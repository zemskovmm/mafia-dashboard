# Mafia Dashboard

A self-hosted web dashboard for moderating in-person Sport / Club Mafia games.

## Status

The project has entered implementation. The earlier Swift/Xcode prototype has been removed; this repository contains the touch-first web application only.

## Documentation

- [`rules.md`](rules.md) — researched game rules, canonical MVP behavior, moderator workflows, data model, deployment baseline, and open product decisions.
- [`docs/product-outline.md`](docs/product-outline.md) — approved setup wizard, round-table UI, music/timer behavior, phase flow, and interaction contracts.
- [`docs/adr/0001-typescript-modular-monolith.md`](docs/adr/0001-typescript-modular-monolith.md) — initial SPA/API/PostgreSQL architecture decision.
- [Implementation plan](.hermes/plans/2026-08-17_162513-mafia-dashboard-spa.md) — staged TDD execution plan and verification matrix.
- [Player/statistics and account-music plan](.hermes/plans/2026-08-17_180401-player-profiles-statistics-youtube-music.md) — persistent profile, statistics, setup-dropdown, and supported OAuth playlist design.
- [GitHub issues](https://github.com/zemskovmm/mafia-dashboard/issues) — dependency-aware implementation backlog.
- [Issue #1](https://github.com/zemskovmm/mafia-dashboard/issues/1) — owner decisions required before implementation.

## Architecture direction

The application is a TypeScript npm workspace with a React/Vite SPA, Fastify API, pure game-domain package, and PostgreSQL event log. The deployment target is Docker Compose with an application container and PostgreSQL persistence.

## Run locally with Docker

1. Copy `.env.example` to `.env` and set a local PostgreSQL password.
2. Optionally set `VITE_YOUTUBE_PLAYLIST_ID` to the playlist used at the table. The setup screen also accepts a playlist ID interactively.
3. Start the application:

   ```bash
   docker compose up --build
   ```

4. Open <http://localhost:8080> on the host. To allow tablets/laptops on the trusted LAN, set `APP_BIND=0.0.0.0` in `.env`, restart Compose, and open `http://<host-LAN-address>:8080` from those devices. Apply local firewall and TLS policy before exposing the service beyond a trusted network.

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
- Read-only Google account playlist selection for the host's YouTube Music library
- Persistent player profiles, ordered nickname selection, and per-player statistics
- Per-seat random canonical role draw
- Round-table host dashboard with privacy shield
- 60/30/10-second timers and faint ten-second warning
- Foul, red-card, nomination, individual voting, Mafia shot, Don check, and Sheriff check controls
- Rotating day order, automatic win detection, and append-only PostgreSQL game events

Owner input still needed for a production table session: preferred fade durations/chime, red-card final-speech rule, initial languages, and any tie-vote rule that differs from `rules.md`.

YouTube Music does not expose a separate embeddable web player API. Account playlist selection uses Google OAuth plus the YouTube Data API at the private HTTPS origin; playback remains in a visible YouTube IFrame. Configure `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`, and `MUSIC_TOKEN_ENCRYPTION_KEY` together. The LAN HTTP mode retains playlist-ID playback only when account authorization is not configured.
