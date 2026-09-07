# Mafia Dashboard

A self-hosted web dashboard for moderating in-person Club Mafia games.

## Status

This repository contains the implemented touch-first TypeScript web application, its PostgreSQL service, and deployment configuration.

## Documentation

- [`rules.md`](rules.md) — canonical Club Mafia behavior, moderator workflows, data model, deployment baseline, and recorded product decisions/gaps.
- [`docs/product-outline.md`](docs/product-outline.md) — approved setup wizard, round-table UI, music/timer behavior, phase flow, and interaction contracts.
- [`docs/architecture.md`](docs/architecture.md) — current workspace boundaries, client rendering, and lighting-renderer lifecycle.
- [`docs/adr/0001-typescript-modular-monolith.md`](docs/adr/0001-typescript-modular-monolith.md) — initial SPA/API/PostgreSQL architecture decision.
- [`docs/azure-deployment.md`](docs/azure-deployment.md) — Azure Container Apps, private PostgreSQL, GitHub OIDC deployment, and rollback runbook.
- [`docs/self-hosted-deployment.md`](docs/self-hosted-deployment.md) — single-host Docker Compose, one-shot migrations, external TLS, bounded logs, upgrades, and rollback.
- [`docs/postgresql-backup-and-recovery.md`](docs/postgresql-backup-and-recovery.md) — scheduled PostgreSQL backups, off-server retention, restore verification, and disaster recovery.
- [`docs/security-and-privacy.md`](docs/security-and-privacy.md) — threat model, security controls, supply-chain gates, verification, and residual risks.
- [GitHub issues](https://github.com/zemskovmm/mafia-dashboard/issues) — dependency-aware implementation backlog.

## Architecture direction

The application is a TypeScript npm workspace with a React/Vite SPA, Fastify API, pure game-domain package, and a revisioned PostgreSQL game-session aggregate. Setup state is persisted directly; live play is derived from an immutable game baseline and parent-linked semantic events. The client defaults to V-GPU lighting, retains existing CSS lighting while V-GPU starts or fails, and offers a **Raytracing** toggle to switch between GPU and legacy CSS. Local development starts the API, Vite, and an owned native PostgreSQL cluster together; Docker Compose remains an alternative. Production deploys to Azure Container Apps with private PostgreSQL Flexible Server persistence.

## Default development app (Mac and iPad)

Prerequisites: Node 22+, npm 10+, and PostgreSQL **17** tools (`initdb`, `pg_ctl`, `createdb`, `psql`) on `PATH`. The default private HTTPS route also requires this Mac's Tailscale connection and existing Serve mapping:

**<https://mbp16.tail102fab.ts.net> → `http://127.0.0.1:5173`**

```bash
npm install
npm run dev
```

This starts persistent PostgreSQL on loopback port 54328, validates/initializes the current schema, starts the real API on port 3000 and the Vite frontend on port 5173, and checks readiness. The launcher verifies the existing Tailscale route without changing Serve, enabling Funnel, or opening LAN listeners. It fails on occupied ports rather than silently choosing another app URL. Press Ctrl+C to stop its processes; data is retained under ignored `postgres-data/local/`. It never automatically resets an existing database.

The native development database uses loopback-only trust authentication and owner-only storage. Use it on a trusted, single-user development machine: other local OS users could access it. It is not a production database configuration.

For real Google sign-in, supply `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the ignored, owner-readable-only `.env.local` file. The launcher does not reuse the Docker `.env` implicitly. Register this exact redirect URI in your Google **Web application** OAuth client:

`https://mbp16.tail102fab.ts.net/api/auth/google/callback`

Credentials are server-only; do not put them in `VITE_*` variables. The launcher pins the local database and approved public origin rather than inheriting deployment targets. Missing Google configuration is a sign-in blocker even if database/API health succeeds. Cookie-authenticated mutations retain exact-origin checks and Secure, HttpOnly cookies.

On iPad, connect Tailscale and open the same HTTPS URL in Safari. Keep this Mac awake with `npm run dev` running. Both devices use the same backend database, but login cookies and browser-local active-game state remain separate; this does not add live cross-device synchronization.

Use `npm run dev:localhost` deliberately for a localhost-only session; it uses `http://localhost:5173` and requires its own registered `/api/auth/google/callback` URI. There is no silent fallback when Tailscale is unavailable. `npm run dev:web` is explicitly frontend-only and requires an independently running API or a fixture-driven test browser—it is not the normal app startup command. Changing origins does not transfer browser-local state or login cookies.

## Run locally with Docker

1. Copy `.env.example` to `.env`, set a local PostgreSQL password, and set `PUBLIC_APP_URL` to the exact browser origin (for example, `http://localhost:8080` for local development or the private HTTPS origin used by tablets).
2. Create a Google OAuth 2.0 **Web application** client. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then authorize `${PUBLIC_APP_URL}/api/auth/google/callback` as a redirect URI. This OpenID Connect flow creates the application's own hashed, HttpOnly database session; the browser never stores Google tokens. Sessions have a fixed, non-sliding 30-day lifetime, and sign-out revokes the current browser's token.
3. To browse and play the host account's YouTube Music library, also authorize `${PUBLIC_APP_URL}/api/music/oauth/callback`, set that exact value as `GOOGLE_OAUTH_REDIRECT_URI`, and generate `MUSIC_TOKEN_ENCRYPTION_KEY` as shown in `.env.example`. A connected music account is required for playback; `VITE_YOUTUBE_PLAYLIST_ID` may set a post-connection default but cannot bypass account connection.
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
npm run test:local
npm run verify:local
npm run check:local
npm run verify:compose
npm run verify:backup
```

`npm run dev` initializes or validates the current schema before starting the server and web watchers. Production Compose and Azure run the same advisory-locked, transaction-protected bundle as a one-shot job before the web process starts. Only an empty database or the current schema is supported; historical schema upgrades and data backfills are not provided. Keep unsupported databases intact and do not bypass the startup gate or reset an existing environment automatically.

`test:local` runs the existing tests against a fresh disposable PostgreSQL cluster. `check:local` runs the full `npm run check` (format, lint, typecheck, tests, build) in that same kind of isolated environment. Each run uses its own loopback port and directory under ignored `postgres-data/tests/`, removes only its owned disposable data afterward, and preserves the child command's exit status. Tests do not load development OAuth credentials, use the development database, or change Tailscale routing. Focused commands can use the same wrapper, for example `npm run test:local -- -- npm run test -w @mafia/server -- src/config.test.ts`.

`verify:local` starts a separate real frontend/API/database and exercises cookie-session authentication, club isolation, and persistence. Synthetic short-lived sessions are confined to its disposable database; application API responses are not mocked. This does **not** validate Google's external login/consent flow or prove an actual iPad session. Those require a separate check through the private HTTPS URL and iPad Safari.

Direct `npm run test` and `npm run check` keep their existing externally provisioned PostgreSQL contract (`TEST_DATABASE_URL`, otherwise the test endpoint on port 54329). Never point them at an application database. Native-cluster lifecycle tests are explicitly skipped where PostgreSQL tools are unavailable; the local wrappers require them.

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
- Browser-authoritative full session snapshots plus **Active games** resume for setup/live state, host, playlist, Log/Timeline history, and Undo recovery
- One browser-wide v5 localStorage game with explicit club/game ownership; no old-format or sessionStorage game recovery. Invalid current-key data blocks gameplay until explicitly cleared. Old game/theme/music keys are ignored, not migrated or swept.
- Current-format API snapshots and SHA-256 replay only; historical normalization, replay adapters, and raw game mutation endpoints are not supported. V-GPU is the default lighting renderer; switching **Raytracing** off selects legacy CSS. GPU card-glow pulsing is adjustable, and red highlights have procedural flames.
- Server validation of snapshot invariants plus semantic-event parent links and state hashes; PostgreSQL mirrors the last uploaded valid browser snapshot
- Destructive three-action Undo and Timeline Reset with every new day as a checkpoint; discarded event tails are permanently removed and timer/music controls remain non-durable UI state

The current 2-second fade-in, 500-millisecond quick fade-out, 3-second slow fade-out, faint ten-second warning chime, no-final-speech red-card behavior, and `rules.md` tie conventions are accepted. The initial product must support English and Russian, but the current UI is English-only. Best Move must become a per-club setting enabled by default, but the current flow is not configurable per club. Production PostgreSQL backups use verified custom archives, independent local/off-server retention, and isolated semantic restore tests.

YouTube Music does not expose a separate embeddable web player API. Account playlist selection uses a separate read-only Google OAuth grant plus the YouTube Data API; playback remains in a visible YouTube IFrame. Application sign-in and YouTube library authorization share the configured Google client but use separate callbacks and separate local session/token storage.
