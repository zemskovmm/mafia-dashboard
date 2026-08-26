# Integrated Right Pane Edges and Spacing Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make the top grip and bottom music player read as structural parts of the right pane, remove the Voting-order divider, and add clear breathing room between the timer and Voting order.

**Architecture:** Keep the existing `LiveSidePanel` ownership, mounted player lifetime, Timer/Voting behavior, and canonical iPad rail geometry unchanged. This is a presentation-only refinement: the rail remains the one bordered/glass surface, while its top grip and bottom music section become flush edge sections whose corner radii follow the rail. The timer and Voting content remain inset inside a dedicated utility wrapper.

**Tech Stack:** React 19, TypeScript, CSS, Vitest, Playwright WebKit.

---

## Current Context and Interpretation

The supplied `IMG_0135.png` is a 2× tablet screenshot. It shows the current 8 CSS-pixel rail padding as visible moats around both edge sections:

- the top utility grip is inset from the pane's top and side edges;
- the compact music dock is inset from the pane's left, right, and bottom edges and retains a complete standalone-card border/radius;
- `margin: auto 0 0` keeps music correctly bottom-anchored, but the inset and nested outline make it look detached;
- the Voting divider comes from `.utility-panel-section + .utility-panel-section { border-top: ... }`;
- Voting starts almost immediately under the timer/divider.

This plan interprets “the gap” as the 8px outer moat around the music dock and the matching moat above/alongside the top grip. It deliberately **preserves the flexible empty pane area above the bottom-anchored player**, because the established design keeps music pinned at the bottom-right. If that large flexible area itself should also disappear, that is a separate composition change.

Existing contracts to preserve:

- Right pane remains `x946 / 406px` at the canonical 1366×1024 iPad viewport.
- Pane remains 14px from the viewport's right and bottom edges.
- Timer and Voting remain mounted while hidden.
- The exact YouTube iframe remains mounted; no player or queue state changes.
- Player expansion, queue scrolling, Initial/Endgame tags, fades, and Night-exit behavior remain untouched.
- The worktree is already intentionally dirty from the preceding prototype; do not reset, commit, or push it.

## Target Geometry

Use one pane-owned geometry contract:

- Rail outer radius: existing `20px`.
- Top grip section:
  - `left/top/right` flush with the rail border box;
  - top-left and top-right radii `20px`;
  - lower corners square so it reads as a header section.
- Utilities wrapper:
  - retain an `8px` horizontal inset for Timer and Voting;
  - keep an internal gap beneath the top grip rather than padding the whole rail.
- Voting:
  - no top border/divider;
  - `20px` visual gap from the timer's bottom edge to the Voting heading/section.
