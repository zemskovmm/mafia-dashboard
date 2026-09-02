# Issue 44 Lighting Renderer Plan Set

> **For Hermes:** Execute the linked one-goal plans in order with strict test-first changes, then use the closeout plan to deliver and close the issue.

**Issue:** [#44 — Add LED player-card effects and day/night table lighting](https://github.com/zemskovmm/mafia-dashboard/issues/44)

**Brief summary of upcoming changes:** Add one persisted Dev-menu renderer selector with **Same as before**, **SVG**, and **V-GPU** options. The selector controls both player-card and table lighting; SVG is the default. Keep the separate persisted player-LED on/off setting from the original scope so operators can hide card indicators without disabling table ambience. If V-GPU cannot initialize, render SVG instead without breaking the game.

## Selection rationale

The live backlog still selects #44: #23 is a multi-outcome release-qualification umbrella, #17 combines independent outcomes with unresolved correction semantics, and #44 has concrete visual acceptance, no unresolved dependency, and no competing PR.

## Confirmed product contract

- One renderer selector controls **both** player-card effects and table ambience.
- **Same as before (`legacy`)** preserves the current CSS card flares/glows and current static day/night table tint.
- **SVG (`svg`)** uses explicit React-rendered SVG card LEDs and animated SVG table ambience.
- **V-GPU (`vgpu`)** uses V-GPU/WebGPU canvas rendering for both surfaces.
- No stored renderer preference defaults to **SVG**.
- V-GPU/WebGPU unavailability or current-generation initialization/render failure falls back automatically to **SVG**.
- The original player-lighting preference remains separate: it defaults enabled, persists in browser storage, and hides only player-card effects in all three renderer modes. Table ambience remains present.

The fallback-status clarification timed out. The plan therefore uses the recommended, reviewable contract: retain the requested/persisted `vgpu` selection, use SVG as the effective renderer for that session, show a localized “V-GPU unavailable — using SVG” status in the Dev menu, and retry V-GPU on the next load or after selecting it again. Explicit approval of this revised plan confirms that assumption; otherwise revise it before implementation.

## Architecture

### Requested versus effective renderer

Model renderer state explicitly:

- `requestedRenderer`: persisted `legacy | svg | vgpu` choice shown by the Dev-menu selector;
- `effectiveRenderer`: `legacy | svg | vgpu`, with `svg` used while V-GPU initializes or after it fails;
- `vgpuStatus`: `idle | initializing | ready | fallback` for accessible Dev-menu feedback and stale-generation protection;
- `playerLightingEnabled`: separate persisted boolean controlling only card effects.

Expose this state through a narrow React lighting context. Existing gameplay components keep their current domain/state props; effect components consume visual context only.

### Renderer ownership

- **Legacy:** gate the current CSS pseudo-element/card animation and static table-cycle rules behind the effective legacy class. No new decorative node is required.
- **SVG:** render explicit `aria-hidden`, pointer-inert SVG player and table layers. CSS animates fixed primitives and becomes static under reduced motion.
- **V-GPU:** dynamically load `vgpu@^0.3.1` only when requested, initialize one shared GPU device, register one table canvas plus visible highlighted-card canvases, and draw them in one lifecycle-owned frame loop. Inline WGSL strings avoid adding a Vite shader-loader plugin.
- Render SVG as the warm-up/fallback layer until V-GPU reports a successful current-generation frame. Switch both player and table surfaces atomically to V-GPU only after readiness.

## Ordered plans

1. [`2026-09-02_102330-lighting-renderer-selection.md`](./2026-09-02_102330-lighting-renderer-selection.md)
   - Add persisted renderer/player-lighting contracts, context, Dev-menu selector/toggle, legacy gating, and requested/effective fallback state.
2. [`2026-09-02_102330-player-card-led-lighting.md`](./2026-09-02_102330-player-card-led-lighting.md)
   - Implement the SVG player-card renderer and state palette mapping.
3. [`2026-09-02_102330-day-night-table-lighting.md`](./2026-09-02_102330-day-night-table-lighting.md)
   - Implement the SVG day/night table renderer.
4. [`2026-09-02_102330-vgpu-lighting-renderer.md`](./2026-09-02_102330-vgpu-lighting-renderer.md)
   - Add the shared V-GPU runtime, player/table shaders, lifecycle handling, and verified SVG fallback.
5. [`2026-09-02_102330-issue-44-delivery-closeout.md`](./2026-09-02_102330-issue-44-delivery-closeout.md)
   - Verify every mode, preserve plan history, push the reviewed tree, post evidence, and close #44 last.

## Shared boundaries and invariants

- Preserve canonical game state, replay/events, server APIs, club isolation, session persistence, privacy, and all card/table interaction handlers.
- Reuse `current`, `mafiaShooter`, `sheriffHighlight`, `goodbyeHighlight`, `votingHighlight`, `is-availability-selected`, `is-table-cycle-day`, and `is-table-cycle-night`.
- Lighting nodes/canvases are `aria-hidden`, non-focusable, pointer-inert, and below names, badges, controls, focus rings, swipe menus, and deceased marks.
- Reduced motion keeps static state/palette indication in every mode. V-GPU draws on invalidation rather than running a continuous loop.
- When overlapping card flags occur, resolve one palette consistently: current → yellow/blue; mafia/availability → red; sheriff → blue; goodbye/voting → yellow.
- Renderer failure cannot change gameplay, erase the requested preference, remove table ambience, or leave a blank lighting surface.
- Preserve the unrelated untracked `.AI/plans/2026-08-29_134707-reconcile-stale-in-progress-github-issues.md`; never stage, delete, or rewrite it.

## Shared acceptance gate

- Selector options are localized, keyboard/touch accessible, persisted, and restore exactly.
- Player-lighting toggle remains persisted and affects only card effects in legacy, SVG, and V-GPU modes.
- Legacy mode retains current visuals and behavior.
- SVG mode renders all required card palettes plus warm animated day and deep navy/violet/blue animated night ambience without pseudo-element effects.
- V-GPU mode renders comparable card/table visuals through one shared V-GPU runtime; real Chromium WebGPU evidence is nonblank and visually inspected.
- Unsupported/failing V-GPU resolves to SVG with visible status and no game/UI error; WebKit fallback is explicitly exercised.
- Reduced-motion, disabled, read-only, eliminated, focus, touch, and responsive layouts remain usable.
- Focused tests, full UI verifier, Chromium/WebKit hardening matrix, dedicated real-WebGPU verifier, and `npm run check` pass on the same final source tree.

## Risks and stop conditions

- **V-GPU lifecycle:** asynchronous init, mode changes, resize, device/render errors, and unmount require generation checks and idempotent disposal. A stale ready/error callback must not change the current renderer.
- **GPU cost:** never create one GPU device or frame loop per card. Use one device/loop and dispose each surface registration independently.
- **Visual proof:** DOM readiness does not prove nonblack WebGPU pixels. Capture and inspect real screenshots; a canvas-ready flag alone is insufficient.
- **WebKit capability:** Safari/WebKit may use SVG fallback; that is accepted only if status, requested preference, accessibility, and full visual continuity are verified.
- **Scope drift:** custom colors/speeds, per-surface renderer selectors, server-synced preferences, audio synchronization, or game-rule changes require re-planning.
