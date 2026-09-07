# Guessing Game indicator — implementation plan

> **Completed — non-executable.** Implemented after Michael’s “go”; focused regressions, Chrome/WebKit checks, full `npm run check:local`, and final independent review passed. See [verification](../reports/ui-recovery/verification.md). Original planning text below is historical. Retained untracked/uncommitted only pending Git-history-safe retirement.

> **For Hermes:** Use the explicit approval boundary and scoped execution approach below.

**Goal:** Identify the ongoing two-citizen/one-mafia endgame with a localized, privacy-safe badge.

**Plain-language summary:** When exactly three living players remain and one is Mafia, show “Guessing Game” in English or “угадайка” in Russian instead of Critical. Hide either badge in private mode.

**Architecture:** Derive an informational condition from the current `GameState`; this is not a new canonical phase or stored event. Render a single status badge using Guessing Game precedence over Critical.

**Tech Stack:** React, TypeScript, existing game-domain types, EN/RU catalogs, Vitest/Testing Library.

## Confirmed decisions
- Activate automatically throughout Day and Night active play, without changing rules.
- Michael selected “Guessing Game” after considering “Final Three”; use his selection, not a claim that it is standardized competitive terminology.
- Replace Critical at three players; hide both badges in private mode.
- “Living” follows existing `status === "active"`; Mafia follows `team === "black"`, including a living Don. Eliminated and red-carded players do not count.

## Context and files
- `apps/web/src/features/game/critical-state.ts` and `.test.ts`: existing derived predicate pattern and active-phase matrix.
- Proposed new `apps/web/src/features/game/guessing-state.ts` and `.test.ts`: narrowly scoped derived condition, reusing the current active-play exclusion through the existing predicate if that keeps the rule clear.
- `apps/web/src/features/game/GameScreen.tsx:525` and `.test.tsx`: team-count/status projection.
- `apps/web/src/i18n/messages/game.ts`: add EN/RU label.
- `apps/web/src/styles/app.css:1880`: existing team-count/pill layout and shared badge styles.
- `packages/game-domain/src/types.ts`: read-only type reference; no schema edits needed.
- `apps/web/src/App.tsx:1351`: preserve existing Endgame music classification via `isCriticalState`.

## Steps
1. Add focused predicate cases: active two-red/one-black, living Don, eliminated/red-carded exclusion, other balances, winner, finished, and pre-play. Cover the same active-phase set as Critical.
2. Add rendered tests in EN/RU: Guessing Game replaces Critical, other critical balances retain Critical, private mode leaves neither badge in DOM/AX, and toggling restores the right single label.
3. Implement pure derivation and one badge selection at render time; do not persist flags or introduce transitions. Apply the existing pill treatment without redesigning the counter.
4. Exercise elimination into the condition, undo/reset out of it, reload, and history preview to prove the badge follows the displayed snapshot without changing live game state. Verify locale switching changes only copy.
5. Check the translated label in tablet/desktop layouts and ensure it does not overlap controls.

## Acceptance criteria
- Exactly one appropriate badge in unmasked critical states; correct EN/RU text.
- Three active players including one black-team player triggers it throughout active Day/Night subphases, not after a winner or before play.
- Both labels absent in private mode.
- No canonical event, state hash, phase progression, timer, win rule, or music-preference changes.

## Non-goals
No special Guessing Game rules, manual mode switch, canonical phase/schema migration, new audio behavior, or general terminology rewrite.

## Focused verification
`npm run test -w @mafia/web -- src/features/game/guessing-state.test.ts src/features/game/critical-state.test.ts src/features/game/GameScreen.test.tsx src/App.test.tsx`

## Risks and dependency
Build on the Critical privacy plan. The three-player state is already a subset of Critical: keep the underlying predicate true for other consumers while changing only the displayed label. UI fixtures alone must not be called proof of historical replay compatibility; no persistence-contract change is intended.

## Approval and execution boundary
Planning only. Implement only after explicit approval in a later turn, using focused regression-first changes and one final scoped review. No commits, pushes, deployments, dependency additions, or live user-data changes are authorized. Preserve unrelated plans and pending game data.

## Final verification
Run the focused checks below, then `npm run check:local` (the inspected wrapper runs `npm run check` against a disposable `mafia_test` database). Never run destructive server tests against `mafia_local`. Run `git diff --check`. Record real outcomes; do not claim browser or device verification from component tests alone. Remove this plan only after its acceptance criteria are verified.
