# One Playlist and Persistent Game Pane Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Simplify Mafia Dashboard to one remembered playlist with independently marked Role-giveaway and Endgame tracks, surface a rules-accurate Critical state, prefer Endgame music after a critical Night, automate planning and Night-exit fade-then-shuffle behavior, keep compact queue rows and familiar grip controls, display the complete right pane unchanged everywhere inside Game mode, and extend Málaga Glass across the full screen.

**Architecture:** `App` remains the lifetime owner of one YouTube iframe, one selected playlist, and one always-mounted `LiveSidePanel`. Browser preferences retain only the current playlist’s queue order plus stable Role-giveaway and Endgame track keys; `YouTubePlaylistPlayer` owns the two-tag swipe tray and exposes commands for fade-in, the first regular track, and a persisted queue shuffle that can prioritize Endgame items. A shared pure `isCriticalState(game)` helper drives both the top-right pill and critical Night-exit shuffle policy, while canonical live Night exits await the required fade and then shuffle exactly once.

**Tech Stack:** React 19.2, TypeScript 6, Vitest + Testing Library, YouTube IFrame API, browser `localStorage`, CSS grid/overflow/ellipsis, touch gestures, Playwright WebKit at the canonical 1366×1024 iPad viewport.

---

## Product contract

1. **One playlist only.** Dev renders one `YouTube Music playlist` selector or one manual playlist-ID field. Remove Initial/Day/Voting/Night playlist mappings and all phase-based playlist swaps.
2. **One remembered queue only.** Persist the selected playlist ID, its current application queue order, and its Initial/Endgame tag sets. Selecting a different playlist clears the previous order and tags instead of retaining parallel per-playlist records.
3. **Tags do not create or mutate a playlist.** Tagged entries remain ordinary rows in the application-owned queue and never modify YouTube.
4. **Role giveaway stays host-controlled.** Entering Role giveaway does not autoplay or filter the queue. Marking identifies intro tracks only.
5. **Mafia-planning transition.** When `Begin Mafia planning stage` is pressed and music is playing, jump once to the first queue item—using the restored/reordered current order—that is not marked Initial.
6. **Planning no-op cases.** Paused/loading/error music, unavailable queue metadata, or an all-marked queue causes no jump. With no marks, queue index 0 is the first regular track.
7. **Planning jump is not Play now.** It preserves current audible volume and does not add a fade. Manual queue `Play now` still starts silently and fades in over 2 seconds.
8. **Two independent queue tags.** Every queue entry can be marked `Initial`, `Endgame`, both, or neither. Endgame is also described as Critical/Endgame in accessible copy; it does not create another playlist.
9. **Swipe marking tray.** Swipe a queue row left to reveal two trailing toggle actions: `Initial` and `Endgame`; swipe right to close. Only one row is open. Drag, Play next, Play now, and vertical scrolling cannot reveal it.
10. **Stable identity.** Both tag sets use `queueEntryKey(videoId + source position)`, so duplicate videos remain independently markable and reordering preserves tags.
11. **Marked feedback.** Compact `Initial` and `Endgame` indicators plus accessible pressed/state metadata remain after the tray closes, without adding a second line. Both indicators may coexist.
12. **Fixed queue geometry.** Every queue row has one fixed single-line height. Long titles use ellipsis and never increase row height, including while the two-action tray is revealed.
13. **Critical rule.** A non-finished daytime/day-entry state is Critical when active Citizens equal active Mafia plus one and at least one Mafia remains. One additional Citizen death would then make `black >= red`, matching the domain victory rule.
14. **Critical phases.** Evaluate the pill during `best-move`, day-entry `goodbye-speech`, Day, Voting, and car-crash phases. Do not display it in setup, Mafia planning, Sheriff wake, any Night phase, or finished state.
15. **Critical privacy.** Hide the pill whenever `privacyHidden` is true so the mask does not leak team-balance information. Preview mode derives the pill from the displayed preview game only.
16. **Critical pill placement.** Render a `Critical` pill directly under the Citizens/Mafia counter group in the table workspace’s top-right corner without moving the table or changing card geometry.
17. **Manual Play now fade.** Set volume to zero before `playVideoAt(index)`, then ramp to the remembered non-zero native player volume over 2 seconds. Never leak a full-volume transient.
18. **Night-exit fades.** `night-resolution → best-move` uses Quick fade (500ms). `night-resolution → day` and `night-resolution → goodbye-speech` with `goodbyeNext: "day"` use Slow fade (3 seconds).
19. **Shuffle after every Night.** Every supported canonical exit from `night-resolution` shuffles the complete current application queue exactly once and persists the shuffled order. Both tag sets remain attached to stable entries.
20. **Critical shuffle priority.** If the resulting day-entry state is Critical and Endgame items exist, shuffle Endgame entries among themselves at the front, shuffle all remaining entries after them, and cue the first Endgame item at 0 seconds without autoplay. If no Endgame items exist, use the ordinary shuffle policy.
21. **Non-critical continuity.** Ordinary shuffles preserve the current item and playback seconds; every shuffle clears one-shot Play-next state. Critical preferred shuffles deliberately cue the first Endgame item instead of preserving a non-Endgame current item.
22. **Fade before shuffle.** If music is playing, await the destination-specific fade and then shuffle/re-cue while paused; if music is already paused, shuffle immediately. A fade failure must not suppress the shuffle.
23. **Queue edge cases.** Unavailable metadata or fewer than two items is a safe no-op. A Critical queue with only one Endgame item still puts/cues that item first when at least two total rows exist.
24. **Transition guard.** Automatic fade/shuffle work runs once per canonical live Night exit. It does not fire on initial mount, internal Night phases, preview navigation, or paused-game resume.
25. **No app volume settings.** Remove percentage buttons, Low/High inputs, preset state, and related props. Keep low-level `setVolume/getVolume` solely for fades.
26. **No redundant expansion row.** Remove the in-player `Expand player and queue` / `Collapse player` button and the empty action wrapper. Retain the MusicDock grip as the sole compact/expanded queue control.
27. **One grip for utilities.** One upper grip hides/shows Timer and Voting together. It uses the same visible grip markup/style as the lower player-queue grip; no visible `Show timer` text. Its `aria-label` changes between `Hide timer and voting` and `Show timer and voting`.
28. **Timer remains mounted.** Hiding utilities uses a hidden wrapper rather than conditional unmounting, so an active countdown continues.
29. **Full right pane everywhere in Game mode.** Whenever `view === "game"`, render the same Timer/Voting/Music pane with the same geometry/style on:
    - initial player setup;
    - Available players;
    - Role giveaway;
    - Mafia planning and Sheriff wake;
    - every Day, Voting, car-crash, Goodbye, Best move, and Night phase;
    - finished state;
    - in-game log/history preview.
