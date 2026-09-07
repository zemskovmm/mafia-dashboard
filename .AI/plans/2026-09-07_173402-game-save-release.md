# Save-fix production release plan

## Plain-language summary
After the console improvements and demonstrated save repair pass local verification, commit only their scoped changes, push main once, and verify the existing Azure production deployment succeeds for that exact commit.

## Goal
Deliver the verified save repair and diagnostics to production using the unchanged existing release pipeline.

## Current release path
.github/workflows/deploy-azure.yml triggers on main pushes with AZURE_DEPLOY_ENABLED=true or explicit workflow_dispatch. It publishes a full-SHA Linux image, deploys by digest through Azure OIDC to the production environment, selects foundation updates automatically, and verifies app/init image equality, readiness, and exact commit identity. No separate QA promotion stage is declared in this repository; do not import another project's environments. Preserve current CI/security policy.

## Prerequisites
Repair-plan acceptance and console regression coverage pass. Run npm run check:local, which invokes the required npm run check using a disposable PostgreSQL instance. Do not publish diagnostics alone while the repair is unresolved unless the user explicitly changes that decision.

## Steps
1. Recheck branch, remote SHA, complete outgoing commits, staged paths, and all source differences. Preserve unrelated work. Inspect current deployment enablement and active runs using non-secret queries.
2. Perform one scoped final code review. Fix only blockers against this plan and rerun affected checks; re-run the full gate when relevant verified bytes changed. Do not add retired scans or redesign workflows.
3. Commit only approved source/tests and relevant plan lifecycle changes. Keep private diagnostic fixtures, screenshots, payloads, and unrelated .AI evidence uncommitted. Ensure committed bytes match verified source.
4. Push the current main branch once, then read origin/main's full SHA back. Locate the existing Deploy Azure run for that SHA; allow bounded registration delay, and do not dispatch a duplicate. If automatic deployment is disabled, use the existing manual deploy=true/deploy_infrastructure=false path only after verifying no equivalent run exists; do not force foundation changes.
5. Watch to terminal completion and read back exact head SHA, publish/deploy job conclusions, and built-in verification outcome. Use a background watcher with notification for a long rollout, not blind redeploys.
6. Obtain the production testing URL from safe deployment metadata/output. Return it with deployed SHA and run URL. Rely on built-in health/identity checks; do not add unsolicited production HTTP/browser/data mutations.
7. Remove fulfilled plans after all local/release acceptance is verified, preserving history as repository guidance requires. Leave unresolved historical-cause evidence clearly labeled rather than claiming recovery.

## Non-goals
No infrastructure redesign, new environments, data reset, database switching, direct production repair, credential changes, duplicate deployments, unrelated pushes, issue closure, or PR creation.

## Acceptance / failure handling
Remote main matches the approved commit; SHA-bound production workflow publishes and deploys successfully including its existing verification. Report blockers honestly if credentials, permissions, quality gates, or rollout fail. Do not overwrite cloud settings or force-push. If rollback is needed, propose the narrow existing-image rollback and seek approval rather than resetting data or rewriting Git history.
