# Issue #52 Current Game Data and Replay Contract Implementation Plan

> **For Hermes:** Plan only until Michael approves the complete revised #52 plan set. After approval, use RED–GREEN–REFACTOR and retain current writer behavior across web/domain/server; old compatibility tests do not define the new acceptance contract.

**Goal:** Accept and persist only current game/session/event/result representations across the browser, API and server, without historical hydration, normalization or replay fallbacks.

**Architecture:** Keep the current authoritative snapshot plus canonical replay model and existing current session operations; remove historical conversion at every reader/writer boundary. Validate supported representations explicitly and preserve live setup/draft state, outbox idempotency, immutable events, claim credentials and private-event handling. Replay accepts only current SHA-256 hashes and current event semantics.

**Tech Stack:** TypeScript, React, Fastify, Zod, PostgreSQL/pg, game-domain replay, Vitest, existing session verifiers.

**Non-goals:** Changing Sport Mafia rules; replacing current snapshot authority with event-only persistence; removing setup activity, transient drafts, result statistics or timeline features; changing OAuth/club permissions; accepting old hashes or old records through a renamed adapter; database reset/deployment; a new import/migration tool.

## Plain-language summary

New and current games keep working from setup through offline play, reload, completion and history. Historical formats will no longer be repaired, normalized or replayed using older rules. Current snapshots and setup activity remain supported: they are produced by today's application, not merely imported from old data.

## Important semantic decisions

1. `sha256:<64 lowercase hex characters>` is the only accepted recorded state-hash format. Delete FNV/8-hex decoding and historical replay-shape alternatives, not just their tests.
2. Preserve the current snapshot operation and its authority over intermediate UI state. Removing legacy snapshot conversion does **not** mean removing current snapshot saves.
3. Preserve `legacyLog` only as the existing current activity-log field written by live setup/game callbacks, **not** as a compatibility exemption: make its current role explicit, remove missing-field fallback/import of historical logs and normalization-based history. No new historical alias/parser is permitted. Renaming this current field is unnecessary scope unless the current contract cannot otherwise be made unambiguous.
4. Current setup-only sessions legitimately have no replay baseline/head/events yet; complete current fields can be explicitly null/empty. Require a coherent baseline/head/event branch once canonical play starts. Do not reject a role-giveaway session because a live game has not started.
5. Current results require explicit `outcome` and nullable `reason`; `winner` remains a current consistency field, not a replacement for absent `outcome`. Retain red/black/draw/cancelled semantics.
6. Unsupported request formats fail validation without writes; unsupported persisted game representations fail closed without conversion. Errors must not expose raw private payloads. Browser invalid-record handling is specified by the singleton companion.

These decisions form the proposed implementation contract and require approval with the plan set; the timed-out `legacyLog` clarification was not consent to delete a current feature.

## Grounded scope map

| Boundary | Existing code to simplify | Required positive behavior |
| --- | --- | --- |
| Domain replay | `packages/game-domain/src/game-events.ts:847,949-990,1361-1620`: 8-hex hash support, reduced historical state shapes and legacy rule/routing attempts | Current strict replay, parent/sequence/game identity, SHA-256 equality, correct current day/night/Best Move rules |
| Browser state | `apps/web/src/session-outbox.ts:325-460,568-623,795-867` and later normalization/legacy branches; `App.tsx:404-424,896-922` | Current authoritative snapshots, durable offline queue, exact stale-record rejection, restored owner, current setup state |
| Shared wire shape | `apps/web/src/api/client.ts:100-192,533-593`; `apps/server/src/game-session-validation.ts:945-1110,1144,1205` | Explicit current fields; valid setup/active/terminal states, current metadata/snapshot operations, current outcome validation |
| Server hydration | `apps/server/src/game-session-store.ts:410-424,450-500,864-999,1780` | Read only current stored shape; keep legitimate projection/materialization and snapshot authority, no old JSON/event/snapshot fallback |
| Legacy mutation surfaces | `apps/server/src/app.ts:930-949,1035-1170`; `game-lifecycle.ts:52`; `event-store.ts`; `player-store.ts:544,649` | Delete normalization and obsolete bypass writes, keep current read-only event access and modern aggregate persistence with locks/isolation |
| Timeline/verifiers | `features/timeline/GameTimelineScreen.tsx`, `i18n/messages/timeline-console.ts`, `scripts/session-verifier-contracts.mjs:303`, `verify-ui.mjs` | Current activity plus canonical timeline, preview/privacy safeguards, exact current storage/API evidence |

