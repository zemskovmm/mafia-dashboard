# Azure deployment

La Verdad has one hosted release target: the existing production Azure Container App. Pull requests and pushes to `main` run **CI only**: no container publication or deployment. An operator explicitly runs the production workflow from trusted `main` to check the selected commit, build and publish one image, and deploy that exact digest. The [public club website](public-website.md#github-pages-publication) has its own manual GitHub Pages workflow. See [IDD-0009](../.idd/intent/IDD-0009.spec-release-environments.md) for the release contract.

## Release production

1. Confirm the intended commit is on trusted `main`. In GitHub, open **Actions → Deploy production → Run workflow** and select **main**. Use the run's full head SHA to confirm the selected commit. A push or a successful CI run is not a release request.
2. The production run executes the repository quality gate against that SHA before building and publishing a single Linux `amd64` release image. It bakes in the full SHA and the workflow build index. The displayed version is the root package's `major.minor` plus that build index. Publication checks the digest returned by the registry and hands `ghcr.io/…@sha256:…` to the deploy job in the same run. Neither a mutable tag nor another workflow run is a source of release identity.
3. The protected production deploy job checks the target and deploys the exact digest to the existing app. It does not rebuild, provision or reconcile the foundation, initialize storage, rotate secrets, or change the production hostname or data bindings. Production releases are serialized without canceling the active release. There are no release inputs for selecting a prior artifact, provisioning infrastructure, or initializing storage.
4. Read the run result and confirm the verified digest, full commit and displayed version. The workflow checks the deployed image and configuration, then checks `/health/ready` and compares `/health/version` with the expected full SHA and version at the existing HTTPS origin. A successful image push or accepted Azure update is not a verified release. Readiness and version checks do not prove logged-in gameplay or Google OAuth acceptance; see the [v1.0.0 release checklist](releases/v1.0.0.md) for separate exact-candidate qualification.

A failed quality gate, digest check or target check blocks deployment. A post-deployment verification failure is different: Azure might already have applied the update. Inspect the current revision, readiness and reported identity, and retain bounded, credential-safe diagnostics before deciding whether to [roll back](#rollback). Do not assume that failure reverted the app, suppress the verification failure or retry blindly. Capture `initialize-storage` diagnostics promptly on activation failure; failed replicas may disappear.

## Target and resource ownership

| Production target   | Expected binding                       |
| ------------------- | -------------------------------------- |
| Subscription        | `9f0da8f6-9da5-4bef-9738-cb26f2a19e58` |
| Region              | `northeurope`                          |
| Resource group      | `rg-mafia-dashboard-prod-weu`          |
| Name prefix         | `mafiadashboard`                       |
| Container App       | `mafiadashboard-app`                   |
| Managed environment | `mafiadashboard-env`                   |
| Storage account     | `mafiadata6du4xvao4bfk2`               |
| Table               | `MafiaEntities`                        |
| Private container   | `mafia-live`                           |
| Partition           | `production-v1`                        |
| Deployment identity | `mafiadashboard-github`                |
| Runtime identity    | `mafiadashboard-storage`               |

The existing app runs with 0.5 vCPU / 1 GiB and one warm replica (`minReplicas: 1`, `maxReplicas: 1`). Its managed environment must have a **Consumption workload profile** so the init container can use managed identity. See [Container Apps managed identity](https://learn.microsoft.com/en-us/azure/container-apps/managed-identity).

Azure Table and private Blob Storage are the sole supported backend. The Storage foundation (`infra/main.bicep`) owns the dedicated GPv2 LRS account, table and private container, and the runtime identity with Storage Table Data Contributor and Storage Blob Data Contributor scoped only to that account. HTTPS/TLS 1.2 are required; shared-key and anonymous Blob access are disabled. The service endpoints are still publicly reachable; this is not a private-endpoint deployment.

`infra/app.bicep` describes the app separately from the foundation. The web and `initialize-storage` containers use the same immutable image. The init container validates the existing store's recognized authority and private container access before startup; the web container always has initialization disabled. A missing or unrecognized store fails closed. A change to the account, table, container or partition selects a different dataset, not a migration.

Foundation reconciliation and any first-time empty-store initialization require separate authorization; neither can be requested by a routine release. For separately authorized template work, review the exact target, compile and inspect the what-if, and use **Incremental**, never Complete. Stop on unknown account ownership or unexpected resource changes. `infra/parameters.example.json` describes foundation inputs only and is not a secret store. Release does not manage or retire the existing managed environment, retained PostgreSQL/databases or their backups, VNet/subnets, DNS, or other legacy resources. Retiring a release path in the repository does not authorize deleting its resources or backups. There is no SQL backend, connection-string fallback or dual write.

For an authorized foundation change, check the saved Azure what-if JSON with `node scripts/azure-deployment-plan.mjs --check-foundation-what-if <json-file>` before applying it. This command only validates the proposed changes; it does not apply them.

## GitHub operator configuration

Protect the GitHub `production` environment with a `main` branch policy. Use the exact existing target and retain the existing production credentials. CI must not receive production permissions. The release's package publication has only the permissions it needs for GHCR; Azure deployment uses the protected environment and OIDC, not a static Azure client secret.

| Production variable            | Value or requirement                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `AZURE_CLIENT_ID`              | Production **deployment** OIDC identity client ID, not the Storage runtime identity |
| `AZURE_TENANT_ID`              | Existing deployment tenant                                                          |
| `AZURE_SUBSCRIPTION_ID`        | Exact production subscription above                                                 |
| `AZURE_RESOURCE_GROUP`         | Exact production resource group above                                               |
| `AZURE_LOCATION`               | `northeurope`                                                                       |
| `AZURE_NAME_PREFIX`            | `mafiadashboard`                                                                    |
| `AZURE_STORAGE_ACCOUNT_NAME`   | `mafiadata6du4xvao4bfk2`                                                            |
| `AZURE_STORAGE_TABLE_NAME`     | `MafiaEntities`                                                                     |
| `AZURE_STORAGE_CONTAINER_NAME` | `mafia-live`                                                                        |
| `AZURE_STORAGE_PARTITION_KEY`  | `production-v1`                                                                     |

The image-only release reuses the Container App's existing registry and secret references. The GHCR pull credential needs `read:packages` access to the image, not repository-write or package-write permission. The release does not take OAuth credentials, encryption keys or image-pull credentials from GitHub environment secrets, and does not provision or rotate them. Do not put credentials in parameters, source, workflow summaries or diagnostic output.

The production OIDC federation uses the observed immutable subject:

```text
repo:zemskovmm@8973322/mafia-dashboard@1320321469:environment:production
```

The deployment identity needs permission to read the existing target and update its image. The app keeps the distinct Storage identity's client ID for `DefaultAzureCredential`, not the deployment identity, a client secret, an account key or a connection string. Do not widen Azure roles or replace federation to make a release pass. Identity bootstrap and foundation role assignment are separately authorized operations; a Contributor grant alone cannot create role assignments.

## Ingress and callbacks

Container Apps HTTPS ingress remains the sole public app route. Preserve the exact production origin and both existing Google callback URLs:

```text
https://<existing-production-host>/api/auth/google/callback
https://<existing-production-host>/api/music/oauth/callback
```

`TRUST_PROXY_HOPS=1` trusts the rightmost client address from the controlled ingress for the in-process authentication-attempt limiter, not caller-controlled prefixes. Adding another ingress requires a separately validated trust policy; do not enable unbounded proxy trust. A single warm replica is not high availability. See [security and privacy](security-and-privacy.md).

## Local verification

Run the repository quality gate and lint the workflow definitions locally. Compile the retained Azure templates to ignored private files for the template contract checks; compilation is not an Azure apply:

```bash
mkdir -p .AI/azure-release-deployment
az bicep build --file infra/main.bicep --outfile .AI/azure-release-deployment/foundation.json
az bicep build --file infra/app.bicep --outfile .AI/azure-release-deployment/app.json
export AZURE_FOUNDATION_TEMPLATE_PATH="$PWD/.AI/azure-release-deployment/foundation.json"
export AZURE_APP_TEMPLATE_PATH="$PWD/.AI/azure-release-deployment/app.json"
actionlint
npm run test:azure-contracts
npm run check:local
```

`check:local` uses owned Azurite fixtures and needs no PostgreSQL service. If a compiled-template assertion is skipped, do not count it as executed. Never commit `.AI` outputs, deployment parameters containing secrets, or captured backup data. Local results do not prove live GitHub environment settings, registry access, Azure RBAC, or production readiness. Do not dispatch production or Pages just to verify a workflow edit.

## Rollback

If an application rollback is needed, separately authorize an app-only redeployment of a recorded known-good **compatible immutable Azure image digest**. Use the existing production target, origin, runtime identity and exact Storage bindings, with initialization disabled. Verify the restored digest, commit, displayed version and readiness. Rerunning a workflow for an old SHA rebuilds an image and is not an artifact-identical rollback. Keep registry manifests needed by serving or rollback-eligible revisions.

A rollback does not reverse storage writes, restore an earlier snapshot, reset authority, or migrate data. The retired SQL image and configuration are not supported rollback targets; switching to SQL after Azure writes is not lossless. If compatibility is uncertain, preserve the store and decide on data recovery separately.

## Backup and recovery

Preserve existing backup packages, archives and legacy resources. Standard LRS, registry retention and a compatible rollback image are not application-consistent data backups. The [Azure Storage backup and recovery runbook](azure-storage-backup-and-recovery.md) covers typed Table records and referenced Blob bytes, owner-checked write freezes and isolated restore. Its tools are local-only; do not point them at production. Live backup scheduling, retention, recovery objectives and any restore/cutover require separate authorization and qualification. A release does not enable or prove any of them.
