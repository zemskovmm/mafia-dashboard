# Offline Game Session Retry Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Keep a live Mafia game fully playable through completion when the server becomes unreachable, while the Save toolbar icon gives clear green/yellow/red state and acts as the manual reconnect/retry control.

**Architecture:** Keep `GameSessionOutbox` as the ordered, idempotent local operation queue, but stop calling its one-shot `flush()` directly from every React path. Add a small retry coordinator that owns one bounded retry sequence, exposes a UI snapshot, suppresses overlapping attempts, and latches local-only/offline mode after retries are exhausted. Store the outbox in `localStorage`, make gameplay mutations local-first, and reconcile a locally completed game after its queued completion reaches the server.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, browser `localStorage`, Fetch/AbortController, existing Fastify `/health/ready` endpoint.

---

## Current Context and Findings

- The supplied screenshot shows many identical `Unable to save the game session operation` entries at the same timestamp from `game-session.auto-flush` and `apps/web/src/api/client.ts`.
- `apps/web/src/App.tsx:737-796` currently calls `flush()` immediately and reports every rejection, so repeated render-triggered saves can flood the Console.
- `apps/web/src/session-outbox.ts` already provides the important data-safety primitives:
  - ordered queued operations;
  - stable `mutationId` values and `baseRevision` values;
  - persisted canonical state plus pending operations;
  - idempotent server retry behavior;
  - stale-tab and late-response protections.
- The outbox is currently constructed with `window.sessionStorage` at `apps/web/src/App.tsx:321-333`; closing the tab can therefore discard an unsynced offline game.
- The toolbar already contains a Save icon at `apps/web/src/App.tsx:1523-1531`, but it is a non-interactive `<div>`.
- `GameSessionOutbox.status` at `apps/web/src/session-outbox.ts:616-631` changes to `offline` after the first failed request; there is no bounded retry state.
- Reset/undo paths await the server before changing the local head (`apps/web/src/App.tsx:924-1013`), and final completion waits for the server before leaving the game (`apps/web/src/App.tsx:1015-1061`). Those paths prevent complete offline operation.
- The server already exposes `/health/ready` and tests it in `apps/server/src/app.test.ts:240-248`; no server route or schema change should be needed.
- The working tree contains substantial unrelated, uncommitted UI/music changes. Implementation must patch only the persistence-related regions and must not revert, reformat, commit, or stage the existing work.

## Product Behavior Contract

1. **Green — saved:** the local outbox is empty and the most recent save/probe reached a ready server.
2. **Yellow — saving/retrying:** a save or readiness probe is in flight, or the app is waiting for the next bounded retry after an error. The accessible label states the attempt, for example `Save retry 2 of 3 · 4 changes pending`.
3. **Red — offline/local-only:** three transient attempts have failed, or a non-retryable server rejection prevents saving. Automatic network requests stop, all subsequent game changes continue to be queued locally, and the label states that the changes are safe on this device.
4. Use **three total attempts per automatic sequence**: immediate attempt, retry after 1 second, retry after 2 seconds. Give each persistence/readiness request a 4-second timeout so the icon cannot remain yellow forever.
5. Do not use `navigator.onLine` as proof of connectivity. A successful game-session write proves connectivity when work is pending; `/health/ready` is the probe when the queue is empty.
6. Clicking the Save button at any time starts a fresh sequence immediately. It cancels a pending backoff timer, never creates a second concurrent request, flushes pending operations first, and otherwise probes `/health/ready`.
7. New gameplay actions while red stay local and **do not** restart automatic retries. The host explicitly retries with the Save button.
8. Retry network errors, timeouts, HTTP 408/425/429, and HTTP 5xx. Treat other HTTP 4xx responses as terminal for that sequence; keep the data local and expose a specific accessible/title message rather than pretending the server is merely slow.
9. Report one aggregated persistence error when entering terminal offline/local-only state. Do not add one Console card per attempt or per React state change.
10. Completing a game offline records `game.completed` and final results locally, displays `Game saved on this device · reconnect to upload`, and prevents duplicate completion events. When a later retry drains the completion, clear the local completed aggregate, refresh lists/statistics best-effort, and return to setup exactly once.
11. Forward actions, undo, reset, and finish are local-first. Network failure must not block the game UI.
12. The guarantee is for an app that has already loaded. This plan preserves game data across reload/tab loss, but it does not add a service worker for a cold launch while the web server itself is unreachable.

---

### Task 1: Specify the Retry Coordinator with Failing Unit Tests

**Objective:** Lock down bounded attempts, status transitions, and concurrency before integrating React.

