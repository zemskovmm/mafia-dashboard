# Incremental Game Replay, Log-State Preview, Reset, and Timeline Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make the game log the canonical incremental history for replaying any accepted game state, add read-only preview and confirmed reset controls to every previewable Log entry, and build the full-screen Dev timeline from the same replayed log.

**Architecture:** Store one immutable initial-game baseline when role setup completes, then append one semantic transition event for each accepted game action. Reconstruct current, historical-preview, and timeline states with one pure replay reducer; never store a complete `GameState` for every step. Preserve append-only history by linking each event to its parent and moving a session head pointer for undo/reset, so resetting to an old state creates a new branch rather than deleting historical events. Keep provisional UI choices outside the canonical log until the host confirms their outcome.

**Tech Stack:** TypeScript 6, React 19, Vite 8, Fastify 5, PostgreSQL 17, Zod 4, Vitest 4, Testing Library, Playwright/WebKit, Lucide React, CSS Grid/custom properties.

---

## Delivery mode and repository state

- Target repository: `/Users/Michael/Repos/Mafia Dashboard`.
- Baseline branch: `main`, currently one commit ahead of `origin/main`.
- The working tree already contains 21 modified files, including the gameplay and persistence files this feature will touch. Do **not** reset, restore, overwrite, rebase, or clean those edits.
- This is still rapid-prototype work: use focused tests and browser probes, rebuild the running app after each visible slice, and leave changes uncommitted until Michael accepts them. Do not push or start broad CI/review loops.
- This document is planning only. Implementation must not begin until Michael explicitly asks.
- Required delivery order:
  1. verify and repair the event contract;
  2. implement and verify canonical replay;
  3. replace per-step snapshots with incremental persistence;
  4. implement Log preview/reset;
  5. generate deterministic sample history;
  6. implement the timeline from replay frames.

## Updated source-backed audit

The working tree already records most requested outcomes, but it is not yet a replayable event source:

| Requirement | Existing event(s) | Replay issue |
|---|---|---|
| Set player for voting | `player.nominated` | Payload is sufficient |
| Voting result | `voting.resolved`, `car-crash.resolved`, `voting.skipped` | Final events must carry all accepted provisional vote data needed to replay |
| Mafia shots/miss | `mafia.shot-recorded`, `mafia.shots-resolved` | Split rows should become one accepted resolution event containing the evaluated shots and result |
| Don/Sheriff checks | `don.checked`, `don.check-skipped`, `sheriff.checked`, `sheriff.check-skipped` | Payload is nearly sufficient; replay must validate the result against roles |
| Fouls/red cards | `foul.issued`, `player.red-carded` | Fourth foul currently creates two rows for one accepted transition; one event should carry both effects |
| Phase progression | Some `phase.changed` plus incidental action rows | Source/destination ownership is inconsistent |

The persistence implementation also conflicts with the new requirement:

1. `GameSessionOutbox.enqueue` stores the full `GameSessionState` in every queued mutation.
2. `game_sessions.state` is overwritten with the complete setup, current game, full log, and full undo snapshots on every save.
3. `GameSessionStore.replaceLogTail` deletes every authoritative event after `game.created` and reinserts the complete client log on every mutation.
4. Undo stores complete `GameState` snapshots in `undoHistory`.
5. `vote.assigned`, `voting.candidate-advanced`, and `car-crash.vote-assigned` are currently logged even though they are provisional UI interactions.
6. Timer/music/setup controls are filtered inconsistently between client and server.
7. Completed sessions are individually readable but not listable.

The target design removes all four forms of repeated full-state storage. The database keeps one replay baseline plus append-only events; browser session storage keeps the same baseline, active event chain, and pending incremental operations.

---

## Canonical product contract

### 1. What counts as a log state

A **log state** is the canonical game state immediately after one accepted semantic game event. Every previewable Log row maps to exactly one replay frame:

```ts
interface ReplayFrame {
  readonly entry: GameLogEntry;
  readonly before: GameState;
  readonly after: GameState;
}
```

Rows that are metadata-only and have no game baseline, such as legacy `game.created` during setup, are visible but their Preview/Reset buttons are disabled with an explanation.

### 2. One event per accepted game transition

One host confirmation produces one canonical transition event. Secondary consequences live in that event payload instead of creating ambiguous adjacent states.

Canonical event types for new games:

- `game.started` — replay root; the initial state itself is stored once in the session baseline;
- `phase.changed` — only for a control whose sole accepted effect is phase progression;
- `turn.completed`;
- `player.nominated`;
- `foul.issued` — includes resulting foul count and whether the fourth foul red-carded the player;
- `player.red-carded` — direct red-card action only;
- `voting.skipped`;
- `voting.resolved` — includes accepted vote assignments, totals, resolution kind, eliminated seats, resulting phase, and winner if any;
- `car-crash.resolved` — includes accepted decision votes and resulting state;
- `mafia.shots-resolved` — includes every evaluated shooter/target pair and kill/no-effect/miss result;
- `don.checked` / `don.check-skipped`;
- `sheriff.checked` / `sheriff.check-skipped`;
- `best-move.completed` — includes the final three selected seats and hit count;
- `game.completed` — explicit Finish game confirmation and persisted results; this does not invent an extra gameplay state.

A direct red card that cancels voting remains one `player.red-carded` transition whose payload/resulting state identifies the cancellation. A fourth foul remains one `foul.issued` transition with `redCarded: true`. Timeline projection may render both foul and red-card visual semantics from the same replay frame.

### 3. Interactions that are intentionally provisional

These may update an in-memory draft but never append events and never create replay states:

- opening/closing drawers, privacy, swipe, or preview UI;
- timer/music controls;
- setup roster edits, role reveal/reroll/manual role selection;
- assigning/changing individual votes;
- advancing voting candidates;
- selecting eliminate/keep before car-crash resolution;
- toggling/auto-filling Mafia targets before Evaluate;
- reopening Mafia results for re-evaluation;
- toggling Best move seats before Save;
- preview entry/exit;
- Undo or Reset head-pointer movement.

Because these are not accepted log states, a browser reload may discard an unfinished provisional choice and return to the latest accepted event. Entering Preview without reloading must preserve the exact in-memory live draft so Exit preview restores it.

