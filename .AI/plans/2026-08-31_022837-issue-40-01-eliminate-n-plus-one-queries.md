# Issue #40 Constant-Bounded Session Persistence Queries Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make active/completed session listing, supplied-event normalization, and completion-result persistence avoid unused or row-count-proportional PostgreSQL statements without changing stored or returned behavior.

**Architecture:** Keep the public `GameSessionStore` contract unchanged. Batch canonical replay events for all listed game IDs in one club-scoped query, hydrate rows synchronously from a pre-grouped event map, skip the unused pre-read when normalization already has persisted JSON events, aggregate completed event counts once, and replace per-player result inserts with one typed set-based insert inside the existing transaction.

**Tech Stack:** TypeScript 6, Node.js 22, PostgreSQL via `pg`, Vitest integration tests.

**Non-goals:** No API/UI changes, schema migration, new index, dependency, generic repository extraction (#39), test-suite parallelization (#41), replay-rule change, cache, pagination, or unrelated query optimization. Do not alter the pre-existing unrelated plan.

---

## Context and invariants

**Issue:** [#40](https://github.com/zemskovmm/mafia-dashboard/issues/40)

Current anchors:

- `apps/server/src/game-session-store.ts:228-260` reads canonical events for exactly one game.
- `apps/server/src/game-session-store.ts:320-370` couples hydration to that one-game query.
- `apps/server/src/game-session-store.ts:554-616` issues one `game_player_results` insert per result row.
- `apps/server/src/game-session-store.ts:958-1019` maps listed rows through asynchronous per-game hydration; completed listing also uses a per-session correlated event-count subquery.
- `apps/server/src/game-session-store.ts:1096-1099` reads canonical rows before deciding whether persisted JSON events make that read unused.
- `apps/server/src/schema.sql:637-639` already indexes `(club_id, game_id, replay_sequence)` for canonical event reads.
- `apps/server/src/game-session-store.test.ts` is the existing PostgreSQL integration boundary and already covers replay, completion idempotency, projections, and club isolation.

Preserve these invariants:

1. Every read/write remains explicitly scoped by `club_id`; identical game/event IDs in another club must be invisible.
2. Replay rows remain ordered by `replay_sequence`, and active-head traversal/replay errors remain unchanged.
3. `listActive`/`listCompleted` response shape, sort order, phase/day/winner/event counts, and legacy-session fallback remain unchanged.
4. Completion remains one transaction with the existing optimistic revision, idempotency, replay-head/result validation, projection replacement, player `last_played_at` update, and rollback behavior.
5. Supplied JSON replay events still pass through game-ID/root/head validation, immutable canonical writes, replay, metadata compaction, and response hydration; only the unused pre-read is removed.
6. No accepted issue criterion permits weakening foreign-player checks, canonical replay integrity, or persistence idempotency.

## Acceptance map

| ID | Criterion | Decisive evidence |
|---|---|---|
| PERF-READ-1 | Listing one or several canonical active sessions uses a bounded two-query path: one session query plus one batched canonical-event query. | Query-recording integration test compares one-game and multi-game fixtures and verifies identical query count and summaries. |
| PERF-READ-2 | Completed listing uses a bounded query path and computes each game’s full event count without a per-session correlated scan. | Multi-game completed fixture verifies two-query bound, event counts including non-replay events, winner/day/output order, and club isolation. |
| PERF-NORMALIZE-1 | Valid persisted JSON events normalize without an unused canonical-event read and are still validated, written, replayed, compacted, and returned. | Query-recording normalization test observes one canonical read for final response hydration instead of the current pre-read plus final read, then verifies rows and response state. |
| PERF-WRITE-1 | Completing a ten-player game emits exactly one `INSERT INTO game_player_results` statement and stores all ten projections. | Query-recording completion test fails against the current loop, then verifies one insert, ten rows, returned results, and idempotent retry. |
| SAFE-1 | Batch optimizations preserve club isolation, replay ordering, transactionality, and existing behavior. | New focused assertions plus the unchanged existing store suite and full `npm run check`. |

## Task 1: Add decisive RED query-count coverage

**Objective:** Prove current query growth before changing production code.

**Files:**
- Modify: `apps/server/src/game-session-store.test.ts`

**Step 1: Add a test-local query recorder**

Wrap a dedicated `Pool`/checked-out client boundary without changing production APIs. Record normalized SQL for calls made through both `pool.query(...)` and clients returned by `pool.connect()`, while delegating every call to the real PostgreSQL connection and preserving `release()`.

The helper must:

- expose `reset()` and recorded SQL text;
- avoid recording fixture setup by resetting immediately before the operation under test;
- restore/deallocate its dedicated pool in `finally`/test teardown;
- never patch the shared global pool or global `pg` prototypes.

**Step 2: Add active/completed listing fixtures in an isolated club**

Create one canonical session, record `listActive(clubId)` and `listCompleted(clubId)`, then add enough same-club canonical sessions to demonstrate growth and repeat. Include another-club session with colliding-style identifiers/data so the test proves club scoping rather than only counts.

Assert:

- one-game and multi-game operations each use the same bounded number of store queries (target: two when at least one canonical session requires hydration);
- current code fails because canonical-event reads grow with the number of rows;
- summaries retain ordering and correct phase/day/winner/event count;
- completed `eventCount` includes all `game_events`, not only rows with `replay_sequence`.

**Step 3: Add supplied-event normalization instrumentation**

Insert a legacy/partial `game_sessions` fixture whose JSON state contains a valid `initialGame`, canonical `events`, and `headEventId`, while canonical rows are absent. Reset the dedicated client-query recorder immediately before `normalize(...)`.

Assert:

- exactly one club/game-scoped canonical-event `SELECT` occurs for final response hydration (current code performs an additional unused pre-read);
- the supplied event is validated, written once, replayed, and returned as the active head;
- session JSON is compacted to metadata and canonical columns/rows hold the baseline, head, and replay event;
- invalid supplied events remain covered by existing replay-integrity tests rather than bypassing validation.

**Step 4: Add completion projection instrumentation**

Use a canonical finished replay fixture, reset the recorder immediately before `complete(...)`, and assert:

- exactly one SQL statement starts with `INSERT INTO game_player_results`;
- the table receives all ten player rows;
- response results match the replayed head;
- an idempotent retry adds no new projection insert.

**Step 5: Run RED tests**

Run:

```bash
npm run test -w @mafia/server -- game-session-store.test.ts
```

Expected: the new bounded-listing, unused-normalization-read, and single-result-insert assertions fail against current code; existing assertions remain green. If a fixture fails for unrelated setup reasons, fix the fixture only—do not edit production behavior before the intended RED is observed.

## Task 2: Batch canonical event reads for list paths

**Objective:** Remove per-session event round trips while retaining the single-session mutation/get path.

**Files:**
- Modify: `apps/server/src/game-session-store.ts:228-370`
- Modify: `apps/server/src/game-session-store.ts:958-1019`
- Test: `apps/server/src/game-session-store.test.ts`

**Step 1: Separate row mapping from I/O**

Extract the existing `CanonicalEventRow -> GameLogEntry` conversion into one mapper. Add a helper with this semantic contract:

```ts
readCanonicalEventsByGame(queryable, clubId, gameIds)
  => Promise<ReadonlyMap<string, readonly GameLogEntry[]>>
```

Use one statement shaped as:

```sql
SELECT ...
  FROM game_events
 WHERE club_id = $1
   AND game_id = ANY($2::uuid[])
   AND replay_sequence IS NOT NULL
 ORDER BY game_id, replay_sequence
```

Deduplicate input IDs, return an empty map without querying for an empty input, initialize empty arrays for requested games with no canonical rows, and group only rows returned for the selected club. Keep `readCanonicalEvents(...)` as the one-game adapter used by mutation/get paths so their behavior does not drift.

**Step 2: Make hydration reusable with preloaded events**

Split `hydrateSession` into:

- a synchronous materializer accepting `row`, `events`, `duplicate`, and optional revision; and
- the existing asynchronous wrapper that reads one game then calls the materializer.

Do not duplicate active-head traversal or replay logic. Missing parents, cycles, hashes, event order, legacy state behavior, and output shape must still flow through the same existing functions.

**Step 3: Rewrite `listActive`**

After the ordered session query:

1. collect IDs only for rows with `initial_game !== null`;
2. batch-read their canonical events once;
3. derive summaries in original row order using preloaded events;
4. keep `deriveCurrentGame(row.state)` for legacy rows.

The result should issue one query for zero/legacy-only rows and at most two for any positive number of replay-backed rows.

**Step 4: Rewrite `listCompleted`**

Replace the correlated event-count scalar subquery with one club/status-scoped relation that aggregates `game_events` by game once and joins counts back to the completed-session rows. Preserve `0` for games without rows and the existing `updated_at DESC, id` ordering.

Then batch-read canonical replay events exactly as in `listActive`, hydrate from the grouped map, and continue filtering impossible legacy rows with `results === null` exactly as today.

**Step 5: Run focused GREEN tests**

Run:

```bash
npm run test -w @mafia/server -- game-session-store.test.ts
```

Expected: PERF-READ-1 and PERF-READ-2 pass; PERF-NORMALIZE-1 and PERF-WRITE-1 still fail until Tasks 3 and 4; all pre-existing listing/replay/isolation tests remain green.

## Task 3: Skip the unused canonical pre-read for supplied-event normalization

**Objective:** Use valid persisted JSON replay events directly while preserving every normalization validation and write.

**Files:**
- Modify: `apps/server/src/game-session-store.ts:1096-1138`
- Test: `apps/server/src/game-session-store.test.ts`

**Step 1: Keep the supplied-event branch authoritative**

Replace the unconditional `readCanonicalEvents(...)` with a conditional expression:

```ts
let events =
  suppliedEvents.length === 0
    ? await readCanonicalEvents(client, clubId, input.gameId)
    : suppliedEvents;
```

Do not move or bypass the subsequent game-ID check, root/baseline validation, active-head traversal, `replayGameLog(...)`, per-event immutable `writeCanonicalEvent(...)`, metadata-only state update, mutation write, or final hydrated response. Empty supplied-event arrays must retain the existing canonical-read/checkpoint behavior.

**Step 2: Run the focused tracer test**

```bash
npm run test -w @mafia/server -- game-session-store.test.ts -t "normalizes supplied JSON replay events without an unused canonical read"
```

Expected: the test changes from two canonical reads to one while preserving the same stored canonical event and returned replay head.

## Task 4: Persist completion player results with one set-based insert

**Objective:** Replace the ten-statement projection loop without changing validation or transactional semantics.

**Files:**
- Modify: `apps/server/src/game-session-store.ts:554-616`
- Test: `apps/server/src/game-session-store.test.ts`

**Step 1: Keep validation and affected-player collection unchanged**

Retain `assertPlayersBelongToClub(...)` before writes, include host and prior/new participant IDs in `affected`, retain the `game_results` upsert and scoped projection delete, and keep `updateLastPlayed(...)` after the replacement.

**Step 2: Replace the loop with one typed `UNNEST` insert**

Build same-length arrays from `results.players` and issue one statement equivalent to:

```sql
INSERT INTO game_player_results
  (club_id, game_id, player_id, seat, role, team, final_status, fouls, won, best_move_hits)
SELECT $1, $2,
       fixture.player_id, fixture.seat, fixture.role, fixture.team,
       fixture.final_status, fixture.fouls, fixture.team = $3,
       fixture.best_move_hits
  FROM UNNEST(
    $4::uuid[], $5::integer[], $6::text[], $7::text[],
    $8::text[], $9::integer[], $10::integer[]
  ) AS fixture(
    player_id, seat, role, team, final_status, fouls, best_move_hits
  )
```

Pass `bestMoveHits ?? null` in the nullable integer array. Do not use dynamic SQL or interpolate values. Empty arrays must remain a valid no-row insert even if current game rules normally produce ten players.

**Step 3: Run focused GREEN tests**

Run:

```bash
npm run test -w @mafia/server -- game-session-store.test.ts
```

Expected: PERF-WRITE-1 now passes with one insert and ten stored rows; completion idempotency, mismatch rejection, reset/reprojection, and club-isolation tests remain green.

## Task 5: Qualify the unchanged candidate

**Objective:** Verify the complete issue boundary before any commit or tracker mutation.

**Files:**
- Review only: `apps/server/src/game-session-store.ts`
- Review only: `apps/server/src/game-session-store.test.ts`

**Step 1: Run formatting on only owned files if needed**

Use Prettier’s check first. If formatting is required, format only the two owned files, then rerun focused tests because candidate bytes changed.

**Step 2: Run the focused server suite**

```bash
npm run test -w @mafia/server -- game-session-store.test.ts
```

Expected: pass.

**Step 3: Run the canonical repository gate**

```bash
npm run check
```

Expected: audit, format check, lint, typecheck, all tests, and build pass on unchanged bytes.

**Step 4: Review scope and invariants**

Inspect `git diff --check`, the exact changed-path list, and the complete diff. Confirm:

- only the two owned source/test files plus this issue’s plan artifacts are candidates for later staging;
- every event/result statement includes club scoping where applicable;
- the list query bound does not depend on game count;
- supplied-event normalization performs no unused canonical pre-read;
- player result insertion is exactly one parameterized statement;
- no API/schema/dependency or unrelated plan changed.

If accepted behavior requires another subsystem, a migration, or a generic harness, stop and return to plan mode rather than absorbing scope.

## Verification summary required for handoff

Record exact commands, exit codes, test counts, changed paths, local/remote base SHA, and any deferred finding. Do not claim issue completion, commit, push, or close from this plan; those actions belong exclusively to the closeout plan.