30. **Only non-Game views hide it.** Players, Timeline, and Console hide—but do not unmount—the pane. Returning to Game restores the same nodes and state.
31. **No-game presentation.** Setup, Available players, and Role giveaway show Timer plus `No nominations yet`; never fabricate a `GameState`.
32. **Preview presentation.** During in-game preview, Voting uses `previewGame ?? game`; Timer and Music remain live global utilities. Critical pill presentation uses the preview game, while fades, shuffles, planning jumps, persistence, and semantic mutations continue using canonical live `game` only.
33. **Pane continuity.** The Timer node/countdown, utilities collapsed state, player compact/expanded state, queue order/tags, and exact iframe node survive all transitions inside Game mode.
34. **Player appearance.** Inside the pane, override only music-card position/size. Preserve the standalone compact player’s background, border, radius, shadow, and opacity.
35. **Málaga Glass full viewport.** Expand the decorative `.app-shell::before` layer from the current 448px right strip to `inset: 0`, including fullscreen/safe-area edges, while keeping it pointer-inert and behind controls.
36. **Canonical geometry.** At 1366×1024 keep main x=14/width=918, 14px gutter, pane x=946/width=406, and 14px right margin. The document never scrolls; queue overflow is internal.
37. **Rapid prototype mode.** Use focused RED/GREEN tests plus one WebKit/iPad browser journey, leave work uncommitted, and skip CI, broad reviews, and full gates until Michael asks to finalize.

## Current code map

- App music preferences/stage switching: `apps/web/src/App.tsx:324-450`
- Setup→live boundary and pane visibility: `apps/web/src/App.tsx:1878-2030`
- App music/lifetime harness: `apps/web/src/App.test.tsx`; current player mock starts at `App.test.tsx:342`
- Queue/player implementation: `apps/web/src/features/music/YouTubePlaylistPlayer.tsx:12-29, 98-236, 353-481, 483-657`
- Queue/player regressions: `apps/web/src/features/music/YouTubePlaylistPlayer.test.tsx`
- Fade engine: `apps/web/src/features/music/music-controller.ts`, `music-controller.test.ts`
- Current V1 multi-playlist envelope and provider-drift-safe queue restoration: `apps/web/src/features/music/music-preferences.ts`
- Obsolete stage policy: `apps/web/src/features/music/music-stage.ts`, `music-stage.test.ts`
- Playlist setup and disconnect callback: `apps/web/src/features/music/AccountPlaylistPicker.tsx`
- Player queue grip and post-swipe click suppression: `apps/web/src/features/music/MusicDock.tsx:30-73`
- Utility contents, mounted hidden panels, and post-swipe click suppression: `apps/web/src/features/game/GameUtilityPanels.tsx`
- Pane state/lifetime and glass-wrapper persistence: `apps/web/src/features/game/LiveSidePanel.tsx`, `LiveSidePanel.test.tsx`, `LiveSidePanel.persistence.test.tsx`
- Team counters/Critical insertion point: `apps/web/src/features/game/GameScreen.tsx:117-122, 463-474`; CSS at `app.css:1792-1815`
- Role giveaway completion: `apps/web/src/features/setup/SetupWizard.tsx:420-425`; App callback at `App.tsx:1927-1958`
- Night completion outputs: `packages/game-domain/src/night-actions.ts:258-296` (read only)
- Swipe-reveal example: active sessions in `apps/web/src/App.tsx` and `.session-swipe-content` in `apps/web/src/styles/app.css`
- Queue/player styles: `apps/web/src/styles/app.css:2084-2269`; pane overrides at `2820-2906`
- Málaga right-strip pseudo-layer: `apps/web/src/styles/app.css:242-267`
- Browser journey: `scripts/verify-ui.mjs`

## Re-verification baseline after cleanup

- Audited commit: `9bd9f08` (`[verified] feat: refine gameplay timeline, controls, and music`), synchronized with `origin/main`.
- Git state at re-verification: no staged or tracked modifications; only this plan is untracked.
- Focused baseline command in Task 1 passed: **13 test files / 186 tests**.
- `npm run typecheck -w @mafia/web` passed.
- Verdict: **PLAN_IMPLEMENT**. None of the requested one-playlist/two-tag/Critical/automatic-shuffle changes are already implemented.
- Cleanup introduced or finalized invariants that implementation must preserve:
  1. `restoreQueueOrder` first matches exact stable keys, then falls back by `videoId` when provider source positions drift.
  2. The player separates provider queue data from applied remembered order and re-applies changed saved order without remounting the iframe.
  3. Player generations prevent stale callbacks from a destroyed/reloaded iframe instance.
  4. Explicit Reload remains the intentional remount path.
  5. `MusicDock` and current utility handles suppress the synthetic click generated after a qualifying swipe.
  6. A running Timer remains mounted while an existing utility section is hidden.
  7. Account disconnect clears App-owned playlist state through `onAccountDisconnected`.
  8. True/fallback glass changes do not remount the persistent player.

---

### Task 1: Lock the verified clean baseline and establish focused RED

**Objective:** Start from the verified clean `9bd9f08` baseline, preserve the cleanup invariants above, and encode the complete revised behavior before production edits.

**Files:**
- Test all affected `*.test.ts(x)` files listed in the code map
- Do not modify production code in this task

**Step 1: Capture the exact current state**

```bash
git status --short --branch
git diff --check
```

Expected before implementation: `main...origin/main`, no staged/tracked changes, and this plan as the only untracked file. If the worktree differs, stop and re-read affected files before patching; never reset unrelated work.

**Step 2: Run the current focused baseline**

```bash
npm run test -w @mafia/web -- \
  src/features/music/music-controller.test.ts \
  src/features/music/YouTubePlaylistPlayer.test.tsx \
  src/features/music/AccountPlaylistPicker.test.tsx \
  src/features/music/music-preferences.test.ts \
  src/features/music/music-stage.test.ts \
  src/features/game/GameScreen.test.tsx \
  src/features/game/GameUtilityPanels.test.tsx \
  src/features/game/LiveSidePanel.test.tsx \
  src/features/game/LiveSidePanel.persistence.test.tsx \
  src/features/music/MusicDock.test.tsx \
  src/features/timer/TimerControls.test.tsx \
  src/App.test.tsx
```

Expected at the audited baseline: **13 files / 186 tests PASS**.

**Step 3: Run baseline typecheck**

```bash
npm run typecheck -w @mafia/web
```

Expected: PASS.

**Step 4: Add RED surface assertions**

Require one playlist control; no volume/action row; one-line queue titles; a swipe tray with independent Initial/Endgame toggles; rules-accurate Critical pill behavior; grip-only utility control; complete pane on all Game-mode fixtures; and hidden-but-mounted pane outside Game mode.

**Step 5: Add RED transition assertions**

Extend the mocked player handle with:

```ts
playFirstRegularTrack: vi.fn(() => true),
quickFadeOut: vi.fn(),
slowFadeOut: vi.fn(),
shuffleQueue: vi.fn((_options?: { readonly preferEndgame?: boolean }) => true),
```

Require playing-only Role giveaway → Mafia planning selection and the exact Quick/Slow Night-exit matrix. Every recognized Night exit must call `shuffleQueue` once: after the fade promise settles while playing, immediately while paused, and never for preview/internal-Night/non-transition renders. The options must be `{ preferEndgame: true }` exactly when `isCriticalState(next)` is true.

**Step 6: Verify semantic RED**

