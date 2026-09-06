# Issue #56: New-game availability navigation implementation plan

> **For Hermes:** Implement only after explicit approval of this saved plan; use the relevant debugging and regression-testing skills.

**Goal:** Make New game guide clubs with enough registered profiles but insufficient available players to Select available players instead of an availability error.

**Plain-language summary:** Replace the dead-end availability error with the existing player-selection screen. Keep ordinary new-game behavior when 11 players are already available, preserve game-deletion safeguards, test the flow, then commit, push, and close #56 with verified results.

**Architecture:** Keep this in the React workspace navigation in `apps/web/src/App.tsx`. Reuse `AvailablePlayersScreen` and existing club-scoped availability storage, and choose the destination only after any required new-game reset succeeds. Do not change backend persistence or game rules.

**Tech stack:** React, TypeScript, Vitest, Testing Library; npm workspaces.

**Non-goals:** Availability UI redesign, automatic availability selection, backend/schema changes, game-rule changes, unrelated lighting work, deployment operations, or changing the number of required registered players.

## Context and scope

- GitHub: https://github.com/zemskovmm/mafia-dashboard/issues/56 (open).
- User authorized fixing, verifying, committing, pushing the current branch, and closing #56.
- Inspected branch: `main`. Tracked files are currently clean; `.AI/lighting-visuals/` and an unrelated `.AI/plans/2026-09-05_120327-local-tailscale-run.md` are untracked. Preserve them and recheck Git state before implementing/staging.
- `App.tsx:2260-2268` currently rejects New game from the Players view when fewer than 11 are available, choosing between registration and availability error messages.
- `App.tsx:2482-2508` renders Players before availability selection, so opening availability also requires leaving the Players view.
- `resetLocalState` (`App.tsx:1657`) sets the game view but closes availability. `clearGameState` (`App.tsx:1728`) confirms deletion, waits for persistence, protects newer sessions, then resets; cancellation/failure must not trigger navigation or discard state.
- `AvailablePlayersScreen.tsx` already supports selecting, searching, and closing back to setup. No changes to that component are expected.
- **Assumption requiring plan approval:** Preserve the existing registered-profile guard for clubs with fewer than 11 profiles. The original report has 11 registered profiles; a follow-up clarification on this edge case timed out. This plan fixes availability, not insufficient registration.

## Acceptance criteria

1. With at least 11 registered players and zero, some, or ten available players, New game opens Select available players without the blocking availability error, including from Players and ordinary setup.
2. The Manage drawer closes and the availability screen/status is visible rather than hidden behind Players.
3. No players are silently marked available. Selections persist only under the current club's existing frontend storage key; another club's selections are not imported or changed.
4. Selecting enough available players and closing the screen returns to setup with those players available for assignment.
5. With at least 11 available players, New game retains the existing setup destination.
6. Fewer than 11 registered profiles retains the existing registration guard, per the explicit assumption above. Minimum host/seat/start rules remain unchanged.
7. Existing active-game confirmation, deletion failure, pending deletion, claim handling, and newer-session protection remain intact. For an existing game, show the intended destination only after successful clearing; never bypass confirmation or clear on navigation alone.
8. Focused regression tests and `npm run check` pass. Publish only scoped changes, verify the pushed commit, and verify issue closure.

## Implementation steps

### 1. Reproduce with failing behavioral tests

**Modify:** `apps/web/src/App.test.tsx`.

- Reuse the existing fixture of ten assigned players plus a host, club storage helpers/patterns, and Manage navigation.
- Add parameterized coverage for zero, partial, and ten available players from Players, asserting visible availability selection, closed drawer, and no availability error.
- Cover New game from ordinary setup with insufficient availability, without changing the registered-player guard test at lines 1212-1244.
- Complete the selection-to-setup flow and inspect the setup player pool and current-club storage; include other-club storage as an isolation sentinel.
- Keep/enhance the sufficient-availability test at lines 2129-2152.
- Extend existing deletion lifecycle tests around lines 3708-3814 only as needed to prove cancellation/failure cannot open availability and successful clearing can.
- Run the focused command below and confirm new assertions fail for the actual navigation defect before editing behavior.

### 2. Apply the smallest navigation fix

**Modify:** `apps/web/src/App.tsx`.

- Separate the insufficient-registration guard from the availability destination decision.
- Remove the availability-error branch from New game while preserving the registration guard.
- Reuse existing reset/clear paths and make the New game destination explicit. If needed, add a narrowly scoped destination option to those helpers with existing defaults for all other callers (finish, takeover, delete, etc.).
- Open availability only after a successful reset/clear and only when required; set the game view so the Players screen cannot mask it.
- Retain cancellation, failure, newer-session, and claim protections. Do not introduce automatic selections, backend writes for availability, or unrelated helper refactors.

### 3. Verify

- `npm run test -w @mafia/web -- src/App.test.tsx src/features/setup/SetupWizard.test.tsx`
- `npm run check`
- Inspect `git diff --check` and the scoped diff. If checks reveal unrelated blockers, report them rather than expanding scope or weakening checks.
- Existing real SetupWizard tests must continue proving assignment is disabled with only ten available players; App tests mock the wizard and cannot alone prove game-rule enforcement.

### 4. Publish and close

- Remove only this implementation plan after successful implementation verification; preserve unrelated AI artifacts.
- Recheck current branch/status and review the exact staged changes; stage only the issue-specific source/tests (and any strictly necessary related change approved within scope).
- Commit the scoped fix and push the current branch without force. Do not incorporate unrelated work or rewrite history; stop if concurrent remote changes require reconciliation.
- Verify the remote branch resolves to the intended commit using a remote read.
- Post a concise issue comment with the commit SHA, change summary, retained registration guard, and actual local verification results; close #56 and read it back to verify the comment/state.
- Report the issue link, commit, and executed check results. No pull request, CI wait, or manual deployment is requested.

## Risks and approval boundary

- A naive `setAvailabilityScreenOpen(true)` is insufficient: Players rendering takes precedence and reset closes availability again.
- Routing before successful active-game deletion could hide or discard state; existing lifecycle checks are mandatory regression targets.
- Fewer-than-11 registered-player behavior is explicitly preserved pending approval of this plan; change that boundary only through clarification/replanning.
- No implementation, GitHub mutation, commit, or push has been performed during this planning phase.
