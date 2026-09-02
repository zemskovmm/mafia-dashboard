# Lighting Renderer Selection Implementation Plan

> **For Hermes:** Implement this plan first with strict RED → GREEN cycles. Do not implement SVG or V-GPU drawing beyond the context/host seams needed by later plans.

**Goal:** Add persisted Dev-menu renderer and player-lighting controls that select legacy/SVG/V-GPU behavior without changing gameplay.

**Brief summary of upcoming changes:** The Dev menu will gain a three-option lighting renderer selector—Same as before, SVG, and V-GPU—plus the original player-LED enable/disable control. SVG defaults on a fresh browser. Requested and effective renderer state will be separate so V-GPU can initialize safely and fall back to SVG with visible status.

**Architecture:** Define small injectable storage helpers, a typed lighting context, and App-owned requested/effective state. Apply renderer/player-enabled data/classes at the app shell. Legacy CSS is gated behind effective legacy mode; SVG/V-GPU plans fill the explicit renderer slots later.

**Tech Stack:** React 19, TypeScript, browser `localStorage`, Vitest/Testing Library, existing i18n.

**Non-goals:** Implementing SVG primitives, V-GPU/WebGPU, changing current state meanings, adding per-club/server preferences, custom colors/timing, or removing the player-lighting toggle.

---

## Task 1: Define persisted contracts test first

**Files:**
- Create: `apps/web/src/features/effects/lighting-preferences.ts`
- Create: `apps/web/src/features/effects/lighting-preferences.test.ts`

**RED:** Tests require:

- `LightingRenderer = "legacy" | "svg" | "vgpu"`;
- missing/malformed renderer values default to `svg`;
- exact valid values restore unchanged;
- player lighting defaults enabled and restores exact enabled/disabled values;
- writes use versioned keys `mafia-dashboard.lighting-renderer.v1` and `mafia-dashboard.player-lighting.v1`;
- helpers accept injected reader/writer interfaces and do not throw for malformed values.

Run:

```sh
npm run test -w @mafia/web -- src/features/effects/lighting-preferences.test.ts
```

Expected RED: missing module. Implement the narrow helpers, rerun, expected PASS.

## Task 2: Establish requested/effective renderer context

**Files:**
- Create: `apps/web/src/features/effects/LightingRendererContext.tsx`
- Create: `apps/web/src/features/effects/LightingRendererContext.test.tsx`
- Modify: `apps/web/src/App.tsx:563-575,1608-1617`

**RED:** Require a context value containing:

- persisted `requestedRenderer`;
- `effectiveRenderer`;
- `vgpuStatus: idle | initializing | ready | fallback`;
- `playerLightingEnabled`;
- callbacks to select renderer, toggle player lighting, report current-generation V-GPU readiness, and report current-generation failure.

Prove these transitions:

1. fresh load: requested/effective SVG, player LEDs enabled;
2. choose legacy: both become legacy synchronously;
3. choose SVG: both become SVG synchronously;
4. choose V-GPU: requested persists V-GPU, effective remains SVG, status initializes;
5. matching-generation ready: effective switches atomically to V-GPU;
6. matching-generation failure: requested remains V-GPU, effective SVG, status fallback;
7. late ready/error after changing away from V-GPU is ignored;
8. player enabled state does not alter table/effective renderer state.

Run the focused context/App tests and confirm semantic RED before implementation. Implement the minimal state machine and provider value; do not put domain state into this context.

## Task 3: Add accessible localized Dev-menu controls

**Files:**
- Modify: `apps/web/src/App.tsx:1903-1952`
- Modify: `apps/web/src/App.test.tsx:961-1228`
- Modify: `apps/web/src/i18n/messages/shell.ts:142-153,339-350`

**RED:** App tests require:

- one labeled `<select>` in the developer menu with ordered options `Same as before`, `SVG`, `V-GPU` (and Russian translations);
- selector value reflects requested—not fallback/effective—renderer;
- keyboard/user changes persist and update app-shell renderer data/class;
- fresh storage selects SVG;
- existing valid storage restores each option;
- the player-lighting button defaults pressed/enabled, persists, and toggles only the player-enabled app-shell class/data;
- V-GPU fallback leaves the selector at V-GPU and exposes localized `role="status"` text “V-GPU unavailable — using SVG”;
- no fallback status appears for legacy/SVG or while V-GPU is ready.

Implement the controls using existing Dev-menu layout/focus behavior. Do not replace the select with three unlabeled buttons.

## Task 4: Gate the existing legacy renderer positively

**Files:**
- Modify: `apps/web/src/styles/app.css` around current player highlight and table-cycle rules
- Modify: `apps/web/src/features/table/GameTable.test.tsx`
- Modify: existing relevant stage tests only if a positive renderer wrapper is required

**RED:** Render a legacy wrapper and prove the existing semantic classes still produce their current positive visual contract; render SVG-effective wrapper and prove legacy decorative layers are not active while semantic classes remain. Do not add brittle absence-only source scans.

**GREEN:**

- Scope current card flare/glow/pseudo-element animations to effective legacy mode.
- Scope current static day/night table tint to effective legacy mode.
- Scope player-card legacy effects additionally to player-lighting enabled state; table tint ignores that toggle.
- Keep border/background/focus and interaction semantics legible when player lighting is disabled.
- Retain current reduced-motion rules for legacy effects.

Run:

```sh
npm run test -w @mafia/web -- src/features/effects/lighting-preferences.test.ts src/features/effects/LightingRendererContext.test.tsx src/features/table/GameTable.test.tsx src/App.test.tsx
```

Expected PASS after implementation.

## Acceptance

- One persisted selector controls both visual surfaces and defaults to SVG.
- Separate persisted player-lighting toggle remains and affects only cards.
- Requested/effective V-GPU states cannot race or lie about fallback.
- Legacy visuals remain available without changing gameplay or persistence.
- English/Russian controls, keyboard focus, `aria-pressed`, labels, and fallback status are covered.
