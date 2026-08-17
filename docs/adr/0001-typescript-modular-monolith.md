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

Use PostgreSQL for the append-only game event store and durable projections. Use `pg` and explicit SQL migrations initially rather than introducing a heavyweight ORM before the domain stabilizes. Validate API boundaries with Zod.

Use Vitest for domain/server/component tests, Testing Library for React behavior, and Playwright for critical browser flows. Build the production SPA into the server image and run the app plus PostgreSQL through Docker Compose.

The YouTube IFrame Player API runs only in the browser. The server stores playlist configuration, the application-owned queue, and music events; it does not proxy audio.

## Event and state model

- Commands are validated against reconstructed/current game state.
- Accepted commands emit one or more immutable events.
- Events receive monotonic per-game sequence numbers in one database transaction.
- Idempotency keys prevent double taps/retries from duplicating actions.
- Host and future public projections are separate server-side serializers.
- Corrections append compensating events; they never delete history.
- Timers store timestamps and paused durations, not one row per visual tick.

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

Deferred. Playback through the IFrame API does not require modifying the user’s account, while playlist writes require Google OAuth, scopes, consent configuration, token storage, and additional security work. MVP edits an application-owned queue.

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
