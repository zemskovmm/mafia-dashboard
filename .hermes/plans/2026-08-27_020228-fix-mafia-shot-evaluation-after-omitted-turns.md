# Fix Mafia Shot Evaluation After Omitted Turns Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Allow **Evaluate Mafia shots** to accept and persist the shot result after non-persisted day-turn navigation, keep the **Critical** pill visible whenever the game is critical, and give the current Goodbye speaker the same bright yellow-fire treatment used for vote selection.

**Architecture:** Keep the existing event-sourced model: provisional assignments and navigation-only turns stay out of accepted history, and the single `mafia.shots-resolved` event remains the semantic checkpoint. Teach the canonical reducer to deterministically advance omitted day turns to the Mafia-shot precondition before applying that event, while refusing to bypass meaningful voting or cancellation states. Derive Critical visibility only from canonical game conditions rather than privacy or phase presentation, and map only the current phase-owned Goodbye speaker to the existing voting-highlight visual class. Cover the domain replay seam, the `App` canonical-vs-displayed-state seam, and focused rendered UI behavior.

**Tech Stack:** TypeScript, React 19, Vitest, Testing Library, `@mafia/game-domain` canonical replay.

---

## Evidence and confirmed root cause

The screenshots show a live `Mafia shots` screen with all three active Mafia players assigned to seat 8. Clicking **Evaluate Mafia shots** raises:

`Mafia shots can only be recorded during the Mafia night phase`

The stack reaches:

- `packages/game-domain/src/night-actions.ts:64-70` (`recordMafiaShot` phase guard)
- `packages/game-domain/src/game-events.ts:1151-1156` (`mafia.shots-resolved` replay)
- `apps/web/src/App.tsx:871-894` (`acceptGameEvent` / `createGameLogEntry`)
- `apps/web/src/features/night/NightStage.tsx:117-124` (Evaluate button)

A deterministic command-line reproduction was run. It kept the canonical state at `day`, advanced only the displayed draft through all day turns to `night-mafia`, assigned all three shots, and then applied `mafia.shots-resolved` against the canonical state. It failed with the exact reported error:

```text
{"canonicalPhase":"day","displayedPhase":"night-mafia","shots":3}
Error: Mafia shots can only be recorded during the Mafia night phase
```

The causal sequence is:

1. `turn.completed` is intentionally classified as non-meaningful in `packages/game-domain/src/game-events.ts:184-186`.
2. `apps/web/src/App.tsx:878-883` therefore advances only the displayed in-memory draft; `canonicalGameRef` remains at the last semantic day checkpoint.
3. With no nominations, the last omitted day turn calls `completeDay` and moves the displayed draft directly to `night-mafia` (`packages/game-domain/src/day-actions.ts:51-56,127-157`).
4. Mafia shot assignments remain provisional via `onGameChange`, as designed.
5. Evaluate emits the meaningful `mafia.shots-resolved` event.
6. `createGameLogEntry` applies that event to the stale canonical `day` state before the displayed-draft fallback in `App.tsx:895-903` can run, so the first `recordMafiaShot` rejects it.

Current focused tests pass but do not represent this split-state path:

- `npm run test -w @mafia/game-domain -- --run src/game-replay.test.ts` — 37 passed
- `npm run test -w @mafia/web -- --run src/features/night/NightStage.test.tsx` — 8 passed

### Ranked hypotheses

1. **Confirmed:** canonical replay is still at `day` while the displayed draft is at `night-mafia` after omitted turns.
2. **Ruled out:** the three shot assignments are malformed; resolving them directly from the displayed state succeeds and yields three secret shots.
3. **Ruled out:** this is a read-only timeline preview mutation; the screenshot shows the live Host view with enabled shot controls and Evaluate action.
4. **Contributing coverage gap:** component tests own the whole game in local React state, so they never exercise `App`'s separate canonical replay head and displayed draft.

---

### Task 1: Add a failing domain regression for the exact canonical/draft divergence

**Objective:** Prove the canonical reducer currently rejects the user's valid semantic Mafia event after omitted no-nomination day turns.

