# Azure Storage backup and recovery

## Scope

These tools qualify the Table/private Blob adapter **locally**, using owned Azurite services. They do not back up production. PostgreSQL support and its archive tools are retired; existing archives remain untouched. The Azure deployment configuration does not schedule production backups. Live scheduling, a separate backup storage account and retention remain separately scoped work.

A backup is a completed package of typed Table entities and all referenced immutable Blob bytes. Blob replication, versioning or a copy of only the game snapshots is not an application backup: accounts, permissions, permanent player identities, creation mappings, deletion markers and result projections also matter.

## Local commands

Install the workspace dependencies first. Stop normal `npm run dev` before operating on its persistent local emulator: the operator commands start and own the same loopback service ports for their lifetime, and refuse to adopt an already-running service. They do not load `.env`, inherit Azure connection targets or accept a remote account argument.

```sh
# One bounded, disposable authenticated application recovery drill:
npm run verify:storage-backup

# Inspect the existing local development store (does not initialize/reset it):
npm run storage:backup -- --local --status

# Choose a new package name; existing destinations are never overwritten:
npm run storage:backup -- --local --output .AI/storage-backups/manual-example

# Restore into a NEW explicit namespace, never the development source:
# Replace the sample with a new lowercase UUID for each attempt.
npm run storage:restore -- --local \
  --input .AI/storage-backups/manual-example \
  --target 00000000-0000-4000-8000-000000000002
```

The restore command prints the target Table, container and partition identifiers, dataset ID and fresh data epoch. It does **not** switch the development application to that target. The `MafiaRestore…` Table and `mafia-restore-…` container remain isolated in the owned development emulator; the default source remains unchanged. Reusing a populated target is refused. Never erase a failed target merely to make the command succeed: preserve it, investigate, then use a separately owned fresh namespace for a new attempt.

The recovery drill starts disposable fixtures, never the persistent development service. Its private synthetic backup package is retained under `.AI/storage-backups/` as an actual recovery input. Its owned disposable emulator data is stopped and removed afterwards. No browser or external Google consent session is claimed by the synthetic authentication test.

## Consistency and interrupted captures

All application Table mutations share a conditionally updated control record. Capture changes that record to an owner-tagged `backup-frozen` state. This invalidates old writers' conditional commits; subsequent writes fail retryably while reads remain available. Physical deletion and garbage collection must obey the same exclusion boundary. A late staging upload is not a committed snapshot and cannot become authority through its stale control version.

The exporter preserves application types, including date, binary and Int64, and copies selected blobs exactly. It validates the complete reference graph, counts, lengths and SHA-256 hashes, then publishes the **completed manifest last**. A partial directory without a valid completed manifest is not restorable. The exporter releases only its own freeze; a crash can leave writes frozen. There is no automatic expiry that could admit new writes midway through capture.

To recover an interrupted capture, first stop or establish that the owning capture process is no longer executing. Preserve its partial package. Inspect the exact current owner using `--status`; do not guess or copy an owner from a different store. Then explicitly abort that owner:

```sh
npm run storage:backup -- --local --release-freeze EXACT-OWNER-UUID
```

Wrong-owner release is refused. This is not a force/reset command and is not permission to release a running capture or an in-progress restore. Start a new capture at a new output path after verifying normal state. CLI error handling intentionally omits raw SDK errors because those can contain signed headers, credentials or stored values.

## Restore prerequisites and deliberate differences

- Preserve the entire completed package, including its manifest, typed entity file and content objects. It contains private application data and must remain owner-only; hashes detect damage, not malicious replacement by someone who can rewrite the entire package. Do not commit or publish it.
- Use a compatible application/codec version. Unsupported manifests, broken references, missing/corrupt objects, symlinked package paths and incompatible targets fail closed. Service-generated ETags/timestamps are evidence, not restored application values.
- Preserve original dataset namespace, opaque IDs, application timestamps and exact accepted snapshot bytes. Restore into a different empty Table/container; do not restore over the source or a live deployment.
- Blobs are restored before Table references. The target remains unavailable until all rows/blobs are read back and verified; only then is its normal control state published.
- Web login sessions are deliberately invalidated; users must sign in again. Account identity and access settings remain. Session invalidation is reported separately from backup completeness.
- If encrypted music credentials are present, supply their original protected encryption key through `RECOVERY_MUSIC_ENCRYPTION_KEY` in the restore process environment, using the same format as the application's music encryption configuration. The key is never part of the backup, command arguments or output. Do not substitute a new key: possession of encrypted bytes alone is not recoverability.
- A fresh `dataEpoch` is allocated as recovery metadata. **No browser/outbox epoch enforcement is required.** Old-browser requests remain subject to ordinary authentication, permissions, supported-data and deletion/idempotency checks.

