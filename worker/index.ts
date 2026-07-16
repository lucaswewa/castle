/** Cloudflare Worker entry point for Castle. */
import { Chess, type Color } from "chess.js";
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): { transform(options: Record<string, unknown>): { output(options: { format: string; quality: number }): Promise<{ response(): Response }> } };
  };
}
interface ExecutionContext { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void; }
type CastleSocket = WebSocket & { accept(): void };
type Seat = Color | "spectator";
type Player = { username: string; rating: number };
type Client = { socket: CastleSocket; username: string; side: Seat };
type Room = { code: string; chess: Chess; players: Partial<Record<Color, Player>>; clients: Set<Client>; status: "waiting" | "playing" | "finished"; lastMove?: { from: string; to: string }; winner?: string; settled: boolean };

const rooms = new Map<string, Room>();
let schemaReady: Promise<void> | undefined;

function ensureSchema(db: D1Database) {
  schemaReady ??= db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS players (
      username TEXT PRIMARY KEY,
      rating INTEGER NOT NULL DEFAULT 1200,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      draws INTEGER NOT NULL DEFAULT 0,
      games INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      room_code TEXT NOT NULL,
      white_username TEXT NOT NULL,
      black_username TEXT NOT NULL,
      result TEXT NOT NULL,
      pgn TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS games_room_idx ON games (room_code)"),
  ]).then(() => undefined);
  return schemaReady;
}

async function getPlayer(db: D1Database, username: string): Promise<Player> {
  await ensureSchema(db);
  await db.prepare("INSERT OR IGNORE INTO players (username, updated_at) VALUES (?, ?)").bind(username, Date.now()).run();
  const row = await db.prepare("SELECT username, rating FROM players WHERE username = ?").bind(username).first<Player>();
  return row || { username, rating: 1200 };
}

function cleanName(value: unknown) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 18);
}
function cleanRoom(value: unknown) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}
function roomState(room: Room) {
  return {
    type: "state",
    fen: room.chess.fen(),
    pgn: room.chess.pgn(),
    turn: room.chess.turn(),
    status: room.status,
    players: room.players,
    lastMove: room.lastMove,
    winner: room.winner,
  };
}
function send(socket: WebSocket, payload: unknown) {
  try { socket.send(JSON.stringify(payload)); } catch { /* disconnected */ }
}
function broadcast(room: Room) {
  const state = roomState(room);
  room.clients.forEach((client) => send(client.socket, state));
}
function expectedScore(ratingA: number, ratingB: number) {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

async function settleGame(db: D1Database, room: Room) {
  if (room.settled || !room.players.w || !room.players.b) return;
  room.settled = true;
  const white = room.players.w;
  const black = room.players.b;
  const whiteScore = room.winner === white.username ? 1 : room.winner === black.username ? 0 : 0.5;
  const blackScore = 1 - whiteScore;
  const whiteNew = Math.round(white.rating + 24 * (whiteScore - expectedScore(white.rating, black.rating)));
  const blackNew = Math.round(black.rating + 24 * (blackScore - expectedScore(black.rating, white.rating)));
  const result = whiteScore === 1 ? "1-0" : whiteScore === 0 ? "0-1" : "1/2-1/2";
  const whiteResultField = whiteScore === 1 ? "wins" : whiteScore === 0 ? "losses" : "draws";
  const blackResultField = blackScore === 1 ? "wins" : blackScore === 0 ? "losses" : "draws";
  try {
    await ensureSchema(db);
    await db.batch([
      db.prepare(`UPDATE players SET rating = ?, games = games + 1, ${whiteResultField} = ${whiteResultField} + 1, updated_at = ? WHERE username = ?`).bind(whiteNew, Date.now(), white.username),
      db.prepare(`UPDATE players SET rating = ?, games = games + 1, ${blackResultField} = ${blackResultField} + 1, updated_at = ? WHERE username = ?`).bind(blackNew, Date.now(), black.username),
      db.prepare("INSERT INTO games (id, room_code, white_username, black_username, result, pgn, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), room.code, white.username, black.username, result, room.chess.pgn(), Date.now()),
    ]);
    white.rating = whiteNew;
    black.rating = blackNew;
  } catch (error) {
    room.settled = false;
    console.error("Could not settle game", error);
  }
}

async function openSocket(request: Request, env: Env) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket upgrade required", { status: 426 });
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1] as CastleSocket;
  server.accept();
  let membership: Client | undefined;
  let currentRoom: Room | undefined;

  server.addEventListener("message", async (event) => {
    let message: Record<string, unknown>;
    try { message = JSON.parse(String(event.data)); } catch { return send(server, { type: "error", message: "Invalid message" }); }
    if (message.type === "join") {
      const username = cleanName(message.username);
      const code = cleanRoom(message.room);
      if (username.length < 2 || code.length < 4) return send(server, { type: "error", message: "Invalid username or room" });
      const room = rooms.get(code) || { code, chess: new Chess(), players: {}, clients: new Set<Client>(), status: "waiting" as const, settled: false };
      rooms.set(code, room);
      const player = await getPlayer(env.DB, username);
      let side: Seat = "spectator";
      if (room.players.w?.username === username) side = "w";
      else if (room.players.b?.username === username) side = "b";
      else if (!room.players.w) { side = "w"; room.players.w = player; }
      else if (!room.players.b) { side = "b"; room.players.b = player; }
      membership = { socket: server, username, side };
      currentRoom = room;
      room.clients.add(membership);
      if (room.players.w && room.players.b && room.status === "waiting") room.status = "playing";
      send(server, { type: "joined", room: code, side });
      broadcast(room);
      return;
    }
    if (message.type === "move" && membership && currentRoom) {
      if (membership.side === "spectator" || currentRoom.status !== "playing" || currentRoom.chess.turn() !== membership.side) return send(server, { type: "error", message: "It is not your move" });
      const from = String(message.from || "");
      const to = String(message.to || "");
      try {
        const move = currentRoom.chess.move({ from, to, promotion: String(message.promotion || "q") });
        if (!move) throw new Error("Illegal move");
        currentRoom.lastMove = { from: move.from, to: move.to };
        if (currentRoom.chess.isGameOver()) {
          currentRoom.status = "finished";
          if (currentRoom.chess.isCheckmate()) currentRoom.winner = currentRoom.players[membership.side]?.username;
          await settleGame(env.DB, currentRoom);
        }
        broadcast(currentRoom);
      } catch { send(server, { type: "error", message: "That move is not legal" }); }
    }
    if (message.type === "resign" && membership && currentRoom && membership.side !== "spectator" && currentRoom.status === "playing") {
      const winnerSide: Color = membership.side === "w" ? "b" : "w";
      currentRoom.status = "finished";
      currentRoom.winner = currentRoom.players[winnerSide]?.username;
      await settleGame(env.DB, currentRoom);
      broadcast(currentRoom);
    }
  });
  server.addEventListener("close", () => {
    if (!membership || !currentRoom) return;
    currentRoom.clients.delete(membership);
    if (currentRoom.clients.size === 0 && currentRoom.status !== "playing") rooms.delete(currentRoom.code);
  });
  return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") return openSocket(request, env);
    if (url.pathname === "/api/leaderboard") {
      await ensureSchema(env.DB);
      const result = await env.DB.prepare("SELECT username, rating, wins, losses, draws, games FROM players ORDER BY rating DESC, games DESC LIMIT 8").all();
      return Response.json({ players: result.results }, { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => (await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality })).response(),
      }, allowedWidths);
    }
    return handler.fetch(request, env, ctx);
  },
};

export default worker;
