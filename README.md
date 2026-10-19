# La Verdad

The official application of [La Verdad · Málaga](https://mafiamalaga.es): a self-hosted web dashboard for moderating in-person Club Mafia games.

## Status

This repository contains the touch-first TypeScript web application with Azure Table/private Blob persistence for local development and Azure deployment. Azure is the sole supported backend; PostgreSQL, its Compose deployment and the SQL-to-Azure importer are retired. Existing databases and archives are not deleted or converted by the application.

## Documentation

- [Current product intent](.idd/intent/INDEX.md) — owning specifications for club access, gameplay, presentation, game records and persistence.
- [`rules.md`](rules.md) — supporting Club Mafia rules, moderator workflows and product context.
- [`docs/product-outline.md`](docs/product-outline.md) — approved setup wizard, round-table UI, music/timer behavior, phase flow, and interaction contracts.
- [`docs/architecture.md`](docs/architecture.md) — current workspace boundaries, client rendering, and lighting-renderer lifecycle.
- [`docs/adr/0001-typescript-modular-monolith.md`](docs/adr/0001-typescript-modular-monolith.md) — initial SPA/API/PostgreSQL architecture decision.
- [`docs/azure-deployment.md`](docs/azure-deployment.md) — Azure Container Apps, identity-authenticated Table/private Blob storage, GitHub OIDC deployment and rollback boundaries.
- [`docs/public-website.md`](docs/public-website.md) — the separate static club website, local preview, assets and manual GitHub Pages publication.

- [`docs/azure-storage-backup-and-recovery.md`](docs/azure-storage-backup-and-recovery.md) — local Table/private Blob packages, owner-checked freeze recovery and isolated restore; not a production cutover.

- [`docs/security-and-privacy.md`](docs/security-and-privacy.md) — threat model, security controls, supply-chain gates, verification, and residual risks.
- [GitHub issues](https://github.com/zemskovmm/mafia-dashboard/issues) — dependency-aware implementation backlog.

## Architecture direction

The application is a TypeScript npm workspace with a React/Vite SPA, Fastify API, pure game-domain package, and remotely published game-session snapshots. Setup state is persisted directly; live play is derived from an immutable game baseline and parent-linked semantic events. The client defaults to V-GPU lighting, retains existing CSS lighting while V-GPU starts or fails, and offers a **Raytracing** toggle to switch between GPU and legacy CSS. Local development starts the API, Vite, and an owned Azurite emulator together. Azure deployment uses Table/Blob with managed identity and the existing application Docker image. [IDD-0006](.idd/intent/IDD-0006.adr-azure-table-and-blob-persistence.md) records the supported persistence boundary. Automated production Storage backups are not configured by this release.

## Default development app (Mac and iPad)

For the backend-free public club website instead, run `npm run dev -w @mafia/site` and open <http://127.0.0.1:5174/>. Its static GitHub Pages build is separate from the authenticated host application described below.

Prerequisites: Node 22+ and npm 10+; the pinned Azurite dependency is installed with the workspace. Development and local checks require no PostgreSQL service or client tools. The default private HTTPS route also requires this Mac's Tailscale connection and existing Serve mapping:

**<https://mbp16.tail102fab.ts.net> → `http://127.0.0.1:5173`**

```bash
npm install
npm run dev
```

This starts an owned loopback Azurite service (Blob/Queue/Table ports 13500/13501/13502), initializes or validates its application namespace, starts the real API on port 3000 and the Vite frontend on port 5173, and checks readiness. The launcher verifies the existing Tailscale route without changing Serve, enabling Funnel, or opening LAN listeners. It fails on occupied ports rather than silently choosing another app URL. Press Ctrl+C to stop its processes; the private persistent dataset is retained under ignored `.AI/local-azurite/dev/`. It never automatically resets an existing dataset or imports the previous local PostgreSQL data.

The emulator uses loopback-only services, a generated local account key and owner-only storage. Treat it as a trusted single-user development fixture, not production storage. Production Azure access uses the application's server identity; emulator credentials are never a remote-storage fallback.

For real Google sign-in, start from `.env.example` and supply `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the ignored, owner-readable-only `.env.local` file. The launcher supplies its own Azure namespace and does not reuse deployment configuration implicitly. Register this exact redirect URI in your Google **Web application** OAuth client:

`https://mbp16.tail102fab.ts.net/api/auth/google/callback`

YouTube playlist connection uses the same Google client but needs two additional server-only settings in `.env.local`:

- `GOOGLE_OAUTH_REDIRECT_URI=https://mbp16.tail102fab.ts.net/api/music/oauth/callback` — register this **additional** redirect URI on the same Google Web application client, keeping the app sign-in callback above.
- `MUSIC_TOKEN_ENCRYPTION_KEY` — a persistent cryptographically random 32-byte base64url key. Generate it once for this local database, keep it private, and never replace an existing key: stored YouTube grants depend on it.

Enable YouTube Data API v3 for that Google project and allow the connecting account through its OAuth consent configuration. Restart `npm run dev` after changing `.env.local`, then connect the account from Music player setup. Use the Tailscale HTTPS origin for this flow because music OAuth cookies require HTTPS. Configured settings do not prove Google consent or playlist access has succeeded.

Credentials are server-only; do not put them in `VITE_*` variables. The launcher pins the local database and approved public origin rather than inheriting deployment targets. Missing Google configuration is a sign-in blocker even if database/API health succeeds. Cookie-authenticated mutations retain exact-origin checks and Secure, HttpOnly cookies.

On iPad, connect Tailscale and open the same HTTPS URL in Safari. Keep this Mac awake with `npm run dev` running. Both devices use the same backend database, but login cookies and browser-local active-game state remain separate; this does not add live cross-device synchronization.

Use `npm run dev:localhost` deliberately for a localhost-only session; it uses `http://localhost:5173` and requires its own registered `/api/auth/google/callback` URI. There is no silent fallback when Tailscale is unavailable. `npm run dev:web` is explicitly frontend-only and requires an independently running API or a fixture-driven test browser—it is not the normal app startup command. Changing origins does not transfer browser-local state or login cookies.

## Authentication and health

Google sign-in creates the application's own hashed, HttpOnly session; the browser never stores Google tokens. Sessions have a fixed, non-sliding 30-day lifetime, and sign-out revokes the current browser's token. A connected music account is required for playback; `VITE_YOUTUBE_PLAYLIST_ID` may set a post-connection default but cannot bypass account connection.

Cookie-authenticated mutations require an exact `Origin` match with `PUBLIC_APP_URL`. Google sign-in initiation and valid callback completion share a per-source limit of 10 attempts per 10 minutes; rejected attempts return `429` with `Retry-After`. Keep `TRUST_PROXY_HOPS=0` for direct access. The production runbooks set it to `1` only where one controlled ingress is the sole path to the application.

Health checks:

- <http://127.0.0.1:3000/health/live>
- <http://127.0.0.1:3000/health/ready>

## Development quality commands

```bash
npm install
npm run dev
npm run test:local
npm run verify:local
npm run check:local
npm run verify:storage-backup
```

`npm run dev` initializes an empty recognized Azure namespace or validates its current control record before starting the server and web watchers. The Azure production image retains its separate `initialize-storage` entry point. Only empty or recognized current stores are supported; historical upgrades and data imports are not provided. Keep unsupported stores intact rather than bypassing the startup gate or resetting them automatically.

`test:local` runs regressions against owned disposable Azurite fixtures. `check:local` runs the full `npm run check` (format, lint, typecheck, tests, build) with the protected Azure fixture. Generated targets are loopback-only and isolated from the persistent development dataset; each launcher removes only its owned disposable state and preserves the child exit status. Tests do not load development OAuth credentials or change Tailscale routing. Focused commands can use the same wrapper, for example `npm run test:local -- -- npm run test -w @mafia/server -- src/config.test.ts`. The retired `--postgres` mode is unsupported.

`verify:local` qualifies a separate real frontend/API/Azurite stack. Synthetic short-lived sessions are confined to its disposable store; application API responses are not mocked. Azure regressions also execute real emulator-backed authenticated API flows in the canonical checks. Neither path validates Google's external login/consent flow or proves an actual iPad session; those require a separate check through the private HTTPS URL and iPad Safari.

Use the local wrappers for the complete owned-fixture gate. No SQL reference suites, native-cluster prerequisites or externally supplied database URL remain in the maintained checks.

## Current implementation slice

- Guided ten-player setup and real playback gate from YouTube IFrame state
- Google OpenID Connect sign-in with revocable application sessions and per-club isolation; managers and regular members can manage game records in their own club, while club and player-profile administration remain manager-only
- Customizable CSS-native glass skin with a persisted base color
- Read-only Google account playlist selection plus a browser-local application session queue with repeated entries, drag reordering, and **Play next** / **Play now** controls
- Persistent player profiles, ordered nickname selection, and per-player statistics
- Per-seat random canonical role draw
- Round-table host dashboard with privacy shield
- 60/30/10-second timers and faint ten-second warning
- Foul, red-card, nomination, individual voting, Mafia shot, Don check, and Sheriff check controls
- Rotating day order, automatic win detection, and atomic Azure persistence of setup state followed by an immutable game baseline and parent-linked semantic events
- Browser-authoritative full session snapshots plus **Active games** resume for setup/live state, host, playlist, Log/Timeline history, and Undo recovery
- One browser-wide v5 localStorage game with explicit club/game ownership; no old-format or sessionStorage game recovery. Invalid current-key data blocks gameplay until explicitly cleared. Old game/theme/music keys are ignored, not migrated or swept.
- Current-format API snapshots and client-side SHA-256 replay checks; historical normalization, replay adapters, and raw game mutation endpoints are not supported. V-GPU is the default lighting renderer; switching **Raytracing** off selects legacy CSS. GPU card-glow pulsing is adjustable, and red highlights have procedural flames.
- Azure stores the last accepted browser snapshot and synchronized projections; the browser owns gameplay and semantic replay validation. The server checks authentication, club membership, transport shape and identity references, not game-rule legality or replay hashes.
- Destructive three-action Undo and Timeline Reset with every new day as a checkpoint; discarded event tails are permanently removed and timer/music controls remain non-durable UI state

The current 2-second fade-in, 500-millisecond quick fade-out, 3-second slow fade-out, faint ten-second warning chime, no-final-speech red-card behavior, and `rules.md` tie conventions are accepted. The UI supports English and Russian: browser language before club entry, then the selected club's language. Best Move is a per-club setting, enabled by default and captured for each game. Azure backup/recovery is locally qualified; production scheduling and recovery remain separate operational work.

YouTube Music does not expose a separate embeddable web player API. Account playlist selection uses a separate read-only Google OAuth grant plus the YouTube Data API; playback remains in a visible YouTube IFrame. Application sign-in and YouTube library authorization share the configured Google client but use separate callbacks and separate local session/token storage.