**Files:**
- Create: `apps/web/src/session-retry.test.ts`
- Create later: `apps/web/src/session-retry.ts`

**Steps:**

1. Write fake-timer tests for a controller with an injected `flush`, `probe`, `pendingCount`, scheduler, and terminal-error callback.
2. Verify a transient failure sequence makes exactly three calls at 0 ms, +1,000 ms, and +2,000 ms, remains yellow through backoff, then becomes red.
3. Verify a second-attempt success drains the queue and becomes green without invoking the terminal-error callback.
4. Verify an HTTP 400-style `ApiError` enters terminal local-only state immediately, while 408/425/429/5xx remain retryable.
5. Verify repeated automatic requests and repeated enqueue notifications share one in-flight promise/timer rather than creating parallel flushes.
6. Verify new automatic requests are ignored after the red latch, but `retryNow()` resets the attempt counter and starts immediately.
7. Verify clicking while a request is actually in flight does not duplicate that request; clicking during backoff cancels the wait and advances immediately.
8. Verify manual retry calls the readiness probe only when `pendingCount() === 0`; successful pending writes do not need a redundant probe.
9. Verify `dispose()` cancels timers and ignores late promise completions so a remounted club cannot inherit state changes.
10. Run the new test and confirm RED because `session-retry.ts` does not yet exist:
   - `npm run test -w @mafia/web -- src/session-retry.test.ts`

### Task 2: Implement the Bounded Retry State Machine

**Objective:** Add one testable owner for automatic retry/offline transitions.

**Files:**
- Create: `apps/web/src/session-retry.ts`
- Test: `apps/web/src/session-retry.test.ts`

**Steps:**

1. Define a read-only snapshot containing:
   - phase: `saved | saving | retrying | offline`;
   - current attempt and maximum attempts;
   - pending operation count;
   - optional next-retry time;
   - terminal reason category (`unreachable` or `rejected`) without retaining response bodies/secrets.
2. Implement `requestAutoSync()`, `retryNow()`, `subscribe()`, `getSnapshot()`, and `dispose()`.
3. Use one generation/token plus one active promise and one timer. A late attempt from an obsolete generation must not change state.
4. Keep `GameSessionOutbox.flush()` as the existing one-attempt primitive. The coordinator, not the outbox, owns retry timing and status policy; this avoids destabilizing the outbox’s extensive revision/race tests.
5. Consume all expected retry rejections inside the controller so they cannot become `unhandledrejection` Console entries.
6. Call the injected terminal reporter only once when a sequence becomes red.
7. Run `npm run test -w @mafia/web -- src/session-retry.test.ts`; expected: PASS.

### Task 3: Add a Real Server Readiness Probe and Request Timeout

**Objective:** Let a green or red Save button verify the server even when there is nothing to write, and prevent hung fetches.

**Files:**
- Modify: `apps/web/src/api/client.ts:230-265,372-455`
- Modify: `apps/web/src/api/client.test.ts:169-335`

**Steps:**

1. Add a small private timeout wrapper using `AbortController`; clear its timer in `finally`.
2. Apply the 4-second timeout to `saveGameSession`, `saveGameSessionOperation`, and the new readiness request. Preserve the exact existing request URL, body, club header, and stable mutation IDs.
3. Export `checkServerReady(): Promise<void>` using `GET /health/ready`; reject via `ApiError` for a non-2xx response.
4. Add client tests that verify the endpoint, successful readiness, non-2xx rejection, and timeout/abort cleanup without exposing response bodies.
5. Run `npm run test -w @mafia/web -- src/api/client.test.ts`; expected: PASS.

### Task 4: Make the Local Outbox Survive Tab Loss

**Objective:** Preserve the current game and pending writes in durable browser storage while retaining logout and club isolation.

**Files:**
- Modify: `apps/web/src/App.tsx:123-159,321-333,2114-2162`
- Modify: `apps/web/src/App.test.tsx:676-702` and persistence assertions around `1737-2216`
- No envelope schema change expected in `apps/web/src/session-outbox.ts`

**Steps:**

1. Before constructing `GameSessionOutbox`, migrate the selected club’s v4 and legacy v3 raw values from `sessionStorage` to `localStorage` only when the destination key is absent.
2. Confirm the destination contains the exact bytes before deleting the source. If a destination already exists, treat it as authoritative and do not overwrite it with a second game.
3. Construct the outbox with `window.localStorage`.
4. Update sign-out to remove game-session v3/v4 keys from both local and session storage while leaving unrelated browser data intact.
5. Update club deletion to remove that club’s game keys from both stores. Keep `Clear all data` behavior clearing both stores.
6. Change App integration tests to inspect `localStorage`, and add a remount/migration test proving an existing session-storage game is restored once and then retained in local storage.
7. Keep club-specific key suffixes unchanged so games remain strictly isolated by club.
8. Run the focused lifecycle tests in `App.test.tsx`; expected: migrated/restored state and cleanup tests PASS.

