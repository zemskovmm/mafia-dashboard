# Security and privacy model

## Scope and product decisions

Mafia Dashboard is an internet-reachable, authenticated moderator application. It has no anonymous club, game, replay, spectator, or public-display API. Google OpenID Connect establishes application accounts; the app then authorizes every club request from a server-side membership.

The accepted authorization model has two roles:

- `manager` may administer the club, persistent players, access grants, settings, and developer tools, and may run games;
- `user` may run games and receives the same club and game state needed by the host workflow, but cannot perform manager-only administration.

Role/check/shot data is intentionally available to both authenticated roles within their club. This is a product decision, not a missing redaction layer. Nearby-player privacy is a physical host-screen responsibility: the privacy shield covers the table, while timeline and log remain visible by design. No public or least-privilege replay projection exists.

## Assets and classification

| Asset                                                               | Classification                    | Primary controls                                                                                       |
| ------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Google subject, email, display name, picture                        | Personal                          | Hashed application sessions, authenticated API, club membership                                        |
| Session token                                                       | Credential                        | Random 32-byte token, HttpOnly cookie, hash-only database storage, absolute expiry, per-session logout |
| Club membership and access role                                     | Authorization data                | Server-side role lookup on every scoped request, manager-only mutations                                |
| Player profile and consent fields                                   | Personal                          | Club isolation, manager-only persistence, consent validation                                           |
| Game baseline, branches, roles, shots, checks, Best Move            | Club-secret game data             | Authenticated club membership, server-side isolation, no-store API responses                           |
| YouTube OAuth access/refresh tokens                                 | Credential                        | Server-side encrypted storage; never returned to the browser                                           |
| Google client secret, database URL, encryption key, registry tokens | Deployment secret                 | Environment/managed secret injection; excluded from images and source                                  |
| PostgreSQL data and backups                                         | Sensitive durable state           | Private network/host network, restricted credentials, backup controls tracked separately               |
| Logs and browser error-console entries                              | Potentially sensitive diagnostics | Generic server errors, bounded logs, browser-side credential redaction                                 |

## Trust boundaries

1. **Browser → public HTTPS ingress → Fastify.** The browser is untrusted input. Fastify validates payloads, authenticates the application session, verifies exact club membership/role, and enforces exact-origin unsafe requests.
2. **Fastify → PostgreSQL.** SQL uses parameterized values. Azure PostgreSQL is private-network only; Compose PostgreSQL is not published.
3. **Fastify → Google OAuth/YouTube APIs.** OAuth state binds callbacks. Provider tokens remain server-side; YouTube grants are read-only.
4. **Browser → YouTube IFrame API and Google Fonts.** CSP allowlists only the required provider origins. The player sends the exact application origin.
5. **GitHub Actions → GHCR/Azure.** Workflows use least-required permissions, immutable action commits, OIDC for Azure, and digest-pinned application deployments. The publish job scans one local image, pushes it, verifies the registry-reported digest, and passes that digest—not the mutable SHA tag—to Azure.
6. **Container runtime.** The Node base image is digest-pinned, the process runs as the unprivileged `node` user, runtime package managers are removed, and current Alpine security updates are applied at build time.
7. **Operator and backup boundary.** Host/cloud operators can access database and deployment secrets. Operational access and backup copies require equivalent protection to live data.

## Threats, controls, and evidence

| Threat                                | Implemented control                                                                 | Regression/evidence                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Anonymous API access                  | Authentication on every non-public API route                                        | `apps/server/src/app.test.ts` protected-route matrix   |
| Cross-club read/write                 | Membership lookup and club-scoped data keys                                         | API/store isolation tests                              |
| Regular user reaches manager behavior | Manager-only route and UI guards                                                    | Role-matrix API/UI tests                               |
| CSRF with ambient session cookie      | Exact `Origin` required for unsafe cookie-authenticated `/api/` requests            | `apps/server/src/app.test.ts`, `http-security.test.ts` |
| OAuth callback substitution           | Random state in secure HttpOnly callback cookie and constant-time comparison        | Google/YouTube OAuth route tests                       |
| Login resource abuse                  | Bounded fail-closed fixed-window source limiter with explicit zero/one-hop trust    | `http-security.test.ts`, `app-security.test.ts`        |
| Session database theft                | Only SHA-256 token hashes stored; fixed 30-day non-sliding lifetime                 | `google-auth.test.ts`                                  |
| XSS/injected active content           | Strict CSP, no object/embed, no framing, security-focused ESLint rules              | `app-security.test.ts`, `npm run lint`                 |
| Clickjacking                          | `frame-ancestors 'none'` and `X-Frame-Options: DENY`                                | `app-security.test.ts`                                 |
| MIME/referrer leakage                 | `nosniff`; strict-origin referrer policy                                            | `app-security.test.ts`                                 |
| Sensitive API caching                 | `Cache-Control: no-store` on all `/api/` responses                                  | `app-security.test.ts`                                 |
| Secret event leakage                  | Canonical event-type secrecy and redacted public legacy-event projection            | `event-store.test.ts`, `app.test.ts`                   |
| Client/server error leakage           | Generic server 500s and bounded credential-redacting browser console                | `app.test.ts`, `error-console.test.ts`                 |
| Dependency compromise/vulnerability   | Lockfile installs suppress scripts, then explicitly rebuild only pinned esbuild     | `npm run audit:security`, security contracts           |
| Workflow action retagging             | Every external action pinned to a 40-character commit                               | security contracts                                     |
| Repository secret/configuration issue | Trivy filesystem vulnerability, secret, and misconfiguration scan                   | `.github/workflows/security.yml`                       |
| Vulnerable production image           | Digest-pinned base; exact pre-push Trivy gate; OS upgrade; package managers removed | deployment/security workflows and image scan           |
| Public database exposure              | Azure public access disabled; Compose DB has no published port                      | Bicep/Compose verification                             |
| Unbounded local logs                  | Docker local driver with size/count limits                                          | Compose contract and deployment runbook                |

