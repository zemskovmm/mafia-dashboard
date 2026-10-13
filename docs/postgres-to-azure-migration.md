# One-time PostgreSQL → Azure business-data migration

This is an **explicit operator tool**, not an application startup task. The initial
Azure release starts empty. Production export/import requires separate operator
authorization; deployment never runs it automatically. Neither migration nor its
execution workflow authorizes a merge, reset or PostgreSQL deletion.

## Approved production execution transport

The manual **One-time PostgreSQL import** workflow
(`.github/workflows/migrate-postgres-to-azure.yml`) runs the existing compiled CLI
in a short-lived Container Apps job in the application's private-network
environment. It is deliberately bound to the reviewed source/target and immutable
application image in `scripts/production-postgres-migration.mjs`; live revision or
image drift refuses instead of silently adopting another release. It is not a
general-purpose migration service.

1. Hold automatic deployment with `AZURE_DEPLOY_ENABLED=false`, recording its
   original value. Both migration and deployment share `azure-production`
   concurrency. Dispatch only the reviewed main commit, using `mode=export` and
   a fresh private archive name `migration-` followed by 32 lowercase hex digits.
   Leave `sha256` empty. The existing production `POSTGRES_PASSWORD` secret is
   supplied only to export; no credentials appear in command arguments or logs.
2. Export verifies TLS and the expected database/backend identity, uses read-only
   SQL, invokes export/validate, and retains the package in the separate private
   archive container. No business records are written to the live target. Check
   the exact job execution outcome and retained receipt/manifest hash; a submitted
   job is not proof of success. Never use GitHub artifacts for the package.
3. Review the package identity, exclusions and counts, then quiesce the live app
   by deactivating its exact serving revision. Dispatch `mode=apply` with the same
   archive and exact approved `sha256`. The controller refuses while any app
   revision is active. The existing importer still independently rejects any
   populated/foreign target and fences partial publication.
4. After complete verified import, reactivate the original app revision and
   verify readiness/version and data readback. Restore/read back the original
   deployment flag. Remove only the owned temporary job after package retention
   and final state are verified; retain the archive and PostgreSQL.

There are no automatic job retries, parallel replicas, app restarts or target
cleanup. An ambiguous Start response requires inspecting the exact job before
another dispatch. Failed/partial imports and their packages must be retained;
do not restore an apparently healthy app over an unverified target. No maintenance
page, public PostgreSQL endpoint, new database user or standing broad permission
is needed. The archive is protected plaintext in private Blob Storage, not an
independent disaster-recovery backup. Runtime staging uses the image's writable,
node-owned `/app/apps/server/.AI`, without changing the app image or running root.

## Runnable interface

From the repository root, the source entrypoint is:

```sh
node --import tsx apps/server/src/migrate-postgres-to-storage.ts --help
```

Compile **from the server workspace**, which keeps its declared dependencies
external (running standalone `tsup` from the repository root bundles CommonJS
`pg` incorrectly):

```sh
npm exec --workspace @mafia/server -- tsup src/migrate-postgres-to-storage.ts --format esm --out-dir dist
node apps/server/dist/migrate-postgres-to-storage.js --help
```

The normal server build should include `src/migrate-postgres-to-storage.ts` among
its entrypoints. Its output belongs in the release image beside `main.js`; it is
never invoked by `main.js`, initialization, deployment or a container entrypoint.
The tool requires the release's ordinary Node dependencies. It does not require a
PostgreSQL server on the Azure application host.

The three operations are deliberately separate:

```sh
node apps/server/dist/migrate-postgres-to-storage.js export \
  --project-root "$PWD" \
  --package "$PWD/.AI/migration-package" \
  --source-file "$PWD/.AI/migration-source.json" \
  --target-file "$PWD/.AI/migration-target.json"

node apps/server/dist/migrate-postgres-to-storage.js validate \
  --project-root "$PWD" \
  --package "$PWD/.AI/migration-package"

node apps/server/dist/migrate-postgres-to-storage.js apply \
  --project-root "$PWD" \
  --package "$PWD/.AI/migration-package" \
  --target-file "$PWD/.AI/migration-target.json" \
  --sha256 APPROVED_MANIFEST_SHA256
```

`export` is the source-side dry run: it reads a consistent snapshot, validates
conversion, and writes a protected package **without accessing or writing the
Azure destination**. `validate` is completely offline and requires no source or
target credentials. `apply` does not connect to PostgreSQL. Successful operations
print a small JSON result with status, SHA-256 and counts, not business rows,
Google subjects, passwords, keys, tokens or SDK request details. Failures have a
nonzero exit status and sanitized diagnostics. Unknown flags are rejected.

