# Queue Next-State and Exclusive Track Markers Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Remove the persistent red “Play next” row state, make Initial and Endgame mutually exclusive classifications, replace inline tag labels with tiny corner dots, and make active classification buttons unmistakably pressed.

**Architecture:** Keep queue order as the sole authority for what plays next: clicking **Play next** physically moves the chosen stable queue entry after the current track, so a second persistent `nextItemPosition` selection state is redundant and causes the reported red-row artifact. Retain the existing stable entry identity, swipe tray, queue persistence, and iframe lifetime. Continue storing Initial and Endgame as two playlist-owned key sets, but enforce disjointness atomically in the application persistence updater and defensively during preference hydration.

**Tech Stack:** React 19, TypeScript, CSS, Vitest, Playwright WebKit.

---

## Current Context and Corrected Diagnosis

The reported state is not a failed queue reorder. **Play next** correctly rewrites the local queue and moves the selected item directly after the current track.

The lingering appearance comes from a separate UI state in `YouTubePlaylistPlayer.tsx`:

```tsx
const [nextItemPosition, setNextItemPosition] = useState<number | null>(null);
```

`playNext()` stores the selected provider position, and each row derives:

```tsx
className={nextItemPosition === item.position ? "is-next" : ""}
aria-pressed={nextItemPosition === item.position}
```

CSS then gives `.is-next .queue-item-content` an accent/red background and border. Because provider position is stable, that red selection follows the same item through drag reorder and remains until another **Play next** click replaces the stored position. The queue order already encodes the requested next track, so this second state should be removed rather than restyled.

The earlier swipe-tray correction remains valid and must not regress: any queue rewrite should close `.is-queue-tags-revealed` so Initial/Endgame actions are never accidentally exposed after moving a row.

## Product Contracts and Assumptions

- After **Play next**, the row moves after the current track and immediately returns to ordinary row styling.
- No item remains red, selected, or `aria-pressed` merely because it was moved with **Play next**.
- The always-available icon controls **Play next** and **Play now** remain visible; this plan does not remove them.
- Initial and Endgame are **mutually exclusive**, but a track may remain unclassified.
- Clicking the active classification button unmarks the track.
- Clicking the other classification moves the track to that classification in one interaction (“last classification action wins”).
- Existing persisted records that contain the same key in both sets are repaired deterministically during hydration; **Endgame wins** because it is the more specific Critical-state classification.
- Initial uses a tiny green corner dot; Endgame/Critical uses a tiny red corner dot.
- A duplicate occurrence of the same YouTube video remains independently classifiable through `videoId:sourcePosition` identity.
- Queue rows remain exactly 54px high with one-line ellipsis.
- Keep the worktree uncommitted until visual acceptance; do not reset unrelated existing prototype changes.

---

### Task 1: Reproduce the Persistent Play-Next Row State

**Objective:** Lock the corrected symptom before removing its redundant state.

**Files:**
- Modify: `apps/web/src/features/music/YouTubePlaylistPlayer.test.tsx:98-208`
- Modify: `scripts/verify-ui.mjs:1818-1847`

**Step 1: Add a focused component regression**

Extend the existing ready-queue journey:

1. Click **Play Finale next**.
2. Assert Finale moves from index 2 to index 1.
3. Assert the moved row has neither `is-next` nor `is-queue-tags-revealed`.
4. Assert its Play-next control is not left `aria-pressed="true"`.
5. Drag the moved row elsewhere.
6. Assert no next-selection class follows it.

Use the existing stable row lookup by title/entry key; do not assert by stale array index after each reorder.

**Step 2: Strengthen the WebKit fixture**

The current browser fixture already:

- creates a three-track queue;
- swipes the third row;
- chooses **Play next**;
- verifies it moves to queue index 1;
- verifies the classification tray closes.

Add computed/rendered assertions that the moved row:

```text
has no is-next class
has no pressed Play-next button
uses the same content background and border color as an ordinary unclassified row
```

**Step 3: Verify RED**

Run:

```bash
npm run test -w @mafia/web -- \
  src/features/music/YouTubePlaylistPlayer.test.tsx \
  -t "cues and presents"
```

Expected: FAIL because the moved row retains `is-next` and its Play-next button remains pressed.

Run the exact WebKit queue journey:

```bash
UI_BROWSER=webkit \
UI_VIEWPORT_WIDTH=1366 \
UI_VIEWPORT_HEIGHT=1024 \
APP_URL=http://127.0.0.1:5173 \
npm run verify:ui
```

Expected: FAIL at the new persistent-highlight assertion while queue order and tray-close assertions continue to pass.

---

### Task 2: Remove Redundant Play-Next Selection State

