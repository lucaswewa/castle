# Castle

Castle is a focused, room-based multiplayer chess game. Two players choose usernames, share a room code, and play a server-authoritative rated game in real time.

## Current product

- Legal chess moves, checkmate, stalemate, resignation, and draw settlement via `chess.js`
- WebSocket actions with immediate same-instance updates and D1-backed polling recovery
- Persistent rooms that survive worker restarts and multi-instance routing
- Ten-minute server-authoritative clocks
- Draw offers, rematches with swapped colors, spectators, and reconnect support
- Elo-style ratings plus win/loss/draw records
- Player profiles, leaderboard, complete PGN history, and recent games
- Responsive keyboard- and touch-friendly interface

## Architecture

- `app/GameClient.tsx` — lobby, board, controls, profiles, and history
- `worker/index.ts` — WebSocket protocol, chess rules, clocks, ratings, and APIs
- `db/schema.ts` — D1 schema definitions
- `drizzle/` — generated database migrations
- `.openai/hosting.json` — Sites project and D1 binding

Room positions, clocks, offers, completed games, and player records are authoritative in D1. Browser storage is used only to remember the username on the current device.

## Development

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
npm test
npm run lint
```

Generate a migration after changing `db/schema.ts`:

```bash
npm run db:generate
```
