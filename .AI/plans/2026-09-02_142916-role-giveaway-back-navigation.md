# Issue #51 Role-giveaway Back-navigation Implementation Plan

> **For Hermes:** Implement this plan task-by-task with strict RED-GREEN-REFACTOR cycles from the `test-driven-development` skill. Do not broaden the issue when unrelated findings appear.

**Goal:** Let the host return from role giveaway to player selection, preserve a still-compatible partial role draw, and irreversibly discard that secret draw after any host or seat change.

**Architecture:** Keep navigation inside `SetupWizard` and its existing `SetupWizardSessionState`; no route, domain-model, or API change is needed. The role screen will publish a `players` snapshot while retaining the current `SetupState`, selection mutations will clear that setup immediately, and re-entry will reuse only an exact role-draw/roster match rather than calling `beginRoleDraw` unconditionally. `App` already assigns the durable game ID on the first `roles` snapshot and persists later setup snapshots under that ID, so integration coverage will prove the contract without changing production persistence unless a failing test exposes a narrow handoff defect.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, the existing `@mafia/game-domain` setup functions, Vite workspace scripts, and the existing English/Russian message catalog.

**Non-goals:** Editing setup after Mafia planning or live play begins; preserving a role deck after any host, player-membership, or seat-mapping change; changing role secrecy/storage authorization; changing club locks or browser-local singleton policy (#52); adding routes, database migrations, dependencies, or a PR/CI workflow.

---

## Selection and current context

- Selected [GitHub issue #51](https://github.com/zemskovmm/mafia-dashboard/issues/51), `[UX] Allow role giveaway to return safely to player selection`.
- The only open backlog items are #51 and #52. Both are `priority:P1`; #51 is first by the maintained backlog order/issue number and its prerequisite #50 is closed, so #51 is the highest-priority implementation-ready item.
- Live issue readback shows no comments, no assignee, and the expected `type:feature`, `area:frontend`, `area:ux`, and `priority:P1` labels. There are no open pull requests or issue branches.
- Local `main` and `origin/main` both point to `6dee088`; the only working-tree state is the pre-existing untracked `.AI/plans/` set. Implementation must stage only the approved issue-specific files.
- `SetupWizard` already restores `hostPlayerId`, all ten `selectedPlayerIds`, and `setup` (`apps/web/src/features/setup/SetupWizard.tsx:261-274`) and publishes every state transition (`:291-293`).
- The live issue’s statement that `beginRoleDraw(setup ?? createSetup(players))` preserves a valid draw is inaccurate: `beginRoleDraw` always reshuffles and clears assignments (`packages/game-domain/src/setup.ts:77-85`). Current re-entry therefore destroys partial progress (`SetupWizard.tsx:352-365`).
- Availability loss already returns to player selection and clears setup (`SetupWizard.tsx:295-316`), but direct host/seat combobox changes and development-player generation do not clear a retained setup (`:527-585`). Random assignment already clears it (`:343-350`).
- `App` creates/retains the game ID whenever the wizard publishes `step: "roles"` (`apps/web/src/App.tsx:1498-1516`) and enqueues every later `setupSession` snapshot (`:1090-1136`). Existing tests prove role snapshots reload and retain one ID (`apps/web/src/App.test.tsx:2582-2658`).

## Acceptance criteria

- Role giveaway exposes an obvious localized button named “Back to player selection” (and the Russian equivalent), operable by keyboard and touch with at least a 48px target.
- Back closes transient role UI, returns to player selection with the exact host and ten seat values, leaves assigned roles out of the rendered player-selection UI, and moves focus to the player-selection heading.
- Returning to role giveaway without changing the selection restores the exact role deck, remaining roles, and assignments; it does not rerun first-entry role-draw/music side effects.
- Changing or clearing the host, changing or clearing any seat, randomizing seats, accepting a generated development roster, or losing a selected available player clears the retained setup before role re-entry.
- A changed roster re-enters with a fresh ten-role draw and no assignments. This “10 remaining” state is the visible reset; no extra confirmation or secret-role copy is added.
- Reload while on the returned player step restores that screen and compatible partial setup; re-entry and reload on the role step preserve it under the original durable game ID.
- No extra local or remote game ID/session is created by any back/forward round trip.

### Task 1: Add accessible back navigation and focus restoration

**Objective:** Introduce the role-screen control and make its player-step transition explicit, persistent, and accessible.

**Files:**
- Modify: `apps/web/src/features/setup/SetupWizard.test.tsx:87-551`
- Modify: `apps/web/src/features/setup/SetupWizard.tsx:247-620`
- Modify: `apps/web/src/i18n/messages/game.ts:96-134,260-298`
- Modify: `apps/web/src/styles/app.css:795-818,2038-2061`

**Steps:**
1. Add a focused test that renders a partial `roles` session, activates the localized Back control with the keyboard, and expects the player heading to receive focus while the same host and ten seat values remain visible. Also assert the player DOM does not render the assigned role name.
2. Run `npm run test -w @mafia/web -- src/features/setup/SetupWizard.test.tsx`; expect RED because no Back control exists.
3. Add the English/Russian `setup.backToPlayerSelection` message, a dedicated role-header Back button, and a small `handleBackToPlayers` transition that closes manual-role state, clears tap state, sets `step` to `players`, and publishes `publishSessionState("players", setup)` without exposing setup contents.
4. Track the back-transition focus request with a ref and focus the player-selection `<h1 tabIndex={-1}>` after React renders it. Do not autofocus initial setup or ordinary reloads.
5. Add narrowly scoped header/action CSS with a minimum 48px button height and responsive wrapping; keep the existing table and global header layouts unchanged.
6. Re-run the focused test file; expect GREEN.

### Task 2: Preserve an unchanged partial role draw

**Objective:** Resume a compatible role draw exactly and avoid duplicate first-entry side effects.

**Files:**
- Modify: `apps/web/src/features/setup/SetupWizard.test.tsx:449-529`
- Modify: `apps/web/src/features/setup/SetupWizard.tsx:318-366`

**Steps:**
1. Add a test that starts a draw, assigns one role, goes back, re-enters without edits, and compares the published role deck, remaining roles, and assignments with the pre-back snapshot. Assert `onStartGame` and `setup.role-draw-started` remain one-time first-entry effects.
2. Run the single test by name with `npm run test -w @mafia/web -- src/features/setup/SetupWizard.test.tsx -t "preserves a partial role draw"`; expect RED because `beginRoleDraw` resets it.
3. Add a local compatibility predicate that accepts only `setup.step === "role-draw"` with the same ten player IDs, names, and seat numbers as the current ordered selection.
4. Change `startRoleDraw` to reuse a compatible setup unchanged; generate a new draw and fire first-entry side effects only when no compatible setup exists. Always publish the `roles` step so `App` persists navigation.
5. Re-run the named test and then the whole `SetupWizard.test.tsx` file; expect GREEN.

### Task 3: Invalidate retained roles for every selection mutation

**Objective:** Make host/seat changes durably destroy incompatible secret assignments before another draw starts.

**Files:**
- Modify: `apps/web/src/features/setup/SetupWizard.test.tsx:164-367,395-447`
- Modify: `apps/web/src/features/setup/SetupWizard.tsx:295-350,527-585`

**Steps:**
1. Add one host-edit test and one seat-edit test. Each begins from a partial draw, goes back, changes the selection, waits for the published `players` snapshot to contain `setup: null`, re-enters after making the roster valid, and expects ten roles remaining with no assignments.
2. Run those named tests; expect RED because combobox handlers currently retain setup.
3. Route direct host and seat changes through small handlers that compare the next value, update the selection, and clear setup on the first real change. Retain the existing clear-on-random-assignment behavior and add the same invalidation before accepting a generated development roster.
4. Keep the availability-reconciliation effect as the guard for deleted/unavailable selected players; extend its regression assertion to require `setup: null` when it repairs a retained draw.
5. Re-run the named tests and the entire `SetupWizard.test.tsx` file; expect GREEN.

### Task 4: Prove durable reload and game-ID continuity

**Objective:** Verify the wizard transitions remain one durable session through browser reloads.

**Files:**
- Modify: `apps/web/src/App.test.tsx:159-279`
- Modify: `apps/web/src/App.test.tsx:2567-2658`
- Modify only if the test exposes a handoff defect: `apps/web/src/App.tsx:1498-1516,2573-2622`

**Steps:**
1. Teach the existing `SetupWizard` test double to expose Back and to preserve an existing compatible role setup instead of replacing it unconditionally. Keep it a behavioral seam; do not duplicate production implementation details.
2. Extend the authoritative-session lifecycle coverage to: enter roles, assign one role, record the generated game ID, go back, wait for a durable `step: "players"` snapshot retaining that setup, unmount/remount, re-enter roles, remount again, and assert the same assignment and game ID throughout.
3. Run `npm run test -w @mafia/web -- src/App.test.tsx -t "role giveaway"`; expect RED before the mock/back behavior and persistence assertions are complete.
4. Make only the minimal test-double changes. Change production `App.tsx` only if the failure proves that its existing `handleSetupSessionChange`/enqueue path violates an acceptance criterion.
5. Re-run the role-giveaway App tests and then `npm run test -w @mafia/web -- src/App.test.tsx`; expect GREEN with no duplicate-session calls.

### Task 5: Verify the issue-scoped implementation

**Objective:** Establish focused and repository-wide confidence before delivery.

**Files:**
- Verify only; do not modify unrelated failures or artifacts.

**Steps:**
1. Run `npm run test -w @mafia/web -- src/features/setup/SetupWizard.test.tsx src/App.test.tsx`; expect both files to pass.
2. Run `npm run typecheck -w @mafia/web`; expect exit 0.
3. Run `npm run check`; expect formatting, lint, typecheck, all tests, and all builds to pass.
4. Inspect `git diff --check`, `git diff --stat`, `git status --short --untracked-files=all`, and the exact diff. Confirm there are no role leaks, persistence/API/domain changes, dependencies, or unrelated edits.
5. Hand off to `.AI/plans/2026-09-04_155114-issue-51-delivery-closeout.md` for plan cleanup, commit, push, remote verification, and issue closure.

## Risks and tradeoffs

- **Stale restored setup:** Comparing only selected IDs would miss seat/name mismatch. Compare the full ordered `{id,name,seat}` player records and require `role-draw` before reuse.
- **Transient secret exposure:** Keeping setup in state is necessary for unchanged round trips, but the player render must consume only host/seat IDs. Tests must query rendered text, not inspect the intentionally durable private snapshot, when proving non-exposure.
- **React update ordering:** Selection and setup invalidation are separate state updates. Assert the emitted settled snapshot with `waitFor`; do not add imperative duplicate persistence calls just to satisfy timing.
- **Duplicate start effects:** Re-entering an existing draw should not restart the opening music queue or log a new draw-start event. Restrict those effects to newly generated draws.
- **Existing untracked plan set:** Stage files by exact path. Do not add the shared plan-set index or #52 plan during #51 delivery.

## Open questions

None. The confirmed default backlog workflow and live issue define the goal, scope, acceptance criteria, local verification, direct-main delivery, and closure behavior.
