# Deliver and close GitHub issue #49

> **For implementing agent:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan.

## Goal

Durably deliver the separately approved issue-#49 implementation to `origin/main`, record verifiable evidence, and close the GitHub issue last without absorbing adjacent untracked plans.

## Brief summary of upcoming changes

After the volume fix passes focused tests and `npm run check`, preserve the approved plan set in Git history, commit only issue-#49 code and plan cleanup, push `main`, verify the remote SHA, post the exact local evidence, and close #49 as the final mutation.

## Preconditions

- The sibling implementation plan `.AI/plans/2026-09-02_142916-music-playback-volume.md` is explicitly approved and implemented without material scope drift.
- `npm test -w @mafia/web -- YouTubePlaylistPlayer.test.tsx` and `npm run check` pass on one unchanged candidate tree.
- GitHub issue #49 remains open with the same acceptance contract and no live writer, linked PR, or competing branch.
- `origin/main` has not moved incompatibly from the approved baseline `fc25472`. Any concurrent drift requires read-only reconciliation before continuing; do not force-push, overwrite, or silently broaden scope.

## Delivery boundaries

- Delivery is direct to the current `main` branch under the repository’s explicit backlog-execution rule; no PR, deployment, or wait for remote CI/review is required.
- Use multiple narrow commits so the previously untracked plans are genuinely recoverable from Git history before repository policy removes the completed copies.
- Do not use `Fixes #49`, `Closes #49`, or another auto-closing keyword. The issue must close only after the pushed commit and evidence comment are remotely verified.
- Never stage the adjacent #51 or #52 plans. The backlog index may receive only the final issue-#49 status/link update described below and otherwise remains byte-for-byte intact.

## Frozen planning baseline

At 2026-09-04 15:31 CEST, `main == origin/main == fc25472` and the only dirty paths were these untracked files:

- `.AI/plans/2026-09-02_142916-browser-local-game-singleton.md` — SHA-256 `aa190c24164a2f785aa7a311e185078e6940620afd93be4ecc35ce361528b6df`
- `.AI/plans/2026-09-02_142916-game-reliability-backlog-plan-set.md` — SHA-256 `753ecf93b84e916b8305afa49aaace3205d1546c8885bf7a2c1ccc6e483b8e8a` before the authorized #49 status update
- `.AI/plans/2026-09-02_142916-music-playback-volume.md` — selected plan, revised in this planning turn
- `.AI/plans/2026-09-02_142916-role-giveaway-back-navigation.md` — SHA-256 `fb4c2f7764dd16f6d3913014904c92435e39dce2590bc2bea5e9324b3d12512b`

This closeout plan is the only additional path created by the planning turn.

## Closeout tasks

### Task 1: Preserve the approved issue-#49 plan set before source edits

1. Re-read the exact Git status, local/remote SHAs, and live issue/PR/branch activity after approval.
2. Stage exactly:
   - `.AI/plans/2026-09-02_142916-music-playback-volume.md`
   - `.AI/plans/2026-09-04_153150-issue-49-delivery-closeout.md`
3. Assert that the staged file list contains only those two paths, then commit them as `chore(ai): preserve issue 49 plan set`.
4. Read the commit tree back and verify both plan blobs are present. Confirm the backlog index, #51 plan, and #52 plan remain untracked and unstaged.

### Task 2: Freeze and commit the verified implementation

1. Complete the sibling implementation plan and its tests first.
2. Re-run the focused test and `npm run check` on the final code.
3. Review `git diff --check`, the exact changed-path list, and the source/test diff against #49’s acceptance criteria.
4. Remove the two completed issue-#49 plan files only after verification; their bytes must remain reachable through the plan-preservation commit.
5. Stage exactly the two scoped music source/test files and the two plan deletions. Assert no adjacent plan is staged.
6. Commit as `fix(music): normalize playback volume (#49)` and verify the commit tree/diff contains no unrelated path.

### Task 3: Reconcile the local active-plan index without absorbing it

1. Update only the #49 status and row in the untracked backlog index to record the delivered implementation commit and remove its link to the deleted implementation plan.
2. Leave the index untracked; do not bundle #51/#52 planning artifacts into issue #49 delivery.
3. Recompute and record the index hash, and verify the #51 and #52 plan hashes still match the frozen baseline.

### Task 4: Push and prove the remote candidate

1. Fetch `origin` immediately before push and require remote `main` to be the expected ancestor. Stop rather than force or overwrite if it diverged.
2. Push the current `main` branch.
3. Verify `git ls-remote origin refs/heads/main` exactly equals local `HEAD` and verify the two intended commits are ancestors of that remote SHA.
4. Re-read local status: only the expected untracked backlog index, #51 plan, and #52 plan may remain.

### Task 5: Comment with evidence, then close last

1. Post one issue comment naming the delivered remote SHA, the focused command/result, `npm run check` result, and a concise acceptance summary.
2. Read the issue back and verify the exact comment exists once.
3. Confirm issue #49 is still open, then close it with state reason `completed` as the final external mutation.
4. Perform read-only verification that #49 is closed as completed and that the verified comment and remote SHA remain present.

## Acceptance criteria

- The approved plan bytes are recoverable from a verified plan-preservation commit before deletion.
- The implementation commit contains only the two scoped source/test files and the two completed plan deletions.
- The #51 and #52 plans retain their frozen hashes and remain unstaged/untracked.
- Focused tests and `npm run check` pass on the exact committed implementation tree.
- Remote `main` equals the reviewed local SHA after push.
- The issue evidence comment is verified by readback and #49 closes only afterward with reason `completed`.
- No PR, deployment, force-push, adjacent issue mutation, or unrelated artifact commit occurs.

## Approval boundary

This plan authorizes delivery actions only after both plans receive explicit approval and the implementation acceptance criteria pass. Any material issue-contract change, overlapping delivery, failing gate that demands broader work, or incompatible remote drift returns to clarification and planning.