### 4. Replay baseline and immutable rules

At `game.started`, store one immutable `InitialGameBaseline` containing:

- the complete initial `GameState` after role draw;
- player IDs/names/seats/roles/teams;
- host identity;
- any rules/configuration values that can affect deterministic replay;
- a schema/replay version.

No later configuration or profile edit may change this baseline. Setup state may continue to use a setup snapshot before the game starts; the no-per-step-snapshot rule applies once `game.started` exists.

### 5. Append-only branching and the active head

Each event has a globally append-ordered `sequence` and a `parentEventId`:

```ts
interface GameLogEntry {
  readonly id: string;
  readonly gameId: string;
  readonly sequence: number;
  readonly parentEventId: string | null;
  readonly type: CanonicalGameEventType;
  readonly payload: CanonicalGameEventPayload;
  readonly phaseBefore: GamePhase;
  readonly phaseAfter: GamePhase;
  readonly dayBefore: number;
  readonly dayAfter: number;
  readonly secret: boolean;
  readonly stateHashAfter: string;
  readonly createdAt: string;
}
```

`game_sessions.head_event_id` identifies the active branch. Undo/reset moves the head without deleting rows. If a new event is accepted after moving backward, its parent is the moved head and it begins a new active branch. Old future rows remain available for audit and recovery but disappear from the ordinary active Log and active timeline.

### 6. Preview and reset UX

Every previewable active Log row has two actions:

- **Preview state**
- **Reset game to this state**

Preview behavior:

- closes the Log drawer;
- leaves the actual active head, live game, outbox, and database untouched;
- renders the replayed historical state in the normal table geometry;
- disables/hides every gameplay, timer, music, swipe, Dev, Log, undo, and seat action;
- shows exactly two enabled controls in the table center:
  1. **Exit preview** — restore the exact live in-memory game/draft that existed before preview;
  2. **Reset game to this state** — run the same confirmed reset operation as the Log-row Reset button.

Reset behavior:

- requires a confirmation naming the selected log number and how many active future actions will be left behind;
- moves the active head to the selected event; it does not delete event rows;
- immediately derives the new actual game by replaying the selected active chain;
- clears provisional draft UI and leaves Preview;
- clears completed results/statistics if the selected state precedes completion;
- records the previous head pointer as a one-step reset recovery pointer so the next Undo can restore the pre-reset branch if no new event has been accepted;
- after a new accepted event, reset recovery is cleared because a new branch now exists.

Reset is available only for the current active game. Past completed-game timeline entries are read-only and can never replace another active game.

### 7. Undo contract

- Ordinary Undo moves the active head to its parent; no game-log event is appended.
- Only the latest three accepted events are undoable.
- A new day remains a checkpoint: ordinary Undo cannot cross the latest transition into that day.
- Undo removes the event from the **active** Log/timeline by moving the head, while retaining the append-only database row off-branch.
- Immediately after a Reset, the first Undo restores the saved pre-reset head. It does not append an event.
- No full `UndoSnapshot.game` values are stored.

### 8. Timeline contract

The timeline receives:

```ts
buildTimeline(replayGameLog(initialBaseline, activeBranchEvents).frames)
```

It does not read `state.game` snapshots and does not infer canonical state directly from unvalidated payload strings. Region boundaries use each replay frame’s actual `before`/`after` phases and days.

Color-coded regions remain:

- Initial night;
- Day N;
- Voting N;
- Night N;
- Finished as a terminal marker, not a fifth region.

The horizontal axis is accepted-event sequence order, not elapsed wall-clock time. Timestamps remain visible in details.

---

### Task 1: Freeze the dirty baseline and prove the current snapshot behavior

**Objective:** Protect current prototype edits and turn the architectural gaps into executable RED evidence.

**Files:**
- Inspect: `apps/web/src/App.tsx`
- Inspect: `apps/web/src/session-outbox.ts`
- Inspect: `apps/server/src/game-session-store.ts`
- Inspect: `apps/server/src/schema.sql`

**Step 1: Capture baseline identity**

Run:

```bash
git status --short --branch
git diff --stat
git diff --check
```

Expected: existing dirty files remain; no whitespace errors are introduced.

**Step 2: Run focused current tests**

```bash
npm run test -w @mafia/web -- \
  src/session-outbox.test.ts \
  src/App.test.tsx \
  src/features/game/GameScreen.test.tsx \
  src/features/voting/VotingStage.test.tsx \
  src/features/night/NightStage.test.tsx
npm run test -w @mafia/server -- \
  src/game-session-validation.test.ts \
  src/game-session-store.test.ts
```

Record pre-existing failures separately.

**Step 3: Add RED assertions before changing production code**

The first failures must demonstrate that:

- an outbox mutation currently contains a full `state.game`, `state.log`, and `undoHistory`;
- a server save currently deletes/reinserts the event tail;
- provisional vote assignments currently emit rows;
- no pure `replayGameLog` exists;
- no session head pointer exists.

A test harness compile error is not valid RED; repair the harness until it fails on these semantics.

---

### Task 2: Define canonical event payloads and replay versions

**Objective:** Establish one typed contract that is sufficient to reconstruct every accepted state.

**Files:**
- Create: `packages/game-domain/src/game-events.test.ts`
- Create: `packages/game-domain/src/game-events.ts`
- Modify: `packages/game-domain/src/index.ts`

**Step 1: Write the event-shape RED tests**

Require discriminated payloads rather than `Record<string, unknown>`:

```ts
type CanonicalGameEvent =
  | { readonly type: "turn.completed"; readonly payload: { readonly seat: number } }
  | {
      readonly type: "voting.resolved";
      readonly payload: {
        readonly voteAssignments: Readonly<Record<number, number>>;
        readonly totals: Readonly<Record<number, number>>;
        readonly kind: VoteResult["kind"];
        readonly eliminatedSeats: readonly number[];
      };
    }
  | {
      readonly type: "mafia.shots-resolved";
      readonly payload: {
        readonly shots: readonly ShotAssignment[];
        readonly result: NightShotResult;
      };
    };
```

Add all canonical types listed above, including source/result phase/day metadata in the persisted envelope.

**Step 2: Verify RED**

```bash
npm run test -w @mafia/game-domain -- src/game-events.test.ts
```

