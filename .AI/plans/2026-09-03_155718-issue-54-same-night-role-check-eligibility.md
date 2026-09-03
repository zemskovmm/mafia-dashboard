# Issue #54 Same-Night Role-Check Eligibility Implementation Plan

> **For Hermes:** Implement this plan task-by-task with the test-driven-development and systematic-debugging skills. Do not broaden the issue when unrelated findings appear.

**Goal:** Let a Don or Sheriff who was active when a night began complete or skip that night’s check even if they become inactive during that night, while omitting owners who were already inactive before the night.

**Architecture:** Snapshot Don and Sheriff eligibility when play enters `night-mafia`, preserve that non-secret eligibility through the current night, and use it as the sole authority for private-phase routing and controls. Extend persisted-state validation and canonical replay compatibility so new states carry the snapshot while existing stored games and pre-change hash chains remain loadable without weakening current-entry validation.

**Tech stack:** TypeScript, `@mafia/game-domain`, React 19, Fastify/Zod persistence validation, Vitest, PostgreSQL-backed store tests.

**Non-goals:** Reordering Mafia/Don/Sheriff phases; changing check targets or result secrecy; allowing a role owner inactive before night to act; changing victory timing; changing unrelated night, foul, music, persistence, or concurrency behavior; implementing issue #53; reopening the broader completion/history work from issue #17.

---

## Plain-language summary

The game will remember, at the start of each night, whether the Don and Sheriff were still in play. If the Mafia shot removes one of them during that same night, the host can still run or skip that role’s check. On later nights, an already removed role is skipped automatically. Existing saved games and histories must keep restoring and replaying correctly.

## Selection and current context