Review and explicitly approve the manifest SHA-256 returned by export/validation;
it is mandatory for apply. Checksums bind integrity and operator approval, not an
external signature or proof that an untrusted package's author is trustworthy.

## Explicit configuration and credentials

Configuration files must be owner-owned, regular, single-link files with no
symlinked ancestors and no group/other permissions, normally mode `0600`.
Packages must be new directories under this repository's ignored `.AI`, mode
`0700`; existing packages are never overwritten. No symlinks or foreign package
files are admitted. Files are protected plaintext, **not encrypted**. Keep the
package's personal data under the same retention/access policy as a backup.

Prepare files with a private editor or secret-management mechanism. Never put a
password, storage key or source connection string in argv, logs, a Git-tracked
file or a package manifest. Do not use a production configuration to test this
tool.

Source file shape (the values below are illustrative, not runnable credentials):

```json
{
  "identity": {
    "database": "business_database",
    "schema": "public",
    "serverAddress": "EXPECTED_POSTGRES_BACKEND_ADDRESS",
    "serverPort": 5432
  },
  "connection": {
    "host": "EXPLICIT_POSTGRES_HOST",
    "port": 5432,
    "database": "business_database",
    "user": "READ_ONLY_EXPORT_ROLE",
    "password": "PROVIDED_PRIVATELY",
    "ssl": { "rejectUnauthorized": true }
  }
}
```

`identity` is checked against `current_database()`, `current_schema()`,
`host(inet_server_addr())` and `inet_server_port()` inside the snapshot. The server
address/port are **backend values**, which may differ from a proxy's connection
address/port. Supply the expected values explicitly; do not guess them. A custom
TLS CA may be supplied as `connection.ssl.ca`. Nonloopback sources require
verified TLS. `ssl: false` is accepted only for an explicit `127.0.0.1` fixture.
Every connection field is required, including an explicitly empty password for
an owned trust-authenticated local fixture.

The CLI does not import application configuration or inherit `DATABASE_URL`,
`PG*`, `PGSERVICE`, `PGPASSWORD`, `PGOPTIONS`, `~/.pgpass`, or
`AZURE_STORAGE_CONNECTION_STRING`. The PostgreSQL password callback prevents
`pg`'s empty-password environment/passfile fallback. The reusable library accepts
an explicitly supplied `Pool`; callers are responsible for constructing it
without environment/default credential fallback.

Future live target file shape:

```json
{
  "mode": "managed-identity",
  "accountName": "explicitstorageaccount",
  "tableName": "ExplicitNewTable",
  "containerName": "explicit-new-private-container",
  "partitionKey": "explicit-new-dataset"
}
```

An optional UUID `clientId` selects a user-assigned managed identity; otherwise
use the executing host's system-assigned identity. This path uses
`ManagedIdentityCredential` **only**, not a default credential chain, Azure CLI
login, shared keys, SAS or an environment client secret. The library rejects a
remote `AzureStorage` using a default credential chain; use
`managedIdentityMigrationStorage`. Public Azure HTTPS endpoints are constructed
from the explicit account/resources and recorded without credentials in the
manifest. Other clouds/custom endpoints are not supported by this version.

The local test path instead requires:

```json
{
  "mode": "local",
  "connectionString": "EXPLICIT_OWNED_AZURITE_CONNECTION_STRING",
  "tableName": "UniqueFixtureTable",
  "containerName": "unique-fixture-container",
  "partitionKey": "unique-fixture-dataset"
}
```

Both Table and Blob endpoints must be credential-free HTTP URLs on
`127.0.0.1` with explicit ports and matching account/resource paths. No remote
shared-key/SAS import is supported. Existing Azure-to-Azure backup/restore tools
remain separate and retain their original loopback-only guards.

## Source permission and snapshot boundary

Use a read-only PostgreSQL role with `CONNECT`, schema `USAGE`, and `SELECT` on
the business relations listed below. It does **not** need SELECT on
`user_sessions` or `youtube_oauth_credentials`. Catalog inspection uses
`pg_catalog`, which allows exact schema inventory without reading those records.
No source initializer, schema migration, DDL, seed, UPDATE, DELETE or locking
write is called. All business SELECTs occur in one `REPEATABLE READ READ ONLY`
transaction, with UTC timestamps and a bounded statement timeout.

The tool admits the current relations, exact column types/nullability/order,
expected constraint/index names and validated constraints, and checks exported
values and relationships independently. Unknown/incomplete schemas, policies,
RLS, custom triggers/rules/partitions, unsupported name-bearing game formats,
unknown replay versions, nonrepresentable JSON numbers, unsupported timestamps,
orphan projections, cross-club references and conflicting reservations refuse
before destination writes. No backfill, normalization of canonical identities,
rehashing, automatic repair or schema upgrade is performed.