Expected: missing module/types.

**Step 3: Add runtime classification**

Export:

- `canonicalGameEventTypes` tuple;
- `CanonicalGameEventType`;
- discriminated `CanonicalGameEventDraft`;
- `GameLogEntry`;
- `isCanonicalGameEventType`;
- `isProvisionalInteractionType` for historical filtering;
- `CURRENT_REPLAY_VERSION`.

The canonical tuple must exclude `vote.assigned`, `voting.candidate-advanced`, `car-crash.vote-assigned`, `mafia.shot-recorded`, all `setup.*`, `timer.*`, and `music.*`.

**Step 4: Verify GREEN**

```bash
npm run test -w @mafia/game-domain -- src/game-events.test.ts
npm run typecheck -w @mafia/game-domain
```

**Prototype checkpoint:** no commit.

---

### Task 3: Implement the pure replay reducer with state-hash verification

**Objective:** Make one function the authority for live accepted transitions, historical preview, server reconstruction, and timeline frames.

**Files:**
- Create: `packages/game-domain/src/game-replay.test.ts`
- Create: `packages/game-domain/src/game-replay.ts`
- Modify: `packages/game-domain/src/index.ts`
- Modify as needed: `packages/game-domain/src/day-actions.ts`
- Modify as needed: `packages/game-domain/src/night-actions.ts`
- Modify as needed: `packages/game-domain/src/game.ts`

**Step 1: Write one vertical RED tracer**

```ts
const event = createNominationEvent(initialDay, { nominatorSeat: 1, candidateSeat: 4 });
const after = applyGameEvent(initialDay, event);
expect(after.nominations).toEqual([{ nominatorSeat: 1, candidateSeat: 4, order: 1 }]);
```

Run the single test and require semantic failure because replay is missing.

**Step 2: Implement `applyGameEvent` by reusing domain rules**

Simple events call existing pure domain functions. Aggregate acceptance events first inject their captured provisional data, then invoke existing resolution logic. Do not duplicate rule formulas in the web or server packages.

**Step 3: Add one RED→GREEN cycle per event type**

Cover:

- phase change;
- turn completion;
- nomination;
- foul including fourth-foul red card/cancelled voting;
- direct red card;
- skipped voting;
- normal and car-crash voting resolution;
- Mafia kill/no-effect/miss with captured shots;
- Don/Sheriff check and skip;
- Best move completion;
- completion metadata no-op on `GameState`.

**Step 4: Add replay-chain output**

```ts
export const replayGameLog = (
  baseline: InitialGameBaseline,
  activeEntries: readonly GameLogEntry[],
): { readonly game: GameState; readonly frames: readonly ReplayFrame[] };
```

Require strict parent continuity, increasing append sequence along the chosen chain, and matching replay version.

**Step 5: Add deterministic state hashing**

Canonicalize object keys and hash each derived state. `stateHashAfter` is verification metadata, not a saved state. Replay must fail closed with the event ID/sequence if a hash disagrees.

**Step 6: Add immutability/branch tests**

- baseline and event payloads are not mutated;
- replaying the same chain twice is byte-equivalent;
- two children of the same parent produce independent branch outcomes;
- malformed/illegal events are rejected before state changes;
- secret events remain replayable without exposing payloads in public projection.

**Step 7: Verify domain suite**

```bash
npm run test -w @mafia/game-domain -- \
  src/game-events.test.ts \
  src/game-replay.test.ts \
  src/day-actions.test.ts \
  src/night-actions.test.ts \
  src/game.test.ts
npm run typecheck -w @mafia/game-domain
```

**Gate:** no web preview, persistence migration, sample timeline, or timeline UI work starts until replay parity is green.

---

### Task 4: Make accepted web actions use the same event/replay path

**Objective:** Eliminate dual writes where React updates one state while logging another description.

**Files:**
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/features/game/GameScreen.test.tsx`
- Modify: `apps/web/src/features/game/GameScreen.tsx`
- Modify: `apps/web/src/features/voting/VotingStage.test.tsx`
- Modify: `apps/web/src/features/voting/VotingStage.tsx`
- Modify: `apps/web/src/features/night/NightStage.test.tsx`
- Modify: `apps/web/src/features/night/NightStage.tsx`
- Modify: `apps/web/src/features/setup/SetupWizard.test.tsx`
- Modify: `apps/web/src/features/setup/SetupWizard.tsx`

**Step 1: Introduce the wished-for accepted-event seam in tests**

Components should expose:

```ts
readonly onAcceptEvent: (event: CanonicalGameEventDraft) => void;
readonly onDraftChange?: (draft: GameState) => void;
```

An accepted action no longer calls both `onGameChange` and `onEvent` independently.

**Step 2: Verify RED on nomination**

Require one nomination event and assert the rendered next game equals `applyGameEvent(before, event)`.

**Step 3: Move provisional choices out of canonical persistence**

Use component-local/draft state for:

- individual vote assignments and candidate position;
- car-crash decision assignments;
- Mafia target toggles/re-evaluation draft;
- Best move seat toggles.

On Resolve/Evaluate/Save, create one event containing the complete accepted draft, apply it to the canonical head state, clear the draft, and render the replay result.

**Step 4: Consolidate secondary rows**

- remove `vote.assigned`, `voting.candidate-advanced`, `car-crash.vote-assigned`;
- remove individual `mafia.shot-recorded` rows and include `shots` in `mafia.shots-resolved`;
- fourth foul becomes one `foul.issued` with `redCarded: true`;
- voting elimination/winner data stays in one voting result event;
- an event that itself changes phase records that transition; do not append an extra `phase.changed` row;
- reserve `phase.changed` for a pure phase-advance button.

**Step 5: Remove setup logging**

Role/setup interactions remain in the setup snapshot until `game.started`. `SetupWizard` stops emitting setup events.

**Step 6: Add no-event regressions**

Assert every provisional interaction in the product contract changes only draft UI and emits no canonical event.

**Step 7: Add live/replay parity assertions**

For each accepted path, capture the emitted event and prove:

```ts
expect(renderedNextGame).toEqual(applyGameEvent(canonicalBefore, emittedEvent));
```

**Step 8: Verify focused web behavior**

```bash
npm run test -w @mafia/web -- \
  src/App.test.tsx \
  src/features/game/GameScreen.test.tsx \
  src/features/voting/VotingStage.test.tsx \
  src/features/night/NightStage.test.tsx \
  src/features/setup/SetupWizard.test.tsx
