# Castle Product Plan

## Product vision

Castle is a simple, fast multiplayer chess game where two people can choose usernames, join the same room, and play a rated game in real time. The server remains authoritative for chess rules, clocks, results, scores, and ratings.

## MVP goals

The MVP should let a player:

- Choose a username without a lengthy sign-up flow.
- Create a private room and share its code.
- Join an existing room from another browser or device.
- Play a complete legal chess game with live synchronized moves.
- Win by checkmate, resignation, or timeout, or finish with a draw.
- Reconnect without losing the current game.
- See a persistent rating, record, leaderboard position, and game history.

## Current status

The MVP is implemented.

- [x] Responsive lobby and interactive chessboard
- [x] Private room creation and room-code joining
- [x] Two-player real-time games with spectator support
- [x] Server-authoritative move validation using `chess.js`
- [x] WebSocket updates with database-backed recovery
- [x] Persistent rooms and reconnect support
- [x] Ten-minute server-authoritative clocks
- [x] Checkmate, stalemate, resignation, timeout, and draw settlement
- [x] Draw offers and rematches with colors swapped
- [x] Elo-style ratings and win/loss/draw records
- [x] Player profiles, leaderboard, recent games, and PGN history
- [x] Keyboard, mouse, and touch support
- [x] Production deployment and persistent D1 storage

## Architecture

### Front end

- Next.js/React application rendered through Vinext
- `app/GameClient.tsx` owns the lobby, board, game controls, profiles, leaderboard, and history views
- Browser storage remembers only the local username
- The board renders authoritative state received from the server

### Backend

- Cloudflare Worker entry point in `worker/index.ts`
- WebSocket protocol handles room presence and live game actions
- HTTP endpoints provide profiles, leaderboard data, and game history
- All moves, clocks, offers, results, and rating updates are validated on the server

### Database

- Cloudflare D1 with Drizzle schema definitions in `db/schema.ts`
- Migrations live in `drizzle/`
- Persistent records cover players, rooms, active positions, completed games, results, ratings, and PGN history

## Delivery phases

### Phase 1: MVP foundation — complete

Deliver a reliable two-player room flow, legal chess, real-time synchronization, persistence, ratings, profiles, and history.

Exit criteria:

- Two separate browsers can create and join a room.
- Illegal and out-of-turn moves are rejected by the server.
- Both players see the same position, clocks, and result.
- A refresh or temporary disconnect restores the active game.
- A completed rated game updates both player records exactly once.

### Phase 2: Reliability and safety — next

- [ ] Add focused backend tests for room joining, move validation, clocks, draws, rematches, and rating idempotency
- [ ] Add WebSocket protocol and reconnect integration tests
- [ ] Add request throttling and abuse protection
- [ ] Normalize and validate usernames, room codes, and payload sizes consistently
- [ ] Add structured server logging and actionable error reporting
- [ ] Improve disconnected-player and abandoned-game handling
- [ ] Add database indexes and retention rules based on real usage

Exit criteria:

- Critical game and rating paths have automated coverage.
- Duplicate messages and reconnect races cannot create duplicate results.
- Invalid or abusive traffic fails safely without affecting other games.

### Phase 3: Accounts and matchmaking

- [ ] Add durable accounts and secure authentication
- [ ] Reserve unique display names while supporting profile renames
- [ ] Add a casual quick-play queue
- [ ] Add rating-based matchmaking for rated games
- [ ] Support additional time controls and separate ratings by format
- [ ] Add invitations and shareable challenge links

Exit criteria:

- A player can use the same identity and rating across devices.
- Players can find an appropriate opponent without exchanging a room code.

### Phase 4: Competitive and social features

- [ ] Add in-game and post-game chat with moderation controls
- [ ] Add friends, presence, challenges, and notifications
- [ ] Add move review, opening labels, and downloadable PGNs
- [ ] Add tournaments, seasons, and rating leaderboards by time control
- [ ] Add player reporting, blocking, and fair-play review tools

### Phase 5: Scale and operations

- [ ] Add operational dashboards for active games, connection health, errors, and latency
- [ ] Load-test concurrent rooms and reconnect storms
- [ ] Introduce stronger per-room coordination if multi-instance contention requires it
- [ ] Add backup, migration, and incident-recovery procedures
- [ ] Define service-level targets for move delivery and availability

## Near-term priorities

1. Protect the completed MVP with backend and WebSocket integration tests.
2. Harden reconnect, timeout, and duplicate-result edge cases.
3. Add lightweight abuse protection and observability.
4. Validate the game with a small group of real players.
5. Use that feedback to choose between accounts, matchmaking, or more time controls as the next product investment.

## Out of scope for the initial MVP

- Computer opponents and chess-engine analysis
- Public matchmaking queues
- Full account recovery and social login
- Chat and moderation systems
- Tournaments, teams, and clubs
- Native mobile applications
- Anti-cheat automation

These features should be added only after the core two-player game is reliable and players demonstrate demand for them.

## Definition of success

Castle is ready to move beyond MVP when players can repeatedly complete games across separate devices, reconnect successfully, trust the clocks and results, and understand how their ratings changed without administrator intervention.
