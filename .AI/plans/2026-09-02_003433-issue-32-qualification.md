# Issue 32 Immutable-Candidate Qualification Plan

> **For Hermes:** Execute this plan task-by-task after explicit approval. Use an independent review subagent for the frozen candidate. Stop and return to plan mode if any product defect or material scope change appears.

**Goal:** Prove that one unchanged, immutable Git tree satisfies every local closure criterion of GitHub issue #32.

**Architecture:** Preserve the approved plans in Git history, then stage only their lifecycle deletion and freeze the resulting index as a Git tree object. Export that tree to a disposable clean room so ignored files, local dependencies, and the unrelated untracked plan cannot influence results. Exercise focused replay/persistence tests, the full repository gate, PostgreSQL 17 migration and legacy-hydration paths, production Compose, Playwright UI checks, and authenticated session restart/cleanup against disposable infrastructure; submit the same tree to independent review.

**Tech Stack:** Git, npm workspaces, Node.js 22, Vitest, PostgreSQL 17, Docker/Compose, Playwright Chromium/WebKit, Fastify/React, Hermes subagent review.

**Plain-language summary:** We will archive the approved plan, freeze the current code as an exact Git tree, test that tree from a clean directory with disposable databases and browsers, and obtain an independent approval without editing product code.

**Non-goals:** Fixing defects found during qualification; adding tests merely to create a diff; changing application code, schema, scripts, docs, dependencies, or workflows; testing production; modifying or deleting `.AI/plans/2026-08-29_134707-reconcile-stale-in-progress-github-issues.md`; closing or commenting on #32.

---

### Task 1: Reconcile the approved starting state

**Objective:** Ensure the plan starts from the intended branch, issue, and remote revision without disturbing unrelated work.

**Files:**
- Read only: repository and GitHub state
- Preserve unchanged: `.AI/plans/2026-08-29_134707-reconcile-stale-in-progress-github-issues.md`

**Steps:**
1. Run `git status --short --branch`, `git branch --show-current`, `git fetch origin`, and compare `git rev-parse HEAD` with `git rev-parse origin/main`.
2. Require branch `main`, no tracked worktree changes, and no divergence from `origin/main`. Treat the existing unrelated untracked plan as preserved user state, not candidate content.
3. Read back `gh issue view 32 --json number,title,state,labels,body,comments,url` and require `OPEN` with children #33–#37 still closed.
4. If branch, remote, issue, or child state changed materially, stop and return to planning rather than reconciling silently.

**Expected result:** A synchronized `main` and still-valid verification-only issue boundary.

### Task 2: Preserve the approved plan set in Git history

**Objective:** Make the approved execution contract recoverable before qualification begins.

**Files:**
- Add exactly: `.AI/plans/2026-09-02_003432-issue-32-plan-set.md`
- Add exactly: `.AI/plans/2026-09-02_003433-issue-32-qualification.md`
- Add exactly: `.AI/plans/2026-09-02_003434-issue-32-delivery.md`

**Steps:**
1. Stage only the three exact paths above; do not use broad `git add`.
2. Inspect `git diff --cached --name-status` and reject any additional path.
3. Commit with `docs(ai): plan issue 32 immutable qualification`.
4. Confirm the unrelated untracked plan is still present and unmodified.

**Expected result:** One plan-only commit, with no source or unrelated artifact included.

### Task 3: Freeze the product candidate and create a clean room

**Objective:** Produce the one immutable tree used by every remaining gate and by independent review.

**Files:**
- Delete from the candidate exactly the three issue-32 plan files listed in Task 2, per repository plan-lifecycle policy
- Create runtime artifacts only beneath `/tmp`

**Steps:**
1. Remove only the three issue-32 plan files and stage their deletions with exact pathspecs.
2. Inspect `git diff --cached --name-status`; require exactly three deletions and no product changes.
3. Capture `candidate_tree=$(git write-tree)` and retain it with the evidence log.
4. Export that tree, not the working directory, into a new `/tmp/mafia-dashboard-issue-32.*` directory using `git archive "$candidate_tree"`.
5. In the clean room run `npm run ci:install`; require a lockfile-only installation and successful esbuild rebuild.
6. Record `git rev-parse HEAD`, the plan commit SHA, the candidate tree SHA, clean-room path, Node/npm versions, and Docker version. Do not record credentials or the ephemeral session token.

**Expected result:** A dependency-clean export whose contents are exactly identified by `candidate_tree`.

### Task 4: Run focused replay, persistence, migration, and verifier coverage

**Objective:** Requalify the defects owned by completed children #33–#37 against real PostgreSQL 17 where required.

**Files:**
- Test only: `packages/game-domain/src/game-replay.test.ts`
- Test only: `packages/game-domain/src/night-actions.test.ts`
- Test only: `apps/web/src/session-outbox.test.ts`
- Test only: `apps/web/src/session-retry.test.ts`
- Test only: `apps/web/src/App.test.tsx`
- Test only: `apps/server/src/schema-migration.test.ts`
- Test only: `apps/server/src/game-session-store.test.ts`
- Test only: `apps/server/src/game-session-validation.test.ts`
- Test only: `scripts/session-verifier-contracts.test.mjs`

**Steps:**
1. Start a disposable `postgres:17-alpine` container with a unique name, automatic local port, test-only credentials, and database `mafia_test`; wait on `pg_isready` and export its URL as `TEST_DATABASE_URL`.
2. From the clean room run:
   - `npm run test -w @mafia/game-domain -- src/game-replay.test.ts src/night-actions.test.ts`
   - `npm run test -w @mafia/web -- src/session-outbox.test.ts src/session-retry.test.ts src/App.test.tsx`
   - `npm run test -w @mafia/server -- src/schema-migration.test.ts src/game-session-store.test.ts src/game-session-validation.test.ts`
   - `npm run test:verifier-contracts`
