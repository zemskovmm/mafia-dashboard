# Azure deployment

Mafia Dashboard deploys to Azure Container Apps from `.github/workflows/deploy-azure.yml` using Azure OIDC. The deployment is single-region and intentionally low-cost:

The production workflow bakes the full Git SHA into the image and exposes it with the package version at `/health/version`. Use the [v1.0.0 release checklist](releases/v1.0.0.md) for exact-candidate qualification and evidence requirements.

- Azure Container Apps Consumption, 0.5 vCPU / 1 GiB, 0–1 replicas
- Azure Database for PostgreSQL Flexible Server 17, private VNet access, B1ms, 32 GiB, 7-day backups
- private immutable images in GitHub Container Registry
- no Azure Files, storage account, Dapr, Redis, NAT Gateway, or retained Log Analytics workspace

Expected baseline is approximately **US$19.41/month** before tax, domain, egress, or excess Container Apps usage. B1ms and a single app/database are pilot-grade, not HA.

## GitHub production environment

The `production` environment must contain these variables:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `AZURE_RESOURCE_GROUP`
- `AZURE_LOCATION`
- `AZURE_NAME_PREFIX`
- `AZURE_DATABASE_NAME` (required explicit target, for example `mafia_current_20260905`)
- `GHCR_USERNAME`
- `AZURE_DEPLOY_ENABLED=true`

`AZURE_DATABASE_NAME` is a non-secret deployment identity: 1–63 lowercase letters, digits, or underscores, beginning with a letter. There is no fallback database name. All Bicep validation, foundation, and application paths receive the same target; the workflow verifies the foundation's database-name output and includes it in the deployment summary. Direct Bicep callers must also supply `databaseName` explicitly and follow the same naming rule.

It must contain these secrets:

- `POSTGRES_PASSWORD`
- `GHCR_PULL_TOKEN` with `read:packages` access
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `MUSIC_TOKEN_ENCRYPTION_KEY`

Azure login uses the resource-group-scoped user-assigned managed identity `mafiadashboard-github`. Its federated subject uses GitHub's immutable owner and repository IDs:

```text
repo:zemskovmm@8973322/mafia-dashboard@1320321469:environment:production
```

The deployment identity has Contributor only on the deployment resource group. The federated credential is an Azure Managed Identity resource created through Azure Resource Manager, so routine GitHub deployments need no user login, stored Azure client secret, or Microsoft Graph application-registration permission.

Bootstrap or repair that trust once from an interactively authenticated Azure CLI session:

```bash
AZURE_SUBSCRIPTION_ID=9f0da8f6-9da5-4bef-9738-cb26f2a19e58 \
AZURE_TENANT_ID=b41b72d0-4e9f-4c26-8a69-f949f367c91d \
AZURE_RESOURCE_GROUP=rg-mafia-dashboard-prod-weu \
AZURE_LOCATION=northeurope \
scripts/bootstrap-azure-oidc.sh
```

After this bootstrap, `azure/login` exchanges GitHub's short-lived OIDC assertion for an Azure token on every run. Interactive Azure login is needed only to bootstrap or repair the managed identity, not for normal deployments.

## Deployment flow

Pull requests run the `CI` workflow. Pushes to `main` run only the Azure workflow, and automatic deployment starts when `AZURE_DEPLOY_ENABLED=true`.

The Azure workflow:

1. builds and publishes `ghcr.io/zemskovmm/mafia-dashboard:<full-git-sha>` for Linux `amd64`;
2. verifies the published digest and passes that immutable reference to deployment;
3. logs into Azure using GitHub OIDC;
4. deploys the private network, PostgreSQL, and Container Apps environment;
5. deploys a revision containing that immutable image as both a migration init container and the web container;
6. requires the init migration to complete before the revision's web container starts;
7. discovers the generated Container Apps HTTPS hostname and applies it as `PUBLIC_APP_URL`;
8. verifies the Container App configuration, `/health/ready`, and the deployed commit identity.

On initial provisioning, the workflow can update the Container App once more after Azure has generated the HTTPS hostname so the final revision receives the canonical `PUBLIC_APP_URL`.

Manual deployment is available from **Actions → Deploy Azure → Run workflow**.

## Fresh current-only database cutover

This is an explicitly approved data reset, not an upgrade. The selected cutover deliberately omits backup creation, restore verification, a PITR server, a production write freeze, and rollback preparation. Existing platform backup settings remain unchanged, but recoverability is not verified or promised.

The new database contains only current DDL and bootstrap seeds. Existing users, clubs, players, sessions, games, and OAuth connections are not copied. Old sessions become invalid; users sign in again, create clubs, and reconnect music as needed. Writes accepted by the old app during cutover are not carried forward and will be lost when the old database is deleted. The Container App hostname and Google callback URLs remain unchanged. Shared-secret updates and revision activation may interrupt service; zero downtime is not promised.

