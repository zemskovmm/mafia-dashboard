# Same-night Don/Sheriff check glow

## Outcome

Implemented the approved visual-only correction. An eligible Don or Sheriff killed that night retains their existing role glow at full brightness during their own check stage. Eliminated status and the deceased cross remain intact. Check-result presentation, other deceased cards, check eligibility, persistence, and game events are unchanged.

## Implementation

- `NightStage` sets a presentation-only `nightCheckHighlight` signal alongside the existing eligible-role lighting signal.
- `GameTable` maps that signal to `is-night-check-highlight` without modifying status or GPU descriptors.
- The scoped CSS class restores opacity 1 and filter none.
- Existing NightStage component coverage now asserts the signal appears for deceased eligible owners and disappears in the result stage.
- `npm run verify:night-check-glow` starts an isolated loopback Vite server, renders the real NightStage/CSS/lighting providers with deterministic domain-generated game fixtures, exercises browser interactions, and shuts the server/browser down. Its earlier-night negative fixture intentionally renders a stale check stage to verify ineligible-owner defenses. No application API or database is used by this browser test.

## Verified evidence

- RED: the initial browser regression failed for the killed Don with actual computed opacity `0.48`, despite the existing `is-mafia-shooter` class; expected `1`.
- GREEN: both Don and Sheriff report actual computed opacity `1` and filter `none` during their check. Browser assertions retain the eliminated status and deceased cross.
- Both requested/effective CSS (`legacy`) and actual requested/effective GPU (`vgpu`) rendering passed in Chrome. GPU cases awaited ready, visible player canvases. The bundled Chromium run separately exercised working CSS fallback.
- Privacy mode and disabled player-lighting mode passed. Earlier-night owners and unrelated deceased targets remain at opacity `0.48`; eligible owners can still select deceased targets. Result stages return the owner to existing opacity `0.48` and grayscale presentation.
- Focused NightStage/GameTable/PlayerCardLighting suites passed; strengthened NightStage suite also passed.
- Strict standalone TypeScript check of the browser fixture passed.
- `npm run check` passed: formatting, lint, workspace typechecking, contract suites, server tests (185), web tests (589), domain tests (136), and production builds.
- The initial full check encountered the offline default test PostgreSQL endpoint. The successful rerun used an isolated PostgreSQL 17 cluster bound only to loopback, with explicit `TEST_DATABASE_URL` and database/identity/port readback. That cluster was stopped and its owned temporary directory removed afterward. No application database was touched.
- Build emitted the existing non-blocking large-chunk warning.
- `git diff --check` passed.

## Repository boundaries

Implementation began on local `main` after the unrelated availability change had already been committed externally as `e3828fc`. This task did not alter App.tsx/App.test.tsx or the pre-existing `.AI/lighting-visuals/` tree. Changes were left uncommitted after local verification. Michael subsequently explicitly authorized committing and deploying this fix through the existing main-push Azure workflow. Unrelated artifacts and issue state remain outside that authorization. The fulfilled untracked implementation plan was removed after verification; this report preserves scope and evidence without leaving a completed plan active.
