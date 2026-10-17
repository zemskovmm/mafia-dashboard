# Azure deployment

La Verdad releases use `.github/workflows/deploy-azure.yml`, GitHub OIDC and immutable GHCR image digests. Azure Table/private Blob Storage is the sole supported backend, with no SQL connection, SQL migration init container, fallback or dual write. The PostgreSQL backend, its Compose deployment and SQL-to-Azure importer are retired; existing SQL data and resources remain untouched. Browser epoch rejection is not a deployment requirement.

## Target and resource ownership

The existing pilot target is subscription `9f0da8f6-9da5-4bef-9738-cb26f2a19e58`, resource group `rg-mafia-dashboard-prod-weu`, region `northeurope`, app `mafiadashboard-app`, environment `mafiadashboard-env`. Preserve the public hostname and Google callback origins. The app remains 0.5 vCPU / 1 GiB, `minReplicas: 1`, `maxReplicas: 1`. One warm replica avoids scale-to-zero but is not high availability.

- `infra/main.bicep` adds a dedicated Standard GPv2 LRS account, its Table/Blob services and empty table/container, user-assigned identity `${namePrefix}-storage`, and Storage Table Data Contributor / Storage Blob Data Contributor roles scoped **only to that account**. These data roles support the adapter's table/container initialization and data access. No account keys or connection string are supplied. TLS 1.2/HTTPS are required, shared-key access and anonymous Blob access are disabled, and the container has `publicAccess: None`.
- Private data means authenticated, non-public Blob content; the account's HTTPS service endpoints remain publicly reachable. This is **not** a private-endpoint deployment. No VNet, subnet, DNS or private-endpoint changes are made. Do not expose the retained private PostgreSQL server to perform this transition.
- `infra/app.bicep` writes **only the Container App**, referencing the existing environment and foundation-managed identity. Both web and `initialize-storage` containers run the same explicit immutable image. The web container always has `STORAGE_PROVIDER=azure` and `AZURE_STORAGE_INITIALIZE=false`.
- Both foundation and app applies use **Incremental**, never Complete. PostgreSQL, its database, platform backups, VNet/subnets, DNS and the existing Container Apps environment are deliberately no longer managed by the Storage foundation; they remain intact. Removing them from the template is not retirement authority. Retained PostgreSQL costs continue.

Record and review the exact Storage account/table/container/partition names before applying the compiled template. The account name is an explicit parameter, not an implicit existing-account lookup. Stop on a collision or unknown namespace; do not adopt, merge or clear it. `infra/parameters.example.json` is a **foundation-only** example, not an executable app parameter file or a secret store.

## GitHub operator configuration

The `production` environment supplies these non-secret variables:

| Variable                       | Value or requirement                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `AZURE_CLIENT_ID`              | Existing **deployment** OIDC identity's client ID; not the application's Storage identity                              |
| `AZURE_TENANT_ID`              | Existing deployment tenant                                                                                             |
| `AZURE_SUBSCRIPTION_ID`        | `9f0da8f6-9da5-4bef-9738-cb26f2a19e58`                                                                                 |
| `AZURE_RESOURCE_GROUP`         | `rg-mafia-dashboard-prod-weu`                                                                                          |
| `AZURE_LOCATION`               | `northeurope`                                                                                                          |
| `AZURE_NAME_PREFIX`            | `mafiadashboard`                                                                                                       |
| `AZURE_STORAGE_ACCOUNT_NAME`   | Operator-selected, globally available, never-used name: 3–24 lowercase letters/digits                                  |
| `AZURE_STORAGE_TABLE_NAME`     | `MafiaEntities` (3–63 alphanumeric characters, beginning with a letter)                                                |
| `AZURE_STORAGE_CONTAINER_NAME` | `mafia-live` (3–63 lowercase letters/digits/hyphens; no adjacent or leading/trailing hyphen)                           |
| `AZURE_STORAGE_PARTITION_KEY`  | Explicit stable namespace, recommended `production-v1`; 1–256 characters, no `/`, `\\`, `#`, `?` or control characters |
| `GHCR_USERNAME`                | Existing registry username                                                                                             |

The workflow requires all four Storage variables, with no SQL or connection-string fallback. Treat a partition change as selection of a different dataset, **not migration**. Do not casually rename the account, table, container or partition on routine releases.

