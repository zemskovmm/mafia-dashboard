# Issue #17 plan 1 — durable terminal records and ruleset identity

## Goal

Represent every canonical terminal outcome—red win, black win, draw, or cancellation—as a durable completed-game record carrying the session’s snapshotted ruleset identity.

## Plain-language summary

Generalize winner-only completion storage so reasoned draws and cancellations are saved and restored like wins, while exposing the already-persisted Club Mafia ruleset/version and preserving existing statistics behavior.

## Scope

- Introduce one validated completion-record shape used across `apps/web/src/api/client.ts`, `apps/web/src/features/players/game-results.ts`, `apps/server/src/game-session-validation.ts`, and `apps/server/src/game-session-store.ts`:
  - terminal outcome: `red`, `black`, `draw`, or `cancelled`;
  - nullable winner derived only for red/black outcomes;
  - terminal timestamp and host identity;
  - required non-empty reason only for draw/cancel outcomes;
  - final participant snapshot for every terminal outcome;
  - `rulesetId` and positive `rulesetVersion` read from the session snapshot, never from a current UI setting.
- Evolve `apps/server/src/schema.sql` and its idempotent migration tests so normalized completion projections can represent non-win outcomes and preserve existing red/black rows.
- Extend session row mapping and `listCompleted()` so all terminal outcomes are returned instead of dropping `results = NULL`, including ruleset identity and reason.
- Update the App/session operation path so accepted `game.drawn` and `game.cancelled` events are completed idempotently and receive the same saving/saved/offline-queued feedback as winner completion.
- Preserve canonical terminal event timestamps/reasons; do not synthesize a second reason or take the terminal time from a later retry.
- Keep win/loss aggregates unchanged for existing winners. Treat draws as played but not won, exclude cancellations from aggregate games/wins, and never infer a win/loss for either; lock those semantics with regression tests.

## Acceptance criteria

- Fresh red/black/draw/cancel games persist with `status='completed'`, restore after a new store/app instance, and appear once in completed history after idempotent retry.
- Draw/cancel records retain exactly the canonical terminal event reason and timestamp.
- Existing winner-only rows migrate/deserialize without data loss or duplicate aggregate effects.
- Every summary/detail exposes `club-mafia` and version `1` from stored session columns.
- Active-session listing excludes every completed terminal outcome.
- Cross-club reads and writes remain impossible.
- Completed replay integrity remains valid; no terminal event can be appended after completion.

## Focused verification

- Domain/result builder tests for all four outcomes and invalid outcome/reason combinations.
- `game-session-validation.test.ts` for the generalized completion contract.
- `schema-migration.test.ts` for fresh schema, legacy winner migration, and rerun convergence.
- `game-session-store.test.ts` for persistence, restart-style re-instantiation, idempotency, listing, aggregate behavior, and club isolation.
- `App.test.tsx`/`GameScreen.test.tsx` for draw/cancel save-state feedback and retry behavior.

## Non-goals

- Alternate ruleset selection or editing.
- Public/spectator summaries.
- Arbitrary post-completion mutation or reopening.
- Broad player-statistics redesign beyond explicit draw/cancel semantics.
