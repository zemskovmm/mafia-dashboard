# Account-gated music with discoverable YouTube connection

> **Completed — non-executable.** Implemented after Michael’s “go”; focused regressions, Chrome/WebKit checks, full `npm run check:local`, and final independent review passed. See [verification](../reports/ui-recovery/verification.md). Original planning text below is historical. Retained untracked/uncommitted only pending Git-history-safe retirement.

## Plain-language summary
Hide the entire music player when no YouTube music account is connected. Keep a clearly labelled Connect YouTube account action in the existing Manage/settings surface, independent of the player.

## Status and goal
Completed and verified. Covers requests 2–3 and the confirmed settings location. Goal achieved: music visibility and onboarding are consistent with actual account connection.

## Source findings
- `apps/web/src/App.tsx:2717`: MusicDock and YouTubePlaylistPlayer mount for managers without an account-connected check.
- `apps/web/src/App.tsx:2020`: music settings mount only when musicSetupOpen; they contain playback status, reload, and AccountPlaylistPicker.
- `apps/web/src/App.tsx:2358`: settings access is the collapsed Music player setup button in Manage.
- `apps/web/src/features/music/AccountPlaylistPicker.tsx:29`: account status is fetched inside the picker, rather than being available to the App player gate.
- Picker lines 66–90: unconfigured OAuth shows a manual playlist input; configured/disconnected shows the existing connection link to `/api/music/oauth/start`.
- `apps/server/src/app.ts:538`: `/api/music/oauth/status` distinguishes configured from connected. Start returns 503 if OAuth is not configured; successful callback returns to `/?music=connected`.
- `apps/web/src/features/music/AccountPlaylistPicker.test.tsx:26` already verifies connection; line 48 expects manual-ID availability when OAuth is unconfigured.
- App tests mock AccountPlaylistPicker, so they alone cannot establish real connection UI integration.

The reported environment's OAuth configuration has not been checked. Missing configuration and collapsed settings are possible explanations for the missing button, not proven live diagnoses.

## Scope and design
1. Load account status at workspace level, using the existing API and explicit loading/error/configured/connected states. Share the result with settings rather than maintaining contradictory picker/player state. A small hook is optional, not a framework redesign.
2. Mount MusicDock and YouTubePlaylistPlayer only for an authorized manager with positively confirmed connection. Loading, disconnected, unconfigured and status-check error states have no player shell, restore handle, controls, queue, empty reserved space or YouTube iframe.
3. Expose an explicit Connect YouTube account action directly in existing Manage/settings when configured and disconnected; do not put it in the hidden dock or require developer mode. Avoid duplicate competing connect links. Retain playlist selection and connected identity in music settings.
4. For unconfigured OAuth, show an honest setup-unavailable explanation and a labelled disabled connection affordance, not an enabled route known to return 503. For failed status requests, show a retry action. Do not claim UI work configures OAuth.
5. Gate playback-only settings status/reload controls too. A remembered/manual playlist ID never overrides the connection gate. Preserve stored preferences unless existing explicit disconnect cleanup removes them.
6. Reuse `clearMusicAccountState` on successful disconnect, transition shared status immediately, unmount/destroy the player and stop audio. Preserve failure feedback without pretending a failed disconnect succeeded. Refresh status after OAuth return, on workspace mount, and through settings retry/reopen; suppress stale responses after unmount/account change.
7. Preserve existing connected queue ordering, stage/endgame tags, playback controls, fade behavior and authenticated manager boundaries. Do not use this task to add volume controls or change music-provider security.

## Implementation tasks
- Add focused failing tests in `apps/web/src/App.test.tsx` and `apps/web/src/features/music/AccountPlaylistPicker.test.tsx` for the gate and onboarding matrix.
- Update `apps/web/src/App.tsx` and the picker to share status and render the appropriate settings/player branches; update EN/RU copy in `apps/web/src/i18n/messages/players-music.ts` and `apps/web/src/i18n/messages/shell.ts` only as needed.
- Exercise the real picker and dock in an isolated browser fixture, not only App's component mocks. Update the old unconfigured/manual-playback expectation so it cannot imply disconnected playback remains enabled.
- Remove the unconfigured manual-playlist input branch and update its EN/RU guidance. `README.md:54` currently advertises playlist-ID playback as an alternative to account connection; revise that statement to match the new account requirement. `VITE_YOUTUBE_PLAYLIST_ID` may remain a post-connection default, never a bypass. Do not change environment files or credentials.

## Acceptance criteria
- Cold load with a saved playlist but no connected account never flashes or initializes the player.
- Configured/disconnected manager finds a clearly labelled settings connection action with the existing OAuth href; EN/RU labels work.
- Unconfigured and error states are explicit; error retry can recover without a reload.
- Connected state mounts the player; normal playlist selection/queue/fades work.
- Successful disconnect hides all player UI and stops audio without remounting from stale state. Sign-out and club/workspace changes do not leak the previous user's connection status.
- Non-managers gain no music controls. Timer/voting remain usable and correctly laid out when music is absent.

## Risks and non-goals
No secrets, deployment changes, new OAuth flow, expanded Google scopes, new music provider, or promise of successful third-party authorization without actual verification. If the environment lacks OAuth configuration, record that as a separate approval-required operational blocker. Live account connection/disconnection is not authorized by this plan.

## Verification
After implementation approval: `npm run test -w @mafia/web -- src/App.test.tsx src/features/music/AccountPlaylistPicker.test.tsx src/features/music/YouTubePlaylistPlayer.test.tsx` must exit 0. Use isolated routed browser responses for loading/disconnected/unconfigured/error/connected/disconnect states and check desktop/tablet layouts. Label fixture evidence as simulated; do not claim a real Google authorization was completed. Run `npm run check:local`, which invokes the required `npm run check` with disposable database isolation. Save browser evidence under `.AI/`.

## Execution boundary
Plan only. No implementation, commit, push, issue closure or deployment until separately authorized. Recheck Git and source before editing. Keep the separate existing game-save-rejection-diagnostics plan untouched. Remove this plan only after its implementation is verified.
