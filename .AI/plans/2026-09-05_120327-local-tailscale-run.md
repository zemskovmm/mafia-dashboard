# Local Mafia Dashboard over Tailscale Plan

**Goal:** Run the current checkout on this Mac and make the authenticated application reachable through private Tailscale HTTPS.

**Plain-language summary:** Start the local application and its database without changing source or production, reconnect Tailscale, and route its private HTTPS address to the loopback-only app. Verify the page, database health, and authentication before reporting a working URL.

**Architecture:** Use the repository's Docker Compose application and PostgreSQL, with host port 8080 bound to 127.0.0.1. Tailscale Serve terminates private HTTPS and proxies to that port. Existing Compose restart policies own process lifecycle; do not add a competing supervisor.

**Tech stack:** Docker Compose, PostgreSQL 17, Fastify, built React/Vite frontend, Tailscale Serve.

**Non-goals:** Source edits, frontend HMR, production changes, public Funnel/LAN exposure, new authentication mechanisms, database resets/backfills, commits/pushes, or unrelated dirty-file changes.

## Observed context

- Branch `main`; four pre-existing modified files: `.github/workflows/deploy-azure.yml`, `docs/azure-deployment.md`, `infra/main.bicep`, `scripts/security-workflow-contracts.test.mjs`. Preserve these and the existing production-cutover plan.
- No app listeners on 3000, 5173, or 8080.
- Docker responds, but its current context lists no containers. Existing named volume `mafiadashboard_mafia-postgres` must be preserved; schema compatibility is unknown.
- Compose parsing fails because `DATABASE_URL` is missing. Credential files have not been read or modified.
- Tailscale reports `Stopped`, no current IP/DNS name, and empty Serve configuration. Historical hostname `mbp16.tail102fab.ts.net` is present in Vite configuration but must not be assumed to be the current node URL.
- `README.md:24-43`, `compose.yaml`, and `Dockerfile` document the local built-app route. `apps/server/src/config.ts` requires Google OAuth credentials and `PUBLIC_APP_URL` for configured login. Cookie mutations require the exact configured origin.

## Preconditions / approval boundary

Execution requires explicit approval. Before app startup, obtain the user-designated existing local environment source and explicit permission to let Compose consume it without printing secrets. Do not guess database credentials, retrieve production secrets, create a replacement database, or read credential files without authorization. If local configuration is unavailable, stop for setup rather than expose a nonfunctional login page.

## Steps

1. Recheck Git status, Docker context/containers, and port occupancy. Resolve the local configuration source with the user. Verify only non-secret configuration facts: local database destination, loopback host binding, OAuth configuration presence, and intended browser origin. Never output expanded Compose configuration or container environment arrays.
2. Reconnect the existing Tailscale node using `tailscale up` with a bounded tool timeout. Preserve non-default settings; do not reset or force reauthentication. If login is required, return the actual login URL to the user. Read `tailscale status --json` and `tailscale serve status --json` again, extracting only necessary network facts.
3. Set the non-secret runtime `PUBLIC_APP_URL` to the verified private HTTPS origin and `APP_BIND=127.0.0.1`, retaining the existing Google client and local database settings. Confirm that the Google callback is authorized; ask the user when provider-side confirmation is unavailable.
4. Using the authorized environment source, run `docker compose build app`, then `docker compose up --detach --no-build --wait` with a bounded readiness timeout. The one-shot migration may initialize an empty database or validate the current schema. If it rejects an old schema, stop without resetting or modifying existing data outside that supported gate.
5. On loopback, verify `/`, `/health/live`, `/health/ready`, `/api/auth/session`, an anonymous protected API request, and Google login initiation. Expect HTML 200, healthy database, authentication configured, unauthorized protected access, and a provider redirect respectively. Keep secrets, cookies, and OAuth state out of printed results.
6. After authentication configuration and gating are proven, run `tailscale serve --bg --yes http://127.0.0.1:8080`. If Serve needs admin enablement, return its exact enablement URL; do not use Funnel or an all-interface fallback. Read back Serve status and verify private-only routing.
7. Repeat page, readiness, session, and protected-route checks through the actual HTTPS URL. Open the app in a browser and verify rendered login UI without console/startup failures. Ask for user completion of interactive Google login if required; do not claim a successful login based only on a redirect.
8. Inspect container health, restart policy, and host port binding. Report the exact URL and stop command, with off-device access explicitly unverified unless an authorized second tailnet client is available. Recheck Git status; remove this plan only after successful verification.

## Files and verification

- No source/configuration file edits planned; only this plan is created. Any required persistent credential/configuration edits return to clarification.
- Relevant runtime definitions: `compose.yaml`, `Dockerfile`, `apps/server/src/config.ts`, `apps/server/src/app.ts`.
- Runtime-only acceptance uses real HTTP/browser checks, Compose health, and Tailscale status. Run `npm run check` if repository code changes become necessary, after separate scope approval.

## Acceptance criteria

- Current checkout builds and the local app/database reach ready state without deleting existing data.
- Host app exposure remains loopback-only; remote route is Tailscale Serve HTTPS, not Funnel or LAN.
- Private URL returns the app and successful readiness; authentication is configured and anonymous protected access denied.
- Interactive login and off-device verification are either actually completed or explicitly recorded as outstanding, never implied.
- Production, source files, existing dirty work, and unrelated services remain unchanged.

## Risks and rollback

- Missing configuration is currently a startup blocker; Tailscale may additionally require login or Serve enablement.
- Existing PostgreSQL volume may be incompatible with the current-only schema. Preserve it and stop if rejected.
- OAuth uses one exact origin; use the private HTTPS URL on this Mac as well for sign-in and mutations, even though the loopback URL remains available for health checks.
- Rollback only the Serve handler created by this task and stop this Compose project while retaining volumes. Never run volume deletion or global Docker/Tailscale resets.
