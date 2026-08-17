# Mafia Dashboard Touch SPA Implementation Plan

> **For Hermes:** Execute this plan task-by-task using strict RED → GREEN → REFACTOR cycles and keep the GitHub issues synchronized with accepted decisions.

**Goal:** Build a touch-first single-page moderator dashboard for a complete ten-player Sport Mafia game, backed by a local Dockerized API and PostgreSQL event log.

**Architecture:** Use a TypeScript npm-workspace modular monolith: a React/Vite SPA, a Fastify API, a pure game-domain package, and PostgreSQL. The game domain accepts commands and emits append-only events; projections drive the table UI and make every accepted action auditable and recoverable. YouTube playback stays browser-side through the official IFrame Player API while the app stores a local editable queue and configured playlist reference.

**Tech stack:** React, TypeScript, Vite, Fastify, PostgreSQL, `pg`, Zod, Vitest, Testing Library, Playwright, Docker Compose, official YouTube IFrame Player API.

---

## Confirmed product behavior

1. The application is a host-operated SPA for tablets and laptops; players do not need phones for the first release.
2. The main game view has ten people arranged around a round table and a distinct host position.
3. Setup is a gated wizard:
   1. select exactly ten players;
   2. start music from a configured YouTube playlist and edit the local playback queue; music must report `PLAYING` before continuing;
   3. reveal one random remaining role each time the host taps an unassigned player: Sheriff ×1, Citizen ×6, Mafia ×2, Don ×1;
   4. enter Mafia negotiation with a clear full-screen phase signal; the host starts the 60-second timer;
   5. run the Sheriff wake-up/check preparation for 10 seconds;
   6. enter day one.
4. Timer presets are 60, 30, and 10 seconds. A faint chime plays when the countdown reaches ten seconds; starting a 10-second timer produces the warning once at start. Timer operations are logged.
5. Music controls are start with fade-in, stop with quick fade-out, and stop with slow fade-out. Playback is browser-side. Queue edits change the app’s local playback queue; modifying the actual YouTube playlist is not required for MVP.
6. Day `N` begins at seat `N` (wrapping after seat 10), continues cyclically, and skips eliminated players. One central button starts each turn and its timer.
7. A player can nominate another active player during their turn. Candidate order is preserved and duplicates are rejected.
8. Each player has Foul, Red card, and Nominate actions. The third foul automatically mutes the player’s next normal turn; that turn becomes a 10-second nomination-only window. A red card eliminates the player immediately.
9. Voting records individual voters by tapping voter icons for a selected candidate. An eligible voter can vote once per voting round.
10. At night, the host records one target for each active Mafia-aligned shooter. A kill succeeds only when all active Mafia-aligned shooters select the same active target.
11. The Don then checks one active player for Sheriff; the Sheriff checks one active player for Mafia alignment.
12. The cycle repeats until all Mafia-aligned players are eliminated or active Mafia count is at least active red-team count.
13. Every accepted action, timer operation, override, and result is appended to the game log.
14. The initial visual language is dark, low-glare, table-focused, and precise: near-black panels, green felt table, restrained indigo interaction accents, red/amber only for game state, large touch targets, and no color-only status communication.

## Explicit MVP assumptions that avoid blocking implementation

- The YouTube playlist ID is provided through configuration; development may use a placeholder until the owner supplies the playlist URL/ID.
- Browser autoplay restrictions are satisfied by the host pressing the music start button. The wizard never claims music is playing until the IFrame API reports `PLAYING`.
- The editable queue is stored by the application as ordered YouTube video IDs/URLs. Editing the owner’s real YouTube playlist through Google OAuth is a separate post-MVP feature.
- Red-card removal has no final speech in the first implementation; this is configurable later.
- Don and Sheriff results are shown only in host-private UI and written as secret log payloads.
- The moderator may correct the most recent action through compensating log events; direct event deletion is forbidden.
- Authentication and a spectator display remain production-v1/post-MVP work, not blockers for the local playable slice.

---

### Task 1: Record the refined requirements and architecture decision

**Objective:** Make the user’s interaction flow and implementation assumptions durable before code is created.

**Files:**

- Create: `docs/product-outline.md`
- Create: `docs/adr/0001-typescript-modular-monolith.md`
- Modify: `rules.md`
- Modify: `README.md`
- Modify: GitHub issues #1, #2, #3, #8–#18

**Steps:**

1. Add the confirmed wizard, table, timer, music, day, voting, night, victory, and logging behavior to `docs/product-outline.md`.
2. Record the TypeScript modular-monolith decision and rejected alternatives in ADR 0001.
3. Reconcile the third-foul behavior and web-only platform decision in `rules.md`.
4. Comment on issue #1 with accepted decisions; update implementation issue acceptance criteria without closing work not yet verified.
5. Run markdown link/structure checks and `git diff --check`.

