# Mafia Dashboard

A self-hosted web dashboard for moderating in-person Sport / Club Mafia games.

## Status

The project has entered implementation. The earlier Swift/Xcode prototype has been removed; this repository contains the touch-first web application only.

## Documentation

- [`rules.md`](rules.md) — researched game rules, canonical MVP behavior, moderator workflows, data model, deployment baseline, and open product decisions.
- [`docs/product-outline.md`](docs/product-outline.md) — approved setup wizard, round-table UI, music/timer behavior, phase flow, and interaction contracts.
- [`docs/adr/0001-typescript-modular-monolith.md`](docs/adr/0001-typescript-modular-monolith.md) — initial SPA/API/PostgreSQL architecture decision.
- [`docs/azure-deployment.md`](docs/azure-deployment.md) — Azure Container Apps, private PostgreSQL, GitHub OIDC deployment, and rollback runbook.
- [Implementation plan](.hermes/plans/2026-08-17_162513-mafia-dashboard-spa.md) — staged TDD execution plan and verification matrix.
- [Player/statistics and account-music plan](.hermes/plans/2026-08-17_180401-player-profiles-statistics-youtube-music.md) — persistent profile, statistics, setup-dropdown, and supported OAuth playlist design.
- [GitHub issues](https://github.com/zemskovmm/mafia-dashboard/issues) — dependency-aware implementation backlog.
- [Issue #1](https://github.com/zemskovmm/mafia-dashboard/issues/1) — owner decisions required before implementation.

## Architecture direction

The application is a TypeScript npm workspace with a React/Vite SPA, Fastify API, pure game-domain package, and one revisioned PostgreSQL game-session aggregate. The deployment target is Docker Compose with an application container and PostgreSQL persistence.

## Run locally with Docker

1. Copy `.env.example` to `.env`, set a local PostgreSQL password, and set `PUBLIC_APP_URL` to the exact browser origin (for example, `http://localhost:8080` for local development or the private HTTPS origin used by tablets).
2. Create a Google OAuth 2.0 **Web application** client. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then authorize `${PUBLIC_APP_URL}/api/auth/google/callback` as a redirect URI. This OpenID Connect flow creates the application's own hashed, HttpOnly database session; the browser never stores Google tokens.
3. To browse the host account's YouTube Music library, also authorize `${PUBLIC_APP_URL}/api/music/oauth/callback`, set that exact value as `GOOGLE_OAUTH_REDIRECT_URI`, and generate `MUSIC_TOKEN_ENCRYPTION_KEY` as shown in `.env.example`. You can instead use `VITE_YOUTUBE_PLAYLIST_ID` or enter a playlist ID in setup.
4. Start the application:

   ```bash
   docker compose up --build
   ```

5. Open the configured `PUBLIC_APP_URL`. To allow tablets/laptops on the trusted LAN, set `APP_BIND=0.0.0.0` and use a private HTTPS origin such as Tailscale HTTPS. Apply local firewall and TLS policy before exposing the service beyond a trusted network.

Health checks:

- <http://localhost:8080/health/live>
- <http://localhost:8080/health/ready>

Stop while retaining PostgreSQL data:

```bash
docker compose down
```

Delete local PostgreSQL data only when intentionally resetting all games:

```bash
docker compose down --volumes
```

## Development quality commands

```bash
npm install
npm run dev
npm run check
```

Server integration tests expect PostgreSQL at `postgresql://mafia:mafia@127.0.0.1:54329/mafia_test`, or use `TEST_DATABASE_URL` to override it.

## Current implementation slice

- Guided ten-player setup and real playback gate from YouTube IFrame state
- Google OpenID Connect sign-in with revocable application sessions and per-club isolation
- Theme-ready CSS with Midnight and Málaga black/white/gold schemes
- Read-only Google account playlist selection for the host's YouTube Music library
- Persistent player profiles, ordered nickname selection, and per-player statistics
- Per-seat random canonical role draw
- Round-table host dashboard with privacy shield
- 60/30/10-second timers and faint ten-second warning
- Foul, red-card, nomination, individual voting, Mafia shot, Don check, and Sheriff check controls
- Rotating day order, automatic win detection, and atomic PostgreSQL game-session snapshots after every setup/game-state action
- Durable browser outbox plus **Active games** resume for full setup/live state, host, playlist, log, and undo recovery
- Three-action ordinary undo with every new day as a checkpoint; timer and music controls remain non-durable UI state

Owner input still needed for a production table session: preferred fade durations/chime, red-card final-speech rule, initial languages, and any tie-vote rule that differs from `rules.md`.

YouTube Music does not expose a separate embeddable web player API. Account playlist selection uses a separate read-only Google OAuth grant plus the YouTube Data API; playback remains in a visible YouTube IFrame. Application sign-in and YouTube library authorization share the configured Google client but use separate callbacks and separate local session/token storage.
