# GitHub issue #17 completed-game portability plan set

## Goal

Complete the still-required portion of [GitHub issue #17 — “Add game completion, role reveal, history, and JSON/CSV export”](https://github.com/zemskovmm/mafia-dashboard/issues/17) without reopening already-delivered completion/history behavior. Per the owner’s revised scope, JSON/CSV export and new role-presentation work are excluded.

## Plain-language summary

Make wins, draws, and cancellations durable completed-game records; add date/player/result filters to club-scoped completed history; preserve the current role presentation unchanged; and make the no-edit-after-finish correction policy explicit and tested.

## Selection and readiness

- #17 is the chronologically oldest open issue (`2026-08-02T15:42:09Z`), five seconds older than #23.
- The issue’s 2026-08-28 owner comment records what is already delivered; the approved remaining scope is draw/cancel records, ruleset identity, filters, and completion correction policy.
- `rules.md` supplies the material product decisions: fixed Club Mafia v1, reasoned draw/cancellation events, no post-Finish Undo/Reset or administrative correction event, and SQL history. The current authenticated club data model remains unchanged.
- The owner explicitly removed JSON/CSV export and new final-role presentation from this delivery. The remaining work is implementation-ready as a plan set.

## Read-only findings and boundaries

- Worktree at planning time: `main` at `78c8ec1ceb7418fc546b21cc284004880bf83c33`; `.AI/plans/` was already untracked and contains unrelated backlog plans that must remain intact.
- `apps/server/src/schema.sql` already snapshots `ruleset_id='club-mafia'` and `ruleset_version=1` on every session, but the store/API response omits them.
- The domain already recognizes `game.drawn` and `game.cancelled`; the web UI renders those terminal phases. Persistence still treats completion as winner-only, and `listCompleted()` drops rows without winner results.
- `GameTimelineScreen` already loads club-scoped completed sessions and canonical history, but only offers a completed-game selector—no date/player/result filters. The loaded completed session already contains final roles; this delivery does not add a dedicated role roster or change role access.
- The server already rejects replay events on completed sessions, and `rules.md` states that ordinary correction ends when Finish is clicked. This plan verifies and documents that policy rather than adding an administrative rewrite path.
- Existing authentication, club isolation, idempotent mutation handling, and canonical replay validation are hard constraints. This delivery does not introduce a new role-data access distinction.

## Semantically split implementation plans

1. [Durable terminal records and ruleset identity](./2026-09-02_171734-issue-17-terminal-records.md)
2. [Persisted completed-history filters](./2026-09-02_171734-issue-17-history-filters.md)
3. [Explicit completed-game correction policy](./2026-09-02_171734-issue-17-correction-policy.md)

Implement in that order: plan 2 consumes the terminal/ruleset projection from plan 1; plan 3 closes the policy after behavior is stable.

## Issue-level acceptance criteria

- Red wins, black wins, draws, and cancellations appear as durable completed records after browser/server restart, with canonical reason retained for draw/cancel outcomes.
- Every completed record identifies the snapshotted ruleset and version.
- Authenticated users see only the selected club’s completed history and can filter it by inclusive date range, participating player, and result.
- Existing role data access and History/Timeline presentation remain unchanged; no dedicated final-role roster is added.
- Completed games remain immutable through normal mutation routes; corrections are documented as pre-Finish Undo/Timeline Reset only.
- Focused domain/server/web regression tests pass, followed by `npm run check`.
- After all revised criteria pass: update #17 to record the owner-approved exclusion of export and new role-presentation work, remove these completed plan files, commit the scoped changes, push `main`, verify the remote commit, and close #17 with the verified local results. Do not open a PR or wait for CI unless separately requested.

## Risks and controls

- **Historical compatibility:** migrate winner-only rows in place and keep decoding older `results` snapshots; cover both legacy and new rows.
- **Statistics semantics:** draw/cancel history must not silently change win/loss aggregates; keep aggregate behavior explicit in tests.
- **Tenant leakage:** apply `club_id` to every list/detail query before filter predicates and verify cross-club IDs cannot match.
- **Date boundaries:** define date inputs and inclusivity once in the API contract and test boundary timestamps.

## Verification and delivery

Use focused tests while implementing each child plan. Before delivery, run `npm run check`; inspect the final diff for scope; update the GitHub issue with the approved scope reduction; remove this plan set and its three child plans; commit; push; verify `origin/main` contains the exact commit; close #17; and read the issue back to verify closure.