Run the Task 1 command again. Failures must come from missing revised behavior, not broken imports, invalid mocks, or stale generated files.

**Step 7: Verify cleanup regressions alongside semantic RED**

Existing tests must continue proving provider-position fallback, saved-order reapplication, stale-player generation guards, explicit-reload remounting, post-swipe click suppression, Timer mount continuity, disconnect clearing, and glass/player lifetime. Do not accept a new RED caused by deleting or weakening those cleanup guarantees.

**Step 8: Checkpoint**

Run `git diff --check`. Do not commit.

---

### Task 2: Remove volume modes and redundant player markup

**Objective:** Delete app-owned volume settings and the expansion action row while preserving native-volume fade capability.

**Files:**
- Modify: `apps/web/src/App.tsx`, `App.test.tsx`
- Modify: `apps/web/src/features/setup/SetupWizard.tsx`, `SetupWizard.test.tsx`
- Modify: `apps/web/src/features/music/YouTubePlaylistPlayer.tsx`, `YouTubePlaylistPlayer.test.tsx`
- Modify: `apps/web/src/styles/app.css`
- Modify: `scripts/verify-ui.mjs`

**Step 1: Remove App state and Dev UI**

Delete `musicVolumePresets`, `activeMusicVolume`, all setters/callbacks, and the `Volume modes` fieldset. Retain Music status, Reload, and one playlist picker.

**Step 2: Remove obsolete SetupWizard props**

Delete unused `musicPlaying`, `musicStatus`, `playlistId`, `onPlaylistIdChange`, `volumePresets`, and `onVolumePresetsChange` props and update fixtures/mocks.

**Step 3: Simplify player props**

Delete `onExpandedChange`, `volumePresets`, `activeVolume`, and `onVolumeChange`. Keep `expanded`, queue persistence, and forthcoming tag callbacks. Stop forcing volume on iframe readiness.

Replace the removed App-owned target with player-local native-volume tracking:

- on iframe readiness and whenever playback reports `PLAYING`, read `getVolume()` and remember it when it is greater than zero;
- `fadeIn()` and manual Play now target that last non-zero native value;
- never expose this value as an App setting or persist it;
- preserve `MusicController.fadeOut`, which pauses and restores the captured native volume after the fade.

This keeps fades functional without recreating a hidden Low/High setting.

**Step 4: Delete the entire player action row**

Remove `.youtube-player-actions`, percentage buttons, expansion button, and their CSS. Expanded grids become `video / queue`, not `video / actions / queue`, across desktop and tablet rules.

**Step 5: GREEN**

```bash
npm run test -w @mafia/web -- \
  src/features/setup/SetupWizard.test.tsx \
  src/features/music/YouTubePlaylistPlayer.test.tsx \
  src/App.test.tsx -t "music player setup|music player|volume"
```

Expected: PASS; no volume settings/action wrapper, native-volume fade targets still work, and expansion still works through the already swipe-safe MusicDock grip.

**Step 6: Checkpoint**

Run `git diff --check`. Do not commit.

---

### Task 3: Collapse preferences and setup to one playlist

**Objective:** Replace stage mappings/per-playlist history with one bounded playlist/order/two-tag envelope.

**Files:**
- Modify: `apps/web/src/features/music/music-preferences.ts`, `music-preferences.test.ts`
- Delete: `apps/web/src/features/music/music-stage.ts`, `music-stage.test.ts`
- Modify: `apps/web/src/features/music/AccountPlaylistPicker.tsx`, `AccountPlaylistPicker.test.tsx`
- Modify: `apps/web/src/App.tsx`, `App.test.tsx`

**Step 1: Define the wished-for V1 shape**

```ts
export interface MusicPreferencesV1 {
  readonly version: 1;
  readonly lastPlaylistId: string;
  readonly queueOrder: readonly string[];
  readonly initialStageEntryKeys: readonly string[];
  readonly endgameEntryKeys: readonly string[];
}
```

Cap all three arrays at 500 valid strings and de-duplicate each while preserving order. Initial and Endgame sets are independent; the same stable key may exist in both.

**Step 2: Migrate current V1 bytes**

- Keep valid `lastPlaylistId`.
- Migrate only `queueOrderByPlaylist[lastPlaylistId]` into `queueOrder`; discard old playlist orders.
- If `lastPlaylistId` is empty, recover one legacy stage ID in deterministic order `initial → day → night → voting`.
- Initialize `initialStageEntryKeys: []` and `endgameEntryKeys: []`.
- Write only the new five-field shape; drop `stagePlaylistIds`.
- Preserve the cleanup reader’s malformed-value bounds and `restoreQueueOrder` behavior: exact stable-key matches first, then one-use `videoId` fallback for source-position drift, then append truly new provider entries.

**Step 3: Reset metadata when playlist changes**

```ts
export const selectRememberedPlaylist = (
  current: MusicPreferencesV1,
  playlistId: string,
): MusicPreferencesV1 =>
  playlistId === current.lastPlaylistId
    ? current
    : {
        version: 1,
        lastPlaylistId: playlistId,
        queueOrder: [],
        initialStageEntryKeys: [],
        endgameEntryKeys: [],
      };
```

**Step 4: Render one account field**

Connected mode has one `YouTube Music playlist` select. Manual mode has one `YouTube Music playlist ID` input. Preserve the cleaned `onAccountDisconnected` contract; disconnect selects `""` through the reset helper so playlist, order, Initial tags, and Endgame tags clear atomically.

**Step 5: Remove runtime stage switching**

Delete `musicStageForPhase` imports/effects and stage callbacks. Active/resumed session playlist wins when present; otherwise use `lastPlaylistId`, then the existing default.

Only apply browser order/tags when they belong to the active playlist:

```ts
const rememberedMusicMatchesActivePlaylist =
  musicPreferences.lastPlaylistId === playlistId;

const rememberedQueueOrder =
  rememberedMusicMatchesActivePlaylist ? musicPreferences.queueOrder : [];
const initialStageEntryKeys =
  rememberedMusicMatchesActivePlaylist ? musicPreferences.initialStageEntryKeys : [];
const endgameEntryKeys =
  rememberedMusicMatchesActivePlaylist ? musicPreferences.endgameEntryKeys : [];
```

A resumed server session with a different playlist must never inherit stale order/tags from the browser’s one remembered playlist. Manual selection adopts the new ID and resets metadata.

**Step 6: Preserve queue reapplication and iframe lifetime**

Keep the current provider queue cache, applied remembered-order ref, equality guard, and player-generation guard. Changing `queueOrder`, Initial tags, or Endgame tags must not reconstruct the iframe; only an explicit Reload increments the instance key. Tag-only changes must not re-cue the player at all.

**Step 7: Delete obsolete stage modules**

Remove `music-stage.ts` and its test after all references are gone.

**Step 8: GREEN**

```bash
npm run test -w @mafia/web -- \
  src/features/music/music-preferences.test.ts \
  src/features/music/AccountPlaylistPicker.test.tsx \
  src/App.test.tsx -t "playlist|queue order|music settings"
```

