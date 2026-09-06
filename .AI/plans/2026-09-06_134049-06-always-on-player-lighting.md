# Remove Player LEDs switch implementation plan

**Goal:** Remove the independent Player LEDs on/off choice while keeping player lighting enabled.
**Summary:** Delete the redundant switch; keep Raytracing and pulse controls, and ensure a previously saved “off” choice cannot silently hide the lighting.
**Architecture:** Retire the obsolete enable/disable preference and its unused dispatch/UI wiring; retain semantic lighting-kind selection, renderer fallback and reduced-motion behavior.
**Tech stack:** React/TypeScript, localStorage preferences, Vitest, existing browser verifiers.
**Non-goals:** Disabling effects, removing Raytracing/pulse settings, changing fire visuals, clearing unrelated browser preferences.

## Evidence and approach
`App.tsx:1945-1947,2454-2472` writes the old preference and renders the switch. `LightingRendererContext.tsx:38` restores it, including disabled values. `VgpuLightingCanvas.tsx:63-69` gates canvases on it; CSS includes corresponding disabled selectors.

1. Add failing tests that the switch is absent, card lighting remains enabled with an old disabled localStorage value, and Raytracing/pulse settings retain persistence and behavior.
2. Remove the switch and dead event/preference wiring. Ignore the retired stored key; do not bulk-clear localStorage. Simplify state, consumers and obsolete disabled CSS/test paths only where no longer used.
3. Update EN/RU labels and active verifiers that expect the removed toggle. Replace retired toggle-off tests with positive always-enabled, semantic-kind/null, renderer fallback and reduced-motion checks; do not weaken GPU-failure coverage.
4. Verify fresh and existing preferences on reload in availability and game views; switching Raytracing still changes GPU/CSS renderer, not whether selection is visible.

**Files:** `App.tsx`/`App.test.tsx`, `features/effects/lighting-preferences.ts` and tests, `LightingRendererContext.tsx` and tests, `vgpu/VgpuLightingCanvas.tsx` and tests, `styles/app.css`, `i18n/messages/shell.ts`, `scripts/verify-ui.mjs` as required by actual usages.
**Verification:** `npm run test -w @mafia/web -- src/features/effects App.test.tsx`; browser stale-preference scenario.

## Shared boundaries and verification
No commits, pushes, deployment, dependency additions, backend/auth changes, or development database mutations. Preserve the dirty working tree, current fire/lighting work, secret-role handling and canonical game state. Use isolated API fixtures, never the signed-in club, for visual interaction tests. After approval, add a failing focused regression before implementation; run focused browser/component checks while iterating, then `npm run check:local` (the disposable-database route to root `npm run check`) for the completed plan set. Keep artifacts under `.AI/ipad-layout/`. Require actual iPad visual acceptance; emulated WebKit is not hardware proof.