npm run typecheck -w @mafia/web
```

**Prototype checkpoint:** no commit.

---

### Task 5: Replace browser full-snapshot mutations with an incremental v4 outbox

**Objective:** Persist one baseline plus incremental operations in sessionStorage and preserve current concurrency protections.

**Files:**
- Modify: `apps/web/src/session-outbox.test.ts`
- Modify: `apps/web/src/session-outbox.ts`
- Modify: `apps/web/src/api/client.test.ts`
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/App.tsx`

**Step 1: Define the v4 envelope in tests**

```ts
interface PersistedEnvelopeV4 {
  readonly version: 4;
  readonly gameId: string | null;
  readonly revision: number;
  readonly baseline: InitialGameBaseline | null;
  readonly activeEntries: readonly GameLogEntry[];
  readonly headEventId: string | null;
  readonly resetReturnEventId: string | null;
  readonly setup: SetupSessionMetadata | null;
  readonly outbox: readonly SessionOperation[];
  readonly failed: boolean;
}

type SessionOperation =
  | StartGameOperation
  | AppendEventOperation
  | MoveHeadOperation
  | CompleteGameOperation
  | SetupMetadataOperation;
```

No queued operation may contain a full current `GameState`, full cumulative log, or full undo snapshots.

**Step 2: Verify RED**

Use the current outbox and assert it fails because mutations contain `state.game`, `state.log`, and `undoHistory`.

**Step 3: Add incremental enqueue methods**

- `saveSetup(...)` before game start;
- `startGame(baseline, gameStartedEvent)` once;
- `appendEvent(eventDraft)`;
- `moveHead(targetEventId, reason: "undo" | "reset" | "restore-reset")`;
- `completeGame(results)`.

Preserve idempotency IDs, base revisions, durable storage, status reporting, stale StrictMode protections, clear behavior, and canonical server-assigned names.

**Step 4: Derive current state; never store it**

`outbox.currentGame` calls `replayGameLog(baseline, activeChain)` or returns a memoized derived value. Session storage contains baseline/events only.

**Step 5: Define provisional reload behavior**

Provisional component drafts are intentionally not in the v4 envelope. Reload restores the latest accepted head state.

**Step 6: Migrate v3 browser data safely**

For a v3 active session:

- retain setup/host/playlist metadata;
- create a compatibility replay checkpoint from its current `state.game`;
- retain old events for timeline display but mark pre-checkpoint states non-previewable;
- never fabricate historical states from an incomplete old log;
- persist v4 only after successful normalization.

**Step 7: Re-run adversarial outbox tests**

Cover stale success/failure, multiple mounts, offline retry, clear during save, append then reset, reset of unacknowledged events, and canonical name adoption.

```bash
npm run test -w @mafia/web -- src/session-outbox.test.ts src/api/client.test.ts src/App.test.tsx
npm run typecheck -w @mafia/web
```

**Prototype checkpoint:** no commit.

---

### Task 6: Expand the PostgreSQL schema for replay bases, parent links, and active heads

**Objective:** Add incremental replay storage without destroying legacy sessions or event history.

**Files:**
- Modify: `apps/server/src/schema.sql`
- Modify: `apps/server/src/initialize-schema.ts` only if required by the existing bootstrap mechanism
- Create: `scripts/verify-game-replay-migration.mjs`
- Modify: `package.json`

**Step 1: Inventory real starting states**

The migration probe must cover:

1. fresh empty database;
2. populated current schema with active v3 sessions;
3. populated completed v3 sessions;
4. partially upgraded schema with new nullable columns but no backfill completion;
5. second startup/idempotent rerun.

**Step 2: Add nullable expand-phase columns**

Proposed schema:

```sql
ALTER TABLE game_events ADD COLUMN IF NOT EXISTS parent_event_id UUID NULL;
ALTER TABLE game_events ADD COLUMN IF NOT EXISTS replay_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE game_events ADD COLUMN IF NOT EXISTS state_hash_after TEXT NULL;

ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS initial_game JSONB NULL;
ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS replay_base_event_id UUID NULL;
ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS head_event_id UUID NULL;
ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS reset_return_event_id UUID NULL;
ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS replay_version INTEGER NOT NULL DEFAULT 1;
```

Add indexes for `(club_id, game_id, parent_event_id)` and active-head reads. Add self/session foreign keys only after populated backfill proves every reference valid.

**Step 3: Backfill legacy linear parent links idempotently**

Use `LAG(id) OVER (PARTITION BY game_id ORDER BY sequence)` for rows whose parent is null, without overwriting rows already linked by the new writer.

**Step 4: Create honest compatibility replay bases**

For legacy sessions, store one compatibility checkpoint at the current head using the existing full `state.game`. Do not claim that earlier historical states are replayable. Preserve the old `state` column during expand/compatibility rollout.

**Step 5: Prove semantic postconditions**

The disposable probe must read back:

- new columns and indexes;
- exact parent chain for representative games;
- `head_event_id` belonging to the same game/club;
- one compatibility checkpoint for legacy active/completed sessions with a game;
- no deleted events/results/statistics;
- second-run no-op behavior.

**Step 6: Keep rollback non-destructive**

Do not drop new event columns or parent data in a prototype rollback path. The previous binary must continue to read its existing `state` JSON while ignoring additive columns.

Run:

```bash
npm run verify:game-replay-migration
```

Expected: fresh, populated, partial, and rerun probes report explicit semantic success markers and clean up disposable databases.

**Prototype checkpoint:** no commit.

---

### Task 7: Add authoritative incremental append and head-move APIs

**Objective:** Stop replacing full session/log state and make the server validate replay transitions atomically.

**Files:**
- Modify: `apps/server/package.json`
- Modify: `package-lock.json`
- Modify: `apps/server/src/game-session-validation.test.ts`
- Modify: `apps/server/src/game-session-validation.ts`
- Modify: `apps/server/src/game-session-store.test.ts`
- Modify: `apps/server/src/game-session-store.ts`
- Modify: `apps/server/src/app.test.ts`
- Modify: `apps/server/src/app.ts`

