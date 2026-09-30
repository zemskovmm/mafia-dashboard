# ADR 0001: TypeScript modular monolith for the local web application

- **Status:** Accepted — TypeScript modular monolith with browser-authoritative snapshots and client-validated semantic history. Server-generated game GUIDs and authorization-only game-record persistence supersede the earlier ownership/claim model below.
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

Use PostgreSQL for club-scoped game records. Game-record CRUD requires authenticated club manager (admin/owner) authorization; game-rule and replay validation belongs to the browser. Other API boundaries retain their existing validation.

### Original persistence decision (historical)

The initial implementation used atomic complete-snapshot replacement and a revisioned durable browser outbox that retries mutations by UUID. Complete snapshots remain the live-play authority. Revision-checked incremental operations and claims are superseded by explicit create, full-snapshot update, list/read and delete operations.

Use Vitest for domain/server/component tests, Testing Library for React behavior, and Playwright for critical browser flows. Build the production SPA into the server image and run the app plus PostgreSQL through Docker Compose.

The YouTube IFrame Player API runs only in the browser. Revisioned session metadata stores the selected playlist, but playback, fades, and timer controls are auxiliary local UI state and do not produce durable game events.

## Current aggregate state and undo model

- The server generates a game GUID when the client enters Role giveaway. Creation retries use a separate client-generated request identity, never a client-chosen game GUID; play waits for the server response.
- Pre-game setup metadata remains revisioned session state. Starting live play records one immutable initial game baseline and one canonical root event.
- Every browser persistence generation contains the complete current `GameState`, setup metadata, Undo allowance, semantic event prefix, and optional final results.
- The browser snapshot is authoritative. PostgreSQL accepts the last committed authorized snapshot without game-rule, replay or stale-writer validation, mirrors its event prefix, and atomically synchronizes persistence projections. Transactions do not grant a browser exclusive control.
- Semantic events retain parent, sequence, phase/day, and state-hash metadata for Log, Timeline, Preview, and internal replay validation; replay does not replace the snapshot's current game state.
- Ordinary Undo and Timeline Reset permanently truncate the browser snapshot and mirrored event prefix. They create no game event, retain no future branch, and provide no Reset Return. Undo remains limited to three actions and cannot cross a new-day checkpoint.
- Clicking **Finish game** locks Undo and Reset in the client and persists the completed snapshot and projections.
- Timers provide start presets and stop only. Timer ticks, starts/stops, music playback, and fades are not durable events.

## Current data support and ownership boundaries

These decisions preserve the contracts from [#48](https://github.com/zemskovmm/mafia-dashboard/issues/48), [#50](https://github.com/zemskovmm/mafia-dashboard/issues/50), [#52](https://github.com/zemskovmm/mafia-dashboard/issues/52), and [#53](https://github.com/zemskovmm/mafia-dashboard/issues/53); the current-only implementation landed in [PR #55](https://github.com/zemskovmm/mafia-dashboard/pull/55).

### Browser-local storage and server game records

- Within one browser profile and application origin, `localStorage["mafia-dashboard.game-session.v5"]` holds the open local game with explicit club identity and the server-issued GUID once created. Protect unsent local work before switching records. This local storage boundary does not restrict the number of active server games in a club.
- Missing v5 data means empty storage. Valid v5 data restores the game and pending outbox. Invalid/unsupported v5 bytes block gameplay until an explicit clear of the exact inspected bytes; they are not silently repaired or replaced. Normal game operations ignore old game/preference keys without migrating or sweeping them. Explicit application-wide clear remains a separate destructive action.
- Browser storage operations serialize through Web Locks and verify the expected stored record before destructive release/discard. Unsupported locking fails closed. Synced release cannot discard unresolved outbox work. If another tab already removed the expected record, release-and-open refreshes storage and opens the captured target club only if storage is empty; replacement or invalid data must not be overwritten.
- Game state has no `sessionStorage` recovery fallback. Game claims, claim generations, heartbeats, expiry, and takeover do not exist. Any authorized client can open/update a club game; concurrent writers are last-write-wins.

### Authorized game-record CRUD

- POST creates a record with a server-issued GUID; PUT updates an existing GUID only; GET lists/reads club records; DELETE permanently removes a game and its dependent data without creating a result. Listing active games excludes completed games. Deletes need no claim or revision.
- Authentication and club manager authorization, including club isolation, are the only application-level game-record validations. Creation/mutation retry bookkeeping and transactional persistence prevent duplication without restoring ownership or stale-writer checks. Failed uploads retain local pending data.
- Update-only addressing prevents late saves from recreating deleted games. Clients report removal on their next read/save and stop automatic retries rather than creating replacement records. There is no realtime kill channel.
- Client semantic replay validates retained event history for Log, Timeline, and Preview; the server does not enforce its rules or hashes. Secret data remains protected by club authorization and the existing visibility projections.

### Current-only support is not an automatic migration

- Browser/API/session/replay writers and readers support current shapes and SHA-256 replay metadata only. Historical envelope parsing, hash adapters, fallback hydration, raw aggregate mutation routes, and database repair/backfill are intentionally unsupported.
- PostgreSQL initialization supports only an empty database or the current schema. The preceding claim-based, unknown and incomplete schemas fail without mutation, reset or backfill. Schema qualification does not authorize deployment. See [self-hosted deployment](../self-hosted-deployment.md) and [backup and recovery](../postgresql-backup-and-recovery.md).
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
- Manager-gated, club-isolated game-record access.
- Small local deployment footprint.
- Straightforward production Docker image.
- No premature real-time or distributed-system dependencies.

### Negative

- Authorization does not establish the correctness of a client-supplied game state; concurrent clients can overwrite each other without warning.
- Explicit SQL requires disciplined migrations and mapping code.
- YouTube playback must handle browser media policies and third-party availability.

## Revisit triggers

Revisit this ADR if the product requires conflict resolution between concurrent writers, fully offline creation before obtaining a server GUID, or deployment scale that the modular monolith and HTTP command model cannot support.
