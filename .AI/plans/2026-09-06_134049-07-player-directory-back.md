# Player directory return navigation implementation plan

**Goal:** Let users leave player management and return to their existing game/setup without resetting it.
**Summary:** Add an obvious accessible Back/Close control to the player directory, not to the already-closeable availability grid.
**Architecture:** Add a navigation callback to PlayersScreen and wire it to workspace view navigation, following existing timeline/console return patterns. Keep profile CRUD and game state separate.
**Tech stack:** React/TypeScript, existing localization and focus patterns, Vitest, Playwright.
**Non-goals:** New-game creation, exiting the club, changing profile validation/permissions, auto-saving drafts.

## Evidence and approach
`PlayersScreen.tsx:9-15` has CRUD props but no return callback; :388-465 renders no navigation control. `App.tsx:2608-2626` mounts it. The Game menu opens it at :2331-2337. `App.tsx:830` can also direct users here when fewer than eleven players exist.

1. Add failing navigation tests from both active play and setup: open directory, close, return to the exact existing phase/setup and preserve saved profiles/selection; no reset/persistence mutation triggered by close.
2. Add a labeled, keyboard-accessible visible close/back control in a consistent header slot. Wire it to view=game/current setup, not clearGameState/start-new-game or club exit. Restore useful destination focus.
3. Cover empty/fewer-than-eleven-player entry: a close control still works while the existing start-game eligibility guard stays intact. If automatic refresh routing would immediately trap users back in the directory, distinguish explicit return from initial routing without bypassing eligibility.
4. Preserve CRUD errors/permissions and existing draft-navigation behavior; do not submit or silently save forms on close. Verify after scrolling a long directory and on fullscreen iPad/phone.

**Files:** `apps/web/src/features/players/PlayersScreen.tsx`, `PlayersScreen.test.tsx`, `App.tsx`, `App.test.tsx`, `styles/app.css`, `i18n/messages/players-music.ts` and/or shell messages as appropriate.
**Verification:** `npm run test -w @mafia/web -- PlayersScreen.test.tsx App.test.tsx`; isolated navigation and no-reset browser proof.
**Risk:** Confusing role-draw Back with directory Back would invoke the wrong state transition; keep these actions distinct.

## Shared boundaries and verification
No commits, pushes, deployment, dependency additions, backend/auth changes, or development database mutations. Preserve the dirty working tree, current fire/lighting work, secret-role handling and canonical game state. Use isolated API fixtures, never the signed-in club, for visual interaction tests. After approval, add a failing focused regression before implementation; run focused browser/component checks while iterating, then `npm run check:local` (the disposable-database route to root `npm run check`) for the completed plan set. Keep artifacts under `.AI/ipad-layout/`. Require actual iPad visual acceptance; emulated WebKit is not hardware proof.
