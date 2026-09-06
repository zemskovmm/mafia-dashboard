# Availability interaction implementation plan

Status: implemented; Chromium/touch-WebKit/keyboard regression matrix and full local check passed. Physical iPad post-tap acceptance remains pending. Evidence: ../card-fire/implementation-report.md.

**Goal:** Make availability cards show a stable selected/unselected state under mouse and touch interaction without losing visible keyboard focus.

**Plain-language summary:** Remove the extra hover/touch appearance that resembles a half-selected card; keep immediate selection and a clearly distinct keyboard outline.

**Architecture:** Scope the CSS correction to availability cards, retaining React's existing binary state and aria-pressed contract. Confirm the winning computed styles in real browsers before choosing the minimal override.

**Tech stack:** React, CSS, existing Vitest and Playwright tooling.

**Non-goals:** Flame redesign, global button restyling, blur-on-click hacks, removal of keyboard outlines, backend or data changes.

## Evidence and uncertainty
- apps/web/src/styles/app.css:170: global button:hover:not(:disabled) changes background and border; applies without a hover-capability media query.
- apps/web/src/styles/app.css:174: global focus-visible outline is separate.
- apps/web/src/styles/app.css:869: availability transitions already disabled.
- apps/web/src/styles/app.css:899 and :1436: selected background rules interact with the global hover shorthand.
- apps/web/src/features/setup/AvailablePlayersScreen.tsx:85-107: state comes directly from availablePlayerIds, with aria-pressed and icon/badge markers.
- Existing AvailablePlayersScreen.test.tsx tests state changes, not real CSS pseudo-class behavior.
- User reports mouse-hover and post-selection iPad appearance. Sticky touch hover is a hypothesis pending browser reproduction, not a verified physical-device diagnosis.

## Steps
1. Use an isolated visual fixture, not the signed-in development club. Record aria-pressed, hover/focus/focus-visible matches, background image/color, border and outline for selected and unselected cards before hover, on hover, on pointer exit, after click/tap, and after tapping elsewhere. Cover Chromium and touch WebKit; distinguish emulation from actual iPad evidence.
2. Add a failing real-browser regression for selected/unselected appearance invariance under pointer hover/tap, plus keyboard Tab and Space/Enter behavior. Extend apps/web/src/features/setup/AvailablePlayersScreen.test.tsx only for relevant missing semantic interactions.
3. Correct only the availability CSS cascade. Neutralize misleading full-card hover background/border changes for both states; keep focus-visible distinct, and do not forcibly blur controls. Preserve pointer/touch targets and instant aria-pressed/icon/badge changes.
4. Rerun focused component/browser checks. Verify rapid toggles, search persistence, keyboard operation, touch hover retention, no console errors, and unchanged other button styles.

## Likely files
- apps/web/src/styles/app.css
- apps/web/src/features/setup/AvailablePlayersScreen.test.tsx
- .AI/card-fire/interaction-proof.mjs (new isolated browser evidence harness after approval)

## Acceptance and verification
Mouse hover and post-tap state never resemble an additional availability state. Keyboard users retain a visible focus indicator independent of selection. Immediate semantic feedback works regardless of GPU readiness or lighting being disabled. Check normal GPU, CSS fallback, lighting-disabled and reduced-motion modes. Ask Michael to confirm the corrected post-tap appearance on actual iPad via the existing private URL. Run npm run check:local before finalizing the plan set; no commits/deployment.

## Risks
CSS shorthand/specificity can remove selected backgrounds unintentionally. WebKit touch emulation is not proof of physical iPad pseudo-class behavior. Keep the correction local; do not solve unrelated button styles.