**Step 1: Add the shared domain dependency**

The server uses `@mafia/game-domain` for runtime event validation/replay. Do not duplicate replay logic in server source.

**Step 2: Write API contract RED tests**

Add exact endpoint contracts:

```http
POST /api/game-sessions/:gameId/start
POST /api/game-sessions/:gameId/events
POST /api/game-sessions/:gameId/head
POST /api/game-sessions/:gameId/complete
```

Every mutation includes `mutationId` and `baseRevision`. Append includes the expected parent/head. Head movement includes target event and reason. Existing GET responses remain compatible by returning a server-replayed `state.game`, even though that state is no longer stored after every step.

**Step 3: Implement idempotent start**

Store one initial baseline and `game.started` root. Exact duplicate mutation returns the prior revision; mismatched reuse returns 409.

**Step 4: Implement append-only event mutation**

In one transaction:

1. lock the session and game event sequence/head;
2. verify club ownership, revision, parent equals active head, and mutation idempotency;
3. read the replay base and active parent chain;
4. replay/validate the event with the shared reducer;
5. allocate `MAX(sequence)+1` for append order;
6. store event with computed phase/day/hash metadata;
7. move `head_event_id` to the new row;
8. clear `reset_return_event_id` because a new branch has begun;
9. update active roster/results projections as required;
10. increment revision and commit.

Never delete/reinsert prior events and never accept a client-supplied full current state as proof.

**Step 5: Implement head movement**

- target must belong to the same club/game and be reachable from the baseline;
- Undo target must be the active parent and obey three-action/day-checkpoint policy;
- Reset may target any previewable event on the currently active chain;
- Reset stores the previous head in `reset_return_event_id`;
- restore-reset may target exactly that saved head if no new append cleared it;
- current game is replayed from the new head;
- if moving before completion, atomically retract `game_results` and player projections and mark session active.

No game event is appended for a head move.

**Step 6: Implement completion**

Finish game validates the replayed head is `finished`, computes/verifies results, stores projections, marks the session completed, and appends/records completion metadata without storing another full state.

**Step 7: Preserve old API reads during migration**

`GET /api/game-sessions/:gameId` should return:

- baseline/replay capability metadata;
- active-chain events;
- server-derived current `state.game` for the current client contract;
- `previewableFromEventId` or null for legacy checkpoint sessions;
- results/status/revision.

**Step 8: Verify concurrency and branch safety**

Tests must cover:

- two concurrent appends to one head: one wins, one gets revision conflict;
- idempotent retry;
- stale parent rejection;
- reset while append is blocked;
- append after reset creates a branch and does not delete old future rows;
- cross-club target/head rejection;
- completion/reset races;
- previous binary read compatibility on additive schema.

```bash
npm run test -w @mafia/server -- \
  src/game-session-validation.test.ts \
  src/game-session-store.test.ts \
  src/app.test.ts
npm run typecheck -w @mafia/server
```

**Gate:** verify SQL readback shows one baseline and N incremental event rows—not N full game snapshots—before UI preview work.

---

### Task 8: Implement active-branch helpers and cursor-based Undo

**Objective:** Make the client derive its Log, current state, undo count, and reset recovery from event links/head pointers.

**Files:**
- Create: `apps/web/src/features/game/game-history.test.ts`
- Create: `apps/web/src/features/game/game-history.ts`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/App.tsx`

**Step 1: Write branch extraction RED tests**

Given all local events and a head ID, require `getActiveBranch` to follow parents back to the replay base and return root→head order. Reject cycles, missing parents, and cross-game IDs.

**Step 2: Add undo availability tests**

Return at most three parent events after the latest Day checkpoint. Off-branch events do not count.

**Step 3: Add reset recovery tests**

Immediately after reset, Undo restores the saved previous head. After one new accepted event, reset recovery is unavailable and ordinary parent undo applies.

**Step 4: Wire App state to replay**

The actual canonical game is always:

```ts
replayGameLog(baseline, getActiveBranch(events, headEventId)).game
```

Remove `UndoSnapshot.game`, `logLength`, and `sequence` state.

**Step 5: Verify**

```bash
npm run test -w @mafia/web -- \
  src/features/game/game-history.test.ts \
  src/App.test.tsx \
  src/session-outbox.test.ts
```

**Prototype checkpoint:** no commit.

---

### Task 9: Add read-only table preview mode

**Objective:** Render any replay frame in the table while guaranteeing that preview cannot mutate actual state.

**Files:**
- Modify: `apps/web/src/features/game/GameScreen.test.tsx`
- Modify: `apps/web/src/features/game/GameScreen.tsx`
- Modify: `apps/web/src/features/table/GameTable.test.tsx`
- Modify: `apps/web/src/features/table/GameTable.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles/app.css`

**Step 1: Write the preview rendering RED test**

Render `GameScreen` with:

```ts
mode="preview"
previewControls={{ onExit, onReset }}
```

Require exactly two enabled table-center buttons:

- Exit preview
- Reset game to this state

Require zero Foul, Vote/Nominate, Red card, phase advance, voting assignment, Mafia shot, check, timer, music, swipe, or finish controls.

**Step 2: Separate actual and preview state**

App keeps:

- canonical actual baseline/events/head;
- current in-memory live draft ref;
- `previewTargetEventId` and derived `previewGame`.

Entering preview must not call `setGame` on canonical state, enqueue persistence, move head, clear drafts, or alter results.

**Step 3: Implement exact Exit behavior**

Exit clears preview state and renders the exact preserved live draft. Add a test with an unconfirmed Mafia/vote draft to prove it returns unchanged.

**Step 4: Disable all external action surfaces**

While previewing:

- hide app toolbar except no gameplay controls; the only actionable elements are the two center buttons;
- hide utility rail actions/timer and music dock;
- disable touch swipe/seat clicks and keyboard shortcuts;
- prevent Dev/Log/Undo handlers from being reachable;
- add a clear `Preview · Log #N` banner that is not a button.

**Step 5: Verify no persistence**

Enter preview, select several non-interactive cards, exit, and assert no API/outbox/sessionStorage mutation occurred.

