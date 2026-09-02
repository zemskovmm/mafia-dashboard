# Issue #17 plan 4 — explicit completed-game correction policy

## Goal

Make the existing pre-Finish-only correction boundary explicit in product documentation, API behavior, and regression coverage.

## Plain-language summary

Document and prove that moderators correct mistakes with Undo or Timeline Reset before Finish; after completion the record is historical and normal mutation routes cannot rewrite or reopen it.

## Scope

- Consolidate the policy in `rules.md` and any focused completed-history documentation introduced by this work:
  - winning state before Finish remains correctable through existing Undo/Timeline Reset limits;
  - draw/cancel confirmation includes its required reason and is terminal;
  - once persisted as completed, a game is immutable through normal session event/head/snapshot/completion mutations;
  - there is no administrative correction event, arbitrary state override, in-place outcome edit, or reopen flow;
  - deletion/retention administration is not a correction mechanism and is outside #17.
- Keep idempotent retries of the exact terminal request successful; reject a different mutation after completion with the existing stable completed-session error instead of silently accepting it.
- Audit every session mutation kind in `apps/server/src/game-session-store.ts` and route dispatch in `apps/server/src/app.ts` so legacy snapshot or head-move paths cannot bypass the completed boundary.
- Ensure the completed timeline/detail UI remains read-only: no Undo, reset-to-checkpoint, finish-again, or editable outcome/reason controls when viewing historical sessions.
- Add focused tests for exact duplicate retry versus conflicting replay append, head move, snapshot, second completion, and any normalization path that could rewrite a completed projection.

## Acceptance criteria

- Documentation gives moderators an unambiguous correction workflow and states the post-completion limitation.
- Every normal mutation route rejects changes to a completed game consistently, while an exact idempotent retry returns the original result without duplicate history/stat effects.
- Historical timeline/details expose no correction controls.
- No new administrative mutation endpoint or hidden override is introduced.
- The behavior holds for wins, draws, and cancellations and remains club-isolated.

## Focused verification

- `game-session-store.test.ts`: table-driven completed-session mutation matrix plus idempotent retry assertions for all outcomes.
- `app.test.ts`: stable status/error payload through each exposed mutation route.
- `GameTimelineScreen.test.tsx` and relevant App tests: historical views remain read-only.
- Documentation review against the implemented history route and mutation-error contracts.

## Non-goals

- Designing a future audited amendment/reversal ledger.
- Deleting historical records, changing retention, or adding admin roles.
- Relaxing canonical replay, idempotency, or club authorization.
