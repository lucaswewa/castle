/** Cloudflare Worker entry point for Castle. */
import { Chess } from "chess.js";
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: { input(stream: ReadableStream): { transform(options: Record<string, unknown>): { output(options: { format: string; quality: number }): Promise<{ response(): Response }> } } };
}
interface ExecutionContext { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void; }
type CastleSocket = WebSocket & { accept(): void };
type Seat = "w" | "b" | "spectator";
type Player = { username: string; rating: number };
type ActiveRoom = {
  code: string; fen: string; pgn: string; white_username: string | null; black_username: string | null;
  status: "waiting" | "playing" | "finished"; last_from: string | null; last_to: string | null;
  winner: string | null; settled: number; created_at: number; updated_at: number;
  white_time_ms: number; black_time_ms: number; turn_started_at: number | null;
  draw_offered_by: string | null; rematch_white: number; rematch_black: number;
};

const socketsByRoom = new Map<string, Set<WebSocket>>();
let schemaReady: Promise<void> | undefined;

function ensureSchema(db: D1Database) {
  schemaReady ??= db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS players (username TEXT PRIMARY KEY, rating INTEGER NOT NULL DEFAULT 1200, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, draws INTEGER NOT NULL DEFAULT 0, games INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS games (id TEXT PRIMARY KEY, room_code TEXT NOT NULL, white_username TEXT NOT NULL, black_username TEXT NOT NULL, result TEXT NOT NULL, pgn TEXT NOT NULL, created_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS games_room_idx ON games (room_code)"),
    db.prepare("CREATE TABLE IF NOT EXISTS active_rooms (code TEXT PRIMARY KEY, fen TEXT NOT NULL, pgn TEXT NOT NULL DEFAULT '', white_username TEXT, black_username TEXT, status TEXT NOT NULL DEFAULT 'waiting', last_from TEXT, last_to TEXT, winner TEXT, settled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS room_features (code TEXT PRIMARY KEY, white_time_ms INTEGER NOT NULL DEFAULT 600000, black_time_ms INTEGER NOT NULL DEFAULT 600000, turn_started_at INTEGER, draw_offered_by TEXT, rematch_white INTEGER NOT NULL DEFAULT 0, rematch_black INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)"),
  ]).then(() => undefined);
  return schemaReady;
}

function cleanName(value: unknown) { return String(value || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 18); }
function cleanRoom(value: unknown) { return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8); }
function send(socket: WebSocket, payload: unknown) { try { socket.send(JSON.stringify(payload)); } catch { /* disconnected */ } }
function expectedScore(ratingA: number, ratingB: number) { return 1 / (1 + 10 ** ((ratingB - ratingA) / 400)); }

async function getPlayer(db: D1Database, username: string): Promise<Player> {
  await ensureSchema(db);
  await db.prepare("INSERT OR IGNORE INTO players (username, updated_at) VALUES (?, ?)").bind(username, Date.now()).run();
  return (await db.prepare("SELECT username, rating FROM players WHERE username = ?").bind(username).first<Player>()) || { username, rating: 1200 };
}
async function getRoom(db: D1Database, code: string) {
  return db.prepare(`SELECT ar.*, COALESCE(rf.white_time_ms, 600000) AS white_time_ms, COALESCE(rf.black_time_ms, 600000) AS black_time_ms, rf.turn_started_at, rf.draw_offered_by, COALESCE(rf.rematch_white, 0) AS rematch_white, COALESCE(rf.rematch_black, 0) AS rematch_black FROM active_rooms ar LEFT JOIN room_features rf ON rf.code = ar.code WHERE ar.code = ?`).bind(code).first<ActiveRoom>();
}
function seatFor(room: ActiveRoom, username: string): Seat {
  return room.white_username === username ? "w" : room.black_username === username ? "b" : "spectator";
}
function chessForRoom(room: ActiveRoom) {
  const chess = new Chess();
  if (room.pgn) {
    try { chess.loadPgn(room.pgn); if (chess.fen() === room.fen) return chess; } catch { /* use authoritative FEN */ }
  }
  chess.load(room.fen);
  return chess;
}
function liveClocks(room: ActiveRoom, chess: Chess, now = Date.now()) {
  let w = room.white_time_ms;
  let b = room.black_time_ms;
  if (room.status === "playing" && room.turn_started_at) {
    const elapsed = Math.max(0, now - room.turn_started_at);
    if (chess.turn() === "w") w = Math.max(0, w - elapsed); else b = Math.max(0, b - elapsed);
  }
  return { w, b, serverNow: now };
}

