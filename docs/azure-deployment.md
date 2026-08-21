# Azure deployment

Mafia Dashboard deploys to Azure Container Apps from `.github/workflows/deploy-azure.yml` using Azure OIDC. The deployment is single-region and intentionally low-cost:

- Azure Container Apps Consumption, 0.5 vCPU / 1 GiB, 0–1 replicas
- Azure Database for PostgreSQL Flexible Server 17, private VNet access, B1ms, 32 GiB, 7-day backups
- public immutable images in GitHub Container Registry
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
- `AZURE_DEPLOY_ENABLED=true`

It must contain these secrets:

- `POSTGRES_PASSWORD`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `MUSIC_TOKEN_ENCRYPTION_KEY`

Azure login uses the federated subject:

```text
repo:zemskovmm/mafia-dashboard:environment:production
```

The deployment identity needs Contributor only on the deployment resource group.

## Deployment flow

Every push to `main` runs the normal CI workflow and the Azure workflow. Azure deployment starts only when `AZURE_DEPLOY_ENABLED=true`.

The Azure workflow:

1. runs `npm run check` with PostgreSQL 17;
2. verifies a Linux `amd64` Docker build;
3. logs into Azure using GitHub OIDC;
4. deploys the private network, PostgreSQL, and Container Apps environment;
5. publishes `ghcr.io/zemskovmm/mafia-dashboard:<full-git-sha>`;
6. deploys that immutable image;
7. discovers the generated Container Apps HTTPS hostname and applies it as `PUBLIC_APP_URL`;
8. verifies the Container App configuration and `/health/ready`.

Manual deployment is available from **Actions → Deploy Azure → Run workflow**.

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
az bicep build --file infra/main.bicep
az deployment group validate \
  --resource-group <resource-group> \
  --template-file infra/main.bicep \
  --parameters deployApp=false postgresPassword='<redacted>'
actionlint .github/workflows/deploy-azure.yml
```

Never commit deployment parameter files containing real passwords or OAuth secrets.

## Rollback

Each deployment uses the full Git SHA as the image tag. To roll back, manually run the workflow from the known-good commit or redeploy the previous ACR image tag. Do not delete previous image tags until the replacement revision is healthy.

Database rollback is separate: application rollback must not automatically restore PostgreSQL. Use Flexible Server point-in-time restore only for an incompatible or destructive database change.