```bash
npm run test -w @mafia/web -- \
  src/features/game/GameScreen.test.tsx \
  src/features/table/GameTable.test.tsx \
  src/App.test.tsx
```

**Prototype checkpoint:** no commit.

---

### Task 10: Add Preview and Reset controls to each Log row

**Objective:** Allow direct navigation to every previewable active log state from the existing drawer.

**Files:**
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles/app.css`

**Step 1: Write the Log-row RED test**

Open Log with three active-chain events. Each previewable row must have:

- `Preview state after log #N`
- `Reset game to state after log #N`

Legacy/pre-baseline rows remain visible but buttons are disabled and explain why.

**Step 2: Implement Preview action**

Replay baseline through the selected active-chain row, close drawer, and enter preview without changing head/revision/outbox.

**Step 3: Implement shared confirmed Reset action**

Both the row button and center Preview button call one handler. Confirmation text states:

```text
Reset the active game to log #N? X later active actions will leave the current branch. Their history will be preserved.
```

Cancel is a no-op.

**Step 4: Apply reset only through head movement**

On confirmation:

- enqueue/send the head move;
- derive actual state from target head;
- clear provisional draft;
- leave preview/close drawer;
- clear/retract results when required;
- preserve old future events off-branch;
- expose reset recovery through Undo.

If server validation fails, keep the previous actual head/game and show an error; never claim reset succeeded from optimistic UI alone without server/outbox acknowledgement semantics.

**Step 5: Add concurrency regressions**

- preview stays safe while a save is pending;
- reset queues after older appends in correct revision order;
- stale reset response cannot overwrite a newer local game/head;
- direct row reset and preview-center reset use identical behavior;
- reset is disabled for completed past games and non-previewable legacy rows.

**Step 6: Verify**

```bash
npm run test -w @mafia/web -- src/App.test.tsx src/session-outbox.test.ts
npm run typecheck -w @mafia/web
```

**Gate:** manually inspect the Log drawer before starting sample/timeline code.

---

### Task 11: Generate deterministic baseline-plus-events sample history

**Objective:** Produce sample data that proves replay, preview, reset, branching, and timeline behavior without persisting synthetic games/statistics.

**Files:**
- Create: `apps/web/src/features/timeline/sample-game-data.test.ts`
- Create: `apps/web/src/features/timeline/sample-game-data.ts`

**Step 1: Write fixture RED tests**

`createSampleGameHistory()` must return:

- one immutable initial baseline;
- append-only canonical entries with valid parent links/hashes;
- one active head;
- at least one inactive branch created by a simulated reset;
- deterministic replay frames for Initial night, Day 1, Voting 1, Night 1, Day 2, Voting 2, Night 2, Finished;
- nomination, resolved vote, Mafia kill, Mafia miss, Don result, Sheriff result, foul, fourth-foul red card, voting cancellation, and completion;
- no full state attached to any event;
- no provisional/setup/timer/music event type.

**Step 2: Verify RED**

```bash
npm run test -w @mafia/web -- src/features/timeline/sample-game-data.test.ts
```

**Step 3: Build through the real replay/event APIs**

Do not hand-author expected `after` states. Create the baseline, append canonical drafts through `applyGameEvent`, compute hashes, then replay and assert final state.

**Step 4: Keep it browser-only**

Label the option `Sample game · not saved`. No fetch, PostgreSQL write, game results, or player-statistic mutation.

**Step 5: Verify deterministic output twice**

Expected: byte-equivalent event JSON and replay frames.

**Gate:** timeline code starts only after sample replay and state previews pass.

---

### Task 12: List completed games and fetch replay material safely

**Objective:** Provide club-scoped history selection without returning per-step snapshots.

**Files:**
- Modify: `apps/server/src/game-session-store.test.ts`
- Modify: `apps/server/src/game-session-store.ts`
- Modify: `apps/server/src/app.test.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/web/src/api/client.test.ts`
- Modify: `apps/web/src/api/client.ts`

**Step 1: Add completed-summary RED tests**

`GET /api/game-sessions?status=completed` returns only the selected club’s completed summaries, newest first, with game ID/name/host/winner/playedAt/day/event count/replay capability.

**Step 2: Preserve active-list API behavior**

No query still means active sessions. Malformed status returns 400.

**Step 3: Add replay-history read contract**

A selected session response supplies:

- baseline or compatibility checkpoint;
- all events needed to resolve the active branch;
- head ID;
- replay version/capability;
- server-derived current state for compatibility;
- results/status.

Host visibility returns secret payloads; public visibility redacts them but preserves structural timeline markers.

**Step 4: Add client types and exact request tests**

Keep historical `event.type` tolerant at the network edge. Adapt legacy rows before projection rather than throwing on an old unknown type.

**Step 5: Verify club isolation and response shape**

```bash
npm run test -w @mafia/server -- src/game-session-store.test.ts src/app.test.ts
npm run test -w @mafia/web -- src/api/client.test.ts
```

**Prototype checkpoint:** no commit.

---

### Task 13: Build timeline regions and markers from replay frames

**Objective:** Ensure the timeline consumes exactly the same canonical state history as Log preview.

**Files:**
- Create: `apps/web/src/features/timeline/timeline-model.test.ts`
- Create: `apps/web/src/features/timeline/timeline-model.ts`

**Step 1: Write the region RED test**

Pass sample replay frames and require:

```ts
[
  "Initial night",
  "Day 1",
  "Voting 1",
  "Night 1",
  "Day 2",
  "Voting 2",
  "Night 2",
]
```

Region membership derives from `frame.before`/`frame.after`, not raw phase strings alone.

**Step 2: Add marker projection one event at a time**

- nomination → player set for voting;
- voting/car-crash result → final totals/elimination/cancellation;
- Mafia resolution → grouped shots and kill/no-effect/miss icon;
- Don/Sheriff checked/skipped;
- foul and fourth-foul red card semantics;
- direct red card;
- completion trophy.

**Step 3: Verify active-branch selection**

Inactive superseded branch events do not appear in the ordinary timeline. A separate model flag may report preserved branch count, but branch visualization is out of scope.

**Step 4: Add legacy compatibility**

Old split Mafia-shot rows and duplicate foul/red-card rows may be grouped for display. Old pre-checkpoint entries can render timeline markers even when table-state preview is unavailable. Never fabricate a replay frame.

