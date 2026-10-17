# Security and privacy model

## Scope and product decisions

La Verdad is an internet-reachable, authenticated moderator application. It has no anonymous club, game, replay, spectator, or public-display API. Google OpenID Connect establishes application accounts; the app then authorizes every club request from a server-side membership.

The accepted authorization model has two roles:

- `manager` may administer the club, persistent players, access grants, settings, and developer tools, and may run games;
- `user` may run games and receives the same club and game state needed by the host workflow, but cannot perform manager-only administration.

Role/check/shot data is intentionally available to both authenticated roles within their club. This is a product decision, not a missing redaction layer. Nearby-player privacy is a physical host-screen responsibility: the privacy shield covers the table, while timeline and log remain visible by design. No public or least-privilege replay projection exists.

## Assets and classification

| Asset                                                    | Classification                    | Primary controls                                                                                       |
| -------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Google subject, email, display name, picture             | Personal                          | Hashed application sessions, authenticated API, club membership                                        |
| Session token                                            | Credential                        | Random 32-byte token, HttpOnly cookie, hash-only database storage, absolute expiry, per-session logout |
| Club membership and access role                          | Authorization data                | Server-side role lookup on every scoped request, manager-only mutations                                |
| Player profile and consent fields                        | Personal                          | Club isolation, manager-only persistence, consent validation                                           |
| Game baseline, branches, roles, shots, checks, Best Move | Club-secret game data             | Authenticated club membership, server-side isolation, no-store API responses                           |
| YouTube OAuth access/refresh tokens                      | Credential                        | Server-side encrypted storage; never returned to the browser                                           |
| Google client secret, encryption key, registry tokens    | Deployment secret                 | Environment/managed secret injection; excluded from images and source                                  |
| Azure Table/private Blob data and backup packages        | Sensitive durable state           | Managed identity with scoped data roles, non-public blobs, protected local recovery packages           |
| Logs and browser error-console entries                   | Potentially sensitive diagnostics | Generic server errors, bounded logs, browser-side credential redaction                                 |

## Trust boundaries

1. **Browser → public HTTPS ingress → Fastify.** The browser is untrusted input. Fastify validates payloads, authenticates the application session, verifies exact club membership/role, and enforces exact-origin unsafe requests.
2. **Fastify → Azure Table/private Blob Storage.** Production uses managed identity scoped to the selected account; blobs are not public, credentials are not sent to browsers, and mutations atomically revalidate authorization. Local Azurite is loopback-only and fixture-owned. HTTPS service endpoints remain publicly reachable; this is not a private-endpoint deployment.
3. **Fastify → Google OAuth/YouTube APIs.** OAuth state binds callbacks. Provider tokens remain server-side; YouTube grants are read-only.
4. **Browser → YouTube IFrame API and Google Fonts.** CSP allowlists only the required provider origins. The player sends the exact application origin.
5. **GitHub Actions → GHCR/Azure.** Workflows use least-required permissions, immutable action commits, OIDC for Azure, and digest-pinned application deployments. The publish job pushes the commit-tagged image, verifies the registry-reported digest, and passes that digest—not the mutable SHA tag—to Azure.
6. **Container runtime.** The Node base image is digest-pinned, the process runs as the unprivileged `node` user, runtime package managers are removed, and current Alpine security updates are applied at build time.
7. **Operator and backup boundary.** Host/cloud operators can access database and deployment secrets. Operational access and backup copies require equivalent protection to live data.

## Threats, controls, and evidence

| Threat                                | Implemented control                                                                                                        | Regression/evidence                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Anonymous API access                  | Authentication on every non-public API route                                                                               | `apps/server/src/app.test.ts` protected-route matrix   |
| Cross-club read/write                 | Membership lookup and club-scoped data keys                                                                                | API/store isolation tests                              |
| Regular user reaches manager behavior | Manager-only route and UI guards                                                                                           | Role-matrix API/UI tests                               |
| CSRF with ambient session cookie      | Exact `Origin` required for unsafe cookie-authenticated `/api/` requests                                                   | `apps/server/src/app.test.ts`, `http-security.test.ts` |
| OAuth callback substitution           | Random state in secure HttpOnly callback cookie and constant-time comparison                                               | Google/YouTube OAuth route tests                       |
| Login resource abuse                  | Bounded fail-closed fixed-window source limiter with explicit zero/one-hop trust                                           | `http-security.test.ts`, `app-security.test.ts`        |
| Session database theft                | Only SHA-256 token hashes stored; fixed 30-day non-sliding lifetime                                                        | `google-auth.test.ts`                                  |
| XSS/injected active content           | Strict CSP, no object/embed, no framing, security-focused ESLint rules                                                     | `app-security.test.ts`, `npm run lint`                 |
| Clickjacking                          | `frame-ancestors 'none'` and `X-Frame-Options: DENY`                                                                       | `app-security.test.ts`                                 |
| MIME/referrer leakage                 | `nosniff`; strict-origin referrer policy                                                                                   | `app-security.test.ts`                                 |
| Sensitive API caching                 | `Cache-Control: no-store` on all `/api/` responses                                                                         | `app-security.test.ts`                                 |
| Secret event leakage                  | Canonical event-type secrecy and redacted public event projection; public responses omit private hashes and payload fields | Azure game-store and authenticated API tests           |
| Client/server error leakage           | Generic server 500s and bounded credential-redacting browser console                                                       | `app.test.ts`, `error-console.test.ts`                 |
| Dependency lifecycle compromise       | Lockfile installs suppress scripts, then explicitly rebuild only pinned esbuild                                            | workflow contracts                                     |
| Workflow action retagging             | Every external action pinned to a 40-character commit                                                                      | security contracts                                     |
| Stale or mutable production base      | Digest-pinned base; OS upgrade; runtime package managers removed                                                           | Dockerfile contracts                                   |
| Anonymous storage access              | Anonymous Blob and shared-key access disabled; account-scoped server identity data roles                                   | Azure Bicep/template and storage authorization tests   |

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