Expected: PASS; one playlist/order/two-tag set survives, switching/disconnecting IDs clears order/tags, mismatched resumed-session IDs receive no stale metadata, provider-position fallback still works, tag-only updates do not re-cue/remount, and no stage swap remains.

**Step 9: Checkpoint**

Run `git diff --check`. Do not commit.

---

### Task 4: Add swipe-to-mark Initial and Endgame tracks with fixed-height rows

**Objective:** Mark/unmark two independent track types from one swipe tray without gesture conflicts or vertical growth.

**Files:**
- Modify: `apps/web/src/features/music/YouTubePlaylistPlayer.tsx`, `YouTubePlaylistPlayer.test.tsx`
- Modify: `apps/web/src/App.tsx`, `App.test.tsx`
- Reuse: `apps/web/src/features/game/panel-swipe.ts`
- Modify: `apps/web/src/styles/app.css`
- Modify: `scripts/verify-ui.mjs`

**Step 1: Add player props**

```ts
readonly initialStageEntryKeys?: readonly string[];
readonly onInitialStageEntryKeysChange?: (
  playlistId: string,
  entryKeys: readonly string[],
) => void;
readonly endgameEntryKeys?: readonly string[];
readonly onEndgameEntryKeysChange?: (
  playlistId: string,
  entryKeys: readonly string[],
) => void;
```

**Step 2: Track one revealed stable key**

Use `revealedTagEntryKey: string | null`, clearing it on playlist change, collapse, missing row, or another reveal.

**Step 3: Protect horizontal gestures**

Bind touch start/end to row content, ignore `.queue-drag-handle`, `.queue-item-actions`, and the trailing action tray, classify with `classifyPanelSwipe`, and keep `touch-action: pan-y`. Left opens, right closes; vertical/diagonal/sub-threshold gestures do nothing.

Reuse the cleanup’s proven post-swipe click-suppression contract: a qualifying swipe sets a one-shot suppression ref, and `onClickCapture` prevents/stops the synthetic click before it can activate the just-revealed Initial/Endgame button. Clear suppression after consuming that click or starting a new touch.

**Step 4: Use a two-toggle reveal-behind-content tray**

```tsx
<li
  data-initial-stage={initialMarked}
  data-endgame={endgameMarked}
  className={revealed ? "is-queue-tags-revealed" : ""}
>
  <div className="queue-tag-actions" role="group" aria-label={`Track types for ${item.title}`}>
    <button
      type="button"
      aria-label={`${initialMarked ? "Unmark" : "Mark"} ${item.title} for Role giveaway`}
      aria-pressed={initialMarked}
    >
      Initial
    </button>
    <button
      type="button"
      aria-label={`${endgameMarked ? "Unmark" : "Mark"} ${item.title} for Critical endgame`}
      aria-pressed={endgameMarked}
    >
      Endgame
    </button>
  </div>
  <div className="queue-item-content">...</div>
</li>
```

Each toggle updates only its own set. Close after a toggle and expose the tray through `:focus-within` for keyboard use. A track may carry both tags.

**Step 5: Persist both stable tag sets**

Toggle `queueEntryKey(item)` in the corresponding array without changing queue order. Reorder/Play next/Play now preserve both tags.

**Step 6: Lock row height and truncate**

Move grid to `.queue-item-content`, set one fixed border-box row/content/action height (the existing one-line visual height, approximately 54px), and apply:

```css
.queue-item-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

Keep `Initial` and `Endgame` indicators on the same line. If both are set, both remain visible by truncating the title further—not by increasing height.

**Step 7: Regressions**

Cover long versus short equal heights, Initial-only/Endgame-only/both/neither, duplicate source positions, reorder persistence, independent toggle behavior, drag/button exclusion, vertical scroll, one-open-row behavior, playlist-change reset, and proof that the synthetic post-swipe click marks neither tag.

**Step 8: GREEN**

```bash
npm run test -w @mafia/web -- \
  src/features/game/panel-swipe.test.ts \
  src/features/music/music-preferences.test.ts \
  src/features/music/YouTubePlaylistPlayer.test.tsx \
  src/App.test.tsx -t "initial|endgame|queue order|playlist"
```

Expected: PASS.

**Step 9: Checkpoint**

Run `git diff --check`. Do not commit.

---

### Task 5: Fade manual Play now and advance past intro tracks

**Objective:** Preserve silent-before-start manual playback and add the playing-only Role giveaway → planning jump.

**Files:**
- Modify: `apps/web/src/features/music/music-controller.ts`, `music-controller.test.ts`
- Modify: `apps/web/src/features/music/YouTubePlaylistPlayer.tsx`, `YouTubePlaylistPlayer.test.tsx`
- Modify: `apps/web/src/App.tsx`, `App.test.tsx`

**Step 1: Add an optional fade starter**

Extend `fadeIn` with:

```ts
readonly startPlayback?: () => void | Promise<void>;
```

After `setVolume(0)`, call `startPlayback?.() ?? player.play()`, then use existing generation-safe ramp/cancellation.

**Step 2: Remember native audible volume**

Read `getVolume()` on readiness and immediately before app fades; retain only finite values `(0, 100]` in a last-audible ref. Never force a readiness volume.

**Step 3: Route Play now through the fade engine**

```ts
void controller.fadeIn({
  durationMs: 2_000,
  targetVolume: rememberAudibleVolume(player),
  startPlayback: () => player.playVideoAt(index),
});
```

Test zero-before-play operation order, final target, cancellation, and no queue/mark mutation.

**Step 4: Add the imperative regular-track command**

```ts
playFirstRegularTrack(): boolean;
```

Require ready rich queue, find the first current-order item not in `initialStageEntryKeys`, cancel active fade without pausing pending playback, clear Play-next state, call `playVideoAt(index)` at current volume, and return true. No candidate/unavailable returns false.

**Step 5: Call it once at SetupWizard completion**

Inside App’s existing Role giveaway `onComplete` boundary:

```ts
if (musicState === "playing") musicRef.current?.playFirstRegularTrack();
```

Do not call on restore, draw rerenders, paused/loading music, or merely displaying Mafia planning.

**Step 6: GREEN**

```bash
npm run test -w @mafia/web -- \
  src/features/music/music-controller.test.ts \
  src/features/music/YouTubePlaylistPlayer.test.tsx \
  src/App.test.tsx -t "Mafia planning|Play now|regular track"
