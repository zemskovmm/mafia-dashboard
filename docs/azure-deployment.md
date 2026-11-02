# Azure deployment

La Verdad releases deploy automatically to **staging** on pushes to `main`. Production deploys only through **Actions → Deploy production → Run workflow**. That action promotes an already verified staging image by immutable digest; it does not rebuild the application or copy staging data. The separate public website keeps its independent manual GitHub Pages workflow. See IDD-0009 for the release-environment contract.

Both environments use GitHub OIDC and Azure Table/private Blob Storage as the sole supported backend, with no SQL connection, SQL migration init container, fallback or dual write. The PostgreSQL backend, its Compose deployment and SQL-to-Azure importer are retired; existing SQL data and resources remain untouched. Browser epoch rejection is not a deployment requirement.

## Target and resource ownership

The environments share subscription `9f0da8f6-9da5-4bef-9738-cb26f2a19e58` and region `northeurope`, but not application instances, storage accounts or identities:

| Target              | Staging                          | Production                    |
| ------------------- | -------------------------------- | ----------------------------- |
| Resource group      | `rg-mafia-dashboard-staging-neu` | `rg-mafia-dashboard-prod-weu` |
| Name prefix         | `mafiadashboard-stg`             | `mafiadashboard`              |
| Container App       | `mafiadashboard-stg-app`         | `mafiadashboard-app`          |
| Managed environment | `mafiadashboard-stg-env`         | `mafiadashboard-env`          |
| Storage account     | `mafiastg6du4xvao4bfk2`          | `mafiadata6du4xvao4bfk2`      |
| Partition           | `staging-v1`                     | `production-v1`               |
| Deployment identity | `mafiadashboard-stg-github`      | `mafiadashboard-github`       |
| Runtime identity    | `mafiadashboard-stg-storage`     | `mafiadashboard-storage`      |

Each account has its own `MafiaEntities` table and private `mafia-live` container. Staging starts empty and retains its test records across releases; no production account, club, session, game, uploaded asset or OAuth token is cloned. Identity scopes prohibit cross-environment data access. This is application-data isolation, not isolation from authorized subscription/repository administrators.

Preserve production's public hostname and Google callback origins. Both apps use 0.5 vCPU / 1 GiB, `minReplicas: 1`, `maxReplicas: 1`. One warm replica avoids scale-to-zero but is not high availability.

- `infra/main.bicep` adds a dedicated Standard GPv2 LRS account, its Table/Blob services and empty table/container, user-assigned identity `${namePrefix}-storage`, and Storage Table Data Contributor / Storage Blob Data Contributor roles scoped **only to that account**. These data roles support the adapter's table/container initialization and data access. No account keys or connection string are supplied. TLS 1.2/HTTPS are required, shared-key access and anonymous Blob access are disabled, and the container has `publicAccess: None`.
- Private data means authenticated, non-public Blob content; the account's HTTPS service endpoints remain publicly reachable. This is **not** a private-endpoint deployment. No VNet, subnet, DNS or private-endpoint changes are made. Do not expose the retained private PostgreSQL server to perform this transition.
- `infra/app.bicep` writes **only the Container App**, referencing the existing environment and foundation-managed identity. Both web and `initialize-storage` containers run the same explicit immutable image. The web container always has `STORAGE_PROVIDER=azure` and `AZURE_STORAGE_INITIALIZE=false`.
- `infra/staging-environment.bicep` is a separately invoked first-time staging bootstrap: it creates only the workload-profile Consumption environment and its Log Analytics workspace. Routine application/foundation workflows do not own it. Invoke it only in the explicit staging resource group, in Incremental mode.
- Both foundation and app applies use **Incremental**, never Complete. PostgreSQL, its database, platform backups, VNet/subnets, DNS and the existing Container Apps environment are deliberately no longer managed by the Storage foundation; they remain intact. Removing them from the template is not retirement authority. Retained PostgreSQL costs continue.

