# Issue #53: server claim lease and stale-writer fencing

> **For agent:** REQUIRED SUB-SKILL: Use subagent-driven-development (fresh subagent per task, two-stage review) to implement this plan.

## Goal

Add an authenticated, club-scoped database lease to the sole active game so one browser generation can mutate it, explicit takeover advances the fence, and stale browsers are rejected without weakening exact mutation retries.

## Plain-language summary

The server will remember which signed-in browser currently controls the live game. That browser renews a 45-second lease; another browser can take over, which increments a generation number and immediately makes the old browser read-only.

## Dependency

Implement after [the single-active-session invariant](./2026-09-03_174007-issue-53-active-session-invariant.md).

## Contract

- Heartbeat interval: 15 seconds in the web client.
- Server lease expiry: 45 seconds from the latest successful acquire/renew/takeover.
- Credential: client-generated UUID claim ID plus server generation.
- Initial create: claim ID with generation `0`; the atomic insert returns generation `1`.
- Existing session writes: exact current claim ID and positive generation are required.
- Exact already-committed mutation retries are resolved before claim fencing; no new stale mutation is allowed.
- Conflict metadata contains holder display name, `claimedAt`, `lastSeenAt`, and `expiresAt` only.

## Scope

### 1. Add RED schema and lease-state tests

- Extend `apps/server/src/schema-migration.test.ts` to require additive claim columns on `game_sessions`:
  - `claim_id UUID`;
  - monotonic `claim_generation BIGINT NOT NULL DEFAULT 0`;
  - `claimed_by_user_id UUID` referencing `users`;
  - `claimed_at`, `claim_last_seen_at`, and `claim_expires_at` timestamps;
  - a check constraint that requires complete metadata and a positive generation when a claim ID is present, and null metadata when it is absent while retaining the last generation.
- Verify fresh install, representative populated upgrade with previously unclaimed active rows, previous-writer compatibility on the additive schema, and idempotent second run through catalog and data readback.
- Add store tests in `apps/server/src/game-session-store.test.ts` for first create-and-claim, exact renewal, expired acquisition, live conflict, takeover, stale renewal/write rejection, exact duplicate retry after takeover/completion, release, completion cleanup, and cross-club denial.
- Use database timestamps/readback (or controlled expiry-column updates in fixtures) rather than wall-clock sleeps.

### 2. Add claim types and atomic store operations

- Add claim input/result/conflict types and a typed `GameSessionClaimConflictError` in `apps/server/src/game-session-store.ts` (or a narrowly scoped sibling module only if extraction materially reduces the store file).
- Extend every game-session mutation input with the parsed claim credential.
- On the first `GameSessionStore.save` insert, atomically write generation `1`, the claim ID, authenticated user ID, and lease timestamps; reject generation other than `0`.
- For existing snapshots and semantic operations (`normalize`, `start`, append event, move head, complete, and active deletion):
  - check exact mutation retries first;
  - lock the session row;
  - require the current unexpired claim ID/generation before applying a new mutation;
  - return the stable claim conflict for missing, expired, or stale credentials without exposing the credential.
- Completion clears claim ID/user/timestamps in the same transaction while retaining the last generation. Session deletion removes the row and claim together.

### 3. Add acquire, renew, takeover, and release operations

- Implement row-locked store methods with these semantics:
  - **claim/renew:** the same live claim renews without changing generation; an unclaimed or expired row accepts the supplied claim ID and increments generation; a different live holder conflicts;
  - **takeover:** authenticated explicit takeover always increments generation and replaces holder/timestamps atomically;
  - **release:** only the exact current credential clears ownership; stale release is rejected or returns the same stable conflict, never clears a newer holder.
- Heartbeats update only lease columns. They must not increment game revision, insert mutation rows, change canonical events, or alter results/statistics.
- Read the current holder name from `users.display_name`; do not denormalize or return email/user IDs.

### 4. Expose and protect the HTTP contract

- Add strict Zod parsing in `apps/server/src/game-session-validation.ts` and/or `apps/server/src/app.ts` for `x-game-claim-id` and `x-game-claim-generation` on mutation routes.
- Add authenticated, selected-club endpoints in `apps/server/src/app.ts`:
  - `POST /api/game-sessions/:gameId/claim` for acquire/renew;
  - `POST /api/game-sessions/:gameId/takeover` for explicit takeover;
  - `DELETE /api/game-sessions/:gameId/claim` for exact release.
- Pass the authenticated user's ID only after existing selected-club authorization succeeds.
- Include the current claim generation/expiry in successful create/mutation/claim responses needed by the holder; include only safe holder/timing metadata in `409 game_session_claim_conflict` responses.
- Require claim headers on all authoritative session mutations, including active-session delete. Keep read/list endpoints claim-free.

### 5. Add RED/GREEN API contract coverage

- Extend `apps/server/src/app.test.ts` to prove:
  - unauthenticated and wrong-club claim requests fail before row details leak;
  - initial create returns generation `1`;
  - second live claimant receives safe structured conflict metadata;
  - renew keeps generation, takeover increments it, and stale headers fail on both heartbeat and every representative write class;
  - an exact duplicate mutation remains readable after the holder was displaced, while a new mutation with the old fence fails;
  - expiry allows acquisition without a force flag;
  - completion/reasoned terminal paths and delete clear/remove the claim;
  - response bodies never contain claim IDs, user IDs, emails, cookies, or secret event data for a conflicting browser.
- Follow vertical RED→GREEN slices: first create/renew, then conflict/takeover, then write fencing, then cleanup/isolation.

## Non-goals

- WebSocket or push notifications.
- Collaborative/multi-writer sessions.
- Treating the claim as a replacement for login, club membership, CSRF, revision checks, or mutation IDs.
- Rewriting canonical game events or browser-authoritative snapshot semantics.
- Browser dialog and heartbeat orchestration; those belong to the next plan.

## Verification

- Focused RED/GREEN runs for each new store/API behavior.
- `npm run test -w @mafia/server -- schema-migration.test.ts game-session-store.test.ts app.test.ts` (split by file if required by Vitest argument handling).
- `npm run typecheck -w @mafia/server`.
- Inspect database readbacks to confirm heartbeat changes only claim timestamps and completion clears claim metadata without duplicating result rows.
- Later, after all #53 plans are integrated: `npm run check`.

## Done when

- One live generation can write, takeover fences it out, expiry recovers abandoned sessions, and exact retries remain idempotent.
- Every claim operation is authenticated and club-scoped.
- Conflict metadata is sufficient for the prompt but contains no credential or private game data.
