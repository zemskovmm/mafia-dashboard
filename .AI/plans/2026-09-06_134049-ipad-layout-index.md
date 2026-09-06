# iPad layout and navigation plan set

**Status:** all seven goals implemented and locally verified. Actual iPad visual acceptance remains pending; retain this uncommitted plan set for that acceptance only, not for re-execution. See [implementation report](../ipad-layout/implementation-report.md) and [machine-counted results](../ipad-layout/verification-summary.json). Final root check: 1,024 passed, 2 infrastructure-template skips; 8 geometry, 3 navigation and 4 lighting scenarios passed.

## Plain-language summary
Correct the table's card spacing and orientation; make the title, role-status information and navigation unobscured; remove the redundant Player LEDs switch while keeping lighting on; add a way back from the player directory. Preserve the existing game, player data and lighting work.

## Requirements and proposed decisions
- Reference is the supplied IMG_0141 iPad role-giveaway screenshot. Physical screenshot is 2752x2064 pixels; determine the actual CSS viewport/DPR/fullscreen safe-area state in browser rather than treating physical pixels as CSS dimensions.
- Seats 1 bottom-left and 10 bottom-right, level and upright, with a clockwise half-spacing rotation.
- Missing navigation concerns Player directory / player management.
- Remove Player LEDs toggle and keep lighting enabled; retain Raytracing and pulse controls.
- The obscured button was “Back to player selection”; it is now in the existing Manage/game menu, preserving role-draw progress and keyboard focus.
- The roles-remaining banner was inside an unmanaged header wrapper. It is now a direct phase-banner child, with verified separation from the timer and toolbar.

## One-goal plans and sequence
1. [seat orientation ](2026-09-06_134049-01-seat-orientation.md)
2. [table clearance ](2026-09-06_134049-02-table-clearance.md)
3. [header title ](2026-09-06_134049-03-header-title.md)
4. [role back action ](2026-09-06_134049-04-role-back-action.md)
5. [role status banner ](2026-09-06_134049-05-role-status-banner.md)
6. [always on player lighting ](2026-09-06_134049-06-always-on-player-lighting.md)
7. [player directory back ](2026-09-06_134049-07-player-directory-back.md)

Implement 01 before qualifying clearance in 02. Header 03/04/05 share markup/CSS and must be coordinated; 04 retains the existing state-preserving return behavior. Goals 06 and 07 are independently useful. Sequence shared-file edits (especially App.tsx/app.css); no concurrent owners of the same file.

## Verification and acceptance
After approval, reproduce each screenshot issue with a failing isolated browser assertion before source edits. Reuse the inspected `.AI/card-fire/integration-proof.mjs` / `.AI/lighting-polish/fixture.mjs` approach, adapted to role giveaway and fullscreen; wait for club-entry curtains to disappear before captures. Include screenshot-sized landscape, portrait, desktop, short landscape, phone, touch WebKit and GPU-ready Chrome (label diagnostic flags). Measure rectangles/clearance and click hit targets, not screenshots alone. EN/RU, safe-area/fullscreen, panels open/closed, keyboard and role-progress/state preservation are required where relevant.

User request 1 (clearance) maps to plan 02; request 2 (rotation) maps to plan 01. Requests 3–7 map to plans 03–07 respectively. Deliver before/after visuals and a locally running app for actual iPad acceptance. Run focused checks while iterating and `npm run check:local` before final delivery. Existing old fire plans remain pending visual acceptance; this plan set neither signs them off nor rolls them back.

## Boundaries
No commits, pushes, deployment, new dependencies, production/Tailscale changes, or development DB mutation. Preserve all existing dirty work and secrecy/replay/club-isolation safeguards. No unrelated markup cleanup. Plans and evidence stay under `.AI/`; successfully accepted/verified plans are then removed per repository policy.
