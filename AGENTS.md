# Mafia Dashboard Repository Instructions

## AI artifacts

- Store every repository-local AI-generated plan, review, handoff, report, and scratch document under `.AI/`.
- Store active implementation plans under `.AI/plans/`.
- Remove successfully implemented plans after verification; Git history is their archive.
- Use `.AI/archive/` only for unresolved or superseded artifacts whose unique rationale must remain visible.
- Do not create `.hermes/`, `.claude/`, `.codex/`, `.cursor/`, or another tool-specific artifact directory in this repository.
- Keep source, product documentation, CI, and deployment files in their conventional locations; `.github/` is not an AI-artifact directory.

## Current architecture

- `apps/web/`: React/Vite host application.
- `apps/server/`: Fastify API, authentication, club isolation, PostgreSQL persistence, and production static hosting.
- `packages/game-domain/`: framework-independent Club Mafia rules, canonical events, and replay logic.
- `docs/`: current product, architecture, and deployment documentation.

## Working rules

- Read relevant source and tests before changing behavior.
- Preserve club isolation, secret-event handling, canonical replay integrity, and idempotent persistence.
- Add focused regression coverage for behavior changes.
- Keep changes scoped.
- Do not commit, push, close issues, or mutate deployments unless explicitly requested.

## Implementation planning

- Every saved implementation plan and every plan-approval request must include a brief plain-language summary of the upcoming changes.
- The summary supplements rather than replaces detailed scope, acceptance criteria, risks, and verification.

## Verification

- Use focused tests while iterating.
- Run `npm run check` before finalizing repository changes.

## Backlog delivery

- When Michael explicitly requests backlog execution, use the open GitHub issue backlog and select the highest-priority implementation-ready item unless he names another item or selection rule.
- Rely on issue-focused local tests plus `npm run check`; do not open a pull request or wait for CI/review unless explicitly requested.
- After all local acceptance criteria pass, commit the scoped changes, push the current branch, verify the remote commit, and close the issue with the verified local results.
- Outside an explicit backlog-execution request, the default no-commit/no-push/no-close rule still applies.
