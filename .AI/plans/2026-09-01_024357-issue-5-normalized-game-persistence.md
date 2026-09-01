# Issue #5 Normalized Game Persistence Implementation Plan

> **For Hermes:** Execute task-by-task with strict RED-GREEN-REFACTOR discipline.

**Goal:** Persist the fixed ruleset identity and active seat/role assignments as a constrained, club-scoped relational projection synchronized atomically with each authoritative game snapshot.

**Architecture:** Keep `game_sessions.state` as the authoritative restorable snapshot. Add a fixed-version ruleset catalog referenced by each session, extend the existing active-player projection with role assignment data, and derive that projection from the canonical game first, the setup roster/assignments second, and selected player IDs last. The projection stays internal; existing member-gated API responses continue returning the same full session model for managers and users.

**Tech Stack:** PostgreSQL 17-compatible SQL, Node.js 22, TypeScript, `pg`, Vitest, Zod-backed existing persistence validation.

**Non-goals:** Configurable/alternate rulesets (#8); public/spectator access; secret/sanitized response models; new API endpoints; changing authoritative snapshot/replay semantics; changing game rules; reverse migrations; backup/restore automation (#22); cleanup of unrelated code or plans.

---

## Context and invariants

- Relevant source anchors:
  - `apps/server/src/schema.sql:323+` — sessions, mutations, active-player and result tables.
  - `apps/server/src/game-session-store.ts:310-357` — current-game materialization.
  - `apps/server/src/game-session-store.ts:458-524` — `PlayerProjection`, `playerProjectionFor`, and `replaceActivePlayers`.
  - `apps/server/src/game-session-store.ts:760-775` — atomic projection synchronization/completion cleanup.
  - `apps/server/src/schema-migration.test.ts` — isolated fresh/populated migration fixtures.
  - `apps/server/src/game-session-store.test.ts:3037-3193` — active-player precedence and completion projection tests.
  - `apps/server/src/app.test.ts:246-387` — manager/user authorization parity.
- Active host rows have no seat or role. Selected/setup players have a seat and may have no role before draw. Canonical game players have exactly one allowed role.
- Completion removes active-player rows; `game_player_results` remains the completed role/result record.
- The database must enforce allowed ruleset references, club-scoped ownership, unique seats/players, legal role values, and host/player row shape. Exact role-deck counts remain validated at the application boundary because partial setup is a valid persisted state.

### Task 1: Specify fresh and populated migration behavior (RED)

**Objective:** Make the missing relational ruleset and role-assignment contract fail against the current schema before production SQL changes.

**Files:**
- Modify: `apps/server/src/schema-migration.test.ts`
- Test: `apps/server/src/schema-migration.test.ts`

**Steps:**
1. Add a focused isolated-schema suite that inspects semantic catalog state rather than matching SQL text.
2. Fresh-schema assertions must require:
   - one canonical immutable identity `(club-mafia, 1)` with ten players and role counts `1/6/2/1`;
   - non-null session ruleset identity with a composite ruleset foreign key;
   - nullable role data on active participant rows with allowed-role and host/seat/role shape constraints;
   - existing composite club/session/player keys and unique seat behavior preserved.
3. Build a representative pre-change populated fixture by removing only the candidate objects from an initialized isolated schema, then insert:
   - a selected-player setup with no role;
   - a partial role-draw setup;
   - a started game with canonical roles;
   - canonical events, mutation idempotency rows, completion results, and tombstones as preservation sentinels.
4. Run `initializeSchema` and assert the fixed ruleset reference is backfilled, canonical-game roles take precedence over setup JSON, partial assignments backfill where present, unassigned rows remain null, and all sentinel bytes/counts survive.
5. Run `initializeSchema` again and compare semantic rows/constraints to prove convergence without duplicate catalog or projection records.
6. Add negative writes proving unknown rulesets, illegal roles, host rows with seat/role data, and participant rows without seats are rejected by PostgreSQL.
7. Run:
   - `npm run test -w @mafia/server -- src/schema-migration.test.ts`
   - Expected RED: assertions fail because the ruleset catalog/session reference/role column and constraints do not exist.

### Task 2: Add the additive relational schema and safe backfill (GREEN)

**Objective:** Implement the smallest additive, rerunnable SQL that satisfies the migration contract without changing session authority.

**Files:**
- Modify: `apps/server/src/schema.sql`
- Test: `apps/server/src/schema-migration.test.ts`

**Steps:**
1. Create a versioned `game_rulesets` catalog before `game_sessions`, with a composite primary key and checks that the fixed role counts sum to the player count.
2. Seed `club-mafia` version `1` idempotently. If an existing canonical row differs, reconcile only changed values; a no-change rerun must not rewrite it.
3. Add `ruleset_id` and `ruleset_version` to `game_sessions` through nullable expand/backfill/constrain ordering. Use compatible defaults so existing runtime inserts and a previous application image can continue writing the fixed v1 identity.
4. Add the composite foreign key from each session to the catalog with restricted update/delete behavior.
5. Add nullable `role` to `game_session_players`; backfill from canonical `state.game.players` first and setup assignment-by-seat second. Leave host and pre-draw participant roles null.
6. Add allowed-role and host/participant shape checks only after the backfill. Preserve all existing composite tenant keys, unique seat/player constraints, and cascade behavior.
7. Keep every statement compatible with the transaction and advisory lock in `initializeSchema`; do not add a separate migration engine or destructive reverse script.
8. Rerun the focused migration test until GREEN, then run it a second time explicitly to verify the test itself exercises idempotence.

### Task 3: Synchronize role assignments on every session write path (RED → GREEN)

**Objective:** Keep normalized active assignments equal to the accepted authoritative snapshot across setup, live play, reset/undo/head movement, normalization, and completion.

**Files:**
- Modify: `apps/server/src/game-session-store.ts:458-524,760-775`
- Modify: `apps/server/src/game-session-store.test.ts:3037-3193` and focused replay/head fixtures nearby
- Test: `apps/server/src/game-session-store.test.ts`

**Steps:**
1. Add one failing vertical-slice test for each materially different projection source:
   - selected IDs produce seated rows with null roles;
   - partial setup assignments populate only assigned seats;
   - canonical game players override stale setup roster/assignments and persist all ten roles;
   - moving/truncating the head and normalizing recomputes the projection from the resulting current game rather than retaining stale roles;
   - completion removes active rows while existing final result roles remain intact.
2. Run `npm run test -w @mafia/server -- src/game-session-store.test.ts` and confirm the new role assertions fail because the projection does not persist roles.
3. Extend `PlayerProjection`/`playerProjectionFor` to carry `role: Role | null` using canonical-game-first precedence. Reuse existing domain types; add no duplicated role enum.
4. Extend `replaceActivePlayers`’ single bulk insert to include roles for all active rows while retaining club ownership validation and transactional replacement.
5. Do not add a new read path. `get`, `list`, event replay, and API serialization continue using the authoritative stored state.
6. Rerun the focused store test to GREEN, then rerun the migration test to catch schema/store drift.

### Task 4: Pin the one-full-member-data-model boundary

**Objective:** Prevent this internal normalization from becoming a manager/user response split.

**Files:**
- Modify: `apps/server/src/app.test.ts:246-387`
- Test: `apps/server/src/app.test.ts`

**Steps:**
1. Extend the existing regular-user authorization scenario so the regular user creates a representative role-bearing session and both the regular user and manager read it.
2. Assert exact response equality, including role-bearing game/setup state. Keep outsider/non-member denial assertions.
3. Treat this as a characterization guard for the accepted #42 contract; it may pass before production changes, but it must remain green throughout.
4. Run `npm run test -w @mafia/server -- src/app.test.ts` and require a clean pass.

## Focused verification

Run after the last production edit:

```bash
npm run test -w @mafia/server -- src/schema-migration.test.ts src/game-session-store.test.ts src/app.test.ts
npm run typecheck -w @mafia/server
```

Expected: all selected Vitest files pass with nonzero test counts; server TypeScript reports no errors. The integrated `npm run check` belongs to the delivery plan.

## Risks and stop conditions

- Stop and return to plan/clarification if exact role-count enforcement would require forbidding valid partial setup states, or if implementation needs a second authoritative state source.
- Stop on any lossy backfill, cross-club FK weakening, changed session API payload, or incompatibility with the previous fixed-v1 writer.
- Do not silently broaden this into configurable rulesets or issue #8.