async function settleGame(db: D1Database, room: ActiveRoom, chess: Chess) {
  if (room.settled || !room.white_username || !room.black_username) return;
  const claim = await db.prepare("UPDATE active_rooms SET settled = 1 WHERE code = ? AND settled = 0").bind(room.code).run();
  if (!claim.meta.changes) return;
  const white = await getPlayer(db, room.white_username);
  const black = await getPlayer(db, room.black_username);
  const whiteScore = room.winner === white.username ? 1 : room.winner === black.username ? 0 : 0.5;
  const blackScore = 1 - whiteScore;
  const whiteNew = Math.round(white.rating + 24 * (whiteScore - expectedScore(white.rating, black.rating)));
  const blackNew = Math.round(black.rating + 24 * (blackScore - expectedScore(black.rating, white.rating)));
  const result = whiteScore === 1 ? "1-0" : whiteScore === 0 ? "0-1" : "1/2-1/2";
  const whiteField = whiteScore === 1 ? "wins" : whiteScore === 0 ? "losses" : "draws";
  const blackField = blackScore === 1 ? "wins" : blackScore === 0 ? "losses" : "draws";
  try {
    await db.batch([
      db.prepare(`UPDATE players SET rating = ?, games = games + 1, ${whiteField} = ${whiteField} + 1, updated_at = ? WHERE username = ?`).bind(whiteNew, Date.now(), white.username),
      db.prepare(`UPDATE players SET rating = ?, games = games + 1, ${blackField} = ${blackField} + 1, updated_at = ? WHERE username = ?`).bind(blackNew, Date.now(), black.username),
      db.prepare("INSERT INTO games (id, room_code, white_username, black_username, result, pgn, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), room.code, white.username, black.username, result, chess.pgn(), Date.now()),
    ]);
  } catch (error) {
    await db.prepare("UPDATE active_rooms SET settled = 0 WHERE code = ?").bind(room.code).run();
    throw error;
  }
}

async function refreshTimeout(db: D1Database, room: ActiveRoom) {
  if (room.status !== "playing" || !room.turn_started_at) return room;
  const chess = chessForRoom(room);
  const clocks = liveClocks(room, chess);
  const expired = chess.turn() === "w" ? clocks.w === 0 : clocks.b === 0;
  if (!expired) return room;
  const winner = chess.turn() === "w" ? room.black_username : room.white_username;
  const finish = await db.prepare("UPDATE active_rooms SET status = 'finished', winner = ?, updated_at = ? WHERE code = ? AND status = 'playing'").bind(winner, Date.now(), room.code).run();
  if (!finish.meta.changes) return (await getRoom(db, room.code)) || room;
  await db.prepare("UPDATE room_features SET white_time_ms = ?, black_time_ms = ?, turn_started_at = NULL, updated_at = ? WHERE code = ?").bind(clocks.w, clocks.b, Date.now(), room.code).run();
  const updated = (await getRoom(db, room.code))!;
  await settleGame(db, updated, chess);
  return (await getRoom(db, room.code))!;
}

async function stateFor(db: D1Database, rawRoom: ActiveRoom) {
  const room = await refreshTimeout(db, rawRoom);
  const players: { w?: Player; b?: Player } = {};
  if (room.white_username) players.w = await getPlayer(db, room.white_username);
  if (room.black_username) players.b = await getPlayer(db, room.black_username);
  const chess = chessForRoom(room);
  return {
    type: "state", fen: room.fen, pgn: room.pgn, turn: chess.turn(), status: room.status, players,
    lastMove: room.last_from && room.last_to ? { from: room.last_from, to: room.last_to } : undefined,
    winner: room.winner || undefined, clocks: liveClocks(room, chess), drawOfferedBy: room.draw_offered_by || undefined,
    rematch: { w: Boolean(room.rematch_white), b: Boolean(room.rematch_black) },
  };
}
async function broadcastState(db: D1Database, room: ActiveRoom) {
  const payload = await stateFor(db, room);
  for (const socket of socketsByRoom.get(room.code) || []) send(socket, payload);
  return payload;
}

async function joinRoom(db: D1Database, code: string, username: string) {
  await ensureSchema(db);
  await getPlayer(db, username);
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO active_rooms (code, fen, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(code, new Chess().fen(), now, now),
    db.prepare("INSERT OR IGNORE INTO room_features (code, updated_at) VALUES (?, ?)").bind(code, now),
  ]);
  let room = await getRoom(db, code);
  if (!room) throw new Error("Could not create room");
  if (!room.white_username) await db.prepare("UPDATE active_rooms SET white_username = ?, updated_at = ? WHERE code = ? AND white_username IS NULL").bind(username, now, code).run();
  room = (await getRoom(db, code))!;
  if (room.white_username !== username && !room.black_username) {
    await db.batch([
      db.prepare("UPDATE active_rooms SET black_username = ?, status = 'playing', updated_at = ? WHERE code = ? AND black_username IS NULL").bind(username, now, code),
      db.prepare("UPDATE room_features SET turn_started_at = ?, updated_at = ? WHERE code = ?").bind(now, now, code),
    ]);
  }
  room = (await getRoom(db, code))!;
  return { room, side: seatFor(room, username) };
}

