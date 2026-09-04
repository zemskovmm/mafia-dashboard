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
- `GHCR_USERNAME`
- `AZURE_DEPLOY_ENABLED=true`

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

Every push to `main` runs the normal CI workflow and the Azure workflow. Azure deployment starts only when `AZURE_DEPLOY_ENABLED=true`.

The Azure workflow:

1. runs `npm run check` with PostgreSQL 17;
2. verifies a Linux `amd64` Docker build;
3. logs into Azure using GitHub OIDC;
4. deploys the private network, PostgreSQL, and Container Apps environment;
5. publishes `ghcr.io/zemskovmm/mafia-dashboard:<full-git-sha>`;
6. deploys a revision containing that immutable image as both a migration init container and the web container;
7. requires the init migration to complete before the revision's web container starts;
8. discovers the generated Container Apps HTTPS hostname and applies it as `PUBLIC_APP_URL`;
9. verifies the Container App configuration and `/health/ready`.

On initial provisioning, the workflow can update the Container App once more after Azure has generated the HTTPS hostname so the final revision receives the canonical `PUBLIC_APP_URL`.

Manual deployment is available from **Actions → Deploy Azure → Run workflow**.

## Trusted ingress and authentication limiting

Azure Container Apps managed HTTPS ingress is the only public route to the application container. The deployment therefore sets `TRUST_PROXY_HOPS=1`: Fastify uses the rightmost `X-Forwarded-For` address supplied by that single ingress for the authentication-attempt limiter. [Container Apps documents](https://learn.microsoft.com/azure/container-apps/ingress-overview#http-headers) that ingress appends the request sender and that only this rightmost address is supplied by Container Apps; caller-controlled values to its left are not trusted.

Do not replace this with unbounded proxy trust. Adding Front Door, a CDN, or another ingress changes the hop model and requires a separately validated policy before deployment. The limiter remains in-process and supports the current 0–1 replica configuration only.

## Security gates

The separate `Security` workflow runs on pull requests, pushes to `main`, a weekly schedule, and manual dispatch. The deployment workflow independently repeats the dependency and repository scan, then builds the commit-tagged image, scans that exact local image, and pushes it only after the image gate passes. Job permissions scope package writes only to publishing and Azure OIDC only to deployment. All external actions are pinned to immutable commits. See [`security-and-privacy.md`](security-and-privacy.md) for the threat model, exact controls, verification commands, and residual risks.

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
  --parameters deployApp=false postgresPassword='<redacted>'
actionlint .github/workflows/deploy-azure.yml
```

Never commit deployment parameter files containing real passwords or OAuth secrets.

## Rollback

The publish job uses the full Git SHA as a traceable GHCR tag, captures and verifies the pushed manifest digest, and deploys Azure from `ghcr.io/...@sha256:<digest>`. Record the deployed digest with the release evidence. To roll back, redeploy the previous known-good digest; rerunning an old commit creates and scans a new artifact and is not an artifact-identical rollback. Do not delete manifests referenced by healthy or rollback-eligible revisions.

Each revision runs the advisory-locked, transaction-protected migration init container before the app container. A failed migration prevents that revision from becoming ready.

Database rollback is separate: application rollback must not automatically restore PostgreSQL. Use Flexible Server point-in-time restore only for an incompatible or destructive database change.
