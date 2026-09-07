# Game-save rejection diagnostics implementation plan

## Plain-language summary
Expose the actual HTTP status and safe server error details when saving a game fails, so the iPad's queued completed game can be diagnosed without resetting it, rewriting its history, or guessing that it is offline. This plan does not yet fix the unknown rejection or upload the user's game.

## Goal
Make the failing save of La Verdad / 06.09.26 #2 diagnostically actionable while preserving its local unsynced state.

## Status and approval
Diagnostics were approved, but the user subsequently expanded the request to diagnosis, a verified save fix, richer console errors, and production delivery. The expanded plan set is `.AI/plans/2026-09-07_173402-game-save-index.md`; its approval boundary governs further work. This file retains the original investigation and diagnostic implementation steps. Existing-game recovery is not required by the user; this is not permission to delete unrelated data. The original failing iPad request has not been captured.

Current evidence supersedes the live-state assumptions below: main and origin/main are now fa275e3c161e0a189581767177389a624123b591, whose production release succeeded. The local game row is absent, and deleted_games contains its UUID with deleted_at 2026-09-06 18:37:35.936209+02. The user confirms the iPad still restores the game and cannot upload. A tombstone is an additional present-day upload blocker, not an explanation of the earlier 17:41 failure. Preserve deletion safeguards.

## Confirmed evidence
- User reports the completed game survives refreshing the iPad page. Screenshot says Citizens won, Game saved on this device / reconnect to upload, and Game saved offline.
- Local repository: main at ad19114; source clean at start; unrelated untracked .AI artifacts exist and must remain untouched.
- GET /health/ready returned HTTP 200 and {"status":"ready"} through 127.0.0.1:3000, 127.0.0.1:5173, and https://mbp16.tail102fab.ts.net. These checks originate from the Mac, not the iPad.
- A BEGIN READ ONLY query scoped to club name La Verdad found game b1b06ce2-706d-4880-a478-28ebcbfee35d, name 06.09.26 #2, revision 38, status active, phase voting, day 1, results NULL, updated_at 2026-09-06 17:41:11.231326+02. Its claim_last_seen_at was 2026-09-06 18:31:20.070337+02. Server communication therefore continued after game-state saves stopped; a heartbeat is not proof of successful state persistence.
- Revision 38's stored request validates against gameSessionMutationSchema when its separately stored mutation_id is restored as mutationId. No database changes were made.
- Screenshot error text is the fallback from saveGameSessionOperation after a non-OK HTTP response (apps/web/src/api/client.ts:523), rather than the native fetch network exception text.
- ApiError retains HTTP status and error code, but the console records only message/stack. Validation issue details are discarded by throwApiError.
- SessionRetryController maps both non-retryable rejection and exhausted transient failures to phase offline, distinguished internally by terminalReason. Auto-sync deliberately stops in this phase; manual retry uses the toolbar save button.
- GameScreen's queued completion presentation does not distinguish rejection from connection failure.
- Fastify logger is disabled; the current process writes to .AI/local-backend/dev-final.log, which has no request-level failure evidence. No ERROR/FATAL matches were found in the local PostgreSQL log.

## Additional reproduced mismatch — deferred, not the established incident cause
A read-only in-memory probe loaded the revision-38 request from PostgreSQL using pg and imported the domain functions plus gameSessionMutationSchema using tsx. It checked the saved request, advanced through voting candidates, and toggled each active seat independently at each candidate. Of 33 probes, 10 failed: toggling off a final candidate's automatically assigned vote is allowed by toggleVote and VotingStage, but rejected by the server with path state.game.voteAssignments and message "The final voting candidate must receive every remaining active vote". Other probes passed. This demonstrates a client/server contract mismatch, NOT that the user performed this action or that it explains the current completed snapshot's rejection. Do not weaken voting validation or change voting behavior in this plan.

