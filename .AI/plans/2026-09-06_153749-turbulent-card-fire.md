# Selected turbulent card fire — implementation plan

**Status:** Scope clarified; awaiting explicit implementation approval.

**Plain-language summary:** Replace the current fire in both selected availability cards and Mafia cards with sample B, turbulent flame sheets, at Michael's selected 50% intensity and 1.6× speed. Keep everything local and preserve other lighting and game behaviour.

**Goal:** Make both existing semantic-fire card paths visually match the chosen prototype at the selected settings.

**Architecture:** Port the mode-1 GLSL fire field from `.AI/fire-samples/index.html` into the existing WGSL player-fire function. Retain the shared V-GPU runtime, semantic fire flag, rounded-card distance mask, ordinary glow and static CSS fallback. Do not introduce a second renderer or new preferences.

**Non-goals:** New settings UI, changing ordinary pulse speed, SVG restoration, backend/data changes, unrelated UI fixes, commits, pushes or deployments. Physical-iPad verification is not interchangeable with browser emulation.

## Grounded context
- Prototype uses 3D noise, 14 composited slices, mode 1 and a screen-blended canvas. Its output is not interchangeable with the app's straight-alpha fire/glow composite.
- Prototype intensity input must map to 0.50; animation clock multiplier must map to 1.6, preserving the shader's internal 0.65 factor rather than interpreting 1.6 as a new pulse speed.
- App shader `apps/web/src/features/effects/vgpu/lighting-shader.ts` currently uses noise-bent ribbons in `player_fire`, with an interior SDF check and `cfg.pulse.z` semantic flag.
- `VgpuLightingRuntime.ts:60` supplies time and existing pulse configuration; ordinary lighting uses those independently.
- Existing shader tests include a brittle `fn flame_domain` source assertion and mock-adapter compilation. Replace the obsolete assertion and supplement with actual GPU output checks.
- The worktree contains substantial prior local changes; preserve them.

## Implementation steps
1. Save current shader/CSS hashes and approved prototype reference frames under `.AI/turbulent-card-fire/`. Capture mode B at intensity 50%, speed 1.6, fixed known times. Keep these values explicit in evidence.
2. Read current canvas selection, CSS stacking/fallback, runtime scheduling and their tests. Add focused RED coverage for the selected fire configuration, interior output, and fire-off/table invariance. Use real renderer proof for shader behaviour, not only source-string/mock checks.
3. Replace only the old fire helpers and fire field in `lighting-shader.ts` with mode B's field. Convert bottom-up prototype coordinates to the app coordinate system, preserve 0.50 intensity and 1.6 clock rate, and correctly map emitted colour to alpha composition without a black opaque card or altered external glow. Keep reduced-motion frames static and the existing fallback nonanimated.
4. Exercise both actual UI paths using isolated API fixtures: selected availability cards and visible Mafia cards. Preserve selection/touch/focus behaviour, Raytracing/manual CSS/adapter-failure paths, pulse preferences, card content and ordinary/table lights. Change CSS or runtime only if required by the selected effect's integration, not opportunistically.
5. Compare actual GPU frames against the reference at matching dimensions/times; inspect screenshots and motion at actual card sizes, desktop and iPad-sized viewport, narrow layout and scrolled cards. Check text contrast and clipping. Measure multi-card frame behaviour versus the current implementation; do not silently reduce slice count/change the chosen appearance to hide a regression. If matching appearance and usable performance conflict, report evidence and return to scope clarification.
6. Run focused effects/UI tests and browser proofs, then `npm run check:local` (which invokes the repository check gate with isolated PostgreSQL). Verify local HTTPS readiness without altering routing or real player data. Deliver in the preview pane using `desktop_preview` with the full path/URL, avoiding space-truncated MEDIA attachments. Remove this plan after verification and retain concise evidence under `.AI/turbulent-card-fire/`.

## Expected file boundaries
- Primary: `apps/web/src/features/effects/vgpu/lighting-shader.ts`, `lighting-shader.test.ts`.
- Conditional only if integration requires: `VgpuLightingRuntime.ts`, `VgpuLightingRuntime.test.ts`, `VgpuLightingCanvas.test.tsx`, `apps/web/src/styles/app.css`.
- Read/regression targets: `apps/web/src/features/setup/AvailablePlayersScreen.tsx`, its tests; `apps/web/src/features/table/GameTable.tsx`, its tests; effects context/provider/canvas tests.
- New verification/reference artifacts: `.AI/turbulent-card-fire/`.

## Acceptance
- Both existing fire usages show the selected B design at 50% intensity and 1.6× speed, not a recoloured version of the old ribbons.
- Fire stays within the rounded card; text remains readable; ordinary/table lighting and pulse timing remain unchanged.
- Reduced motion, fallback, selection, touch/focus and scrolling remain functional.
- Actual GPU proof and visual comparisons pass; browser emulation and physical-device acceptance are reported separately.
- Focused tests and the full local gate pass, or any blocker is explicitly reported without claiming completion.
- No commits, publication, live data mutations or unrelated file changes.
