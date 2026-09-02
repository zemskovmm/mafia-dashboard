# Issue #17 plan 2 — persisted history filters

## Goal

Provide club-scoped, restart-safe completed-game history filtered by date, participating player, and terminal result while leaving current role presentation unchanged.

## Plain-language summary

Turn the existing completed-game dropdown into a useful history browser by querying durable SQL records by date, player, and result and allowing those filters to compose. Do not add a dedicated role roster or change who can see existing completed-session data.

## Scope

- Extend the validated `GET /api/game-sessions?status=completed` query in `apps/server/src/app.ts` with optional:
  - inclusive `from` and `to` calendar dates using a documented UTC boundary contract;
  - `playerId` UUID;
  - `outcome` in `red|black|draw|cancelled`.
- Push filters into `GameSessionStore.listCompleted()` using parameterized SQL and club-first predicates. Match `playerId` through the club-scoped participant projection, not by searching JSON.
- Reject malformed ranges and `from > to` with the existing structured 400 response. Return an empty set—not another club’s data—for a valid inaccessible/nonparticipant player ID.
- Extend `listCompletedGameSessions()` in `apps/web/src/api/client.ts` to encode filters with `URLSearchParams` and preserve the current unfiltered call.
- Add accessible date, player, and result controls to `GameTimelineScreen.tsx`, including clear/reset behavior, combined filtering, loading/empty/error states, and stale-response protection when club or filters change.
- Source player choices from the current club’s profiles through an explicit loader/prop from `App.tsx`; never retain prior-club options or results after a club switch.
- Preserve the current completed-session Timeline behavior and role presentation exactly; filtering must not add, hide, or broaden role data.
- Keep filters in component/query state; “survives restart” means results are reconstructed from PostgreSQL after a new server/store instance, not browser-only cached history.
- Add English and Russian strings through the established scoped message catalogs and localization coverage.

## Acceptance criteria

- Each filter works independently and all filters compose.
- Date boundaries include records on both requested dates and exclude adjacent timestamps.
- Player filtering returns only games in which that club-owned player participated.
- Outcome filtering distinguishes red win, black win, draw, and cancellation.
- Recreating the store/app against the same database produces the same filtered result set.
- Selecting a result retains the current read-only Timeline behavior and does not enable reset/correction controls for that historical game.
- Club changes synchronously clear old history, filters that reference the old club, selected details, and role data.
- Keyboard labels, empty states, and both locales are covered.

## Focused verification

- `game-session-store.test.ts`: independent/composed filters, boundary timestamps, restart, and same IDs across clubs.
- `app.test.ts`: query validation, access rules, and club isolation.
- `client.test.ts`: exact encoded query and backward-compatible unfiltered URL.
- `GameTimelineScreen.test.tsx`: controls, combined requests, stale responses, club switch, unchanged completed-session presentation, and no reset controls.
- `localization-coverage.test.ts`: new English/Russian keys.

## Non-goals

- Free-text event search, pagination, sorting controls, or analytics dashboards.
- Persisting the user’s filter-control choices across browser sessions.
- New role-reveal presentation or role-access changes.
- Editing a selected completed game.
