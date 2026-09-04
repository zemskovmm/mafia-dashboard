# Issue #51 Delivery and Closure Plan

> **For Hermes:** Execute only after the issue #51 implementation plan is approved and all implementation acceptance criteria are verified.

**Goal:** Deliver the verified issue #51 change to `origin/main` with an auditable plan checkpoint, verify the exact remote commit, and close the GitHub issue with truthful local evidence.

**Architecture:** Preserve the issue-specific implementation and closeout plans in a local plan-only commit before code changes, then remove them after successful verification in the final scoped implementation commit so Git retains their rationale without leaving completed plans active. Push both commits directly to `main`, verify the remote SHA and clean issue-scoped state, then comment and close #51 and read the issue back.

**Tech Stack:** Git, GitHub CLI, npm workspace checks, GitHub issue #51.

**Non-goals:** Opening a pull request; waiting for CI or review; committing the pre-existing shared backlog plan-set index or #52 plan; changing issue labels/milestones/assignees; closing #52; deploying; repairing unrelated checks or working-tree changes.

---

## Plain-language summary

After the back-navigation behavior passes its focused tests and the complete repository gate, record exactly what was planned and implemented, push it to `main`, verify GitHub has the exact commit, and close only issue #51 with the real test results.

## Preconditions

- Michael has explicitly approved both issue #51 plan files.
- `main` still targets `origin/main`, and no unexpected local or remote work has appeared.
- The implementation plan’s acceptance criteria and focused tests pass.
- `npm run check` passes in full.
- The only intended source changes are issue #51 files; the shared `2026-09-02_142916-game-reliability-backlog-plan-set.md` and `2026-09-02_142916-browser-local-game-singleton.md` remain unstaged.

## Acceptance criteria

- The issue-specific implementation and closeout plans exist in Git history before implementation begins.
- The final source diff is limited to issue #51 and includes focused regression coverage.
- Completed issue #51 plans are removed from `.AI/plans/` only after verification succeeds.
- Both local commits are pushed to `origin/main` without a force push.
- The verified remote `main` SHA equals the local delivery SHA.
- Issue #51 receives a factual completion comment containing the delivery SHA and actual focused/full verification results, is closed, and is read back as `CLOSED`.
- Issue #52 and its plan remain untouched.

### Task 1: Create the plan checkpoint before implementation

**Objective:** Preserve the approved rationale without staging unrelated backlog artifacts.

**Files:**
- Add exactly: `.AI/plans/2026-09-02_142916-role-giveaway-back-navigation.md`
- Add exactly: `.AI/plans/2026-09-04_155114-issue-51-delivery-closeout.md`
- Exclude: `.AI/plans/2026-09-02_142916-game-reliability-backlog-plan-set.md`
- Exclude: `.AI/plans/2026-09-02_142916-browser-local-game-singleton.md`

**Steps:**
1. Run `git branch --show-current`, `git status --short --untracked-files=all`, `git rev-parse HEAD`, and `git rev-parse origin/main`; stop and return to clarification/plan mode if branch, remote parity, or working-tree scope materially changed.
2. Stage the two approved issue #51 plan paths explicitly; never use `git add .` or a directory-level add.
3. Inspect `git diff --cached --check`, `git diff --cached --stat`, and `git diff --cached --name-only`; expect exactly the two issue #51 plan files.
4. Commit with `git commit -m "chore(ai): plan issue 51 back-navigation"`.
5. Record the plan commit SHA locally; do not push yet and do not start source edits before this checkpoint exists.

### Task 2: Reconfirm final local verification and scope

**Objective:** Ensure the artifact being delivered is exactly the approved, tested issue change.

**Files:**
- Inspect all issue #51 source/test changes from the implementation plan.

**Steps:**
1. Confirm the focused SetupWizard/App command and `npm run check` both passed after the final edit; if any edit followed either run, rerun the affected focused command and then `npm run check`.
2. Run `git diff --check`, `git diff --stat`, `git diff --name-only`, and `git status --short --untracked-files=all`.
3. Review the exact diff for secret-role leakage, duplicate game/session creation, accidental API/domain changes, generated artifacts, and unrelated formatting.
4. Remove only the two completed issue #51 plan files. Keep the shared plan-set index and #52 plan present and unstaged.
5. Stage the intended source/test changes and the two plan deletions by exact path.
6. Inspect `git diff --cached --check`, `git diff --cached --stat`, `git diff --cached --name-status`, and `git status --short --untracked-files=all`. Stop if the index contains anything outside issue #51.

### Task 3: Commit and push the implementation

**Objective:** Publish the exact verified code and plan cleanup to the current main branch.

**Files:**
- Commit only the verified issue #51 source/tests plus deletion of the two completed issue-specific plans.

**Steps:**
1. Commit with `git commit -m "feat(setup): preserve role draw across back navigation (#51)"`.
2. Record `git rev-parse HEAD` as the delivery SHA and inspect `git show --stat --oneline --decorate HEAD`.
3. Immediately before pushing, query `git ls-remote origin refs/heads/main` and compare it with the pre-implementation `origin/main` baseline. If remote `main` advanced, do not push; reconcile through a new clarification/plan checkpoint.
4. Push with `git push origin main`; never force push.
5. Verify `git ls-remote origin refs/heads/main` equals the recorded delivery SHA. Also verify `git rev-parse HEAD`, `git rev-parse origin/main`, and the remote SHA agree.
6. Run `git status --short --branch --untracked-files=all`; expect branch parity and only the two known unrelated untracked plan-set/#52 files.

### Task 4: Comment, close, and verify GitHub issue #51

**Objective:** Close the selected issue only after immutable delivery is proven.

**Files:**
- External target: `https://github.com/zemskovmm/mafia-dashboard/issues/51`

**Steps:**
1. Read issue #51 immediately before mutation with `gh issue view 51 --json number,title,state,url`; require `OPEN` and the exact title.
2. Add one completion comment containing the full delivery SHA, a concise behavior summary, the actual focused-test result, and the actual `npm run check` result. Do not invent counts; copy them from tool output.
3. Close with `gh issue close 51`.
4. Read back `gh issue view 51 --json number,title,state,closedAt,comments,url` and programmatically verify `state === "CLOSED"`, `closedAt` is non-null, and the new comment contains the exact delivery SHA and verification evidence.
5. Confirm issue #52 remains `OPEN` and unchanged with `gh issue view 52 --json number,title,state,updatedAt,url`.

## Rollback and blockers

- If a focused test or `npm run check` fails, do not commit, push, or close; fix only an issue-scoped root cause, otherwise report the blocker.
- If remote `main` advances, do not force or blindly rebase a verified artifact. Return to plan/clarification mode for reconciliation.
- If push succeeds but issue mutation fails, keep the delivered commit and retry only the comment/close/readback sequence with the same verified SHA.
- If close succeeds but readback is inconsistent, treat state as unverified and query again before reporting completion.
- Do not delete or stage the sibling #52/shared backlog plans while cleaning up issue #51 plans.