```

Expected: PASS; manual Play now fades, automatic planning jump uses current volume/order once.

**Step 7: Checkpoint**

Run `git diff --check`. Do not commit.

---

### Task 5A: Define Critical state once and display the top-right pill

**Objective:** Encode the “one Citizen death from a Mafia win” rule as one pure helper shared by GameScreen and Night-exit music policy.

**Files:**
- Create: `apps/web/src/features/game/critical-state.ts`
- Create: `apps/web/src/features/game/critical-state.test.ts`
- Modify: `apps/web/src/features/game/GameScreen.tsx`, `GameScreen.test.tsx`
- Modify: `apps/web/src/styles/app.css:1792-1815`
- Modify: `scripts/verify-ui.mjs`

**Step 1: Write the exact rule and phase-matrix RED**

Create a pure helper:

```ts
export const isCriticalState = (game: GameState): boolean => {
  const activeCitizens = game.players.filter(
    ({ status, team }) => status === "active" && team === "red",
  ).length;
  const activeMafia = game.players.filter(
    ({ status, team }) => status === "active" && team === "black",
  ).length;

  if (activeMafia === 0 || activeCitizens !== activeMafia + 1) return false;

  switch (game.phase) {
    case "best-move":
    case "goodbye-speech":
    case "day":
    case "voting":
    case "voting-cancelled":
    case "car-crash":
    case "car-crash-decision":
    case "car-crash-result":
    case "car-crash-skipped":
      return true;
    default:
      return false;
  }
};
```

Test `4 Citizens / 3 Mafia → true`, `5/3 → false`, `3/3 → false because Mafia has already reached its win threshold`, zero Mafia → false, and statuses other than `active` excluded. Run the count fixture across every `GamePhase`: only the explicit daytime/day-entry phases return true.

**Step 2: Reuse the domain victory invariant rather than inventing a score**

The helper’s `activeCitizens === activeMafia + 1` follows `evaluateVictory`: one Citizen death changes the counts to `activeMafia >= activeCitizens`. Do not add Critical to `GameState`, events, server schemas, replay, or persistence; it is derived presentation/policy state.

**Step 3: Refactor the counter markup safely**

The current `span:first-child` / `span:last-child` color rules would mis-style a third span. Use explicit structure/classes:

```tsx
<div className="team-counts" aria-label={...}>
  <div className="team-count-values">
    <span className="citizen-count">Citizens ...</span>
    <span className="mafia-count">Mafia ...</span>
  </div>
  {isCriticalState(game) && !privacyHidden ? (
    <span className="critical-state-pill" role="status">Critical</span>
  ) : null}
</div>
```

`.team-counts` becomes a right-aligned vertical stack; `.team-count-values` remains the current horizontal pill row. The Critical pill sits directly below, uses a compact warning treatment, stays pointer-inert, and does not change table/card geometry.

**Step 4: Preserve privacy and preview behavior**

When `privacyHidden`, show neither Critical text nor an accessible Critical label. In preview mode, `GameScreen` receives the preview game, so the pill truthfully reflects that displayed state. This presentation must not trigger queue shuffle; App separately evaluates canonical `next` in Task 6.

**Step 5: Component RED/GREEN coverage**

Prove:

- Critical Day renders the pill under the two counters;
- ordinary Day omits it;
- matching counts during Night omit it;
- matching counts during Best move/Goodbye/Voting render it;
- `privacyHidden` omits it while counter values remain `?`;
- preview uses preview counts;
- adding/removing the pill leaves the counter group’s right edge and table box unchanged.

**Step 6: GREEN**

```bash
npm run test -w @mafia/web -- \
  src/features/game/critical-state.test.ts \
  src/features/game/GameScreen.test.tsx
```

Expected: PASS with one shared Critical rule and no domain/persistence changes.

**Step 7: Checkpoint**

Run `git diff --check`. Do not commit.

---

### Task 6: Fade and then shuffle whenever canonical Night ends

**Objective:** Invoke the destination-specific fade, shuffle the complete current queue exactly once after every Night exit, prefer/cue Endgame tracks when the resulting live state is Critical, persist that order, and ignore preview state.

**Files:**
- Modify: `apps/web/src/features/music/music-preferences.ts`, `music-preferences.test.ts`
- Modify: `apps/web/src/features/music/YouTubePlaylistPlayer.tsx`, `YouTubePlaylistPlayer.test.tsx`
- Modify: `apps/web/src/App.tsx`, `App.test.tsx`
- Reuse: `apps/web/src/features/game/critical-state.ts`
- Read only: `packages/game-domain/src/night-actions.ts:258-296`

**Step 1: Add a pure Fisher–Yates helper**

Place a generic queue-order helper beside the existing restore/order utilities:

```ts
export const shuffledQueue = <Entry,>(
  entries: readonly Entry[],
  random: () => number = Math.random,
): readonly Entry[] => {
  const result = [...entries];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
};
```

Test empty, one-item, deterministic three/five-item permutations, source immutability, duplicate video objects, and injected boundary random values. Do not shuffle by sorting on `Math.random()`.

Add a preferred partition helper that remains fully deterministic under injected randomness:

```ts
export const shuffledQueueWithPreferred = <Entry,>(
  entries: readonly Entry[],
  preferred: (entry: Entry) => boolean,
  random: () => number = Math.random,
): readonly Entry[] => [
  ...shuffledQueue(entries.filter(preferred), random),
  ...shuffledQueue(entries.filter((entry) => !preferred(entry)), random),
];
```

Preferred items are guaranteed to occupy the front partition but remain randomized among themselves; the remainder is independently randomized. If no item is preferred, use one ordinary full-queue Fisher–Yates shuffle so random-consumption/behavior does not silently change.

**Step 2: Add an imperative queue shuffle**

Extend `YouTubePlayerHandle`:

```ts
shuffleQueue(options?: { readonly preferEndgame?: boolean }): boolean;
```

Implementation:

1. require rich loaded metadata and at least two queue items;
2. capture `currentPosition()` before changing order;
3. when `preferEndgame` and at least one current item’s stable key is in `endgameEntryKeys`, create a preferred-front shuffle; otherwise create one ordinary shuffle;
4. atomically update the ref and rendered queue state;
5. clear `nextItemPosition` so a stale Play-next override cannot survive;
6. call `onQueueOrderChange` with stable keys so the one remembered order is updated;
7. calculate cue index/seconds: effective Endgame preference uses index 0 / 0 seconds; ordinary shuffle locates the previously current entry in the new order and keeps its seconds;
8. if an iframe exists, force `cuePlaylist(shuffledVideoIds, index, seconds)` through a dedicated queue-cue helper; do **not** reuse `applyPlaylist`/`applyQueue`, whose current playing-state branch can call `loadPlaylist` and autoplay while the asynchronous YouTube pause event is still pending;
9. mark readiness false, cancel obsolete fades, publish `loading`, and let the existing current player generation own subsequent callbacks; if the iframe is not ready yet, the existing readiness path cues `queueRef.current` when it becomes available;
10. return true; unavailable/short queues return false without mutation.

Initial and Endgame tags need no rewrite because stable keys follow their entries. The operation changes only the application queue, never the remote playlist. Direct cueing, rather than trusting a possibly lagging `playbackStateRef`, guarantees that neither path autoplays.

**Step 3: Keep previous canonical live state**

Initialize from `initialDerivedGame` so mount does not look like a transition. Observe `game`, never `previewGame`.

**Step 4: Classify supported exits and fade mode**

```ts
type NightExitFade = "quick" | "slow";

