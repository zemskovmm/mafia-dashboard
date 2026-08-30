# Plan 3 — Record the threat model, evidence, and residual risk

**Status:** Implementation verified — final immutable review and delivery pending  
**Parent:** [Issue #19 plan set](2026-08-30_173748-issue-19-security-hardening-plan-set.md)  
**Depends on:** Plans 1 and 2  
**Goal:** Produce a source-backed security baseline for the exact release candidate, close or defer every finding explicitly, and deliver issue #19 with independently reviewed evidence.

## Scope

### In

- Threat model and trust-boundary documentation.
- Control-to-evidence matrix.
- Redaction/error/log sampling and residual-risk decisions.
- Exact candidate scans, full repository verification, immutable independent review, push verification, and issue closure.

### Out

- Implementing separately tracked exports (#17), self-host backup automation (#22), centralized logs, MFA, horizontal rate-limit storage, or a public/spectator data projection.

## Expected files

- `docs/security-and-privacy.md` (new)
- `README.md`
- `docs/self-hosted-deployment.md`
- `docs/azure-deployment.md`
- Additional test/docs edits only when an evidence gap discovered here requires a focused regression.

## Implementation sequence

1. **Write the threat model from repository and issue evidence.**
   - Assets: Google identities, hashed application sessions, club memberships/player profiles, full game roles/checks/shots/replay branches, OAuth refresh/access tokens, database/backups, logs/error console, GitHub/Azure/GHCR credentials, and release images.
   - Trust boundaries: browser ↔ public ingress/Fastify, Fastify ↔ Google OAuth/YouTube, app ↔ private PostgreSQL, GitHub Actions ↔ GHCR/Azure, and self-host reverse proxy ↔ Compose network/volume.
   - Actors: unauthenticated internet client, authenticated regular user, manager, cross-club member, nearby table participant, compromised browser/device, malicious dependency/image, and host/cloud operator.
   - Map threats with a lightweight STRIDE-style table to the implemented controls and exact tests/commands.

2. **Record accepted product/security decisions.**
   - #42 intentionally gives `user` and `manager` identical full game/session data while restricting administrative actions.
   - #28 intentionally limits the privacy shield to the table; timeline/log visibility is an accepted shoulder-surfing risk for the host device.
   - There is no anonymous/spectator endpoint.
   - OAuth codes remain standard short-lived callback query values; provider/session/access/refresh tokens must not enter URLs or client-visible errors.

3. **Sample every sensitive channel.**
   - Re-run authorization-matrix and secret-event projection tests for anonymous, outsider, user, and manager roles.
   - Re-run browser error-console credential redaction tests, server generic-error tests, and inspect application/shutdown logging paths for secret-bearing values.
   - Verify database session/token encryption/hash properties and OAuth callback cookie flags.
   - Inspect release image history/files for source, development dependencies, credentials, writable root execution, and unexpected build context.
   - Verify API no-store and production security headers against a local production build; after push, read back safe unauthenticated headers from the exact deployed origin without using or printing credentials.

4. **Run and record the final evidence set.**
   - `npm audit --json` with zero high/critical findings.
   - Security lint and workflow-contract tests.
   - Filesystem/configuration/secret scan and built-image high/critical scan.
   - Focused auth/redaction/header/OAuth tests.
   - `npm run check`, `npm run verify:compose`, and a production Docker build.
   - Any finding is fixed in its owning plan or published as a new issue with severity, evidence, mitigation, owner/dependency, and explicit residual-risk rationale; #19 does not close with an undocumented high finding.

5. **Document residual risks and operational ownership.**
   - Self-host backup automation/restore tests remain owned by #22; Azure retains its documented seven-day managed backup baseline.
   - Export security/portability remains owned by #17 because no export endpoint exists yet.
   - The in-memory login limiter is safe for the supported single replica; horizontal scaling requires shared enforcement.
   - Local bounded logs are not centralized audit logs.
   - The CSP intentionally trusts the documented Google Fonts/YouTube origins.
   - Paid GitHub Code Security is unavailable; repository-owned lint/audit/Trivy gates are the accepted replacement.

6. **Freeze, review, and deliver.**
   - Stage only issue #19 files, generate the exact patch/tree digest, and obtain independent security/logic review of that immutable artifact.
   - Correct blockers and repeat full verification/review until clean.
   - Remove all four completed issue #19 plan files while preserving the unrelated older plan.
   - Commit and push `main`, verify `origin/main` equals the local commit, read back the issue comment/state, and close #19 as completed with exact counts, scan versions/results, review digest, commit, and residual-risk links.

## Acceptance criteria

- A current threat model covers every asset, actor, and trust boundary named by issue #19.
- Every implemented control has repeatable evidence; every gap is fixed or explicitly deferred to a linked issue with rationale.
- Redaction/error/log samples contain no credentials, role/check secrets beyond the accepted full-data club model, or private cross-club data.
- Dependency, static/workflow, filesystem/secret/configuration, and exact-image scans pass under the documented thresholds.
- Focused tests and `npm run check` pass, and the production image builds.
- Independent review approves the exact candidate with no unresolved high-severity finding.
- The remote commit and closed GitHub issue are read back and verified.
