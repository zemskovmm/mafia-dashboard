# Issue #20 Moderator Usability Report

**Issue:** https://github.com/zemskovmm/mafia-dashboard/issues/20

**Date:** 2026-09-01

**Result:** PASS — no deferred usability findings

## Brief summary

The moderator workflow now supports keyboard-only operation for core play, predictable focus entry/return for toolbar drawers and player context actions, 48px core targets, and fixed no-scroll layouts at the approved laptop, iPad, and compact-tablet landscape sizes.

## Scripted journey

The full browser verifier completed this moderator path:

1. Open a club and configure player availability.
2. Select a host and ten seats, clear/reselect a seat, and start the game.
3. Open manual role assignment with `Shift+F10`, verify focus placement, close with `Escape`, and restore seat focus.
4. Complete role giveaway and night-zero setup.
5. Enter day play and open/close player discipline actions entirely from the keyboard.
6. Exercise timer, nominations, voting, night actions, music controls, privacy, fullscreen, undo, timeline preview/reset, and game completion.
7. Confirm the fixed viewport, table, rail, toolbar, and controls remain unobstructed.

## Viewport results

| Profile | Result | Evidence |
| --- | --- | --- |
| Chromium 1366 × 768 laptop | PASS | keyboard/naming/target/geometry checks |
| WebKit 1366 × 1024 canonical iPad | PASS | keyboard/naming/target/geometry checks |
| Chromium 1000 × 600 compact tablet | PASS | keyboard/naming/target/geometry checks |
| Chromium 1366 × 1024 full journey | PASS | setup-through-completion browser verifier |

Generated browser artifacts:

- `/tmp/mafia-dashboard-laptop-1366x768-table.png`
- `/tmp/mafia-dashboard-ipad-1366x1024-table.png`
- `/tmp/mafia-dashboard-compact-tablet-1000x600-table.png`
- `/tmp/mafia-dashboard-table.png`

## Friction found and resolved

1. Player swipe actions had no conventional keyboard entry or focus-return path. Added `Shift+F10`/Context Menu, first-action focus, `Escape`, and origin restoration.
2. Log, Manage, and Dev drawers retained focus on their toolbar trigger. Added heading focus, `Escape`, `aria-controls`, and trigger restoration.
3. Several core targets measured 32–46px. Increased toolbar, utility handles, timer presets, seat actions, phase actions, nomination controls, and music fades to 48px.
4. Compact seat cards allowed only 42px per discipline action. Increased compact seat width to preserve two 48px actions.
5. Enlarged action rows initially touched the phase banner and adjacent cards at shorter landscape heights. Added bounded radial spacing and seat-specific row placement; pairwise browser checks now prove core controls do not overlap while the host stays inside the viewport.
6. Existing UI verification contained stale labels/theme assumptions. Updated it to the current night-zero wording and single glass-theme implementation.

## Deferred findings

None. Playlist drag reordering and developer-only diagnostics are explicitly outside the approved core-play boundary, and the user explicitly excluded status announcements, reduced-motion work, contrast/ambient-light work, and new non-color indicators.

## Commands executed

```text
npm test -w @mafia/web -- --run src/features/table/GameTable.test.tsx
npm test -w @mafia/web -- --run src/features/game/GameScreen.test.tsx
npm test -w @mafia/web -- --run src/features/setup/SetupWizard.test.tsx -t "opens and closes manual role assignment from the keyboard"
npm test -w @mafia/web -- --run src/App.test.tsx -t "moves focus into a toolbar drawer"
APP_URL=http://127.0.0.1:5174 npm run verify:ui-hardening
APP_URL=http://127.0.0.1:5174 npm run verify:ui
npm run check
```

The exact final results are also recorded in the issue closure comment.