**Step 5: Add malformed-history resilience**

Missing player names fall back to Seat N; malformed payloads produce a generic marker; hash/parent failures show a bounded history error rather than a false timeline.

```bash
npm run test -w @mafia/web -- src/features/timeline/timeline-model.test.ts
npm run typecheck -w @mafia/web
```

**Prototype checkpoint:** no commit.

---

### Task 14: Build the full-screen Dev timeline

**Objective:** Render completed/sample replay history as a video-editor-style sequence without allowing past games to mutate the active game.

**Files:**
- Create: `apps/web/src/features/timeline/GameTimelineScreen.test.tsx`
- Create: `apps/web/src/features/timeline/GameTimelineScreen.tsx`
- Create: `apps/web/src/styles/timeline.css`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/App.tsx`

**Step 1: Add loading/empty/error/sample tests**

Require Past game timeline heading, retryable errors, empty state, and explicit browser-only sample generation.

**Step 2: Add latest-request-wins selection tests**

A late Game A response/error cannot overwrite selected Game B.

**Step 3: Render the pure model**

- labeled color regions for Initial night/Day/Voting/Night;
- one fixed-width accepted-event column per replay frame;
- accessible Lucide marker buttons;
- event inspector with sequence/time/players/result/secret status;
- optional read-only table-state inspection for replay-capable past frames, but no Reset into another game.

**Step 4: Integrate Dev navigation**

Add `Past game timeline` to Dev, preserve the prior Game/Players view for Back, hide irrelevant live controls/music while timeline is open, and never alter active head/game/outbox.

**Step 5: Implement no-document-scroll geometry**

```css
.timeline-screen {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) minmax(170px, 24vh);
  width: 100%;
  height: var(--app-viewport-height, 100dvh);
  min-height: 0;
  overflow: hidden;
}

.timeline-track-scroll {
  min-width: 0;
  min-height: 0;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior: contain;
}
```

**Step 6: Verify component/integration tests**

```bash
npm run test -w @mafia/web -- \
  src/features/timeline/GameTimelineScreen.test.tsx \
  src/App.test.tsx
npm run typecheck -w @mafia/web
```

**Prototype checkpoint:** no commit.

---

### Task 15: Run focused replay, reset, migration, and visual verification

**Objective:** Prove no per-step snapshots remain and the same event chain powers resume, preview, reset, and timeline.

**Files:**
- Create: `scripts/verify-game-history.mjs`
- Create: `scripts/verify-timeline.mjs`
- Modify: `package.json`

**Step 1: Verify incremental storage structurally**

Run a complete sample game and inspect browser/PostgreSQL data:

- exactly one initial baseline/checkpoint;
- one new `game_events` row per accepted action;
- no event row contains a full `GameState`;
- no queued outbox operation contains full cumulative state/log/undo snapshots;
- ordinary append never deletes/reinserts prior events;
- current state hash equals server/client replay output.

**Step 2: Verify every Log state**

For each active-chain previewable event:

1. click Preview state;
2. assert table state equals that replay frame’s `after` state;
3. assert exactly Exit preview and Reset game to this state are actionable;
4. Exit and assert exact actual live/draft state restored;
5. assert no revision/head/outbox change.

**Step 3: Verify reset branching**

- reset from Log row and from preview center;
- cancel confirmation is no-op;
- confirmed reset moves head and active Log/timeline to target;
- old future rows remain in PostgreSQL off-branch;
- immediate Undo restores pre-reset head;
- reset then new accepted action creates a branch and clears reset recovery;
- player statistics/results retract only when reset moves before completion.

**Step 4: Verify restart/offline behavior**

- restart reconstructs current state from baseline+events;
- unfinished provisional choices are intentionally discarded;
- pending append/head operations retry idempotently;
- stale responses cannot overwrite newer head/game identity.

**Step 5: Rebuild live prototype and health-check**

```bash
docker compose up --build -d
curl --fail --silent http://127.0.0.1:8080/health/ready
```

**Step 6: Run visual probes**

At 1366×1024 and touch 1024×768:

- inspect Log row buttons;
- preview an early Day and Night state;
- confirm only two center controls are actionable;
- exit without state change;
- reset a disposable/sample active game and verify branch behavior;
- open the Dev timeline and inspect all regions/markers;
- assert document does not scroll, timeline scroll is internal, and controls do not overlap.

Save:

```text
/tmp/mafia-dashboard-log-preview-desktop.png
/tmp/mafia-dashboard-log-preview-ipad.png
/tmp/mafia-dashboard-timeline-desktop.png
/tmp/mafia-dashboard-timeline-ipad.png
```

**Step 7: Run final focused gates**

```bash
npm run test -w @mafia/game-domain -- \
  src/game-events.test.ts \
  src/game-replay.test.ts \
  src/day-actions.test.ts \
  src/night-actions.test.ts \
  src/game.test.ts
npm run test -w @mafia/server -- \
  src/game-session-validation.test.ts \
  src/game-session-store.test.ts \
  src/app.test.ts
npm run test -w @mafia/web -- \
  src/api/client.test.ts \
  src/session-outbox.test.ts \
  src/App.test.tsx \
  src/features/game/game-history.test.ts \
  src/features/game/GameScreen.test.tsx \
  src/features/table/GameTable.test.tsx \
  src/features/voting/VotingStage.test.tsx \
  src/features/night/NightStage.test.tsx \
  src/features/timeline/sample-game-data.test.ts \
  src/features/timeline/timeline-model.test.ts \
  src/features/timeline/GameTimelineScreen.test.tsx