## HTTP policy

All HTTP responses receive the Helmet baseline. The policy includes:

- `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, and `form-action 'self'`;
- scripts and frames restricted to the application and required YouTube origins;
- Google Fonts style/font origins;
- same-origin connections and manifests;
- image support for local/data/blob content plus HTTPS profile and playlist images;
- HSTS for configured HTTPS deployments only;
- `Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options: nosniff`, and `X-Frame-Options: DENY`;
- `Permissions-Policy: picture-in-picture=()`; and
- `Cache-Control: no-store` for every API response.

`style-src 'unsafe-inline'` remains necessary for current React inline styles. `img-src https:` remains necessary because Google profile and YouTube thumbnail hosts are provider-controlled. These are explicit compatibility allowances, not blanket script or connection access.

### Client address and proxy trust

`TRUST_PROXY_HOPS` accepts only `0` or `1` and defaults to `0`. Direct deployments therefore key authentication attempts by the socket peer and ignore forwarding headers. Azure Container Apps and the documented Caddy deployment set it to `1` because exactly one controlled ingress is the only path to the application; Fastify then uses only the rightmost forwarded address and ignores caller-controlled prefixes. The Caddy topology also requires loopback-only application binding and Caddy's default forwarding-header sanitization. Unbounded proxy trust and arbitrary multi-hop chains are unsupported.

This policy only selects the key for the existing fail-closed fixed-window limiter. Limiter state remains in one application process and must be replaced with shared state before horizontal scaling.

## Supply-chain gates

The `Security` workflow runs on pull requests, pushes to `main`, a weekly schedule, and manual dispatch. It has read-only repository permissions and blocks on:

1. `npm audit --audit-level=high`;
2. the repository ESLint security and DOM-sink rules;
3. Trivy filesystem vulnerability/secret/misconfiguration findings at HIGH or CRITICAL;
4. a production Docker build; and
5. Trivy production-image vulnerabilities or secrets at HIGH or CRITICAL.

Action implementations are pinned to exact commits. Trivy is pinned to `v0.74.0`. Every CI/Docker lockfile install uses `npm ci --ignore-scripts`, then explicitly runs `npm rebuild esbuild`; no other dependency lifecycle scripts execute. The deployment publish job scans its loaded commit-tagged image before pushing that exact local image to GHCR.

GitHub Code Security is not enabled for this private repository. The repository-owned ESLint, npm audit, Trivy, and workflow-contract gates are the deterministic baseline instead; enabling GitHub Advanced Security later is additive, not a replacement.

## Verification

Run before release:

```bash
npm run audit:security
npm run lint
npm run test:security-contracts
npm run check
npm run verify:compose

docker build --tag mafia-dashboard:security-scan .
docker run --rm \
  --volume "$PWD:/workspace:ro" \
  --volume mafia-dashboard-trivy-cache:/root/.cache/trivy \
  aquasec/trivy:0.74.0 fs \
  --scanners vuln,secret,misconfig \
  --severity HIGH,CRITICAL --ignore-unfixed=false --exit-code 1 /workspace

docker run --rm \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --volume mafia-dashboard-trivy-cache:/root/.cache/trivy \
  aquasec/trivy:0.74.0 image \
  --scanners vuln,secret \
  --severity HIGH,CRITICAL --ignore-unfixed=false --exit-code 1 \
  mafia-dashboard:security-scan
```

For a deployed HTTPS origin, sample the root and `/api/auth/session` responses and verify the documented headers, HTTPS-only HSTS, API `no-store`, generic unauthenticated behavior, and the absence of tokens or private data. Never put a real session cookie, OAuth code, or secret in a command line, issue comment, or retained log.

## Residual and deferred risks

| Risk                                                       | Disposition                                                                                                                            |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Authenticated regular users receive full club/game state   | Accepted product model from issue #42; both roles may host games                                                                       |
| Privacy shield does not hide timeline/log                  | Accepted product decision from issue #28                                                                                               |
| Single-process in-memory login limiter                     | Accepted for supported 0–1 replica deployments; replace with shared state before horizontal scale                                      |
| Google/YouTube and Google Fonts availability/privacy       | Required external providers; CSP restricts access to documented purposes                                                               |
| Inline style CSP allowance and broad HTTPS image allowance | Accepted compatibility scope; scripts, frames, connections, objects, and forms remain constrained                                      |
| Self-hosted automated backup/restore                       | Delivered logical backup, off-server copy, isolated restore, and failure drills; see `postgresql-backup-and-recovery.md`               |
| Export security                                            | Export is excluded from v1.0.0; any future design must preserve club isolation and avoid secret, OAuth, log, and personal-data leakage |
| Central audit-log retention                                | Not implemented; local logs are bounded and diagnostic rather than a security audit ledger                                             |
| Host/cloud operator access                                 | Operational trust boundary; protect credentials, backups, and console access outside the application                                   |
| Denial of service beyond login throttling                  | Infrastructure-level rate limiting/WAF is not part of the pilot baseline                                                               |
| GitHub Advanced Security/CodeQL                            | Unavailable in the current private repository; repository-owned gates run instead                                                      |

Revisit this model when adding horizontal scale, anonymous/public views, new identity providers, exports, centralized logging, or a different backup system.
