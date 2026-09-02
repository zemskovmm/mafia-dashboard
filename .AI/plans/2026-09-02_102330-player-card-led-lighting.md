# SVG Player-Card LED Renderer Implementation Plan

> **For Hermes:** Implement after the renderer-selection plan passes. Follow strict RED → GREEN cycles.

**Goal:** Implement the SVG renderer's state-driven player-card LEDs while preserving card semantics and interaction.

**Brief summary of upcoming changes:** In SVG mode, player cards will display red, blue, yellow, or alternating yellow/blue SVG LEDs from their existing state flags. Selected availability cards reuse red. The shared player-lighting toggle hides these layers without affecting table ambience or state behavior.

**Architecture:** Add a reusable pointer-inert `PlayerCardLighting` SVG with fixed perimeter LED primitives. A pure resolver maps `TableSeatView` flags to one palette. `GameTable` and `AvailablePlayersScreen` render the SVG only when requested/effective state needs SVG (including V-GPU warm-up/fallback).

**Tech Stack:** React, TypeScript, inline SVG, CSS animations, Vitest/Testing Library, Playwright.

**Non-goals:** Renderer selection/state, legacy effects, table ambience, V-GPU canvases, new game state, or changing card controls.

---

## Task 1: Define the semantic palette renderer test first

**Files:**
- Create: `apps/web/src/features/effects/PlayerCardLighting.tsx`
- Create: `apps/web/src/features/effects/PlayerCardLighting.test.tsx`

**RED:** Require:

- `red`, `blue`, `yellow`, and `speaker` palettes;
- explicit SVG perimeter LED primitives, not pseudo-elements;
- speaker points alternate yellow and blue;
- SVG is `aria-hidden`, non-focusable, and pointer-inert;
- player-disabled state does not render/show a card layer;
- SVG remains renderable when effective SVG is serving a requested V-GPU fallback.

Run the focused test; verify missing-component RED, then implement fixed primitives with no React frame state or layout reads and rerun to PASS.

## Task 2: Map existing GameTable state without changing it

**Files:**
- Modify: `apps/web/src/features/table/GameTable.tsx:7-24,129-245`
- Modify: `apps/web/src/features/table/GameTable.test.tsx:28-172`

**RED:** Require palette precedence:

1. `current` → speaker yellow/blue;
2. `mafiaShooter` → red;
3. `sheriffHighlight` → blue;
4. `goodbyeHighlight` or `votingHighlight` → yellow;
5. no visual signal → no SVG layer.

Prove button/read-only cards retain roles, labels, disabled state, content, deceased mark, swipe/context behavior, and current semantic classes.

**GREEN:** Add a pure resolver and insert `PlayerCardLighting` behind content. Keep all stage-owned flags and class names unchanged.

## Task 3: Integrate selected availability cards and SVG styling

**Files:**
- Modify: `apps/web/src/features/setup/AvailablePlayersScreen.tsx:79-101`
- Modify: `apps/web/src/App.test.tsx` in the existing availability flow
- Modify: `apps/web/src/styles/app.css:1347-1587` plus reduced-motion rules

**RED:** Require a selected availability card to show the red SVG renderer in SVG/fallback mode, while selection IDs, labels, and `aria-pressed` remain unchanged. Prove player-toggle off hides the effect but does not deselect the player.

**GREEN:**

- Render red `PlayerCardLighting` for `is-availability-selected`.
- Add tight bright LED cores, restrained outward drop-shadow radiance, staggered chase/fade timing, and content stacking above the SVG.
- Keep high-contrast border/background state cues.
- Use no decorative pseudo-elements for SVG-mode player effects.
- Under reduced motion, set LED animations to `none` while retaining static colored LEDs.

## Task 4: Add positive browser evidence

**Files:**
- Modify: `scripts/verify-ui.mjs` at existing state-highlight probes

Update the real moderator journey to assert in SVG mode:

- current seat yellow/blue;
- mafia cards red;
- Sheriff blue;
- voting/goodbye yellow only where intended;
- selected availability red;
- pointer/accessibility isolation;
- player-toggle hides only card layers and persists;
- reduced motion keeps static palettes.

Run:

```sh
APP_URL=http://127.0.0.1:5173 npm run verify:ui
```

Expected final result: focused journey PASS with inspectable screenshots.

## Acceptance

- Every required state maps to the correct SVG palette.
- The separate player toggle works in SVG and V-GPU-fallback-to-SVG states.
- No SVG-mode player effect depends on pseudo-elements or modifies domain behavior.
- Existing interaction and stage tests remain green.