async function makeMove(db: D1Database, code: string, username: string, message: Record<string, unknown>) {
  let room = await getRoom(db, code);
  if (!room) throw new Error("Room not found");
  room = await refreshTimeout(db, room);
  if (room.status !== "playing") throw new Error("This game is not active");
  const side = seatFor(room, username);
  const chess = chessForRoom(room);
  if (side === "spectator" || chess.turn() !== side) throw new Error("It is not your move");
  const clocks = liveClocks(room, chess);
  if ((side === "w" ? clocks.w : clocks.b) === 0) throw new Error("Time expired");
  const move = chess.move({ from: String(message.from || ""), to: String(message.to || ""), promotion: String(message.promotion || "q") });
  if (!move) throw new Error("That move is not legal");
  let status: ActiveRoom["status"] = "playing";
  let winner: string | null = null;
  if (chess.isGameOver()) { status = "finished"; if (chess.isCheckmate()) winner = username; }
  const now = Date.now();
  const result = await db.prepare("UPDATE active_rooms SET fen = ?, pgn = ?, status = ?, last_from = ?, last_to = ?, winner = ?, updated_at = ? WHERE code = ? AND fen = ?")
    .bind(chess.fen(), chess.pgn(), status, move.from, move.to, winner, now, code, room.fen).run();
  if (!result.meta.changes) throw new Error("The position changed; try again");
  await db.prepare("UPDATE room_features SET white_time_ms = ?, black_time_ms = ?, turn_started_at = ?, draw_offered_by = NULL, updated_at = ? WHERE code = ?")
    .bind(clocks.w, clocks.b, status === "playing" ? now : null, now, code).run();
  const updated = (await getRoom(db, code))!;
  if (status === "finished") await settleGame(db, updated, chess);
  return (await getRoom(db, code))!;
}

async function resignGame(db: D1Database, code: string, username: string) {
  let room = await getRoom(db, code);
  if (room) room = await refreshTimeout(db, room);
  if (!room || room.status !== "playing") throw new Error("This game is not active");
  const side = seatFor(room, username);
  if (side === "spectator") throw new Error("Only a player can resign");
  const winner = side === "w" ? room.black_username : room.white_username;
  if (!winner) throw new Error("Waiting for an opponent");
  const result = await db.prepare("UPDATE active_rooms SET status = 'finished', winner = ?, updated_at = ? WHERE code = ? AND status = 'playing'").bind(winner, Date.now(), code).run();
  if (!result.meta.changes) throw new Error("This game is already over");
  await db.prepare("UPDATE room_features SET turn_started_at = NULL, updated_at = ? WHERE code = ?").bind(Date.now(), code).run();
  const updated = (await getRoom(db, code))!;
  await settleGame(db, updated, chessForRoom(updated));
  return (await getRoom(db, code))!;
}

async function offerDraw(db: D1Database, code: string, username: string) {
  let room = await getRoom(db, code);
  if (room) room = await refreshTimeout(db, room);
  if (!room || room.status !== "playing" || seatFor(room, username) === "spectator") throw new Error("Draw offers are unavailable");
  if (room.draw_offered_by) throw new Error("A draw offer is already pending");
  await db.prepare("UPDATE room_features SET draw_offered_by = ?, updated_at = ? WHERE code = ? AND draw_offered_by IS NULL").bind(username, Date.now(), code).run();
  return (await getRoom(db, code))!;
}

async function acceptDraw(db: D1Database, code: string, username: string) {
  let room = await getRoom(db, code);
  if (room) room = await refreshTimeout(db, room);
  if (!room || room.status !== "playing" || !room.draw_offered_by || room.draw_offered_by === username || seatFor(room, username) === "spectator") throw new Error("There is no draw offer to accept");
  const result = await db.prepare("UPDATE active_rooms SET status = 'finished', winner = NULL, updated_at = ? WHERE code = ? AND status = 'playing'").bind(Date.now(), code).run();
  if (!result.meta.changes) throw new Error("This game is already over");
  await db.prepare("UPDATE room_features SET turn_started_at = NULL, draw_offered_by = NULL, updated_at = ? WHERE code = ?").bind(Date.now(), code).run();
  const updated = (await getRoom(db, code))!;
  await settleGame(db, updated, chessForRoom(updated));
  return (await getRoom(db, code))!;
}

