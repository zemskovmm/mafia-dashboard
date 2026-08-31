# ADR 0001: TypeScript modular monolith for the local web application

- **Status:** Partially superseded — the TypeScript modular-monolith decision remains accepted; the original snapshot persistence model is superseded by the current replay/head model below.
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

### Original persistence decision (superseded)

The initial implementation decision was for each accepted setup or game action to replace a complete restorable snapshot, non-auxiliary log tail, active-player projection, undo history, and final results in one transaction. It also introduced a revisioned durable browser outbox that retries mutations by UUID and fails closed on conflicts. The outbox/revision contract remains; snapshot replacement for live play does not.

Use Vitest for domain/server/component tests, Testing Library for React behavior, and Playwright for critical browser flows. Build the production SPA into the server image and run the app plus PostgreSQL through Docker Compose.

The YouTube IFrame Player API runs only in the browser. Revisioned session metadata stores the selected playlist, but playback, fades, and timer controls are auxiliary local UI state and do not produce durable game events.

## Current aggregate state and undo model

- A client-generated game UUID exists before the first network mutation.
- Pre-game setup metadata remains revisioned session state. Starting live play records one immutable initial game baseline and one canonical root event.
- Every browser persistence generation contains the complete current `GameState`, setup metadata, Undo allowance, semantic event prefix, and optional final results.
- The browser snapshot is authoritative. PostgreSQL accepts the last uploaded schema/invariant/club/privacy-valid snapshot regardless of the browser's previously observed server revision, mirrors its exact event prefix, and synchronizes active-player or completion projections atomically under a per-game lock.
- Semantic events retain parent, sequence, phase/day, and state-hash metadata for Log, Timeline, Preview, and internal replay validation; replay does not replace the snapshot's current game state.
- Ordinary Undo and Timeline Reset permanently truncate the browser snapshot and mirrored event prefix. They create no game event, retain no future branch, and provide no Reset Return. Undo remains limited to three actions and cannot cross a new-day checkpoint.
- Clicking **Finish game** locks Undo and Reset in the client and persists the completed snapshot and projections.
- Timers provide start presets and stop only. Timer ticks, starts/stops, music playback, and fades are not durable events.

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
- Explicit server-side secret filtering.
- Small local deployment footprint.
- Straightforward production Docker image.
- No premature real-time or distributed-system dependencies.

### Negative

- The server must enforce authority even though types are shared with the client.
- Explicit SQL requires disciplined migrations and mapping code.
- YouTube playback must handle browser media policies and third-party availability.

## Revisit triggers

Revisit this ADR if the product requires multiple concurrent writers, offline-first multi-device conflict resolution, or deployment scale that the modular monolith and HTTP command model cannot support.
