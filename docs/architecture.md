# Architecture

La Verdad is a TypeScript npm workspace with three primary application boundaries:

- `apps/web/` is the React/Vite browser application for club setup and moderated play.
- `apps/server/` is the Fastify API and static host. It owns authentication, club isolation, and Azure Table + private Blob Storage persistence for local development and Azure deployment.
- `packages/game-domain/` contains framework-independent Club Mafia rules, canonical events, and replay logic.

The browser owns game rules, setup checks, and semantic replay. The first meaningful setup change creates a server-backed game record and receives its server-generated GUID before role draws begin; subsequent full-snapshot updates address that GUID. Managers and regular club members may list, open, create, save and delete game records in their own club. Club and player-profile administration remain manager-only. The server checks authentication, club membership, transport shape and identity references, preserves club isolation, and stores the client snapshot without validating game-rule legality or replay hashes. Concurrent updates are last-write-wins; there are no host claims or client revision fences. These boundaries are owned by [IDD-0001](../.idd/intent/IDD-0001.spec-club-access-and-player-identity.md) and [IDD-0004](../.idd/intent/IDD-0004.spec-game-records-and-continuity.md).

A club may have multiple active games. The client lists and opens those server records without takeover, and permanently deletes a selected game through the same club-scoped API. Updates never create missing records, so a deleted game cannot be resurrected by a late save. There are no game claims, heartbeats, expiry or stale-writer fencing. New games require a server response before play; existing games retain offline save retries. Deletion is acknowledged only after the server succeeds, and another client discovers deletion on its next request.

For nomination/support input, preflight `setNominationSelection` against the displayed current speaker. If it returns the same game object, record no action: canonical `nomination.selection-set` admission rejects no-op relation updates. Accepted corrections change only that speaker's relationship and must not discard later unrelated events.

## Persistence

The accepted storage decision is [IDD-0006](../.idd/intent/IDD-0006.adr-azure-table-and-blob-persistence.md). Azure is the sole backend, with no SQL fallback or dual writes. Readiness, authentication, club access, profiles, games, music credentials and maintained verification do not require PostgreSQL.

Azure Tables hold typed account/session/access/profile records, game heads, creation mappings, deletion markers and bounded participant/result projections. Private immutable blobs hold exact game revision envelopes (including any retained projected event view) and large club logos. The complete accepted active snapshot remains the live recovery authority; projections cannot rewrite canonical hashes or reconstruct missing setup fields. Completed records may contain minimal/partial accepted facts without a full snapshot or timeline. Known facts remain usable independently of missing observations; available timelines are separately validated and read-only. Missing/corrupt authoritative storage is still an error, not an empty or older-revision fallback. No Table row is created for each canonical event.

All structured records share one persisted application partition. Each transaction conditionally updates a control row and publishes its related changes atomically. A private blob is uploaded and verified before its pointer is published; an exact atomic commit receipt proves publication, including a lost response followed by another writer's commit. Saves are acknowledged only after remote proof. Internal CAS retries recheck permissions and identities and preserve last-commit-wins; they do not introduce client revision fencing. Combined reads verify a stable control ETag around Table pages and selected blobs.

Large or arbitrary payloads stay in blobs; Table records use scalar/date/binary properties with nullable values omitted through full replacement. Azure's 100-operation and 4-MiB transaction bounds include the control and receipt. Over-limit operations fail without partial publication. The SDK's batch-delete API has no per-delete ETag option; its deletion group is fenced by the same conditional control update. This relies on every application writer using the adapter rather than directly changing business entities.

Game deletion retains its original creation mapping and a tombstone. Player retirement checks active full snapshots, including incomplete setup. Club deletion first makes the club unavailable, then purges its owned entities/assets in bounded resumable steps. Retired blob references are tracked separately for later cleanup; no independent archive is deleted as a side effect.

Local Azure development uses an owned loopback Azurite fixture under ignored `.AI/`, with a stable development namespace and disposable isolated test namespaces. The canonical check wrapper and real local API/browser verifier use owned Azure fixtures. Production configuration uses the named Azure account and server identity, not emulator credentials. Explicit initialization can create an empty dataset; unknown schemas and nonempty unrecognized state fail closed without reset.