**Objective:** Make physical queue order the only representation of “next.”

**Files:**
- Modify: `apps/web/src/features/music/YouTubePlaylistPlayer.tsx:105-125, 170-260, 451-468, 598-775`
- Modify: `apps/web/src/styles/app.css:2172-2178`

**Step 1: Delete `nextItemPosition` state**

Remove:

```tsx
const [nextItemPosition, setNextItemPosition] = useState<number | null>(null);
```

Delete every `setNextItemPosition(...)` call from playlist reset, restored-order application, Play next, Play now, and shuffle paths. These writes no longer represent product state.

**Step 2: Keep Play next as a queue rewrite only**

Preserve the current verified algorithm:

```text
capture current item and playback time
remove selected stable entry
insert it immediately after current item
persist ordered stable entry keys
re-cue/load the updated video-ID array at current item/time
close the swipe classification tray
```

Do not change provider playlist ownership or mutate YouTube remotely.

**Step 3: Remove selection rendering**

From each queue row:

- remove the `is-next` class branch;
- remove `aria-pressed={nextItemPosition === item.position}` from **Play next**;
- keep its `aria-label`, title, click handler, and icon unchanged.

**Step 4: Remove obsolete CSS**

Delete:

```css
.youtube-session-queue li.is-next .queue-item-content {
  border-color: var(--accent);
  background: rgb(var(--accent-rgb) / 12%);
}
```

Do not change `.is-queue-tags-revealed` or the fixed row geometry.

**Step 5: Verify GREEN**

Run the Task 1 component command.

Expected: PASS; the row moves correctly and renders as an ordinary row immediately afterward.

---

### Task 3: Enforce Mutually Exclusive Initial and Endgame Persistence

**Objective:** Guarantee that no stable queue entry can belong to both classification sets.

**Files:**
- Modify: `apps/web/src/features/music/music-preferences.ts:26-58`
- Modify: `apps/web/src/features/music/music-preferences.test.ts:109-235`
- Modify: `apps/web/src/App.tsx:442-456`
- Modify: `apps/web/src/App.test.tsx:1275-1310`

**Step 1: Write hydration RED**

Add a preference test with overlapping saved keys:

```ts
initialStageEntryKeys: ["shared:0", "initial-only:1"]
endgameEntryKeys: ["shared:0", "endgame-only:2"]
```

Expected hydrated result:

```ts
initialStageEntryKeys: ["initial-only:1"]
endgameEntryKeys: ["shared:0", "endgame-only:2"]
```

This documents the one-time Endgame-wins repair for ambiguous legacy data.

**Step 2: Implement disjoint hydration**

In `sanitizeMusicPreferences`, sanitize Endgame first, build an Endgame `Set`, and filter matching keys from sanitized Initial keys before returning the envelope. Preserve ordering, deduplication, and the existing 500-key bounds.

**Step 3: Write atomic update RED**

Extend the App music-preference test to exercise the same entry key:

1. Mark `video-a:0` Initial.
2. Mark `video-a:0` Endgame.
3. Assert storage contains it only in Endgame.
4. Mark it Initial again.
5. Assert storage contains it only in Initial.
6. Toggle Initial off.
7. Assert it appears in neither set.

The test should observe the persisted club-scoped envelope, not only mock callback calls.

**Step 4: Enforce exclusivity in `changeQueueTags`**

Keep the existing single-field callback API, but make each application update remove overlaps from the opposite set in the same functional state update:

```ts
if (field === "initialStageEntryKeys") {
  next.initialStageEntryKeys = entryKeys;
  next.endgameEntryKeys = current.endgameEntryKeys.filter((key) => !entryKeys.includes(key));
}
```

Apply the symmetric rule for Endgame. Write localStorage once from the resulting complete envelope.

**Step 5: Verify GREEN**

Run:

```bash
npm run test -w @mafia/web -- \
  src/features/music/music-preferences.test.ts \
  src/App.test.tsx \
  -t "exclusive|Initial and Endgame"
```

Expected: all targeted persistence and migration tests pass.

---

### Task 4: Make Classification Buttons Clearly Pressed

**Objective:** Give the swipe actions unambiguous active states while preserving accessibility.

**Files:**
- Modify: `apps/web/src/features/music/YouTubePlaylistPlayer.tsx:620-651`
- Modify: `apps/web/src/features/music/YouTubePlaylistPlayer.test.tsx`
- Modify: `apps/web/src/styles/app.css:2154-2171`

**Step 1: Add semantic button classes**

Retain `aria-pressed` and add stable class names:

```tsx
className="queue-tag-action is-initial"
className="queue-tag-action is-endgame"
```

Do not infer classification from button order in TypeScript tests.

