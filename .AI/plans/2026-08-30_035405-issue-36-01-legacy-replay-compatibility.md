# Plan 1 — Implement and verify legacy replay compatibility

Status: awaiting approval
Issue: [#36 — Close legacy replay gaps for Best Move, checks, and lifecycle variants](https://github.com/zemskovmm/mafia-dashboard/issues/36)

## Goal

Make every explicitly supported historical Best Move, Don/Sheriff check, and lifecycle variant restore to the same canonical game aggregate and server-hydrated projection, while keeping modern event creation and mutation validation strict.

## Current evidence

- `packages/game-domain/src/game-events.ts:1247` has compatibility-only branches for weak-hash Don/Sheriff checks and car-crash votes, but weak-hash Best Move events still flow through modern `toggleBestMoveSeat` rules and can reject historical owner/inactive selections.
- `packages/game-domain/src/game-events.ts:1326` enforces `game.started` phase legality only inside full replay; `applyGameEvent`/`createGameLogEntry` currently accept the marker from other phases.
- `packages/game-domain/src/game-replay.test.ts:973` covers one eliminated-owner Sheriff check, not the full Don/Sheriff matrix or historical Best Move selection variants.
- `apps/server/src/game-session-store.test.ts:319` proves a weak-hash root remains readable, but does not exercise a live historical special-action chain through server hydration.
- `apps/server/src/game-session-validation.test.ts:123` already establishes the modern API boundary by rejecting an 8-hex event hash; preserve that contract.

## Non-goals

- No new replay version, database migration, bulk rewrite, or destructive cleanup of historical rows.
- No relaxation of modern Best Move target rules, immutable-role result checks, lifecycle-root ordering, SHA-256 generation, or API rejection of weak hashes.
- No UI redesign, timeline presentation change, statistics change, or work from parent/adjacent issues.
- No changes to club ownership/isolation behavior.

## Implementation sequence (strict RED → GREEN per behavior)

1. **Reproduce historical Best Move replay failure.**
   - Add a focused domain regression fixture using a genuine legacy 8-hex hash and a `best-move.completed` payload containing historically accepted owner and/or inactive selections.
   - Verify RED: current replay rejects the event through modern target validation.
   - Add the narrowest compatibility-only replay branch that reconstructs the historical result, validates phase, seated identities, selection cardinality/uniqueness, and immutable `mafiaHits`, and is reachable only for legacy-hash events.
   - Verify GREEN, then add negative cases for malformed phase, seat, duplicates/count, or hit total as the historical contract requires.

2. **Complete the legacy check matrix.**
   - Convert/extend the existing eliminated-owner check regression so both Don and Sheriff historical encodings are exercised through replay.
   - Preserve rejection of wrong phases, missing role owners/targets, and role-derived match mismatches.
   - Confirm modern SHA events continue through `performDonCheck`/`performSheriffCheck` and retain current active-owner rules.

3. **Make lifecycle legality consistent at creation and replay boundaries.**
   - Add failing domain tests showing `game.started` cannot be applied or created outside its documented `mafia-planning` root state while valid setup lifecycle roots remain legal.
   - Centralize the invariant in the narrowest shared domain boundary so direct application, creation, and replay agree; retain full-chain root-position and completion-head checks.
   - Add lifecycle restoration coverage across documented transient setup/phase states (including `mafia-planning` and `sheriff-wake`) and assert replay frames/aggregate state at each supported checkpoint.

4. **Prove live server hydration, not only domain replay.**
   - Add a server-store integration regression that seeds representative historical replay rows and reads them through `GameSessionStore` initialization/hydration.
   - Assert the hydrated current game, active event branch, head, and materialized log/projection agree with domain replay and preserve the original historical envelopes.
   - Keep the fixture on the historical read path; do not make modern start/append mutation paths accept or emit weak hashes.

5. **Reconfirm the modern-write boundary and scope.**
   - Retain or sharpen focused validation assertions that API mutation schemas reject 8-hex hashes and malformed lifecycle roots.
   - Confirm `createGameLogEntry` emits `sha256:<64 lowercase hex>` for every newly created event and that invalid modern Best Move selections remain rejected.
   - Inspect the final diff for only issue #36 source/tests plus this plan set; preserve the unrelated pre-existing untracked plan.

## Expected files

- `packages/game-domain/src/game-events.ts`
- `packages/game-domain/src/game-replay.test.ts`
- `apps/server/src/game-session-store.test.ts`
- `apps/server/src/game-session-validation.test.ts` only if an explicit modern-boundary assertion is needed

Change another production file only if a failing end-to-end compatibility probe proves the read path itself must change; stop and revise this plan if that materially changes scope.

## Verification

Run each new focused test alone and observe the intended RED before production edits, then GREEN after the minimal fix. On the unchanged final candidate run:

1. `npm run test -w @mafia/game-domain -- game-replay.test.ts`
2. `npm run test -w @mafia/server -- game-session-store.test.ts game-session-validation.test.ts`
3. `npm run check`
4. Review `git diff --check`, the exact changed-path list, and the final diff for legacy-read-only branching, modern-write strictness, secrets, generated artifacts, and unrelated edits.

## Acceptance criteria

- Supported historical Best Move variants, including owner/inactive selections represented by legacy hashes, replay deterministically to the expected canonical state.
- Both historical Don and Sheriff check variants restore with eliminated role owners where supported, while invalid role/phase/result combinations fail closed.
- `game.started` phase/root legality is consistent across direct application, event creation, request validation, and full replay.
- Documented transient lifecycle states restore in order with correct replay frames and no skipped meaningful checkpoint.
- A representative persisted legacy chain hydrates through the real server store to the same current game and projection as domain replay.
- Newly created events remain SHA-256 only; modern API writes still reject weak hashes and modern Best Move/check rules remain strict.
- Focused tests and `npm run check` pass with no unrelated source changes.
