# ADR 0001: TypeScript modular monolith for the local web application

- **Status:** Accepted — TypeScript modular monolith with browser-authoritative snapshots, validated semantic history, and the current-only data and ownership boundaries below. Earlier persistence descriptions are historical where they conflict with this model.
- **Decision owners:** Project owner and implementation agent
- **Scope:** Initial touch SPA, local API, game domain, and PostgreSQL persistence

## Context

At the time of this decision, Mafia Dashboard needed a touch-friendly SPA for tablets and laptops, a Docker-started local server, durable game actions, browser-hosted YouTube playback, and active-game recovery after refresh or restart. The repository then contained product documentation but no application stack; the resulting stack is now implemented and also deployed through Azure Container Apps.

The highest-risk logic is not generic CRUD. It is the deterministic game state machine: setup gates, role draws, rotating turns, penalties, nominations, individual votes, coordinated Mafia shots, secret checks, victory, and compensating corrections. That logic should be testable without React, HTTP, or PostgreSQL.

## Decision

Use one TypeScript npm workspace with three deployable/logical units:

- `apps/web`: React + Vite SPA
- `apps/server`: Fastify HTTP API and static production host
- `packages/game-domain`: framework-independent commands, events, state transitions, and projections

Use PostgreSQL for one authoritative game-session aggregate. Validate API boundaries with Zod.

### Original persistence decision (historical)

The initial implementation used atomic complete-snapshot replacement and a revisioned durable browser outbox that retries mutations by UUID. Complete snapshots remain the live-play authority. The current contract below distinguishes snapshot uploads from revision-checked incremental operations and destructive clear; it does not reject every snapshot solely because its observed server revision is older.

Use Vitest for domain/server/component tests, Testing Library for React behavior, and Playwright for critical browser flows. Build the production SPA into the server image and run the app plus PostgreSQL through Docker Compose.

The YouTube IFrame Player API runs only in the browser. Revisioned session metadata stores the selected playlist, but playback, fades, and timer controls are auxiliary local UI state and do not produce durable game events.

## Current aggregate state and undo model

- A client-generated game UUID exists before the first network mutation.
- Pre-game setup metadata remains revisioned session state. Starting live play records one immutable initial game baseline and one canonical root event.
- Every browser persistence generation contains the complete current `GameState`, setup metadata, Undo allowance, semantic event prefix, and optional final results.
- The browser snapshot is authoritative. PostgreSQL accepts the last uploaded schema/invariant/club/privacy-valid snapshot regardless of the browser's previously observed server revision, mirrors its exact event prefix, and atomically synchronizes the fixed ruleset identity plus active seat/role or completion projections under a per-game lock.
- Semantic events retain parent, sequence, phase/day, and state-hash metadata for Log, Timeline, Preview, and internal replay validation; replay does not replace the snapshot's current game state.
- Ordinary Undo and Timeline Reset permanently truncate the browser snapshot and mirrored event prefix. They create no game event, retain no future branch, and provide no Reset Return. Undo remains limited to three actions and cannot cross a new-day checkpoint.
- Clicking **Finish game** locks Undo and Reset in the client and persists the completed snapshot and projections.
- Timers provide start presets and stop only. Timer ticks, starts/stops, music playback, and fades are not durable events.

## Current data support and ownership boundaries

