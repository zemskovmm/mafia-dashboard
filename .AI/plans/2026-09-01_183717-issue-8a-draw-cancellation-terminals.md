# Issue #8A — Draw and Cancellation Terminals

> **For Hermes:** Execute only as part of the approved #8 plan set.

**Goal:** Give the pure game domain deterministic no-elimination-cycle tracking plus reasoned, replayable draw and cancellation terminal actions, without adding product UI or completed-result storage.

**Architecture:** Keep team victory represented by `phase: "finished"` plus `winner: Team`. Add separate `"draw"` and `"cancelled"` terminal phases whose `winner` remains `null`. Track cycle facts in `GameState`, derive whether to suggest a draw, and make draw/cancel canonical lifecycle events with mandatory reasons. Treat absent cycle fields as legacy defaults so existing browser/server snapshots and hashes remain replayable.

**Non-goals:** Draw/cancel buttons or dialogs; final result rows/statistics/filters/export; alternate rulesets; arbitrary state patches; a generic correction event; changing Undo/Timeline Reset; migration of existing completed results; issue #17 work.

## Source-backed starting point

- `packages/game-domain/src/types.ts:9-28,66-94` has one terminal phase (`finished`) and no cycle state.
- `packages/game-domain/src/game.ts:30-65,117-129` creates games and evaluates team victory.
- `packages/game-domain/src/night-actions.ts:240-278` is the deterministic boundary from one complete day/night cycle to the next day.
- `packages/game-domain/src/game-events.ts:1071-1204,1340-1423` applies canonical actions and enforces root/head lifecycle markers.
- `apps/server/src/game-session-validation.ts:14-34,147-208,760-825` independently validates phases, snapshots, and canonical event payloads.
- `apps/web/src/features/timeline/timeline-model.ts:131-188,271+` and `GameTimelineScreen.tsx:240+` assume only `game.completed` is terminal.

## State contract

Modern games should initialize these fields:

- `cyclesWithoutElimination: number` — completed day/night cycles since the last elimination or red card.
- `eliminationOccurredThisCycle: boolean` — internal cycle fact set by every active-to-inactive transition and consumed at the next `completeNight` boundary.

For legacy persisted states, domain logic and server validation accept both fields as absent and interpret them as `0` and `false`; do not normalize an old baseline before hashing it.

A derived `shouldSuggestDraw(game)` returns true at `cyclesWithoutElimination >= 3`. It does not end the game. `confirmDraw(game, reason)` and `cancelGame(game, reason)` require trimmed non-empty reasons and explicitly terminalize the state.

## Task 1: Add terminal phases and cycle bookkeeping

**Files:**
- Modify: `packages/game-domain/src/types.ts`
- Modify: `packages/game-domain/src/game.ts`
- Modify: `packages/game-domain/src/night-actions.ts`
- Modify if transient cleanup remains shared there: `packages/game-domain/src/night-transition.ts`
- Modify: `packages/game-domain/src/game.test.ts`
- Modify: `packages/game-domain/src/night-actions.test.ts`

**Steps:**
1. Extend `GamePhase` with `draw` and `cancelled`; add optional legacy-compatible cycle fields to `GameState` while ensuring `createGame` always writes modern values.
2. Add one terminal-phase helper and use it wherever “finished” really means “no further game action.” Preserve `winner !== null` exclusively for `phase === "finished"`.
3. Set `eliminationOccurredThisCycle: true` in the single active-to-inactive primitive (`markPlayerInactive`) so voting kills, night kills, and red cards cannot diverge.
4. At `completeNight`, compute the next count once: reset to zero if an elimination occurred during the completed cycle, otherwise increment; then clear the cycle flag.
5. Add `shouldSuggestDraw`, `confirmDraw`, and `cancelGame`. Draw is available only after active play begins; cancellation is available from any nonterminal game phase. Both reject blank reasons and both reject a second terminal action.
6. Terminalization must clear transient voting/night/check/turn-action fields that server state invariants restrict, while retaining players, day, rule snapshot, cycle count, and immutable historical facts.
7. Add focused tests for initialization, three no-elimination cycle boundaries, reset on vote/night/red-card removal, no automatic draw, confirmation/cancellation, invalid/duplicate terminal actions, and team-winner invariants.
8. Run `npm test -w @mafia/game-domain -- src/game.test.ts src/night-actions.test.ts src/day-actions.test.ts`.

## Task 2: Add canonical terminal events and replay rules