**Files:**
- Modify: `packages/game-domain/src/game-replay.test.ts`

**Step 1: Build the smallest reported state sequence**

Add a regression that:

1. Starts from `dayOne()` with no nominations; retain this as `canonical`.
2. Advances a separate `displayed` state with `completeCurrentTurn` until it reaches `night-mafia`.
3. Assigns every active black player to one active red target in `displayed`.
4. Calls `resolveMafiaShots(displayed)` to obtain the exact `shots` and `result` payload emitted by `NightStage`.
5. Applies or creates a `mafia.shots-resolved` event with `before: canonical`.

Use the real domain functions rather than manually forcing `phase` or fabricating a payload.

**Step 2: Assert the intended semantic outcome**

The event should:

- apply without throwing;
- end in `night-mafia-result`;
- preserve the complete shooter-to-target assignments;
- keep the target active until **Continue night**, matching the existing evaluate-before-confirm contract;
- produce the same state as applying the event directly to the displayed `night-mafia` state.

**Step 3: Add a safety boundary**

Add a neighboring assertion showing that the same Mafia event cannot skip a meaningful unresolved phase. A day state with a valid nomination should advance only to `voting`, then still reject the Mafia shots. This prevents the preparation logic from silently bypassing voting, car-crash resolution, or explicit cancellation review.

**Step 4: Run RED**

Run:

```bash
npm run test -w @mafia/game-domain -- --run src/game-replay.test.ts
```

Expected before implementation: the new no-nomination test fails with `Mafia shots can only be recorded during the Mafia night phase`; the meaningful-phase safety assertion passes or fails only if the harness needs correction.

---

### Task 2: Fold omitted day navigation into the Mafia semantic checkpoint

**Objective:** Make `mafia.shots-resolved` replayable from the last canonical semantic checkpoint without persisting navigation-only turns.

**Files:**
- Modify: `packages/game-domain/src/game-events.ts:1010-1060` (phase-preparation helpers)
- Modify: `packages/game-domain/src/game-events.ts:1151-1160` (`mafia.shots-resolved` reducer branch)

**Step 1: Add one narrow preparation helper**

Add a helper beside `advanceToVoting`, `advanceToDonCheck`, and `advanceToSheriffCheck` that prepares the Mafia-shot precondition:

- If state is already `night-mafia`, return it unchanged.
- If state is `day` or `car-crash`, repeatedly use the existing canonical `completeCurrentTurn` path, as `advanceToVoting` already does.
- Stop as soon as the domain reaches a non-navigation phase.
- Return `night-mafia` only when the normal no-nomination day transition naturally produces it.
- Do not invoke `beginNight` across `voting`, `voting-cancelled`, `car-crash-decision`, `car-crash-result`, `car-crash-skipped`, or `goodbye-speech`; those are meaningful/reviewable boundaries with their own accepted events.

Prefer reusing or narrowly generalizing `advanceToVoting` rather than duplicating its bounded turn loop.

**Step 2: Prepare before restoring shot assignments**

In the `mafia.shots-resolved` case, initialize `shotGame` from the prepared canonical state and then clear/reapply `shotAssignments` from the immutable event payload. Keep all existing shooter eligibility, result-integrity, and phase guards intact.

Do not:

- weaken `recordMafiaShot`'s `night-mafia` guard;
- persist provisional shot clicks;
- create a synthetic extra phase event;
- apply the event from `App`'s displayed state, which would make the persisted chain unreplayable from its parent;
- skip unresolved voting or review phases.

**Step 3: Run GREEN**

Run:

```bash
npm run test -w @mafia/game-domain -- --run src/game-replay.test.ts
npm run test -w @mafia/game-domain -- --run src/night-actions.test.ts
```

Expected: the exact regression passes, the safety boundary still rejects phase skipping, and all Mafia evaluation/confirmation rules remain green.

---

### Task 3: Add an `App` regression at the failing integration seam

**Objective:** Verify the real split between `canonicalGameRef` and the displayed draft no longer causes a console error or dropped event.