`TRUST_PROXY_HOPS` accepts only `0` or `1` and defaults to `0`. Direct development sessions therefore key authentication attempts by the socket peer and ignore forwarding headers. Azure Container Apps sets it to `1` because exactly one controlled ingress is the only path to the application; Fastify then uses only the rightmost forwarded address and ignores caller-controlled prefixes. Unbounded proxy trust and arbitrary multi-hop chains are unsupported.

This policy only selects the key for the existing fail-closed fixed-window limiter. Limiter state remains in one application process and must be replaced with shared state before horizontal scaling.

## Build and workflow safeguards

Pull requests run one `CI` workflow that performs formatting, lint, typecheck, tests, and the application build. Pushes to `main` run only `Deploy Azure`, which builds, publishes, and deploys the image without repeating CI.

Every CI/Docker lockfile install uses `npm ci --ignore-scripts --no-audit`, then explicitly runs `npm rebuild esbuild`; no other dependency lifecycle scripts execute. Production pruning also disables lifecycle scripts and npm's implicit advisory request. External action implementations and Node base images remain pinned to immutable commits or digests. The deployment publish job verifies the registry-reported image digest and deploys that immutable reference.

There is no dedicated Security workflow, automated dependency advisory audit, repository secret/misconfiguration scan, or production-image vulnerability scan. Main pushes also do not rerun the pull-request quality gate. These are accepted operational trade-offs; the retained ESLint security/DOM-sink rules and application tests run only through pull-request CI or explicit local verification.

## Verification

Run before release:

```bash
npm run lint
npm run test:security-contracts
npm run check:local
npm run verify:local
npm run verify:storage-backup
docker build --tag mafia-dashboard:local .
```

For a deployed HTTPS origin, sample the root and `/api/auth/session` responses and verify the documented headers, HTTPS-only HSTS, API `no-store`, generic unauthenticated behavior, and the absence of tokens or private data. Never put a real session cookie, OAuth code, or secret in a command line, issue comment, or retained log.

## Residual and deferred risks

| Risk                                                       | Disposition                                                                                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authenticated regular users receive full club/game state   | Accepted product model from issue #42; both roles may host games                                                                                                   |
| Privacy shield does not hide timeline/log                  | Accepted product decision from issue #28                                                                                                                           |
| Single-process in-memory login limiter                     | Accepted for supported 0–1 replica deployments; replace with shared state before horizontal scale                                                                  |
| Google/YouTube and Google Fonts availability/privacy       | Required external providers; CSP restricts access to documented purposes                                                                                           |
| Inline style CSP allowance and broad HTTPS image allowance | Accepted compatibility scope; scripts, frames, connections, objects, and forms remain constrained                                                                  |
| Production Azure backup/recovery                           | Local consistent-package and isolated-restore qualification exists; production scheduling/retention are not configured; see `azure-storage-backup-and-recovery.md` |
| Export security                                            | Export is excluded from v1.0.0; any future design must preserve club isolation and avoid secret, OAuth, log, and personal-data leakage                             |
| Central audit-log retention                                | Not implemented; local logs are bounded and diagnostic rather than a security audit ledger                                                                         |
| Host/cloud operator access                                 | Operational trust boundary; protect credentials, backups, and console access outside the application                                                               |
| Denial of service beyond login throttling                  | Infrastructure-level rate limiting/WAF is not part of the pilot baseline                                                                                           |
| Automated dependency/repository/image security scanning    | Not configured; local review and dependency maintenance are operator responsibilities                                                                              |
| Main-push quality verification                             | Not configured; main deployment relies on prior pull-request CI or explicit local verification                                                                     |
| GitHub Advanced Security/CodeQL                            | Unavailable in the current private repository                                                                                                                      |

Revisit this model when adding horizontal scale, anonymous/public views, new identity providers, exports, centralized logging, or a different backup system.