async function requestRematch(db: D1Database, code: string, username: string) {
  let room = await getRoom(db, code);
  if (!room || room.status !== "finished") throw new Error("Finish the current game first");
  const side = seatFor(room, username);
  if (side === "spectator") throw new Error("Only players can request a rematch");
  await db.prepare(`UPDATE room_features SET ${side === "w" ? "rematch_white" : "rematch_black"} = 1, updated_at = ? WHERE code = ?`).bind(Date.now(), code).run();
  room = (await getRoom(db, code))!;
  if (room.rematch_white && room.rematch_black) {
    const now = Date.now();
    await db.batch([
      db.prepare("UPDATE active_rooms SET fen = ?, pgn = '', white_username = ?, black_username = ?, status = 'playing', last_from = NULL, last_to = NULL, winner = NULL, settled = 0, updated_at = ? WHERE code = ?").bind(new Chess().fen(), room.black_username, room.white_username, now, code),
      db.prepare("UPDATE room_features SET white_time_ms = 600000, black_time_ms = 600000, turn_started_at = ?, draw_offered_by = NULL, rematch_white = 0, rematch_black = 0, updated_at = ? WHERE code = ?").bind(now, now, code),
    ]);
  }
  return (await getRoom(db, code))!;
}

async function openSocket(request: Request, env: Env) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket upgrade required", { status: 426 });
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1] as CastleSocket;
  server.accept();
  let username = "";
  let code = "";
  server.addEventListener("message", async (event) => {
    let message: Record<string, unknown>;
    try { message = JSON.parse(String(event.data)); } catch { return send(server, { type: "error", message: "Invalid message" }); }
    try {
      let room: ActiveRoom | null = null;
      if (message.type === "join") {
        username = cleanName(message.username); code = cleanRoom(message.room);
        if (username.length < 2 || code.length < 4) throw new Error("Invalid username or room");
        const joined = await joinRoom(env.DB, code, username);
        room = joined.room;
        const sockets = socketsByRoom.get(code);
        if (sockets) sockets.add(server); else socketsByRoom.set(code, new Set([server]));
        send(server, { type: "joined", room: code, side: joined.side });
      } else if (message.type === "move" && username && code) room = await makeMove(env.DB, code, username, message);
      else if (message.type === "resign" && username && code) room = await resignGame(env.DB, code, username);
      else if (message.type === "offer_draw" && username && code) room = await offerDraw(env.DB, code, username);
      else if (message.type === "accept_draw" && username && code) room = await acceptDraw(env.DB, code, username);
      else if (message.type === "rematch" && username && code) room = await requestRematch(env.DB, code, username);
      if (room) await broadcastState(env.DB, room);
    } catch (error) { send(server, { type: "error", message: error instanceof Error ? error.message : "Request failed" }); }
  });
  server.addEventListener("close", () => { const sockets = socketsByRoom.get(code); sockets?.delete(server); if (sockets?.size === 0) socketsByRoom.delete(code); });
  return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") return openSocket(request, env);
    if (url.pathname === "/api/room") {
      await ensureSchema(env.DB);
      const code = cleanRoom(url.searchParams.get("code"));
      const username = cleanName(url.searchParams.get("username"));
      const room = await getRoom(env.DB, code);
      if (!room) return Response.json({ error: "Room not found" }, { status: 404 });
      const state = await stateFor(env.DB, room);
      const current = (await getRoom(env.DB, code)) || room;
      return Response.json({ side: seatFor(current, username), state }, { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/api/leaderboard") {
      await ensureSchema(env.DB);
      const result = await env.DB.prepare("SELECT username, rating, wins, losses, draws, games FROM players ORDER BY rating DESC, games DESC LIMIT 8").all();
      return Response.json({ players: result.results }, { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/api/player") {
      await ensureSchema(env.DB);
      const username = cleanName(url.searchParams.get("username"));
      if (!username) return Response.json({ error: "Username is required" }, { status: 400 });
      const player = await env.DB.prepare("SELECT username, rating, wins, losses, draws, games FROM players WHERE username = ?").bind(username).first();
      if (!player) return Response.json({ error: "Player not found" }, { status: 404 });
      return Response.json({ player }, { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/api/history") {
      await ensureSchema(env.DB);
      const username = cleanName(url.searchParams.get("username"));
      if (!username) return Response.json({ error: "Username is required" }, { status: 400 });
      const history = await env.DB.prepare("SELECT id, room_code, white_username, black_username, result, pgn, created_at FROM games WHERE white_username = ? OR black_username = ? ORDER BY created_at DESC LIMIT 12").bind(username, username).all();
      return Response.json({ games: history.results }, { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, { fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))), transformImage: async (body, { width, format, quality }) => (await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality })).response() }, allowedWidths);
    }
    return handler.fetch(request, env, ctx);
  },
};
export default worker;
