# La Verdad

The official application of [La Verdad · Málaga](https://mafiamalaga.es): a self-hosted web dashboard for moderating in-person Club Mafia games.

## Status

This repository contains the touch-first TypeScript web application with Azure Table/private Blob persistence for local development and Azure deployment. PostgreSQL remains available for Docker Compose, reference tests and deferred one-time data migration. The Azure release starts empty; deployment never imports or deletes the old PostgreSQL data.

## Documentation

- [`rules.md`](rules.md) — canonical Club Mafia behavior, moderator workflows, data model, deployment baseline, and recorded product decisions/gaps.
- [`docs/product-outline.md`](docs/product-outline.md) — approved setup wizard, round-table UI, music/timer behavior, phase flow, and interaction contracts.
- [`docs/architecture.md`](docs/architecture.md) — current workspace boundaries, client rendering, and lighting-renderer lifecycle.
- [`docs/adr/0001-typescript-modular-monolith.md`](docs/adr/0001-typescript-modular-monolith.md) — initial SPA/API/PostgreSQL architecture decision.
- [`docs/azure-deployment.md`](docs/azure-deployment.md) — Azure Container Apps, identity-authenticated Table/private Blob storage, GitHub OIDC deployment and rollback boundaries.
- [`docs/self-hosted-deployment.md`](docs/self-hosted-deployment.md) — single-host Docker Compose, one-shot migrations, external TLS, bounded logs, upgrades, and rollback.
- [`docs/postgresql-backup-and-recovery.md`](docs/postgresql-backup-and-recovery.md) — scheduled PostgreSQL backups, off-server retention, restore verification, and disaster recovery.
- [`docs/azure-storage-backup-and-recovery.md`](docs/azure-storage-backup-and-recovery.md) — local Table/private Blob packages, owner-checked freeze recovery and isolated restore; not a production cutover.
- [`docs/postgres-to-azure-migration.md`](docs/postgres-to-azure-migration.md) — explicit deferred business-data import into an empty target, excluding sessions and music connections; never run automatically by deployment.
- [`docs/security-and-privacy.md`](docs/security-and-privacy.md) — threat model, security controls, supply-chain gates, verification, and residual risks.
- [GitHub issues](https://github.com/zemskovmm/mafia-dashboard/issues) — dependency-aware implementation backlog.

## Architecture direction

The application is a TypeScript npm workspace with a React/Vite SPA, Fastify API, pure game-domain package, and remotely published game-session snapshots. Setup state is persisted directly; live play is derived from an immutable game baseline and parent-linked semantic events. The client defaults to V-GPU lighting, retains existing CSS lighting while V-GPU starts or fails, and offers a **Raytracing** toggle to switch between GPU and legacy CSS. Local development starts the API, Vite, and an owned Azurite emulator together, without PostgreSQL. Azure deployment explicitly selects Table/Blob with managed identity; Docker Compose retains PostgreSQL. [IDD-0006](.idd/intent/IDD-0006.adr-azure-table-and-blob-persistence.md) records persistence and deferred migration boundaries. Automated production Storage backups are not configured by this release.

## Default development app (Mac and iPad)

Prerequisites: Node 22+ and npm 10+; the pinned Azurite dependency is installed with the workspace. PostgreSQL **17** tools (`initdb`, `pg_ctl`, `createdb`, `psql`) on `PATH` are needed only for the retained reference tests/checks, not normal Azure development. The default private HTTPS route also requires this Mac's Tailscale connection and existing Serve mapping:

**<https://mbp16.tail102fab.ts.net> → `http://127.0.0.1:5173`**

```bash
npm install
npm run dev
```

This starts an owned loopback Azurite service (Blob/Queue/Table ports 13500/13501/13502), initializes or validates its application namespace, starts the real API on port 3000 and the Vite frontend on port 5173, and checks readiness. The launcher verifies the existing Tailscale route without changing Serve, enabling Funnel, or opening LAN listeners. It fails on occupied ports rather than silently choosing another app URL. Press Ctrl+C to stop its processes; the private persistent dataset is retained under ignored `.AI/local-azurite/dev/`. It never automatically resets an existing dataset or imports the previous local PostgreSQL data.

The emulator uses loopback-only services, a generated local account key and owner-only storage. Treat it as a trusted single-user development fixture, not production storage. Production Azure access uses the application's server identity; emulator credentials are never a remote-storage fallback.

For real Google sign-in, supply `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the ignored, owner-readable-only `.env.local` file. The launcher does not reuse the Docker `.env` implicitly. Register this exact redirect URI in your Google **Web application** OAuth client:

`https://mbp16.tail102fab.ts.net/api/auth/google/callback`

YouTube playlist connection uses the same Google client but needs two additional server-only settings in `.env.local`:

- `GOOGLE_OAUTH_REDIRECT_URI=https://mbp16.tail102fab.ts.net/api/music/oauth/callback` — register this **additional** redirect URI on the same Google Web application client, keeping the app sign-in callback above.
- `MUSIC_TOKEN_ENCRYPTION_KEY` — a persistent cryptographically random 32-byte base64url key. Generate it once for this local database, keep it private, and never replace an existing key: stored YouTube grants depend on it.

Enable YouTube Data API v3 for that Google project and allow the connecting account through its OAuth consent configuration. Restart `npm run dev` after changing `.env.local`, then connect the account from Music player setup. Use the Tailscale HTTPS origin for this flow because music OAuth cookies require HTTPS. Configured settings do not prove Google consent or playlist access has succeeded.

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

`npm run dev` initializes an empty recognized Azure namespace or validates its current control record before starting the server and web watchers. The unchanged production Compose/Azure PostgreSQL deployment still runs its advisory-locked, transaction-protected schema bundle as a one-shot job. Only empty or recognized current stores are supported; historical upgrades and data imports are not provided. Keep unsupported stores intact rather than bypassing the startup gate or resetting them automatically.

`test:local` runs Azure regressions against owned disposable Azurite fixtures and retains the existing SQL reference suites against a fresh disposable PostgreSQL cluster. `check:local` runs the full `npm run check` (format, lint, typecheck, tests, build) with both protected test backends available. Generated test targets are loopback-only and isolated from the persistent development dataset; each launcher removes only its owned disposable state and preserves the child exit status. Tests do not load development OAuth credentials or change Tailscale routing. Focused commands can use the same wrapper, for example `npm run test:local -- -- npm run test -w @mafia/server -- src/config.test.ts`. `node scripts/test-local.mjs --postgres --check` retains the PostgreSQL-only outer wrapper; Azure regression cases still own their independent emulator fixtures.

`verify:local` still qualifies the retained PostgreSQL reference stack with a separate real frontend/API/database. Synthetic short-lived sessions are confined to its disposable database; application API responses are not mocked. Azure regressions execute real emulator-backed authenticated API flows in the canonical checks. Neither path validates Google's external login/consent flow or proves an actual iPad session; those require a separate check through the private HTTPS URL and iPad Safari.

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
