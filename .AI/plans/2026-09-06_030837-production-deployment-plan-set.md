# Production deployment improvements — plan set

## Plain-language summary

Keep the app running so idle visitors do not need to wake it, and stop reapplying the whole Azure foundation during routine app releases. After verification, commit only these changes, push main, execute the deployment paths, and verify the live result. Leave unrelated UI work untouched.

## Goals and order

1. [Separate infrastructure deployment](2026-09-06_030837-separate-infrastructure-deployment.md): distinct foundation/app resource ownership; automatic foundation change detection and manual force. Implement the template split first.
2. [Keep production app warm](2026-09-06_030837-keep-production-app-warm.md): min/max replicas=1 in the extracted app template; post-idle verification.

These are independently useful and reversible outcomes. They share template/docs/test edits and a single scoped delivery. Neither includes deployment of unrelated local changes.

## Confirmed decisions

- Infrastructure changes deploy automatically, with a manual force override; unchanged code-only releases deploy only the app.
- Extra idle cost and production rollout are accepted.
- Scoped commit, push, and pipeline execution are requested.
- Preserve CI for pull requests and deployment for main; do not restore removed gates or open a PR merely to trigger CI.
- Keep one app instance maximum; preserve in-process auth limiting, migration safeguards, club isolation, canonical replay, idempotent persistence, private PostgreSQL, immutable image identity, and health checks.

## Shared delivery and verification

1. After final plan approval, recheck branch/status, remote main, and live deployment state. The inspected workspace contains substantial unrelated UI/docs/harness edits. Do not stage them, stash them, overwrite them, or commit another actor's changes. Stop if concurrent changes overlap the approved files. Avoid broad `git add`.
2. Implement scoped files and regression tests. Run focused tests, actionlint, and compile both Bicep templates. Use `npm run check` against an isolated copy of the exact proposed release tree rather than claiming dirty-worktree tests prove the commit. Supply a disposable test database per the existing test setup; do not use production.
3. Review the exact scoped diff and resource identities. Commit only approved deployment source/docs/tests and relevant plan artifacts. Verify commit contents and remote ancestry before pushing current main; no force push or rewriting history. If another actor advances main with unreviewed work, stop rather than implicitly deploy it.
4. Push main once and watch the automatic Deploy Azure run to completion. It must apply the newly separated foundation and app, preserve the explicit database target, and deploy exactly the published digest in both containers. Verify remote commit and run head SHA.
5. Dispatch Deploy Azure on the same source commit with deploy=true and deploy_infrastructure=false; unchanged foundation must be skipped. Verify successful app-only deployment and record timing. Then exercise deploy_infrastructure=true and verify forced foundation application and healthy app. Run these serially; do not dispatch overlapping deployments or misrepresent per-run rebuilt digests as identical.
6. CI remains pull-request-only and cannot be manually dispatched under current policy. Run its `npm run check` locally on the exact candidate; report it as local CI-equivalent verification, not a hosted CI run. No PR or new trigger is authorized by this plan.
7. After the final deployment, verify live health/version, min/max=1, expected current digest, unchanged foundation/database identities, and the warm plan's ten-minute no-synthetic-traffic observation plus first-request timing. Use a browser for actual page load only within the approved verification scope; do not modify game data.
8. Report commit SHA, verified remote SHA, actual workflow URLs/statuses, before/after timings, skipped/applied foundation evidence, live replica state, and honest residual limitations. Completion requires verified live acceptance, not merely successful push.
9. Remove successfully implemented active plan files after verification as repository policy requires; if they were committed, a narrowly scoped cleanup commit is permitted. Avoid causing an unnecessary additional production build solely for cleanup: document an existing supported skip mechanism if available; otherwise explicitly account for and verify any triggered final cleanup run. Never silently leave a pipeline running after declaring delivery complete.

## Risks and boundaries

No app/server/database SKU upgrades, CDN work, migrations redesign, workflow trigger policy changes, resource deletion, or deployment of dirty UI work. The always-running container adds cost and is not HA. External drift beyond existence checks needs manual infrastructure reconciliation. If the first-visit delay persists after warming, report it and plan a separate frontend/network investigation.

## Final approval gate

The user has authorized the delivery actions and cost. Because infrastructure separation materially expands the earlier plan, save and present this plan set and stop for final explicit approval before implementation. After approval, continue through commit, push, pipeline completion, and live verification without another routine approval pause; ask only for a new material scope decision or blocker.
