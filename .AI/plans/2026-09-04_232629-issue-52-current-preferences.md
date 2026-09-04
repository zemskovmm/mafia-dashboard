# Issue #52 Current-Format Browser Preferences Implementation Plan

> **For Hermes:** Plan only until Michael explicitly approves the entire revised #52 plan set. Use regression-first RED–GREEN–REFACTOR implementation after approval; do not create another ticket.

**Goal:** Read and write only the current browser preference representations without migrating or cleaning historical preference data.

**Architecture:** Retain the existing current theme and music storage keys and current sanitization/default behavior. Remove old-key and old-field fallback branches; preserve current features, including the lighting renderer whose current enum value is `legacy`.

**Tech Stack:** TypeScript, React, localStorage, Vitest, Testing Library.

**Non-goals:** Removing lighting renderers; changing music playback, queue behavior, colors, or defaults; moving preferences between storage areas; destructive cleanup of existing browser data; changing game-storage ownership (companion plan).

## Plain-language summary

Old theme names and old music preference shapes will no longer be imported. Current colors, playlists, queue ordering, tags, and lighting choices will continue to work. A feature named “legacy” will not be removed merely because of its name.

## Authority and assumptions

- Part of [the same-ticket #52 plan set](./2026-09-04_232629-issue-52-current-only-plan-set.md); not a new issue or independent delivery authorization.
- Obsolete preference keys are ignored and left untouched; broad, explicitly invoked Clear all browser data remains the existing exception. This is a proposed non-destructive boundary awaiting plan approval, not a recorded clarification answer.
- Current invalid preference values remain best-effort defaults/sanitization, unlike blocking invalid game-state data.

## Grounded scope

- `apps/web/src/theme.ts:4-11,25-41`: old named theme fallback and removal of old theme/glass keys.
- `apps/web/src/features/music/music-preferences.ts:36-62`: `stagePlaylistIds` and `queueOrderByPlaylist` fallbacks inside the current v1 key.
- `apps/web/src/features/effects/lighting-preferences.ts:5-19`: `legacy`, `svg`, and `vgpu` are currently supported renderer selections, not obsolete data representations.
- `apps/web/src/features/music/music-preferences.ts:155-191`: video-ID matching for reordered remote playlist occurrences is current queue reconciliation, not historical format migration. Preserve it.

## Tasks

### 1. Remove historical theme conversion

**Files:** `apps/web/src/theme.ts`, `apps/web/src/theme.test.ts`.

1. Add tests that current hex colors restore, invalid/missing current values use `DEFAULT_THEME_COLOR`, and obsolete theme/glass keys are never read or removed during normal read/apply.
2. Run `npm run test -w @mafia/web -- src/theme.test.ts`; observe the intended regression failures.
3. Remove `legacyThemeStorageKey`, `legacyGlassSettingsStorageKey`, `legacyColors`, historical fallback reads and deletes. Preserve current hex validation/lowercasing and DOM application.
4. Run the full file and require GREEN. Do not add another migration path.

### 2. Remove historical music preference fields

**Files:** `apps/web/src/features/music/music-preferences.ts`, `music-preferences.test.ts`, `AccountPlaylistPicker.test.tsx`, `MusicDock.test.tsx` in the same directory.

1. Add negative fixtures with old `stagePlaylistIds`/`queueOrderByPlaylist` and positive current fixtures containing `lastPlaylistId`, `queueOrder`, `initialStageEntryKeys`, and `endgameEntryKeys`.
2. Prove old fields never supply current values; current values retain bounded strings, deduplication, disjoint tags, playlist selection, per-club isolation and best-effort storage error behavior. Preserve repeated video occurrences and remote position reconciliation.
3. Run the focused preference suite to establish RED, remove only historical-field conversion, and rerun GREEN.
4. Update picker/dock fixtures that deliberately exercise removed formats; retain current user interaction assertions rather than deleting entire tests.

### 3. Preserve current lighting and integrate

**Files:** `apps/web/src/features/effects/lighting-preferences.test.ts`, `LightingRendererContext.test.tsx`, `PlayerCardLighting.test.tsx`, `TableAmbientLighting.test.tsx`; `scripts/verify-ui.mjs` (retain renderer assertions).

1. Confirm tests still cover the three current renderer values, current defaults and reduced-motion behavior. No production lighting edit is expected.
2. Run:
   ```bash
   npm run test -w @mafia/web -- src/theme.test.ts src/features/music/music-preferences.test.ts src/features/music/AccountPlaylistPicker.test.tsx src/features/music/MusicDock.test.tsx src/features/effects/lighting-preferences.test.ts src/features/effects/LightingRendererContext.test.tsx src/features/effects/PlayerCardLighting.test.tsx src/features/effects/TableAmbientLighting.test.tsx
   ```
3. Audit production preference readers for old aliases/fallbacks and record any additional true historical format in the plan before broadening source work.
4. Hand this source slice to integrated `npm run check` and exact-candidate review in the plan-set index. No separate commit/push under this implementation plan.

## Acceptance criteria

- Normal theme reads/writes consult only `mafia-dashboard.theme-color.v1`; obsolete keys remain byte-identical.
- Music reads/writes use only the current fields at `mafia-dashboard.music-preferences.v1.<clubId>`; legacy fields are not interpreted or migrated.
- No old preference data is deleted automatically; invalid optional preferences safely default.
- Current color, music and lighting behaviors remain verified; the `legacy` renderer remains supported as a current feature.
- Every removed compatibility-positive test is replaced by obsolete-input rejection/ignore coverage and a current-format positive test where that safeguard remains relevant.

## Risks and approval

Users with only old preferences will see current defaults. No promise is made to retain those preferences, migrate them, or clean their keys. This tradeoff and the non-destructive assumption require approval with the full #52 plan set.