const nightExitFade = (previous: GameState | null, next: GameState | null): NightExitFade | null => {
  if (previous?.phase !== "night-resolution" || next === null) return null;
  if (next.phase === "best-move") return "quick";
  if (next.phase === "day") return "slow";
  if (next.phase === "goodbye-speech" && next.goodbyeNext === "day") return "slow";
  return null;
};
```

Every non-null result means both fade policy and a required shuffle. Evaluate `isCriticalState(next)` from this canonical `next` before launching async work; never derive preference from `previewGame` or from rendered pill presence.

**Step 5: Sequence fade before shuffle**

Update the previous-state ref before starting async work, then run one guarded operation:

```ts
const finishNightMusic = async (fade: NightExitFade, critical: boolean) => {
  try {
    if (musicState === "playing") {
      if (fade === "quick") await musicRef.current?.quickFadeOut();
      else await musicRef.current?.slowFadeOut();
    }
  } catch {
    // MusicController already reports fade errors; Night-exit shuffle is still required.
  } finally {
    musicRef.current?.shuffleQueue({ preferEndgame: critical });
  }
};
```

While playing, fade completion pauses/restores volume before re-cueing the shuffled queue. The YouTube PAUSED event can arrive after the fade promise resolves, so `shuffleQueue` must force the cue path described above instead of consulting the old playing state. While paused, no fade is awaited and shuffle happens immediately. Critical preference is a one-operation policy input; it is not stored as music preference state.

**Step 6: Regressions**

Cover:

- critical Best move: Quick resolves, then `shuffleQueue({ preferEndgame: true })` once;
- critical Day/Goodbye-to-day: Slow resolves, then preferred shuffle once;
- non-critical Best move/Day/Goodbye: correct fade, then `preferEndgame: false` ordinary shuffle;
- paused Critical Night exit: no fade, preferred shuffle once immediately;
- rejected fade: correctly parameterized shuffle still once;
- pending fade: Shuffle not called until settlement;
- internal Night, initial mount, preview entry/exit, and unrelated phase changes: no fade and no Shuffle;
- player-state rerenders after fade: no duplicate Shuffle;
- preferred queue puts all Endgame entries first, shuffles both partitions, persists order, cues the first Endgame at 0, and keeps Initial tags unchanged;
- tracks tagged both Initial and Endgame participate in the Endgame partition;
- no Endgame tags under Critical falls back to ordinary shuffle/current-position preservation;
- ordinary shuffled order is persisted, both tag sets follow stable keys, Play-next clears, current item/time are preserved;
- when the fade promise has resolved but `playbackStateRef` still says `playing`, shuffle calls `cuePlaylist` and never `loadPlaylist`/autoplay;
- a stale callback from the pre-Reload player generation cannot overwrite the newly shuffled queue/readiness state;
- unavailable/one-item queue: safe false/no mutation and no fabricated Critical action.

**Step 7: GREEN**

```bash
npm run test -w @mafia/web -- \
  src/features/music/music-preferences.test.ts \
  src/features/music/YouTubePlaylistPlayer.test.tsx \
  src/App.test.tsx -t "Night.*fade|Night.*shuffle|Best move.*music|preview.*music"
```

Expected: PASS with one persisted post-fade shuffle per canonical Night exit and Endgame-front cueing only for a truly Critical resulting live state.

**Step 8: Checkpoint**

Run `git diff --check`. Do not commit.

---

### Task 7: Keep one unchanged pane everywhere in Game mode

**Objective:** Use one grip-style utility control and make `view === "game"` the sole pane visibility authority.

**Files:**
- Modify: `apps/web/src/features/game/GameUtilityPanels.tsx`, `GameUtilityPanels.test.tsx`
- Modify: `apps/web/src/features/game/LiveSidePanel.tsx`, `LiveSidePanel.test.tsx`, `LiveSidePanel.persistence.test.tsx`
- Modify: `apps/web/src/App.tsx`, `App.test.tsx`
- Modify: `apps/web/src/styles/app.css`
- Modify: `scripts/verify-ui.mjs`

**Step 1: Make utility content nullable**

Remove separate Timer/Voting dismissal wrappers/props. Accept `game: GameState | null`; null renders Timer and `No nominations yet` without fake domain state.

**Step 2: Keep one mounted hidden wrapper**

`LiveSidePanel` owns one `utilitiesHidden` state and always mounts:

```tsx
<div id="game-utility-panels" hidden={utilitiesHidden}>
  <GameUtilityPanels game={game} />
</div>
```

**Step 3: Use the shared grip visual**

```tsx
<button
  type="button"
  className="panel-swipe-handle utility-panels-toggle"
  aria-label={utilitiesHidden ? "Show timer and voting" : "Hide timer and voting"}
  aria-controls="game-utility-panels"
  aria-expanded={!utilitiesHidden}
  onClick={() => setUtilitiesHidden((hidden) => !hidden)}
>
  <span data-testid="panel-grip" aria-hidden="true" />
</button>
```

No visible label or Show-timer chip. The lower identical grip continues controlling the queue.

Preserve the cleanup’s `touchStartRef` / `suppressNextClickRef` behavior on this replacement control. A qualifying swipe or drag over the grip must not be followed by a synthetic click that reverses the requested state; a plain tap toggles exactly once.

**Step 4: Derive pane context solely from workspace view**

```ts
const gameModeActive = view === "game";
const displayedUtilityGame = previewGame ?? game;

<LiveSidePanel
  game={displayedUtilityGame}
  showUtilities={gameModeActive}
  hidden={!gameModeActive}
  ...
>
  <MusicDock hidden={!gameModeActive} ...>
    ...
  </MusicDock>
</LiveSidePanel>
```

Do not condition on setup step, `game`, role-draw state, phase, finished state, or preview state. The pane uses the full `has-live-utilities` composition on every Game-mode surface. Hide it only in Players, Timeline, and Console while preserving mount/state.

**Step 5: Preserve preview/live authority split**

Voting reads `displayedUtilityGame`. Timer/Music remain host utilities. Automatic fades and planning/persistence remain bound to live `game`; preview must never drive them.

**Step 6: Remove obsolete special cases**

Remove App/MusicDock `previewGame !== null` hiding conditions, the unused `.has-timer-rail` class, separate restore-chip CSS, and any player-only Game-mode assumptions. Keep hidden-pane behavior outside Game.

**Step 7: Full parity/lifetime test**

Capture pane, Timer, player dock, and iframe on initial setup. Traverse:

1. Available players;
2. setup return;
3. Role giveaway;
4. Mafia planning;
5. Day/Voting/Night fixtures;
6. finished state;
7. in-game preview and preview exit.

At each point require the same pane structure/classes/geometry and same Timer/player nodes. Null contexts show `No nominations yet`; preview uses preview nominations; exit restores live nominations. Start a timer and prove continuity. Collapse utilities and expand the queue, then prove both states survive transitions. Verify tap toggles once and swipe-generated click suppression cannot reverse the upper or lower grip action.

Switch to Players, Timeline, and Console: require hidden pane with same mounted nodes. Return to Game and require state restoration.

**Step 8: GREEN**

```bash
npm run test -w @mafia/web -- \
  src/features/game/GameUtilityPanels.test.tsx \
  src/features/game/LiveSidePanel.test.tsx \
  src/features/game/LiveSidePanel.persistence.test.tsx \
  src/features/timer/TimerControls.test.tsx \
  src/features/music/MusicDock.test.tsx \
  src/App.test.tsx -t "Game mode|Available players|Role giveaway|finished|preview|side panel"