- Music dock:
  - `left/right/bottom` flush with the rail border box;
  - no standalone full border or shadow;
  - square top corners, bottom-left and bottom-right radii `20px` (or rely on the pane's `overflow: hidden` clipping);
  - retain a single top separator only if needed for section definition;
  - remain bottom-anchored with `margin-top: auto`.
- No document scroll, overlap, iframe remount, or width change.

---

### Task 1: Lock the Requested Edge and Spacing Geometry in the WebKit Probe

**Objective:** Make the requested visual relationships measurable before changing CSS.

**Files:**
- Modify: `scripts/verify-ui.mjs:621-699`

**Step 1: Extend the geometry sample**

Add rendered boxes/computed styles for:

- `.utility-panels-toggle`;
- `#game-utility-panels`;
- `.utility-panel-section[data-panel="timer"]`;
- `.utility-panel-section[data-panel="voting"]`;
- `.live-side-panel .youtube-dock`;
- the rail, top grip, Voting section, and music dock border radii/border widths.

**Step 2: Add RED assertions for the new contract**

Assert with a one-pixel tolerance:

```text
upperGrip.left   == rail.left
upperGrip.right  == rail.right
upperGrip.top    == rail.top
music.left       == rail.left
music.right      == rail.right
music.bottom     == rail.bottom
upperGrip top radii == rail radius (20px)
music full outer border width == 0
voting border-top width == 0
gap(voting.top, timer.bottom) >= 20px
documentHeight <= viewportHeight + 1
```

Update the obsolete equal-width assertion: Timer and Voting stay 8px inset, while music intentionally becomes full rail width.

**Step 3: Run the current probe and confirm semantic failure**

Run:

```bash
UI_BROWSER=webkit \
UI_VIEWPORT_WIDTH=1366 \
UI_VIEWPORT_HEIGHT=1024 \
UI_HEADER_ONLY=1 \
APP_URL=http://127.0.0.1:5173 \
npm run verify:ui
```

Expected: FAIL on the current 8px top/music moat, Voting divider, or insufficient timer-to-Voting gap—not on navigation or unrelated gameplay behavior.

---

### Task 2: Make the Rail Own the Top and Bottom Edge Sections

**Objective:** Remove nested-card spacing without changing component state or iframe lifetime.

**Files:**
- Modify: `apps/web/src/styles/app.css:2814-2888`
- No React markup change expected.

**Step 1: Remove outer padding/gap as rail-wide layout properties**

Change the canonical iPad/fullscreen rail from global `padding: 8px` and `gap: 8px` to edge-to-edge layout. Preserve internal utility spacing on `#game-utility-panels` instead:

```css
.live-side-panel.has-live-utilities {
  gap: 0;
  padding: 0;
}

.live-side-panel.has-live-utilities > #game-utility-panels {
  padding: 8px 8px 0;
}
```

Do not change the rail's fixed top/right/bottom/width or `20px` radius.

**Step 2: Match the upper grip to the pane radius**

Scope the rule to the rail so the lower music grip is unaffected:

```css
.live-side-panel.has-live-utilities > .utility-panels-toggle {
  border-radius: 20px 20px 0 0;
}
```

The button remains at least 44px tall and retains its current click/swipe suppression behavior.

**Step 3: Integrate the compact music dock**

Keep `margin-top: auto`, but make the dock a lower pane section rather than a nested card:

```css
.live-side-panel.has-live-utilities .youtube-dock.is-compact {
  width: 100%;
  margin: auto 0 0;
  border: 0;
  border-top: 1px solid var(--border);
  border-radius: 0 0 20px 20px;
  box-shadow: none;
}
```

The pane's `overflow: hidden` remains the final clipping authority. Apply the same edge contract when `.is-expanded` is present; do not remount or reposition the iframe.

**Step 4: Preserve standalone dock styling outside the unified rail**

Keep the base `.youtube-dock` border, shadow, radius, opacity, and fixed positioning unchanged for any presentation outside `.live-side-panel.has-live-utilities`. Only the descendant override should lose nested-card chrome.

---

### Task 3: Remove the Voting Divider and Add Timer Separation

**Objective:** Give Voting a clean, borderless start with more breathing room below the clock.

**Files:**
- Modify: `apps/web/src/styles/app.css:2859-2868`

**Step 1: Delete the unified-rail divider rule**

Remove:

```css
.live-side-panel.has-live-utilities .utility-panel-section + .utility-panel-section {
  border-top: 1px solid var(--border);
}
```

Do not remove list-item borders or the right pane's own border.

**Step 2: Add explicit spacing to Voting**

Use the semantic data attribute already present in `GameUtilityPanels.tsx`:

```css
.live-side-panel.has-live-utilities .utility-panel-section[data-panel="voting"] {
  margin-top: 20px;
}
```

The gap belongs to the Voting section, not to the timer buttons, so timer geometry and hit areas remain unchanged.

**Step 3: Confirm empty and populated Voting states remain compact**

Verify both `No nominations yet` and a populated nomination list fit without clipping or introducing document scrolling. Internal Voting content may grow; the document must not.

---

### Task 4: Focused Regression and Screenshot Review

**Objective:** Verify only the affected behavior and exact tablet composition.

**Files:**
- Test: `apps/web/src/features/game/LiveSidePanel.test.tsx`
- Test: `apps/web/src/features/game/GameUtilityPanels.test.tsx`
- Verify: `scripts/verify-ui.mjs`
- Screenshot: `/tmp/mafia-dashboard-side-panel.png`

**Step 1: Run semantic component tests**

Run:

```bash
npm run test -w @mafia/web -- \
  src/features/game/LiveSidePanel.test.tsx \
  src/features/game/GameUtilityPanels.test.tsx
```

Expected: all tests pass; the grip still hides/reveals both utilities without unmounting the Timer.

**Step 2: Run web TypeScript verification**

Run:

```bash
npm run typecheck -w @mafia/web
```

Expected: PASS.

**Step 3: Run the exact WebKit journey**

Run the Task 1 WebKit command again.

Expected: PASS with:

- rail still `x946 / 406px`, 14px from viewport edges;
- top grip and music dock flush with the pane;
- grip top radii match the pane;
- no Voting divider;
- at least 20px timer-to-Voting separation;
- no document scrolling;
- player node identity unchanged after grip/expansion interactions.

**Step 4: Inspect the resulting screenshot**

Inspect `/tmp/mafia-dashboard-side-panel.png` at full resolution and confirm:

- no visible moat above the top grip;
- no visible moat left/right/below the music section;
- no “card inside a card” border/shadow around music;
- upper and lower pane curves look continuous;
- Voting is clearly separated from the timer without a line;
- no clipping, accidental double border, opaque corner patch, or scrollbar.

**Step 5: Preserve prototype delivery state**

Leave all changes uncommitted and keep the running HMR application available at:

```text
https://mbp16.tail102fab.ts.net
```

Report the focused test count, WebKit geometry, screenshot inspection, and dirty worktree accurately. Do not run broad CI or commit/push until the user accepts the visual result.

---

## Files Likely to Change

- `apps/web/src/styles/app.css`
  - Rail padding/gap ownership.
  - Top grip radius.
  - Integrated music dock border/radius/shadow.
  - Voting divider removal and spacing.
- `scripts/verify-ui.mjs`
  - Edge alignment, radius, border, and timer-to-Voting gap assertions.

No changes are expected in:

- `apps/web/src/features/game/LiveSidePanel.tsx`;
- `apps/web/src/features/game/GameUtilityPanels.tsx`;
- `apps/web/src/features/music/YouTubePlaylistPlayer.tsx`;
- music preference, queue, fade, or game-domain code.

## Risks and Tradeoffs

- Removing rail padding globally without reintroducing an inset on `#game-utility-panels` would make Timer/Voting touch the pane edges; scope the inset deliberately.
- Leaving the base music border/shadow active would preserve the nested-card effect; override only inside the unified rail.
- Removing `margin-top: auto` would move music directly under Voting and violate the established bottom-pinned composition; keep it unless the user explicitly asks to eliminate the large flexible middle region.
- Matching a child radius while retaining an inset produces non-concentric curves; the top grip must be flush before assigning the full 20px radius.
- A full-width music dock means the old `timer.width === voting.width === music.width` browser assertion is no longer correct and must be replaced rather than weakened.
- The current worktree contains the previous one-playlist/global-pane prototype. Implementation must build on it and avoid resetting unrelated dirty files.

## Open Questions

None required for this iteration. The plan uses a 20px Timer-to-Voting gap as the concrete interpretation of “bigger margin” and preserves the player’s bottom anchoring.