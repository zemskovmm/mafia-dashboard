# Issue #52 Delivery and Closure Plan

> **For Hermes:** Execute this plan only after the implementation plan is approved and complete on one unchanged, locally verified candidate. Tracker closure is the final mutation.

**Goal:** Preserve the approved issue #52 plan pair in history, deliver the exact verified browser-singleton implementation directly to `main`, reconcile the intentionally untracked shared plan index without absorbing it, and close GitHub issue #52 only after remote verification.

**Architecture:** Because the primary `main` checkout contains a shared untracked plan set, perform implementation and commits in an isolated ticket worktree created from a freshly verified `origin/main`. Transport only the two approved issue #52 plans by exact hash into a plan-only commit, preserve that history through a direct non-squashed push, delete the fulfilled plans in the final source commit, then reconcile the primary checkout and shared untracked index. Use a source commit message without `Closes`/`Fixes` so the issue remains open until the evidence comment is verified and the close command runs last.

**Tech Stack:** Git, GitHub CLI, npm workspace checks, SHA-256/file hashing, an isolated Git worktree, and GitHub issue readback.

**Non-goals:** Opening or merging a pull request; waiting for CI or review; deploying; changing issue labels/milestone/Project/assignee; committing the shared backlog index; committing neighboring AI artifacts; amending/rebasing/squashing existing history; stashing/resetting/cleaning the primary checkout; or closing any issue other than #52.

---

## Plain-language summary

After the browser-singleton behavior passes its focused tests and the full repository check, preserve the approved plans in a small history commit, commit the exact implementation while removing those completed plans, push that history directly to `main`, verify GitHub has the same commit, record the local evidence, and close #52 last. The shared untracked backlog index stays local and is updated only to point #52 at the verified delivery commit.

## Preconditions

- Michael approved both `.AI/plans/2026-09-02_142916-browser-local-game-singleton.md` and this closeout plan together in their current bytes.
- GitHub issue #52 is still open with the same title/scope and remains the selected implementation-ready item.
- `npm run test -w @mafia/web -- src/browser-game-storage.test.ts src/session-outbox.test.ts src/App.test.tsx`, `npm run test:verifier-contracts`, `npm run typecheck -w @mafia/web`, and `npm run check` all pass on the same implementation candidate.
- The candidate introduces no server/domain/database/deployment changes and no unrelated working-tree paths.
- The canonical remote `main` still identifies the frozen implementation base before work begins and again before push.
- The primary checkout’s shared index is intentionally untracked; it is not part of the ticket’s durable commit set.

### Task 1: Freeze and isolate the approved ticket plan set

**Objective:** Preserve the dirty primary checkout while making the exact approved plan pair durable before implementation.

**Files:**
- Approved transport: `.AI/plans/2026-09-02_142916-browser-local-game-singleton.md`
- Approved transport: `.AI/plans/2026-09-04_163803-issue-52-delivery-closeout.md`
- Local-only shared index: `.AI/plans/2026-09-02_142916-game-reliability-backlog-plan-set.md`

**Steps:**
1. Re-read `git status --porcelain=v1 -z --untracked-files=all`, local `HEAD`, `origin/main`, the canonical remote SHA, all worktrees, and issue #52. Stop if source work appeared, the remote moved incompatibly, or issue scope/state changed.
2. Record SHA-256 and Git classification for every dirty primary path. Classify only the two named issue #52 plans as authorized transport; classify the shared index as an authorized later one-row local update but not authorized commit.
3. Fetch the canonical remote without changing the primary checkout. Create a temporary `issue-52-browser-game-singleton` branch and isolated worktree from the verified base.
4. Copy only the two approved plan files to the same relative paths in the isolated worktree. Recompute hashes and require exact equality with the approved primary bytes.
5. Stage the two exact paths, assert the staged path set contains exactly those paths, and commit them as `chore(ai): plan issue 52 browser game singleton`.
6. Read both blobs back from the commit and verify their hashes. Confirm the ticket worktree is clean and the primary index remains untracked with its frozen hash.

### Task 2: Freeze the verified implementation candidate

**Objective:** Prove the exact source tree—not just a test narrative—is the one authorized for delivery.

**Files:**
- The scoped files named by the implementation plan and discovered by the exact base-to-candidate diff.
- Delete from final tip: the two approved issue #52 plan files.

**Steps:**
1. Complete the implementation plan in the isolated worktree with strict TDD. Do not copy source changes from or into the dirty primary checkout.
2. Run the focused web test command, verifier-contract suite, web typecheck, and `npm run check` on one unchanged candidate. Save command, exit status, and concise test/build totals for the eventual issue comment.
3. Remove only the two fulfilled issue #52 plan files from the isolated worktree. Do not materialize, stage, or delete the shared plan index there.
4. Stage only scoped source/tests/localization/styles plus the two plan deletions. Assert the exact staged path list and an empty unstaged diff.
5. Inspect the full canonical-base-to-index patch, `git diff --check`, changed-path list, file modes, and candidate tree ID. Confirm the patch satisfies every issue acceptance criterion and contains no unrelated refactor, dependency, generated output, plan index, or hidden game/session data.
6. If any edit occurs after this freeze, invalidate the tree identity, rerun every affected focused test and `npm run check`, and repeat this task before committing.

