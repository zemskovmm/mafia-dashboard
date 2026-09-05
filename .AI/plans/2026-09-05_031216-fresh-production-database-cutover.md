# Fresh Production Database Cutover Implementation Plan

> **For Hermes:** Use the test-driven-development and infra-troubleshooting skills to implement this plan task-by-task. Treat every GitHub/Azure mutation as a separately approved live change.

**Goal:** Deploy the current-only #52 release against a new empty production database, verify it, then delete the old `mafia` database. No backup, PITR restore, write freeze, or rollback work is included.

**Architecture:** Keep the PostgreSQL Flexible Server, Container Apps environment, hostname, and runtime credentials. Make the target database name an explicit fail-closed deployment input, create a new empty database on the same server through the existing incremental Bicep deployment, and let the current migration init container bootstrap it. After production acceptance, stop obsolete revisions and delete only the old `mafia` database.

**Tech Stack:** GitHub Actions, Azure OIDC, Azure Container Apps, Azure Database for PostgreSQL Flexible Server 17, Bicep, Bash, Node.js contract tests.

**Non-goals:** No historical schema/data migration, row copying, backup or restore verification, PITR server creation, pre-cutover write freeze, or rollback implementation. No weakening `initializeSchema` checks, Dockerfile change, PostgreSQL server deletion, unrelated pipeline/security changes, or commit/push/live mutation without explicit approval. Existing platform backup retention settings are unchanged; no recovery guarantee is claimed.

## Plain-language summary

The new revision's migration container fails, with the current-only schema gate the high-confidence cause. Point deployment at a brand-new database, verify the new application, and then delete the old database. Old data—including writes made to the old application during cutover—will not be carried forward. There will be no verified backup or planned rollback.

---

## Current evidence and root cause