1. Obtain explicit approval for publishing, deploying, and deleting the old database after acceptance. Confirm Azure access and the exact subscription, resource group, PostgreSQL server, app, old database, and distinct never-used new database name. Do not read credentials into logs.
2. Before pushing, pause automatic deployment using `AZURE_DEPLOY_ENABLED=false` at the scopes supplying the workflow's job conditions, including any repository/organization-level value; read back the effective configuration and check that no deployment is already in flight. A production-environment variable alone must not be assumed to gate jobs before environment initialization. Manual dispatch with `deploy=true` bypasses this automatic-deployment switch. Do not freeze application writes.
3. Qualify and publish the scoped change, verify the remote SHA, then set and read back production `AZURE_DATABASE_NAME` to the new name. Keep automatic deployment paused while checking inputs. The existing incremental ARM deployment creates/selects the named database on the same server; it does **not** delete the old database.
4. Dispatch the qualified ref with deployment enabled. Record the run's actual pushed digest and verify that the deployed init and app containers use it. Rebuilding the same SHA is not proof of an identical artifact. Require migration success, a healthy serving revision, and `/health/live`, `/health/ready`, and `/health/version` matching the expected commit.
5. Verify both containers target the new database without exposing the connection string. At the unchanged origin, verify rejection of an old session, fresh Google sign-in, club creation/isolation, and a current-format game save/reload. Confirm historical records were not copied and clean up only verifier-owned data. If any acceptance check fails or cannot be completed, stop with the old database undeleted; do not improvise rollback.
6. After acceptance passes, deactivate obsolete revisions and verify only the new healthy revision can serve traffic. Old revisions must not restart against changed app-level secrets.
7. Immediately before deletion, re-read the exact server, old database `mafia`, new database, and active app target. Require old and new names to differ and the app to use the verified new database. Delete only the old database resource—never the server, resource group, or a wildcard. Stop on uncertain identity or connections rather than forcing a broad cleanup.
8. Read back database resources: the old database must be absent and the new one present. Recheck health, exact version, and current-game persistence after deletion. Report verified results and restore the intended automatic-deployment setting only when the target is correct. No old-database retention or rollback guarantee applies to this cutover.

## Trusted ingress and authentication limiting

Azure Container Apps managed HTTPS ingress is the only public route to the application container. The deployment therefore sets `TRUST_PROXY_HOPS=1`: Fastify uses the rightmost `X-Forwarded-For` address supplied by that single ingress for the authentication-attempt limiter. [Container Apps documents](https://learn.microsoft.com/azure/container-apps/ingress-overview#http-headers) that ingress appends the request sender and that only this rightmost address is supplied by Container Apps; caller-controlled values to its left are not trusted.

Do not replace this with unbounded proxy trust. Adding Front Door, a CDN, or another ingress changes the hop model and requires a separately validated policy before deployment. The limiter remains in-process and supports the current 0–1 replica configuration only.

## Workflow boundaries

The deployment workflow intentionally does not repeat pull-request formatting, lint, typecheck, tests, or automated vulnerability scans. A main push builds, publishes, and deploys directly. Job permissions scope package writes only to publishing and Azure OIDC only to deployment, and all external actions remain pinned to immutable commits. See [`security-and-privacy.md`](security-and-privacy.md) for the retained application controls and residual risks.

### Known diagnostic limitation

The deployment verifier can finish its health wait before reporting `ActivationFailed`; by then, the failed migration init replica may no longer be available for console logs. When investigating activation failures, inspect revision state and capture init-container logs early. Failing fast and automatically capturing those logs remains a deferred workflow improvement, not part of the fresh-database cutover.

## Google OAuth callbacks

After the first Azure deployment, obtain the URL from the workflow summary. Add both callback URLs to the Google OAuth Web application client:

```text
https://<azure-container-app-host>/api/auth/google/callback
https://<azure-container-app-host>/api/music/oauth/callback
```

Until those exact URLs are authorized by Google, the Azure application is healthy but Google sign-in or YouTube Music connection can be rejected by Google.

## Local validation

```bash
npm run check
npm run verify:compose
az bicep build --file infra/main.bicep
az deployment group validate \
  --resource-group <resource-group> \
  --template-file infra/main.bicep \
  --parameters deployApp=false databaseName='<explicit-database-name>' postgresPassword='<redacted>'
actionlint .github/workflows/deploy-azure.yml
```

Never commit deployment parameter files containing real passwords or OAuth secrets.

## Rollback

The fresh cutover above intentionally has no planned rollback and deletes its old database after verification. The general guidance below is not a recovery guarantee for that reset.

The publish job uses the full Git SHA as a traceable GHCR tag, captures and verifies the pushed manifest digest, and deploys Azure from `ghcr.io/...@sha256:<digest>`. Record the deployed digest with the release evidence. To roll back, redeploy the previous known-good digest; rerunning an old commit creates a new artifact and is not an artifact-identical rollback. Do not delete manifests referenced by healthy or rollback-eligible revisions.

Each revision runs the advisory-locked, transaction-protected schema initialization container before the app container. Only an empty database or the current schema with current-format rows is supported. Historical upgrades and backfills are not provided, and an unsupported schema prevents the revision from becoming ready without repairing or deleting existing data. Independently verify the database contract before selecting a rollback image; a previous digest is not automatically compatible.

Database rollback is separate: application rollback must not automatically restore PostgreSQL. Use Flexible Server point-in-time restore only for an incompatible or destructive database change.
