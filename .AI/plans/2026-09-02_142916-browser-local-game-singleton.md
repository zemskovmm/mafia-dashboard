# Issue #52 V5-only Browser Game Singleton Implementation Plan

> **For Hermes:** Execute only after Michael approves the entire revised [same-ticket #52 plan set](./2026-09-04_232629-issue-52-current-only-plan-set.md). Use strict RED-GREEN-REFACTOR cycles. This file covers browser ownership only; companion plans now remove historical game-data, server, database and preference compatibility too.

**Goal:** Enforce at most one durable browser-local game through one strict global v5 `localStorage` record, while ignoring all obsolete browser game records and blocking malformed/unsupported v5 data until the host explicitly clears it.

**Architecture:** Keep `mafia-dashboard.game-session.v5` as the only supported durable game key. `GameSessionOutbox` accepts only the current canonical v5 envelope with explicit `clubId`/`gameId`; the browser-storage coordinator classifies that one key as empty, valid, or invalid under the existing Web Lock. Valid ownership is resolved before a workspace mounts. Invalid v5 bytes block every club until an exact-snapshot explicit clear. No production path discovers, reads, migrates, deletes, tombstones, or resolves v3/v4 candidates, and no game-state path reads or writes `sessionStorage`.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, the current `GameSessionOutbox`, Web Locks, browser `localStorage`, and the existing verifier-contract scripts.

**Non-goals:** Preserving, migrating, cleaning, or interpreting v3/v4 browser game data; conflict selection between old records; changing claim/takeover behavior; merging, deploying, or closing issue #52. Server/domain/database/preference compatibility and the shared game-data contract belong to companion plans under this same ticket, not exclusions from #52.

---

## Plain-language summary

The browser will understand only the current global v5 game record. Old v3/v4 keys are invisible and remain byte-for-byte untouched. A valid v5 game restores its owning club and cannot be silently replaced; a bad v5 record blocks play until the host deliberately clears exactly that record. The old migration, tombstone, and candidate-choice machinery disappears, while cross-tab locking, offline outbox safety, lifecycle cleanup, owner gating, and verifier checks remain.

## Requirements and proposed safety boundaries

- Remove all v3/v4 migration and normalization paths, legacy `sessionStorage` scans, legacy tombstones, candidate-conflict state/UI, compatibility tests, and verifier fallbacks.
- Ignore obsolete v3/v4 keys in both storage areas and leave their bytes untouched. Only the existing explicit **Clear all browser data** action may remove them as part of clearing all application storage.
- Treat a malformed or unsupported value at the global v5 key as blocking state. Never reinterpret it as empty or allow a new game to overwrite it; require an explicit exact-snapshot local clear.
- Keep delivery on `issue-52-browser-game-singleton`: open a PR to `main`, but do not merge, deploy, enable auto-merge, or close #52.
- Preserve current canonical replay/outbox behavior using the strict current game-data contract defined in the companion plan. The earlier blanket exemption for server/domain compatibility is superseded.
- Untouched obsolete keys and invalid-record exact-clear handling are retained proposed safety boundaries; unanswered clarification forms are not confirmation. Approval must cover these assumptions as recorded in the plan-set index.

## Current state and planning boundary

- Issue #52 remains open, but its current GitHub body still requires v3/v4 migration and stale-copy cleanup. That text is superseded by the decisions above and must be reconciled after plan approval before source work resumes.
- Read-only refresh found `/Users/Michael/Repos/Mafia Dashboard.issue-52` on `issue-52-browser-game-singleton`, HEAD `a072794e74e0fc7c173edfe21524834189a37832`, with staged source plus two earlier-plan deletions and no unstaged diff. Canonical remote `main` remains `3ab810850aed528bc7c700049d629008b8f9682f`. Preserve this state; do not reset, stash, clean, or copy source into the primary checkout.
- Commit `a072794e74e0fc7c173edfe21524834189a37832` preserves the earlier migration-oriented plan pair. The regenerated approved bytes must enter a later plan-only revision commit before the final source commit.
- The prior v3 identity and tombstone review findings become obsolete when all legacy discovery and conflict resolution are removed. The stale release-result finding remains applicable to the v5-only flow.
- `.AI/reviews/2026-09-04_200409-issue-52-blocker-disposition.md` is a superseded local review input, not source and not authorized for ticket-history transport.

## Revised issue contract

After approval, replace issue #52's migration-oriented body with the complete contract in the plan-set index, including the following browser semantics, and verify remote readback before implementation:

- One global `localStorage` key, `mafia-dashboard.game-session.v5`, is the only supported browser game aggregate.
- A valid record requires current v5 shape plus explicit UUID `clubId` and `gameId` ownership.
- v3/v4 keys and game-state values in `sessionStorage` are ignored and left untouched; there is no migration or compatibility path.
- An absent v5 key means empty. A valid v5 key means attached. A malformed or unsupported v5 value means blocked-invalid and requires an explicit exact-value clear.
- Starting/resuming another game cannot replace a valid or invalid v5 value without the appropriate explicit safe action.
- Valid v5 completion, sign-out, owning-club deletion, explicit game clear, and local release remove only the current v5 record plus current claim data where already required. Clear all browser data remains intentionally broad.
- Cross-device ownership remains outside #52; current club claim/takeover behavior remains unchanged.

## Acceptance criteria

- At most one supported browser game exists, under the exact global v5 `localStorage` key, with explicit owning `clubId` and `gameId`.
- Production contains no v3/v4 game-key constants, parsers, migration options, candidate ranking/selection, tombstone policy, or legacy game-key cleanup.
- Production never reads or writes browser game state in `sessionStorage`; current claim-controller tab identity remains permitted and separately tested.
- Obsolete v3/v4 values in either storage area remain byte-identical through startup, owner restore, release, completion, sign-out, and club deletion. Clear all browser data may remove them only because it clears all application storage.
- A missing v5 key is empty; a valid current v5 record is restored; malformed or unsupported v5 bytes produce a blocking invalid state without mutation.
- Invalid state prevents club/workspace entry, game start/resume, and outbox construction until an explicit clear revalidates the exact displayed raw value under the browser lock.
- If invalid bytes change before clear acquires the lock, clear refuses, preserves the replacement, and refreshes the blocking state.
- A valid owner is resolved before workspace rendering. Selecting another club cannot mount it or overwrite the aggregate and offers return-to-owner plus synchronized local-only release.
- Release rejects unresolved or changed records. If another context already removed the exact record while release waited, stale dialog state is dismissed and the requested club becomes openable without recreating or deleting data.
- Outbox enqueue/flush/clear preserves exact v5 ownership, canonical replay, offline operations, idempotent mutation IDs, durable clear recovery, and stale cross-context rejection.
- Completion, sign-out, explicit clear, and owning-club deletion remove the applicable v5 record; deletion of another club leaves it intact; unrelated browser preferences remain untouched except under Clear all browser data.
- English and Russian v5 ownership, missing-owner, release, and invalid-record recovery copy remains accessible. All legacy candidate-choice copy and styling is absent.
- Verifier contracts inspect only the global v5 `localStorage` record, require the expected owner, and contain no v3/v4 or game-state `sessionStorage` fallback.

### Task 1: Reconcile issue semantics and freeze the current candidate

**Objective:** Make the tracker and local implementation boundary match the v5-only decision before source edits.

**Files/state:**
- GitHub issue #52 body.
- Primary regenerated plan pair and shared untracked backlog index.
- Isolated worktree staged candidate.

**Steps:**
1. Re-read issue #52, local/remote `main`, worktrees, branch state, and every primary dirty path. Stop on unexpected source or remote drift.
2. Update only issue #52's body to the complete contract in the revised plan-set index; retain title, labels, open state, and issue relationships. Read it back and verify all companion scopes, removed compatibility promises, and current-version safeguards. Do not update the issue with this browser slice alone.
3. Record the exact canonical base, staged tree, staged path set, and empty/dirty unstaged boundary before edits. Do not reset or reconstruct the candidate from chat history.
4. Hash every plan named by the revised #52 index. Keep the shared backlog index and superseded review local-only; preserve their existing bytes.

### Task 2: Make the outbox strictly v5-only

**Objective:** Remove browser-envelope compatibility code while preserving current v5 replay and cross-tab safety.

**Files:**
- Modify: `apps/web/src/session-outbox.test.ts`
- Modify: `apps/web/src/session-outbox.ts`

**Steps:**
1. Add RED tests that an absent key starts empty, a canonical v5 record restores, and any v3/v4/malformed/unsupported value at the v5 key throws a blocking invalid-record error without changing storage.
2. Add RED assertions that unrelated v3/v4 keys in local/session storage are never consulted or changed and that no `legacyStorageKey` option or legacy flush path exists.
3. Remove v3/v4 envelope types/parsers/migration branches, `legacyStorageKey`, legacy snapshots/flush state, and browser-envelope normalization operations. Tighten the current v5 schema instead of silently returning an empty envelope for invalid bytes.
4. Preserve current v5 canonical replay, snapshot authority, claim generation, outbox enqueue/flush, clear recovery, exact storage synchronization, and different-owner/game rejection.
5. Integrate the companion current game-data contract without retaining historical snapshot/hash/log conversions. Preserve current snapshot authority and setup activity; do not improvise a second wire schema in the browser layer.
6. Run the full `session-outbox.test.ts` suite and require GREEN.

### Task 3: Replace migration coordination with strict v5 classification

**Objective:** Reduce browser storage coordination to empty/valid/invalid v5 state and exact locked lifecycle mutations.

**Files:**
- Modify: `apps/web/src/browser-game-storage.test.ts`
- Modify: `apps/web/src/browser-game-storage.ts`
- Preserve unless a focused regression requires change: `apps/web/src/browser-game-storage-lock.ts`

**Steps:**
1. Replace migration/conflict tests with RED cases for absent v5, valid v5 owner inspection, malformed/unsupported v5 blocking, exact invalid-record discard, stale discard refusal, synchronized release, unresolved release refusal, owner-club cleanup, other-club preservation, sign-out cleanup, and unrelated-key preservation.
2. Add explicit fixtures proving v3/v4 keys in both storage areas remain byte-identical and do not affect empty/valid/invalid classification.
3. Remove legacy prefixes, tombstone records/policies, v3/v4 normalization, storage enumeration, candidate types/ranking/deduplication, conflict state, and conflict resolution.
4. Expose one strict read/prepare state for the global localStorage v5 key: `empty`, `ready`, or `invalid`. Preserve the exact raw storage snapshot in ready/invalid state for post-lock comparison.
5. Keep Web Lock serialization and exact compare-before-release/clear behavior. Simplify cleanup to the v5 key and current claim keys only; never sweep obsolete game keys.
6. Run the full `browser-game-storage.test.ts` suite and require GREEN.

### Task 4: Simplify App ownership and add invalid-v5 recovery

**Objective:** Remove legacy candidate UI while preserving owner-first gating and explicit recovery from invalid current data.

**Files:**
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/i18n/messages/shell.ts`
- Modify: `apps/web/src/styles/app.css`

**Steps:**
1. Add RED App cases for valid-owner restore, cross-club blocking, valid missing-owner recovery, invalid v5 pre-workspace blocking, exact invalid clear, changed-invalid refusal, ignored/untouched v3/v4 keys, and the stale `releaseBrowserGameStorage() === false` race.
2. Remove candidate-conflict callbacks/rendering, candidate types, migration preparation arguments, localized conflict-choice strings, and `.browser-game-candidates` styling.
3. Prepare only localStorage v5 after clubs load. Gate `openClub` with a fresh strict state read so invalid bytes can never be treated as empty and no wrong-club workspace can mount.
4. Add an accessible localized invalid-record recovery dialog. Its destructive action must name local clearing, compare the exact displayed bytes under the lock, and refresh instead of clearing if another context changed the value.
5. Keep valid missing-owner discard separate from invalid-record clear. Both must be exact-snapshot locked operations.
6. On safe release, capture the target before awaiting. Treat a locked `false` result as already absent: clear stale blocking UI and open the captured target. Preserve fail-closed behavior for changed/invalid/unresolved records.
7. Update completion, sign-out, active-game clear, club deletion, and Clear all integrations to remove only supported v5/current claim data, except Clear all's intentionally broad storage wipe.
8. Run the named ownership/invalid/release tests and the full `App.test.tsx` suite; require GREEN.

### Task 5: Align verifier contracts and prove legacy absence

**Objective:** Keep operational verification on the exact v5-only contract.

**Files:**
- Modify as needed: `scripts/session-verifier-contracts.test.mjs`
- Modify as needed: `scripts/session-verifier-contracts.mjs`
- Modify as needed: `scripts/verify-session-state.mjs`
- Modify as needed: `scripts/verify-ui.mjs`

**Steps:**
1. Add/retain positive checks for the one global v5 localStorage key and exact `clubId` ownership before browser-owned requests.
2. Remove compatibility fixtures and fallback logic. Replace narrow v4 checks with a static contract that no production verifier reads game state from sessionStorage or derives v3/v4 keys.
3. Preserve canonical replay/event verification and use the exact strict current metadata contract from the companion game-data plan. Remove old-field fallback rather than independently reinterpreting server responses.
4. Run `npm run test:verifier-contracts`; require GREEN.

### Task 6: Verify and freeze one exact v5-only candidate

**Objective:** Qualify the simplified source tree before any commit or remote publication.

**Steps:**
1. Run focused tests:
   ```bash
   npm run test -w @mafia/web -- src/browser-game-storage.test.ts src/session-outbox.test.ts src/session-claim.test.ts src/App.test.tsx src/i18n/localization-coverage.test.ts --reporter=dot
   npm run test:verifier-contracts
   npm run typecheck -w @mafia/web -- --force
   npm run check
   ```
2. Search production/tests/verifiers for v3/v4 browser game constants, `legacyStorageKey`, legacy tombstones, conflict-candidate symbols/copy, and game-state sessionStorage access. Reconcile other compatibility occurrences with the companion plans; a keyword match alone is not a defect.
3. Inspect the canonical-base-to-index diff, changed path set, file modes, `git diff --check`, and non-printing secret scan. Require every changed path to belong to an approved #52 companion scope; no dependency or deployment-workflow change is planned.
4. Freeze the exact staged tree and canonical-base patch SHA-256 with an empty unstaged diff.
5. Use the integrated review in the plan-set index, including strict invalid-v5 blocking, no hidden legacy reads/deletes, exact cross-tab checks, owner isolation, lifecycle cleanup, and verifier alignment. Do not count a browser-only review as acceptance of server/domain/database changes.
6. Permit at most one bounded fix/re-review cycle for concrete accepted-scope P0/P1 findings. Suggestions and rejected legacy-migration concerns are non-blocking. Any source edit invalidates the candidate hash and all prior verdicts.
7. Hand the passing exact candidate to the closeout plan below. Do not commit or push a review-failed candidate.

## Risks and tradeoffs

- **Intentional data abandonment:** Existing v3/v4 browser records will not restore and will remain stored. This is the explicit product decision; tests must prevent accidental future migration or deletion.
- **Invalid v5 deadlock:** If any path treats invalid bytes as empty, a new game could silently overwrite them. Use one typed state reader at every pre-workspace and destructive boundary.
- **Cross-plan contract drift:** Historical server/replay/schema compatibility is now in #52, but removal belongs to the named companion plans. Current setup activity, authoritative snapshots, current renderer choices and active server deletion tombstones must not disappear through keyword deletion.
- **Claim/sessionStorage confusion:** The ban applies to durable game state. Current session claim/tab identity may remain in sessionStorage and must still be cleaned where existing lifecycle rules require.
- **Stale cross-tab actions:** Every valid release and invalid clear must revalidate the exact displayed raw value after lock acquisition.
- **Staged-candidate loss:** The isolated worktree contains substantial approved work. Never reset/stash/clean it; remove obsolete paths through reviewed TDD edits only.

## Open questions

The complete revised plan set awaits approval. The latest clarification timed out; see the index for explicitly proposed non-destructive storage/database assumptions. Earlier approvals do not authorize this broadened implementation.