### Task 2: Bootstrap the npm workspace and canonical quality commands

**Objective:** Establish the smallest buildable/testable workspace without product logic.

**Files:**

- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.base.json`
- Create: `apps/web/package.json`
- Create: `apps/server/package.json`
- Create: `packages/game-domain/package.json`
- Modify: `.gitignore`

**Steps:**

1. Define npm workspaces and canonical `format:check`, `lint`, `typecheck`, `test`, and `build` commands.
2. Pin supported Node and npm versions.
3. Install React/Vite, Fastify, PostgreSQL, Zod, Vitest, Testing Library, and Playwright dependencies.
4. Verify the empty workspace commands execute successfully.

### Task 3: Implement the role deck and setup state with TDD

**Objective:** Provide deterministic, testable random role draws and setup gating.

**Files:**

- Test: `packages/game-domain/src/setup.test.ts`
- Create: `packages/game-domain/src/setup.ts`
- Create: `packages/game-domain/src/types.ts`
- Create: `packages/game-domain/src/index.ts`

**RED → GREEN behaviors:**

1. Exactly ten distinct players are required.
2. The role deck contains Sheriff ×1, Citizen ×6, Mafia ×2, Don ×1.
3. Tapping an unassigned seat draws one remaining role; assigned seats cannot draw twice.
4. Seeded randomness produces deterministic tests.
5. Role assignment cannot begin until music state is `PLAYING`.
6. Setup cannot advance until every seat has one role.

**Verification:** `npm test -w @mafia/game-domain -- setup.test.ts`

### Task 4: Implement phase transitions, day rotation, and victory with TDD

**Objective:** Model the complete setup/day/vote/night cycle independently of React.

**Files:**

- Test: `packages/game-domain/src/game.test.ts`
- Create: `packages/game-domain/src/game.ts`
- Modify: `packages/game-domain/src/types.ts`
- Modify: `packages/game-domain/src/index.ts`

**RED → GREEN behaviors:**

1. Legal setup transitions are players → music → roles → Mafia negotiation → Sheriff setup → day.
2. Day one orders seats 1…10; day two 2…10,1; subsequent days rotate and skip inactive seats.
3. The next speaker is deterministic and a day ends after every eligible seat’s turn.
4. Red wins with zero active Mafia-aligned players.
5. Mafia wins when active Mafia-aligned count is at least active red count.
6. Illegal transitions fail without mutating state.

**Verification:** run the focused test, then the full domain suite.

### Task 5: Implement fouls, nominations, individual voting, and tie-ready results with TDD

**Objective:** Capture the complete day interaction model and preserve candidate order.

**Files:**

- Test: `packages/game-domain/src/day-actions.test.ts`
- Create: `packages/game-domain/src/day-actions.ts`
- Modify: `packages/game-domain/src/types.ts`

**RED → GREEN behaviors:**

1. A nomination is accepted only from the current eligible speaker and targets an active other player.
2. Duplicate candidates do not create duplicate voting slots.
3. Candidate insertion order is stable.
4. The third foul creates one pending 10-second nomination-only turn and is consumed once.
5. Red card immediately deactivates the target and triggers a victory check.
6. A voter can vote once; eliminated players cannot vote; vote totals derive from voter assignments.
7. Highest vote result and ties are represented without silently choosing a winner.

### Task 6: Implement Mafia shots and Don/Sheriff checks with TDD

**Objective:** Resolve secret night actions correctly and audibly to the event log, not the public view.

**Files:**

- Test: `packages/game-domain/src/night-actions.test.ts`
- Create: `packages/game-domain/src/night-actions.ts`
- Modify: `packages/game-domain/src/types.ts`

**RED → GREEN behaviors:**

1. Every active Mafia-aligned player records exactly one target.
2. A kill succeeds only when all active Mafia-aligned shooters choose the same active target.
3. Missing, conflicting, duplicate, or inactive-target shots produce no kill.
4. An active Don can check one active target and receives Sheriff/not-Sheriff.
5. An active Sheriff can check one active target and receives Mafia/not-Mafia.
6. Checks and individual shots are marked secret.

### Task 7: Implement append-only events and PostgreSQL persistence

**Objective:** Persist game commands/events transactionally and reconstruct the active game after restart.

**Files:**

- Test: `apps/server/src/event-store.test.ts`
- Create: `apps/server/src/db.ts`
- Create: `apps/server/src/event-store.ts`
- Create: `apps/server/src/schema.sql`
- Create: `apps/server/src/config.ts`

**RED → GREEN behaviors:**

1. Appending an event assigns a monotonic per-game sequence.
2. Duplicate idempotency keys do not append duplicate events.
3. Reading a game returns events in sequence order.
4. Secret event payloads are omitted from public projections.
5. A compensating event corrects state without deleting history.

**Verification:** run server integration tests against PostgreSQL.

### Task 8: Expose the game API and health endpoints

**Objective:** Provide stable HTTP commands/projections for the SPA.

**Files:**

- Test: `apps/server/src/app.test.ts`
- Create: `apps/server/src/app.ts`
- Create: `apps/server/src/routes/games.ts`
- Create: `apps/server/src/projections.ts`
- Create: `apps/server/src/main.ts`

**RED → GREEN behaviors:**

1. `/health/live` and `/health/ready` report process and database readiness separately.
2. Create game, append command, fetch host projection, and fetch log routes work.
3. Invalid commands return structured 4xx responses and append nothing.
4. Repeated idempotent requests return the original result.

### Task 9: Build the setup wizard UI

**Objective:** Deliver the complete gated setup experience on touch devices.

**Files:**

- Test: `apps/web/src/features/setup/SetupWizard.test.tsx`
- Create: `apps/web/src/features/setup/SetupWizard.tsx`
- Create: `apps/web/src/features/setup/PlayerSelectionStep.tsx`
- Create: `apps/web/src/features/setup/MusicStep.tsx`
- Create: `apps/web/src/features/setup/RoleDrawStep.tsx`
- Create: `apps/web/src/api/client.ts`

**RED → GREEN behaviors:**

1. Exactly ten players are selectable and ordered into seats.
2. Music step cannot advance until the player adapter reports `PLAYING`.
3. Each seat tap privately reveals one random remaining role.
4. Wizard progress and errors are announced accessibly.
5. Refresh restores accepted setup state from the API.

### Task 10: Implement the YouTube playlist player, fades, and local queue

**Objective:** Make setup music operational without requiring Google OAuth for MVP.

**Files:**

- Test: `apps/web/src/features/music/music-controller.test.ts`
- Create: `apps/web/src/features/music/youtube-player.ts`
- Create: `apps/web/src/features/music/music-controller.ts`
- Create: `apps/web/src/features/music/MusicControls.tsx`
- Create: `apps/web/src/features/music/QueueEditor.tsx`
- Create: `apps/web/src/types/youtube.d.ts`

**RED → GREEN behaviors:**

1. Fade-in starts muted and reaches configured volume over the configured duration.
2. Quick and slow fade-out reach zero, then pause/stop exactly once.
3. Playback state comes from the IFrame API, not optimistic button state.
4. Queue accepts valid YouTube URLs/video IDs, supports reorder/remove, and rejects invalid entries.
5. Failed/blocked playback leaves the wizard gated and displays a recovery action.

### Task 11: Build the round-table shell and authoritative timer

**Objective:** Render ten touch-friendly player positions, the host, central phase control, and reliable timer presets.

**Files:**

- Test: `apps/web/src/features/table/GameTable.test.tsx`
- Test: `apps/web/src/features/timer/timer.test.ts`
- Create: `apps/web/src/features/table/GameTable.tsx`
- Create: `apps/web/src/features/table/PlayerSeat.tsx`
- Create: `apps/web/src/features/table/HostSeat.tsx`
- Create: `apps/web/src/features/timer/timer.ts`
- Create: `apps/web/src/features/timer/TimerControls.tsx`
- Create: `apps/web/src/styles/app.css`

**RED → GREEN behaviors:**

1. Ten seat icons are arranged around a round table with a distinct host position.
2. Current player and current phase are visible without color alone.
3. 60-, 30-, and 10-second buttons start the requested countdown.
4. The ten-second threshold emits one faint chime per run.
5. Pause/restart and refresh recovery use authoritative timestamps.
6. Primary controls meet a minimum 48×48 CSS-pixel touch target.

### Task 12: Build setup subphases and rotating day controls

**Objective:** Run Mafia negotiation, Sheriff setup, and every day speech from the table.

**Files:**

- Test: `apps/web/src/features/game/GameScreen.test.tsx`
- Create: `apps/web/src/features/game/GameScreen.tsx`
- Create: `apps/web/src/features/game/PhaseBanner.tsx`
- Create: `apps/web/src/features/day/DayControls.tsx`
- Create: `apps/web/src/features/day/PlayerActions.tsx`
- Create: `apps/web/src/features/day/NominationQueue.tsx`

**RED → GREEN behaviors:**

1. Mafia negotiation and Sheriff setup have unmistakable banners and correct central actions.
2. Central day button starts the highlighted player’s 60-second or muted 10-second turn.
3. Foul, red card, and nomination actions are large, confirm destructive effects, and follow domain validation.
4. Eliminated players are visually distinct and skipped.
5. Nomination order remains visible throughout the day.

### Task 13: Build voting and night action screens

**Objective:** Make every vote and secret night action operable by tapping player icons.

**Files:**

- Test: `apps/web/src/features/voting/VotingStage.test.tsx`
- Test: `apps/web/src/features/night/NightStage.test.tsx`
- Create: `apps/web/src/features/voting/VotingStage.tsx`
- Create: `apps/web/src/features/night/NightStage.tsx`
- Create: `apps/web/src/features/night/SecretResult.tsx`

**RED → GREEN behaviors:**

1. Selecting a candidate and tapping eligible voter icons assigns each voter once.
2. Vote totals and unassigned voters remain visible.
3. Night screen guides each active Mafia shooter, then Don, then Sheriff in order.
4. Secret targets/results are hidden behind a host privacy control.
5. Night resolution displays success/miss, performs win check, then advances to the next rotated day.

### Task 14: Build the complete game log and correction flow

**Objective:** Make every accepted operation inspectable and the latest mistake correctable.

**Files:**

- Test: `apps/web/src/features/log/GameLog.test.tsx`
- Create: `apps/web/src/features/log/GameLog.tsx`
- Create: `apps/web/src/features/log/EventSummary.tsx`
- Modify: `apps/server/src/routes/games.ts`

**RED → GREEN behaviors:**

1. Log entries show sequence, game time, phase, actor/seat, action, and public result.
2. Secret values are hidden by default and never enter a public projection.
3. Timer, music, foul, nomination, vote, shot, check, elimination, transition, victory, and correction events all appear.
4. Correcting the latest action appends a compensating event and refreshes projections.

### Task 15: Containerize, verify, and document the vertical slice

**Objective:** Run the complete app locally through Docker Compose and prove the critical workflows.

**Files:**

- Create: `Dockerfile`
- Create: `compose.yaml`
- Create: `.dockerignore`
- Create: `apps/web/e2e/setup-and-day.spec.ts`
- Create: `apps/web/e2e/night-and-victory.spec.ts`
- Modify: `README.md`
- Modify: `.env.example`

**Steps:**

1. Build a multi-stage image and PostgreSQL service with a health check and persistent volume.
2. Gate API readiness on PostgreSQL health and schema migration.
3. Run canonical format, lint, typecheck, unit, integration, and production builds.
4. Run E2E workflows for setup → first day and night → victory.
5. Start Compose, call health endpoints, load the SPA in a real browser, and visually verify tablet and laptop layouts.
6. Test container restart and active-game restoration.
7. Document playlist configuration, browser media permissions, start/stop, data reset, backup, and known limitations.
8. Commit and push only after the working tree, tests, Docker runtime, and remote commit are verified.

---

## Verification matrix

| Area          | Required proof                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| Domain        | Vitest covers setup gates, role counts, rotations, fouls, nominations, votes, shots, checks, and both victories |
| API           | Fastify injection tests plus PostgreSQL integration tests                                                       |
| SPA           | Testing Library component tests and keyboard/touch semantics                                                    |
| Music         | Unit tests with a fake IFrame adapter plus real manual browser playback using the configured playlist           |
| Timer         | Fake-clock unit tests plus browser refresh/reconnect check                                                      |
| Persistence   | Container restart restores active game and ordered log                                                          |
| Security      | Host/public projection tests prevent secret payload leakage                                                     |
| Responsive UI | Browser screenshots at 1024×768 tablet and 1440×900 laptop sizes                                                |
| Deployment    | `docker compose up --build`, healthy API/database, production SPA served                                        |

## Principal risks and mitigations

- **YouTube autoplay/media policy:** require an explicit host tap and gate progress on the real player state.
- **YouTube playlist mutation:** keep a local queue in MVP; actual playlist editing requires Google OAuth and YouTube Data API scopes.
- **Secret leakage on a shared display:** use host-only projection and an instant privacy shield; public display remains separate.
- **Timer drift/background throttling:** derive time from server/event timestamps, never accumulated UI intervals.
- **Accidental double taps:** command idempotency keys and visibly disabled in-flight controls.
- **Ambiguous tournament variants:** snapshot resolved settings per game and keep moderator overrides auditable.
- **Round-table layout on narrow screens:** support landscape tablet/laptop first, scale seats with CSS container queries, and provide a compact list fallback below the approved minimum width.
