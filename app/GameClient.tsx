"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess, type Color, type Square } from "chess.js";

type Player = { username: string; rating: number };
type PlayerRecord = Player & { wins: number; losses: number; draws: number; games: number };
type CompletedGame = { id: string; room_code: string; white_username: string; black_username: string; result: string; pgn: string; created_at: number };
type Snapshot = {
  type: "state";
  fen: string;
  pgn: string;
  turn: Color;
  status: "waiting" | "playing" | "finished";
  players: { w?: Player; b?: Player };
  lastMove?: { from: string; to: string };
  winner?: string;
  clocks: { w: number; b: number; serverNow: number };
  drawOfferedBy?: string;
  rematch: { w: boolean; b: boolean };
};

const pieces: Record<string, string> = {
  wp: "♙", wn: "♘", wb: "♗", wr: "♖", wq: "♕", wk: "♔",
  bp: "♟", bn: "♞", bb: "♝", br: "♜", bq: "♛", bk: "♚",
};
const emptySnapshot: Snapshot = {
  type: "state", fen: new Chess().fen(), pgn: "", turn: "w", status: "waiting", players: {},
  clocks: { w: 600000, b: 600000, serverNow: 0 }, rematch: { w: false, b: false },
};

function randomRoom() { return Math.random().toString(36).slice(2, 7).toUpperCase(); }
function initials(name?: string) { return (name || "?").slice(0, 2).toUpperCase(); }
function formatClock(milliseconds: number) {
  const total = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export default function GameClient() {
  const [username, setUsername] = useState("");
  const [draftName, setDraftName] = useState("");
  const [room, setRoom] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [side, setSide] = useState<Color | "spectator">("spectator");
  const [selected, setSelected] = useState<Square | null>(null);
  const [targets, setTargets] = useState<Square[]>([]);
  const [notice, setNotice] = useState("Choose a name to begin");
  const [leaders, setLeaders] = useState<PlayerRecord[]>([]);
  const [profile, setProfile] = useState<PlayerRecord | null>(null);
  const [pastGames, setPastGames] = useState<CompletedGame[]>([]);
  const [now, setNow] = useState(0);
  const socket = useRef<WebSocket | null>(null);

  const loadLeaderboard = useCallback(() => {
    fetch("/api/leaderboard").then((r) => r.json()).then((d) => setLeaders(d.players || [])).catch(() => {});
  }, []);
  const loadAccount = useCallback((name: string) => {
    Promise.all([
      fetch(`/api/player?username=${encodeURIComponent(name)}`).then((r) => r.ok ? r.json() : null),
      fetch(`/api/history?username=${encodeURIComponent(name)}`).then((r) => r.ok ? r.json() : null),
    ]).then(([playerData, historyData]) => {
      if (playerData?.player) setProfile(playerData.player);
      setPastGames(historyData?.games || []);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem("castle-username") || "";
    const restore = window.setTimeout(() => { setUsername(saved); setDraftName(saved); setNow(Date.now()); }, 0);
    const ticker = window.setInterval(() => setNow(Date.now()), 250);
    loadLeaderboard();
    return () => { window.clearTimeout(restore); window.clearInterval(ticker); socket.current?.close(); };
  }, [loadLeaderboard]);

  useEffect(() => { if (username) loadAccount(username); }, [username, loadAccount]);

  useEffect(() => {
    if (!room || !username) return;
    let stopped = false;
    const refresh = () => fetch(`/api/room?code=${encodeURIComponent(room)}&username=${encodeURIComponent(username)}`)
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        if (!stopped && data?.state) {
          setSnapshot(data.state);
          if (data.side) setSide(data.side);
        }
      }).catch(() => {});
    refresh();
    const timer = window.setInterval(refresh, 700);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [room, username]);

  const game = useMemo(() => {
    const next = new Chess();
    try { if (snapshot.pgn) next.loadPgn(snapshot.pgn); else next.load(snapshot.fen); } catch { try { next.load(snapshot.fen); } catch {} }
    return next;
  }, [snapshot.fen, snapshot.pgn]);
  const board = useMemo(() => {
    const rows = game.board();
    return side === "b" ? rows.slice().reverse().map((row) => row.slice().reverse()) : rows;
  }, [game, side]);
  const me = side === "spectator" ? undefined : snapshot.players[side];
  const opponentSide: Color = side === "b" ? "w" : "b";
  const opponent = snapshot.players[opponentSide];
  const myTurn = side !== "spectator" && snapshot.turn === side && snapshot.status === "playing";
  const history = game.history();

  function liveClock(color: Color) {
    let value = snapshot.clocks[color];
    if (snapshot.status === "playing" && snapshot.turn === color && snapshot.clocks.serverNow && now) value -= Math.max(0, now - snapshot.clocks.serverNow);
    return formatClock(value);
  }
  function saveName() {
    const clean = draftName.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 18);
    if (clean.length < 2) return setNotice("Use at least 2 letters or numbers");
    window.localStorage.setItem("castle-username", clean);
    setUsername(clean); setDraftName(clean); setNotice("Ready for a game");
  }
  function connect(code: string) {
    if (!username) return setNotice("Set your username first");
    socket.current?.close();
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    socket.current = ws;
    setNotice("Connecting…");
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", room: code, username }));
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "joined") {
        setRoom(message.room); setJoinCode(message.room); setSide(message.side);
        setNotice(message.side === "spectator" ? "Watching game" : `You are ${message.side === "w" ? "White" : "Black"}`);
      }
      if (message.type === "state") {
        setSnapshot(message); setSelected(null); setTargets([]);
        if (message.status === "finished") {
          setNotice(message.winner ? `${message.winner} wins` : "Game drawn");
          loadLeaderboard(); loadAccount(username);
        }
      }
      if (message.type === "error") setNotice(message.message);
    };
    ws.onclose = () => setNotice((old) => old === "Connecting…" ? "Could not connect" : old);
  }
  function pick(square: Square) {
    if (!myTurn) return;
    const piece = game.get(square);
    if (selected && targets.includes(square)) {
      socket.current?.send(JSON.stringify({ type: "move", from: selected, to: square, promotion: "q" }));
      setSelected(null); setTargets([]); return;
    }
    if (!piece || piece.color !== side) { setSelected(null); setTargets([]); return; }
    setSelected(square);
    setTargets(game.moves({ square, verbose: true }).map((move) => move.to as Square));
  }
  function sendAction(type: string) { socket.current?.send(JSON.stringify({ type })); }
  function copyRoom() { if (room) navigator.clipboard.writeText(room).then(() => setNotice("Room code copied")); }

  const statusLabel = snapshot.status === "waiting" ? "Waiting for opponent" : snapshot.status === "finished"
    ? (snapshot.winner ? `${snapshot.winner} won` : "Draw") : myTurn ? "Your move" : "Opponent's move";
  const myRematch = side === "spectator" ? false : snapshot.rematch[side];
  const drawFromOpponent = Boolean(snapshot.drawOfferedBy && snapshot.drawOfferedBy !== username);

  return (
    <main className="app-shell">
      <nav className="topbar">
        <a className="brand" href="#top" aria-label="Castle home"><span className="brand-mark">♜</span> CASTLE</a>
        <div className="nav-actions"><span className="live-pill"><i /> LIVE MULTIPLAYER</span>{username && <span className="signed-in">Playing as <strong>{username}</strong></span>}</div>
      </nav>

      <section className="hero" id="top">
        <div><span className="eyebrow">YOUR NEXT MOVE STARTS HERE</span><h1>Classic chess.<br/><em>Zero clutter.</em></h1><p>Open a room, share the code, and play a real-time rated game with a friend.</p></div>
        <div className="hero-stat"><span>ACTIVE ROOM</span><strong>{room || "— — — — —"}</strong><small>{notice}</small></div>
      </section>

      {!username ? (
        <section className="name-gate card"><span className="section-number">01</span><div><h2>Choose your player name</h2><p>This is how opponents will see you on the board and leaderboard.</p></div><div className="inline-form"><input value={draftName} onChange={(e) => setDraftName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && saveName()} placeholder="e.g. knightowl" maxLength={18} aria-label="Username" /><button onClick={saveName}>Continue <span>→</span></button></div></section>
      ) : !room ? (
        <section className="lobby-grid">
          <article className="card lobby-card primary-card"><span className="section-number">01</span><div className="big-icon">＋</div><h2>Create a room</h2><p>Start a 10-minute rated game and invite a friend with a private code.</p><button className="wide-button" onClick={() => connect(randomRoom())}>Create game <span>→</span></button></article>
          <article className="card lobby-card"><span className="section-number">02</span><div className="big-icon">↳</div><h2>Join a friend</h2><p>Paste the five-character room code they shared with you.</p><div className="join-form"><input value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === "Enter" && connect(joinCode.trim().toUpperCase())} placeholder="ROOM CODE" maxLength={8} aria-label="Room code" /><button onClick={() => joinCode.trim().length >= 4 ? connect(joinCode.trim().toUpperCase()) : setNotice("Enter a valid room code")}>Join</button></div></article>
        </section>
      ) : (
        <section className="game-layout">
          <div className="game-column">
            <div className="game-meta"><div><span className={`status-dot ${snapshot.status}`} /> <strong>{statusLabel}</strong></div><button className="room-code" onClick={copyRoom} title="Copy room code">ROOM {room} <span>▣</span></button></div>
            <PlayerBar player={opponent} waiting={!opponent} tone="dark" clock={liveClock(opponentSide)} active={snapshot.status === "playing" && snapshot.turn === opponentSide} />
            <div className="board-wrap" data-testid="chess-board">
              {board.flat().map((piece, index) => {
                const displayRow = Math.floor(index / 8), displayCol = index % 8;
                const rank = side === "b" ? displayRow + 1 : 8 - displayRow;
                const fileIndex = side === "b" ? 7 - displayCol : displayCol;
                const square = `${String.fromCharCode(97 + fileIndex)}${rank}` as Square;
                const dark = (fileIndex + rank) % 2 === 1;
                const isLast = snapshot.lastMove?.from === square || snapshot.lastMove?.to === square;
                return <button key={square} aria-label={square} onClick={() => pick(square)} className={`square ${dark ? "dark" : "light"} ${selected === square ? "selected" : ""} ${isLast ? "last-move" : ""}`}>
                  {displayCol === 0 && <span className="rank-label">{rank}</span>}{displayRow === 7 && <span className="file-label">{String.fromCharCode(97 + fileIndex)}</span>}
                  {targets.includes(square) && <span className={`target ${piece ? "capture" : ""}`} />}{piece && <span className={`piece ${piece.color}`}>{pieces[piece.color + piece.type]}</span>}
                </button>;
              })}
            </div>
            <PlayerBar player={me} waiting={!me} tone="light" clock={side === "spectator" ? "—:—" : liveClock(side)} active={myTurn} />
          </div>
          <aside className="side-panel card">
            <div className="panel-header"><span>MOVE LOG</span><strong>{history.length} PLY</strong></div>
            <div className="move-list">{history.length ? Array.from({ length: Math.ceil(history.length / 2) }, (_, i) => <div className="move-row" key={i}><span>{i + 1}.</span><b>{history[i * 2]}</b><b>{history[i * 2 + 1] || ""}</b></div>) : <div className="empty-moves"><span>♙</span><p>Moves will appear here once the game begins.</p></div>}</div>
            <div className="game-note"><span>SERVER AUTHORITATIVE</span><p>Moves and clocks are validated before the board updates.</p></div>
            {side !== "spectator" && <div className="game-actions">
              {snapshot.status === "playing" && <>
                <button disabled={Boolean(snapshot.drawOfferedBy && !drawFromOpponent)} onClick={() => sendAction(drawFromOpponent ? "accept_draw" : "offer_draw")}>{drawFromOpponent ? "Accept draw" : snapshot.drawOfferedBy ? "Draw offered" : "Offer draw"}</button>
                <button className="danger-action" onClick={() => sendAction("resign")}>Resign</button>
              </>}
              {snapshot.status === "finished" && <button className="rematch-action" disabled={myRematch} onClick={() => sendAction("rematch")}>{myRematch ? "Rematch requested" : "Play rematch"}</button>}
            </div>}
          </aside>
        </section>
      )}

      {username && <section className="account-section">
        <div className="section-heading"><span className="section-number">03</span><div><h2>Your chess record</h2><p>Every rated result is stored with its final move history.</p></div></div>
        <div className="account-grid">
          <article className="profile-card card"><span className="avatar large">{initials(username)}</span><div><strong>{username}</strong><p>{profile?.games || 0} rated games</p></div><b>{profile?.rating || 1200}<small>RATING</small></b><div className="record-strip"><span><b>{profile?.wins || 0}</b> Wins</span><span><b>{profile?.draws || 0}</b> Draws</span><span><b>{profile?.losses || 0}</b> Losses</span></div></article>
          <article className="history-card card"><div className="panel-header"><span>RECENT GAMES</span><strong>{pastGames.length}</strong></div><div className="history-list">{pastGames.length ? pastGames.map((past) => {
            const wasWhite = past.white_username === username;
            const opponentName = wasWhite ? past.black_username : past.white_username;
            const score = past.result === "1/2-1/2" ? "DRAW" : (wasWhite ? past.result === "1-0" : past.result === "0-1") ? "WIN" : "LOSS";
            return <div className="history-row" key={past.id}><span className={`result-badge ${score.toLowerCase()}`}>{score}</span><div><strong>vs {opponentName}</strong><small>{wasWhite ? "White" : "Black"} · Room {past.room_code}</small></div><time>{new Date(past.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time></div>;
          }) : <div className="history-empty">Your completed games will appear here.</div>}</div></article>
        </div>
      </section>}

      <section className="leaderboard"><div className="section-heading"><span className="section-number">04</span><div><h2>Club standings</h2><p>Ratings update after every completed game.</p></div></div><div className="leader-table card"><div className="leader-head"><span>RANK / PLAYER</span><span>RECORD</span><span>RATING</span></div>{(leaders.length ? leaders : [{ username: "First game awaits", rating: 1200, wins: 0, losses: 0, draws: 0, games: 0 }]).map((player, i) => <div className="leader-row" key={player.username}><div><b>{String(i + 1).padStart(2, "0")}</b><span className="avatar">{initials(player.username)}</span><strong>{player.username}</strong></div><span>{player.wins}W · {player.losses}L · {player.draws}D</span><strong>{player.rating}</strong></div>)}</div></section>

      <footer><span>♜ CASTLE</span><p>Built for the love of a good game.</p><small>REAL-TIME · RATED · FOCUSED</small></footer>
    </main>
  );
}

function PlayerBar({ player, waiting, tone, clock, active }: { player?: Player; waiting: boolean; tone: "dark" | "light"; clock: string; active: boolean }) {
  return <div className={`player-bar ${tone} ${active ? "active-turn" : ""}`}><div className="avatar">{waiting ? "··" : initials(player?.username)}</div><div><strong>{waiting ? "Waiting for opponent" : player?.username}</strong><span>{waiting ? "Share the room code" : `${player?.rating} rating`}</span></div><div className="clock">{clock}</div></div>;
}