**Step 2: Write pressed-state interaction RED**

Use a small controlled test harness or rerender sequence that proves:

- marking Initial sets Initial `aria-pressed="true"` and Endgame false;
- marking Endgame sets Endgame true and Initial false;
- clicking the active Endgame action makes both false;
- action labels switch between `Mark` and `Unmark` consistently.

**Step 3: Implement visibly depressed styles**

Use type-specific active colors and physical pressed cues:

```css
.queue-tag-action[aria-pressed="true"] {
  color: #fff;
  font-weight: 700;
  transform: translateY(1px);
  box-shadow: inset 0 2px 7px rgb(0 0 0 / 45%);
}

.queue-tag-action.is-initial[aria-pressed="true"] {
  background: #168553;
}

.queue-tag-action.is-endgame[aria-pressed="true"] {
  background: #a72b35;
}
```

Give inactive buttons a visible neutral background/border contrast so the active state is not merely a subtle hue change. Keep each action at least 44px high and retain the 54px row contract.

**Step 4: Verify GREEN**

Run:

```bash
npm run test -w @mafia/web -- src/features/music/YouTubePlaylistPlayer.test.tsx
```

Expected: all queue, swipe, pressed-state, fade, duplicate-entry, and player-generation tests pass.

---

### Task 5: Replace Inline Tag Chips with Tiny Corner Dots

**Objective:** Show classification at a glance without consuming title width or increasing row height.

**Files:**
- Modify: `apps/web/src/features/music/YouTubePlaylistPlayer.tsx:598-765`
- Modify: `apps/web/src/features/music/YouTubePlaylistPlayer.test.tsx`
- Modify: `apps/web/src/styles/app.css:2135-2149, 2179-2206`

**Step 1: Write marker RED**

Assert rendered stable rows expose exactly one marker state:

- Initial row: `data-initial-stage="true"`, `data-endgame="false"`;
- Endgame row: `data-initial-stage="false"`, `data-endgame="true"`;
- unclassified row: both false;
- no row renders the old inline `Initial`/`Endgame` chip inside `.queue-item-copy`.

Keep the swipe-tray button text; only the persistent inline labels disappear.

**Step 2: Remove inline chip markup**

Replace:

```tsx
<span className="queue-item-tags">…</span>
```

with no title-adjacent classification text. The existing row data attributes remain the semantic/CSS hooks.

**Step 3: Add tiny top-left dot styles**

Use a 6px overlay on `.queue-item-content`:

```css
.youtube-session-queue li[data-initial-stage="true"] .queue-item-content::before,
.youtube-session-queue li[data-endgame="true"] .queue-item-content::before {
  position: absolute;
  top: 4px;
  left: 4px;
  width: 6px;
  height: 6px;
  content: "";
  border-radius: 50%;
  box-shadow: 0 0 0 1px rgb(0 0 0 / 55%);
}

.youtube-session-queue li[data-initial-stage="true"] .queue-item-content::before {
  background: #35c978;
}

.youtube-session-queue li[data-endgame="true"] .queue-item-content::before {
  background: #e44b55;
}
```

The dot must not alter grid columns, title width, row height, drag hit area, or action-button placement.

**Step 4: Remove obsolete chip CSS**

Delete `.queue-item-tags`, `:empty`, and child-chip rules. Retain `.queue-item-copy` and one-line title ellipsis.

**Step 5: Verify GREEN**

Run the full player test file. Expected: dot semantics pass and every queue row remains fixed-height.

---

### Task 6: Exact WebKit/iPad Interaction and Visual Verification

**Objective:** Prove the combined queue behavior on the same interaction path that exposed the issue.

**Files:**
- Modify: `scripts/verify-ui.mjs`
- Evidence: `/tmp/mafia-dashboard-queue-tags.png`

**Step 1: Extend the existing three-track browser fixture**

At 1366×1024 in WebKit:

1. Expand the queue.
2. Swipe the third row left.
3. Mark it Initial.
4. Assert a 6px green dot appears at the row's top-left.
5. Reopen its tray and assert Initial has `aria-pressed="true"`, a green filled background, bold text, and inset pressed shadow.
6. Mark the same row Endgame.
7. Assert Initial becomes false, Endgame true, and the dot becomes red.
8. Click active Endgame again and assert both classifications/dots clear.
9. Reclassify it Endgame.
10. Click **Play next**.
11. Assert the row moves to index 1, the swipe tray closes, no `is-next` class exists, no Play-next pressed state remains, and the red classification dot stays with the same stable entry.
12. Drag that row elsewhere and assert the red dot follows the entry without any red full-row selection background.

**Step 2: Capture a focused screenshot**

