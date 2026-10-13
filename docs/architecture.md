# Architecture

Mafia Dashboard is a TypeScript npm workspace with three primary application boundaries:

- `apps/web/` is the React/Vite browser application for club setup and moderated play.
- `apps/server/` is the Fastify API and static host. It owns authentication, club isolation, and explicit persistence adapters: PostgreSQL for Compose/reference fixtures, or Azure Table + private Blob Storage for local development and Azure deployment.
- `packages/game-domain/` contains framework-independent Club Mafia rules, canonical events, and replay logic.

The browser owns game rules, setup checks, and semantic replay. On entering Role giveaway it creates a server-backed game record and receives its server-generated GUID; subsequent full-snapshot updates address that GUID. The server authorizes the authenticated club manager (admin/owner), preserves club isolation, and stores the client snapshot without validating game rules, replay, claims, or revisions. Concurrent updates are last-write-wins.

A club may have multiple active games. The client lists and opens those server records without takeover, and permanently deletes a selected game through the same club-scoped API. Updates never create missing records, so a deleted game cannot be resurrected by a late save. There are no game claims, heartbeats, expiry or stale-writer fencing. New games require a server response before play; existing games retain offline save retries. Deletion is acknowledged only after the server succeeds, and another client discovers deletion on its next request.

## Persistence adapters

The accepted storage decision is [IDD-0006](../.idd/intent/IDD-0006.adr-azure-table-and-blob-persistence.md). Provider selection never silently falls back or dual-writes. The Azure adapter does not need PostgreSQL for readiness, authentication, club access, profiles, games or music credentials.

Azure Tables hold typed account/session/access/profile records, game heads, creation mappings, deletion markers and bounded participant/result projections. Private immutable blobs hold exact game revision envelopes (including the projected event view) and large club logos. The complete accepted snapshot remains the recovery authority; projections cannot rewrite canonical hashes or reconstruct missing setup fields. No Table row is created for each canonical event.

All structured records share one persisted application partition. Each transaction conditionally updates a control row and publishes its related changes atomically. A private blob is uploaded and verified before its pointer is published; an exact atomic commit receipt proves publication, including a lost response followed by another writer's commit. Saves are acknowledged only after remote proof. Internal CAS retries recheck permissions and identities and preserve last-commit-wins; they do not introduce client revision fencing. Combined reads verify a stable control ETag around Table pages and selected blobs.

Large or arbitrary payloads stay in blobs; Table records use scalar/date/binary properties with nullable values omitted through full replacement. Azure's 100-operation and 4-MiB transaction bounds include the control and receipt. Over-limit operations fail without partial publication. The SDK's batch-delete API has no per-delete ETag option; its deletion group is fenced by the same conditional control update. This relies on every application writer using the adapter rather than directly changing business entities.

Game deletion retains its original creation mapping and a tombstone. Player retirement checks active full snapshots, including incomplete setup. Club deletion first makes the club unavailable, then purges its owned entities/assets in bounded resumable steps. Retired blob references are tracked separately for later cleanup; no independent archive is deleted as a side effect.

Local Azure development uses an owned loopback Azurite fixture under ignored `.AI/`, with a stable development namespace and disposable isolated test namespaces. Normal development needs no PostgreSQL server; the canonical check wrapper additionally owns a disposable PostgreSQL fixture so the retained reference suites actually execute. Production configuration uses the named Azure account and server identity, not emulator credentials. Explicit initialization can create an empty dataset; unknown schemas and nonempty unrecognized state fail closed without reset.

**Transition boundary:** Azure deployment starts empty and leaves the original PostgreSQL data intact. The separately invoked migration tool can later import business data into an empty target, excluding login sessions and music connections; deployment never runs it. No special browser-epoch rejection is required. Local backup/restore tooling does not configure production scheduling or qualify live disaster recovery. Azurite is not proof of live RBAC, networking or availability. Consistent backups must cover both Table records and referenced blob bytes; storage replication alone is not backup.

## Lighting renderer

The web client has two supported lighting renderers:

- **Raytracing on** selects V-GPU, the default persisted preference. This is a UI label for shader-based illumination, not physical ray tracing. Its shared runtime registers separate player-card and table canvases and exposes them only after rendering is ready.
- **Raytracing off** selects the `legacy` renderer. It uses the existing CSS card highlights and table day/night styling.

A V-GPU request initially keeps the effective renderer on legacy CSS while the runtime starts. Successful readiness switches the effective renderer to V-GPU. Initialization timeout, shader failure, and device loss return to legacy CSS without overwriting the requested V-GPU preference; switching Raytracing off explicitly persists the legacy preference.

Player and table lighting are independent. Card illumination is always enabled for the relevant game or selection state; the retired Player LEDs switch and its stored off preference no longer suppress it. In V-GPU mode, a speaker card renders a continuous warm-gold rounded perimeter with a soft surrounding spill; state palettes remain available for Mafia, sheriff, and attention highlights. The table renderer uses the game shell's existing day/night cycle to render a restrained continuous rim and inward wash: amber/gold by day and cool blue/purple at night. Reduced motion keeps a static illuminated result.

GPU player-glow pulsing has persistent on/off, speed and strength controls. Uniform updates apply live without recreating surfaces, and do not affect table ambience. Mafia and selected availability highlights also render subdued single-pass procedural flames inside the card, beneath its content. Fire animation is independent of pulsing; reduced motion freezes both, while geometry still refreshes on resize.

The legacy CSS treatment remains the startup and failure path, preserving its current card highlight animation and table day/night gradient. SVG lighting is not part of the renderer lifecycle.

Developer-menu access and development-tools enablement persist independently in browser localStorage. Hide clears both without clearing lighting preferences; the normal entry gesture remains available. These are UI preferences, not authorization: existing manager permissions still govern editing tools.
