# Recover a browser game attached to an unavailable club

> **Completed — non-executable.** Implemented after Michael’s “go”; focused regressions, Chrome/WebKit checks, full `npm run check:local`, and final independent review passed. See [verification](../reports/ui-recovery/verification.md). Original planning text below is historical. Retained untracked/uncommitted only pending Git-history-safe retirement.

## Plain-language summary
Fix the stuck unavailable-club dialog. After explicit confirmation, discard only the captured local game and open the selected club; if none was selected, return to the club portal. Keep normal unsynced-game release protections intact.

## Status and goal
Completed and verified. Covers request 9. Goal achieved: a working, guarded recovery path for the reported unfinished game of a deleted club.

## Evidence and confidence
The supplied screenshot says the game belongs to a club no longer available and asks to discard its local copy, but offers Release and open Qqq.

Source inspection confirms a mismatched branch:
- `apps/web/src/App.tsx:3210` derives missingOwner from the visible club list.
- Lines 3260–3273 use missing-owner discard copy and suppress the ordinary unresolved-release explanation.
- Lines 3285–3295 choose the normal release button whenever blockedClub is non-null, even when missingOwner is true. That button is disabled for unresolved attachments.
- `releaseAndOpenBlockedClub` at line 3120 calls the normal release helper, rereads storage, and silently stays put if it is not empty; failures are console-reported rather than shown in the dialog.
- `apps/web/src/browser-game-storage.ts:82` deliberately refuses unresolved or stale snapshots. Unresolved means pending outbox operations, failed saves/clears or an in-progress clear; it is not synonymous with an unfinished game.
- `discardUnavailableBrowserGame` at App line 3136 already uses confirmation and guarded local discard, but does not capture/open a blocked destination. It currently sets state empty instead of verifying the final target through a fresh read.
- `discardBrowserGameStorage` at storage line 102 already compares exact snapshot, club and game IDs under the browser storage transaction and verifies removal.
- `apps/web/src/App.test.tsx:733–889` covers normal release, already-released storage, replacement/invalid records, unsynced normal blocking and stale missing-owner discard. Extend the matrix for missing owner PLUS blocked destination.

This is a source-confirmed defect consistent with the screenshot. The exact device/storage condition has not been reproduced, so do not claim a uniquely proven runtime cause or repair the user's live storage during planning.

## Scope and design
1. Make the missing-owner branch take precedence over ordinary release when choosing actions. Display Discard local game and open {club} when a destination exists, or Discard local game otherwise. Include a clear warning that unsent local changes will be lost.
2. Keep explicit confirmation, cancellation with no mutation, and exact-snapshot transaction guards. Capture the attachment and destination before awaiting anything. Do not clear all localStorage or clear a newly replaced record.
3. After guarded discard, prepare/reread storage. Open the captured, still-available target only if storage is empty; otherwise refresh the dialog and explain the changed state. Without a target, return to the portal. Respect newer attachments even if they arrive during confirmation or cleanup.
4. Treat already-empty storage as an idempotent recovery after rereading, without weakening stale-record refusal. If a target disappeared, stay at the portal with meaningful feedback rather than opening a stale club object.
5. Use an explicit pending state to prevent duplicate operations, and an inline accessible error/status message for lock failure, storage failure or replacement. Retain structured console diagnostics without exposing game contents.
6. Preserve normal release for available owners: unsynced records remain attached, with the existing explanation and path back to the owning club. Do not make the shared normal-release helper accept unresolved records.
7. Use the existing unavailable-owner determination only after club loading completes successfully. A loading/network error must not newly authorize a destructive discard. Absence from the visible list means unavailable, not necessarily deleted; keep wording honest and obtain explicit confirmation.
8. No remote session deletion, claim takeover, fake save success, database cleanup or cross-club transfer is required for local recovery. Preserve server records, club isolation, canonical logs and persistence protections.

## Implementation tasks
- Add failing regression tests in `apps/web/src/App.test.tsx` reproducing a missing owner with selected target, unfinished current state and unresolved outbox. Assert the reachable discard action, confirmation, storage readback and destination.
- Update App recovery handlers/action branch and EN/RU strings in `apps/web/src/i18n/messages/shell.ts`.
- Keep existing storage helpers unchanged unless a focused test proves a helper adjustment is necessary. Extend `apps/web/src/browser-game-storage.test.ts` for any such adjustment; retain exact guards and readback.
- Exercise the flow in an isolated tablet browser fixture with real frontend storage handling. Add a two-context replacement race check using the existing local fixture/verifier approach.

## Acceptance matrix
- Missing owner + blocked target: synchronized and unresolved unfinished records can both be explicitly discarded; correct target opens and old local record is absent after readback/reload.
- Missing owner + no target: confirmed discard returns to the portal.
- Cancel confirmation: identical local record retained; no navigation or remote mutation.
- Normal available owner + unresolved record: release remains blocked; explanation and owner navigation remain available.
- Other context already cleared: safely refresh and proceed only after verifying empty state.
- Other context replaced/changed/invalidated record: preserve replacement bytes, do not open the requested workspace over it, show feedback.
- Storage transaction unavailable, read/remove failure, target missing or club-list load failure: no false success; actionable feedback and safe retry/portal outcome.
- Duplicate taps cannot cause duplicate navigation or broaden deletion. No target-club game receives the old club's state.
- Reload cannot resurrect the discarded record; stale state is not immediately written back by a mounted workspace.

## Verification
After approval: `npm run test -w @mafia/web -- src/App.test.tsx src/browser-game-storage.test.ts` must exit 0 with all positive guards retained. Reproduce on an isolated tablet/WebKit fixture and desktop Chromium; exercise actual storage and dialog click, inspect after reload and test a second-context replacement. Do not infer iPad coverage solely from desktop Chromium viewport size. Save evidence under `.AI/`. Run `npm run check:local`, invoking required `npm run check` against a disposable database.

## Risks, boundaries and dependencies
Discard is intentionally destructive to the captured local record, so confirmation is mandatory and no live-user data should be touched for testing. This is not a fix for the separately planned game-save rejection diagnostics and must not absorb that plan. No schema migration, deployment, commit, push or issue mutation. If investigation requires broader persistence behavior changes, return to clarification and plan approval.

Implementation starts only after explicit approval in a later turn. Recheck source/Git first and remove this plan only after full verification.