**Files:**
- Modify: `packages/game-domain/src/game-events.ts`
- Modify: `packages/game-domain/src/game-replay.test.ts`
- Modify only if a new module is introduced: `packages/game-domain/src/index.ts`

**Steps:**
1. Add non-secret canonical drafts/events `game.drawn` and `game.cancelled`, each with exact payload `{ reason: string }`.
2. Validate reason shape in the domain validator: it must be a trimmed non-empty string and the payload must reject unknown keys. Keep user-facing maximum length enforcement at the eventual UI/API boundary rather than inventing one here.
3. Apply each event through the domain terminal action; do not patch state directly in replay.
4. Treat `game.completed`, `game.drawn`, and `game.cancelled` as mutually exclusive lifecycle terminals that may occur at most once and only at the active head. Reject any event after a terminal marker.
5. Include the new phases in canonical state validation and maintain the invariant: `finished` has a team winner; `draw`/`cancelled` have `winner: null`; every nonterminal phase has `winner: null`.
6. Ensure `isMeaningfulGameEventDraft`, secrecy classification, entry creation, state hashing, replay frames, and legacy-event handling remain exhaustive.
7. Add direct-vs-replay parity tests for draw and cancellation, strict payload tests, terminal-head tests, and tamper/hash rejection tests.
8. Run `npm test -w @mafia/game-domain -- src/game-replay.test.ts src/game-events-security.test.ts` (use the actual existing security test filename if the search at implementation start shows a different name).

## Task 3: Preserve persistence and visible-history boundaries

**Files:**
- Modify: `apps/server/src/game-session-validation.ts`
- Modify: `apps/server/src/game-session-validation.test.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/i18n/messages/shell.ts`
- Modify: `apps/web/src/features/game/GameScreen.tsx`
- Modify: `apps/web/src/i18n/messages/game.ts`
- Modify: `apps/web/src/features/timeline/timeline-model.ts`
- Modify: `apps/web/src/features/timeline/timeline-model.test.ts`
- Modify: `apps/web/src/features/timeline/GameTimelineScreen.tsx`
- Modify: `apps/web/src/features/timeline/GameTimelineScreen.test.tsx`
- Modify if required by localization coverage: `apps/web/src/i18n/messages/timeline-console.ts`

**Steps:**
1. Extend the independent Zod schemas for the two phases, optional legacy cycle fields, exact terminal-event payloads, and terminal winner consistency.
2. Keep `finalGameResultsSchema` team-winner-only and do not call the completion endpoint for draw/cancel; that remains #17. A live session snapshot may nevertheless persist and restore the terminal domain state and event chain.
3. Make App phase/event labels exhaustive for draw/cancel. Exclude terminal markers from ordinary three-action undo accounting in the same way as `game.completed`; do not add controls that can create these events.
4. Make `GameScreen` render stable read-only terminal titles rather than falling through to an unknown/active phase. Do not add a Finish result action for these states.
5. Add localized timeline marker descriptions containing the ruling reason and classify both as terminal/completion-style markers outside day/night regions.
6. Add server validation tests for valid modern and legacy snapshots, malformed reasons, inconsistent winner/phase combinations, and an event after a terminal head.
7. Add focused web tests for localized phase/event/timeline labels and terminal timeline placement; do not broaden into issue #17 workflows.
8. Run `npm test -w @mafia/server -- src/game-session-validation.test.ts` and `npm test -w @mafia/web -- src/features/timeline/timeline-model.test.ts src/features/timeline/GameTimelineScreen.test.tsx src/features/game/GameScreen.test.tsx`.

## Acceptance criteria

- The third completed no-elimination cycle suggests but does not force a draw.
- Any elimination or red card in a cycle resets the next completed-cycle count.
- Draw and cancellation require explicit non-empty explanations and result in distinct terminal phases with no winner.
- Canonical replay reproduces direct draw/cancel projections and rejects post-terminal entries.
- Existing persisted version-1/legacy-compatible snapshots without new fields still validate and replay without pre-hash normalization.
- Server/browser snapshot boundaries recognize the new state and events, while final result persistence remains untouched.

## Stop conditions

- If legacy hash compatibility requires rewriting historical baselines or events, stop and return to plan mode.
- If server completion/result tables must change to persist draw/cancel, defer that work to #17 rather than absorbing it.
- If implementing an explained terminal ruling requires an arbitrary state override, stop; that conflicts with the owner decisions on #15/#16.