```

Expected: PASS; pane unchanged everywhere in Game mode and hidden-only elsewhere, with Timer/player/glass lifetime and cleanup-era swipe suppression preserved.

**Step 9: Checkpoint**

Run `git diff --check`. Do not commit.

---

### Task 8: Preserve music-card chrome and expand Málaga Glass

**Objective:** Keep the established compact-player appearance inside the always-full pane and cover the whole viewport with the existing Málaga decorative layer.

**Files:**
- Modify: `apps/web/src/styles/app.css`
- Modify: `scripts/verify-ui.mjs`

**Step 1: Narrow in-pane player overrides**

Full-pane CSS may override only static position, auto edges, width 100%, max-height, flex sizing, and bottom-pinning margin. Remove overrides that flatten opacity, border, radius, or shadow.

Compare visual computed values against the same hidden-but-mounted MusicDock outside Game mode (excluding `display`): background, border, radius, shadow, and opacity must match.

**Step 2: Preserve expanded containment**

Use `flex: 1 1 auto`, `min-height: 0`, fixed-height rows, and queue-owned scrolling. The rounded card clips iframe, queue, the revealed two-tag action tray, and fade controls.

**Step 3: Expand one existing Málaga layer**

Replace the right-strip geometry:

```css
top: 0;
right: 0;
width: 448px;
height: 100%;
```

with:

```css
inset: 0;
```

Keep fixed position, gradient recipe, bounded blur, z-index, and pointer-events. Do not add another filter/layer.

**Step 4: Verify all Game-mode geometries**

At 1366×1024, every Game-mode surface keeps x=946/width=406/right margin=14 for the pane and accepted x=14/width=918 main-card geometry where the canonical desktop/tablet layout applies. No overflow or scroll.

**Step 5: Check fullscreen and stacking**

Málaga layer reaches every regular/fullscreen edge while toolbar, pane, drawers, queue actions, and swipe targets remain above and clickable. Preserve reduced-transparency fallback.

**Step 6: Checkpoint**

Run `git diff --check`. Do not commit.

---

### Task 9: Run one exact WebKit/iPad journey

**Objective:** Verify the complete interaction/state/visual contract on the primary device path.

**Files:**
- Modify: `scripts/verify-ui.mjs`

**Step 1: Update the journey**

At 1366×1024 WebKit:

1. Initial setup already shows full Timer/Voting/Music pane at the right-rail rectangle.
2. Visit Available players and return; pane/nodes/geometry stay unchanged.
3. Dev music setup has one playlist field, no stage fields, no volume settings.
4. Expand queue through lower grip; no redundant expansion action row.
5. Long and short queue rows have equal fixed heights and long title ellipsis.
6. Swipe rows left and create Initial-only, Endgame-only, and both-tag states; drag one and prove both stable tag identities.
7. Start music, enter Role giveaway, then Mafia planning; pane persists and first unmarked current-order item starts exactly once.
8. Upper grip hides/reveals Timer/Voting with no visible text; Timer continues.
9. Enter a `4 active Citizens / 3 active Mafia` daytime fixture; require a Critical pill directly under the counters. Verify ordinary counts, Night, finished, and privacy-hidden states omit it; preview reflects preview Critical state without firing music side effects.
10. Visit Players, Timeline, and Console; pane is hidden but its nodes remain. Return to Game and state is restored.
11. Traverse Day, Voting, Night, finished, preview, and preview exit; pane/nodes/collapsed/expanded states persist. Preview Voting/Critical presentation reflects preview data while live side effects stay untouched.
12. A Critical Best move records Quick fade followed by one Endgame-preferred persisted shuffle; Critical Day/Goodbye records Slow then preferred shuffle. Require Endgame rows first and the first Endgame track cued at 0.
13. Non-critical Night exits perform the existing ordinary shuffle/current-position preservation. A paused Critical exit skips fade but still performs one preferred shuffle.
14. Compact player retains expected background/border/radius/shadow/opacity on every Game surface.
15. Málaga Glass covers the whole regular/fullscreen viewport.
16. No player remount, page error, duplicate fade/shuffle/jump, document scroll, queue overflow, Critical-pill geometry drift, or pane geometry drift.

**Step 2: Capture evidence**

Save screenshots for setup pane, Available players pane, the swipe-revealed Initial/Endgame tray, marked-row indicators, Critical pill, Role giveaway, Mafia planning, collapsed utilities, expanded queue, preview pane, finished pane, and whole-screen Málaga Glass.

**Step 3: Run**

```bash
UI_BROWSER=webkit APP_URL=http://127.0.0.1:5173 UI_HEADER_ONLY=1 npm run verify:ui
```

Expected: PASS with reported pane/player node IDs, active team counts/Critical decisions, pre/post-Night queue orders, preferred partition/cued index, persisted Initial/Endgame keys, fade/shuffle call order, row/counter/pane boxes, and screenshot paths.

**Step 4: Checkpoint**

```bash
node --check scripts/verify-ui.mjs
git diff --check
```

Expected: both pass. Do not commit.

---

### Task 10: Focused final handoff

**Objective:** Verify changed slices and report the uncommitted rapid prototype honestly.

**Step 1: Focused tests**

```bash
npm run test -w @mafia/web -- \
  src/features/setup/SetupWizard.test.tsx \
  src/features/music/music-controller.test.ts \
  src/features/music/YouTubePlaylistPlayer.test.tsx \
  src/features/music/AccountPlaylistPicker.test.tsx \
  src/features/music/music-preferences.test.ts \
  src/features/music/MusicDock.test.tsx \
  src/features/game/panel-swipe.test.ts \
  src/features/game/critical-state.test.ts \
  src/features/game/GameScreen.test.tsx \
  src/features/game/GameUtilityPanels.test.tsx \
  src/features/game/LiveSidePanel.test.tsx \
  src/features/game/LiveSidePanel.persistence.test.tsx \
  src/features/timer/TimerControls.test.tsx \
  src/App.test.tsx