A **current schema with zero business rows** is supported. An uninitialized or
historical empty schema is not initialized automatically.

The consistent snapshot is not continuous replication. For a later final
migration, separately schedule maintenance that stops all source writers,
complete the final snapshot/import/readback, and explicitly switch application
configuration to the new dataset. Keep the old PostgreSQL database intact. Do
not start application workers or another initializer against the new target
while apply is running. Live RBAC, networking and managed-identity permissions
require later qualification; Azurite does not prove them.

## Included and excluded data

| Source relations                                                 | Target representation                                                                                                                                                                                            |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`                                                          | Original user IDs, account fields/timestamps, Google subject and exact subject/email reservations                                                                                                                |
| `clubs`, `club_memberships`                                      | Original club IDs, creator/settings/timestamps, separately digest-checked logo Blobs, member roles and access-player provenance                                                                                  |
| `players`                                                        | Original opaque IDs, consent/profile fields and dates, account bindings, access, retirement, nickname reservations and result-derived statistics                                                                 |
| `game_sessions`, `game_events`                                   | Original aggregate IDs/revision/status/ruleset, exact JSON values/canonical identity strings and hashes; immutable version-1 session envelope and the actual source API event view, not a regenerated projection |
| `game_session_players`, `game_results`, `game_player_results`    | Actual source participant/result rows, host/player statistics, outcome/date/filter semantics; retained raw result projection metadata                                                                            |
| `game_session_creations`, `deleted_games`, `deleted_clubs`       | Original creation retry mappings and deletion markers/timestamps; deleted-game retries cannot resurrect games                                                                                                    |
| `game_session_mutations`, `game_daily_counters`, `game_rulesets` | Explicit legacy mutation-request/revision mappings, date counters and current ruleset values; no invented new retry or numbering behavior                                                                        |
| `user_sessions`, `youtube_oauth_credentials`                     | **Excluded entirely; their rows are never selected**                                                                                                                                                             |

Source-only aggregate fields and complete API event projection metadata are
retained in the snapshot envelope's `postgres` metadata, outside `session.state`.
Legacy mutation records use explicit club/game-scoped metadata rows
with digest-checked Blobs for JSON requests. Raw result projection metadata is
inside the snapshot envelope. These do not become a new public API
or change ordinary snapshot save semantics. Creation and deletion protection
uses the existing reader/writer keys directly. `migration:source` contains only
source identity/checksum/length provenance, **not** an immutable duplicate of
player/account personal data in the live dataset.

Users sign in afresh and reconnect music. The imported Google subject reservation
binds fresh verified login to the original account ID and memberships; an old
cookie finds no imported session. Canonical UUID strings can retain original
letter case inside snapshots/hashes while structured PostgreSQL UUID row keys
use the database's existing lowercase representation.

`source.json` holds the exact UTF-8 export package and each relation's original
`row_to_json(t)::text` strings. `manifest.json`, written **last**, binds source and
target identity, format/schema checksum, source SHA-256/length, converted typed
entity/blob checksum/counts and exclusions. PostgreSQL JSONB has already lost
pre-JSONB whitespace: this tool preserves stored JSON values and canonical hash
strings plus exact export bytes, **not impossible original HTTP request bytes**.
Sub-millisecond source timestamp spelling remains in the protected package and
retained source metadata; API dates have the same JavaScript Date precision as
the original SQL readers. A lossy JSON numeric conversion is refused, not rounded.

The one-time implementation intentionally bounds the entire source package and
each Blob to 64 MiB. Oversized properties/entities fail validation before apply.
This is not an unbounded streaming migration framework. Table writes are
create-only individual requests, so sources exceeding 100 entities do not cross
Azure's 100-operation/4-MiB group transaction limits.

## Empty target, reservation, readback and interruption

Use a **dedicated empty Table and private empty container**, absent, explicitly
pre-created, or initialized by the application but still completely unused.
The only admitted preexisting row is the exact recognized application control
for this partition/container: schema version 1, a valid dataset UUID, revision 0,
normal write mode and no extra fields. There must be no other rows anywhere in
the Table, no Blobs and no container ownership metadata. Unknown or modified
controls, foreign partitions, public containers and incomplete imports refuse
without alteration. Merely selecting a new partition in a used Table is not
enough. The package is bound to account, endpoints, Table, container and partition;
changing any target requires another export package and approval.

The importer reserves the target with unsupported `schemaVersion: -1` and
`writeMode: postgres-migration-in-progress`. With no control, reservation is
create-only. With the recognized empty control, replacement uses its inspected
ETag: if a concurrent first business write wins, reservation refuses and leaves
that accepted data/control intact, without retrying, merging or resetting it.
Application `ready`/initialization/read/write paths reject a reserved marker.
A short-lived container lease protects ownership-metadata assignment; the
container stays private and bears a package owner marker. Business uploads and
rows are create-only. This is a storage publication fence, not a new browser
dataset-epoch requirement.

Before activation, readback compares **every typed business row and exact
inventory**, every Blob's length/content-type/digest metadata and complete bytes,
and the unchanged reservation. Only then does an ETag-conditional replacement
publish the recognized normal control record. The published target is read back
again before success is reported. Blob URLs never become public.

Any failure leaves original source rows and protected inputs untouched. An
admission/CAS refusal does not replace the preexisting application state; after
reservation, an incomplete target remains unservable. Diagnose the private
package/control marker. There is **no hidden resume/reset/delete/merge path**: use another empty
Table/container and produce another bound package. Cleanup of an abandoned
namespace is a separately authorized operation. A lost activation response is
resolved by exact completion readback, not by blindly resetting the target.

The same successful package can return `already-imported` only while the exact
completed control record, all typed rows, ownership and all Blob bytes still
match. Another package, partial/foreign data, corruption or **any subsequent
business mutation** refuses. No `--force` or nonempty-destination merge exists.
If the freshly deployed empty Azure store has since acquired user data, do not
import over it: choose another empty dataset and separately decide the disposition
of that new data. This tool authorizes neither overwriting it nor combining it.

## Post-import game lifecycle

Later saves preserve the imported `GameRow.createdAt` and optional envelope
`postgres` metadata. The row's `lastMutationId` and the envelope's
`postgres.lastMutationId` / `postgres.updatedAt` follow the newly committed save;
other source-only fields and raw source projection metadata remain retained
provenance rather than newly generated public/canonical game state. Repeated
mutation IDs still obey ordinary last-commit-wins saves, not legacy deduplication.

Clear atomically removes the game and its participant/result projections,
retires its snapshot reference, and publishes the durable deletion tombstone.
It then drains every `club:<clubId>:mutation:<gameId>:` imported retry row in
bounded, paginated groups of at most 40. Each group deletes its rows and records
request-Blob retirements in one fenced Table transaction, with at most 82 actions
including control and receipt. Null-request rows are also removed. History is
never silently truncated or included in the core deletion transaction, so an
unbounded number of imported retries cannot exceed Table's 100-action limit.

If cleanup is interrupted, clear reports a sanitized storage failure; the game
remains deleted, stale saves/creation retries cannot resurrect it, and repeating
clear resumes the remaining history without changing the original tombstone.
Normal clear never physically deletes Blobs. The existing explicit frozen
garbage collector later deletes only unreferenced owned objects, preserving
request Blobs still referenced by another game and retaining protected backup
roots. No new public API, browser epoch enforcement or gameplay validation is
introduced.

## Local qualification and retained inputs

Run the focused suite from the repository root:

```sh
node scripts/test-local.mjs --postgres -- \
  npm run test -w @mafia/server -- \
    src/postgres-storage-migration.test.ts src/azure-game-session-store.test.ts