**Files:**
- Modify: `apps/web/src/App.test.tsx:40-45` (test harness state)
- Modify: `apps/web/src/App.test.tsx:219-350` (mocked `GameScreen` controls/callback capture)
- Modify: `apps/web/src/App.test.tsx:1779-1824` (incremental checkpoint tests area)

**Step 1: Expose the accepted-event callback in the existing harness**

Extend the mocked `GameScreen` harness to capture the live `onAcceptedEvent`, or add one test-only action that emits a complete `mafia.shots-resolved` draft derived from the current displayed game. Reset this extra harness field in the existing test cleanup to avoid cross-test leakage.

**Step 2: Reproduce the UI/application sequence**

The test should:

1. Start the test game.
2. Invoke `Record game action` until the displayed state naturally reaches `night-mafia`; do not set the phase directly.
3. Confirm the persisted/canonical history still contains only the prior semantic checkpoint.
4. Build valid shot assignments for every active black player and a shared active red target using domain helpers.
5. Emit the same `mafia.shots-resolved` draft as `NightStage`.

**Step 3: Verify behavior and persistence**

Assert:

- no `reportError` entry with the Mafia phase-guard message;
- the displayed game reaches `night-mafia-result`;
- one `append-event` operation is queued/sent with type `mafia.shots-resolved`;
- local persisted history contains that event with the previous canonical checkpoint as parent;
- replaying the persisted active branch yields the same evaluated result.

This test must fail on the current code for the exact console error, not because of a missing fixture field or mocked API shape.

**Step 4: Run the focused web regression**

Run:

```bash
npm run test -w @mafia/web -- --run src/App.test.tsx
```

Expected: the new integration test and existing incremental-history/preview tests pass.

---

### Task 4: Keep the Critical pill visible whenever conditions are met

**Objective:** Make Critical state presentation independent of the current gameplay phase and privacy masking.

**Files:**
- Modify: `apps/web/src/features/game/GameScreen.tsx:463-481`
- Modify: `apps/web/src/features/game/GameScreen.test.tsx:63-109`

**Step 1: Change the focused test to the required contract**

Build one critical fixture and rerender it through Day, Voting, car-crash, Goodbye speech, Best move, Mafia shots/results, Don/Sheriff checks/results, Night complete, and privacy-hidden presentation. Assert the `Critical` status pill stays rendered whenever `isCriticalState(game)` is true. Add one non-critical fixture proving the pill is absent.

**Step 2: Run RED**

```bash
npm run test -w @mafia/web -- --run src/features/game/GameScreen.test.tsx
```

Expected before implementation: the existing phase/privacy gates hide the pill in at least privacy-hidden and `night-mafia` states.

**Step 3: Remove presentation-only visibility gates**

Render the pill solely when `isCriticalState(game)` is true. Keep team counts masked when privacy is hidden, but do not hide the non-secret Critical status. Preserve its placement directly below/with the Citizens/Mafia counters and existing styling.

**Step 4: Run GREEN**

Run the same focused test and expect all phase cases to pass.

---

### Task 5: Give only the current Goodbye speaker the bright vote-selection highlight

**Objective:** Reuse the established `is-voting-highlight` yellow-fire animation for the active Goodbye speaker, without illuminating stale Best move owners or unrelated eliminated players.

**Files:**
- Modify: `apps/web/src/features/game/GameScreen.tsx:556-590`
- Modify: `apps/web/src/features/game/GameScreen.test.tsx:415-448,529-600`

**Step 1: Strengthen the rendered regression**

Update the Goodbye tests to assert:

- the current `goodbyeSeats` player has `is-voting-highlight` (the bright votee-selection treatment);
- it does not rely only on the dimmer `is-goodbye-highlight` class;
- all other cards lack `is-voting-highlight`, including a stale retained `bestMove.playerSeat` from an earlier night;
- Best move keeps its deceased owner bright through the following Goodbye speech and loses the highlight only when Day starts.

**Step 2: Run RED**

```bash
npm run test -w @mafia/web -- --run src/features/game/GameScreen.test.tsx
```

Expected before implementation: vote-elimination Goodbye uses only `is-goodbye-highlight`, while the bright class is limited by the current `goodbyeNext === "day"` condition.