```

Expected: PASS. `music-stage.test.ts` is absent because the module is deleted.

**Step 2: Typecheck**

```bash
npm run typecheck -w @mafia/web
```

Expected: PASS with no stale stage/volume/pane-visibility props.

**Step 3: Re-run Task 9 WebKit probe**

Expected: PASS.

**Step 4: Scope check**

```bash
git diff --check
git status --short --branch
```

Expected: no whitespace errors; only planned files plus this plan are changed; no commit/push. If unrelated user changes appeared after the audited baseline, preserve them and report them separately.

**Step 5: Report**

Include focused test results, WebKit evidence, pane parity across every Game surface, hidden-only behavior outside Game, player/Timer node identity, selected planning index, Critical count/phase decisions, pre/post-Night queue orders, Endgame partition/cued track, persisted Initial/Endgame keys, fade/shuffle call ordering, row/counter/rail geometry, Málaga full-screen bounds, screenshot paths, and intentionally skipped broad gates.

---

## Files likely to change

| File | Planned change |
|---|---|
| `apps/web/src/App.tsx` | One playlist/order/two-tag sets, planning jump, Critical-aware sequenced Night-exit fade/shuffle, and `view === "game"` pane authority. |
| `apps/web/src/App.test.tsx` | One-playlist, Critical-aware fade/shuffle ordering, transition, preview/live split, all-Game-pane parity, and lifetime coverage. |
| `apps/web/src/features/setup/SetupWizard.tsx` | Remove obsolete music props; retain Role giveaway completion boundary. |
| `apps/web/src/features/music/YouTubePlaylistPlayer.tsx` | Remove volume/action row; player-local native fade target; two-tag swipe tray; fixed titles; Play-now fade; first-regular and force-cued Endgame-preferred shuffle commands. |
| `apps/web/src/features/music/music-controller.ts` | Optional fade starter. |
| `apps/web/src/features/music/AccountPlaylistPicker.tsx` | One playlist field. |
| `apps/web/src/features/music/music-preferences.ts` | One playlist/order/Initial+Endgame tags, legacy migration, deterministic ordinary/preferred shuffle helpers, and preservation of provider-position fallback. |
| `apps/web/src/features/music/music-stage.ts` | Delete. |
| `apps/web/src/features/game/critical-state.ts` | Shared derived Critical rule and exhaustive phase/count tests. |
| `apps/web/src/features/game/GameScreen.tsx` | Critical pill under explicit Citizens/Mafia counter classes. |
| `apps/web/src/features/game/GameUtilityPanels.tsx` | Nullable content and no separate dismissal. |
| `apps/web/src/features/game/LiveSidePanel.tsx` | One grip state; full pane on every Game surface. |
| `apps/web/src/styles/app.css` | Fixed swipe rows, dead volume CSS removal, player chrome, pane parity, whole-screen Málaga. |
| `scripts/verify-ui.mjs` | One playlist, two tags, Critical pill, preferred shuffle, transitions, all-Game pane, geometry, and theme evidence. |
| Corresponding tests | Focused RED/GREEN behavior and lifetime regressions. |

## Files intentionally unchanged

- `packages/game-domain/**` — existing phases provide all transition signals.
- `apps/server/**` — queue order and both tag sets remain browser preferences; selected playlist metadata remains valid.
- Remote YouTube playlists — no mutation.
- `apps/web/src/features/music/LiveMusicControls.tsx` — Fade in, Quick fade, Slow fade remain.
- Authentication, OAuth scope, Tailscale, dependencies, and glass-control schema.

## Acceptance checklist

- [ ] One remembered playlist/order/Initial+Endgame tag set; no stage playlist UI/runtime.
- [ ] Swipe-left tray independently marks Initial and Endgame, supports both, is gesture-safe, and leaves visible indicators.
- [ ] A qualifying swipe cannot synthetically click a just-revealed tag or reverse either panel grip.
- [ ] Queue rows are fixed-height with one-line ellipsis.
- [ ] Exact-key plus one-use `videoId` queue restoration survives provider position drift; tag-only updates neither re-cue nor remount.
- [ ] Critical is derived as active Citizens = active Mafia + 1 during explicit daytime/day-entry phases, with zero Mafia/finished/Night excluded.
- [ ] Critical pill sits under the top-right counters, stays geometry-neutral, reflects preview state, and disappears under privacy masking.
- [ ] Playing Role giveaway → planning selects first unmarked current-order track once.
- [ ] Manual Play now mutes before start and fades to native volume.
- [ ] Every Night exit shuffles and persists the complete queue exactly once; stable Initial/Endgame tags follow entries and Play-next clears.
- [ ] Critical Night exits place randomized Endgame items first and cue the first Endgame track at 0 without autoplay; no Endgame marks fall back to ordinary shuffle.
- [ ] Night → Best move Quick fades before shuffle; Night → Day/Goodbye Slow fades before shuffle; paused Night exit shuffles immediately with the same Critical preference decision.
- [ ] Post-fade shuffle force-cues even while the YouTube PAUSED event lags; it never takes the stale `loadPlaylist` autoplay branch.
- [ ] No app volume settings or redundant expand row.
- [ ] Upper utility control is the same visible grip style as lower queue control; no visible Show-timer text.
- [ ] Timer remains mounted while hidden.
- [ ] Complete right pane appears unchanged on setup, Available players, Role giveaway, all live/finished phases, and preview.
- [ ] No-game surfaces show `No nominations yet`; preview shows preview Voting data.
- [ ] Players/Timeline/Console hide but do not unmount pane.
- [ ] Timer/player/iframe and collapsed/expanded states survive all Game transitions and leave/return.
- [ ] Explicit Reload remains the only intentional iframe remount; stale callbacks from older generations cannot overwrite current state.
- [ ] Player visual chrome remains intact inside pane.
- [ ] Málaga Glass decor covers full regular/fullscreen viewport.
- [ ] 14/918/14/406/14 geometry and no-document-scroll contract remain.

## Risks and tradeoffs

1. A two-button row tray is wider than the old single action; its translate distance and fixed row height must be measured at iPad width without covering Play controls after closure.
2. Row swipe must not steal vertical scrolling or drag/button gestures.
3. Stable source-position keys are required for duplicate videos and both independent tag sets.
4. All-Initial/unavailable queues intentionally keep current playback at planning.
5. Critical must remain a pure current-state derivation; persisting a `critical` flag would become stale after a red card, elimination, replay, or preview.
6. `3 Citizens / 3 Mafia` is not Critical—it already meets Mafia’s victory threshold. The helper must require exactly `Citizens = Mafia + 1` and at least one active Mafia.
7. Queue re-cue cancels an active fade, so shuffle must occur only after the automatic fade settles; paused music shuffles immediately. Because YouTube pause events lag the fade promise, the shuffle path must force `cuePlaylist` rather than trust `playbackStateRef`.
8. Critical preferred shuffle intentionally changes the next cued track to the first Endgame item; ordinary shuffle preserves current item/time.
9. Shuffle order must be persisted through the existing stable-key callback, or reload would silently restore the pre-Night order.
10. A random permutation can theoretically equal the original order; tests inject deterministic randomness and prove the algorithm ran rather than requiring a biased always-different result.
11. Preview Voting/Critical presentation uses preview state, but every side effect—including Endgame preference and shuffle—must stay live-state-bound.
12. Showing utilities before a game deliberately allows Timer use early without fake nominations/domain state.
13. Enlarging the fixed blurred Málaga layer may increase iPad GPU work; reuse one bounded layer and inspect WebKit.
14. The audited baseline was clean at `9bd9f08`; if implementation starts after new work lands, re-read exact changed files and preserve unrelated edits rather than assuming this snapshot is current.
15. Rapid verification provides less confidence than final full gates; restore them only when asked to finalize.

## Open questions

None required. “Critical” is the exact derived `active Citizens = active Mafia + 1` daytime/day-entry condition. During a Critical Night exit, Endgame-tagged items form a shuffled front partition and the first is cued at 0 without autoplay; ordinary exits retain current-position-preserving shuffle. “Everywhere in game mode” remains every `view === "game"` surface, with only Players, Timeline, and Console hiding the still-mounted pane.