3. Require the PostgreSQL-backed schema suite to prove fresh and populated migrations, replay-metadata backfill/bounds, idempotence, and legacy session hydration; require the web/domain suites to prove canonical replay, outbox/restore convergence, legacy envelope normalization, supported Best Move/check behavior, and lifecycle variants.
4. Capture actual test-file/test-case totals from command output programmatically; do not estimate them.

**Expected result:** All focused suites pass on the frozen clean-room tree with live PostgreSQL 17.

### Task 5: Run the canonical clean-room gate and production Compose probe

**Objective:** Qualify the full repository and production container topology from the same clean-room tree.

**Files:**
- Read/execute: `package.json`
- Read/execute: `scripts/verify-production-compose.mjs`
- Read/execute: `compose.yaml`

**Steps:**
1. With the disposable PostgreSQL container still healthy and `TEST_DATABASE_URL` exported, run `npm run check` from the clean room.
2. Require audit, formatting, lint, typecheck, all tests, and all workspace builds to pass.
3. Run `npm run verify:compose` serially; require image build, one-shot migration, app readiness, persisted probe-game survival across app recreation, and verifier-owned cleanup to pass.
4. If either command changes tracked clean-room content, fail qualification and investigate before proceeding.

**Expected result:** The repository's canonical gate and production Compose verification pass from a fresh lockfile install.

### Task 6: Run UI and authenticated restart/cleanup verification

**Objective:** Exercise browser behavior and the authenticated session verifier against a disposable local application stack.

**Files:**
- Execute: `scripts/verify-ui.mjs`
- Execute: `scripts/verify-ui-hardening.mjs`
- Execute: `scripts/verify-session-state.mjs`
- Execute: `compose.yaml`

**Steps:**
1. In the clean room launch `compose.yaml` under a unique Compose project with a unique localhost port, disposable PostgreSQL volume, test-only database password, `PUBLIC_APP_URL` matching that port, and non-secret placeholder Google client values so application-session authentication is enabled.
2. Generate an ephemeral random application-session token without printing it; SHA-256 hash it and insert only the hash into `user_sessions` for the schema-seeded owner and default club. Never use a real Google account, cookie, or deployment.
3. Run against the local stack:
   - `APP_URL=<local-url> npm run verify:ui`
   - `APP_URL=<local-url> npm run verify:ui-hardening`
   - `APP_URL=<local-url> SESSION_AUTH_COOKIE="mafia_session=<ephemeral-token>" SESSION_CLUB_ID="00000000-0000-4000-8000-000000000101" npm run verify:session`
4. Require Chromium and WebKit UI matrices to pass, and require the authenticated verifier to complete browser restart, canonical restore, mutation/cleanup, and ownership checks.
5. Query the verifier-owned game/player identifiers after completion and require no owned test records remain.
6. In a `finally`-style cleanup, run Compose down with volumes/orphans, stop the focused-test PostgreSQL container, remove the clean-room directory, and verify no issue-32 containers or volumes remain.

**Expected result:** Browser and authenticated restart/cleanup checks pass without persistent test data or infrastructure.

### Task 7: Obtain independent approval of the exact candidate

**Objective:** Have a separate reviewer assess the same immutable tree and evidence before delivery.

**Files:**
- Review read-only: the clean-room archive or a fresh export of `candidate_tree`
- Review evidence: captured outputs from Tasks 4–6

**Steps:**
1. If the prior clean room was removed, export `candidate_tree` again to a new read-only review directory and install nothing unless the reviewer needs a focused command.
2. Delegate an independent review with issue #32's body, the exact tree SHA, child-issue closure context, and qualification results. Require review of club isolation, secret-event handling, canonical replay, idempotent persistence, migration convergence, verifier ownership/cleanup, and false-pass risks.
3. Require a structured verdict with findings by severity and explicit `approve`/`block` status tied to the tree SHA.
4. If any blocker/high-severity defect or unverified acceptance criterion remains, do not edit under this plan. Preserve evidence, return to clarification/plan mode, and route the defect to the appropriate child/follow-up issue.
5. If approved, confirm `git write-tree` still equals `candidate_tree` and `git diff --cached --name-status` still contains only the three planned deletions.

**Expected result:** An independent approval names the exact unchanged candidate tree and no unresolved blocker remains.

## Qualification acceptance criteria

- All focused suites and `npm run check` pass from a clean export of one frozen tree.
- PostgreSQL migration/legacy hydration, production Compose, UI matrix, and authenticated restart/cleanup checks pass.
- Test data, containers, volumes, and temporary directories are cleaned up and verified absent.
- An independent reviewer approves the exact tree SHA with no blocker/high finding.
- The primary index still writes the same `candidate_tree`; only the issue-32 plan deletions are staged.
- No application, test, docs, dependency, workflow, or deployment file is changed.

## Risks and stop conditions

- Docker, PostgreSQL, Chrome, or WebKit unavailability is a blocker, not a reason to weaken the matrix.
- A flaky or false-passing verifier must be treated as a defect and returned to plan mode.
- Any change required to pass a gate invalidates the frozen tree and this qualification; create an approved focused plan before editing.
- Never expose the ephemeral session token in logs, issue comments, commits, or files.
