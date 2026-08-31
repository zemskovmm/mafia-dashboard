# Self-hosted production deployment

This guide deploys Mafia Dashboard on one Linux host with Docker Engine and Docker Compose v2. PostgreSQL runs in a private Compose network with a named volume; the application binds to loopback by default and expects an external HTTPS reverse proxy.

The Compose deployment is pilot-grade rather than highly available. Choose and test a backup/restore policy before production; backup automation is tracked separately in [issue #22](https://github.com/zemskovmm/mafia-dashboard/issues/22).

## Prerequisites

- Docker Engine with the Compose v2 plugin
- a DNS name that resolves to the host
- a reverse proxy that obtains and renews TLS certificates
- an immutable application image reference for production, preferably a registry digest
- enough disk space for PostgreSQL, Docker's bounded local logs, and operational headroom

Clone the repository only for the Compose definition and runbook. Do not place credentials in the image or commit a populated `.env` file.

## Configure the deployment

Create a root-owned deployment directory, copy `compose.yaml` and `.env.example` into it, rename the example to `.env`, and restrict the file to the deployment account:

```bash
chmod 600 .env
```

Set at least:

```dotenv
APP_IMAGE=ghcr.io/zemskovmm/mafia-dashboard@sha256:<verified-digest>
APP_BIND=127.0.0.1
APP_PORT=8080
TRUST_PROXY_HOPS=1
PUBLIC_APP_URL=https://mafia.example.com
POSTGRES_USER=mafia
POSTGRES_PASSWORD=<long-random-password>
POSTGRES_DB=mafia
DATABASE_URL=postgresql://mafia:<percent-encoded-password>@db:5432/mafia
GOOGLE_CLIENT_ID=<google-web-client-id>
GOOGLE_CLIENT_SECRET=<google-web-client-secret>
GOOGLE_OAUTH_REDIRECT_URI=https://mafia.example.com/api/music/oauth/callback
MUSIC_TOKEN_ENCRYPTION_KEY=<32-byte-base64url-key>
```

Use the exact browser origin for `PUBLIC_APP_URL`. Register these exact Google callback URLs:

```text
https://mafia.example.com/api/auth/google/callback
https://mafia.example.com/api/music/oauth/callback
```

`PUBLIC_APP_URL` is also the CSRF trust boundary: every cookie-authenticated `POST`, `PUT`, `PATCH`, or `DELETE` request must carry that exact browser origin. Keep the reverse proxy and browser on the same canonical origin; alternate hostnames or ports are rejected. Application sessions are absolute and non-sliding for 30 days, and sign-out revokes only the presented session so other explicitly signed-in devices remain active. Google sign-in initiation and valid callback completion share an in-process limit of 10 attempts per source IP every 10 minutes. `TRUST_PROXY_HOPS=1` makes that source the rightmost address supplied by the one supported reverse proxy; earlier forwarding values remain untrusted. The supported deployments run at most one application replica; revisit the limiter storage before enabling horizontal scale.

The complete HTTP policy, trust boundaries, scanning gates, and accepted residual risks are documented in [`security-and-privacy.md`](security-and-privacy.md).

`DATABASE_URL` is required and passed unchanged to both the migration and app containers. Keep `POSTGRES_PASSWORD` as the raw database password, but percent-encode that password in the URL userinfo when it contains reserved characters such as `@`, `:`, `/`, `?`, or `#`.

`APP_BIND=127.0.0.1` keeps the HTTP application private to the host. Compose does not publish PostgreSQL at all.

## Start a local build

For a source checkout, build the shared application image before starting the stack:

```bash
docker compose build app
docker compose up --detach --no-build --wait
```

Startup order is enforced:

1. PostgreSQL must pass `pg_isready`.
2. The one-shot `migrate` service applies the schema in one advisory-locked transaction and exits successfully.
3. The web process starts without applying schema changes.
4. The application must pass `/health/ready`.

A failed or interrupted migration exits non-zero and prevents the app service from starting. Re-running the migration is safe because the schema is idempotent and transaction-protected.

### Recover from a failed migration

1. Keep `app` stopped; never bypass its `service_completed_successfully` dependency.
2. Inspect `docker compose ps --all` and `docker compose logs migrate`.
3. Correct database reachability, credentials, TLS settings, disk capacity, or the image reference without editing schema manually.
4. Retry only the one-shot job:

   ```bash
   docker compose run --rm migrate
   ```

5. After it exits 0, run `docker compose up --detach --no-build --wait` and verify known-good game data.

The migration schema executes inside one PostgreSQL transaction, so an interrupted or failed attempt rolls back. If a migration committed but the new application is incompatible, keep the app stopped and follow the application/database rollback rules below; do not improvise a reverse migration.

## Start an immutable production image

Set `APP_IMAGE` to a verified registry digest, then pull and start without building local source:

```bash
docker compose pull app migrate
docker compose up --detach --no-build --wait
```

Confirm the one-shot job and runtime state:

```bash
docker compose ps --all
docker compose logs migrate
docker compose exec db sh -c 'pg_isready --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"'
APP_ORIGIN="http://$(docker compose port app 3000)"
curl --fail --silent "$APP_ORIGIN/health/live"
curl --fail --silent "$APP_ORIGIN/health/ready"
```

Expected results are `migrate` exited with code 0, `db` healthy, `app` healthy, and HTTP 200 from both endpoints. Readiness checks PostgreSQL; liveness only proves the process can answer HTTP.

## Use external PostgreSQL

For managed or separately operated PostgreSQL 17, set `DATABASE_URL` to the complete connection URL. Percent-encode credentials and require the provider's TLS mode, for example `sslmode=verify-full`. Both the migration job and web process receive this exact value.

Use the external-database overlay so Compose does not start the bundled PostgreSQL service or wait on its health check:

```bash
docker compose -f compose.yaml -f compose.external-db.yaml pull app migrate
docker compose -f compose.yaml -f compose.external-db.yaml up --detach --no-build --wait
```

The external service must already be reachable from the Docker network. If it is unavailable, the one-shot migration exits non-zero and the app remains stopped. Keep credentials in the restricted `.env` file or the host's secret manager; never put them in an image or command line.

## Reverse proxy and TLS

Terminate TLS in an existing reverse proxy and forward only to the loopback application port. A minimal Caddy site is:

```caddyfile
mafia.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

Validate certificate issuance and renewal, preserve the original `Host` and forwarded protocol headers, and allow inbound traffic only to ports 80/443. Caddy's `reverse_proxy` defaults discard caller-supplied `X-Forwarded-*` values before setting the client address; do not override that behavior. `TRUST_PROXY_HOPS=1` is safe only while Caddy is the sole proxy and `APP_BIND=127.0.0.1` prevents direct public access to the application. Use `TRUST_PROXY_HOPS=0` for direct access, and reassess the trust chain before adding a CDN or another proxy. Never expose port 3000 inside the container, the host loopback port, or PostgreSQL directly to the public internet.

After configuring the proxy, verify the public origin:

```bash
curl --fail --silent https://mafia.example.com/health/live
curl --fail --silent https://mafia.example.com/health/ready
```

The Azure Container Apps deployment uses managed HTTPS ingress instead of a host reverse proxy, but it uses the same one-shot migration image as an init container.

## Logs

Compose uses Docker's `local` logging driver with a `10m` maximum file and three retained files for the application and PostgreSQL containers. This bounds local container-log growth; it is not centralized audit-log retention.

```bash
docker compose logs --since 1h app
docker compose logs --since 1h db
docker compose logs migrate
```

If retention requirements exceed this baseline, ship logs to a separate protected destination before increasing local retention. Recreate containers after changing logging options.

## Graceful shutdown and persistence

The image declares `SIGTERM` as its stop signal. On shutdown, Fastify stops accepting work and drains requests before the PostgreSQL pool closes. Compose gives the process ten seconds in the production smoke check.

Stop the application while retaining data:

```bash
docker compose down
```

The named `mafia-postgres` volume survives ordinary container replacement and application upgrades. A volume is not a backup. Delete it only for an intentional destructive reset:

```bash
docker compose down --volumes
```

## Upgrade

1. Record the currently deployed `APP_IMAGE` digest and confirm the application is ready.
2. Complete the chosen database recovery checkpoint or backup procedure.
3. Set `APP_IMAGE` to the new verified digest.
4. Pull and start the release:

   ```bash
   docker compose pull app migrate
   docker compose up --detach --no-build --wait
   ```

5. Confirm `migrate` exited 0, both health endpoints return HTTP 200, and a known game can be opened.

Every `up` runs the one-shot migration before the replacement app starts. Do not start `app` directly around the dependency gate.

## Application rollback

If the schema remains compatible, restore the previous image digest and recreate the services:

```bash
docker compose pull app migrate
docker compose up --detach --no-build --wait
```

An application rollback does not reverse database changes. If a release introduces an incompatible or destructive migration, stop and use the separately tested database restore procedure; do not guess at manual schema reversal.

## Local production smoke verification

From a source checkout with Docker running:

```bash
npm run verify:compose
```

The script uses a unique Compose project, temporary port, disposable database volume, and throwaway image tag. It verifies the production image build, failed-migration startup blocking, health checks, one-shot and idempotent migrations, clean `SIGTERM` shutdown, automatic application restart after `SIGKILL`, exact accepted-event readback after that crash, and PostgreSQL persistence, then removes its containers, network, volume, and image.

Run the full repository gate separately:

```bash
npm run check
az bicep build --file infra/main.bicep
```