- The latest failed deployment is [GitHub Actions run 33934952617](https://github.com/zemskovmm/mafia-dashboard/actions/runs/33934952617), commit `273ada4a813060f2ea7fa7121cd2ff6392d3b5c4`. It contains only documentation after merge commit `1d4ad55a6805b4ec8ae8c78b19b02a15551590ed`, so it exercises the same #52 application/schema behavior.
- Image publication, Azure OIDC login, input validation, Bicep validation, foundation deployment, and application resource deployment all succeeded. This rules out the Dockerfile/build, GHCR publication, OIDC, and base infrastructure as the failure point.
- Revision `mafiadashboard-app--0000059`, image digest `sha256:72b57a152c093568dd17282af7d8c922d686e4074608e84fd63dc9bed2eba73e`, reached `ActivationFailed`; its `migrate` init container repeatedly terminated with exit code `1`. Azure left prior revision `--0000057`, digest `sha256:e63c5e80d946c4468925b4682266c955bb977c2b8286963968ac673114b95011`, healthy and running, so the failed rollout did not replace production.
- `infra/main.bicep:35-38` hard-codes database `mafia`, and both the app and migration container receive that database URL. Every new revision therefore opens the existing pre-#52 database.
- PR #55 replaced historical SQL upgrade/repair behavior with strict fresh/current bootstrap. `apps/server/src/initialize-schema.ts` rejects any non-empty catalog that is not exactly current before executing DDL; `apps/server/src/schema-migration.test.ts:533-590` explicitly proves incomplete/old schemas fail without mutation.
- Issue #52 and PR #55 both state that historical installations are unsupported and deployment/reset is a separate decision. The production failure is therefore the intended safety gate, not evidence that the current image needs a compatibility migration.
- The workflow's delayed diagnostics could no longer attach to the exited init-container replica, so the exact stderr line was unavailable. The revision state, init exit code, hard-coded target, deployed schema history, and explicit rejection contract make the root-cause assessment high confidence.
- The immediately preceding #52 merge deployment, run `33932321130`, failed in the same stage with revision `--0000058` and `migrate` exit code `1`, confirming the failure is repeatable rather than transient.
- Local Azure CLI inspection is currently blocked by an expired Conditional Access refresh token. A fresh interactive `az login` is a prerequisite for live preflight, not for the source changes.

## Accepted cutover decision

Michael revised the decision to **skip backup and delete the old database after verification**. No write freeze, PITR server, restore comparison, or old-image/old-database rollback is wanted. “Fresh” means current DDL and seeds only: no production user, club, player, session, game, OAuth token, or preference row is copied. Old-database deletion is conditional on successful production verification and explicit live execution approval; this plan revision alone does not authorize execution.

---

### Task 1: Make the production database target explicit and fail closed

**Objective:** Allow a new-database cutover without silently falling back to `mafia`.

**Files:**
- Modify: `infra/main.bicep:27-38,239-243,374-377`
- Modify: `.github/workflows/deploy-azure.yml:73-218`
- Test: `scripts/security-workflow-contracts.test.mjs:26-87`

**Steps:**

1. Add failing contract assertions that require:
   - `AZURE_DATABASE_NAME` to come from the GitHub `production` environment;
   - strict non-empty PostgreSQL identifier validation before any Azure mutation;
   - an explicit `databaseName="$AZURE_DATABASE_NAME"` parameter in Bicep validation, foundation deployment, and every application deployment;
   - no hard-coded `var databaseName = 'mafia'` fallback;
   - a non-secret `databaseName` Bicep output used in the deployment summary/evidence.
2. Run `npm run test:security-contracts` and confirm the new assertions fail for the missing explicit target.
3. Change `infra/main.bicep` from the hard-coded variable to a required, bounded `databaseName` parameter. Continue constructing the secret connection string inside Bicep; never output the URL/password.
4. Add `AZURE_DATABASE_NAME: ${{ vars.AZURE_DATABASE_NAME }}` to the deploy job, validate a conservative identifier such as `^[a-z][a-z0-9_]{0,62}$`, and pass it to all three Bicep invocations.
5. Expose only the database name as an ARM output/workflow summary field. Keep migration and app containers on the same secret reference.
6. Re-run `npm run test:security-contracts`; it must pass.

**Acceptance:** A missing/invalid database variable fails before resource mutation, every Bicep path receives the same explicit name, and logs contain no connection string or credential.

---

### Task 2: Document the current-only Azure cutover and old-database deletion

**Objective:** Make the operational boundary and recovery sequence unambiguous for future deployments.

**Files:**
- Modify: `docs/azure-deployment.md:14-32,55-72,95-116`


**Steps:**

1. Add `AZURE_DATABASE_NAME` to the required production environment variables and state that it is a deployment identity, not a secret.
2. Document that changing it creates/selects a database on the existing server because ARM deployments are incremental; it does not delete the former database.
3. Add a current-only cutover runbook covering: pause automatic deployments, confirm the exact old and new database targets, set a never-used database name, deploy, validate, stop obsolete revisions, and delete only the old database.
4. State that this cutover deliberately omits backup, restore verification, write freeze, and rollback. Writes accepted by the old application are not migrated. Deletion must never run on failed or incomplete acceptance.
5. State the expected user impact: old sessions become invalid; production users/clubs/players/games/OAuth records do not appear in the fresh database; the hostname and Google callback URL stay unchanged.
6. Explain that existing platform backup settings remain unchanged, without asserting recoverability or introducing a backup/restore task.

**Acceptance:** An operator can identify the intentional data loss, exact deletion target, verification prerequisite, and stop conditions without assuming backup or rollback exists.

---

### Task 3: Qualify the source change before any live mutation

**Objective:** Prove the parameterization preserves the existing deployment/security contract.

**Steps:**

1. Run `npm run test:security-contracts`.
2. Run `az bicep build --file infra/main.bicep`.
3. Run `actionlint .github/workflows/deploy-azure.yml`.
4. Run `npm run check` as the repository-wide gate.
5. Review `git diff --check`, `git status --short`, and the scoped diff; verify only the files named in Tasks 1-2 changed.
6. Stop and present results. Do not commit/push or alter GitHub/Azure yet unless Michael explicitly authorizes those actions.

**Acceptance:** All focused checks and `npm run check` pass on one exact candidate; no secret or deployment state was touched.

---

### Task 4: Prepare the explicit fresh-database target

**Objective:** Prevent an unintended automatic deployment and establish unambiguous old/new database identities without freezing production writes.

**Live-change gate:** Requires explicit execution approval and successful Azure authentication. Stop on missing access or uncertain target identity.

**Steps:**

1. Set and read back `AZURE_DEPLOY_ENABLED=false` before any authorized implementation push. This pauses deployments, not production traffic or writes.
2. After separately authorized commit/push, verify the remote SHA and publication evidence. Bind the eventual deployment to its actual published immutable digest; do not assume rebuilding a SHA gives the same digest.
3. Read back subscription, resource group, PostgreSQL server, app, current revision, and database identity using non-secret projections.
4. Confirm the old database is exactly `mafia`; select a valid never-used target such as `mafia_current_20260905` only after verifying absence. Require old and new names to differ on the explicitly identified server.
5. Do not create a backup/PITR server, compare data manifests, or take the old revision out of service before cutover.

**Acceptance:** Exact server and distinct old/new targets are recorded; automatic deployments are paused; no production write freeze or backup work occurred.

---

### Task 5: Cut over to the fresh database and verify production

**Objective:** Bootstrap the current schema on a new empty database and make the exact qualified image the active production revision.

**Live-change gate:** Requires approved execution of this revised plan and Task 4's target checks. No backup or rollback prerequisite applies.

**Steps:**

1. Set production `AZURE_DATABASE_NAME` to the verified never-used name and read it back. Keep `AZURE_DEPLOY_ENABLED=false` until all preflight values are correct.
2. Enable deployment, read back both variables, then manually dispatch the exact qualified SHA. Avoid an unrelated main push.
3. Verify the workflow:
   - deploys the same published digest;
   - creates the named empty database through incremental Bicep deployment;
   - completes the `migrate` init container once;
   - starts the app container;
   - passes `/health/live`, `/health/ready`, and `/health/version` for the exact SHA.
4. Query Azure revision state and confirm only the new healthy revision serves traffic. Verify the app and init container resolve to the new database without printing the connection string. Do not yet delete `mafia`.
5. Perform fresh-state acceptance at the unchanged production origin:
   - old session is rejected and Google sign-in succeeds afresh;
   - a new club can be created and is visible only to its authenticated club member;
   - no old club/player/game/OAuth data appears;
   - create/save/reload one current-format game, then clean up only verifier-owned data;
   - `/health/version` remains the exact deployed SHA after the checks.
6. If activation or acceptance fails, disable automatic deployments, leave the old database undeleted, report actual service state, and stop for a decision. Do not improvise rollback or delete either database.
7. After all acceptance checks pass, deactivate obsolete revisions and verify that no obsolete revision can serve traffic or restart against an unintended shared database secret. This is post-cutover cleanup, not a pre-cutover write freeze.
8. Immediately before deletion, re-read the exact server, old database `mafia`, new database name, configured target, and healthy revision. Require `old != new`, the new target to exist, and the app to use it. Delete only the exact old database via its database resource, never the server/resource group or a wildcard. Stop if identity or connection checks are uncertain; do not use a broad forced cleanup.
9. Read back database resources and verify `mafia` is absent and the new database remains present. Recheck health/version and the fresh current-game persistence path after deletion.
10. Report the run URL, actual image digest, active revision, new database name, acceptance evidence, and verified old-database deletion. No rollback or recoverability guarantee is made.

**Acceptance:** The current-only candidate is healthy at the unchanged production URL against the new database, fresh-state behavior passes before and after deletion, and only the old `mafia` database has been deleted.

---

## Verification summary

**Local/source:**

```text
npm run test:security-contracts
az bicep build --file infra/main.bicep
actionlint .github/workflows/deploy-azure.yml
npm run check
git diff --check
git status --short
```

**Live/pre-cutover:** Explicit server and distinct database targets; new target confirmed absent; automatic deployments paused without freezing application writes.

**Live/post-cutover:** Successful migration init, healthy active revision, exact `/health/version` SHA, fresh authentication/club/game journey, no historical data copied, obsolete revisions inactive, old database absent, new database present, and health/persistence reverified after deletion.

## Risks and safeguards

- **Intentional data loss:** Old users, clubs, players, sessions, games, and OAuth rows are not migrated; the old database is deleted after acceptance. No backup is created or verified, and there is no planned rollback. Michael explicitly selected this revised scope.
- **Wrong-target deletion:** Safeguard: exact server/database identity readback, old/new inequality, verified new-app configuration, successful acceptance before deletion, and readback plus persistence checks afterward. Never delete the server or resource group.
- **Obsolete revisions and shared secrets:** Old revisions may restart with changed app-level secrets. Safeguard: deactivate obsolete revisions after the new deployment passes and verify the new revision is the sole serving revision before deletion.
- **Credential leakage:** Connection strings contain the PostgreSQL password. Safeguard: keep shell tracing off around secrets, pass values through protected process/environment/secret references, and log only redacted names/counts/digests.
- **Concurrent writes and interruption:** No pre-cutover write freeze is performed. Writes accepted by the old app are intentionally not carried forward and will be lost with deletion. Shared-secret updates and revision activation may interrupt service; zero downtime is not promised.
- **Auth prerequisite:** Local `az` currently requires interactive Conditional Access login. Safeguard: stop at the live gate until authentication succeeds; never guess credentials or weaken the tenant policy.
- **Repeated automatic failures:** Main pushes currently keep targeting `mafia`. Safeguard: set and verify `AZURE_DEPLOY_ENABLED=false` before any implementation push, then manually dispatch the reviewed cutover candidate.

## Deferred follow-up

The workflow waits for health before reporting `ActivationFailed`, by which time the init replica may be unavailable for console logs. A separate diagnostics improvement could fail fast on revision activation failure and capture init logs earlier. It is useful but independently reviewable and is not required for this database cutover, so it is intentionally excluded from this plan.

## Implementation checkpoint

- Revised plan approved; Tasks 1–3 (local implementation and qualification) complete.
- Required `databaseName` Bicep parameter and `AZURE_DATABASE_NAME` workflow input now drive validation, foundation, application, and the non-secret deployment summary. Missing/unsafe values fail before resource mutation. No compatibility fallback or automatic deletion was added.
- Regression-first evidence: database wiring test failed before implementation; shell execution test failed because an unset name was accepted before validation was added; all 9 deployment/security contract tests now pass.
- Bicep compilation to stdout, compiled ARM database-identity assertions, `actionlint .github/workflows/deploy-azure.yml`, and `git diff --check` passed.
- Focused real-PostgreSQL schema/migration/startup tests: 13 passed. Full `npm run check` passed: formatting, lint, typecheck, contract suites, server (185), web (587), domain (136), and production build. The first check found no local PostgreSQL listener; a disposable PostgreSQL 17 container resolved the prerequisite without changing existing databases and was removed after qualification.
- Changes remain local and uncommitted. No Azure/GitHub state, production data, or deployment was changed. No backup/PITR operation was performed.
- Stopped at the Task 3 publication/live-action checkpoint. Tasks 4–5 and live DoD remain pending explicit commit/push/deploy authorization; this plan remains active until those operations are verified.
