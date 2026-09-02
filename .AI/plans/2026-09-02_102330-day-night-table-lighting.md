# SVG Day/Night Table Renderer Implementation Plan

> **For Hermes:** Implement after the SVG player-card plan passes.

**Goal:** Implement always-on animated SVG table ambience for day and night while preserving table geometry and controls.

**Brief summary of upcoming changes:** SVG mode will render warm multicolor chasing/fading around the day table and deep navy/violet/blue ambience at night. The actual SVG layer stays present even when player LEDs are disabled and becomes static under reduced motion.

**Architecture:** Add one `TableAmbientLighting` SVG as the first `.round-table` child. Existing `is-table-cycle-day` / `is-table-cycle-night` classes select palette and timing. Render SVG during requested SVG and during V-GPU warm-up/fallback; legacy continues using its scoped current tint.

**Tech Stack:** React, TypeScript, inline SVG, CSS animations, Vitest, Playwright Chromium/WebKit.

**Non-goals:** Renderer selection, player LEDs, legacy tint implementation, V-GPU runtime, phase/rules changes, custom themes, or changing the permanent center shadow.

---

## Task 1: Define the explicit ambient layer test first

**Files:**
- Create: `apps/web/src/features/effects/TableAmbientLighting.tsx`
- Create: `apps/web/src/features/effects/TableAmbientLighting.test.tsx`
- Modify: `apps/web/src/features/table/GameTable.tsx:97-128`
- Modify: `apps/web/src/features/table/GameTable.test.tsx`

**RED:** Require one `aria-hidden`, non-focusable, pointer-inert SVG inside `.round-table` for SVG effective mode, requested V-GPU warm-up/fallback, normal/read-only tables, and player-lighting disabled state. Require multiple explicit paths/fields and unchanged center/advance/seat/host semantics.

Verify semantic RED, implement the minimal viewBox-based layer, and rerun to PASS.

## Task 2: Add responsive day/night palettes

**Files:**
- Modify: `apps/web/src/styles/app.css` at table-cycle, stacking, reduced-motion, and responsive rules around `:3421-3432` and `:3684-3700`

**GREEN contract:**

- Day: warm amber/gold plus restrained secondary color, slow multipath chase/fade, broad low-opacity outward halo.
- Night: lower-luminance navy/violet/blue and slower suspenseful motion.
- Animate opacity/stroke-dash offset/transform only; no React frame loop or layout read.
- Position absolute/inset zero, preserve circular and narrow-grid layouts, and keep all semantic content/focus above it.
- Player-lighting toggle never hides table ambience.
- Reduced motion stops every ambient animation while retaining palette/radiance.
- New SVG mode does not use decorative table pseudo-elements.

## Task 3: Replace retired pseudo checks with rendered evidence

**Files:**
- Modify: `scripts/verify-ui.mjs:804-853` and final evidence payload
- Modify if screenshot naming needs extension: `scripts/verify-ui-hardening.mjs:3-29`

**RED then GREEN:** Assert against `.table-ambient-lighting` rather than old pseudo-elements:

- day and night have distinct requested palettes and active normal-motion animations;
- no visible DAY/NIGHT text appears;
- bounds cover the table without altering core geometry;
- layer remains visible after disabling player LEDs;
- V-GPU initialization/failure warm-up uses the same SVG layer;
- reduced motion yields `animation: none` with visible palette;
- pointer/accessibility checks remain clean.

Run:

```sh
APP_URL=http://127.0.0.1:5173 npm run verify:ui
APP_URL=http://127.0.0.1:5173 npm run verify:ui-hardening
```

Inspect 1366×768 Chromium, 1366×1024 WebKit, and 1000×600 Chromium screenshots for clipping, washout, overlap, and input obstruction.

## Acceptance

- Explicit SVG table layer is always on in SVG/fallback mode and independent of player LEDs.
- Day/night palettes and motion match the issue; reduced motion is static.
- Table controls, geometry, read-only view, and target viewport matrix remain intact.
