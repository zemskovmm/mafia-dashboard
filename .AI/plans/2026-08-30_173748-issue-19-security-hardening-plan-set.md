# Issue #19 security-hardening plan set

**Status:** Implementation verified — final immutable review and delivery pending  
**Issue:** [#19 — Perform security and privacy hardening for a public server deployment](https://github.com/zemskovmm/mafia-dashboard/issues/19)  
**Selected at:** 2026-08-30 17:37 CEST

## Readiness verdict

**READY.** Issue #19 is the highest-priority implementation-ready inactive open item.

- It is `priority:P0` in milestone **2 — Production-ready v1**.
- Authentication/session/authorization hardening in #6 is closed and deployed.
- Secret-event compatibility work in #27 and the explicit product decisions in #28, #29, and #42 are settled.
- The latest CI and Azure deployment for `82234cb` passed; the public deployment path is operational.
- The dependency audit currently reports 0 vulnerabilities across 450 dependencies.
- Other open P0 items are blocked by active or prerequisite work: #16 depends on replay closure, #20 depends on #16, #22 follows active persistence work, and #23 depends on #22.

## Continuation checkpoint — 2026-08-30 18:20 CEST

Issue #19 remains the item to resume rather than selecting new work. `main`, `origin/main`, and GitHub's current `main` all point to `82234cbcf86b155e7102f94fa41e78e8adef8c7b`; #19 is still open. The worktree contains only the issue #19 candidate plus the older unrelated reconciliation plan.

- **Plan 1 implementation is present but not accepted yet.** `@fastify/helmet`, explicit CSP/HSTS/referrer/frame/MIME policies, API `no-store`, YouTube origin binding, and focused tests are in the worktree. The prior session recorded passing focused header, player, authorization, lint, and audit checks. Continuation must still add or confirm static-SPA/asset and OAuth compatibility coverage, then rerun the focused set on the current tree.
- **Plan 2 implementation is partially verified.** Immutable action pins, repository-owned ESLint security rules, workflow contracts, a scheduled Trivy workflow, and runtime image hardening are present. The prior Trivy filesystem scan reported zero vulnerability, secret, or misconfiguration findings.
- **The first image scan failed closed.** It found two high Alpine OpenSSL findings plus high/critical packages bundled only in the base image's global npm toolchain. The candidate now upgrades Alpine packages and removes npm/Corepack from the runtime stage; image `sha256:6470efddd6c5dfcf3d7154a45812fe164a6b8baf0e943fc256c1cbc16ed2b3b8` built successfully. A final image rescan was started but produced no durable result before the previous session ended, so remediation is unverified.
- **Two deterministic-gate gaps remain visible in the candidate.** `npm run check` does not yet invoke the dependency audit, and the security workflow installs dependencies before auditing the lockfile. Contract coverage must enforce the intended audit ordering plus the planned permissions, timeout, event, and fail-closed invariants.
- **Plan 3 has not started.** No `docs/security-and-privacy.md` or control/evidence matrix exists yet.

Resume at the missing image rescan and deterministic-gate gaps; preserve already implemented work and do not repeat completed edits merely because their plan status was stale.

## Current gaps found during readiness inspection

1. The server sets only `Permissions-Policy`; it has no tested CSP, HSTS policy, clickjacking, MIME-sniffing, or referrer hardening.
2. The YouTube IFrame API is loaded from a fixed external script but the player does not send the documented `origin` parameter.
3. Sensitive authenticated API responses do not have an explicit no-store policy.
4. CI has no dependency vulnerability gate, security-focused static lint, filesystem/secret/misconfiguration scan, or built-image vulnerability scan.
5. Workflow actions use floating major tags rather than immutable commit SHAs.
6. GitHub Code Security/CodeQL is unavailable for this private repository (the API returns 403), so the plan must use repository-owned and open-source gates that do not require GHAS.
7. The threat model, control evidence, accepted product decisions, and residual risks are distributed across issues and deployment docs rather than recorded as one reviewable security baseline.

## Sequential one-goal plans

1. [`2026-08-30_173748-issue-19-01-runtime-browser-security-controls.md`](2026-08-30_173748-issue-19-01-runtime-browser-security-controls.md) — harden the browser/server HTTP boundary without changing product authorization.
2. [`2026-08-30_173748-issue-19-02-deterministic-security-gates.md`](2026-08-30_173748-issue-19-02-deterministic-security-gates.md) — add reproducible dependency, static, repository, and image security gates.
3. [`2026-08-30_173748-issue-19-03-threat-model-evidence-and-closure.md`](2026-08-30_173748-issue-19-03-threat-model-evidence-and-closure.md) — consolidate the threat model, verify evidence, record residual risk, and close the item.

The plans are sequential: Plan 2 scans the runtime candidate from Plan 1; Plan 3 documents and independently reviews the exact combined candidate.

## Shared boundaries

### In scope

- Accounts, sessions, club roles, game secrets, OAuth credentials, browser error data, logs, backups, deployment credentials, and software supply chain.
- Internet-facing Fastify/SPA headers and third-party YouTube/Google resource boundaries.
- Dependency, static-pattern, workflow, filesystem/secret/configuration, and container image scanning.
- Explicit evidence and residual-risk documentation.

### Out of scope

- Spectator/public-display endpoints.
- A second redacted session projection; #42 intentionally gives regular users and managers identical game data.
- Privacy masking of timeline/log metadata; #28 intentionally limits the privacy shield to the table.
- Building exports (#17) or self-host backup automation (#22); their security requirements will be recorded as deferred controls.
- MFA, provider replacement, centralized SIEM, horizontal scaling, or changing the two-role club model.
- Enabling paid GitHub Code Security for this private repository.

## Delivery workflow

After explicit approval:

1. Execute each plan test-first and keep changes scoped.
2. Run focused tests while iterating and `npm run check` on the combined candidate.
3. Run the new security gates against the exact candidate and production image.
4. Freeze the staged tree and obtain independent security review of its exact digest.
5. Remove this completed plan set, commit, push `main`, verify the remote commit, and close #19 with exact evidence.
6. Leave unrelated `.AI/plans/2026-08-29_134707-reconcile-stale-in-progress-github-issues.md` untouched.
