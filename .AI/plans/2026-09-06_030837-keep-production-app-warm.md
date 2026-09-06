# Keep production app warm — implementation plan

**Goal:** Remove idle scale-to-zero cold starts from Mafia Dashboard page requests.

**Plain-language summary:** Keep one application container running instead of shutting the app down when unused. Preserve the existing single-instance architecture, migration safeguards, and deployment identity checks. This trades some additional Azure cost for more consistent first-visit response times.

**Architecture:** Azure Container Apps Consumption currently hosts the web app and API in one container with a migration init container. Change the minimum replica count from zero to one while retaining the maximum of one and existing resources.

**Tech stack:** Bicep, Azure Container Apps, GitHub Actions, Node test runner.

**Non-goals:** Infrastructure deployment separation (covered by the sibling plan); CDN or frontend bundle changes; larger CPU/database SKUs; multiple replicas or high availability; migration redesign; unrelated in-progress UI changes.

**Plan set:** See `2026-09-06_030837-production-deployment-plan-set.md` for shared delivery authorization, order, and final approval gate. Michael has authorized scoped commit/push, pipeline execution, the additional warm-container cost, and production rollout, subject to final approval of this expanded plan set.

## Evidence and uncertainty

- User reports delay primarily on first visit or after idle.
- Read-only Azure inspection confirms `mafiadashboard-app` in `rg-mafia-dashboard-prod-weu` has minReplicas=0, maxReplicas=1, cooldownPeriod=300, 0.5 vCPU / 1 GiB, single revision mode, and a migration init container.
- `infra/main.bicep:358-370` matches the live scale settings.
- `docs/azure-deployment.md:3-12` explicitly describes the deployment as low-cost/pilot-grade.
- Before the HTTP samples, revision `mafiadashboard-app--0000063` already had a Running replica. Three homepage requests returned HTTP 200 in 0.266827, 0.167205, and 0.249987 seconds; readiness and version returned 200. These are warm HTML HTTP timings from this machine, not browser full-page timings. No cold start was observed or deliberately induced.
- Scale-to-zero is the leading explanation, not a measured attribution of the user's specific slow request. Azure documents cold starts at https://learn.microsoft.com/en-us/azure/container-apps/cold-start and minimum replicas at https://learn.microsoft.com/en-us/azure/container-apps/scale-app .
- The auth limiter is in-process; docs explicitly restrict it to single-instance operation. Keep maxReplicas=1.

## Implementation boundary

1. Add a focused regression in `scripts/security-workflow-contracts.test.mjs` enforcing a minimum and maximum of one in the app scale block and retaining existing migration/identity safeguards. Follow the existing deployment contract test conventions. Demonstrate failure against the current configuration.
2. Change only `minReplicas: 0` to `minReplicas: 1` in the application resource. After the sibling template separation this resource lives in `infra/app.bicep`; update the regression to target the separated template.
3. Update `docs/azure-deployment.md` to describe 1–1 replicas, idle cost versus scale-to-zero, and the remaining lack of HA. Do not reuse the existing monthly estimate as if it included the new policy; verify current regional idle pricing before claiming an updated estimate.
4. Run `npm run test:security-contracts`, compile Bicep with output under `.AI/`, and run `npm run check`. Preserve unrelated working-tree modifications and report unrelated failures rather than repairing their scope.

## Production verification — included in the expanded delivery scope

Before applying anything, confirm the live target, current image digest and revision, and no conflicting deployment. Michael accepted the additional idle cost during clarification; verify current pricing before quoting a figure. Do not publish unrelated dirty UI work. Use the scoped release path in the plan-set index; do not rely on an undocumented Azure-only override that the next Bicep deployment would undo.

After the approved rollout:
- Read back the exact app: minReplicas=1, maxReplicas=1, correct resources, healthy active revision, unchanged database target and expected immutable image.
- Verify `/health/live`, `/health/ready`, and `/health/version` and expected release identity.
- Allow at least ten minutes with no synthetic HTTP traffic; inspect replica state using the management API and verify a replica remains running.
- Measure the next homepage request and subsequent warm requests from the same client. Target post-idle HTML time-to-first-byte below one second in this measurement environment; record DNS/TLS separately and investigate rather than declare success if it is not met.
- Check an actual browser first visit/refresh for perceived loading delay. If HTML is fast but rendering remains slow, stop and plan a separate frontend/network diagnosis rather than expanding this change.

## Acceptance criteria

- Repository and (if rollout is authorized) live settings agree on exactly one minimum and maximum replica.
- Existing migration, health, identity, isolation, and authentication safeguards remain intact.
- Relevant contract tests and `npm run check` pass, or blockers are reported accurately.
- Live completion requires the idle-period replica and first-request verification, not just a green deployment.

## Risks and rollback

- A warm minimum incurs ongoing idle charges; exact cost is not yet estimated. The cost tradeoff is accepted; confirm current pricing before quoting an estimate.
- One replica is not HA and can still restart during deployments, maintenance, or failures. This does not eliminate every possible startup or browser delay.
- Reverting the scoped replica change restores scale-to-zero savings and the cold-start tradeoff; no database rollback is involved. Production rollback also requires approval.

## Approval gate

Await final approval of the expanded plan set before implementation. That approval activates the already requested scoped commit, push, pipeline execution, and production rollout. Remove this active plan only after its acceptance criteria are verified.
