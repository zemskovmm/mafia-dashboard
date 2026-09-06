# Separate infrastructure deployment — implementation plan

**Goal:** Make routine application releases deploy only the application resource, applying the infrastructure foundation only when its deployment inputs change or an operator forces it.

**Plain-language summary:** Stop submitting the whole Azure infrastructure twice for every release. Maintain separate foundation and application templates in the existing serialized deployment workflow. Automatically apply infrastructure changes, with a manual force option, then deploy and verify the app using the existing immutable image handoff.

**Architecture:** Keep `infra/main.bicep` as the foundation entry point; extract the Container App into `infra/app.bicep` referencing existing environment, PostgreSQL, and database resources. Preserve exact resource naming formulas and explicit database targeting. A durable successful-foundation fingerprint determines whether the foundation must be reapplied; an app-only release must never emit foundation resource writes.

**Tech stack:** Bicep, GitHub Actions, Azure CLI, Node built-in test runner.

**Non-goals:** Additional workflows, restoring removed CI/security gates, changing pull-request/main event ownership, database reset or migration redesign, resource renames/recreation, multiple app replicas, unrelated UI work. Warm-container behavior is covered by the sibling plan.

## Current evidence

- `.github/workflows/deploy-azure.yml` applies `infra/main.bicep` with deployApp=false and then again with deployApp=true.
- Application naming and existing-resource identities derive from subscription/resource-group IDs and namePrefix. Preserve those formulas and current North Europe location; the resource group's historical `weu` suffix does not define its region.
- Both app paths must preserve the immutable publish-job image output, migration init container, canonical PUBLIC_APP_URL bootstrap, explicit database name, TLS verification, secret references, probes, and health/version verification.
- Workflow-level `azure-production` concurrency already covers publishing through verification. Retain it and `cancel-in-progress: false`.
- `scripts/security-workflow-contracts.test.mjs` assumes three main-template invocations and foundation step outputs; update it to verify the new effective behavior, not obsolete invocation counts.
- CI is pull-request-only; main push and manual dispatch belong to Deploy Azure.

## Tasks

### 1. Define and regression-test deployment selection

Create `scripts/azure-deployment-contracts.test.mjs` and, if needed for clear testable logic, `scripts/azure-deployment-plan.mjs`. Register the test in `package.json` using the existing Node test-script convention. Use fixtures and compiled-template assertions rather than solely matching YAML tokens.

Selection contract:
- Auto mode applies foundation when there is no successful recorded foundation fingerprint, the fingerprint differs, or required foundation resources are missing.
- Fingerprint deterministic sorted deployment file paths and contents (all `infra/` Bicep files, deployment workflow and any extracted deployment helper), plus explicit non-secret target identity: subscription/resource group/location/name prefix/database name. Never hash or print secrets.
- Use a stable, named foundation ARM deployment record with a non-secret fingerprint output. Reuse only when its provisioning state is Succeeded, fingerprint matches, outputs match the requested target, and required resources exist. Missing/failed records require foundation deployment; authorization, network, or malformed response errors must fail rather than masquerade as missing resources.
- Record the fingerprint through the successful foundation deployment itself; never mark a planned or failed deployment as applied. If a deployment fails, a subsequent run retries safely. Manual force supports drift reconciliation and secret-driven infrastructure updates; out-of-band drift not found by existence checks remains a documented limitation.
- Add boolean manual input `deploy_infrastructure`, default false, meaning force foundation. False means automatic detection, not suppress necessary infrastructure work.
- Keep existing `deploy=false` publish-only behavior: it must perform no Azure deployment, regardless of force input.

Cover unchanged inputs, changed files, deleted files, changed target identity, missing resources/record, failed deployment, manual force, and malformed/API failure responses. Prove that token-preserving bad variants (unconditional foundation, recording success before completion, mismatched database, wrong image) fail the relevant tests.

### 2. Separate resource ownership

Modify `infra/main.bicep` to own only VNet/subnets, DNS/link, PostgreSQL/database, and Container Apps environment. Export non-secret identities plus the successful fingerprint. Remove app-only secret/env/template parameters and the deployApp switch from this entry point.