### Task 5: Replace Direct Auto-Flush Calls with the Coordinator

**Objective:** Stop retry storms and make one persistence state authoritative throughout `ClubWorkspace`.

**Files:**
- Modify: `apps/web/src/App.tsx:321-335,491,700-796`
- Modify: `apps/web/src/App.test.tsx`

**Steps:**

1. Create one coordinator next to the existing outbox ref, injecting:
   - `sessionSync.flush()`;
   - `checkServerReady()`;
   - `sessionSync.pendingCount`;
   - one terminal `reportError` call with context `game-session.offline`.
2. Subscribe React to both outbox and coordinator snapshots; dispose the coordinator on club-workspace unmount.
3. Replace the initial `flush().catch(reportError)` and auto-flush `flush().catch(reportError)` calls with `requestAutoSync()`.
4. Preserve the current enqueue effect and idempotent outbox operations, but ensure coordinator red state remains latched while more actions enqueue locally.
5. On mount with an existing pending outbox, begin one fresh automatic three-attempt sequence.
6. Remove per-attempt `game-session.initial-flush` and `game-session.auto-flush` reports. Keep unexpected local serialization/invariant errors reportable.
7. Add tests proving:
   - one gameplay action cannot create overlapping save loops;
   - exactly three transient attempts occur;
   - only one terminal Console entry appears;
   - state stays red as further game actions are recorded locally;
   - a successful manual retry drains operations in order and turns green.

### Task 6: Make Undo, Reset, and Completion Local-First

**Objective:** Remove server availability from all live-game progression paths.

**Files:**
- Modify: `apps/web/src/App.tsx:924-1086,1288-1319`
- Modify: `apps/web/src/App.test.tsx:1839-1965`
- Modify: `apps/web/src/features/game/GameScreen.tsx:23-35,241-249,306-321`
- Modify: `apps/web/src/features/game/GameScreen.test.tsx:642-671`

**Steps:**

1. Replace `persistHeadMove(): Promise<boolean>` with a synchronous local queue operation:
   - enqueue the desired head/reset/results state first;
   - apply `moveHeadLocally` immediately;
   - request background sync without awaiting it.
2. Update reset and undo handlers to use the local-first operation. Preserve current confirmation dialogs, branch history, undo budgets, and outbox conflict recovery.
3. Refactor finish state so it is derived from final results plus persistence phase rather than treating a network rejection as a failed game:
   - `ready` before confirmation;
   - `saving` while yellow;
   - `queued` when final results are local and the coordinator is red;
   - `saved` only after server acknowledgement (normally followed by reset).
4. On `Finish the game`, append `game.completed`, calculate results, enqueue both operations, and return control immediately. Do not append another completion event on repeated taps.
5. In `GameScreen`, replace `Game was not saved` with truthful local durability text such as `Game saved on this device · reconnect to upload`; disable the completion button once completion is queued and direct retry behavior to the toolbar Save button.
6. Add one idempotent completion-reconciliation function called after a successful drain:
   - if queued final results exist and the outbox is empty, clear the local aggregate and reset to setup once;
   - refresh players and active sessions best-effort after the server accepted completion;
   - report refresh failures separately without resurrecting or duplicating the completed game.
7. Add tests that start online, lose connectivity, continue through meaningful actions, undo/reset, finish, remount from local storage, restore connectivity, click Save, and observe exactly one server completion plus return to setup.

### Task 7: Turn the Save Indicator into the Retry Button

**Objective:** Implement the requested green/yellow/red status and manual reconnect interaction without changing toolbar geometry.

**Files:**
- Modify: `apps/web/src/App.tsx:1427,1513-1531`
- Modify: `apps/web/src/styles/app.css:315-347,2311-2352`
- Modify: `apps/web/src/App.test.tsx`

**Steps:**

1. Replace the Save `<div>` with a native `<button type="button">` using `retryNow()`.
2. Preserve the existing 44×44/46×46 toolbar dimensions and Save glyph.
3. Map colors:
   - `saved` → `var(--green)`;
   - `saving` and `retrying` → `var(--amber)`;
   - `offline` → `var(--red)`.