Line references are read-only planning anchors, not a frozen implementation patch.

## Tasks

### 1. Establish the current writer-to-reader contract and negative fixtures

**Files:** `apps/web/src/api/client.ts`, `session-outbox.ts`, `App.tsx`; `apps/server/src/game-session-validation.ts`, `game-session-store.ts`; current tests listed below.

1. Trace metadata, snapshot, start, append-event, move-head, complete, claim/release, setup logging and timeline projection end to end. Record required current fields versus legitimate current optional/null values before tightening types.
2. Build positive fixtures from actual current constructors/accepted events: role giveaway, active game with baseline/head, intermediate unsaved UI draft, completed red/black/draw/cancelled game, offline queued snapshot and retried mutation.
3. Add negative fixtures for v3/v4 envelopes, normalize operations, missing replay metadata on a started game, historical snapshot-only game input, absent result outcome, old hash strings and old-only replay variants. Negative cases must assert rejection and unchanged durable state, not successful conversion.
4. Run relevant tests and record expected RED. Do not drop old regressions without preserving their current isolation/idempotency/validation assertions.

### 2. Remove historical replay algorithms

**Files:** `packages/game-domain/src/game-events.ts`, `game-replay.test.ts`, `night-actions.test.ts`; `apps/server/src/game-session-validation.test.ts`, `event-store.test.ts` for decoder ingress.

1. Restrict recorded hashes to the exact SHA-256 format and delete `legacyHashGameState` and mixed legacy-to-modern chain rules.
2. Remove old shape projections and historical Best Move/Don/Sheriff/phase-routing replay alternatives. Keep the current reducer and invariants; do not accept a historical shape simply by trying multiple reduced state hashes.
3. Retain current lifecycle/transient-state restoration if it is required by current writers. Any retained alternative must have a positive current-writer fixture and may not be a historical format repair.
4. Verify current day-opening cursor, same-night role-check eligibility, mute behavior, undo/reset prefix, game identity, sequence/parent integrity, hash mismatch and private-event rules.
5. Run domain suite GREEN and decoder/server regression files; carry exact replay behavior into browser/server fixtures.

### 3. Remove legacy wire, outbox and UI normalization paths

**Files:** `apps/web/src/api/client.ts`, `session-outbox.ts`, `session-outbox.test.ts`, `App.tsx`, `App.test.tsx`; `features/timeline/GameTimelineScreen.tsx`, `GameTimelineScreen.test.tsx`; `i18n/messages/shell.ts`, `i18n/messages/timeline-console.ts`.

1. Remove `normalize` operation, legacy envelope/load/flush/save hooks, normalization UI gates and `takeNormalizedCurrent` handling. Browser v5 parser/ownership changes are implemented with the singleton companion, not duplicated here.
2. Make modern writers emit the explicit supported shape and align types/validators/verifiers. Remove `legacyLog ?? log`, missing-baseline conversion and historical state reconstruction; retain current activity entries without historical import. Update metadata-only requests to explicit current setup fields as needed.
3. Preserve snapshot-based intermediate draft save/restore, append/head/complete flows, revision/claim handling and exact byte revalidation. A failed or unsupported record must never be treated as an empty session.
4. Remove UI copy and branches whose only purpose is previewing/normalizing historical data. Retain legitimate current setup/activity entries with no canonical preview and their privacy treatment; do not make every timeline row falsely previewable.
5. Add setup-to-game-to-reload/timeline regressions showing current activity and canonical events preserved. Run focused browser tests GREEN.

### 4. Remove historical server hydration and obsolete mutation entry points

**Files:** `apps/server/src/app.ts`, `game-session-validation.ts`, `game-session-store.ts`, `event-store.ts`, `player-store.ts`, `game-lifecycle.ts`, and their associated existing tests.