These decisions preserve the contracts from [#48](https://github.com/zemskovmm/mafia-dashboard/issues/48), [#50](https://github.com/zemskovmm/mafia-dashboard/issues/50), [#52](https://github.com/zemskovmm/mafia-dashboard/issues/52), and [#53](https://github.com/zemskovmm/mafia-dashboard/issues/53); the current-only implementation landed in [PR #55](https://github.com/zemskovmm/mafia-dashboard/pull/55).

### Browser ownership and club claims are separate safeguards

- Within one browser profile and application origin, the sole supported durable game record is `localStorage["mafia-dashboard.game-session.v5"]`, with explicit `clubId` and `gameId`. Restore its owner before allowing another start or resume. Browser-local ownership does not replace the server's club-wide active-game claim and explicit takeover across tabs/devices.
- Missing v5 data means empty storage. Valid v5 data restores the game and pending outbox. Invalid/unsupported v5 bytes block gameplay until an explicit clear of the exact inspected bytes; they are not silently repaired or replaced. Normal game operations ignore old game/preference keys without migrating or sweeping them. Explicit application-wide clear remains a separate destructive action.
- Browser storage operations serialize through Web Locks and verify the expected stored record before destructive release/discard. Unsupported locking fails closed. Synced release cannot discard unresolved outbox work. If another tab already removed the expected record, release-and-open refreshes storage and opens the captured target club only if storage is empty; replacement or invalid data must not be overwritten.
- Game state has no `sessionStorage` recovery fallback. Tab-claim identity may still use session storage. Server claims fence stale writers by claim identity/generation; HTTP polling/revalidation and explicit takeover are sufficient, without requiring WebSockets.

### Snapshot authority is not unrestricted writing

- A full snapshot from a valid current claim may replace the server mirror despite an older `baseRevision`. Requiring compare-and-swap for every full snapshot was rejected because it would change the accepted browser-authority contract, not fix a regression. Incremental operations and destructive clear retain revision checks.
- Club membership/isolation, claim ownership, schema/invariant validation, immutable event identity, canonical parent/hash validation, and exact mutation-ID retries remain required. Reusing a mutation ID for a different payload is rejected. Current setup, active games, and completion/results retain atomic persistence and idempotent retries; a failed upload must not discard the pending browser state.
- Semantic replay validates the retained event history for Log, Timeline, and Preview; it does not reconstruct over or replace the authoritative snapshot's current `GameState` merely because both valid representations differ.

### Current-only support is not an automatic migration

- Browser/API/session/replay writers and readers support current shapes and SHA-256 replay metadata only. Historical envelope parsing, hash adapters, fallback hydration, raw aggregate mutation routes, and database repair/backfill are intentionally unsupported.
- PostgreSQL initialization supports an empty database or an already-current schema. It is advisory-locked and transactional; unsupported or incomplete schemas must fail without partial conversion, destructive reset, or data backfill. This boundary does not authorize deployment or conversion of an existing historical installation. See [self-hosted deployment](../self-hosted-deployment.md) and [backup and recovery](../postgresql-backup-and-recovery.md).
- Removing compatibility does not remove current features whose names contain `legacy`: the `legacyLog` field still carries current setup/activity entries, and the selectable `legacy` lighting renderer remains supported. Current theme/music preference keys, defaults, queue behavior, and lighting choices remain intact.

## Considered alternatives

### Next.js full-stack application

Rejected for the initial architecture. It can build an SPA-like interface and server routes, but its server/client rendering conventions add complexity that does not help a local host-operated dashboard. Vite plus Fastify gives explicit boundaries and a smaller mental model.

### Python/FastAPI backend with React frontend

Viable, but rejected to avoid duplicating domain types and validation rules across Python and TypeScript. The core rules engine benefits from sharing types and pure functions with the SPA while retaining server authority.

### Client-only SPA with local storage

Rejected because the owner explicitly wants a Dockerized server and SQL persistence. Client-only storage would weaken server-authoritative recovery and auditability.

### Microservices, Redis, message queue, or mandatory WebSockets

Rejected as unnecessary for a single-host local deployment. HTTP commands plus polling/revalidation are enough for the current product. Revisit real-time transport only if a supported workflow later requires concurrent writers.

### YouTube Data API playlist writes

Rejected for the current product. The account integration uses read-only scope to list/select owned playlists. The browser builds an application-owned session queue from those entries, preserves repeated occurrences, and allows drag reorder and **Play next** / **Play now** without modifying the owner’s real playlist.

## Consequences

### Positive

- One language and shared types across domain, server, and SPA.
- Pure rules can be developed with strict TDD.
- Membership-gated, club-isolated access without divergent manager/user game projections.
- Small local deployment footprint.
- Straightforward production Docker image.
- No premature real-time or distributed-system dependencies.

### Negative

- The server must enforce authority even though types are shared with the client.
- Explicit SQL requires disciplined migrations and mapping code.
- YouTube playback must handle browser media policies and third-party availability.

## Revisit triggers

Revisit this ADR if the product requires multiple concurrent writers, offline-first multi-device conflict resolution, or deployment scale that the modular monolith and HTTP command model cannot support.
