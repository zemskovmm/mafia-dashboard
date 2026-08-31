# Issue #41B — Failure-Local Migration Test Isolation Plan

> **For Hermes:** Execute only after explicit approval and after plan 41A. This is the second half of issue #41; close the issue only after both plans and the final unchanged-candidate gates pass.

**Issue:** [#41 — Isolate session persistence fixtures and concurrency barriers](https://github.com/zemskovmm/mafia-dashboard/issues/41)

**Goal:** Make migration tests self-cleaning and failure-local by centralizing isolated-schema lifecycle ownership and splitting the tenant migration monolith into concern-specific behavioral tests without losing coverage.

**Acceptance slice:** TEST-3, TEST-4, and final repository verification for issue #41.

## Current architecture

`apps/server/src/schema-migration.test.ts` creates isolated PostgreSQL schemas with `createIsolatedPool`, then repeats manual `try/finally` cleanup through `dropIsolatedPool`. Most tests clean up correctly, but lifecycle ownership is optional at every call site and there is no regression proving callback failures remove both the pool and schema.

The tenant-composite migration scenario at `apps/server/src/schema-migration.test.ts:690` is one roughly 620-line test. It mixes composite-key reconciliation, consent/provenance and owner backfill, replay retention, same-UUID cross-club collisions, tombstones, and idempotency, so one failure obscures which migration contract broke.

## Files

- Modify: `apps/server/src/schema-migration.test.ts`
- Modify only if a reusable typed fixture genuinely reduces duplication: a test helper colocated under `apps/server/src/` and named for migration tests; do not add production exports merely for tests.

## Task 1 — Make isolated-schema lifecycle mandatory and failure-safe

1. Replace the create/drop pair with a single `withIsolatedSchema(prefix, callback)` helper that:
   - generates a unique safe schema name internally;
   - creates the schema before opening the schema-scoped pool;
   - invokes the callback with the pool and schema name;
   - closes the pool and drops the schema in `finally`;
   - attempts schema removal even if callback execution or pool shutdown fails;
   - preserves the primary test failure while reporting cleanup failures rather than masking them.
2. Add a regression that intentionally throws inside the callback, catches the sentinel error, and then queries `pg_namespace` through `adminPool` to prove the schema was removed.
3. Convert existing migration tests to the mandatory wrapper without changing their assertions.
4. Keep schema identifiers generated internally; never interpolate user-controlled values.

**Checkpoint:** run the lifecycle regression plus one existing fresh/populated migration case, and verify no matching schema remains after each pass or failure path.

## Task 2 — Extract typed tenant-migration fixture building blocks

1. Identify the reusable legacy-schema setup in the tenant-composite test and extract narrowly typed helpers for:
   - creating the pre-composite-key table/constraint shape;
   - inserting a default-club legacy aggregate;
   - inserting a second-club collision aggregate;
   - reading the canonical constraint/row manifest.
2. Keep event-specific and assertion-specific data at each test call site; do not replace readable test intent with a universal fixture factory.
3. Preserve fixed IDs only where cross-table/cross-club relationships require them; otherwise generate per-test IDs.
4. Ensure every helper receives the isolated pool explicitly and cannot touch the public schema.

**Checkpoint:** run the still-combined tenant scenario once after extraction to prove helpers preserve behavior before splitting assertions.

## Task 3 — Split the tenant migration monolith by independent contract

Replace the single test beginning around line 691 with concern-specific tests, each using its own isolated schema and fixture:

1. **Composite identity and foreign keys:** fresh/populated primary keys, unique constraints, and club-scoped foreign keys reconcile to canonical definitions.
2. **Consent/provenance and owner backfill:** legacy ownership/access rows retain required consent/provenance and canonical owner references.
3. **Replay and aggregate retention:** mutations, selected players, results, player results, replay rows, and tombstones survive migration with expected counts/content.
4. **Cross-club collisions:** the same game UUID in two clubs remains independent across every tenant-composite table.
5. **Idempotency:** a second `initializeSchema` call leaves canonical constraints and representative rows unchanged.

Each failure must name one contract while retaining the original positive assertions. Do not weaken checks merely to reduce test size.

**Checkpoint:** run `npm test -w @mafia/server -- src/schema-migration.test.ts`; all concern-specific cases must pass independently.

## Task 4 — Verify the complete issue on one unchanged candidate

1. Run both focused files together:
   `npm test -w @mafia/server -- src/game-session-store.test.ts src/schema-migration.test.ts`
2. Query `pg_namespace` for the test prefixes and prove no isolated schemas leaked.
3. Run the full repository gate: `npm run check`.
4. Freeze the exact candidate (base commit, candidate tree, full-index binary patch, complete `git ls-tree` manifest, and SHA-256) without modifying the source worktree.
5. Delegate an independent immutable review covering test determinism, cleanup-on-failure behavior, preserved migration assertions, test-only scope, and accidental runtime changes.
6. If review finds an in-scope blocker, fix it, rerun focused tests and `npm run check`, freeze a new candidate, and obtain a fresh review. Defer unrelated findings.
7. Require unchanged patch/tree/digest continuity after review.

## Task 5 — Deliver and verify

After every gate passes:

1. Remove only these two completed issue-#41 plan files; leave the unrelated existing reconciliation plan untouched.
2. Confirm the final diff contains only issue-#41 test-harness changes and plan cleanup.
3. Commit with a scoped message referencing #41 and push `main` to `origin` without opening a PR or waiting for CI.
4. Verify local `HEAD`, `origin/main`, and GitHub’s commit API resolve to the exact same commit and candidate tree.
5. Comment on #41 with evidence for TEST-1 through TEST-6, focused test counts, `npm run check`, cleanup readback, and immutable-review identity.
6. Close #41 as completed and read back its exact number, title, state, reason, closing comment, and remote commit before reporting success.

## Non-goals

- No product/runtime behavior changes.
- No runtime persistence refactor (#39) or query optimization (#40).
- No schema behavior changes (#38).
- No deletion of existing migration assertions.
- No changes to CI, deployment, or production databases.

## Done when

- Isolated schemas are cleaned on pass and failure paths by one mandatory lifecycle helper.
- Tenant migration failures are localized by concern while preserving every named contract.
- No schemas or pools leak after focused/full execution.
- Both plan 41A and plan 41B pass `npm run check` and independent immutable review on one unchanged candidate.
- The verified commit is pushed and live issue #41 is closed with read-back evidence.
