# Hide Critical in private mode — implementation plan

> **Completed — non-executable.** Implemented after Michael’s “go”; focused regressions, Chrome/WebKit checks, full `npm run check:local`, and final independent review passed. See [verification](../reports/ui-recovery/verification.md). Original planning text below is historical. Retained untracked/uncommitted only pending Git-history-safe retirement.

> **For Hermes:** Use the explicit approval boundary and scoped execution approach below.

**Goal:** Prevent the Critical badge from exposing game balance when private mode is enabled.

**Plain-language summary:** Critical disappears with private team information and returns when privacy is disabled, if the condition still applies.

**Architecture:** Gate rendering with existing `privacyHidden`; do not change canonical game state or the critical-condition predicate.

**Tech Stack:** React, TypeScript, Vitest/Testing Library.

## Confirmed context and files
- Michael explicitly superseded the earlier always-visible-while-masked decision.
- `apps/web/src/features/game/GameScreen.tsx:545` currently renders Critical solely from `isCriticalState(game)`.
- `apps/web/src/features/game/GameScreen.test.tsx:86` explicitly requires visibility while masked in Day and Night; this expectation must change.
- `apps/web/src/features/game/critical-state.ts` defines the critical balance and excludes pre-play/finished/winner states.
- `apps/web/src/App.tsx:1351` uses the same predicate for Endgame music preference. Preserve that behavior.

## Steps
1. Replace masked-visibility expectations with DOM absence assertions, including accessible status names, in Day and Night. Test a same-instance private on/off round trip and a condition change while hidden.
2. Run the focused tests and verify failure is the existing rendered badge, not a fixture error.
3. Add the privacy render gate; retain unmasked critical coverage across all currently supported active phases and preview rendering.
4. Verify through the actual privacy control in an isolated browser fixture. Counts remain masked; no hidden Critical text, tooltip, or accessible status is left behind.

## Acceptance criteria
- Private mode: Critical is absent from DOM/accessibility output, not merely visually hidden.
- Unmasked: existing critical behavior is unchanged across Day/Night and active subphases.
- Toggling privacy neither mutates game state nor changes music classification.

## Non-goals
No new privacy filtering for logs/timeline, no changes to rules or replay, no unrelated private-info redesign. The Guessing Game indicator is delivered by its separate plan, using the same hiding rule.

## Focused verification
`npm run test -w @mafia/web -- src/features/game/GameScreen.test.tsx src/features/game/critical-state.test.ts src/App.test.tsx`

## Risks and dependency
Only presentation is private; changing `isCriticalState` to depend on privacy would incorrectly change music behavior. Implement before Guessing Game to establish the shared presentation rule.

## Approval and execution boundary
Planning only. Implement only after explicit approval in a later turn, using focused regression-first changes and one final scoped review. No commits, pushes, deployments, dependency additions, or live user-data changes are authorized. Preserve unrelated plans and pending game data.

## Final verification
Run the focused checks below, then `npm run check:local` (the inspected wrapper runs `npm run check` against a disposable `mafia_test` database). Never run destructive server tests against `mafia_local`. Run `git diff --check`. Record real outcomes; do not claim browser or device verification from component tests alone. Remove this plan only after its acceptance criteria are verified.
