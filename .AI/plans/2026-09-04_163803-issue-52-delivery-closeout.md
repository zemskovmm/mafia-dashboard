# Issue #52 Current-Version-Only Feature Branch and Pull Request Closeout Plan

> **For Hermes:** Execute only after Michael approves the entire revised [same-ticket #52 plan set](./2026-09-04_232629-issue-52-current-only-plan-set.md), including its explicitly proposed safety assumptions. Do not merge the pull request, push `main`, deploy, enable auto-merge, or close issue #52.

**Goal:** Publish the approved current-version-only #52 implementation as one exact-reviewed feature-branch PR, leaving merge, deployment and closure for explicit follow-up.

**Architecture:** The existing feature branch contains the original migration-oriented plan-only commit. After the integrated implementation passes exact review, preserve all approved #52 plan files in a plan-only revision commit without changing the reviewed source candidate. Then commit the reviewed implementation with the completed plans absent from the branch tip; push the feature branch and verify the open PR and unchanged `main` by remote readback.

**Tech Stack:** Git, GitHub CLI, npm workspace verification, immutable binary-patch SHA-256/tree checks.

**Non-goals:** Merging; pushing or fast-forwarding `main`; deployment; issue closure; auto-merge; force-push; PR auto-fixes; changing labels/milestone/Project/assignee; committing the shared backlog index or superseded review artifact; stashing/resetting/cleaning the primary or isolated worktree; or retaining obsolete v3/v4 implementation merely to reduce the diff.

---

## Plain-language summary

Once browser persistence, the current game-data contract, database bootstrap and preferences all pass integrated tests and independent review, preserve the approved plans in branch history, commit exactly that reviewed source, and publish it as an unmerged PR. The issue stays open. Removing compatibility is not authorization to upgrade, reset or deploy any environment.

## Preconditions

- Michael has approved every file enumerated by the revised #52 plan-set index and its safety assumptions; earlier browser-only approvals do not apply.
- GitHub issue #52 has been updated and read back with the complete same-ticket current-version-only contract, including browser, game/replay/API, database and preference boundaries.
- Issue #52 remains open with its existing title/labels; no incompatible tracker or remote-main drift exists.
- The isolated worktree remains on `issue-52-browser-game-singleton`, based on the frozen canonical commit, with no unrelated or unstaged source paths.
- All focused domain/server/web tests, real PostgreSQL bootstrap and store tests, browser lifecycle evidence, verifier contracts and `npm run check` pass on one unchanged candidate.
- The integrated independent immutable reviews specified in the index pass for that exact base-to-index patch/tree/digest; no old migration-candidate review is reused.
- The primary checkout remains on `main`; shared artifacts remain untouched. The superseded blocker review is local-only and is not authorized for commit or deletion under this plan.

### Task 1: Preserve the regenerated plan contract

**Objective:** Make the complete approved current-version-only scope and PR boundary durable without changing the reviewed source tree.

**Steps:**
1. Immediately before history mutation, fetch and verify local `main`, `origin/main`, and canonical remote `main`; re-read issue #52 and confirm its complete updated body and open state.
2. Record SHA-256 and Git classification for every plan explicitly enumerated by the #52 index. Separately record protected shared artifacts; do not stage them.
3. Copy only the enumerated approved #52 plan files into the isolated worktree using exact approved primary bytes. Verify every hash; stop rather than overwrite unexpected worktree edits.
4. Create one plan-only revision commit for those exact paths while preserving the staged source candidate. Suggested message: `chore(ai): revise issue 52 for current-only data`. Use explicit path-scoped/index-isolated Git operations; never broad add/reset/stash.
5. Read each committed plan blob back and verify its SHA-256. Confirm the original plan-only commit and this revision commit remain reachable.
6. Remove the completed plan-set files from the isolated worktree and stage their deletions plus the exact reviewed source paths. Require canonical-base-to-index tree and binary-patch SHA-256 to remain the reviewed candidate; plan-history transport must not alter product bytes.

### Task 2: Commit the exact reviewed source

**Objective:** Create one implementation commit whose tree is identical to the passing immutable candidate.

**Steps:**
1. Re-run `git diff --check`, inspect the full staged path set and file modes, and require an empty unstaged diff.
2. Commit as `feat(persistence): enforce current-only data and one browser game (#52)` without an auto-closing keyword.
3. Verify the commit tree equals the reviewed tree and regenerate the canonical-base-to-commit binary patch; require its SHA-256 to equal the reviewed patch.
4. Verify the final tree contains no completed #52 plan files, shared artifacts, dependency/deployment-workflow changes, v3/v4 browser support, historical data adapters, or game-state sessionStorage access. Server/domain/database changes must match the approved companion plans, not be excluded from review.
5. Require the isolated worktree to be clean.

### Task 3: Push the feature branch

**Objective:** Publish only the reviewed feature branch without changing `main`.

**Steps:**
1. Fetch immediately before push and require canonical `origin/main` still equals the frozen base. Stop and replan on drift; do not rebase or force-push implicitly.
2. Verify no incompatible remote `issue-52-browser-game-singleton` branch or PR already exists.
3. Push the local feature branch with ordinary non-force semantics and set its upstream.
4. Fetch/read back the remote branch and require remote SHA, local implementation commit, reviewed commit/tree, and GitHub's commit object to match exactly.
5. Confirm remote `main` remains unchanged and no deployment workflow was triggered by the feature-branch push.

### Task 4: Open and verify the pull request

**Objective:** Put the reviewed complete #52 change into human review without authorizing merge or deployment.

**Steps:**
1. Open one PR from `issue-52-browser-game-singleton` to `main` titled from issue #52.
2. Summarize the global v5 contract, strict invalid-v5 recovery, all removed compatibility surfaces, fresh/current-schema prerequisite, preserved safeguards and exact local verification results. Explicitly state that existing historical data is unsupported and no migration/reset/deployment was performed.
3. Link with `Refs #52`, not an auto-closing keyword. State that the PR is intentionally unmerged: merging to `main` triggers production deployment and is not authorized. Issue closure remains an explicit later decision.
4. Read the PR back and verify it is open, non-draft unless explicitly requested otherwise, targets `main`, has the exact reviewed head SHA, contains the verification/issue linkage, and has no auto-merge request.
5. Read the initial PR check state. A queued/running check is reportable; a completed failure blocks further mutation and must be reported without auto-fixing under this plan.
6. Read workflow runs for the exact head SHA and verify no production deployment run was triggered.

### Task 5: Reconcile local planning state and stop at review

**Objective:** Leave the repository and tracker in an honest in-review state.

**Steps:**
1. Record the verified PR URL/head and delivery state in the final response. Do not mutate unrelated/shared backlog files or reviews.
2. Only after exact plan-history transport and all local criteria succeed, remove the completed #52 plan files enumerated by the index from the primary checkout if their hashes still match the approved bytes. Changed/shared artifacts must be preserved; Git history is the archive of successful plans.
3. Rehash/reclassify protected primary artifacts and require them unchanged. Keep local `main` at unchanged canonical `main`.
4. Keep the isolated worktree and branch available for PR follow-up; do not remove them or other agents' state as incidental cleanup.
5. Remove only owned temporary patches/body files and stop only test infrastructure started for this execution. Never remove an existing database volume or unrelated container.
6. Final remote readback must show: PR open, issue #52 open, remote feature branch at the reviewed SHA, `main` unchanged, no auto-merge, and no production deployment for the feature head.

## Acceptance criteria

- The updated issue body, approved plan-set revision, final implementation, and PR all describe the complete same-ticket current-version-only contract.
- The final implementation commit exactly matches the focused-tested, full-check, and independently reviewed candidate.
- Original and revised plan commits remain reachable while completed #52 plans are absent from the feature-branch tip.
- No shared index or superseded review artifact enters ticket history.
- The feature branch is pushed without force and its remote SHA/tree equal the reviewed local commit.
- The PR is open against `main`, linked with `Refs #52` without automatic closure, and contains accurate local evidence and the explicit unsupported-historical-data warning.
- Issue #52 remains open; `main` remains unchanged; no merge, deployment, auto-merge, issue closure, force-push, label change, or unrelated mutation occurs.
- Primary protected artifacts remain byte-identical; completed ticket-plan removal occurs only after verified Git-history preservation, with no other primary edits.

## Stop conditions

- The issue body cannot be reconciled exactly or issue #52 no longer remains the selected open item.
- Any unclassified source/plan/index drift appears in either checkout.
- Focused verification, typecheck, `npm run check`, static legacy-absence audit, diff check, or immutable review fails.
- Any source edit occurs after candidate freeze without a full affected verification and new patch/tree/digest review.
- Canonical `main` moves incompatibly before push, the remote feature branch/PR conflicts, or any remote readback differs from the reviewed commit.
- Publishing the branch or PR would change `main`, trigger production deployment, or require force/auto-merge.

## Open questions

Approval of the entire revised plan set is outstanding. The index labels the unanswered current-schema/non-destructive assumptions explicitly. No clarification timeout or earlier narrower approval counts as authorization.
