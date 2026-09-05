# Architecture

Mafia Dashboard is a TypeScript npm workspace with three primary application boundaries:

- `apps/web/` is the React/Vite browser application for club setup and moderated play.
- `apps/server/` is the Fastify API and static host. It owns authentication, club isolation, and PostgreSQL persistence.
- `packages/game-domain/` contains framework-independent Club Mafia rules, canonical events, and replay logic.

The browser persists setup state directly. During live play, it derives the visible game from an immutable baseline plus parent-linked semantic events. The server validates and stores the latest valid snapshot within its club-scoped game-session aggregate.

## Lighting renderer

The web client has two supported lighting renderers:

- **V-GPU** is the default persisted preference. Its shared runtime registers separate player-card and table canvases and exposes them only after rendering is ready.
- **Same as before** is the manually selectable `legacy` renderer. It uses the existing CSS card highlights and table day/night styling.

A V-GPU request initially keeps the effective renderer on legacy CSS while the runtime starts. Successful readiness switches the effective renderer to V-GPU. Initialization timeout, shader failure, and device loss return to legacy CSS without overwriting the requested V-GPU preference; selecting **Same as before** explicitly persists the legacy preference.

Player and table lighting are independent. The player-lighting control affects card illumination only. In V-GPU mode, a speaker card renders a continuous warm-gold rounded perimeter with a soft surrounding spill; state palettes remain available for Mafia, sheriff, and attention highlights. The table renderer uses the game shell's existing day/night cycle to render a restrained continuous rim and inward wash: amber/gold by day and cool blue/purple at night. Reduced motion keeps a static illuminated result.

The legacy CSS treatment remains the startup and failure path, preserving its current card highlight animation and table day/night gradient. SVG lighting is not part of the renderer lifecycle.
