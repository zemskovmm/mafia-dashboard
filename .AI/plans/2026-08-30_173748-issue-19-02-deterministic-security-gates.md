# Plan 2 — Add deterministic security gates

**Status:** Completed and verified — 2026-08-30  
**Parent:** [Issue #19 plan set](2026-08-30_173748-issue-19-security-hardening-plan-set.md)  
**Depends on:** Plan 1  
**Goal:** Make dependency, static-pattern, workflow, repository, and production-image security checks reproducible locally and in GitHub Actions without paid GitHub Code Security.

## Scope

### In

- Lockfile-backed npm audit gate.
- Security-focused ESLint rules for Node and browser TypeScript.
- Trivy filesystem/configuration/secret and built-image vulnerability scans.
- Immutable GitHub Action references and least-privilege workflow contracts.
- Local scripts/tests that prove workflow security properties without waiting for CI.

### Out

- Enabling GHAS/CodeQL, cloud scanner accounts, automatic dependency upgrades, signing/attestation, or suppressing findings without issue-linked rationale.

## Expected files

- `package.json`
- `package-lock.json`
- `eslint.config.js`
- `.github/workflows/ci.yml`
- `.github/workflows/deploy-azure.yml`
- `.github/workflows/security.yml` (new)
- `scripts/security-workflow-contracts.test.mjs` (new)
- `Dockerfile`
- Documentation references may be deferred to Plan 3.

## Continuation checkpoint

The workflow, action pins, lint plugins, root scripts, contracts, and runtime-image hardening are present. The repository scan passed previously, but the first image scan exposed fixable Alpine packages and vulnerable tooling inherited from the base image. The runtime stage now upgrades Alpine packages and removes global npm/Corepack; the rebuilt image has not yet received a durable passing rescan. The current contracts also need to prove that `npm run check` includes the audit, lockfile auditing precedes dependency lifecycle execution in CI, and every planned permission/timeout/event/fail-closed invariant is enforced.

## Implementation sequence

1. **Write failing workflow-contract tests.**
   - Inventory every `.github/workflows/*.yml` `uses:` reference and reject anything not pinned to a full commit SHA.
   - Assert workflow/job permissions remain least-privilege, jobs have timeouts, and no `pull_request_target` or untrusted checkout/write combination is introduced.
   - Assert the security workflow runs for pull requests, pushes to `main`, a weekly schedule, and manual dispatch.
   - Assert the dependency/static job and built-image job use the same checked-out commit and fail closed on scanner errors/findings.

2. **Add deterministic dependency and static analysis.**
   - Add explicit root scripts for dependency auditing and security linting; include them in the repository’s trusted `npm run check` path where they are deterministic and do not require Docker.
   - Use `npm audit --audit-level=high` against the committed lockfile; do not run automatic fixes or add an advisory allowlist unless a concrete finding is separately documented.
   - Add reviewed, current ESLint security/XSS plugins and enable high-signal rules for TypeScript/React/Node. Scope any unavoidable false-positive suppression to the exact line and document why.

3. **Create the security workflow.**
   - Use `contents: read` by default and add no write/security-event permission because this private repository cannot use GitHub Code Security uploads.
   - Pin checkout, setup-node, Buildx, Trivy, and any artifact/cache action to immutable upstream commit SHAs with version comments.
   - Run lockfile audit before executing package lifecycle scripts, then install and run security lint/workflow contracts.
   - Build the exact production Dockerfile candidate and run Trivy against high/critical OS and library vulnerabilities.
   - Run a separate Trivy filesystem scan for secrets and configuration errors, excluding only generated/vendor directories through a checked-in reviewed configuration if necessary.
   - Avoid registry login and deployment secrets; scan the local image built in the job.

4. **Harden existing workflows.**
   - Replace floating action tags in CI/deploy with verified immutable SHAs.
   - Preserve the existing event matrix, package permissions, OIDC deployment permission, environment gate, image tag, and build/deploy flow.
   - Keep interpolated external/user-controlled values out of shell source; use environment variables for any new values.

5. **Exercise the gates locally.**
   - Confirm `npm audit` is clean.
   - Run security lint and workflow contract tests.
   - Build the production image and run the same Trivy severity/failure policy via a pinned scanner image or the available Docker Scout equivalent for corroboration.
   - Record scanner versions/digests and exact commands for Plan 3 evidence.

## Acceptance criteria

- All workflow actions are immutable-SHA pinned and contract-tested.
- `npm run check` includes deterministic dependency/security-static checks and remains green.
- The security workflow scans the filesystem and exact built image on PRs, `main`, schedule, and manual dispatch with least privilege.
- High/critical dependency or image findings fail the gate; secret/config findings fail according to the checked-in policy.
- No GHAS, external scanner account, deployment credential, or mutable scanner tag is required.
- No unexplained allowlist or ignored finding is introduced.
- Focused workflow/security checks pass before Plan 3.