- Selected tracker item: [GitHub issue #54](https://github.com/zemskovmm/mafia-dashboard/issues/54), `priority:P0`, `bug`, `area:rules`.
- It is the highest-priority implementation-ready item after qualification:
  - #23 is a broad umbrella, not one independently closable implementation outcome.
  - #48 predates the later issue-#17 terminal-persistence delivery on the same day; the current tree now contains durable terminal completion, idempotency, and completed-history coverage, so #48 first needs live re-qualification rather than speculative duplicate implementation.
  - #53 still combines the active-row invariant, lease/fencing protocol, stale timeout, conflict identity, takeover UI, release policy, and displaced-offline-write behavior without an exact claim contract; it requires semantic refinement/splitting before safe implementation.
- The live branch is `main` at `50bf0ac`, aligned with `origin/main` at planning time.
- The working tree already contains staged/untracked `.AI/plans/` artifacts from backlog intake. They are unrelated existing work and must not be overwritten, deleted, or swept into the implementation commit. This plan is the only new planning artifact.
- No implementation or test command has been run in this planning turn.

## Current behavior and traced cause

- `transitionToNight` resets night fields but records no role-owner eligibility (`packages/game-domain/src/night-transition.ts:3-20`).
- `resolveMafiaShots` marks a valid victim inactive immediately, and `nextPrivatePhase` then chooses Don/Sheriff phases by current active status (`packages/game-domain/src/night-actions.ts:5-17`, `:108-151`).
- `performDonCheck` and `performSheriffCheck` also require the owner to be currently active (`packages/game-domain/src/night-actions.ts:153-230`). This rejects the exact same-night-kill case.
- `continueDonCheck` routes based on whether a Sheriff exists at all, while the UI separately gates check controls on current active status (`apps/web/src/features/night/NightStage.tsx:199-238`, `:244-341`). These paths must share one eligibility rule.
- Existing domain coverage intentionally expects killed role owners not to act (`packages/game-domain/src/night-actions.test.ts:436-476`); that opposite contract must be replaced, not retained as an absence guard.
- `GameState` has no night eligibility field (`packages/game-domain/src/types.ts:68-99`). Both the domain event-envelope validator (`packages/game-domain/src/game-events.ts:577-811`) and server snapshot schema (`apps/server/src/game-session-validation.ts:178-665`) must understand any new durable field.
- Canonical event hashes cover the entire state. Adding a field at night entry changes current replay output, so historical SHA-256 and legacy FNV chains need a narrow compatibility candidate in `replayGameLog`; current appends must continue to require current semantics (`packages/game-domain/src/game-events.ts:934-955`, `:1344-1491`).

## Acceptance criteria

1. Night entry records independent Don and Sheriff eligibility from each owner’s status at that moment.
2. A Don killed by the current Mafia shot can perform or skip that night’s Don check.
3. A Sheriff killed by the current Mafia shot can perform or skip that night’s Sheriff check.
4. If both were eligible at night start and become inactive during the night, each retains the appropriate phase; eligibility is not recomputed from current status.
5. A role owner inactive before night entry gets no phase and cannot invoke the corresponding domain action through a forged state.
6. Don and Sheriff remain independent, and phase order stays Mafia result → eligible Don check/result → eligible Sheriff check/result → night resolution.
7. The eligibility snapshot is removed when the night ends or a terminal result ends play, so the following night receives a fresh snapshot.
8. New persisted snapshots validate; inconsistent role-phase/eligibility combinations are rejected without exposing roles or private check results in public event data.
9. Existing active snapshots without the field restore with a bounded compatibility fallback, and old canonical chains retain their recorded states/hashes. New events use the corrected semantics and hashes.
10. Live execution and replay produce equivalent states through same-night Don/Sheriff kills, manual skips, later-night omission, and terminal victory paths.

## Task 1: Pin the rule correction with failing domain tests

**Objective:** Replace the old opposite expectation and define the complete transition contract before production edits.

**Files:**
- Modify: `packages/game-domain/src/night-actions.test.ts`

**Steps:**
1. Replace the test that expects a same-night killed Don/Sheriff to be skipped.
2. Add table-driven RED cases for: Don killed this night; Sheriff killed this night; both eligibility flags retained when statuses change after night entry; Don already inactive before `beginNight`; Sheriff already inactive before `beginNight`; each manual skip path.
3. Assert exact phase order and that check payload/result behavior remains unchanged.
4. Add a later-night case that completes the current night, enters the next night, and confirms the inactive owner’s phase is omitted.
5. Add a victory-timing case showing immediate terminal victory still prevents private checks.
6. Run:
   - `npm run test -w @mafia/game-domain -- src/night-actions.test.ts`
   - Expected before implementation: the new same-night cases fail for the current-active checks/phase routing, while unrelated cases pass.

## Task 2: Introduce one durable night-eligibility invariant

**Objective:** Make one domain-owned eligibility snapshot drive every private-phase decision.

**Files:**
- Modify: `packages/game-domain/src/types.ts`
- Modify: `packages/game-domain/src/night-transition.ts`
- Modify: `packages/game-domain/src/night-actions.ts`
- Test: `packages/game-domain/src/night-actions.test.ts`

**Steps:**
1. Add an optional immutable `nightCheckEligibility` object to `GameState` with explicit `don` and `sheriff` booleans. Keep it optional only for backward-compatible loading of pre-change states.
2. In `transitionToNight`, compute both booleans exactly once from the role owners’ statuses before any night action.
3. Add a small shared helper that reads the snapshot. For legacy mid-night states without it, derive only the minimum safe compatibility value from an owner still active or from that owner being the current night’s confirmed `kill` target; never infer eligibility for an owner inactive before the night.
4. Route `nextPrivatePhase`, `performDonCheck`, `performSheriffCheck`, `continueDonCheck`, `skipDonCheck`, and `skipSheriffCheck` through that helper. Require the correct eligibility in addition to the correct phase so forged ineligible role phases fail closed.
5. Preserve the snapshot through Mafia result and both role result phases.
6. Clear it when `completeNight` enters day/best-move/goodbye flow and whenever victory makes the game terminal.
7. Run the focused domain test and confirm GREEN.

## Task 3: Align the host UI with domain eligibility

**Objective:** Ensure the same-night killed owner receives usable controls and an ineligible owner is never presented.

**Files:**
- Modify: `apps/web/src/features/night/NightStage.tsx`
- Modify: `apps/web/src/features/night/NightStage.test.tsx`

**Steps:**
1. Add RED component cases for a same-night killed Don and Sheriff. Assert target buttons and Skip remain available, the check can complete, and secret result copy remains unchanged.
2. Add a case for an owner inactive before night entry and assert the domain-routed stage advances without presenting that role’s check.
3. Replace current-active UI predicates and the “any Sheriff exists” continuation label with the domain eligibility helper/snapshot used by routing.
4. Keep highlighting/seat status truthful: the owner may remain visually eliminated while the current-night check controls are enabled.
5. Run:
   - `npm run test -w @mafia/web -- src/features/night/NightStage.test.tsx`
   - Expected: RED before UI changes, then GREEN.

## Task 4: Preserve persistence and replay integrity

**Objective:** Accept valid new snapshots and replay old/new canonical histories without hash or secrecy regressions.

**Files:**
- Modify: `packages/game-domain/src/game-events.ts`
- Modify: `packages/game-domain/src/game-replay.test.ts`
- Modify: `apps/server/src/game-session-validation.ts`
- Modify: `apps/server/src/game-session-validation.test.ts`
- Modify if the persisted restore fixture proves necessary: `apps/server/src/game-session-store.test.ts`
- Modify if browser restore needs explicit coverage: `apps/web/src/session-outbox.test.ts` or `apps/web/src/App.test.tsx` (choose the narrowest existing harness after the RED test identifies the boundary)

**Steps:**
1. Extend strict domain state assertions and the Zod state schema for the exact boolean object; reject unknown keys/non-booleans.
2. Add cross-field validation: active Don/Sheriff phases require corresponding eligibility; the snapshot may exist only during the current night and must be absent after night completion/terminalization.
3. Add RED replay tests for new night-entry/check events and live-versus-replay equality through Don kill, Sheriff kill, both skips, and next-night omission.
4. Construct historical entries whose recorded state omits `nightCheckEligibility`, covering both SHA-256 and legacy FNV hashes. Add a narrow replay-only fallback that strips the newly derived field when the incoming historical state lacks it and only accepts the fallback when the exact recorded phase/day/hash matches.
5. Keep `applyCurrentGameLogEntry` strict: a newly appended entry must match corrected current semantics and may not use the historical fallback.
6. Add validation tests for valid same-night killed-owner phases, invalid ineligible phases, malformed eligibility, and post-night leakage.
7. Add one persisted restore regression at each affected phase (`night-mafia-result`, `night-don`, `night-don-result`, `night-sheriff`, `night-sheriff-result`) using the narrowest existing real store/browser restore harness. Confirm the field survives write/read and private check results remain subject to existing event redaction.
8. Run:
   - `npm run test -w @mafia/game-domain -- src/night-actions.test.ts src/game-replay.test.ts`
   - `npm run test -w @mafia/server -- src/game-session-validation.test.ts src/game-session-store.test.ts`
   - `npm run test -w @mafia/web -- src/features/night/NightStage.test.tsx src/session-outbox.test.ts src/App.test.tsx`

## Task 5: Verify and deliver the backlog item

**Objective:** Prove the scoped tree is healthy, then perform the approved backlog delivery workflow.

**Files:**
- Remove after successful implementation: `.AI/plans/2026-09-03_155718-issue-54-same-night-role-check-eligibility.md`
- Preserve untouched: all pre-existing `.AI/plans/2026-09-02_142916-*` artifacts unless they are independently shown to be part of the already-staged backlog artifact set and explicitly intended for the same commit.

**Steps:**
1. Review `git diff` and `git status`; exclude unrelated staged/untracked files from the implementation commit.
2. Run the focused suites from Tasks 1–4.
3. Run `npm run check` and require security audit, format check, lint, typecheck, all tests, and build to pass.
4. Re-read issue #54 and verify each acceptance criterion against tests and current code.
5. Remove this successfully implemented active plan, per `AGENTS.md`, and verify its deletion is the only intended AI-artifact cleanup.
6. Commit only issue-#54 source/tests plus this plan’s cleanup using a scoped message such as `fix(rules): preserve same-night role checks (#54)`.
7. Push `main`, fetch/read back `origin/main`, and verify the remote commit SHA equals the local commit.
8. Close issue #54 with the exact focused-test and `npm run check` results, then read it back to verify `state=CLOSED` and the closing comment.
9. Confirm the final working tree still contains any unrelated pre-existing artifacts exactly as found; do not claim it is clean if those artifacts remain.

## Risks and safeguards

- **Historical hash breakage:** constrain compatibility to replay only and require exact recorded hash/phase/day before accepting a legacy candidate.
- **Forged persisted phases:** domain actions and server cross-field validation both fail closed when eligibility and phase disagree.
- **Secret leakage:** eligibility contains only booleans, not roles, targets, or check results; existing private event redaction remains unchanged and receives regression coverage.
- **Stale carry-over:** explicitly clear the snapshot on every night-exit/terminal path and test a second night.
- **Conflicting UI/domain rules:** export or centralize one domain helper rather than reproducing status predicates in React.
- **Scope drift:** defer unrelated persistence, concurrency, music, and rules findings to their existing issues or a separately approved issue.

## Approval boundary

Approval authorizes only the issue-#54 implementation, focused tests, full `npm run check`, successful-plan removal, a scoped commit to `main`, push verification, and closing issue #54. Any material requirement change, replay-contract redesign beyond the bounded compatibility approach, or unrelated defect returns to clarification and plan mode.
