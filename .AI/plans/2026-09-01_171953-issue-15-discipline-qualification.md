# Issue #15 Discipline Qualification and Regression Plan

> **For Hermes:** Execute only after explicit approval. Preserve direct foul/red-card controls and the existing Undo/Timeline Reset correction model.

**Tracker:** [#15 — Implement fouls, speech penalties, disqualification, and moderator rulings](https://github.com/zemskovmm/mafia-dashboard/issues/15)

**Goal:** Qualify the existing discipline implementation against the owner-revised acceptance contract, add only missing regression coverage, fix production code only if a new test proves a real behavior defect, and close #15 with verified evidence.

**Architecture:** Treat the existing canonical foul/red-card events and browser-authoritative replay prefix as complete product behavior. Exercise corrections through the actual Undo/Timeline Reset paths and verify domain invariants directly. Do not introduce forms, explanatory metadata, new event types, or a generalized ruling system.

**Tech Stack:** TypeScript, Vitest, React Testing Library, existing canonical replay and App state/history code.

**Non-goals:** Confirmation dialogs; foul reasons or notes; actor metadata; payload timestamps beyond existing event-envelope `createdAt`; custom-ruling UI; compensating reversal events; append-only inactive branches; redesigning discipline controls; unrelated issue work.

---

## Revised acceptance contract

Owner decisions supersede the stale remaining-scope text in #15:

1. Foul and swipe red-card controls remain immediate; no confirmation step.
2. No reason, optional note, host actor, or additional discipline metadata is required.
3. Existing Undo and Timeline Reset are the correction mechanisms.
4. Existing game rules remain authoritative:
   - foul 3 creates one pending 10-second nomination-only turn;
   - foul 4 immediately red-cards the player;
   - a manual red card can remove any active player from Day 1 through active play;
   - red cards update eligibility, voting cancellation, and victory;
   - red-carded players never receive a final speech.

## Source-backed readiness findings

- `packages/game-domain/src/day-actions.ts:113-128` already counts fouls, sets the third-foul pending penalty, and routes foul 4 through `redCard`.
- `packages/game-domain/src/day-actions.ts:164-235` already supports manual red cards across active phases, removes the player from active state/turn order, cancels voting where required, and reevaluates victory.
- `packages/game-domain/src/day-actions.test.ts:77-227` covers the third-foul turn, fourth-foul red card, manual disqualification, all active phases, and voting cancellation.
- `apps/web/src/App.tsx:836-1024` records canonical events and rebuilds state from the retained event prefix for Timeline Reset and Undo.
- `apps/web/src/App.test.tsx:1039-1066` already proves Timeline Reset removes a foul and reconstructs the prior count.
- Missing focused evidence is limited to Undo around third-foul penalty consumption, Undo of a red-card victory/eligibility change, and explicit no-goodbye assertions for manual and fourth-foul paths.

## Protected baseline

- Branch: `main`
- Local/tracked remote baseline: `5fba469f68657c027dbef2810ad39f087405fa51`
- Leave `.AI/plans/2026-08-29_134707-reconcile-stale-in-progress-github-issues.md` untouched.
- This plan replaces the superseded three-file metadata/dialog plan set; those obsolete files are removed rather than archived because their rationale was explicitly rejected.

### Task 1: Add only the missing domain regression coverage

**Files:**
- Modify: `packages/game-domain/src/day-actions.test.ts`
- Modify only if replay-prefix coverage fits better there: `packages/game-domain/src/game-replay.test.ts`

**Steps:**
1. Add explicit assertions that fourth-foul and manual red cards never create a new `goodbye-speech` state or add the red-carded seat to `goodbyeSeats`.
2. Include an active `goodbye-speech` setup to prove red-carding another active player does not grant that player final words or disturb the legitimate eliminated player's existing goodbye.
3. Assert the fourth-foul route still produces exactly the same eligibility/victory consequences as direct `redCard`.
4. Run `npm test -w @mafia/game-domain -- src/day-actions.test.ts src/game-replay.test.ts`.
5. These are characterization/regression tests for already-required behavior; do not manufacture a failing RED cycle. If a test reveals a real defect, make the smallest domain fix and prove the test fails on the old behavior before retaining it.

### Task 2: Prove corrections through the real Undo path

**Files:**
- Modify: `apps/web/src/App.test.tsx`
- Modify production only if a test proves a defect: `apps/web/src/App.tsx`

**Steps:**
1. Extend the existing `GameScreen` test harness only as needed to issue repeated canonical fouls to the same seat and a deterministic manual red card.
2. Add an App integration test for Undo **before** third-foul penalty consumption: after three fouls, Undo restores foul count 2 and clears `mutePending`.
3. Add an App integration test for Undo **after** the penalty-consuming turn action: undo the later turn action and then the third foul, verifying replay restores the correct speaker, foul count, pending-penalty state, and event prefix at each step.
4. Add an App integration test that a manual red card changes active eligibility and can create a winner, then Undo restores the player, prior phase, and `winner: null` without adding a compensating event.
5. Retain the existing Timeline Reset foul regression as the complementary correction path.
6. Run `npm test -w @mafia/web -- src/App.test.tsx`.
7. Fix production only if these source-backed expectations fail; keep any fix within current prefix-replay semantics.

### Task 3: Verify and deliver the revised issue

**Steps:**
1. Run the focused domain and App tests above.
2. Run `npm run check` from the repository root.
3. Run `git diff --check` and inspect the scoped diff/status. Confirm there are no dialog, reason/note, actor, timestamp-payload, or custom-ruling changes.
4. At implementation start, commit only this approved replacement plan so its rationale remains in Git history. After verification, remove this completed issue-15 plan in the implementation commit per `AGENTS.md`; do not remove the older unrelated plan.
5. Commit the scoped regression coverage and any test-proven minimal fix, push `main`, and verify the remote SHA with `git ls-remote origin refs/heads/main`.
6. Comment on #15 with the owner-approved scope reduction, verified behavior, exact local commands, and remote commit. Read the comment back, close #15, and verify its closed state.

## Stop conditions

- If correction cannot reconstruct foul count, pending penalty, eligibility, phase, or victory within the existing three-action/day-boundary Undo rules, stop and return to plan mode rather than inventing a new correction architecture.
- If satisfying no-final-speech requires changing unrelated elimination/Best Move behavior, stop and report the source-backed conflict.
- Do not absorb newly discovered discipline features into #15; defer them separately.
