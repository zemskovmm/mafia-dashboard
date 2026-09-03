# Issue #53: database-backed single-active-session invariant

> **For agent:** REQUIRED SUB-SKILL: Use subagent-driven-development (fresh subagent per task, two-stage review) to implement this plan.

## Goal

Make PostgreSQL the final authority that each club has at most one active game session, including concurrent first-save races and populated upgrades, without choosing or deleting existing sessions automatically.

## Plain-language summary

The first browser to create a live game wins. A racing browser gets a clear conflict pointing at the existing game, while another club remains unaffected. If an old database already contains duplicates, migration stops and preserves them until an operator explicitly decides which session to retain.

## Scope

### 1. Add RED migration coverage

- Extend `apps/server/src/schema-migration.test.ts` with isolated-schema cases that prove:
  - a fresh schema contains a unique partial index on `game_sessions(club_id)` where `status = 'active'`;
  - a second active row in the same club fails with PostgreSQL unique violation, while completed rows and another club remain valid;
  - an upgrade fixture containing two active rows for one club makes `initializeSchema` fail with the named invariant and leaves both rows unchanged because the migration transaction rolls back;
  - after the fixture explicitly removes its chosen obsolete row, the same migration succeeds and a second migration run is semantically unchanged.
- Run the focused test before changing schema and require the expected missing-index/concurrency assertions to fail rather than a fixture/setup error.

### 2. Install the fail-closed database invariant

- Update `apps/server/src/schema.sql` near the `game_sessions` definition and reconciliation block to:
  - detect duplicate active rows per club before installing the constraint and raise a named, actionable migration error with affected club/game IDs;
  - create an idempotent partial unique index such as `game_sessions_one_active_per_club_idx` on `club_id` for active rows only;
  - leave completed rows and every existing session payload untouched.
- Read the index predicate, uniqueness, and column order back from `pg_catalog` in the migration test; do not treat SQL execution alone as proof.

### 3. Add RED store/API race coverage

- In `apps/server/src/game-session-store.test.ts`, race valid first snapshot saves for two game IDs in the same club and assert exactly one succeeds, exactly one reports the active-session conflict, and a readback contains one active row.
- Add the control where the same race runs in two clubs and both saves succeed.
- In `apps/server/src/app.test.ts`, assert the losing HTTP request returns `409` with stable code `club_active_game_exists` and only the existing game's safe summary (`gameId`, name, phase/day, updated time), never state/replay/private role data.
- Watch each behavior test fail before adding production behavior.

### 4. Return a deterministic application conflict

- Add a club-level advisory-lock helper beside `lockClubGame` in `apps/server/src/game-lifecycle.ts` so competing first saves serialize in a consistent lock order before the per-game lock.
- Update the create branch of `GameSessionStore.save` in `apps/server/src/game-session-store.ts` to:
  - take the club-active lock before attempting a new active insert;
  - query the existing active summary under that lock and throw a typed `ClubActiveGameExistsError` when another active game exists;
  - retain the partial unique index as the final non-cooperating-writer guard and translate only that named index's `23505` into the same typed conflict;
  - preserve normal idempotent retry behavior for the same game/mutation.
- Map the typed error in `apps/server/src/app.ts` to the tested `409` response. Do not map unrelated unique violations to this code.
- Keep `GameSessionStore.listActive` and the public list response shaped as arrays for compatibility, while tests assert they contain zero or one active session per club.

### 5. Document populated-upgrade recovery

- Add a focused subsection to `docs/self-hosted-deployment.md` beside migration recovery explaining:
  - the exact duplicate-active preflight failure;
  - taking and verifying a PostgreSQL backup first;
  - querying each affected session's ID, name, revision, state, and `updated_at` before deciding;
  - explicitly retaining one canonical active session and deleting only operator-approved obsolete IDs;
  - rerunning only the migration job and reading back the partial index and surviving row.
- State that the application intentionally performs no automatic winner selection or destructive cleanup.

## Non-goals

- Client claim/lease lifecycle or takeover UI; those are the next two plans.
- Changing completed-game history, canonical replay, or session naming.
- Converting duplicate active rows to fabricated completed sessions.
- Replacing the existing array-shaped active-session API.

## Verification

- Focused RED/GREEN runs for the new migration, store race, and HTTP conflict tests.
- `npm run test -w @mafia/server -- schema-migration.test.ts game-session-store.test.ts app.test.ts` (adjust only to the workspace's Vitest CLI syntax if file filtering requires separate runs).
- Run the real migration twice against disposable fresh and repaired-populated schemas and inspect the index via `pg_catalog` through the automated tests.
- Later, after all #53 plans are integrated: `npm run check`.

## Done when

- PostgreSQL prevents two active rows for one club under a real concurrent race.
- Different clubs remain independent.
- Existing duplicates are preserved behind a fail-closed, documented operator decision.
- The API exposes one stable, privacy-safe conflict rather than an internal database error.
