# Unified Side Panel, Stage Playlists, and Málaga Glass Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Unify Timer, Voting order, and the persistent music player in one correctly spaced right-side panel with swipe controls; remember each playlist and queue order; hot-swap stage-specific playlists; and add a Málaga-derived liquid-glass theme with safe Dev tuning controls.

**Architecture:** `App` will remain the lifetime owner of the music iframe and will render one always-mounted `LiveSidePanel`; phase-owned Timer/Voting presentation will be extracted from `GameScreen` into that shell so the music player never remounts. Club-scoped browser preferences will retain the last playlist, per-playlist queue order, and Day/Voting/Night playlist mappings without polluting semantic game history. A small `GlassSurface` adapter will use `@hashintel/refractive` only where true refraction is supported and will deliberately render a Málaga-styled CSS fallback on iPad Safari.

**Tech Stack:** React 19.2, TypeScript 6, Vitest + Testing Library, YouTube IFrame API, browser `localStorage`, CSS grid/flex and touch/pointer gestures, Playwright Chromium/WebKit, `@hashintel/refractive` 0.0.4.

---

## Confirmed interpretation and constraints

1. **“Player” means the persistent music player.** The screenshot shows Timer and Voting in `GameScreen` while the music player is independently fixed by `App`; there is no separate current-player module in the rail.
2. **Canonical iPad geometry remains authoritative.** At 1366×1024, keep the main card at x=14 / width=918, use a 14px gutter, and place the unified rail at x=946 / width=406 / right margin=14. The current `7px` gutter and `413px` rail are the inconsistency to remove.
3. **One outer container owns all three surfaces.** Timer, Voting, and Music are 100%-width children of one rounded rail shell. The compact music player uses `margin-top: auto` so its lower edge stays pinned to the panel bottom.
4. **Music iframe persistence is non-negotiable.** View changes, phase changes, panel hide/show, compact/expanded presentation, and playlist changes must not remount the YouTube iframe except an explicit Reload action or a documented fallback recovery.
5. **Swipe gestures are progressive enhancement.** Keep accessible tap controls. Use a dedicated gesture handle so queue scrolling, queue reordering, timer buttons, and voting-list interactions cannot trigger panel gestures accidentally.
6. **Gesture contract:** swipe up on the music handle expands; swipe down collapses. Swipe right on Timer/Voting handles hides that section; the resulting labeled restore chip can be tapped or swiped left to restore. Use a dominant-axis threshold of 44 CSS px.
7. **Hidden Timer/Voting state is session-local UI state.** Do not put it in game events, server sessions, or localStorage.
8. **Playlist memory is club-scoped and browser-local.** Existing active-game `playlistId` metadata remains server-backed; queue ordering and stage mappings remain presentation preferences in localStorage. If cross-device queue synchronization is later required, that is separate server work.
9. **Stage playlist groups are `day`, `voting`, and `night`.** Setup/portal/finished screens keep the current playlist. Voting includes voting and car-crash voting phases; Night includes Mafia planning, Sheriff wake, and all `night-*` phases.
10. **Hot swap preserves intent.** A playing player switches via `loadPlaylist`; a paused/cued player switches via `cuePlaylist` and does not auto-play. Active fades are cancelled before switching.
11. **Queue memory stores stable source-entry keys, not array indexes.** Use `videoId + source position` so duplicate videos can be ordered independently; removed entries disappear and newly fetched entries append in provider order.
12. **Málaga Glass is a third theme**, alongside Midnight and Málaga gold, and inherits Málaga typography/colors before replacing elevated surfaces with translucent treatments.
13. **True refraction is not available on the primary iPad Safari path.** HASH documents `backdrop-filter` with SVG filters as Chrome-only. Safari must receive an intentional blur/gradient fallback with the same dimensions and contrast.
14. **Use the beta library sparingly.** HASH states each refractive component creates an uncached client-side `<Filter>`. Wrap a bounded set of large shells, never every seat, button, queue row, or repeated list item.
15. **`@hashintel/refractive` overrides inline `backdropFilter` and `borderRadius`.** `GlassSurface` is the single owner of these values on true-refraction surfaces; component CSS owns fallback styling.
16. **`bezelWidth < radius`.** Clamp loaded and edited settings accordingly before passing them to the library.
17. **Fast-prototype worktree rules remain active.** The repository already has accepted, uncommitted work. Do not reset, commit, push, or reformat unrelated files. Replace the generic plan skill’s per-task commits with focused tests and `git diff --check`; commit only after explicit acceptance.

## Source-backed package findings

