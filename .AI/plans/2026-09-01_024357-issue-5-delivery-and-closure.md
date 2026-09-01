# Issue #5 Delivery and Closure Plan

> **For Hermes:** Execute only after the implementation and documentation plans are complete and focused checks are green.

**Goal:** Deliver the verified issue #5 change to `origin/main`, preserve then retire its temporary plans, publish exact evidence, and close the issue as the final mutation.

**Architecture:** Freeze one integrated local candidate, run the canonical local gate, stage only issue-owned paths, and use direct-main delivery with remote-SHA and tracker readback. Keep the pre-existing unrelated untracked plan out of every commit.

**Tech Stack:** Git, GitHub CLI, npm scripts.

**Non-goals:** Pull request creation; waiting for CI/review; production deployment; closing any issue other than #5; changing labels/milestones on adjacent issues; staging or cleaning `.AI/plans/2026-08-29_134707-reconcile-stale-in-progress-github-issues.md`.

---

### Task 1: Preserve the approved plan bytes before implementation closeout

**Objective:** Ensure Git history can recover the temporary issue #5 plans before repository policy removes them.

**Files:**
- Add only:
  - `.AI/plans/2026-09-01_024357-issue-5-relational-game-schema-plan-set.md`
  - `.AI/plans/2026-09-01_024357-issue-5-normalized-game-persistence.md`
  - `.AI/plans/2026-09-01_024357-issue-5-data-model-and-migration-docs.md`
  - `.AI/plans/2026-09-01_024357-issue-5-delivery-and-closure.md`

**Steps:**
1. At implementation start, re-read issue #5, fetch `origin`, and require local/remote base `ea39d950d4cf5caaafe9fa1b3df21bbfc19a4163` unless a newer remote is reconciled before source edits.
2. Confirm the only pre-existing dirty artifact is the unrelated 2026-08-29 plan.
3. Stage the four named issue #5 plans explicitly; inspect `git diff --cached --name-only` and reject any extra path.
4. Commit without a close keyword: `docs(ai): plan issue 5 relational schema`.
5. Do not push yet; implementation and final checks must follow.

### Task 2: Freeze and verify the integrated candidate

**Objective:** Prove every issue-owned behavior and repository gate on the final source/doc bytes.

**Files:**
- Expected implementation scope:
  - `apps/server/src/schema.sql`
  - `apps/server/src/schema-migration.test.ts`
  - `apps/server/src/game-session-store.ts`
  - `apps/server/src/game-session-store.test.ts`
  - `apps/server/src/app.test.ts`
  - `docs/entity-model.md`
  - `docs/adr/0001-typescript-modular-monolith.md`
  - `docs/self-hosted-deployment.md`

**Steps:**
1. Inspect `git status --short` and `git diff --check`; classify every changed path. Stop on unrelated source changes or remote drift.
2. Run the focused persistence/API matrix:
   - `npm run test -w @mafia/server -- src/schema-migration.test.ts src/game-session-store.test.ts src/app.test.ts`
   - `npm run typecheck -w @mafia/server`
3. Run the repository’s canonical local gate: `npm run check`.
4. Require clean, nonzero test execution and successful format, lint, typecheck, tests, and builds. Do not substitute partial success if the canonical gate fails.
5. Re-run `git diff --check` after any formatter/fix. Any source edit invalidates prior final-gate evidence and requires rerunning the affected focused checks plus `npm run check`.

### Task 3: Commit the scoped implementation and retire fulfilled plans

**Objective:** Keep implementation reviewable while satisfying `.AI/` lifecycle policy.

**Steps:**
1. Stage only the expected source/test/doc paths; verify the staged path list and review the cached diff.
2. Commit without auto-closing syntax: `feat: normalize game persistence projections (#5)`.
3. Delete only the four issue #5 plan-set files after the verified implementation commit exists. Leave the unrelated 2026-08-29 plan untouched.
4. Stage only those four deletions; verify cached paths and commit `docs(ai): retire issue 5 plan`.
5. Confirm the final worktree contains only the pre-existing unrelated untracked plan and that no issue #5 plan remains active.

### Task 4: Push, verify, publish evidence, and close last

**Objective:** Make remote delivery and closure independently verifiable.

**Steps:**
1. Fetch and require `origin/main` still equals the planned base; if not, stop for reconciliation rather than force-push or rebase silently.
2. Push current `main` normally.
3. Read back `git ls-remote origin refs/heads/main` and require exact equality with local `git rev-parse HEAD`.
4. Post one issue #5 comment naming:
   - the resolved #42 one-full-member-data-model decision;
   - relational ruleset/session assignment behavior delivered;
   - migration preservation/idempotence evidence;
   - exact focused commands and observed pass counts;
   - `npm run check` result;
   - verified remote commit SHA.
5. Read back the newest issue comment and compare its body/URL to the intended evidence.
6. Close issue #5 as the final external mutation.
7. Read back issue #5 and require native state `CLOSED`; perform no further tracker mutation.

## Failure policy

- Keep #5 open if focused tests, `npm run check`, push, remote-SHA verification, or evidence readback fails.
- Never force-push, amend published history, stage unrelated work, or manufacture a clean tree with reset/clean/stash.
- No production deployment is authorized by backlog delivery.
