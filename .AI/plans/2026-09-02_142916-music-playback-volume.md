# Implement issue #49: normalize music playback starts to 100% volume

> **For implementing agent:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan.

## Goal

Make every application-controlled playback-start path use one explicit 100% target without changing fade timing, queue behavior, or the general-purpose fade controller.

## Brief summary of upcoming changes

Music started by the opening queue, the Fade in control, Play now, or the transition to the first regular track will no longer inherit a quieter native-player volume. Focused adapter tests will lock the target at 100 and prove that a stale fade cannot lower a newer direct-play action.

## Selected issue and readiness

- **Issue:** [#49 — `[Music] Normalize direct play and fade-ins to 100% volume`](https://github.com/zemskovmm/mafia-dashboard/issues/49)
- **Live contract checked:** 2026-09-04 15:31 CEST. The issue is open, has complete behavioral acceptance criteria, has no comments, assignee, milestone, Project item, linked PR, or non-`main` remote branch.
- **Activity:** **inactive**. No current writer or candidate branch was found, and the latest commits touching `YouTubePlaylistPlayer` predate the issue.
- **Priority selection:** all three open issues are `priority:P1`; there are no open higher-priority items. #52 is not currently implementation-ready because its browser-wide storage contract conflicts with the later, explicit club-scoped storage contract added by `fc25472` in `scripts/session-verifier-contracts.mjs:119-125` and `scripts/session-verifier-contracts.test.mjs:150-162`. Of the remaining ready items, #49 is a user-visible correctness bug while #51 is a newer UX feature; #49 also wins the stable oldest-issue tie-break.
- **Dependency state:** no prerequisite issue or unresolved product decision blocks #49.

## Baseline and artifact boundaries

- Baseline: `main` and `origin/main` both point to `fc25472`; the tracked worktree is clean.
- The selected plan is currently untracked. The untracked backlog index, #51 plan, and #52 plan are adjacent owner artifacts and must not be staged with issue #49 source work.
- Implementation scope is limited to:
  - `apps/web/src/features/music/YouTubePlaylistPlayer.tsx`
  - `apps/web/src/features/music/YouTubePlaylistPlayer.test.tsx`
- `apps/web/src/features/music/music-controller.ts` remains general-purpose and should not be changed unless a failing in-scope regression proves its existing cancellation contract insufficient.

## Source-backed current behavior

- `lastAudibleVolumeRef` begins at 100 but is refreshed from `player.getVolume()` on ready and playing events (`YouTubePlaylistPlayer.tsx:163`, `:335`, `:371`). A native volume of 65 therefore becomes policy for later starts.
- Queue-item Play now, manual Fade in, and opening-queue playback pass that remembered value to `MusicController.fadeIn` (`YouTubePlaylistPlayer.tsx:485-491`, `:525-532`, `:560-568`).
- `playFirstRegularTrack` starts the selected track directly without normalizing volume or cancelling a pending fade (`YouTubePlaylistPlayer.tsx:578-598`).
- Existing integration expectations demonstrate the defect by expecting Play now and opening playback to finish at 65 (`YouTubePlaylistPlayer.test.tsx:178-187`, `:313-322`).
- `MusicController` already accepts exact targets and generation-fences stale fades; its parameterized interpolation and cancellation tests should remain unchanged (`music-controller.ts:33-69`, `:78-116`; `music-controller.test.ts:47-76`, `:105-155`).

## Scope and non-goals

### In scope

- Define one named full-volume policy value of 100 in the YouTube adapter.
- Use it for manual Fade in, opening-queue fade, and queue-item Play now.
- Before `playFirstRegularTrack` starts a track, cancel any active fade without pausing the newer action, set volume to 100, then start the selected regular track.
- Remove remembered-native-volume state and event updates that no longer serve playback-start policy.
- Preserve existing fade durations, fade-out restoration, queue ordering, callbacks, readiness/error handling, and cancellation semantics.

### Non-goals

- A volume slider or remembered user volume preference.
- Changes to fade interpolation, fade-out endpoints, durations, YouTube iframe controls, playlist selection, or music preference storage.
- Changes to setup/game transition rules outside their existing calls into the player handle.

## Implementation tasks

### Task 1: Add failing adapter-level regression coverage

**File:** `apps/web/src/features/music/YouTubePlaylistPlayer.test.tsx`

1. Keep the fake native player at a lower starting volume (currently 65) so tests prove policy does not inherit it.
2. Change the existing Play now and opening-queue assertions to require a final `setVolume(100)` while retaining the existing mute-before-play and queue-callback assertions.
3. Add focused coverage for the public `fadeIn()` handle: it must set zero before playback, complete at 100 after the existing duration, and preserve its boolean success contract.
4. Extend direct-track coverage so `playFirstRegularTrack()` cancels an in-progress fade, writes 100 before `playVideoAt`, and cannot later be overwritten when old timers advance.
5. Exercise repeated start actions and assert the latest action completes at 100 without an unhandled rejection or changed playback-state/queue callback behavior.
6. Run `npm test -w @mafia/web -- YouTubePlaylistPlayer.test.tsx` and confirm the new target/order assertions fail for the existing implementation before editing production code.

### Task 2: Apply the explicit full-volume start policy

**File:** `apps/web/src/features/music/YouTubePlaylistPlayer.tsx`

1. Add one local named constant for the 100% playback-start target.
2. Remove `lastAudibleVolumeRef` and the on-ready/on-playing assignments sourced from `getVolume()`.
3. Pass the constant to all three adapter-owned fade-in paths: Play now, the imperative `fadeIn()`, and the opening queue.
4. In `playFirstRegularTrack()`, after all existing readiness and index guards pass, cancel the active controller operation with pending-playback pausing disabled, set the player to the full-volume constant, and only then call `playVideoAt`.
5. Do not alter the controller implementation or fade-out path; fade-out must still sample and restore the player’s current volume.
6. Re-run `npm test -w @mafia/web -- YouTubePlaylistPlayer.test.tsx` and require all focused music-adapter tests to pass.

### Task 3: Verify the integrated behavior

1. Run `npm test -w @mafia/web -- YouTubePlaylistPlayer.test.tsx` once more on the final source tree.
2. Run the repository gate `npm run check`.
3. Inspect the final diff and confirm only the two scoped source/test files plus approved issue-#49 plan lifecycle changes are present; preserve adjacent untracked plans.

## Acceptance criteria

- Completed manual, opening, and Play now fades end at exactly 100.
- The first regular track starts at 100 even when the native player previously reported a lower volume.
- Volume is written before direct selected-track playback becomes audible.
- A cancelled/stale fade cannot later overwrite a newer direct action.
- Repeated actions remain race-safe with no unhandled rejection.
- Fade durations, fade-out behavior, queue order, readiness/error behavior, playback-state callbacks, and queue callbacks remain unchanged.
- Focused tests and `npm run check` pass on the same final tree.

## Risks and controls

- **Stale timer lowers direct playback:** explicitly cancel before the direct 100% write and verify by advancing timers after the newer action.
- **Accidental fade-out regression:** leave `MusicController.getVolume()` and fade-out untouched; only remove the adapter’s remembered start target.
- **Order regression:** assert `setVolume(100)` precedes `playVideoAt`, while existing tests continue to assert zero precedes Play now playback.
- **Scope contamination:** stage paths explicitly because three unrelated plans remain untracked beside this plan set.

## Approval boundary

No production code, tests, GitHub state, commits, or pushes have been changed by this planning pass. Implementation begins only after Michael explicitly approves this plan together with the sibling delivery closeout plan.