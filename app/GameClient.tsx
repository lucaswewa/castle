"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Chess, type Color, type Square } from "chess.js";

type Player = { username: string; rating: number };
type Snapshot = {
  type: "state";
  fen: string;
  pgn: string;
  turn: Color;
  status: string;
  players: { w?: Player; b?: Player };
  lastMove?: { from: string; to: string };
  winner?: string;
};
type Leader = Player & { wins: number; losses: number; draws: number; games: number };

const pieces: Record<string, string> = {
  wp: "♙", wn: "♘", wb: "♗", wr: "♖", wq: "♕", wk: "♔",
  bp: "♟", bn: "♞", bb: "♝", br: "♜", bq: "♛", bk: "♚",
};

const emptySnapshot: Snapshot = {
  type: "state",
  fen: new Chess().fen(),
  pgn: "",
  turn: "w",
  status: "waiting",
  players: {},
};

function randomRoom() {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

function initials(name?: string) {
  return (name || "?").slice(0, 2).toUpperCase();
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
  const [leaders, setLeaders] = useState<Leader[]>([]);
  const socket = useRef<WebSocket | null>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem("castle-username") || "";
    setUsername(saved);
    setDraftName(saved);
    fetch("/api/leaderboard").then((r) => r.json()).then((d) => setLeaders(d.players || [])).catch(() => {});
    return () => socket.current?.close();
  }, []);

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
      })
      .catch(() => {});
    refresh();
    const timer = window.setInterval(refresh, 700);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [room, username]);

  const game = useMemo(() => {
    const next = new Chess();
    try { next.load(snapshot.fen); } catch { /* keep initial board */ }
    return next;
  }, [snapshot.fen]);

  const board = useMemo(() => {
    const rows = game.board();
    return side === "b" ? rows.slice().reverse().map((row) => row.slice().reverse()) : rows;
  }, [game, side]);

  const me = side === "spectator" ? undefined : snapshot.players[side];
  const opponentSide = side === "b" ? "w" : "b";
  const opponent = snapshot.players[opponentSide];
  const myTurn = side !== "spectator" && snapshot.turn === side && snapshot.status === "playing";

  function saveName() {
    const clean = draftName.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 18);
    if (clean.length < 2) return setNotice("Use at least 2 letters or numbers");
    window.localStorage.setItem("castle-username", clean);
    setUsername(clean);
    setDraftName(clean);
    setNotice("Ready for a game");
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
        setRoom(message.room);
        setJoinCode(message.room);
        setSide(message.side);
        setNotice(message.side === "spectator" ? "Watching game" : `You are ${message.side === "w" ? "White" : "Black"}`);
      }
      if (message.type === "state") {
        setSnapshot(message);
        setSelected(null);
        setTargets([]);
        if (message.status === "finished") {
          setNotice(message.winner ? `${message.winner} wins` : "Game drawn");
          fetch("/api/leaderboard").then((r) => r.json()).then((d) => setLeaders(d.players || [])).catch(() => {});
        }
      }
      if (message.type === "error") setNotice(message.message);
    };
    ws.onclose = () => setNotice((old) => old === "Connecting…" ? "Could not connect" : old);
  }

  function createGame() {
    connect(randomRoom());
  }

  function joinGame() {
    const code = joinCode.trim().toUpperCase();
    if (code.length < 4) return setNotice("Enter a valid room code");
    connect(code);
  }

  function pick(square: Square) {
    if (!myTurn) return;
    const piece = game.get(square);
    if (selected && targets.includes(square)) {
      socket.current?.send(JSON.stringify({ type: "move", from: selected, to: square, promotion: "q" }));
      setSelected(null);
      setTargets([]);
      return;
    }
    if (!piece || piece.color !== side) {
      setSelected(null);
      setTargets([]);
      return;
    }
    const legal = game.moves({ square, verbose: true }).map((move) => move.to as Square);
    setSelected(square);
    setTargets(legal);
  }

  function copyRoom() {
    if (!room) return;
    navigator.clipboard.writeText(room).then(() => setNotice("Room code copied"));
  }

  function resign() {
    if (side === "spectator" || snapshot.status !== "playing") return;
    socket.current?.send(JSON.stringify({ type: "resign" }));
  }

  const history = game.history();
  const statusLabel = snapshot.status === "waiting"
    ? "Waiting for opponent"
    : snapshot.status === "finished"
      ? (snapshot.winner ? `${snapshot.winner} won` : "Draw")
      : myTurn ? "Your move" : "Opponent's move";

  return (
    <main className="app-shell">
      <nav className="topbar">
        <a className="brand" href="#top" aria-label="Castle home"><span className="brand-mark">♜</span> CASTLE</a>
        <div className="nav-actions">
          <span className="live-pill"><i /> LIVE MULTIPLAYER</span>
          {username && <span className="signed-in">Playing as <strong>{username}</strong></span>}
        </div>
      </nav>

      <section className="hero" id="top">
        <div>
          <span className="eyebrow">YOUR NEXT MOVE STARTS HERE</span>
          <h1>Classic chess.<br/><em>Zero clutter.</em></h1>
          <p>Open a room, share the code, and play a real-time rated game with a friend.</p>
        </div>
        <div className="hero-stat"><span>ACTIVE ROOM</span><strong>{room || "— — — — —"}</strong><small>{notice}</small></div>
      </section>

      {!username ? (
        <section className="name-gate card">
          <span className="section-number">01</span>
          <div><h2>Choose your player name</h2><p>This is how opponents will see you on the board and leaderboard.</p></div>
          <div className="inline-form">
            <input value={draftName} onChange={(e) => setDraftName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && saveName()} placeholder="e.g. knightowl" maxLength={18} aria-label="Username" />
            <button onClick={saveName}>Continue <span>→</span></button>
          </div>
        </section>
      ) : !room ? (
        <section className="lobby-grid">
          <article className="card lobby-card primary-card">
            <span className="section-number">01</span><div className="big-icon">＋</div>
            <h2>Create a room</h2><p>Start a fresh rated game and invite a friend with a private code.</p>
            <button className="wide-button" onClick={createGame}>Create game <span>→</span></button>
          </article>
          <article className="card lobby-card">
            <span className="section-number">02</span><div className="big-icon">↳</div>
            <h2>Join a friend</h2><p>Paste the five-character room code they shared with you.</p>
            <div className="join-form"><input value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === "Enter" && joinGame()} placeholder="ROOM CODE" maxLength={8} aria-label="Room code" /><button onClick={joinGame}>Join</button></div>
          </article>
        </section>
      ) : (
        <section className="game-layout">
          <div className="game-column">
            <div className="game-meta">
              <div><span className={`status-dot ${snapshot.status}`} /> <strong>{statusLabel}</strong></div>
              <button className="room-code" onClick={copyRoom} title="Copy room code">ROOM {room} <span>▣</span></button>
            </div>
            <PlayerBar player={opponent} waiting={!opponent} tone="dark" />
            <div className="board-wrap" data-testid="chess-board">
              {board.flat().map((piece, index) => {
                const displayRow = Math.floor(index / 8);
                const displayCol = index % 8;
                const rank = side === "b" ? displayRow + 1 : 8 - displayRow;
                const fileIndex = side === "b" ? 7 - displayCol : displayCol;
                const square = `${String.fromCharCode(97 + fileIndex)}${rank}` as Square;
                const dark = (fileIndex + rank) % 2 === 1;
                const isLast = snapshot.lastMove?.from === square || snapshot.lastMove?.to === square;
                return <button key={square} aria-label={square} onClick={() => pick(square)} className={`square ${dark ? "dark" : "light"} ${selected === square ? "selected" : ""} ${isLast ? "last-move" : ""}`}>
                  {displayCol === 0 && <span className="rank-label">{rank}</span>}
                  {displayRow === 7 && <span className="file-label">{String.fromCharCode(97 + fileIndex)}</span>}
                  {targets.includes(square) && <span className={`target ${piece ? "capture" : ""}`} />}
                  {piece && <span className={`piece ${piece.color}`}>{pieces[piece.color + piece.type]}</span>}
                </button>;
              })}
            </div>
            <PlayerBar player={me} waiting={!me} tone="light" />
          </div>
          <aside className="side-panel card">
            <div className="panel-header"><span>MOVE LOG</span><strong>{history.length} PLY</strong></div>
            <div className="move-list">
              {history.length ? Array.from({ length: Math.ceil(history.length / 2) }, (_, i) => <div className="move-row" key={i}><span>{i + 1}.</span><b>{history[i * 2]}</b><b>{history[i * 2 + 1] || ""}</b></div>) : <div className="empty-moves"><span>♙</span><p>Moves will appear here once the game begins.</p></div>}
            </div>
            <div className="game-note"><span>SERVER AUTHORITATIVE</span><p>Every move is validated before it reaches the board.</p></div>
            {side !== "spectator" && snapshot.status === "playing" && <button className="resign-button" onClick={resign}>Resign game</button>}
          </aside>
        </section>
      )}

      <section className="leaderboard">
        <div className="section-heading"><span className="section-number">03</span><div><h2>Club standings</h2><p>Ratings update after every completed game.</p></div></div>
        <div className="leader-table card">
          <div className="leader-head"><span>RANK / PLAYER</span><span>RECORD</span><span>RATING</span></div>
          {(leaders.length ? leaders : [{ username: "First game awaits", rating: 1200, wins: 0, losses: 0, draws: 0, games: 0 }]).map((player, i) => <div className="leader-row" key={player.username}><div><b>{String(i + 1).padStart(2, "0")}</b><span className="avatar">{initials(player.username)}</span><strong>{player.username}</strong></div><span>{player.wins}W · {player.losses}L · {player.draws}D</span><strong>{player.rating}</strong></div>)}
        </div>
      </section>

      <footer><span>♜ CASTLE</span><p>Built for the love of a good game.</p><small>REAL-TIME · RATED · FOCUSED</small></footer>
    </main>
  );
}

function PlayerBar({ player, waiting, tone }: { player?: Player; waiting: boolean; tone: "dark" | "light" }) {
  return <div className={`player-bar ${tone}`}><div className="avatar">{waiting ? "··" : initials(player?.username)}</div><div><strong>{waiting ? "Waiting for opponent" : player?.username}</strong><span>{waiting ? "Share the room code" : `${player?.rating} rating`}</span></div><div className="clock">10:00</div></div>;
}