npm run verify:game-replay-migration
npm run typecheck
npm run build
npm run verify:game-history
npm run verify:timeline
git diff --check
```

Broad `npm run check`, independent review, commit, and push remain deferred until Michael asks to finalize.

---

## Files likely to change

### Create

- `packages/game-domain/src/game-events.ts`
- `packages/game-domain/src/game-events.test.ts`
- `packages/game-domain/src/game-replay.ts`
- `packages/game-domain/src/game-replay.test.ts`
- `apps/web/src/features/game/game-history.ts`
- `apps/web/src/features/game/game-history.test.ts`
- `apps/web/src/features/timeline/sample-game-data.ts`
- `apps/web/src/features/timeline/sample-game-data.test.ts`
- `apps/web/src/features/timeline/timeline-model.ts`
- `apps/web/src/features/timeline/timeline-model.test.ts`
- `apps/web/src/features/timeline/GameTimelineScreen.tsx`
- `apps/web/src/features/timeline/GameTimelineScreen.test.tsx`
- `apps/web/src/styles/timeline.css`
- `scripts/verify-game-replay-migration.mjs`
- `scripts/verify-game-history.mjs`
- `scripts/verify-timeline.mjs`

### Modify

- `package.json`
- `package-lock.json`
- `packages/game-domain/src/index.ts`
- `packages/game-domain/src/game.ts`
- `packages/game-domain/src/day-actions.ts`
- `packages/game-domain/src/night-actions.ts`
- relevant domain tests
- `apps/server/package.json`
- `apps/server/src/schema.sql`
- `apps/server/src/game-session-validation.ts`
- `apps/server/src/game-session-validation.test.ts`
- `apps/server/src/game-session-store.ts`
- `apps/server/src/game-session-store.test.ts`
- `apps/server/src/app.ts`
- `apps/server/src/app.test.ts`
- `apps/web/src/api/client.ts`
- `apps/web/src/api/client.test.ts`
- `apps/web/src/session-outbox.ts`
- `apps/web/src/session-outbox.test.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/App.test.tsx`
- `apps/web/src/features/setup/SetupWizard.tsx`
- `apps/web/src/features/setup/SetupWizard.test.tsx`
- `apps/web/src/features/game/GameScreen.tsx`
- `apps/web/src/features/game/GameScreen.test.tsx`
- `apps/web/src/features/table/GameTable.tsx`
- `apps/web/src/features/table/GameTable.test.tsx`
- `apps/web/src/features/voting/VotingStage.tsx`
- `apps/web/src/features/voting/VotingStage.test.tsx`
- `apps/web/src/features/night/NightStage.tsx`
- `apps/web/src/features/night/NightStage.test.tsx`
- `apps/web/src/styles/app.css`

## Verification matrix

| Layer | Required proof |
|---|---|
| Event sufficiency | Every accepted action replays from its semantic payload |
| No intermediate logging | Draft UI tests plus strict shared/server allowlist |
| Live/replay parity | Rendered accepted state equals `applyGameEvent` output |
| Incremental browser storage | v4 envelope contains one baseline, entries, pointers, and operations—not per-step states |
| Incremental PostgreSQL storage | Append adds one row; no log-tail replacement or per-step state overwrite |
| Resume | Baseline + active branch reconstruct exact current state/hash |
| Preview isolation | Every historical frame renders; no action/persistence; Exit restores exact live draft |
| Reset | Confirmed head move; off-branch future preserved; derived actual state correct |
| Undo | Parent-pointer last-three/day checkpoint plus reset recovery, no new log event |
| Migration | Fresh/populated/partial/rerun probes and legacy checkpoint honesty |
| Club isolation | Cross-club baseline/event/head access rejected |
| Timeline | Built from replay frames and active branch only |
| Accessibility | Text labels, focus states, keyboard marker navigation, no color-only semantics |
| Fullscreen geometry | Desktop/iPad screenshots, internal scrolling, no overlap/document scroll |

## Risks and tradeoffs

1. **This is an event-sourcing migration, not a small UI addition.** Replay correctness must land before preview/timeline; otherwise two divergent state authorities will exist.
2. **Provisional choices are intentionally transient.** They survive entering/exiting Preview in the same tab but may be lost on reload because they are not canonical log states.
3. **Legacy histories are incomplete for replay.** A one-time compatibility checkpoint makes current legacy sessions resumable without inventing prior states. Pre-checkpoint timeline markers remain visible, but Preview/Reset are disabled where reconstruction is impossible.
4. **Reset creates branches.** Ordinary Log/timeline shows the active chain; superseded branches stay preserved but branch-visualization UI is deferred.
5. **State hashes detect drift but do not replace replay tests.** Canonical serialization must be stable across browser/server runtimes.
6. **Completion/reset affects statistics.** Head movement before completion must retract results atomically and recompute affected player `last_played_at`; races need database tests.
7. **Additive schema is deliberate.** Keep legacy `state` during prototype/compatibility. Dropping it is a later contract/removal migration after all sessions are converted.
8. **Current files are already dirty.** Use targeted edits; do not reset or opportunistically refactor unrelated work.

## Clarified assumptions encoded in this plan

- The Log drawer has both Preview and direct Reset buttons on each previewable row.
- Preview mode itself shows exactly Exit preview and Reset game to this state as actionable controls in the table center.
- Reset moves the active history head and preserves the old future branch; it does not physically delete log events.
- Past completed-game timeline states are read-only and cannot replace the current active game.
- The timeline and Log preview share the same replay frames; neither consumes saved per-step `GameState` snapshots.
- Sequence spacing remains event-ordinal rather than elapsed-time proportional.

## Definition of done for the prototype

- One immutable initial baseline is stored per game; no complete `GameState` is stored for every accepted step.
- Every accepted gameplay action is one canonical incremental event sufficient for deterministic replay.
- Provisional vote/shot/Best-move/setup/timer/music/UI interactions create no log states.
- Browser and PostgreSQL persistence append operations/events rather than rewriting full cumulative state/log history.
- Current state, every previewable Log state, reset state, and timeline regions all derive from the same replay function.
- Every previewable active Log row has Preview and Reset controls.
- Preview cannot perform gameplay actions and exposes only Exit preview and Reset in the table center.
- Exit preview restores the exact pre-preview live draft; Reset moves the canonical head after confirmation.
- Reset preserves the old future off-branch, supports immediate Undo recovery, and retracts completion/statistics when needed.
- Last-three/day-checkpoint Undo remains cursor-based and adds no log event.
- Completed games are club-scoped, listable, and visualized from their active event chain.
- Deterministic browser-only sample history demonstrates all regions/events without database/statistics pollution.
- Fresh/populated/partial/rerun migration probes pass.
- Focused tests, typecheck, build, health check, browser probes, and `git diff --check` pass.
- Changes remain uncommitted until Michael accepts the visual and replay behavior.