### Task 3: Commit and verify local history

**Objective:** Create reviewable history whose final tree exactly matches the frozen candidate while retaining the approved plan bytes in its parent.

**Steps:**
1. Commit the frozen implementation and plan deletions as `feat(persistence): enforce one local game per browser (#52)` with no auto-closing keyword.
2. Verify the canonical-base-to-commit patch and final tree exactly equal the frozen patch/tree. Read back changed paths and confirm the issue plans are absent from the tip but present byte-for-byte in the earlier plan commit.
3. Verify the isolated worktree is clean and both local commits descend from the frozen canonical base without amend, rebase, or squash.
4. Re-read issue #52 and confirm it is still open before any push.

### Task 4: Push directly to main and verify the remote

**Objective:** Publish only the exact reviewed history and prove the canonical remote accepted it.

**Steps:**
1. Fetch immediately before push and require canonical `origin/main` still equals the frozen base. If it moved, stop and reconcile/retest rather than force-push.
2. Push the isolated ticket `HEAD` explicitly to `origin/main` with ordinary fast-forward semantics.
3. Fetch/read back the canonical remote and require `refs/remotes/origin/main`, `gh api repos/zemskovmm/mafia-dashboard/commits/main`, and the local ticket `HEAD` to report the exact same commit SHA.
4. Read the remote commit’s parent/history and changed files to confirm the plan-only commit remains reachable and the final tip omits completed plans.
5. If push or readback fails, leave issue #52 open and do not proceed to evidence/closure.

### Task 5: Reconcile the primary checkout and shared local index

**Objective:** Bring local `main` to the verified remote while preserving the intentionally untracked backlog ledger.

**Files:**
- Remove from primary after remote durability is proven: the two completed issue #52 plan files.
- Update locally only: `.AI/plans/2026-09-02_142916-game-reliability-backlog-plan-set.md`

**Steps:**
1. Rehash/reclassify all primary dirty paths and compare them with Task 1. Stop if any unexpected byte or classification changed.
2. Remove only the two completed issue #52 plan copies from the primary checkout; their exact bytes must already be proven reachable from canonical `main` history.
3. Verify the incoming final tree cannot overwrite the retained untracked shared index, then fast-forward local `main` to the verified `origin/main` commit without stash/reset/clean.
4. Update only issue #52’s shared-index status/row from its relative active-plan link to `Delivered in <verified-short-SHA>`. Leave the index untracked; record its new hash and do not claim it is byte-identical to the initial index.
5. Verify local `main`, `origin/main`, and GitHub’s canonical SHA agree; the two completed plans are absent from the working-tree tip; and the only retained dirty state is the expected untracked shared index.

### Task 6: Comment with evidence and close issue #52 last

**Objective:** Make tracker closure depend on verified local and remote evidence.

**Steps:**
1. Post one concise issue comment naming the verified commit SHA and the successful focused web tests, verifier contracts, web typecheck, and `npm run check` results. Do not claim CI, PR review, or deployment.
2. Read back issue #52 comments and verify the exact evidence comment URL/body/author exists once.
3. Close issue #52 as the final external mutation.
4. Perform read-only verification only: read back issue number/title/state/state reason/comments and confirm `state=CLOSED`; list open issues and confirm #52 is absent; confirm canonical remote SHA is unchanged.
5. Remove the clean temporary worktree and local ticket branch only after remote/issue verification, then read back worktrees/branches. Do not alter the remote history.

## Acceptance criteria

- Only the approved issue #52 plan pair enters the plan-only commit; the shared index never enters the ticket history.
- The final source commit exactly matches the focused-tested and `npm run check`-verified candidate and has no auto-closing keyword.
- Completed plan files are absent from the delivered tip but their approved bytes remain reachable from canonical non-squashed history.
- The push is fast-forward only, and GitHub’s readback SHA exactly equals the reviewed local commit.
- The shared index remains untracked and changes only in the issue #52 status/row to reference the verified delivery identity.
- Primary local `main`, `origin/main`, and canonical GitHub `main` end at the same verified SHA; no unrelated primary bytes or classifications are changed.
- One verified evidence comment records local focused and canonical checks without overstating CI/review/deployment.
- Issue #52 stays open through planning, implementation, testing, commit, push, remote verification, and local reconciliation, then closes as the last external mutation.
- No PR, deployment, force-push, history rewrite, stash/reset/clean, label change, or unrelated issue mutation occurs.

## Stop conditions

- Issue #52 scope/state changes, a new higher-priority ready issue appears before implementation begins, or the prerequisite assumptions no longer hold.
- The primary checkout contains source changes or any dirty artifact cannot be frozen/preserved exactly.
- The isolated plan copies differ from approved hashes, or the shared index/sibling classification changes unexpectedly.
- Focused verification, web typecheck, `npm run check`, diff review, or exact-tree comparison fails.
- Canonical `main` moves after freeze, the push is not a fast-forward, or remote SHA/readback differs from the reviewed commit.
- Evidence comment readback fails. In every stop case, keep issue #52 open and report the exact blocker.

## Open questions

None. Michael explicitly approved the repository’s standing direct-main backlog workflow: focused tests plus `npm run check`, no PR/deployment, verified push, evidence, and close-last issue handling.
