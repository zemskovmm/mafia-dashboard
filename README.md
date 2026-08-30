# Mafia Dashboard

A self-hosted web dashboard for moderating in-person Club Mafia games.

## Status

This repository contains the implemented touch-first TypeScript web application, its PostgreSQL service, and deployment configuration.

## Documentation

- [`rules.md`](rules.md) — canonical Club Mafia behavior, moderator workflows, data model, deployment baseline, and recorded product decisions/gaps.
- [`docs/product-outline.md`](docs/product-outline.md) — approved setup wizard, round-table UI, music/timer behavior, phase flow, and interaction contracts.
- [`docs/adr/0001-typescript-modular-monolith.md`](docs/adr/0001-typescript-modular-monolith.md) — initial SPA/API/PostgreSQL architecture decision.
- [`docs/azure-deployment.md`](docs/azure-deployment.md) — Azure Container Apps, private PostgreSQL, GitHub OIDC deployment, and rollback runbook.
- [`docs/self-hosted-deployment.md`](docs/self-hosted-deployment.md) — single-host Docker Compose, one-shot migrations, external TLS, bounded logs, upgrades, and rollback.
- [`docs/security-and-privacy.md`](docs/security-and-privacy.md) — threat model, security controls, supply-chain gates, verification, and residual risks.
- [GitHub issues](https://github.com/zemskovmm/mafia-dashboard/issues) — dependency-aware implementation backlog.

## Architecture direction

The application is a TypeScript npm workspace with a React/Vite SPA, Fastify API, pure game-domain package, and a revisioned PostgreSQL game-session aggregate. Setup state is persisted directly; live play is derived from an immutable game baseline and parent-linked semantic events. Local development uses Docker Compose; production deploys to Azure Container Apps with private PostgreSQL Flexible Server persistence.

## Run locally with Docker

1. Copy `.env.example` to `.env`, set a local PostgreSQL password, and set `PUBLIC_APP_URL` to the exact browser origin (for example, `http://localhost:8080` for local development or the private HTTPS origin used by tablets).
2. Create a Google OAuth 2.0 **Web application** client. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then authorize `${PUBLIC_APP_URL}/api/auth/google/callback` as a redirect URI. This OpenID Connect flow creates the application's own hashed, HttpOnly database session; the browser never stores Google tokens. Sessions have a fixed, non-sliding 30-day lifetime, and sign-out revokes the current browser's token.
3. To browse the host account's YouTube Music library, also authorize `${PUBLIC_APP_URL}/api/music/oauth/callback`, set that exact value as `GOOGLE_OAUTH_REDIRECT_URI`, and generate `MUSIC_TOKEN_ENCRYPTION_KEY` as shown in `.env.example`. You can instead use `VITE_YOUTUBE_PLAYLIST_ID` or enter a playlist ID in setup.
4. Start the application:

   ```bash
   docker compose build app
   docker compose up --detach --no-build --wait
   ```

5. Open the configured `PUBLIC_APP_URL`. To allow tablets/laptops on the trusted LAN, set `APP_BIND=0.0.0.0` and use a private HTTPS origin such as Tailscale HTTPS. Apply local firewall and TLS policy before exposing the service beyond a trusted network.

Cookie-authenticated mutations require an exact `Origin` match with `PUBLIC_APP_URL`. Google sign-in initiation and valid callback completion share a per-source limit of 10 attempts per 10 minutes; rejected attempts return `429` with `Retry-After`. Keep `TRUST_PROXY_HOPS=0` for direct access. The production runbooks set it to `1` only where one controlled ingress is the sole path to the application.

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
npm run verify:compose
```

`npm run dev` applies the idempotent schema migration before starting the server and web watchers. The production Compose stack and Azure deployment instead run the same migration bundle as a one-shot job before the web process starts.

Server integration tests expect PostgreSQL at `postgresql://mafia:mafia@127.0.0.1:54329/mafia_test`, or use `TEST_DATABASE_URL` to override it.

## Current implementation slice

- Guided ten-player setup and real playback gate from YouTube IFrame state
- Google OpenID Connect sign-in with revocable application sessions and per-club isolation
- Customizable CSS-native glass skin with a persisted base color
- Read-only Google account playlist selection plus a browser-local application session queue with repeated entries, drag reordering, and **Play next** / **Play now** controls
- Persistent player profiles, ordered nickname selection, and per-player statistics
- Per-seat random canonical role draw
- Round-table host dashboard with privacy shield
- 60/30/10-second timers and faint ten-second warning
- Foul, red-card, nomination, individual voting, Mafia shot, Don check, and Sheriff check controls
- Rotating day order, automatic win detection, and atomic PostgreSQL persistence of setup state followed by an immutable game baseline and parent-linked semantic events
- Durable browser outbox plus **Active games** resume for full setup/live state, host, playlist, log, and undo recovery
- Replay validation of parent links and state hashes, one active event head, and retained inactive future branches
- Three-action ordinary undo by moving the active head, with every new day as a checkpoint; timer and music controls remain non-durable UI state

The current 2-second fade-in, 500-millisecond quick fade-out, 3-second slow fade-out, faint ten-second warning chime, no-final-speech red-card behavior, and `rules.md` tie conventions are accepted. The initial product must support English and Russian, but the current UI is English-only. Best Move must become a per-club setting enabled by default, but the current flow is not configurable per club. The production backup direction remains unresolved.

YouTube Music does not expose a separate embeddable web player API. Account playlist selection uses a separate read-only Google OAuth grant plus the YouTube Data API; playback remains in a visible YouTube IFrame. Application sign-in and YouTube library authorization share the configured Google client but use separate callbacks and separate local session/token storage.