```

This starts an owned disposable PostgreSQL fixture and the suite starts its own
owned Azurite fixture with fresh credentials/loopback ports. Synthetic packages,
rejected originals, private fixture-only configuration and a compiled CLI remain
under `.AI/migration-test-*`; database/emulator processes and disposable state are
cleaned up. Do not print those private configuration files. Tests use real SQL
and Azure SDK reads/writes, not inferred conversion from Azure backup recovery.

Coverage includes account/access/consent and large logos, partial and completed
snapshots, exact uppercase canonical IDs and replay hashes/replay, API events,
retired identities/statistics/date filtering, tombstones/creation retries,
retained mutation/counter data, source-role credential SELECT denial, zero
business data, more than 100 entities, corrupt/unsupported source and packages,
recognized initialized-empty admission, a concurrent first-write CAS refusal,
foreign/nonempty targets, interrupted writes, incomplete readback, exact rerun,
post-import save provenance, interrupted/resumable cleanup of 125 imported
mutations, shared request-Blob collection, atomic full-roster deletion and
refusal after later writes. The **compiled** CLI executes export, offline
validation, apply and idempotent apply with poisoned inherited PostgreSQL/Azure
configuration to prove explicit configuration use.

Workspace typecheck, targeted ESLint and Prettier checks accompany this suite.
The integration owner runs the ordinary `npm run check:local` gate and wires the
entrypoint into the release build; the focused worker does not run a competing
broad check. Fixture success alone is not evidence of production migration.