**Support boundary:** PostgreSQL runtime/reference support, its Compose deployment and SQL-to-Azure import tooling are removed. Existing databases, archives and external infrastructure remain intact; support removal is not data-erasure authority. No special browser-epoch rejection is required. Local Azure backup/restore tooling does not configure production scheduling or qualify live disaster recovery. Azurite is not proof of live RBAC, networking or availability. Consistent backups must cover both Table records and referenced blob bytes; storage replication alone is not backup.

## Current rules and one-time data normalization

The application has one current gameplay/replay implementation. Persisted business data contains no `rulesEdition`, `rulesetId`, `rulesetVersion` or equivalent engine selector, and UI/history/statistics have no old/current edition categories. Serialization/storage versions, dataset identity, revisions, transport checksums, recovery epochs and the Elo calculation identifier remain operational/data-shape metadata, never rule dispatch. The dated rules source is documentation, not a game property.

Factual statistics use observation-specific denominators; unknown values are not fabricated zeroes, dates, losses or roles, and missing unrelated fields do not erase known facts. Rating eligibility is separate from factual validity. [IDD-0007](../.idd/intent/IDD-0007.spec-club-statistics-and-rating.md) retains the complete lifetime Elo and tournament-delta algorithm, removing only edition-based exclusion. Active resume, secrecy, canonical parent/sequence/lifecycle/hash checks, Undo, unresolved local work, UUID semantics and deletion/creation idempotency remain required.

[IDD-0005](../.idd/intent/IDD-0005.spec-data-compatibility-and-preservation.md) permits explicit one-time historical normalization outside normal startup/read/save paths. Private local operational material may decode predecessor inputs solely for this bounded conversion; no old engine, automatic repair or persistent compatibility service is shipped. Preserve every game identity/ownership, known fact and valid relationship, retain faithful usable completed timelines, and use a statistics-only disposition only for unconvertible optional completed detail. Incompatible active/unsent state, changed source, corrupt authority or unknown meaningful fields stop the operation. Explicit verified representation conversion may replace immutable envelopes and corresponding hashes through the existing atomic publication protocol; ordinary persistence never does.

Production conversion is not established by local implementation. It needs exact target/revision inventory and dry-run dispositions, separately authorized writes, a complete private typed-Table/referenced-Blob backup with isolated restore/readback proof, and an explicitly authorized compatible app/data maintenance sequence. Quiesce incompatible writers without losing pending work, retain recovery originals, qualify interruption and repeat no-op behavior, and read back the exact converted targets. Existing local-only recovery commands remain local-only. An image rollback alone does not restore data compatibility; pre-conversion restore after subsequent writes needs a new recovery decision. See [backup and recovery](azure-storage-backup-and-recovery.md).

## Lighting renderer

The web client has two supported lighting renderers:

- **Raytracing on** selects V-GPU, the default persisted preference. This is a UI label for shader-based illumination, not physical ray tracing. Its shared runtime registers separate player-card and table canvases and exposes them only after rendering is ready.
- **Raytracing off** selects the `legacy` renderer. It uses the existing CSS card highlights and table day/night styling.

A V-GPU request initially keeps the effective renderer on legacy CSS while the runtime starts. Successful readiness switches the effective renderer to V-GPU. Initialization timeout, shader failure, and device loss return to legacy CSS without overwriting the requested V-GPU preference; switching Raytracing off explicitly persists the legacy preference.

Player and table lighting are independent. Card illumination is always enabled for the relevant game or selection state; the retired Player LEDs switch and its stored off preference no longer suppress it. In V-GPU mode, a speaker card renders a continuous warm-gold rounded perimeter with a soft surrounding spill; state palettes remain available for Mafia, sheriff, and attention highlights. The table renderer uses the game shell's existing day/night cycle to render a restrained continuous rim and inward wash: amber/gold by day and cool blue/purple at night. Reduced motion keeps a static illuminated result.

GPU player-glow pulsing has persistent on/off, speed and strength controls. Uniform updates apply live without recreating surfaces, and do not affect table ambience. Mafia and selected availability highlights also render subdued single-pass procedural flames inside the card, beneath its content. Fire animation is independent of pulsing; reduced motion freezes both, while geometry still refreshes on resize.

The legacy CSS treatment remains the startup and failure path, preserving its current card highlight animation and table day/night gradient. SVG lighting is not part of the renderer lifecycle.

Developer-menu access and development-tools enablement persist independently in browser localStorage. Hide clears both without clearing lighting preferences; the normal entry gesture remains available. These are UI preferences, not authorization: existing manager permissions still govern editing tools.
