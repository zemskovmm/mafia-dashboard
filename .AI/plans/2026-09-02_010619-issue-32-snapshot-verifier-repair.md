# Issue 32 Snapshot-Verifier Repair Plan

> **For Hermes:** Execute with strict RED–GREEN–REFACTOR after explicit approval. Change only the three files named below. If the authenticated verifier still fails for a reason outside browser-authoritative snapshot request recognition, stop and return to plan mode.

**Goal:** Make the authenticated restart/cleanup verifier wait for the current browser-authoritative day snapshot instead of an obsolete event-era start response.

**Architecture:** Add a small pure contract that recognizes the required `PUT /api/game-sessions/:id` snapshot by method, exact path shape, materialized day phase, and lifecycle-root event. Test that contract first, then use it in `verify-session-state.mjs` when awaiting the initial durable day save. Keep application, API, persistence, ownership, and cleanup behavior unchanged.

**Tech Stack:** Node.js ESM, `node:test`, Playwright response/request APIs, existing session-verifier contracts.

**Plain-language summary:** The application now saves full game snapshots, but the verifier still waits for an older start-event request that is never sent. We will teach only the verifier and its tests to recognize the current day snapshot, then prove the real authenticated flow completes and cleans up.

**Observed failure:** On frozen tree `c82b32a89ff2996046aef07051ef24f82a96a65a`, `npm run verify:session` timed out at `scripts/verify-session-state.mjs:453`. The predicate requires `POST` and a path ending `/start`. `apps/web/src/session-outbox.ts` now emits `snapshot` operations, and `apps/web/src/api/client.ts:491-498` sends those operations as `PUT /api/game-sessions/:id` with full `state` and `results`. Therefore the required response cannot match.

**Files:**
- Modify: `scripts/session-verifier-contracts.test.mjs`
- Modify: `scripts/session-verifier-contracts.mjs`
- Modify: `scripts/verify-session-state.mjs`

**Non-goals:** Changing application or API behavior; restoring event-era `POST /start` persistence; changing schemas, migrations, dependencies, browser UI, ownership policy, or cleanup semantics; weakening the verifier to accept any successful request; modifying #17 or #23.

---

### Task 1: RED — specify the authoritative day-snapshot request

**Objective:** Add one behavioral regression test that fails because no day-snapshot request classifier exists yet.

**Steps:**
1. In `scripts/session-verifier-contracts.test.mjs`, import the wished-for pure contract `isAuthoritativeDaySnapshotRequest`.
2. Add a focused test whose valid request has:
   - method `PUT`;
   - pathname `/api/game-sessions/<UUID>` with no suffix or query ambiguity;
   - JSON body containing `state.game.phase === "day"`;
   - `state.events` containing a root `game.started` or `game.checkpointed` event;
   - `results: null`.
3. In the same focused test, prove that wrong method, wrong path, non-day state, malformed events, or a missing lifecycle root do not satisfy the contract. These cases define one classifier boundary rather than testing source-text absence.
4. Run `npm run test:verifier-contracts` and require an expected failure because the new export is missing. Record the failing test name and message.

**Expected result:** A genuine RED caused by the missing contract, not syntax, import-path, or fixture errors.

### Task 2: GREEN — implement and use the minimal contract

**Objective:** Replace the stale endpoint-specific wait with the tested full-snapshot predicate.

**Steps:**
1. In `scripts/session-verifier-contracts.mjs`, implement `isAuthoritativeDaySnapshotRequest({ method, pathname, body })` with the exact boundary from Task 1. Reuse the module's existing UUID validation convention; do not accept nested paths or a non-object body.
2. In `scripts/verify-session-state.mjs`, import the contract.
3. Keep the listener armed before the Mafia-planning, Sheriff wake-up, and day-one clicks, but make `startSave` pass the Playwright request method, URL pathname, and parsed JSON body to the new contract.
4. Treat an unparsable request body as a non-match rather than crashing the response predicate.
5. Do not alter `waitForSaved`, response failure tracking, ownership checks, resource creation, canonical readback assertions, reset probes, browser restart, or cleanup.
6. Run `npm run test:verifier-contracts`; require GREEN.

**Expected result:** The unit contract passes and the verifier waits for the durable day snapshot that the current outbox actually sends.

### Task 3: Verify the real authenticated path

**Objective:** Prove the repair against the same kind of disposable authenticated application stack that exposed the defect.

**Steps:**
1. Run formatting/lint checks focused on the three modified files through the repository commands that cover them.
2. Launch a unique local Compose stack with a disposable PostgreSQL volume, exact localhost `PUBLIC_APP_URL`, placeholder Google client values, and an ephemeral hashed application-session token for the schema-seeded owner/default club. Never print or persist the raw token.
3. Run `APP_URL=<local-url> SESSION_AUTH_COOKIE="mafia_session=<ephemeral-token>" SESSION_CLUB_ID="00000000-0000-4000-8000-000000000101" npm run verify:session`.
4. Require the verifier to pass the initial save, authoritative day readback, reset/readback, browser restart, local-envelope equality, new-game cleanup, and final ownership cleanup.
5. Query active/completed sessions and players and require no run-owned records remain.
6. Tear down the Compose project with volumes/orphans and verify its containers and volumes are absent.
7. If this reveals another stale assumption within the same three-file snapshot-recognition boundary, add a new RED before the minimal correction. If it requires application code or another path, stop and return to plan mode.

**Expected result:** `verify:session` passes against a real authenticated local stack and leaves no run-owned data or infrastructure.

## Acceptance criteria

- A focused contract test was observed failing before implementation and passing afterward.
- The required-save predicate positively identifies only a full day snapshot at `PUT /api/game-sessions/:id` with a lifecycle root.
- The runtime verifier uses the shared tested predicate.
- The authenticated end-to-end verifier passes against disposable PostgreSQL/Compose infrastructure.
- No run-owned player, game session, container, or volume remains.
- No file outside the three approved verifier paths changes.

## Risks and stop conditions

- A broad `PUT` match could create a false pass; the phase and lifecycle-root checks are mandatory.
- Playwright `postDataJSON()` can throw; malformed/non-JSON traffic must be a non-match.
- Do not classify application failure as verifier drift without authoritative API/readback evidence.
- Any required application, API, schema, dependency, or fourth-file change is material scope drift and requires a new plan approval.
