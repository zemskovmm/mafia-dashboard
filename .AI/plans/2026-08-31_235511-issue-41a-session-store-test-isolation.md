# Issue #41A — Deterministic Session-Store Test Isolation Plan

> **For Hermes:** Execute only after explicit approval, and keep this plan paired with `2026-08-31_235511-issue-41b-migration-test-isolation.md`. This plan is test-harness work only; do not change runtime product behavior.

**Issue:** [#41 — Isolate session persistence fixtures and concurrency barriers](https://github.com/zemskovmm/mafia-dashboard/issues/41)

**Goal:** Make the session-store integration suite deterministic under concurrent/local runs by binding lock waits to the exact PostgreSQL blocker, limiting mutations to owned fixtures, using valid operation inputs, and pinning legacy FNV compatibility to historical bytes.

**Acceptance slice:** TEST-1, TEST-2, TEST-5, TEST-6, plus the session-store portion of the clean-suite requirement.

## Selection rationale

- P0 items are blocked by unmet dependencies or already marked `status:in-progress`.
- P1 #17 is multi-outcome and overlaps unfinished #8; P1 #32 is an umbrella qualification item rather than an implementation unit.
- P2 #39 is not implementation-ready because BOUNDARY-4 says legacy PUT must be rejected after canonical replay begins, while the current intentional regression at `apps/server/src/game-session-store.test.ts:2412` requires the opposite store behavior. That contradiction needs tracker refinement before code changes.
- Current live P2 #41 has explicit failing-risk locations and no product decision. Its two concerns are split into plans 41A and 41B so each plan has one independently verifiable goal.

## Current architecture

`apps/server/src/game-session-store.test.ts` uses one public test schema and a shared `GameSessionStore`. The production store already scopes queries by club/game, but a few tests weaken their own isolation: the lock helper identifies a waiter by SQL text, the active-list test rewrites every session timestamp, not-found tests rely on invalid `as never` payloads, and the legacy FNV hash is generated from the current implementation rather than pinned as historical evidence.

This plan changes only test fixtures and synchronization. Runtime persistence code, lock order, API behavior, replay semantics, and schema remain untouched.

## Files

- Modify: `apps/server/src/game-session-store.test.ts`

## Task 1 — Replace SQL-text lock detection with an exact blocker barrier

1. Capture the blocking connection’s backend PID with `SELECT pg_backend_pid()` immediately after acquiring the explicit player-row locks.
2. Replace `waitForPlayerLockWaiter()` with a helper that accepts that blocker PID and polls `pg_stat_activity` for a different backend whose `pg_blocking_pids(pid)` contains the exact blocker PID.
3. Keep the bounded timeout and produce a diagnostic naming the blocker PID when no waiter appears.
4. Update the clear-vs-newer-results race test to pass the captured PID, release the blocker only after the exact waiter is observed, and preserve its existing last-played assertions.
5. Add a focused negative barrier assertion using an impossible/nonblocking PID so the helper proves it fails deterministically instead of silently continuing.

**Checkpoint:** run the focused concurrency test and confirm both the exact-blocker path and timeout path behave as asserted.

## Task 2 — Scope ordering fixtures to owned rows and prove a foreign-club control

1. In the active-session ordering test around `apps/server/src/game-session-store.test.ts:2902`, stop executing the unqualified `UPDATE game_sessions SET updated_at = ...`.
2. Create the test’s three local session IDs plus one deliberately newer active session in a separately created club.
3. Apply timestamp/status updates with both `club_id` and `id = ANY(...)` predicates limited to owned fixture rows.
4. Assert the local list contains only the expected local active rows in order, excludes the completed local row, and excludes the newer foreign-club row.
5. Read the foreign row directly after the local mutations and assert its timestamp/status remained unchanged.

**Checkpoint:** run the focused list/order tests; no pre-existing session row may be rewritten by this test.

## Task 3 — Use valid public-contract operation fixtures in club-isolation tests

1. Introduce a narrow helper that derives a valid baseline, root event, append event, reachable head target, and completion results from the existing deterministic completed-session fixture.
2. Replace `initialGame: {} as never`, `event: {} as never`, and `results: {} as never` in not-found/foreign-club tests around lines 1964–2029 with those valid inputs.
3. Keep the same expected `GameSessionNotFoundError` and selected-club assertions, proving club isolation wins without depending on downstream validation order.
4. Do not add exported test-only production APIs or broaden runtime types.

**Checkpoint:** run the focused club-isolation tests and confirm normalize/start/append/head/complete all reject the foreign/missing aggregate for the intended reason.

## Task 4 — Pin required legacy FNV behavior to a fixed historical fixture

1. Replace at least one dynamically derived `legacyHashGameState(...)` compatibility case with a fixed game/event fixture containing stable UUIDs, timestamp, payload, and a literal previously supported FNV hash.
2. Keep the compatibility assertion behavioral: persist the fixed legacy row, hydrate it through `GameSessionStore`, and prove replay succeeds with the historical hash unchanged.
3. If the helper remains for other setup, add an explicit assertion that it reproduces the fixed literal; the literal—not the current helper—is the compatibility oracle.
4. Preserve the separate legacy Best Move compatibility coverage.

**Checkpoint:** run the focused FNV tests and confirm changing the current hash implementation could not silently rewrite the expected historical value.

## Task 5 — Verify plan 41A

Run in order:

1. Focused `game-session-store.test.ts` cases for lock synchronization, listing/order, club isolation, and legacy FNV.
2. Entire server test file:
   `npm test -w @mafia/server -- src/game-session-store.test.ts`
3. Confirm no test-created rows outside owned IDs/clubs changed and the pool exits cleanly.
4. Continue to plan 41B; do not run final repository delivery gates or close #41 until both plans pass on one unchanged candidate.

## Non-goals

- No product or API behavior changes.
- No runtime query optimization (#40).
- No schema semantic changes (#38).
- No persistence-mode refactor (#39).
- No broad fixture rewrite outside the acceptance anchors above.

## Done when

- Exact blocker PID synchronization replaces SQL-text matching.
- Ordering tests touch only owned fixture rows and include a preserved foreign-club control.
- Club-isolation tests use valid operation contracts.
- A literal historical FNV artifact guards compatibility.
- The entire session-store test file passes without cross-test leakage.
