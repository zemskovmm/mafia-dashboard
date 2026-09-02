# V-GPU Lighting Renderer Implementation Plan

> **For Hermes:** Implement only after the selector and complete SVG renderer pass. Keep SVG available as the runtime fallback throughout.

**Goal:** Add a lifecycle-safe V-GPU/WebGPU renderer for both player-card and table lighting with atomic SVG fallback.

**Brief summary of upcoming changes:** Selecting V-GPU will dynamically initialize one shared GPU runtime and render card LEDs plus day/night table ambience on pointer-inert canvases. Unsupported WebGPU, initialization failures, stale async completion, device/render errors, or failed readiness keep the requested selection but switch the effective visuals to SVG with visible Dev-menu status.

**Architecture:** Add `vgpu@^0.3.1` to the web workspace and use inline WGSL strings, avoiding a loader plugin. A single provider owns one `Gpu`, cached player/table effects, registered canvas surfaces, one frame loop, resize/invalidation, reduced-motion behavior, and disposal. React canvas components register/unregister declaratively; they never own separate devices or loops.

**Tech Stack:** V-GPU 0.3.1, WebGPU/WGSL, React, TypeScript, `vgpu/mock`, Vitest, Playwright Chromium.

**Non-goals:** Porting the triangle demo wholesale; pointer interaction; GPU-driven game state; one GPU per card; server rendering; replacing the SVG fallback; custom shader controls.

---

## Current reference findings

- Official browser API uses `init`, `surface`, effects/draw calls, and `frameLoop`; `init()` throws `VGPU-RING1-UNSUPPORTED` when WebGPU/adapter is unavailable.
- The triangle LED reference is a multi-pass continuous renderer with explicit resize, generation, error, and disposal handling. Reuse its lifecycle discipline and layered edge/radiance look, not its triangle geometry or pointer controls.
- `vgpu` 0.3.1 is MIT licensed and approximately 6.2 MB unpacked. Dynamic import keeps it out of legacy/SVG startup execution; the lockfile pins resolved bytes.
- V-GPU accepts inline WGSL strings, so no direct `@vgpu/wgsl/loader-vite` integration is needed.

## Task 1: Add the dependency and injectable runtime contract

**Files:**
- Modify: `apps/web/package.json`
- Modify: `package-lock.json`
- Create: `apps/web/src/features/effects/vgpu/VgpuLightingRuntime.ts`
- Create: `apps/web/src/features/effects/vgpu/VgpuLightingRuntime.test.ts`

**RED:** Define wished-for runtime behavior with an injected V-GPU module/fake:

- one async initialization generation;
- one GPU owner for all surfaces;
- registration/update/unregistration for `player` and `table` canvases;
- idempotent dispose;
- matching-generation ready/error callbacks exactly once;
- stale init/resize/error completion after dispose or mode change cannot publish status;
- failed partial initialization disposes every acquired surface/effect/GPU;
- no registration accepts pointer input.

Add `vgpu` using the workspace package manager only after RED exists. Implement the smallest runtime seam and test through `vgpu/mock` or a typed fake where DOM canvas behavior is not available.

## Task 2: Implement shared WGSL effects and one frame scheduler

**Files:**
- Create: `apps/web/src/features/effects/vgpu/lighting-shaders.ts`
- Modify: `apps/web/src/features/effects/vgpu/VgpuLightingRuntime.ts`
- Extend: `apps/web/src/features/effects/vgpu/VgpuLightingRuntime.test.ts`

**RED:** Require:

- player shader modes red/blue/yellow/speaker, with speaker alternating yellow/blue emitters;
- table shader day warm multicolor and night navy/violet/blue;
- one shared frame submission iterates registered surfaces;
- state updates change uniforms without recreating the GPU;
- resize follows surface sizing/DPR capped to a safe range;
- player-disabled state unregisters/skips player surfaces while table continues;
- reduced motion draws one stable frame on registration/state/resize and stops continuous animation;
- normal motion starts only one shared frame loop and stops it when no animated surfaces remain.

**GREEN:** Implement compact rectangular/card and radial/table WGSL derived from normalized coordinates. Use narrow emitter cores and restrained falloff; do not copy the triangle demo's geometry, input system, or full multi-pass pipeline. Cache pipelines/effects and keep per-surface state small.

## Task 3: Integrate React canvases and atomic renderer readiness

**Files:**
- Create: `apps/web/src/features/effects/vgpu/VgpuLightingProvider.tsx`
- Create: `apps/web/src/features/effects/vgpu/VgpuLightingCanvas.tsx`
- Create: `apps/web/src/features/effects/vgpu/VgpuLightingProvider.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/features/effects/PlayerCardLighting.tsx` or its host seam
- Modify: `apps/web/src/features/effects/TableAmbientLighting.tsx` or its host seam
- Modify: `apps/web/src/styles/app.css`

**RED:** Prove:

1. requested V-GPU mounts provider/canvases while SVG remains visible;
2. first successful current-generation render reports ready and atomically reveals all V-GPU layers/hides SVG;
3. unsupported/rejected init reports fallback, removes/hides canvases, keeps SVG visible, preserves requested V-GPU preference, and exposes status;
4. changing modes during init disposes late resources and cannot flip back to V-GPU;
5. unmount and Strict Mode double lifecycle do not leak devices, loops, surfaces, observers, or callbacks;
6. player toggle removes only player canvases; table canvas continues;
7. canvas is `aria-hidden`, nonfocusable, pointer-inert, and below content.

**GREEN:** Dynamically import `vgpu` only for requested V-GPU, route status through the renderer context, and preserve SVG until readiness. Handle current-generation initialization/frame failures through the same fallback path. Retry on next load/reselection; do not rewrite the requested preference to SVG.

## Task 4: Verify fallback and real WebGPU separately

**Files:**
- Create: `scripts/verify-vgpu-lighting.mjs`
- Modify: `package.json` to add `verify:lighting-vgpu`
- Modify: `scripts/verify-ui.mjs` for selector/fallback continuity

**Fallback browser matrix:** Existing Chromium/WebKit verifier must select V-GPU with WebGPU unavailable/failed and prove:

- requested select stays V-GPU;
- localized fallback status appears;
- effective SVG player/table layers remain visible and usable;
- no page/console/accessibility error or blank gap;
- switching to legacy/SVG clears status and restores that exact renderer.

**Real V-GPU probe:** Launch Chromium with WebGPU enabled against the local Vite app and require:

- `navigator.gpu` and a non-null adapter;
- V-GPU status reaches ready rather than fallback;
- one table canvas plus only currently highlighted/selected player canvases;
- normal-motion pixels visibly change across frames, reduced-motion pixels remain stable, and canvases resize with their cards/table;
- mode switch/unmount removes canvases and releases the runtime;
- screenshots for red, blue, yellow/speaker, day, and night are captured and visually inspected for nonblack/nonuniform output and content contrast.

Run:

```sh
APP_URL=http://127.0.0.1:5173 npm run verify:lighting-vgpu
```

If the local browser cannot expose real WebGPU or screenshots are black/unverifiable, stop and leave #44 open; unit mocks and readiness flags are not substitutes for pixel evidence.

## Acceptance

- V-GPU renders both player and table surfaces from one GPU/runtime.
- SVG stays seamless during warm-up and after any failure.
- Requested V-GPU persists; fallback is visible and retries later.
- Reduced motion, resize, mode races, cleanup, player-toggle isolation, and real nonblank Chromium output are verified.
- No V-GPU code executes in legacy/SVG mode beyond the lazy host seam.