1. Remove `/api/game-sessions/:gameId/normalize`, its schema/type/client branch, `normalizationPlanFor`, normalization method and normalization-required compatibility errors.
2. Remove old JSON-replay/snapshot-to-canonical conversion and result outcome inference. Hydrate only the current authoritative stored shape; validate unsupported persisted rows before writing anything. Retain legitimate current relational projections and snapshot values.
3. Trace `/api/games` create/delete, raw event append/truncate and results PUT/DELETE callers. Remove their historical aggregate-bypass mutation contracts and the now-exclusive helpers, while preserving `GET /api/games/:gameId/events` used by current timeline/verifiers and all current `/api/game-sessions` flows. If a current production writer still depends on an alleged old route, classify it and align the current writer rather than silently deleting behavior.
4. Do not delete `synchronizeLegacyAggregate` merely by name: its current save call sites synchronize event/results projections. Remove historical branches; retain the current projection operation and rename only if it clarifies its remaining responsibility. Similarly remove `assertLegacyGameMutationAllowed` only with obsolete bypass routes, not its shared claim/deletion/lock safeguards.
5. For removed routes, assert they do not dispatch to mutation logic (authenticated requests normally receive 404); preserve auth/CSRF rejection behavior for remaining endpoints. For retained routes, prove malformed historical payloads fail validation without inserts/revision advances.
6. Test current mutation replay duplicates, conflicting idempotency payloads, claim takeover/release, stale revision, event identity immutability, explicit club isolation, deletion anti-resurrection, atomic completion/results and current history reads against real PostgreSQL.

### 5. Align verifier contracts and product documentation

**Files:** `scripts/session-verifier-contracts.mjs`, `session-verifier-contracts.test.mjs`, `verify-session-state.mjs`, `verify-ui.mjs`; `docs/entity-model.md`, `docs/product-outline.md`, `docs/security-and-privacy.md` as relevant.

1. Remove old-field normalization such as `state.legacyLog ?? []` in contract comparison when the strict current field is required. Seed exactly the current browser/server shape; maintain request ownership guards and secret-safe evidence.
2. Document current schema/hash/operation support and explicit non-support of historical data. Do not rewrite archived release history to pretend historical behavior never existed.
3. Audit each remaining production `legacy`, migration, compatibility, old-hash and old-shape reference semantically. Document retained current activity/renderer/projection meanings in code or concise test names; no blanket grep-to-delete pass.

## Focused verification

```bash
npm run test -w @mafia/game-domain -- src/game-replay.test.ts src/night-actions.test.ts
npm run test -w @mafia/server -- src/game-session-validation.test.ts src/game-session-store.test.ts src/event-store.test.ts src/app.test.ts
npm run test -w @mafia/web -- src/session-outbox.test.ts src/App.test.tsx src/features/timeline/GameTimelineScreen.test.tsx src/i18n/localization-coverage.test.ts
npm run test:verifier-contracts
npm run check
```

Run the server group on a disposable current-schema PostgreSQL instance prepared by the schema companion. Add current player/results coverage through the existing test file that owns those route/store tests after tracing it. Use the controlled local browser verification in the index; do not point mutating verifiers at Production.

## Acceptance criteria

- Only current SHA-256 replay succeeds; old hash/shape/rule-adapter branches are absent and old fixtures fail without conversion.
- All current game/session writers and readers agree on explicit shapes; setup-only sessions, intermediate snapshots and current activity logs remain functional.
- Legacy normalization, fallback hydration, winner-to-outcome inference and obsolete mutation routes are removed.
- Invalid current or historical input cannot be silently repaired, overwritten or persisted through a side door.
- Canonical replay, current snapshot authority, claim/club isolation, offline/idempotent save, results projection and secret handling remain positively tested.
- Current-format end-to-end session lifecycle, focused suites, `npm run check` and integrated exact-candidate reviews pass.

## Risks and dependencies

This is intentionally a breaking removal of historical reads/writes, not merely deletion of browser key migration. Browser, API, server and verifiers must land together in one PR; partial delivery is not acceptable. Coordinate with [the browser singleton plan](./2026-09-02_142916-browser-local-game-singleton.md) and [current-schema bootstrap](./2026-09-04_232629-issue-52-current-schema.md), under [the same #52 index](./2026-09-04_232629-issue-52-current-only-plan-set.md). If “legacy” code turns out to implement a required current behavior, preserve that behavior, remove only historical adaptation, and record any material contract change for approval before continuing.