Record and review the exact Storage account/table/container/partition names before applying the compiled template. The account name is an explicit parameter, not an implicit existing-account lookup. Stop on a collision or unknown namespace; do not adopt, merge or clear it. `infra/parameters.example.json` is a **foundation-only** example, not an executable app parameter file or a secret store.

## GitHub operator configuration

The `staging` and `production` GitHub environments each supply their own non-secret variables. Use the exact targets above; the deployment helper rejects wrong-environment bindings. Protect each environment with a `main` branch policy.

| Variable                       | Value or requirement                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `AZURE_CLIENT_ID`              | Matching environment's **deployment** OIDC identity client ID; not the application's Storage identity |
| `AZURE_TENANT_ID`              | Existing deployment tenant                                                                            |
| `AZURE_SUBSCRIPTION_ID`        | `9f0da8f6-9da5-4bef-9738-cb26f2a19e58`                                                                |
| `AZURE_RESOURCE_GROUP`         | Exact environment resource group from the table above                                                 |
| `AZURE_LOCATION`               | `northeurope`                                                                                         |
| `AZURE_NAME_PREFIX`            | Exact environment name prefix from the table above                                                    |
| `AZURE_STORAGE_ACCOUNT_NAME`   | Exact dedicated account from the table above; never adopt an unknown existing account                 |
| `AZURE_STORAGE_TABLE_NAME`     | `MafiaEntities` (3–63 alphanumeric characters, beginning with a letter)                               |
| `AZURE_STORAGE_CONTAINER_NAME` | `mafia-live` (3–63 lowercase letters/digits/hyphens; no adjacent or leading/trailing hyphen)          |
| `AZURE_STORAGE_PARTITION_KEY`  | Exact `staging-v1` or `production-v1` namespace from the table above                                  |
| `GHCR_USERNAME`                | Existing registry username                                                                            |

The workflow requires all four Storage variables, with no SQL or connection-string fallback. Treat a partition change as selection of a different dataset, **not migration**. Do not casually rename the account, table, container or partition on routine releases.