- npm package page: [`@hashintel/refractive` 0.0.4](https://www.npmjs.com/package/@hashintel/refractive) — React HOC, zero runtime dependencies, React/ReactDOM 19 peers, SVG filters applied through `backdrop-filter`.
- Official HASH documentation: [Refractive](https://hash.dev/docs/libs/refractive) — early beta; true refraction is currently Chrome-only; recommends Gaussian blur/solid-gradient fallbacks and a user preference control.
- Official source: [`hoc/refractive.tsx`](https://github.com/hashintel/hash/blob/main/libs/%40hashintel/refractive/src/hoc/refractive.tsx) — public fields are `radius`, `blur`, `glassThickness`, `bezelWidth`, `refractiveIndex`, `specularOpacity`, `specularAngle`, and optional `bezelHeightFn`; defaults include thickness 70 and refractive index 1.5.
- The source confirms ResizeObserver measurement and one Filter per wrapped surface, so the plan deliberately limits simultaneous refractive surfaces.

## Current code map

- Timer/Voting rail ownership: `apps/web/src/features/game/GameScreen.tsx:664-703`
- Music lifetime/presentation ownership: `apps/web/src/App.tsx:1805+`, `apps/web/src/features/music/MusicDock.tsx`
- Current split geometry: `apps/web/src/styles/app.css:2418-2425,2580-2646`
  - `--layout-gutter: 7px`
  - `--right-panel-width: 413px`
  - fixed compact music dock independent of `.utility-rail`
- Queue load/reorder/apply logic: `apps/web/src/features/music/YouTubePlaylistPlayer.tsx:88-301`
- Queue UI and drag handles: `apps/web/src/features/music/YouTubePlaylistPlayer.tsx:340-508`
- Existing playlist metadata persistence: `apps/web/src/App.tsx:260-266,366,639-688`; `apps/web/src/session-outbox.ts`; `apps/web/src/api/client.ts:94-123`
- Playlist account picker: `apps/web/src/features/music/AccountPlaylistPicker.tsx`
- Theme model: `apps/web/src/theme.ts`; theme cycle in `ClubPortal.tsx:7-10,156-190` and `App.tsx:1319-1320,1505-1507`
- Theme tokens: `apps/web/src/styles/app.css:3-72`; portal tokens in `apps/web/src/styles/clubs.css`
- Deterministic iPad verifier: `scripts/verify-ui.mjs`

---

### Task 1: Record the dirty baseline and install the exact refractive dependency

**Objective:** Preserve the existing accepted work and add only the package version researched above.

**Files:**
- Modify during execution: `apps/web/package.json`
- Modify during execution: `package-lock.json`
- Read only first: all files in the current code map

**Step 1: Record the worktree without changing it**

Run:

```bash
git status --short --branch
git diff --check
```

Expected: branch remains `main...origin/main`, existing modified/untracked work remains present, and `git diff --check` exits 0.

**Step 2: Run the existing focused baseline**

```bash
npm run test -w @mafia/web -- \
  src/App.test.tsx \
  src/features/game/GameScreen.test.tsx \
  src/features/music/YouTubePlaylistPlayer.test.tsx \
  src/features/music/AccountPlaylistPicker.test.tsx \
  src/theme.test.ts
```

Expected: PASS before new assertions.

**Step 3: Install the pinned beta**

```bash
npm install -w @mafia/web @hashintel/refractive@0.0.4
```

Expected: `apps/web/package.json` contains exact `0.0.4`; lockfile records the HASH package; no unrelated dependency upgrades.

**Step 4: Verify package compatibility**

```bash
npm run typecheck -w @mafia/web
npm run build -w @mafia/web
```

Expected: React 19 peer constraints resolve and both commands pass.

**Step 5: Checkpoint**

Run `git diff --check`. Do not commit.

---

### Task 2: Extract a pure Game utility-panel component

**Objective:** Make Timer and Voting renderable by the App-owned persistent rail without changing their behavior.

**Files:**
- Create: `apps/web/src/features/game/GameUtilityPanels.tsx`
- Create: `apps/web/src/features/game/GameUtilityPanels.test.tsx`
- Modify: `apps/web/src/features/game/GameScreen.tsx:110-133,664-703`
- Modify: `apps/web/src/features/game/GameScreen.test.tsx`

**Step 1: Write a RED component test**

Create the wished-for component contract:

```tsx
render(
  <GameUtilityPanels
    game={gameWithNominations}
    timerHidden={false}
    votingHidden={false}
    onTimerHiddenChange={vi.fn()}
    onVotingHiddenChange={vi.fn()}
  />,
);

expect(screen.getByRole("region", { name: "Timer controls" })).toBeInTheDocument();
expect(screen.getByRole("region", { name: "Voting order" })).toHaveTextContent(
  "#1 Player 4",
);
```

Also prove voting totals appear only in voting/car-crash voting phases and the nominations retain candidate/nominator copy.

**Step 2: Run RED**

```bash
npm run test -w @mafia/web -- src/features/game/GameUtilityPanels.test.tsx
```

Expected: FAIL because the component does not exist.

**Step 3: Implement the minimal extraction**

Move the current rail derivation/markup into the new component. Keep `TimerControls` unchanged and preserve exact nomination semantics. Recommended contract:

```ts
interface GameUtilityPanelsProps {
  readonly game: GameState;
  readonly timerHidden: boolean;
  readonly votingHidden: boolean;
  readonly onTimerHiddenChange: (hidden: boolean) => void;
  readonly onVotingHiddenChange: (hidden: boolean) => void;
}
```

At this task, render ordinary sections only; gesture behavior arrives later.

**Step 4: Remove duplicate ownership**

Delete `.utility-rail` from `GameScreen`. `GameScreen` must render only `.table-workspace` inside `.live-layout`. Keep all gameplay table logic unchanged.

**Step 5: Run GREEN**

```bash
npm run test -w @mafia/web -- \
  src/features/game/GameUtilityPanels.test.tsx \
  src/features/game/GameScreen.test.tsx
```

Expected: PASS and no Timer/Voting duplicate appears in `GameScreen` tests.

**Step 6: Checkpoint**

Run `git diff --check`. Do not commit.

---

### Task 3: Create one always-mounted LiveSidePanel and correct the canonical gutter

**Objective:** Timer, Voting, and Music share one 406px shell; music stays mounted and pinned to the bottom; table-to-panel gap is exactly 14px.

**Files:**
- Create: `apps/web/src/features/game/LiveSidePanel.tsx`
- Create: `apps/web/src/features/game/LiveSidePanel.test.tsx`
- Modify: `apps/web/src/App.tsx:360-371,1323+,1805+`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/features/music/MusicDock.tsx`
- Modify: `apps/web/src/features/music/MusicDock.test.tsx` if absent/create it
- Modify: `apps/web/src/styles/app.css:1737-1803,1944-1975,2418-2425,2580-2646`

**Step 1: Write RED lifetime/structure tests**

In `App.test.tsx`, retain the existing YouTube mount counter and assert one mount while moving Game → Players → Game and compact → expanded.

In `LiveSidePanel.test.tsx`:

```tsx
const player = <div data-testid="persistent-player" />;
render(<LiveSidePanel game={game}>{player}</LiveSidePanel>);

const rail = screen.getByRole("complementary", { name: "Live game controls" });
expect(within(rail).getByRole("region", { name: "Timer controls" })).toBeInTheDocument();
expect(within(rail).getByRole("region", { name: "Voting order" })).toBeInTheDocument();
expect(within(rail).getByTestId("persistent-player")).toBeInTheDocument();
```

Assert Music is the last child and that no utility panels render when `game={null}` while the music child remains mounted.

**Step 2: Run RED**

```bash
npm run test -w @mafia/web -- \
  src/features/game/LiveSidePanel.test.tsx \
  src/App.test.tsx -t "music|side panel"
```

Expected: FAIL because the shell does not exist and the music dock is independently fixed.

**Step 3: Implement the permanent App-owned shell**

Recommended shape:

```tsx
<LiveSidePanel
  game={view === "game" && previewGame === null ? game : null}
  hidden={view !== "game" || previewGame !== null}
>
  <MusicDock ...>
    <YouTubePlaylistPlayer ... />
  </MusicDock>
</LiveSidePanel>
```

`LiveSidePanel` itself remains mounted. Conditional rendering may add/remove Timer/Voting, but the `children` subtree must remain at the same React position.

**Step 4: Replace split positioning with one shell**

At desktop/iPad geometry:

```css
.app-shell {
  --layout-gutter: 14px;
  --right-panel-width: 406px;
}
.live-side-panel {
  position: fixed;
  top: var(--main-card-top);
  right: 14px;
  bottom: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: var(--right-panel-width);
  min-height: 0;
  padding: 12px;
  overflow: hidden;
}
.live-side-panel > * {
  width: 100%;
}
.live-side-panel .music-dock {
  position: static;
  width: 100%;
  margin-top: auto;
}
```

Use one outer border/background/radius. Remove duplicate child borders/radii where they make the shell look like three unrelated cards; retain dividers and internal padding.

**Step 5: Preserve compact/expanded behavior inside the shell**

- Compact music: intrinsic height, `margin-top: auto`.
- Expanded music: `flex: 1 1 auto; min-height: 0`; queue owns internal scrolling.
- Remove the old `top: calc(... + 265px)` fixed-position workaround.
- In setup/non-live mode, keep the music dock’s existing standalone bottom-right presentation.

**Step 6: Run GREEN**

```bash
npm run test -w @mafia/web -- \
  src/features/game/LiveSidePanel.test.tsx \
  src/features/game/GameUtilityPanels.test.tsx \
  src/features/music/MusicDock.test.tsx \
  src/App.test.tsx
```

Expected: PASS; player mount count remains one.

**Step 7: Checkpoint**

Run `git diff --check`. Do not commit.

---

### Task 4: Add shared dominant-axis swipe classification

**Objective:** Provide deterministic, conflict-resistant gesture recognition for expand/collapse and hide/restore.

**Files:**
- Create: `apps/web/src/features/game/panel-swipe.ts`
- Create: `apps/web/src/features/game/panel-swipe.test.ts`

**Step 1: Write RED pure tests**

Wished-for API:

```ts
classifyPanelSwipe(
  { x: 20, y: 100 },
  { x: 24, y: 40 },
  44,
); // "up"
```

Cover:

- up/down/left/right over threshold;
- exactly under threshold → `null`;
- diagonal movement where no axis dominates by at least 1.25 → `null`;
- vertical movement with small horizontal drift;
- horizontal movement with small vertical drift.

**Step 2: Run RED**

```bash
npm run test -w @mafia/web -- src/features/game/panel-swipe.test.ts
```

Expected: FAIL because the classifier does not exist.

**Step 3: Implement the minimal classifier**

```ts
export type PanelSwipe = "up" | "down" | "left" | "right";

export const classifyPanelSwipe = (
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
  threshold = 44,
): PanelSwipe | null => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < threshold) return null;
  if (Math.abs(dx) > Math.abs(dy) * 1.25) return dx > 0 ? "right" : "left";
  if (Math.abs(dy) > Math.abs(dx) * 1.25) return dy > 0 ? "down" : "up";
  return null;
};
```

**Step 4: Run GREEN**

Run the Task 4 test command. Expected: PASS.

**Step 5: Checkpoint**

Run `git diff --check`. Do not commit.

---

### Task 5: Add swipe expansion and section hide/restore without dead ends

**Objective:** Music expands upward/collapses downward; Timer/Voting dismiss right and restore left/tap, without stealing gestures from controls or the queue.

**Files:**
- Modify: `apps/web/src/features/game/LiveSidePanel.tsx`
- Modify: `apps/web/src/features/game/LiveSidePanel.test.tsx`
- Modify: `apps/web/src/features/game/GameUtilityPanels.tsx`
- Modify: `apps/web/src/features/game/GameUtilityPanels.test.tsx`
- Modify: `apps/web/src/features/music/MusicDock.tsx`
- Modify: `apps/web/src/features/music/MusicDock.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles/app.css`

**Step 1: Write music gesture RED**

On a dedicated `Music player panel handle`:

```tsx
fireEvent.touchStart(handle, { touches: [{ clientX: 10, clientY: 100 }] });
fireEvent.touchEnd(handle, { changedTouches: [{ clientX: 12, clientY: 40 }] });
expect(onExpandedChange).toHaveBeenCalledWith(true);
```

Repeat downward while expanded and expect `false`. Assert sub-threshold and horizontal gestures do nothing. Keep the existing Expand/Collapse button and test it separately.

**Step 2: Write Timer/Voting hide RED**

Swipe right on each section handle and assert:

- full section disappears;
- labeled `Show timer` / `Show voting` restore chips remain;
- music player remains last/pinned;
- tapping the chip restores;
- swiping left on the chip restores;
- swipe state does not mutate `GameState` or emit an event.

**Step 3: Run RED**

```bash
npm run test -w @mafia/web -- \
  src/features/game/LiveSidePanel.test.tsx \
  src/features/game/GameUtilityPanels.test.tsx \
  src/features/music/MusicDock.test.tsx
```

Expected: FAIL because gesture handles/states do not exist.

**Step 4: Implement dedicated handles**

- Add an explicit grip/label to each section.
- Bind touch start/end only to the handle.
- Do not bind vertical swipe to `.youtube-session-queue`, queue rows, drag handles, iframe, inputs, links, or playback buttons.
- Set gesture-handle `touch-action` narrowly; keep queue `touch-action` and scrolling behavior intact.
- Provide normal buttons with `aria-expanded`/`aria-controls` for keyboard and assistive users.

**Step 5: Run GREEN**

Run the Task 5 command. Expected: PASS.

**Step 6: Checkpoint**

Run `git diff --check`. Do not commit.

---

### Task 6: Add club-scoped music preference parsing and queue reconciliation

**Objective:** Safely retain the last playlist, each playlist’s exact queue order, and stage mappings across reloads.

**Files:**
- Create: `apps/web/src/features/music/music-preferences.ts`
- Create: `apps/web/src/features/music/music-preferences.test.ts`

**Step 1: Write RED storage tests**

Define:

```ts
export type MusicStage = "day" | "voting" | "night";

export interface MusicPreferencesV1 {
  readonly version: 1;
  readonly lastPlaylistId: string;
  readonly queueOrderByPlaylist: Readonly<Record<string, readonly string[]>>;
  readonly stagePlaylistIds: Readonly<Partial<Record<MusicStage, string>>>;
}
```

Test:

- missing/corrupt/unknown-version JSON returns defaults;
- key is club-scoped: `mafia-dashboard.music-preferences.v1.<clubId>`;
- malformed values and oversized arrays are bounded/ignored;
- write/read round trip;
- no secrets or player/game state are accepted into this shape.

**Step 2: Write RED queue-order reconciliation tests**

Use an entry key that preserves duplicates:

```ts
queueEntryKey({ videoId: "abc", position: 4 }); // "abc:4"
```

Given saved `[C, A]` and remote `[A, B, C, D]`, expect `[C, A, B, D]`. Also prove:

- saved deleted entries are dropped;
- new remote entries append in provider order;
- duplicate videos at different source positions remain distinct;
- duplicate saved keys are used once.

**Step 3: Run RED**

```bash
npm run test -w @mafia/web -- src/features/music/music-preferences.test.ts
```

Expected: FAIL because the module does not exist.

**Step 4: Implement minimal bounded parsing**

Keep this module pure. Expose `readMusicPreferences`, `writeMusicPreferences`, `queueEntryKey`, and `restoreQueueOrder`. Cap remembered entries per playlist to a reasonable provider-bound size (for example 500).

**Step 5: Run GREEN**

Run the Task 6 command. Expected: PASS.

**Step 6: Checkpoint**

Run `git diff --check`. Do not commit.

---

### Task 7: Restore queue order and hot-swap playlists without remounting the iframe

**Objective:** The last playlist and queue order are applied on load, while playlist changes use the existing player instance whenever metadata is available.

**Files:**
- Modify: `apps/web/src/features/music/YouTubePlaylistPlayer.tsx:74-301`
- Modify: `apps/web/src/features/music/YouTubePlaylistPlayer.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`

**Step 1: Add new player props in RED tests**

```ts
interface YouTubePlaylistPlayerProps {
  // existing props...
  readonly rememberedQueueOrder?: readonly string[];
  readonly onQueueOrderChange?: (
    playlistId: string,
    orderedEntryKeys: readonly string[],
  ) => void;
}
```

Mock remote items and prove the first `cuePlaylist` uses remembered order, including duplicates by source position.

**Step 2: Add queue-change RED tests**

After drag reorder and Play Next, assert `onQueueOrderChange` receives the resulting stable keys. Play Now must not emit an order change.

**Step 3: Add hot-swap RED tests**

Render playlist A, capture one fake YT player, then rerender with playlist B:

- Player constructor remains called once.
- If state was CUED/paused, B uses `cuePlaylist` and `playVideo` is not called.
- If state was PLAYING, B uses `loadPlaylist`.
- Active fade is cancelled.
- Queue selection resets to the start of B.
- A late queue response cannot overwrite B (deferred-promise latest-request-wins regression).
- Explicit Reload remains the only normal remount path.

**Step 4: Run RED**

```bash
npm run test -w @mafia/web -- src/features/music/YouTubePlaylistPlayer.test.tsx
```

Expected: semantic failures: remembered order is ignored and playlist prop changes recreate the player.

**Step 5: Separate one-time iframe construction from queue application**

Refactor into distinct effects:

1. one player/API construction effect keyed only by explicit reload instance;
2. one latest-request-wins metadata load keyed by playlist ID;
3. one queue-application effect that cues/loads the current player.

For metadata-unavailable fallback, retain a documented recovery path that rebuilds with provider `listType/list` only when necessary; do not use that fallback for successful account playlist loads.

**Step 6: Persist order through App**

- Read the club preference once per `ClubWorkspace` mount.
- Active/resumed session playlist wins when present; otherwise use remembered last playlist, then environment default.
- Manual or automatic playlist changes update `lastPlaylistId`.
- Queue callbacks update only that playlist’s order.
- `Clear game state` does not erase music preferences; `Clear all data` does through the existing localStorage clear.

**Step 7: Run GREEN**

```bash
npm run test -w @mafia/web -- \
  src/features/music/music-preferences.test.ts \
  src/features/music/YouTubePlaylistPlayer.test.tsx \
  src/App.test.tsx -t "playlist|music"
```

Expected: PASS; player mount counter remains one.

**Step 8: Checkpoint**

Run `git diff --check`. Do not commit.

---

### Task 8: Map canonical phases to Day/Voting/Night playlists

**Objective:** Configure three stage playlists and switch automatically on meaningful phase transitions without writing gameplay events.

**Files:**
- Create: `apps/web/src/features/music/music-stage.ts`
- Create: `apps/web/src/features/music/music-stage.test.ts`
- Modify: `apps/web/src/features/music/AccountPlaylistPicker.tsx`
- Modify: `apps/web/src/features/music/AccountPlaylistPicker.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`

**Step 1: Write RED phase classification tests**

Create `musicStageForPhase(phase)` and exhaustively classify every `GamePhase`:

```ts
expect(musicStageForPhase("day")).toBe("day");
expect(musicStageForPhase("voting")).toBe("voting");
expect(musicStageForPhase("car-crash-result")).toBe("voting");
expect(musicStageForPhase("night-mafia")).toBe("night");
expect(musicStageForPhase("mafia-planning")).toBe("night");
expect(musicStageForPhase("finished")).toBeNull();
```

Keep the mapping pure and independent from event persistence.

**Step 2: Run RED**

```bash
npm run test -w @mafia/web -- src/features/music/music-stage.test.ts
```

Expected: FAIL because the mapping does not exist.

**Step 3: Implement the exhaustive mapping**

Use a `switch` over the domain phase union so new phases cause a compile/test decision instead of silently inheriting the wrong music.

**Step 4: Add Dev playlist-setting RED**

Extend the existing account picker to render one options load and these selectors:

- Active playlist
- Day playlist
- Voting playlist
- Night playlist

Each stage allows `Use current playlist`/unset. Test that changing a mapping returns the full updated stage map and does not immediately alter an unrelated active phase.

**Step 5: Run RED**

```bash
npm run test -w @mafia/web -- src/features/music/AccountPlaylistPicker.test.tsx
```

Expected: FAIL because stage selectors do not exist.

**Step 6: Implement App switching**

On canonical `game.phase` changes:

```ts
const stage = musicStageForPhase(game.phase);
const mappedPlaylistId = stage === null ? undefined : preferences.stagePlaylistIds[stage];
if (mappedPlaylistId && mappedPlaylistId !== playlistId) setPlaylistId(mappedPlaylistId);
```

Do not append a game event. Existing session metadata may persist the resulting active playlist, but semantic history remains untouched.

**Step 7: Add transition RED/GREEN coverage**

In `App.test.tsx` prove Day → Voting → Night chooses configured IDs; unmapped phases keep the current ID; re-rendering the same phase does not repeatedly switch/reload.

**Step 8: Run GREEN**

```bash
npm run test -w @mafia/web -- \
  src/features/music/music-stage.test.ts \
  src/features/music/AccountPlaylistPicker.test.tsx \
  src/App.test.tsx -t "stage playlist|hot swap"
```

Expected: PASS.

**Step 9: Checkpoint**

Run `git diff --check`. Do not commit.

---

### Task 9: Add a safe Málaga Glass settings model and support detector

**Objective:** Persist validated effect settings and choose true refraction only where the documented browser support exists.

**Files:**
- Create: `apps/web/src/features/theme/glass-settings.ts`
- Create: `apps/web/src/features/theme/glass-settings.test.ts`
- Create: `apps/web/src/features/theme/refractive-support.ts`
- Create: `apps/web/src/features/theme/refractive-support.test.ts`

**Step 1: Write RED settings tests**

Recommended applied settings:

```ts
export interface GlassSettings {
  readonly enabled: boolean;
  readonly blur: number;
  readonly glassThickness: number;
  readonly bezelWidth: number;
  readonly refractiveIndex: number;
  readonly specularOpacity: number;
  readonly specularAngle: number;
  readonly fallbackOpacity: number;
}
```

Defaults:

```ts
{
  enabled: true,
  blur: 4,
  glassThickness: 70,
  bezelWidth: 10,
  refractiveIndex: 1.5,
  specularOpacity: 0.28,
  specularAngle: 45,
  fallbackOpacity: 0.62,
}
```

Test corrupt JSON, NaN/infinity, min/max clamps, angle normalization, and `bezelWidth < minimumSurfaceRadius`. Storage key is `mafia-dashboard.glass-settings.v1` and contains appearance data only.

**Step 2: Write RED capability tests**

Use injected inputs rather than hard-coding test globals:

```ts
supportsTrueRefraction({
  cssSupportsFilterUrl: true,
  browserBrands: ["Chromium"],
}); // true
```

Safari/WebKit, Firefox, unsupported CSS, disabled settings, and test/jsdom paths return false. The Dev UI must be able to show `True refraction unavailable · using fallback`.

**Step 3: Run RED**

```bash
npm run test -w @mafia/web -- \
  src/features/theme/glass-settings.test.ts \
  src/features/theme/refractive-support.test.ts
```

Expected: FAIL because modules do not exist.

**Step 4: Implement bounded parsing and explicit support policy**

Do not pretend `CSS.supports` alone proves rendered SVG refraction. Combine required CSS support with a Chromium-family brand check, reflecting HASH’s documented limitation. Keep the detector isolated so future package/browser improvements are one-file changes.

**Step 5: Run GREEN**

Run the Task 9 command. Expected: PASS.

**Step 6: Checkpoint**

Run `git diff --check`. Do not commit.

---

### Task 10: Add GlassSurface with Chrome refraction and Safari fallback

**Objective:** Centralize the beta HOC, prevent style conflicts, and keep unsupported browsers visually equivalent.

**Files:**
- Create: `apps/web/src/features/theme/GlassSurface.tsx`
- Create: `apps/web/src/features/theme/GlassSurface.test.tsx`
- Optionally create: `apps/web/src/features/theme/GlassSettingsContext.tsx` if context is cleaner than prop drilling
- Modify: `apps/web/src/styles/app.css`

**Step 1: Write RED mode tests**

Inject capability in tests and assert:

- Midnight/Málaga plain themes render a normal wrapper.
- Málaga Glass + supported + enabled renders through `refractive` with exact settings.
- Málaga Glass + Safari/unsupported renders `.is-glass-fallback` and no SVG Filter.
- Disabled setting renders fallback/opaque appearance.
- Radius passed to the package also owns rendered border radius.

Mock `@hashintel/refractive` rather than depending on SVG/image calculation in jsdom.

**Step 2: Run RED**

```bash
npm run test -w @mafia/web -- src/features/theme/GlassSurface.test.tsx
```

Expected: FAIL because `GlassSurface` does not exist.

**Step 3: Implement the adapter**

The adapter receives semantic class/children, radius, settings, and support mode. It passes only documented fields:

```tsx
refraction={{
  radius,
  blur: settings.blur,
  glassThickness: settings.glassThickness,
  bezelWidth: Math.min(settings.bezelWidth, radius - 1),
  refractiveIndex: settings.refractiveIndex,
  specularOpacity: settings.specularOpacity,
  specularAngle: settings.specularAngle,
}}
```

Do not persist or expose `bezelHeightFn`.

**Step 4: Implement fallback CSS**

Use Málaga-derived translucent gradients, a bounded Gaussian blur, subtle inset edge/specular line, and readable contrast. Keep geometry identical between true/fallback/plain modes. Respect `prefers-reduced-transparency`/effect-disabled settings by increasing opacity and removing blur.

**Step 5: Run GREEN**

Run the Task 10 test command and web typecheck. Expected: PASS.

**Step 6: Checkpoint**

Run `git diff --check`. Do not commit.

---

### Task 11: Add Málaga Glass theme cycling and Dev effect controls

**Objective:** Expose the new style through normal theme selection and provide safe, resettable effect tuning in Dev.

**Files:**
- Modify: `apps/web/src/theme.ts`
- Modify: `apps/web/src/theme.test.ts`
- Modify: `apps/web/src/features/clubs/ClubPortal.tsx:7-10,156-190`
- Modify: `apps/web/src/features/clubs/ClubPortal.test.tsx` if present, otherwise `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/App.tsx:1319-1320,1505-1615,1857+`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/styles/app.css:3-72`
- Modify: `apps/web/src/styles/clubs.css`

**Step 1: Write theme RED**

```ts
expect(readColorTheme({ getItem: () => "malaga-glass" })).toBe("malaga-glass");
```

Cycle must be:

```text
Midnight → Málaga gold → Málaga Glass → Midnight
```

Unknown values still fall back to Midnight.

**Step 2: Run RED**

```bash
npm run test -w @mafia/web -- src/theme.test.ts src/App.test.tsx -t "theme"
```

Expected: FAIL because the theme union/cycle has only two values.

**Step 3: Implement theme tokens**

Add `malaga-glass` to `ColorTheme`, reader, portal theme list, Dev next-theme logic, and `[data-theme="malaga-glass"]` tokens. Inherit Málaga font/accent values; change only surface opacity, border light, shadows, and glass variables.

**Step 4: Write Dev settings RED**

When Málaga Glass is active, Dev shows:

- Effect enabled toggle
- Browser status: True refraction / Fallback
- Blur
- Glass thickness
- Bezel width
- Refractive index
- Specular opacity
- Specular angle
- Fallback opacity
- Reset glass settings

Use labeled range/number inputs with exact min/max/step and current values. Changing settings persists validated values and updates a single preview. The section may remain visible but disabled/explanatory under other themes.

**Step 5: Run RED**

```bash
npm run test -w @mafia/web -- src/App.test.tsx -t "glass settings|Málaga Glass"
```

Expected: FAIL because settings UI/state do not exist.

**Step 6: Implement Dev controls**

Use one `Glass settings` collapsible section, mirroring Music setup. Apply clamping before state/persistence. Include Reset defaults. Avoid CSS-variable-only control of SVG properties because HASH documents that CSS variables do not currently control the Filter.

**Step 7: Run GREEN**

```bash
npm run test -w @mafia/web -- \
  src/theme.test.ts \
  src/features/theme/glass-settings.test.ts \
  src/features/theme/GlassSurface.test.tsx \
  src/App.test.tsx -t "theme|glass"
```

Expected: PASS.

**Step 8: Checkpoint**

Run `git diff --check`. Do not commit.

---

### Task 12: Apply glass to a bounded set of major surfaces

**Objective:** Make Málaga Glass feel coherent without generating dozens of uncached filters or hurting iPad readability.

**Files:**
- Modify: `apps/web/src/features/game/LiveSidePanel.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/features/setup/SetupWizard.tsx`
- Modify: `apps/web/src/features/players/PlayersScreen.tsx`
- Modify: `apps/web/src/features/timeline/GameTimelineScreen.tsx`
- Modify: `apps/web/src/features/console/ErrorConsoleScreen.tsx`
- Modify: `apps/web/src/styles/app.css`
- Modify: `apps/web/src/styles/timeline.css`
- Modify: `apps/web/src/styles/clubs.css`
- Update focused component tests only where semantic wrappers change

**Step 1: Establish the bounded surface list**

Apply `GlassSurface` to no more than these concurrently visible elevated shells:

1. unified live side panel (one filter, not one per child);
2. active App drawer (Log or Dev);
3. setup/player primary card;
4. Timeline header/editor/inspector only when shown;
5. Console header/content only when shown.

Do **not** wrap table seats, Timer buttons, voting entries, queue rows, every club card, or repeated player cards.

**Step 2: Add semantic RED assertions**

Component tests should find `.glass-surface` only under Málaga Glass context and should retain original landmarks (`aside`, `main`, labels, headings). Assert no extra filters for repeated seat/list items.

**Step 3: Run RED**

Run the affected component tests. Expected: FAIL because surfaces are not wrapped.

**Step 4: Apply adapters with unchanged geometry**

Keep existing classes on the outer geometry owner. Because the HOC overrides border radius/backdrop filter, remove competing inline styles and keep dimensions/padding/gaps in CSS.

**Step 5: Run GREEN**

```bash
npm run test -w @mafia/web -- \
  src/features/game/LiveSidePanel.test.tsx \
  src/features/setup/SetupWizard.test.tsx \
  src/features/players/PlayersScreen.test.tsx \
  src/features/timeline/GameTimelineScreen.test.tsx \
  src/features/console/ErrorConsoleScreen.test.tsx \
  src/App.test.tsx
```

Expected: PASS.

**Step 6: Checkpoint**

Run `git diff --check`. Do not commit.

---

### Task 13: Extend deterministic browser verification for geometry, gestures, memory, hot swap, and browser fallback

**Objective:** Prove real touch geometry/state in Chromium and the canonical iPad Safari fallback in WebKit.

**Files:**
- Modify: `scripts/verify-ui.mjs`
- Rebuild/reload: existing Vite app at `http://127.0.0.1:5173`

**Step 1: Prove canonical rail geometry at 1366×1024**

Measure and require:

```text
main:  x=14, width=918
gap:   14
rail:  x=946, width=406, right=1352
margin right: 14
```

Timer, Voting, and Music content boxes must have identical left/right/width within 1 CSS px. The compact music bottom must equal the rail bottom within 1px.

**Step 2: Prove hide/restore and music expansion gestures**

With trusted touch dispatch:

- swipe right Timer → restore chip;
- swipe left/tap chip → Timer restored;
- repeat Voting;
- swipe up music handle → expanded queue fills only available rail height;
- swipe down → compact at bottom;
- queue scrolling/reorder gesture does not collapse player;
- no document scroll or table overlap occurs in any state.

**Step 3: Prove playlist order memory**

1. choose playlist A;
2. reorder queue including duplicate-video fixtures;
3. reload page;
4. assert A is selected and cue order matches saved order;
5. change provider fixture to remove one item/add one item;
6. reload and assert removed dropped/new appended.

Inspect localStorage for only the bounded preference schema, never credentials/player/game payloads.

**Step 4: Prove hot swap**

Configure Day=A, Voting=B, Night=C. Transition phases through real controls and capture YT fake calls:

- one player constructor/mount;
- paused transition uses cue;
- playing transition uses load;
- exact mapped IDs/order;
- stale A metadata response cannot replace B/C;
- no semantic log entry is emitted for playlist changes.

**Step 5: Prove Málaga Glass in Chromium**

Use the new theme and require:

- bounded SVG filter count equals intended visible `GlassSurface` count;
- computed true surface backdrop includes `url(#...)`;
- no seat/list row owns a filter;
- Dev settings update computed/refraction attributes and clamp bezel below radius;
- rail/table geometry remains identical.

**Step 6: Prove iPad Safari fallback in WebKit**

Run:

```bash
UI_BROWSER=webkit APP_URL=http://127.0.0.1:5173 UI_HEADER_ONLY=1 npm run verify:ui
```

Require:

- status says Fallback, not True refraction;
- no SVG filter is instantiated for glass surfaces;
- CSS blur/gradient/opacity fallback renders;
- text contrast and all canonical geometry pass;
- gesture behavior remains functional.

**Step 7: Capture evidence**

Save compact rail, expanded rail, hidden Timer/Voting, Chrome glass, and WebKit fallback screenshots. Include geometry, mount count, queue order, stage swaps, support mode, filter count, and paths in verifier JSON.

**Step 8: Checkpoint**

```bash
node --check scripts/verify-ui.mjs
git diff --check
```

Expected: both exit 0. Do not commit.

---

### Task 14: Run focused gates and hand off the uncommitted prototype

**Objective:** Verify the changed UI/music/theme paths and preserve the live authenticated/Tailscale development route.

**Files:**
- Verify all Task 1-13 files
- Update this plan only if implementation discovers a corrected requirement

**Step 1: Run focused web suites**

```bash
npm run test -w @mafia/web -- \
  src/features/game/panel-swipe.test.ts \
  src/features/game/GameUtilityPanels.test.tsx \
  src/features/game/LiveSidePanel.test.tsx \
  src/features/game/GameScreen.test.tsx \
  src/features/music/music-preferences.test.ts \
  src/features/music/music-stage.test.ts \
  src/features/music/MusicDock.test.tsx \
  src/features/music/YouTubePlaylistPlayer.test.tsx \
  src/features/music/AccountPlaylistPicker.test.tsx \
  src/features/theme/glass-settings.test.ts \
  src/features/theme/refractive-support.test.ts \
  src/features/theme/GlassSurface.test.tsx \
  src/theme.test.ts \
  src/App.test.tsx
```

Expected: PASS.

**Step 2: Run complete web and relevant persistence suites**

```bash
npm run test -w @mafia/web
npm run test -w @mafia/server -- \
  src/game-session-validation.test.ts \
  src/game-session-store.test.ts \
  src/app.test.ts
```

Expected: PASS; playlist changes remain metadata/preferences, not semantic game events.

**Step 3: Run type/build gates**

```bash
npm run typecheck
npm run build
npm run lint
npm run format:check
```

Expected: all exit 0. Do not run `npm run format` over the dirty worktree.

**Step 4: Run both browser paths**

```bash
APP_URL=http://127.0.0.1:5173 UI_HEADER_ONLY=1 npm run verify:ui
UI_BROWSER=webkit APP_URL=http://127.0.0.1:5173 UI_HEADER_ONLY=1 npm run verify:ui
```

Expected: Chromium true-refraction PASS and WebKit fallback PASS.

**Step 5: Verify private live access**

- Confirm Vite still proxies API calls to `http://127.0.0.1:8080`.
- Confirm `https://mbp16.tail102fab.ts.net/` returns 200 and matches the local frontend bytes.
- Confirm `/health/ready` returns ready.
- Do not alter Tailscale Serve or authentication.

**Step 6: Review scope and hand off**

```bash
git diff --check
git status --short --branch
```

Report exact tests/browser evidence, package/browser limitation, live URLs, and screenshots. Explicitly state changes remain uncommitted. Defer commit/push until Michael accepts the visual and gesture behavior.

---

## Files likely to change

| File | Planned change |
|---|---|
| `apps/web/package.json`, `package-lock.json` | Pin `@hashintel/refractive` 0.0.4. |
| `apps/web/src/features/game/GameUtilityPanels.tsx` | Extract Timer/Voting presentation. |
| `apps/web/src/features/game/LiveSidePanel.tsx` | One persistent rail shell with hidden-state ownership. |
| `apps/web/src/features/game/panel-swipe.ts` | Pure dominant-axis gesture classifier. |
| `apps/web/src/features/game/GameScreen.tsx` | Remove split utility-rail ownership. |
| `apps/web/src/features/music/MusicDock.tsx` | Rail integration and music swipe handle. |
| `apps/web/src/features/music/music-preferences.ts` | Club-scoped last playlist/order/stage preferences. |
| `apps/web/src/features/music/music-stage.ts` | Exhaustive phase → Day/Voting/Night mapping. |
| `apps/web/src/features/music/YouTubePlaylistPlayer.tsx` | Restore queue order and hot-swap without normal remounts. |
| `apps/web/src/features/music/AccountPlaylistPicker.tsx` | Active and stage playlist selectors. |
| `apps/web/src/features/theme/glass-settings.ts` | Validated persisted effect settings. |
| `apps/web/src/features/theme/refractive-support.ts` | Explicit Chrome true-refraction policy. |
| `apps/web/src/features/theme/GlassSurface.tsx` | HASH HOC adapter plus fallback. |
| `apps/web/src/theme.ts` | Third `malaga-glass` theme. |
| `apps/web/src/App.tsx` | Persistent side panel, music preferences/stage switching, theme/Dev controls. |
| `apps/web/src/styles/app.css` | 14px gutter, 406px rail, unified panel, gestures, glass/fallback. |
| `apps/web/src/styles/clubs.css`, `timeline.css` | Málaga Glass surface variants. |
| `scripts/verify-ui.mjs` | Geometry, gesture, memory, hot-swap, Chromium/WebKit evidence. |
| Corresponding `*.test.ts(x)` files | Strict RED/GREEN regressions for every behavior. |

## Files intentionally not changed

- `packages/game-domain/**` — playlist/stage selection is presentation state, not game rules or semantic history.
- Server schemas/routes — queue order and stage mappings remain club-scoped browser preferences in this plan.
- Canonical event persistence/replay — music swaps do not create events or checkpoints.
- Authentication/Tailscale configuration — unchanged.
- Existing player-seat swipe Red interaction — new rail gestures are handle-scoped and must not interfere.

## Risks and tradeoffs

1. **Primary-device limitation:** iPad Safari cannot render HASH’s current true SVG refraction. The fallback can look glass-like, but it is not the same optical displacement effect. This must be communicated honestly in Dev status and acceptance evidence.
2. **Beta/performance:** each supported `GlassSurface` computes an uncached client-side filter. Excess wrappers or rapid slider changes can hurt Chrome performance; keep surfaces bounded and monitor filter count.
3. **Gesture conflicts:** full-surface swipe listeners would break queue scrolling/reordering and control taps. Dedicated handles and dominant-axis thresholds are mandatory.
4. **Music hot-swap complexity:** current code recreates the player when `playlistId` changes. Separating construction from queue application must preserve explicit Reload, readiness, fade cancellation, and unavailable-metadata fallback.
5. **Autoplay policy:** a paused player must remain paused after a stage switch. Continuing only when already playing avoids violating browser expectations.
6. **Browser-local memory:** queue order does not roam to another iPad/browser. Server synchronization would require a separate multiclient product decision and validation/migration work.
7. **Remote playlist drift:** stored queue keys can become stale. Reconciliation must drop missing entries and append new provider entries rather than failing or restoring invalid IDs.
8. **Duplicate videos:** video ID alone is insufficient; source position is required to identify duplicate playlist entries.
9. **Dirty worktree:** shared files already contain accepted uncommitted work. Every patch must be surgical and verified against current contents.

## Open questions before implementation

- This plan assumes swipe **right** hides Timer/Voting and swipe **left** (or tap) restores them. If a different direction is preferred, change Task 5 before execution.
- This plan maps exactly three music stages: Day, Voting, Night. Setup and Finished keep the current playlist. Additional mappings should be named before implementation rather than inferred later.
- Queue memory is browser-local. If it must follow the club across multiple devices, choose a server-backed club preference contract before Task 6.
- The iPad will receive the designed Málaga glass fallback because true `@hashintel/refractive` output is Chrome-only. If true optical refraction on iPad is a hard acceptance criterion, this library cannot currently satisfy it and an alternative rendering approach must be evaluated first.