Create `infra/app.bicep` to own only the Container App. Reference existing foundation resources using their exact current names and preserve resource scope. Move the existing app environment, secrets, migration init container, probes, ingress, image and PUBLIC_APP_URL behavior unchanged. Apply the sibling plan's minReplicas=1 here. Preserve maxReplicas=1 and existing resource sizes.

Compile both templates and assert their resource-write boundaries: the app deployment may read/reference foundation resources but must not create/update network, database/server, or managed environment resources. Preserve incremental deployment mode; no complete-mode deletion or renamed foundation resources.

### 3. Wire the existing workflow

Modify `.github/workflows/deploy-azure.yml`:
- Preserve triggers, disabled-deploy switch, pinned actions, least-privilege job credentials, timeouts, immutable image publish/output, and production concurrency.
- Compute selection and validate configuration; condition resource-group creation, foundation validation, and foundation deployment on the foundation-needed result.
- Resolve/validate foundation outputs in both paths so app-only never depends on skipped-step outputs. Fail closed on a wrong/missing database or environment.
- Always apply the app-only template when deployment is enabled. Set both init and web image explicitly to the publish output.
- Retain initial hostname discovery and second app-only apply when PUBLIC_APP_URL must be bootstrapped.
- Keep failure diagnostics and readiness/version checks; assert read-back min/max replicas and both image references instead of merely printing them.
- Emit a summary with foundation applied/skipped and reason, app URL, explicit database identity, commit and digest.

### 4. Documentation and verification

Update `docs/azure-deployment.md` for separate templates, auto fingerprint detection, manual force, missing-resource bootstrap, publish-only mode, secret rotation/drift requiring force, and rollback limitations. Change relevant test assertions in `scripts/security-workflow-contracts.test.mjs` without weakening existing retained protections. Do not change `ci.yml` merely to produce an extra hosted CI run.

Run focused Node contract tests, actionlint, both Bicep compilations (generated output under `.AI/`), and `npm run check` against the exact scoped release tree, with a disposable PostgreSQL test database. Do not allow the unrelated dirty working tree to contaminate release evidence.

## Event matrix

| Context | CI | Publish/app deploy | Foundation |
| --- | --- | --- | --- |
| Pull request | Existing CI | Absent | Absent |
| Non-main push | Absent | Absent | Absent |
| Enabled main push | Absent | Automatic | Automatic only when needed |
| Main push with deployment disabled | Absent | Skipped | Skipped |
| Manual deploy=true, force=false | Absent | Automatic | Automatic only when needed |
| Manual deploy=true, force=true | Absent | Automatic | Forced |
| Manual deploy=false | Absent | Publish only | Absent |

Retain existing manual ref semantics; do not broaden credential access or historical redeploy guarantees.

## Acceptance and rollout

Follow the plan-set index for scoped commit/push and production authorization. Verify a real foundation-changing main run, a manual unchanged-input app-only run, and a manual forced-foundation run on the same approved source commit. Rebuilding the same commit can produce a new digest; bind every run to its own pushed digest, never claim artifact-identical retry. Record step timing and compare with the previous 8m55s run; no invented speedup target.

App-only acceptance requires both a skipped foundation stage and a compiled app template with no foundation resource writes. Read back live revision, both image references, exact /health/version commit, readiness, min/max replicas, database target, and canonical URL after each rollout. Never log connection strings or secret payloads.

## Risks and rollback

- Incorrect existing-resource names can silently point at a different foundation. Compare identities before applying anything; stop on mismatch.
- A fingerprint is change detection, not a complete drift detector. Manual force remains necessary for deliberate reconciliation and changes not represented by non-secret inputs.
- Foundation failure blocks app deployment; reruns must not record it as successful.
- Retaining one workflow avoids cross-workflow lock/order races and avoids duplicate automatic runs.
- Reverting template separation reintroduces redundant writes; preserve actual resource IDs and never restore/delete the database as an app rollback.

## Approval gate

Planning only until the expanded plan set receives final approval. Michael has already requested scoped commit/push/pipeline execution and accepted production rollout and warm-container cost. No additional rollout approval is required after final plan approval unless material scope changes or a new safety blocker arises.