**Step 3: Derive one phase-owned bright seat set**

In `GameScreen`, apply `votingHighlight` to:

- `bestMove.playerSeat` during `best-move`;
- seats in `goodbyeSeats` during `goodbye-speech`.

Do not derive Goodbye highlighting from retained `bestMove` data. Keep `goodbyeHighlight` only if another distinct non-bright semantic style still needs it; otherwise remove the duplicate class assignment rather than stacking conflicting visual states.

**Step 4: Run GREEN and inspect the exact classes**

Run the focused test, then inspect the rendered table at the iPad viewport to ensure one and only one current Goodbye speaker has the same bright yellow-fire animation as a selected voter.

---

### Task 6: Verify the whole affected vertical slice

**Objective:** Confirm replay, UI flow, persistence, and production compilation remain consistent.

**Files:**
- Review only: `packages/game-domain/src/game-events.ts`
- Review only: `packages/game-domain/src/game-replay.test.ts`
- Review only: `apps/web/src/App.test.tsx`

**Step 1: Run affected component and domain suites**

```bash
npm run test -w @mafia/game-domain -- --run src/game-replay.test.ts src/night-actions.test.ts src/day-actions.test.ts
npm run test -w @mafia/web -- --run src/App.test.tsx src/features/night/NightStage.test.tsx src/features/game/GameScreen.test.tsx
```

Expected: all selected tests pass.

**Step 2: Run static verification and build**

```bash
npm run typecheck
npm run lint
npm run build
```

Expected: zero type, lint, or build failures.

**Step 3: Run the repository test suite**

```bash
npm run test
```

Expected: all workspace tests pass. Report any pre-existing warning separately; do not treat warnings as proof of this fix.

**Step 4: Review the patch**

```bash
git diff --check
git diff -- packages/game-domain/src/game-events.ts packages/game-domain/src/game-replay.test.ts apps/web/src/App.test.tsx
```

Confirm the patch is limited to canonical phase preparation plus focused regressions, with no generated `dist` files, snapshots, formatting churn, or unrelated refactors.

**Step 5: Rebuild and replay on the running iPad app**

After rebuilding/restarting the existing development app, reproduce:

1. A day with no nominations.
2. Advance through the last speaker into Mafia shots.
3. Assign all active Mafia shooters to one target.
4. Tap **Evaluate Mafia shots**.
5. Verify the Mafia result screen appears, the target is only provisionally marked, and the in-app Console receives no new error.
6. Continue night and verify the result survives reload/replay.

Per the active project workflow, keep changes uncommitted until Michael accepts the fix. Do not commit or push unless explicitly requested.

---

## Files likely to change

- `packages/game-domain/src/game-events.ts`
- `packages/game-domain/src/game-replay.test.ts`
- `apps/web/src/App.test.tsx`
- `apps/web/src/features/game/GameScreen.tsx`
- `apps/web/src/features/game/GameScreen.test.tsx`

No production change is expected in `NightStage.tsx`, `night-actions.ts`, or `App.tsx`; those layers are exposing the canonical replay mismatch correctly. No new CSS should be needed because the Goodbye speaker must reuse the existing bright `is-voting-highlight` treatment.

## Risks and tradeoffs

- **Over-advancing canonical state:** a broad helper could bypass voting or review phases. The nominated-day safety test is mandatory.
- **Fixing only the displayed state:** using `game` instead of `canonicalGameRef` would make the append appear to work but break replay/hash/parent invariants after reload.
- **Persisting extra navigation:** making every final `turn.completed` event meaningful would avoid this symptom but violate the deliberate semantic-checkpoint policy and add noisy timeline/history entries.
- **Weak regression:** a local `NightStage` test cannot reproduce this bug because its canonical and displayed state are the same object. The `App` seam test is required.
- **Legacy compatibility:** the preparation must preserve existing already-at-`night-mafia` replay and legacy hash behavior; focused replay tests plus the full suite cover this.

## Open questions

None required for implementation. The intended policy is already encoded by the current replay design: navigation-only turns remain transient, and the next semantic event must fold them deterministically into its canonical precondition.