4. Add visible focus, hover, pressed, and `aria-busy` behavior consistent with neighboring toolbar buttons. Do not disable the button during backoff; a tap should retry immediately. Ignore duplicate taps only while a request is already in flight.
5. Generate explicit labels/titles:
   - `Saved to server · tap to check connection`;
   - `Saving · N changes pending`;
   - `Save failed · retry 2 of 3 · N changes pending`;
   - `Offline · N changes safe on this device · tap to retry`;
   - terminal non-transient rejection: `Save blocked · N changes safe on this device · tap to retry`.
6. Use a polite live region so state changes are announced without converting the button back into a non-interactive status element.
7. Add Testing Library assertions for the native button role, labels, click behavior, pending count, and status data attribute.
8. Add a focused browser check at iPad landscape dimensions to verify the icon remains aligned with the existing toolbar and all three colors are clearly distinguishable in the active theme.

### Task 8: Regression and Acceptance Verification

**Objective:** Prove both data safety and the exact user flow before declaring completion.

**Files:**
- Tests above; avoid changing unrelated UI/music files except shared regions already modified in the working tree.

**Automated verification:**

1. Retry and API contracts:
   - `npm run test -w @mafia/web -- src/session-retry.test.ts src/api/client.test.ts`
2. Durable queue/race invariants:
   - `npm run test -w @mafia/web -- src/session-outbox.test.ts`
3. UI and full offline lifecycle:
   - `npm run test -w @mafia/web -- src/features/game/GameScreen.test.tsx src/App.test.tsx`
4. Web package gates:
   - `npm run typecheck -w @mafia/web`
   - `npm run build -w @mafia/web`
5. Once focused tests are green, run the complete web suite:
   - `npm run test -w @mafia/web`

**Browser acceptance scenario:**

1. Load and start a game while the server is reachable; verify green Save.
2. Block game-session requests or stop the server, then perform a game action.
3. Verify yellow immediately, exactly three requests with bounded backoff, no request storm, and one Console error only after the final failure.
4. Verify red and a tooltip/label saying changes are safe locally.
5. Continue all the way through the game, including an undo/reset, and press `Finish the game`; verify the completed result is retained locally and no controls are blocked by connectivity.
6. Reload/remount and verify the same completed game and pending operations restore from local storage.
7. Tap red Save while still disconnected; verify it retries and returns to red without duplicating operations.
8. Restore the server and tap Save; verify operations replay in order with the original mutation IDs, the icon becomes green, exactly one completion is recorded, statistics refresh, and the app returns to setup.
9. Tap green Save with no pending operations; verify `/health/ready` is actually requested and the icon returns yellow → green.
10. Sign out and verify all club game-session keys are removed from both browser stores while unrelated local data remains.

## Files Likely to Change

- Create `apps/web/src/session-retry.ts`
- Create `apps/web/src/session-retry.test.ts`
- Modify `apps/web/src/api/client.ts`
- Modify `apps/web/src/api/client.test.ts`
- Modify `apps/web/src/App.tsx`
- Modify `apps/web/src/App.test.tsx`
- Modify `apps/web/src/features/game/GameScreen.tsx`
- Modify `apps/web/src/features/game/GameScreen.test.tsx`
- Modify `apps/web/src/styles/app.css`
- `apps/web/src/session-outbox.ts` should remain unchanged unless implementation reveals a missing read-only signal; its existing persistence and race behavior should be reused, not rewritten.

## Risks and Tradeoffs

- **Cold offline launch:** local state survives, but without a service worker the browser may not be able to reload the app shell while the host itself is unreachable. That is intentionally outside this focused change.
- **Local storage privacy:** game state now survives tab closure. Sign-out, club deletion, and Clear all data must therefore clear the correct keys from both stores.
- **Storage conflict during rollout:** never overwrite an existing local aggregate with a session-storage aggregate. Prefer preserving the already durable value over attempting an unsafe merge.
- **Late network responses:** controller generation checks and the outbox’s existing mutation/race guards must both remain in place.
- **Non-retryable server errors:** the UI uses the same red local-only safety mode but must not label an authenticated/validation rejection as mere network loss in its accessible text.
- **Completed-game cleanup:** only clear local state after the complete operation is acknowledged. A successful health probe alone is not sufficient.
- **Working-tree overlap:** `App.tsx`, `App.test.tsx`, `GameScreen.tsx`, `GameScreen.test.tsx`, and `app.css` already contain unrelated edits. Apply narrow patches and inspect the diff after each task; do not reformat whole files.

## Implementation Constraint

Do not create commits, stage files, push, or rewrite history unless Michael explicitly asks. Keep all existing uncommitted work intact.
