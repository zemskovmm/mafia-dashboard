# Issue #52 Current-Schema Database Bootstrap Implementation Plan

> **For Hermes:** Plan only until Michael explicitly approves the entire revised #52 plan set. Use regression-first implementation on an isolated disposable PostgreSQL database, never an existing environment.

**Goal:** Initialize and reopen only the current PostgreSQL schema without repairing or importing historical schemas and data.

**Architecture:** Replace accumulated historical repair/backfill SQL with the final current schema definitions. Retain the transactional advisory-locked initializer, idempotent current-schema bootstrap, required bootstrap seeds and every current integrity/isolation constraint. Reject an unsupported existing application schema rather than upgrading it.

**Tech Stack:** PostgreSQL 17, pg, TypeScript, Vitest, existing SQL schema initializer.

**Non-goals:** Production/QA/local-user database resets; data migration or conversion; deleting old deployments, backups, tables, rows or volumes; redesigning auth or club membership; removing current deletion tombstones; introducing a new migration framework; changing deployment or security pipelines.

## Plain-language summary

The application will create its current schema on a fresh database and safely reopen an already-current database. It will stop trying to rename old tables, repair old constraints, fill missing historical fields, or reconstruct old aggregates. An older database is unsupported—not silently upgraded and not automatically deleted.

## Approval assumption

This is a proposed starting-state boundary, not an answered clarification: **only a fresh application schema or the exact supported current schema with current-format rows is supported**. The user asked to assume actual-version data; the follow-up form timed out. Approval must explicitly cover this boundary. No operational cutover is authorized by approving code changes.

## Grounded inventory

- `apps/server/src/schema.sql`: historical `mock_users` rename at 1–6; users field/index repairs at 18–21; club defaults/backfill at 46–64; membership role remapping at 76–86; event column/constraint conversion beginning at 143; historical game-session column/backfill work beginning at 421. The file also defines the current tables, constraints, indexes and seeds that must survive.
- `apps/server/src/initialize-schema.ts:6-21`: explicit transaction, advisory transaction lock, COMMIT/ROLLBACK and client release. Preserve these safeguards.
- `apps/server/src/run-migration.ts:6-25`: pool closure and original error preservation. Its public command name can remain `migrate` as the bootstrap entry point; a name alone is not legacy compatibility.
- Current tombstones in `deleted_games` and `deleted_clubs` prevent current deleted data from reappearing. They are not obsolete browser migration markers.
- The root `package.json` invokes `migrate` before dev; retain the working startup command rather than removing it because historical SQL disappears.

## Tasks

### 1. Capture the current final schema contract

**Files:** `apps/server/src/schema.sql`, `initialize-schema.ts`, `schema-migration.test.ts`, `migrate.test.ts`, `app-startup.test.ts`, `club-store.test.ts`, `app-security.test.ts`.

1. Inspect all schema statements and classify each as current DDL, current invariant/seed, or historical repair/backfill. Do not mechanically delete every `ALTER`, `DO`, `UPDATE` or `INSERT`; some express valid current initialization.
2. In an explicitly disposable test database, bootstrap the existing schema and capture catalog definitions of current tables, columns, nullability, defaults, primary/foreign/unique/check constraints and indexes. Store non-sensitive test evidence under `.AI/`, never data or credentials.
3. Account for current roles, club-scoped event identity, game/player/results relations, claim fields, one-live-game enforcement, ruleset identity, replay columns and deletion tombstones. Historical names need not survive; their current semantics must.
4. Identify true current seeds (including rulesets and any still-required default club/user data) using callers and bootstrap tests. Retain deleted-default-club anti-resurrection behavior. Do not treat removing data compatibility as an instruction to change product bootstrap policy.

### 2. Establish RED for fresh/current-only bootstrap

**Files:** `apps/server/src/schema-migration.test.ts`, `migrate.test.ts`, `app-startup.test.ts`; add focused cases to existing tests rather than inventing another runner.