A restore package describes a captured point in time, not unsent browser work or writes accepted after the capture. Ordinary acknowledged commits remain remotely durable through application restarts; disaster-recovery loss depends on separately approved backup frequency and retention.

## One-time game-data normalization boundary

The current target is one engine-independent business-data contract: no `rulesEdition`, `rulesetId`, `rulesetVersion` or equivalent gameplay selector. Storage/serialization versions, dataset identity, revisions, blob checksums and recovery metadata remain operational. [IDD-0005](../.idd/intent/IDD-0005.spec-data-compatibility-and-preservation.md) governs explicit one-time historical normalization; ordinary backup, restore, startup, reads and saves do not decode old rules or convert game representations.

Preserve every game identity/club owner, known result and independently known observation, valid tournament/participant relationships, creation mappings and deletion markers. Do not invent absent fields or recompute historical winners. Retain completed timelines that can be converted faithfully; otherwise preserve the completed facts with a private statistics-only disposition and visible unavailable detail. An active game or unsent draft that cannot be preserved truthfully stops the operation. Only this explicit, verified conversion may replace representation bytes and corresponding hashes; an ordinary recovery package remains an exact capture of its source.

Local preparation and Azurite rehearsal are not production migration completion. Before any production change, require all of:

- Exact target/dataset/control/revision inventory and source-bound dry-run dispositions, including unknown meaningful fields and optional-history omissions; a conforming source receives a verified no-op disposition.
- Separately authorized target-bound write access and an explicitly authorized compatible application release/maintenance sequence. Read access, local implementation approval and cloud configuration access do not authorize writes, permission grants, commits, publication or deployment.
- A complete private checksummed package of typed Table entities and all referenced blob bytes, with isolated restore/readback proof. Preserve encrypted credentials as opaque bytes and retain protected keys separately; no secrets enter commands, logs or manifests intended for publication.
- Quiesced incompatible writers, protected pending-client work, an owned freeze and the existing conditional atomic blob/projection publication protocol. Bind every change to source identities/revisions/digests; stop on changed source, corrupt authority or unknown meaningful data. Read back replacements before retiring references, preserve archives/active roots/receipts, and qualify interruption plus repeated execution as a no-op.
- Real compatible-application/storage readbacks of inventory, partial/full facts, retained timelines, active resume and an authorized save/retry, with original/final private manifests and a retained recoverable source package.

Any temporary predecessor decoder/operator remains private local operational material, not supported runtime compatibility or a new permanent migration component. The local-only commands above remain local-only; no undocumented remote flag or safety-check bypass is implied. Service returns only with matching code and data. Image-only rollback does not prove data compatibility, and restoring a pre-conversion package after subsequent writes would lose them and requires a new recovery decision. These gates describe required live qualification, not an assertion that it has happened.

## Explicit bounded cleanup

There is no automatic Blob lifecycle deletion. Run maintenance only deliberately:

```sh
npm run storage:backup -- --local --collect

# Additionally protect original source references named by retained packages:
npm run storage:backup -- --local --collect \
  --protect .AI/storage-backups/manual-example
```

Maintenance freezes the store, treats committed references and explicit protected references as roots, and removes only qualified retired/unreferenced blobs in the exact owned dataset. It never removes independent package files, another dataset or the PostgreSQL archive. Staging that finishes during cleanup may leave an orphan for a later cycle; it is not a lost acknowledged save. Commit receipts are not swept opportunistically because an interrupted caller may still need exact publication proof.

## Verification and production boundaries

`npm run check:local` runs the canonical checks with isolated Azure fixtures and no PostgreSQL dependency. The Azure suite exercises freeze/write races, typed package integrity, wrong targets, interrupted restore, ownership-safe cleanup, fresh cookie authentication and a subsequent save against restored data. `verify:storage-backup` is one bounded recovery drill, not a replacement for those checks.

Observed timings, manifest hashes, counts and limitations belong in ignored project metadata, not in a claim that production recovery is proven. Local Azurite cannot qualify managed identity permissions, private networking, regional durability, a separate backup account or production recovery time. Software-support retirement does not authorize deleting original PostgreSQL archives or other independent backups.