Capture after reopening the tray on an active classification so both the corner dot and unmistakably pressed button are visible:

```text
/tmp/mafia-dashboard-queue-tags.png
```

**Step 3: Run the browser journey**

Run:

```bash
UI_BROWSER=webkit \
UI_VIEWPORT_WIDTH=1366 \
UI_VIEWPORT_HEIGHT=1024 \
APP_URL=http://127.0.0.1:5173 \
npm run verify:ui
```

Expected: PASS with queue order, exclusivity, marker color, pressed styling, tray closure, drag identity, player node identity, and non-scrolling pane geometry all verified.

**Step 4: Inspect the screenshot**

Confirm visually:

- dots are visible but genuinely tiny;
- green and red are distinguishable on the dark/red queue palette;
- dots do not collide with the six-dot drag handle;
- the active action looks physically pushed, not merely tinted;
- the opposite action is clearly inactive;
- long titles still ellipsize on one line;
- no row grows beyond 54px;
- the moved Play-next row looks ordinary except for its independent classification dot.

---

### Task 7: Focused Final Validation

**Objective:** Close the prototype with accurate evidence and no unrelated work.

**Files:**
- Verify only; no additional feature files expected.

**Step 1: Run focused tests**

```bash
npm run test -w @mafia/web -- \
  src/features/music/music-preferences.test.ts \
  src/features/music/YouTubePlaylistPlayer.test.tsx \
  src/features/music/MusicDock.test.tsx \
  src/App.test.tsx
```

Expected: all focused tests pass.

**Step 2: Run TypeScript verification**

```bash
npm run typecheck -w @mafia/web
```

Expected: PASS.

**Step 3: Check patch integrity and live availability**

```bash
git diff --check
curl -ksS -o /dev/null -w '%{http_code}\n' https://mbp16.tail102fab.ts.net
```

Expected: no whitespace errors and HTTP 200.

**Step 4: Report prototype state**

Report:

- removal of the redundant `nextItemPosition` artifact;
- exclusive Initial/Endgame behavior and legacy overlap precedence;
- green/red corner dots;
- pressed-button computed styles;
- focused test and WebKit results;
- live URL;
- dirty/uncommitted worktree.

Do not run broad CI, commit, or push until the user accepts the interaction and visual treatment.

---

## Files Likely to Change

- `apps/web/src/features/music/YouTubePlaylistPlayer.tsx`
  - Remove persistent Play-next selection state.
  - Remove inline tag chips.
  - Add semantic classification-button classes.
- `apps/web/src/features/music/YouTubePlaylistPlayer.test.tsx`
  - Play-next normal-style regression.
  - Exclusive classification and marker assertions.
- `apps/web/src/features/music/music-preferences.ts`
  - Repair overlapping persisted classification sets.
- `apps/web/src/features/music/music-preferences.test.ts`
  - Endgame-wins legacy overlap test.
- `apps/web/src/App.tsx`
  - Atomic disjoint tag-set persistence update.
- `apps/web/src/App.test.tsx`
  - Last-classification-action-wins storage regression.
- `apps/web/src/styles/app.css`
  - Remove `.is-next` styling and inline chip styles.
  - Add tiny green/red dots and visibly depressed button states.
- `scripts/verify-ui.mjs`
  - Exact WebKit queue-order/classification/drag visual probe.

## Risks and Tradeoffs

- Removing `nextItemPosition` also removes the pressed state from **Play next**. This is intentional: physical queue position is the authoritative feedback.
- Two separate tag arrays remain for compatibility with existing Night/Role-giveaway selectors. Replacing them with a new enum/map would create unnecessary migration and API surface for this prototype.
- Writing one tag set without filtering the opposite set would allow overlap to return through any caller; exclusivity belongs in the App persistence update, not only the player button handler.
- Existing dual-tag records have no action timestamps, so no true “last action” can be reconstructed. Endgame-wins is a deterministic repair rule only for those legacy overlaps; all future user interactions use actual last-action-wins semantics.
- The row data attributes should never both render true. Keep an Endgame-wins defensive display rule until hydrated state converges, so HMR or stale in-memory state cannot show two dots/buttons as active.
- Red is already used in queue/action surfaces. The dot needs a bright red and one-pixel dark halo to remain legible without resembling a full-row warning.
- Classification dots must follow stable entry identity through drag and shuffle; never key them by current array index.
- The current worktree includes the previous one-playlist/global-pane prototype and right-pane refinements. Implementation must build on it without resetting unrelated dirty files.

## Open Questions

None required. This plan interprets “either Endgame or Initial” as mutually exclusive with an allowed unclassified state, preserves the normal Play-next/Play-now controls, and removes only the redundant persistent red Play-next selection.