1. Replace old-upgrade success expectations with unsupported-old-schema rejection where appropriate; prove existing historical tables/rows are unchanged after failure.
2. Add fresh-bootstrap and repeated-current-bootstrap tests with populated current rows. Assert row preservation, catalog equivalence, constraints, required seeds, and no resurrected deleted default club.
3. Add concurrent initialization and injected SQL failure checks: advisory exclusion, transaction rollback, no half-created application schema and released connections/pool.
4. Run `npm run test -w @mafia/server -- src/schema-migration.test.ts src/migrate.test.ts src/app-startup.test.ts`; record expected failures caused by the legacy acceptance still present.

### 3. Simplify schema and preserve fail-closed initialization

**Files:** `apps/server/src/schema.sql`, `initialize-schema.ts` only if necessary; retain `migrate.ts`/`run-migration.ts` unless actual integration requires edits.

1. Define tables at their final supported shape instead of creating old shapes and subsequently repairing them. Remove historical table renaming, alias roles, missing-column upgrades, old primary/index/constraint replacement, default-club retro-assignment and JSON/event/result/session backfills.
2. Keep current FK/constraint cycles correctly resolved, idempotent seeds and useful current indexes. Do not weaken constraints to make the simplified file easier to order.
3. Under the existing transaction/advisory lock, distinguish empty application schema from a supported current schema. Add only the catalog validation needed to reject incomplete/old application schemas before any repair or partial initialization; no old-version upgrader or new migration framework.
4. Keep repeat initialization free of destructive rewrites to current rows/constraints. Unsupported current-format data encountered by runtime is rejected by the companion data-contract plan, not mass-converted here.
5. Run focused bootstrap tests GREEN, then current security/store tests against the newly initialized schema.

### 4. Document the supported starting state

**Files:** `docs/self-hosted-deployment.md`, `docs/azure-deployment.md`, `docs/postgresql-backup-and-recovery.md`, `docs/entity-model.md`, and `README.md` only where current instructions/contracts reference the changed schema behavior.

1. State fresh/current-schema support, absence of an upgrade/backfill promise, actionable unsupported-schema errors, and requirement for a separately authorized deployment decision.
2. Preserve working current backup/restore guidance: restoration from a current-schema backup remains supported. An older backup is not silently converted.
3. Do not publish automatic reset/drop instructions or change infrastructure/configuration/CI as part of this ticket.

## Verification

Use repository-prescribed safe test configuration without printing or reading credential files. Start only an explicitly named disposable test database when required; do not reuse or remove an unrelated volume/container.

```bash
npm run test -w @mafia/server -- src/schema-migration.test.ts src/migrate.test.ts src/app-startup.test.ts src/app-security.test.ts src/club-store.test.ts src/game-session-store.test.ts src/event-store.test.ts
npm run test:backup-contracts
npm run check
```

Record actual fresh-bootstrap, populated rerun, concurrent-start and rollback results. A skipped/unreachable DB suite is a blocker, not a passing verification result. Review schema semantic equivalence against the captured current catalog; allowed differences must be justified by the approved removal contract.

## Acceptance criteria

- Fresh bootstrap creates the complete supported schema; current populated reruns preserve rows and all required invariants.
- Unsupported existing application schemas fail without partial changes or data conversion.
- Historical rename/repair/upgrade/backfill paths are gone; no automatic destructive cleanup replaces them.
- Current club isolation, event immutability/idempotency, claim exclusion, results/player links, rulesets, startup locking and deletion safeguards remain tested.
- Docs accurately distinguish supported current backup restore from unsupported historical conversion.
- Full integrated #52 checks and exact-candidate database review pass before delivery.

## Risks and stop conditions

Dropping upgrade support is a breaking deployment prerequisite. Do not infer that any existing deployment already satisfies it. If the current bootstrap cannot be simplified without changing current product semantics, record the concrete conflict and return to refinement—do not broaden into data deletion, removal of useful seeds, or weakened constraints.

## Dependencies

Part of [the #52 plan-set index](./2026-09-04_232629-issue-52-current-only-plan-set.md). Coordinate final persisted game fields with the current game-data companion before schema acceptance. Independent from preference removal; all slices must pass before one PR closeout.
