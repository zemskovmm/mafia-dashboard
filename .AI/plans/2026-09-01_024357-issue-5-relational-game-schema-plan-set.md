# Issue #5 Relational Game Schema Plan Set

**Selected issue:** [#5 — Replace the placeholder data model with the normalized game schema](https://github.com/zemskovmm/mafia-dashboard/issues/5)

**Simplified outcome:** Add a relational, club-scoped projection of the fixed Club Mafia ruleset and active seat/role assignments while preserving the authoritative browser snapshot and the existing member-visible API contract.

## Selection record

- Baseline: `main`, local `HEAD`, `origin/main`, and live `origin` all matched `ea39d950d4cf5caaafe9fa1b3df21bbfc19a4163` during planning.
- The worktree had no source changes. The only pre-existing artifact was the unrelated untracked `.AI/plans/2026-08-29_134707-reconcile-stale-in-progress-github-issues.md`; it must remain untouched and unstaged.
- #5 is the oldest dependency-free P0 and unblocks both #8 and #22. Its `status:in-progress` label represents dormant partial delivery rather than a live local/PR candidate, so this pickup resumes the remaining scope instead of duplicating active work.
- Higher/equal-priority exclusions:
  - #20 is blocked by #14 and #15.
  - #22 is blocked by #5.
  - #23 is a release-qualification umbrella and remains blocked by #22.
  - #14 and #15 also have dormant partial-delivery labels; #5 wins the P0 tie on age and on unblocking two downstream issues.
- P1 candidates were not considered while #5 remained ready. #17 also contains several independent outcomes and an unresolved correction architecture; #32 is a qualification umbrella.
- Duplicate-work sweep: no open PR exists, and searches by issue number plus schema/migration/session variants found no PR candidate. Current source proves only partial delivery: `game_session_players` relationally projects active seats, while ruleset identity and active role assignments remain inside JSON.

## Resolved product contract

Michael selected the completed #42 contract over stale wording in #5:

- Managers and regular users receive the same full game/session data.
- There is no public/private or secret/sanitized API projection.
- This issue may normalize ruleset, seat, and role records internally, but must not add a second response model, spectator path, or role-based redaction.
- Existing authentication, club-membership authorization, and club isolation remain the access boundary.

## Ordered plans

1. [`2026-09-01_024357-issue-5-normalized-game-persistence.md`](./2026-09-01_024357-issue-5-normalized-game-persistence.md) — add and synchronize the relational ruleset/seat/role projection with migration and regression coverage.
2. [`2026-09-01_024357-issue-5-data-model-and-migration-docs.md`](./2026-09-01_024357-issue-5-data-model-and-migration-docs.md) — document the resulting model and forward/rollback contract.
3. [`2026-09-01_024357-issue-5-delivery-and-closure.md`](./2026-09-01_024357-issue-5-delivery-and-closure.md) — run the integrated gate, preserve and retire the plans correctly, push verified `main`, publish evidence, and close #5 last.

## Shared invariants

- `game_sessions.state` remains the authoritative restorable browser snapshot described by `docs/adr/0001-typescript-modular-monolith.md`; relational rows are query/constraint projections, not a second game authority.
- All new keys and foreign keys include `club_id` where they refer to club-owned games or players.
- Canonical replay integrity, idempotent mutation handling, tombstones, final results/statistics, and completion behavior remain unchanged.
- The fixed ten-player Club Mafia v1 ruleset is the only seeded ruleset. Configurable rulesets and immutable per-game rule snapshots remain #8.
- Additive migration must work for fresh and representative populated schemas, run transactionally, and converge idempotently.
- No production deployment, PR, unrelated backlog fix, or stale-plan cleanup is included.

## Shared completion gate

All implementation and documentation plans must be complete on one unchanged tree; focused server tests and `npm run check` must pass. Only then may the plan artifacts be retired, the scoped commits pushed, the remote SHA verified, an evidence comment read back, and issue #5 closed as the final external mutation.
