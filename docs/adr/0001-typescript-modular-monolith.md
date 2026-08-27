# ADR 0001: TypeScript modular monolith for the local web application

- **Status:** Accepted
- **Decision owners:** Project owner and implementation agent
- **Scope:** Initial touch SPA, local API, game domain, and PostgreSQL persistence

## Context

Mafia Dashboard must be a touch-friendly SPA that runs on tablets and laptops, uses a server started locally through Docker, persists every game action, integrates a browser-hosted YouTube player, and restores an active game after refresh or restart. The repository contains product documentation but no application stack.

The highest-risk logic is not generic CRUD. It is the deterministic game state machine: setup gates, role draws, rotating turns, penalties, nominations, individual votes, coordinated Mafia shots, secret checks, victory, and compensating corrections. That logic should be testable without React, HTTP, or PostgreSQL.

## Decision

Use one TypeScript npm workspace with three deployable/logical units:

- `apps/web`: React + Vite SPA
- `apps/server`: Fastify HTTP API and static production host
- `packages/game-domain`: framework-independent commands, events, state transitions, and projections

Use PostgreSQL for one authoritative game-session aggregate. Each accepted setup or game action replaces the complete restorable snapshot, its non-auxiliary log tail, active-player projection, undo history, and final results in one transaction. A revisioned, durable browser outbox retries mutations by UUID and fails closed on conflicts. Validate API boundaries with Zod.

Use Vitest for domain/server/component tests, Testing Library for React behavior, and Playwright for critical browser flows. Build the production SPA into the server image and run the app plus PostgreSQL through Docker Compose.

The YouTube IFrame Player API runs only in the browser. The session snapshot stores the selected playlist, but playback, fades, and timer controls are auxiliary local UI state and do not produce durable game events.

## Aggregate state and undo model

- A client-generated game UUID exists before the first network mutation.
- Each accepted normal setup/game action queues one complete snapshot mutation with a base revision and mutation UUID.
- The server commits the snapshot, non-auxiliary log, active player foreign keys, and results atomically under a per-game advisory lock.
- The immutable sequence-1 `game.created` row is preserved while later log rows are replaced from the authoritative snapshot.
- Undo restores a prior game snapshot and removes the corresponding log tail. At most three ordinary actions are retained.
- Beginning day one and every later completed-night day increment are checkpoints: undo history is cleared, so undo never crosses a day boundary.
- Timers provide start presets and stop only. Timer ticks, starts/stops, music playback, and fades are not durable events.

## Considered alternatives

### Next.js full-stack application

Rejected for the initial architecture. It can build an SPA-like interface and server routes, but its server/client rendering conventions add complexity that does not help a local host-operated dashboard. Vite plus Fastify gives explicit boundaries and a smaller mental model.

### Python/FastAPI backend with React frontend

Viable, but rejected to avoid duplicating domain types and validation rules across Python and TypeScript. The core rules engine benefits from sharing types and pure functions with the SPA while retaining server authority.

### Client-only SPA with local storage

Rejected because the owner explicitly wants a Dockerized server and SQL persistence. Client-only storage would weaken recovery, auditability, and future multi-screen support.

### Microservices, Redis, message queue, or mandatory WebSockets

Rejected as unnecessary for a single-host local deployment. HTTP commands plus polling/revalidation are enough for the initial slice. A real-time transport can be added only when a second concurrent display is approved.

### YouTube Data API playlist writes

Deferred. Playback through the IFrame API does not require modifying the user’s account, while playlist writes require Google OAuth, scopes, consent configuration, token storage, and additional security work. The MVP plays the selected YouTube playlist as supplied, including repeated video occurrences, without an application-owned editable queue.

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
- A future public display may justify WebSockets or server-sent events.

## Revisit triggers

Revisit this ADR if the product requires multiple concurrent moderators, remote player devices, offline-first multi-device conflict resolution, high-volume tournament hosting, or direct editing of the owner’s YouTube account playlist.
