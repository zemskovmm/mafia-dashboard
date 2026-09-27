# Architecture

Mafia Dashboard is a TypeScript npm workspace with three primary application boundaries:

- `apps/web/` is the React/Vite browser application for club setup and moderated play.
- `apps/server/` is the Fastify API and static host. It owns authentication, club isolation, and PostgreSQL persistence.
- `packages/game-domain/` contains framework-independent Club Mafia rules, canonical events, and replay logic.

The browser owns game rules, setup checks, and semantic replay. On entering Role giveaway it creates a server-backed game record and receives its server-generated GUID; subsequent full-snapshot updates address that GUID. The server authorizes the authenticated club manager (admin/owner), preserves club isolation, and stores the client snapshot without validating game rules, replay, claims, or revisions. Concurrent updates are last-write-wins.

A club may have multiple active games. The client lists and opens those server records without takeover, and permanently deletes a selected game through the same club-scoped API. Updates never create missing records, so a deleted game cannot be resurrected by a late save. There are no game claims, heartbeats, expiry or stale-writer fencing. New games require a server response before play; existing games retain offline save retries. Deletion is acknowledged only after the server succeeds, and another client discovers deletion on its next request.

## Lighting renderer

The web client has two supported lighting renderers:

- **Raytracing on** selects V-GPU, the default persisted preference. This is a UI label for shader-based illumination, not physical ray tracing. Its shared runtime registers separate player-card and table canvases and exposes them only after rendering is ready.
- **Raytracing off** selects the `legacy` renderer. It uses the existing CSS card highlights and table day/night styling.

A V-GPU request initially keeps the effective renderer on legacy CSS while the runtime starts. Successful readiness switches the effective renderer to V-GPU. Initialization timeout, shader failure, and device loss return to legacy CSS without overwriting the requested V-GPU preference; switching Raytracing off explicitly persists the legacy preference.

Player and table lighting are independent. Card illumination is always enabled for the relevant game or selection state; the retired Player LEDs switch and its stored off preference no longer suppress it. In V-GPU mode, a speaker card renders a continuous warm-gold rounded perimeter with a soft surrounding spill; state palettes remain available for Mafia, sheriff, and attention highlights. The table renderer uses the game shell's existing day/night cycle to render a restrained continuous rim and inward wash: amber/gold by day and cool blue/purple at night. Reduced motion keeps a static illuminated result.

GPU player-glow pulsing has persistent on/off, speed and strength controls. Uniform updates apply live without recreating surfaces, and do not affect table ambience. Mafia and selected availability highlights also render subdued single-pass procedural flames inside the card, beneath its content. Fire animation is independent of pulsing; reduced motion freezes both, while geometry still refreshes on resize.

The legacy CSS treatment remains the startup and failure path, preserving its current card highlight animation and table day/night gradient. SVG lighting is not part of the renderer lifecycle.

Developer-menu access and development-tools enablement persist independently in browser localStorage. Hide clears both without clearing lighting preferences; the normal entry gesture remains available. These are UI preferences, not authorization: existing manager permissions still govern editing tools.
