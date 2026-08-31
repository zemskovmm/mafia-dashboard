# Issue #40 Delivery and Closure Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Durably deliver the unchanged, fully verified issue #40 candidate to `origin/main`, verify the remote commit, and close GitHub issue #40 last with read-back evidence.

**Architecture:** Treat delivery as a separate closeout boundary. Preserve approved plan bytes in Git history, retire only the fulfilled issue #40 plans in the final implementation commit, push only after proving the remote base is unchanged, then comment and close the issue with exact readback.

**Tech Stack:** Git, GitHub CLI, npm verification evidence.

**Non-goals:** No source fixes, test edits, rebases, force-pushes, history rewrites, pull request, CI wait, deployment, unrelated issue mutation, or staging/deleting `.AI/plans/2026-08-29_134707-reconcile-stale-in-progress-github-issues.md`.

---

## Preconditions

Do not begin until the implementation plan reports all of the following on one unchanged candidate:

- issue-focused test pass;
- `npm run check` pass;
- exact changed-path and diff review pass;
- no material scope drift;
- local `main` still based on the recorded canonical remote or any concurrent change has been explicitly reconciled.

The user has already authorized the repository’s default direct-`main` backlog workflow. This plan remains gated only by approval of the complete plan set.

## Task 1: Freeze delivery inputs and preserve plan bytes

**Objective:** Bind commits to the approved plan and verified candidate without touching unrelated work.

**Files:**
- Add in planning-history commit:
  - `.AI/plans/2026-08-31_022837-issue-40-plan-set.md`
  - `.AI/plans/2026-08-31_022837-issue-40-01-eliminate-n-plus-one-queries.md`
  - `.AI/plans/2026-08-31_022837-issue-40-02-deliver-and-close.md`
- Preserve untouched:
  - `.AI/plans/2026-08-29_134707-reconcile-stale-in-progress-github-issues.md`

**Step 1: Re-freeze repository and remote state**

Read `git status --short --branch`, local `HEAD`, `git ls-remote origin refs/heads/main`, and the exact diff. Stop on any unexplained change or remote movement; do not pull/rebase/reset over it.

**Step 2: Stage only this issue’s three approved plan files**

Use explicit paths. Inspect `git diff --cached --name-status` and `git diff --cached`; require exactly those three additions.

**Step 3: Commit the plan set**

Commit without an auto-closing keyword, for example:

```bash
git commit -m "docs: plan issue 40 query batching"
```

Read back the commit tree and status. The implementation candidate must remain otherwise unstaged, and the unrelated pre-existing plan must remain untracked.

## Task 2: Create the final implementation commit and retire fulfilled plans

**Objective:** Commit only verified source/tests while making Git history the archive for completed plans.

**Files:**
- Modify: `apps/server/src/game-session-store.ts`
- Modify: `apps/server/src/game-session-store.test.ts`
- Delete:
  - `.AI/plans/2026-08-31_022837-issue-40-plan-set.md`
  - `.AI/plans/2026-08-31_022837-issue-40-01-eliminate-n-plus-one-queries.md`
  - `.AI/plans/2026-08-31_022837-issue-40-02-deliver-and-close.md`

**Step 1: Delete only the fulfilled issue #40 plan set**

Do not delete, archive, stage, or rewrite the unrelated active reconciliation plan.

**Step 2: Stage explicit source/test/deletion paths**

Require the cached path set to contain exactly the two implementation files and three plan deletions. Run `git diff --cached --check` and inspect the full cached diff.

**Step 3: Confirm verification still binds to staged bytes**

Compare staged source bytes to the candidate that passed focused tests and `npm run check`. Any source/test difference invalidates qualification: unstage, rerun affected focused tests plus `npm run check`, and repeat exact-diff review.

**Step 4: Commit without auto-closing syntax**

For example:

```bash
git commit -m "perf: batch session store queries"
```

Read back the commit, parent, changed paths, and worktree status. Expected residual status is only the pre-existing unrelated untracked plan; do not claim a clean worktree.

## Task 3: Push and verify the canonical remote

**Objective:** Publish only if the remote still has the frozen base and prove the exact remote SHA.

**Step 1: Compare canonical remote before push**

Use `git ls-remote origin refs/heads/main`. It must equal the pre-delivery remote base. If it moved, stop for reconciliation rather than force-pushing or silently merging.

**Step 2: Push current `main`**

```bash
git push origin main
```

**Step 3: Verify remote identity**

Read `git ls-remote origin refs/heads/main` again and require it to equal local `HEAD`. Also verify the remote commit contains only the approved two-commit sequence relative to the frozen base.

No PR or CI wait is required by the repository’s authorized backlog workflow; the authoritative gates are the recorded focused local test and `npm run check` on the delivered source bytes.

## Task 4: Post evidence and close issue #40 last

**Objective:** Mutate the tracker only after verified remote delivery.

**Step 1: Re-read issue #40**

Require native state `OPEN` and confirm no concurrent closure or material body/acceptance change. If scope changed, stop and reconcile.

**Step 2: Post one evidence comment**

The comment must name:

- remote implementation commit SHA;
- focused test command and result;
- `npm run check` result;
- bounded listing query behavior, skipped unused supplied-event normalization read, and single bulk projection insert evidence;
- statement that no PR/CI wait was used under the repository’s approved local-only workflow.

Read the comment back and verify its exact issue number, author, body, and URL.

**Step 3: Close as completed**

Close issue #40 with completed state reason. Closure is the final external mutation.

**Step 4: Perform read-only closure verification**

Read issue #40 again and require:

- `state: CLOSED`;
- `stateReason: COMPLETED`;
- evidence comment present;
- referenced remote SHA still equals `origin/main` and local `HEAD`.

## Final report

Report issue URL, selected rationale in one sentence, changed source/test paths, focused and full verification results, both commit SHAs, verified remote SHA, evidence-comment URL, final issue state/reason, and the intentionally preserved unrelated untracked plan. Do not call the worktree clean while that plan remains untracked.