## Scope
1. Preserve bounded, explicitly allowlisted diagnostic metadata on ApiError: HTTP status, machine error code, and safe validation issue paths/categories. Do not retain arbitrary response bodies, headers, cookies, claims, game snapshots, or unbounded strings. Existing claim-conflict details must keep their current shape and behavior.
2. Include that metadata in the existing error console for genuine ApiError instances. Prefer the smallest explicit representation consistent with console redaction and length limits; do not stringify arbitrary Error properties.
3. After approval and local verification, obtain the next failing iPad save's diagnostic entry using the existing toolbar retry. Do not clear/reset/take over the game. Have the user perform the retry if the iPad cannot be inspected directly.
4. Record the exact response status/code/path, then stop and refine a separate repair plan against that evidence.

## Non-goals
- No database writes, forced completion, replacing the local snapshot, claim takeover, or deleting queued operations.
- No game rules, replay validation, retry policy, offline-storage schema, statistics, authentication, or club-isolation changes.
- No completion-screen copy redesign; misleading offline wording is recorded for follow-up.
- No implementation of the separate final-candidate voting mismatch without clarification and its own plan.
- No release actions within this diagnostic step. The expanded plan set separately specifies scoped commit/push and production deployment after repair and verification. No dependency changes.

## Relevant source and tests
- apps/web/src/api/client.ts: ApiError, throwApiError, saveGameSessionOperation.
- apps/web/src/api/client.test.ts: API error preservation and privacy regression tests.
- apps/web/src/features/console/error-console.ts and error-console.test.ts: structured safe error reporting and existing redaction tests.
- apps/server/src/app.ts:124: validationFailure response format; read-only reference unless later evidence requires a separate server change.
- apps/web/src/session-retry.ts and session-retry.test.ts: rejection/retry semantics; preserve behavior.
- apps/web/src/session-outbox.ts:442,575: snapshot coalescing and flush; preserve behavior.
- apps/web/src/App.tsx:1900,2166: rejected save label and toolbar retry.
- apps/web/src/features/game/GameScreen.tsx:279,365: queued completion display.

## Implementation steps after approval
1. Read ApiError definition, API tests, console tests, and console rendering in full before choosing the minimal metadata representation.
2. Add focused regression tests showing that a failed save's HTTP status and safe machine/validation identifiers survive reporting. Include a response containing sensitive/unexpected fields to prove those fields never appear, and retain existing conflict-handling contracts.
3. Implement minimal client/console-only diagnostic preservation. Do not include free-form server validation messages if they could contain payload data; allowlist schema field paths and issue categories instead.
4. Run focused tests: npm run test -w @mafia/web -- src/api/client.test.ts src/features/console/error-console.test.ts src/session-retry.test.ts src/session-outbox.test.ts.
5. Run npm run check, using the repository's isolated database verification workflow if server tests require a test database; never point destructive tests at mafia_local. Read scripts/test-local.mjs and related instructions before configuring this.
6. Coordinate the iPad retry and capture only sanitized diagnostics. This is an explicit verification checkpoint: automated tests alone do not identify the user's current save failure.
7. Present the actual cause if established, or the remaining evidence blocker, and save a separately scoped recovery/fix plan for approval. Remove this plan only once its own acceptance criteria are verified.

## Acceptance criteria / Definition of Done
- Existing console displays a genuine failed save's HTTP status and safe error code/path without exposing secrets, personal data, or game payloads.
- Existing error redaction, conflict handling, retry behavior, and durable outbox preservation remain intact and focused tests pass.
- npm run check passes, with no tests targeting the live local database.
- The actual iPad failure's safe diagnostic result is captured; if this is inaccessible, report that blocker rather than claim incident diagnosis or game recovery.

## Risks and open questions
- The exact status/code and rejected payload remain unknown; possibilities include validation, operation rejection, or internal application failure. Do not infer a specific code from the offline label.
- Safari/iPad state is not automatically accessible from the Mac. User participation may be needed for one retry and screenshot.
- This is a live Vite app; implementation could hot-reload the iPad. Coordinate before changing source, keep the tab/browser data intact, and never assume local backup integrity beyond the observed successful refresh restoration.
- A later fix must verify completed results persisted once, full canonical history retained, and no duplicate statistics; those recovery criteria are deliberately outside this diagnostic-only plan.