Each environment supplies protected `GHCR_PULL_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `MUSIC_TOKEN_ENCRYPTION_KEY` secrets. Staging needs a `read:packages`-only image-pull token, its own Google web client and callback URLs, and an independently generated 32-byte base64url encryption key. Verify a registry credential's actual scopes instead of trusting its name. Do not give staging a repository-write token. Preserve production's existing OAuth credentials and encryption key; do not rotate them as part of staging setup. Neither environment's workflow consumes `POSTGRES_PASSWORD` or `AZURE_DATABASE_NAME`; retaining those old items does not create a runtime SQL dependency or authorize deleting old resources.

`AZURE_STAGING_DEPLOY_ENABLED` is the **repository-level** automatic-staging gate. Set it to `true` only after staging is provisioned and qualified. Set repository variable `AZURE_STAGING_APP_URL` to the exact staging HTTPS origin without a trailing slash; the production selector uses it to confirm the current release. The obsolete `AZURE_DEPLOY_ENABLED` must remain `false`; the new workflows do not use it and there is no automatic-production gate to enable. A protected-environment variable alone cannot control jobs before that environment is selected.

### Deployment identity and application identity are different

The distinct OIDC trusts use these exact observed immutable subjects:

```text
repo:zemskovmm@8973322/mafia-dashboard@1320321469:environment:production
repo:zemskovmm@8973322/mafia-dashboard@1320321469:environment:staging
```

`scripts/bootstrap-azure-oidc.sh` requires explicit subscription, tenant, resource group, identity name, `GITHUB_REPOSITORY`, `GITHUB_ENVIRONMENT` and `GITHUB_FEDERATED_SUBJECT`. It refuses mismatched targets or existing conflicting federation rather than replacing trust. It grants only matching-resource-group Contributor and verifies the provider/GitHub readbacks. **Contributor alone cannot create role assignments.** Provision initial foundation roles with an authorized operator, then restrict any workflow RBAC-administration grant to the matching Storage account, exact runtime principal and Table/Blob Contributor roles. Do not grant Owner/subscription-wide authority. App-only releases still need permission to update the matching app and attach/use its identity.

The application receives the Storage identity's `clientId` as **container** `AZURE_CLIENT_ID`; `DefaultAzureCredential` uses it. It receives no deployment OIDC identity, Azure client secret, account key or production connection string. The environment must be a **workload-profile environment with a Consumption profile**: Microsoft supports managed identity in its init containers, unlike legacy consumption-only environments. The workflow checks this prerequisite without changing the environment. See [Container Apps managed identity](https://learn.microsoft.com/en-us/azure/container-apps/managed-identity).

## Initialization and repeat releases

The published server build must contain `apps/server/dist/initialize-storage.js`. That entrypoint loads the explicit Azure config, uses managed identity, retries storage readiness within a bounded wait for RBAC propagation, and exits nonzero with a credential-safe diagnostic on failure. It must never dump Azure SDK error/request objects or seed business accounts, clubs, games or sessions.

- `initialize_storage=false` is the workflow-dispatch default, and every automatic push uses false. The init container validates `ready()` only. Missing/unknown authority fails the revision instead of selecting PostgreSQL or silently creating another dataset.
- Set `initialize_storage=true` **only for the approved, independently verified empty target**. The init container invokes the existing `initialize(true)` path: create the recognized control/schema authority if absent, refuse unrecognized Table rows, then verify readiness. Infrastructure creates only an empty table and private container. A control row/dataset UUID is operational metadata, not business seed.
- Existing recognized state is never reset, even when initialization is explicitly requested again. Routine release with false leaves business rows, canonical blobs and dataset identity untouched. There is no importer or authority to clear a populated target.
- Readiness verifies authority and private-container access; it is not proof of a full write/read/delete roundtrip or an empty business dataset. An operator must verify initial emptiness and a bounded disposable-namespace data probe separately. Current initialization does not inspect arbitrary orphan blobs; the never-used dedicated-account precondition remains important.

## Release flow and safety gates

`.github/workflows/deploy-azure.yml` (**Deploy staging**) publishes/deploys pushes to `main` only when `AZURE_STAGING_DEPLOY_ENABLED=true`; pull requests retain their separate CI. Its manual dispatch always permits publishing and affects staging only:

| Inputs                                       | Effect                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| `deploy=false`                               | Publish only; no Azure login/apply, regardless of other inputs                      |
| `deploy=true`, `deploy_infrastructure=false` | Deploy app; automatically detect whether the Storage foundation must be applied     |
| `deploy=true`, `deploy_infrastructure=true`  | Explicit foundation reconciliation, still incremental and collision/what-if guarded |
| `deploy=true`, `initialize_storage=true`     | Explicit first empty-store initialization; not import/reset                         |

Publication builds Linux `amd64`, bakes the full Git SHA and workflow build index into the image, pushes its commit tag, verifies the pushed manifest digest through registry readback, and passes only `ghcr.io/...@sha256:...` to the environment-bound reusable deployment workflow. Rebuilding a SHA is not proof of the same artifact. Package-write and OIDC permissions remain job-scoped, actions remain immutable-SHA pinned, and staging/production share one serialized release group with `cancel-in-progress: false`.

### Deploy production with the GitHub button

1. Test the staged release and confirm its staging workflow succeeded.
2. Open **Actions → Deploy production → Run workflow**, leaving branch **main** selected.
3. Leave `staging_run_id` blank to select the currently verified staging release, or enter an exact successful staging run ID to select a previously verified release.
4. The selection job freezes and displays the original run, commit, version and image digest. Production deploys that digest with production configuration and data; it does not rebuild or initialize Storage.

`.github/workflows/deploy-production.yml` has only `workflow_dispatch`, no push/schedule/staging-success trigger. The selector validates successful trusted-main run metadata, attempt-specific immutable artifact contents and digest, commit/build/version identity and registry availability. Default selection also checks live staging readiness/version; a newer failed, incomplete or publish-only run blocks it rather than silently choosing an older release. Concurrent staging updates cannot substitute an image after selection. Explicit historical selection does not require that release to still be served on staging.

Verified staging records are retained as `staging-release-RUN_ID-ATTEMPT` artifacts for 90 days. Expired/missing evidence or an unavailable image blocks promotion. This retention is not a data backup; preserve registry images required by serving or rollback-eligible releases. Merely publishing the button is not evidence that a production promotion has run.

Foundation detection fingerprints sorted Bicep/workflow/helper bytes and non-secret subscription/RG/location/prefix/Storage namespace inputs. Secrets are not hashed. The stable successful `mafia-foundation` deployment record holds the fingerprint and target/resource outputs. App-only is allowed only after matching state/fingerprint/target outputs and existence of all recorded foundation resources. Resource GETs use each Bicep type's explicit API version, including account-scoped RBAC extension IDs. Missing/failed/changed records or missing resources require apply; authorization, network or malformed responses fail closed. External drift still requires operator review; a fingerprint is not a complete drift detector.

The workflow checks the existing subscription/app/environment, refuses unknown account adoption, validates foundation inputs and rejects foundation what-if deletions or writes to retained SQL/network/environment resources. It applies the foundation incrementally, reads back the exact successful record, and then deploys the app to its **existing** canonical HTTPS hostname. It does not recreate a missing target or invent a replacement hostname. Initialization must succeed before web startup. Release readback requires the expected image in both containers, one replica, port 3000, the exact Storage identity/namespace/provider and absence of SQL/connection-string env. Existing `/health/ready` and `/health/version` checks still require the expected commit and composed version.

Verification runs **after** the application has been applied: a failed verification step does not roll back the release. Configuration failures name the mismatched check without dumping container environment values. The jq verifier binds identity and environment variables before boolean assertions so its meaning stays the same on jq 1.7 and 1.8; jq 1.8 changed the precedence of `as` relative to boolean operators. Do not suppress verification failures or accept readiness without the exact release identity.

### First-time staging setup checklist

1. Record the production image, version and data bindings without reading business data or secrets. Disable/read back legacy `AZURE_DEPLOY_ENABLED=false` and reconcile any active legacy run before publishing changed routing. Never restore automatic production.
2. Verify the staging account name is unused, create only the dedicated staging resource group, and inspect compiled templates/what-if. Apply `infra/staging-environment.bicep` and `infra/main.bicep` separately in Incremental mode. Record the successful foundation as `mafia-foundation`; routine workflows refuse to adopt an unrecorded existing account.
3. Configure the staging-only OIDC identity, exact account-scoped runtime data roles, restricted foundation role administration and main-only GitHub environment. Set its own variables and protected credentials. Do not copy production data or reuse production encryption/OAuth secrets.
4. Verify the new table and private container are empty, then explicitly create the first staging app with a recorded known-good immutable image and `initializeStorage=true`. Use its generated HTTPS origin for staging-only Google auth/music callbacks. Read back all bindings and readiness, then deploy with initialization false. Ordinary release workflows require this first app/environment/FQDN to exist; they do not invent replacement targets.
5. Qualify and publish the workflow changes, set/read back `AZURE_STAGING_APP_URL` and enable `AZURE_STAGING_DEPLOY_ENABLED`. Observe an actual automatic staging deployment and exact image/commit/version readback. Exercise staging-only test-data persistence across a routine deployment and verify staging identity cannot access production data.
6. Verify production is still on its original image and data namespace. Hand off the production button without dispatching it; the first production release remains Michael's explicit action. Report OAuth/browser or runtime checks not performed separately from successful configuration checks.

## Local compiled verification

Use ignored, private repository-local `.AI` outputs, not adjacent tracked JSON files:

```bash
mkdir -p .AI/azure-release-deployment
az bicep build --file infra/main.bicep --outfile .AI/azure-release-deployment/foundation.json
az bicep build --file infra/app.bicep --outfile .AI/azure-release-deployment/app.json
az bicep build --file infra/staging-environment.bicep --outfile .AI/azure-release-deployment/staging-environment.json
export AZURE_FOUNDATION_TEMPLATE_PATH="$PWD/.AI/azure-release-deployment/foundation.json"
export AZURE_APP_TEMPLATE_PATH="$PWD/.AI/azure-release-deployment/app.json"
export AZURE_STAGING_ENVIRONMENT_TEMPLATE_PATH="$PWD/.AI/azure-release-deployment/staging-environment.json"
npm run test:azure-contracts
npm run test:release-contracts
actionlint .github/workflows/deploy-azure.yml .github/workflows/deploy-azure-release.yml .github/workflows/deploy-production.yml
npm run check:local
```

Both compiled-template assertion groups must execute with these actual paths; skipped optional assertions are not release evidence. `check:local` owns disposable Azurite qualification with no PostgreSQL service or tool prerequisite. Compilation and local fixtures do **not** prove live Azure RBAC/readiness or production empty-store acceptance. Never commit `.AI`, local deployment parameter files with secrets, or captured backup data. Use the [v1.0.0 release checklist](releases/v1.0.0.md) for remaining exact-candidate gates; local Azure recovery qualification does not prove production backup automation exists.

## Ingress, callbacks and workflow limits

Container Apps HTTPS ingress is the sole public app route. `TRUST_PROXY_HOPS=1` trusts only its rightmost supplied client address for the in-process authentication-attempt limiter, not caller-controlled addresses to the left. Adding a CDN/Front Door/other ingress needs a separate validated policy; do not enable unbounded proxy trust. The limiter and session assumptions remain single-replica. See [Container Apps ingress headers](https://learn.microsoft.com/azure/container-apps/ingress-overview#http-headers).

Keep both exact Google callback URLs authorized on each environment's own web client. Preserve the production origin; staging must use its distinct origin:

```text
https://<matching-container-app-host>/api/auth/google/callback
https://<matching-container-app-host>/api/music/oauth/callback
```

The deployment workflow intentionally does not repeat local formatting/lint/typecheck/tests or vulnerability scans before a main release. Perform the canonical local check/review before publication; a green build alone is not qualification. See [security and privacy](security-and-privacy.md). On activation failure, capture `initialize-storage` logs early: failed init replicas may disappear before the verifier's diagnostic tail is available.

## Recovery, costs and deferred work

No historical data is imported and no new production backup scheduler is configured. Existing backups and private SQL source/resources remain untouched. Local Azure backup/restore tooling and recovery hooks are preserved; see [Azure Storage backup and recovery](azure-storage-backup-and-recovery.md). Passing local recovery drills does not mean a production backup job is operating. Standard LRS is not an application-consistent backup or regional HA.

The historical SQL image/config is not a supported rollback target for this application. Switching back to SQL after Azure writes is **not lossless**: preserve all data and stop for an explicit recovery decision. For a routine Azure application rollback, redeploy the recorded known-good compatible Azure image digest through `infra/app.bicep` with `initializeStorage=false` and the identical namespace. Neither rollback nor forced foundation reconciliation may restore, rename, reset or delete data automatically. Do not delete manifests still needed by serving or rollback-eligible revisions.

Costs include both warm Container Apps, separate Storage requests/capacity/egress, staging log ingestion and any retained PostgreSQL/network estate. Both environments remain single-region/non-HA. Infrastructure decommissioning, production backup scheduling and any private-endpoint redesign require separate authorized work; removing SQL support does not remove its external resources or costs.