Preserve the existing environment secrets: `GHCR_PULL_TOKEN` (`read:packages`), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MUSIC_TOKEN_ENCRYPTION_KEY`. Keep the existing key for newly stored encrypted music credentials and future recovery. The new workflow no longer consumes `POSTGRES_PASSWORD` or `AZURE_DATABASE_NAME`; retaining those old configuration items does not create a runtime SQL dependency and does not authorize deleting the old database or secret.

`AZURE_DEPLOY_ENABLED` is the **repository-level** automatic-release gate read by job conditions before production-environment initialization. Record its original value and scope, hold it at `false` before publication, and read it back. Manual dispatch with `deploy=true` bypasses this hold. Restore/read back the prior value only after verified acceptance or an explicitly reconciled abort. A production-environment variable alone must not be assumed to hold automatic jobs.

### Deployment identity and application identity are different

The existing OIDC trust uses `mafiadashboard-github` and the federated subject:

```text
repo:zemskovmm@8973322/mafia-dashboard@1320321469:environment:production
```

The existing `scripts/bootstrap-azure-oidc.sh` can bootstrap/repair that trust, but **Contributor alone cannot create role assignments**. Before a foundation apply, the operator must explicitly arrange resource-group-scoped role-assignment creation authority (for example appropriately scoped Role Based Access Control Administrator), or provision the foundation with an authorized operator identity. Do not silently grant Owner/subscription-wide authority or change OIDC trust. App-only releases still need permissions to update the app and attach/use the existing user-assigned identity.

The application receives the Storage identity's `clientId` as **container** `AZURE_CLIENT_ID`; `DefaultAzureCredential` uses it. It receives no deployment OIDC identity, Azure client secret, account key or production connection string. The environment must be a **workload-profile environment with a Consumption profile**: Microsoft supports managed identity in its init containers, unlike legacy consumption-only environments. The workflow checks this prerequisite without changing the environment. See [Container Apps managed identity](https://learn.microsoft.com/en-us/azure/container-apps/managed-identity).

## Initialization and repeat releases

The published server build must contain `apps/server/dist/initialize-storage.js`. That entrypoint loads the explicit Azure config, uses managed identity, retries storage readiness within a bounded wait for RBAC propagation, and exits nonzero with a credential-safe diagnostic on failure. It must never dump Azure SDK error/request objects or seed business accounts, clubs, games or sessions.

- `initialize_storage=false` is the workflow-dispatch default, and every automatic push uses false. The init container validates `ready()` only. Missing/unknown authority fails the revision instead of selecting PostgreSQL or silently creating another dataset.
- Set `initialize_storage=true` **only for the approved, independently verified empty target**. The init container invokes the existing `initialize(true)` path: create the recognized control/schema authority if absent, refuse unrecognized Table rows, then verify readiness. Infrastructure creates only an empty table and private container. A control row/dataset UUID is operational metadata, not business seed.
- Existing recognized state is never reset, even when initialization is explicitly requested again. Routine release with false leaves business rows, canonical blobs and dataset identity untouched. There is no importer or authority to clear a populated target.
- Readiness verifies authority and private-container access; it is not proof of a full write/read/delete roundtrip or an empty business dataset. An operator must verify initial emptiness and a bounded disposable-namespace data probe separately. Current initialization does not inspect arbitrary orphan blobs; the never-used dedicated-account precondition remains important.

## Release flow and safety gates

Pushes to `main` publish/deploy only when the repository flag is `true`; pull requests retain their separate CI. Manual dispatch always permits publishing:

| Inputs                                       | Effect                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| `deploy=false`                               | Publish only; no Azure login/apply, regardless of other inputs                      |
| `deploy=true`, `deploy_infrastructure=false` | Deploy app; automatically detect whether the Storage foundation must be applied     |
| `deploy=true`, `deploy_infrastructure=true`  | Explicit foundation reconciliation, still incremental and collision/what-if guarded |
| `deploy=true`, `initialize_storage=true`     | Explicit first empty-store initialization; not import/reset                         |

Publication builds Linux `amd64`, bakes the full Git SHA and workflow build index into the image, pushes its commit tag, verifies the pushed manifest digest through registry readback, and passes only `ghcr.io/...@sha256:...` to deployment. Rebuilding a SHA is not proof of the same artifact. Package-write and OIDC permissions remain job-scoped, actions remain immutable-SHA pinned, and the whole release remains serialized with `cancel-in-progress: false`.

Foundation detection fingerprints sorted Bicep/workflow/helper bytes and non-secret subscription/RG/location/prefix/Storage namespace inputs. Secrets are not hashed. The stable successful `mafia-foundation` deployment record holds the fingerprint and target/resource outputs. App-only is allowed only after matching state/fingerprint/target outputs and existence of all recorded foundation resources. Resource GETs use each Bicep type's explicit API version, including account-scoped RBAC extension IDs. Missing/failed/changed records or missing resources require apply; authorization, network or malformed responses fail closed. External drift still requires operator review; a fingerprint is not a complete drift detector.

The workflow checks the existing subscription/app/environment, refuses unknown account adoption, validates foundation inputs and rejects foundation what-if deletions or writes to retained SQL/network/environment resources. It applies the foundation incrementally, reads back the exact successful record, and then deploys the app to its **existing** canonical HTTPS hostname. It does not recreate a missing target or invent a replacement hostname. Initialization must succeed before web startup. Release readback requires the expected image in both containers, one replica, port 3000, the exact Storage identity/namespace/provider and absence of SQL/connection-string env. Existing `/health/ready` and `/health/version` checks still require the expected commit and composed version.

### Approved first cutover checklist

1. Confirm subscription, RG, app/environment identity, old private SQL resources and rollback-eligible SQL image/config without printing credentials. Confirm workload-profile init identity support and foundation RBAC authority. Stop on drift or destructive what-if.
2. Hold/read back repository `AZURE_DEPLOY_ENABLED=false`, qualify the dependency-complete local candidate, and publish only after final local checks/review. Preserve the old SQL app while adding the Storage foundation incrementally.
3. Select/read back all four new Storage variables. Verify the exact never-used account name is globally available, inspect compiled resource identities/namespace and what-if, then provision the foundation. No table rows/blobs or business seed are created by Bicep. Read back account/namespace, identity, role scopes and unchanged PostgreSQL/network resources.
4. Publish and record the exact verified commit/image digest. Dispatch that qualified ref with `deploy=true`, `initialize_storage=true`. Do not infer artifact identity from the commit tag or a later rebuild. Require bounded initialization, readiness and matching commit/version.
5. Verify the serving revision uses Azure and managed identity, the business dataset is empty, old SQL-serving revisions cannot serve traffic, and an explicitly disposable namespace can write/read/delete a small Table/Blob probe. Never use a real account/game as the probe and never clear business data to restore emptiness. Fresh-login/new-club behavior is covered by local retained HTTP tests; no broad live-browser audit is added by this deployment.
6. Run a routine release with `initialize_storage=false` and confirm no dataset reset. Read back remote SHA/workflow/digest/active traffic, unchanged SQL resources and the restored automatic-release flag. Report live gaps distinctly from local qualification. There is no deferred production import workflow.

## Local compiled verification

Use ignored, private repository-local `.AI` outputs, not adjacent tracked JSON files:

```bash
mkdir -p .AI/azure-release-deployment
az bicep build --file infra/main.bicep --outfile .AI/azure-release-deployment/foundation.json
az bicep build --file infra/app.bicep --outfile .AI/azure-release-deployment/app.json
export AZURE_FOUNDATION_TEMPLATE_PATH="$PWD/.AI/azure-release-deployment/foundation.json"
export AZURE_APP_TEMPLATE_PATH="$PWD/.AI/azure-release-deployment/app.json"
npm run test:azure-contracts
actionlint .github/workflows/deploy-azure.yml
npm run check:local
```

Both compiled-template assertion groups must execute with these actual paths; skipped optional assertions are not release evidence. `check:local` owns disposable Azurite qualification with no PostgreSQL service or tool prerequisite. Compilation and local fixtures do **not** prove live Azure RBAC/readiness or production empty-store acceptance. Never commit `.AI`, local deployment parameter files with secrets, or captured backup data. Use the [v1.0.0 release checklist](releases/v1.0.0.md) for remaining exact-candidate gates; local Azure recovery qualification does not prove production backup automation exists.

## Ingress, callbacks and workflow limits

Container Apps HTTPS ingress is the sole public app route. `TRUST_PROXY_HOPS=1` trusts only its rightmost supplied client address for the in-process authentication-attempt limiter, not caller-controlled addresses to the left. Adding a CDN/Front Door/other ingress needs a separate validated policy; do not enable unbounded proxy trust. The limiter and session assumptions remain single-replica. See [Container Apps ingress headers](https://learn.microsoft.com/azure/container-apps/ingress-overview#http-headers).

Keep both exact Google callback URLs authorized at the unchanged origin:

```text
https://<existing-container-app-host>/api/auth/google/callback
https://<existing-container-app-host>/api/music/oauth/callback
```

The deployment workflow intentionally does not repeat local formatting/lint/typecheck/tests or vulnerability scans before a main release. Perform the canonical local check/review before publication; a green build alone is not qualification. See [security and privacy](security-and-privacy.md). On activation failure, capture `initialize-storage` logs early: failed init replicas may disappear before the verifier's diagnostic tail is available.

## Recovery, costs and deferred work

No historical data is imported and no new production backup scheduler is configured. Existing backups and private SQL source/resources remain untouched. Local Azure backup/restore tooling and recovery hooks are preserved; see [Azure Storage backup and recovery](azure-storage-backup-and-recovery.md). Passing local recovery drills does not mean a production backup job is operating. Standard LRS is not an application-consistent backup or regional HA.

The historical SQL image/config is not a supported rollback target for this application. Switching back to SQL after Azure writes is **not lossless**: preserve all data and stop for an explicit recovery decision. For a routine Azure application rollback, redeploy the recorded known-good compatible Azure image digest through `infra/app.bicep` with `initializeStorage=false` and the identical namespace. Neither rollback nor forced foundation reconciliation may restore, rename, reset or delete data automatically. Do not delete manifests still needed by serving or rollback-eligible revisions.

Costs include the warm Container App, Storage requests/capacity/egress and any retained PostgreSQL/network estate. This pilot remains single-region/non-HA. Infrastructure decommissioning, production backup scheduling and any private-endpoint redesign require separate authorized work; removing SQL support does not remove its external resources or costs.
