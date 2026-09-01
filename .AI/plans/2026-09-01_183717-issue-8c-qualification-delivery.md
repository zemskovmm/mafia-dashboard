# Issue #8C — State-Machine Qualification and Delivery

> **For Hermes:** Execute only after #8A and #8B are implemented and focused tests pass.

**Goal:** Prove the full revised #8 acceptance contract against the current fixed Club Mafia baseline, correct stale rules documentation, and deliver/close the issue with verified local and remote evidence.

**Architecture:** Treat existing setup/day/voting/night/discipline tests as the detailed behavior source. Add one acceptance-level state-machine matrix only for cross-cutting proof that scattered suites do not provide: phase reachability, rule snapshot immutability, structured rejection/non-mutation, both victory paths, exceptional terminals, and direct-vs-replay projection parity. Do not duplicate every rule permutation or redesign working code merely to manufacture a new abstraction.

**Non-goals:** New gameplay UI; alternate rulesets; generic overrides/corrections; draw/cancel result rows; analytics/export; responsive/accessibility work from #20; replay/outbox work from #32; production deployment; PR/CI/review.

## Revised #8 acceptance mapping

| Issue requirement | Qualification source |
| --- | --- |
| Snapshot resolved rule values at game start | Existing `createGame(..., { bestMoveEnabled })` primitive copy plus new mutation-isolation regression; fixed rules have no external template reference. |
| Every normal transition test | Existing focused suites plus one explicit phase/action matrix. |
| Red wins with no active Mafia | Existing `evaluateVictory` and end-to-end transition regression. |
| Black wins at parity | Existing `evaluateVictory` and end-to-end transition regression. |
| Draw/cancelled states | #8A direct action, event, persistence-boundary, and replay tests. |
| Explained moderator override | Owner-revised scope: reasoned `game.drawn`/`game.cancelled` terminal rulings only; no generic `game.corrected` event per #15/#16 decisions. |
| Structured errors/no partial writes | #8B `GameRuleError` and immutable rejected-action tests. |
| Event replay equals stored projection | Existing hash/replay suite extended with the acceptance matrix and #8A terminals. |
| Versioning | Existing canonical `replayVersion: 1`; no second replay/rules format is invented without a real migration requirement. |

## Task 1: Add the acceptance-level state-machine matrix

**Files:**
- Create: `packages/game-domain/src/game-state-machine.test.ts`
- Modify production files only if a new acceptance test proves a real defect

**Steps:**
1. Build one deterministic completed setup fixture using existing setup helpers; do not copy a second role engine into the test.
2. Table-test each `GamePhase` and its intended canonical advancing action, including voting tie branches, goodbye/Best Move, night private phases, finished, draw, and cancelled.
3. Prove at least one full red-victory path and one full black-parity path through domain actions rather than direct state patching.
4. Prove three no-elimination cycles suggest a draw while gameplay continues until `confirmDraw`; prove cancellation remains an explicit reasoned action.
5. Prove the `bestMoveEnabled` value is copied at game creation: mutate/reuse the caller’s options object after creation and verify active and replayed game behavior does not change.
6. For each representative illegal transition, assert the expected stable `GameRuleError.code` and deep equality of the original state.
7. Create canonical entries for the same representative transitions, replay from `InitialGameBaseline`, and assert each frame’s `after` projection equals the direct domain result and final replay projection.
8. Include a legacy-compatible baseline lacking the new cycle fields and prove replay/hash checks continue to work without rewriting the baseline.
9. Avoid asserting source shape or absence. Tests should prove behavior and canonical parity.
10. Run `npm test -w @mafia/game-domain -- src/game-state-machine.test.ts src/game-replay.test.ts`.

## Task 2: Align maintained rules documentation with delivered owner decisions

**Files:**
- Modify: `rules.md`

**Steps:**
1. Update the status/header and the Best Move sections that still say configuration is not implemented; record that the one settled toggle is snapshotted into each game.
2. Describe the exact no-elimination-cycle boundary and three-cycle draw suggestion, explicit confirmation, and reasoned draw/cancellation events.
3. Reconcile the old generic explained-override language with the #15/#16 owner decisions: Undo/Timeline Reset remain ordinary correction; #8 adds only reasoned exceptional terminal rulings; no arbitrary state-replacement event exists.
4. Preserve fixed 10-player role distribution, current victory thresholds, and all already-delivered day/voting/night behavior.
5. Do not document #17 result/history/export behavior as delivered.

## Task 3: Run focused and full verification

**Steps:**
1. Run focused domain tests for setup, game/state matrix, day actions, voting, night actions, and replay.
2. Run focused server validation tests.
3. Run focused web GameScreen/timeline/localization tests.
4. Run `npm run check` from the repository root.
5. Run `git diff --check` and inspect `git status --short`, the scoped diff, and changed-file list. Confirm no schema migration, result persistence, generic correction event, alternate ruleset selector, deployment, or unrelated UI work entered the diff.
6. If `npm run check` rewrites nothing and all gates pass, record exact test totals/commands from real output; do not infer counts.

## Task 4: Deliver and close #8

**Steps:**
1. At implementation start, refresh `main`, issue #8 state/body/comments/labels/`updatedAt`, and its dependency states. Stop on unexplained drift or a new owner decision.
2. Commit only this approved four-file plan set before source implementation so its rationale survives after cleanup. Do not add the unrelated untracked reconciliation plan.
3. After successful verification, remove all four completed issue-8 plan files in the implementation commit per `AGENTS.md`.
4. Commit the scoped implementation and documentation, push `main`, and verify `git ls-remote origin refs/heads/main` equals the local commit SHA.
5. Comment on #8 with:
   - the revised owner-decision scope (fixed rules, no generic correction event);
   - delivered draw/cancel/cycle/error/replay behavior;
   - exact focused commands and `npm run check` result;
   - the verified remote commit SHA.
6. Read back the exact comment, close #8 with state reason `completed`, and read back state, state reason, labels, latest comment, and remote SHA.
7. Re-list open issues to verify #8 is absent and report the next backlog candidate without starting it.

## Final acceptance criteria

- All checklist items in #8 are either demonstrated by current tests/source or delivered by #8A/#8B, with owner-revised exclusions stated in the closure comment.
- `rules.md` describes current behavior and no longer claims the Best Move control is unimplemented.
- Focused tests and `npm run check` pass from real execution.
- Only scoped source/tests/docs and the planned AI-artifact lifecycle appear in commits.
- Local `main`, `origin/main`, and GitHub remote `main` match the implementation SHA.
- #8’s closure comment is verified and the issue is closed/completed.

## Stop conditions

- If issue #8 or any dependency has material remote drift, re-plan before coding or mutating the tracker.
- If the acceptance matrix reveals a missing normal rule whose product decision is not in `rules.md` or closed issue history, stop for clarification rather than inventing it.
- If full verification requires result persistence, migrations, or a completed-game policy for draw/cancel, defer to #17 and do not close #8 until the domain boundary can be independently accepted.
- If implementation materially changes the approved boundaries, return to clarification and plan mode.
