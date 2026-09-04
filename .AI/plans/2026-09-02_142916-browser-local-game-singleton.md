# Issue #52 Browser-local Game Singleton Implementation Plan

> **For Hermes:** Implement this plan task-by-task with strict RED-GREEN-REFACTOR cycles from the `test-driven-development` skill. Do not broaden the issue when unrelated findings appear.

**Goal:** Replace club-scoped browser game aggregates with one validated localStorage record that owns exactly one club/game attachment, restores that owner first, and cannot be overwritten without an explicit safe release or clear decision.

**Architecture:** Advance the durable aggregate from v4 to a browser-wide v5 envelope with required `clubId` and `gameId` ownership. Keep canonical envelope validation and outbox mutation safety in `session-outbox.ts`; add a small pure browser-storage coordinator for bounded v3/v4 discovery, deterministic migration, conflict resolution, owner lookup, and local release. `App` will run that coordinator after authenticated clubs load, auto-open the owning club on reload, and gate attempts to open another club before a mismatched `ClubWorkspace` can mount. `ClubWorkspace` will use the one global v5 key and reject a different game ID even when the current record is fully synced.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, the existing `GameSessionOutbox`/claim/retry controllers, browser Storage APIs, and the English/Russian message catalog.

**Non-goals:** Cross-browser or cross-device exclusivity, leases, takeover semantics, or server locking (#53 already owns that boundary); changing PostgreSQL/API contracts; moving player/music/theme preferences; deleting a server game merely to release this browser; adding routes, dependencies, deployments, or a pull request.

---

## Plain-language summary

The browser will keep one local game record for the whole application instead of one per club. Reloads will return to that game’s club, other clubs/games cannot replace it behind the host’s back, old v3/v4 records migrate once without losing offline changes, and the host gets an explicit recovery/release choice when old records conflict or the owning club is unavailable.

## Selection and current context

- Selected [GitHub issue #52](https://github.com/zemskovmm/mafia-dashboard/issues/52), `[Persistence] Enforce one durable local game per browser`.
- It is the repository’s only open issue, has the expected `type:feature`, `area:frontend`, `area:data`, and `priority:P1` labels, and has no comments, assignee, milestone, or Project item. Its prerequisite #50 and related club-lock issue #53 are both closed, so it is implementation-ready and necessarily the highest-priority ready item.
- Local `main`, `origin/main`, and the canonical remote all point to `3ab810850aed528bc7c700049d629008b8f9682f`. The only working-tree state is the pre-existing untracked `.AI/plans/` set; delivery must preserve the shared plan index and transport only this issue’s approved plan pair.
- `App.tsx` currently derives a v4 and v3 key per club and migrates only the selected club’s matching sessionStorage keys during `ClubWorkspace` render (`apps/web/src/App.tsx:208-210,279-307,459-515`). Consequently the parent cannot identify the owner before mounting a workspace.
- `GameSessionOutbox` validates v4/v3 records, preserves offline operations, checks concurrent storage changes, and refuses restore only while changes are unresolved (`apps/web/src/session-outbox.ts:20-68,116-164,766-850,975-1005,1119-1174`). A fully synced game can therefore still be replaced by `restore` with another game ID.
- The host can leave a workspace and open another club (`apps/web/src/App.tsx:1721-1725,2926-2991`); a new `ClubWorkspace` then reads that club’s independent aggregate. Starting a new game explicitly clears the current server session, while remote resume currently has no browser-wide attachment guard (`apps/web/src/App.tsx:1583-1651,1798-1816,2050-2114,2319-2340`).
- Completion clears the active outbox, sign-out scans v3/v4 game keys in both storage areas, club deletion removes only that club’s v3/v4 keys, and Clear all browser data intentionally clears both complete storage areas (`apps/web/src/App.tsx:1764-1796,1859-1893,2862-2924`).
- Existing regression coverage already exercises v3 normalization, malformed records, stale browser-context writes, offline outboxes, reload, sessionStorage migration, completion, sign-out, and club deletion (`apps/web/src/session-outbox.test.ts`; `apps/web/src/App.test.tsx:830-899,3217-3600`). These are the seams to evolve rather than replace.
- The restart/session verifier independently derives the current per-club v4 localStorage key (`scripts/session-verifier-contracts.mjs:112-125`; `scripts/verify-session-state.mjs:99-103`), and its contract suite explicitly requires isolated club keys (`scripts/session-verifier-contracts.test.mjs:150-162,759-760`). The optional browser verifier also inspects/mutates v4 fixtures in sessionStorage (`scripts/verify-ui.mjs:1175-1234,1605-1620,1732-1757`). These verifier fixtures/contracts must advance with production rather than retaining a false v4/sessionStorage assumption.

## Migration and release decisions

- The new canonical key is one origin-wide v5 localStorage key. Every valid v5 envelope requires a UUID `clubId` and a UUID `gameId` whenever game content exists; an empty in-memory envelope is not persisted.
- Legacy discovery is bounded to exact v3/v4 game-session prefixes in localStorage and sessionStorage. It never enumerates or rewrites unrelated keys and never writes game state to sessionStorage.
- Invalid/stale legacy values are excluded from candidate selection and reported through the existing persistence error console; cleanup of their bounded game keys occurs only after a valid v5 selection or an explicit stale-data clear. Valid duplicate copies of the same club/game are deduplicated.
- If one valid candidate has unresolved local work and all others are fully synced, that candidate wins. If all candidates are fully synced, use a documented stable ordering—highest revision, then v4 over v3, then localStorage over sessionStorage, then source key—to select one while the remote sessions remain resumable.
- Distinct candidates with unresolved work on more than one game are not auto-selected or deleted. Preserve all source bytes and surface a blocking recovery dialog. The host must explicitly choose the record to keep, with every affected club/game and pending-change count shown before competing local copies are removed.
- A migration or conflict choice copies and validates the selected v5 record, reads back exact ownership/game identity, and only then removes bounded v3/v4 sources from both storage areas. A failed copy/readback leaves every source unchanged.
- Normal release is local-only: it removes the v5 attachment without deleting the server session, but only when the outbox has no pending/failed/clearing work and the durable snapshot has not changed. Unsynced work can be retried or cleared through the owning workspace; it cannot be silently released from a cross-club prompt.
- If the stored owner is no longer in the authenticated club list, surface stale-owner recovery instead of mounting another club. A destructive discard remains explicit and names whether local pending changes will be lost.

## Acceptance criteria

- At most one canonical game aggregate exists under the application origin, and every persisted mutation retains the same explicit `clubId`/`gameId` ownership.
- On authenticated reload, a valid record is migrated/validated before workspace rendering and the owning club/game is restored automatically; no request or mutation is issued with another club’s ID.
- Exiting to the club portal remains possible, but selecting another club is blocked before mount and offers “return to attached game” plus a local-only release only when release is safe.
- Starting or resuming another game cannot replace a different attached game. Existing explicit server-game deletion remains a separate clear path, and cross-browser claim/takeover behavior remains unchanged.
- New game/draft/outbox writes go only to the global v5 localStorage key. sessionStorage is read only for bounded v3/v4 migration/cleanup; claim-controller sessionStorage data is outside the game-state record and remains unchanged.
- Zero/one/duplicate legacy candidates migrate deterministically. Multiple candidates preserve the sole unsynced record when one exists; multiple unsynced games stop with an explicit host choice and no pre-choice source deletion.
- Migration and conflict resolution never mix club IDs, game IDs, revisions, canonical event chains, or outboxes, and source removal occurs only after verified v5 readback.
- Offline outboxes survive reload and blocked club/game attempts unchanged. Fully synced local release preserves the remote active session for later resume.
- Completion, sign-out, owning-club deletion, explicit game clear, Clear all browser data, and stale-owner recovery remove the applicable v5 and bounded legacy copies so sessionStorage cannot resurrect them.
- Unrelated localStorage/sessionStorage keys and existing per-club preferences remain untouched except by the already explicit Clear all browser data action.
- English and Russian recovery/attachment copy is accessible as a modal with a clear title, initial focus, keyboard/touch actions, and no underlying club mutation while blocked.
- The restart/session verifier reads the same global v5 localStorage contract and asserts the stored `clubId` before treating a game ID as browser-owned; verifier safety must not regress to trusting a caller-selected club.

### Task 1: Make ownership part of the durable outbox contract

**Objective:** Establish one v5 serialization that cannot read, mutate, restore, or clear a different club/game accidentally.

**Files:**
- Modify: `apps/web/src/session-outbox.test.ts`
- Modify: `apps/web/src/session-outbox.ts`
- Modify: `scripts/session-verifier-contracts.test.mjs`
- Modify: `scripts/session-verifier-contracts.mjs`
- Modify: `scripts/verify-session-state.mjs`
- Modify: `scripts/verify-ui.mjs`

**Steps:**
1. Add focused tests for a v5 record containing `clubId`, a shared default storage key, rejection of malformed/mismatched ownership, preservation of the owner through enqueue/flush/clear recovery, and refusal to restore a different game ID even with an empty outbox.
2. Run the new tests by name with `npm run test -w @mafia/web -- src/session-outbox.test.ts -t "browser owner"`; expect RED because v4 has no owner and `restore` replaces a synced record.
3. Require `clubId` in production `GameSessionOutbox` construction, advance newly persisted envelopes to v5, validate the owner alongside canonical game IDs, and make all empty/replacement/legacy-upgrade paths retain the one owner. Keep legacy v3/v4 parsing read-only for migration.
4. Add a narrow snapshot/release inspection API needed by the coordinator; it must expose ownership, revision, and unresolved-change status without leaking mutable envelope internals. Make a local release compare the live serialized snapshot before removal.
5. Replace the verifier’s per-club key derivation with the one v5 key and validate the persisted owner against `SESSION_CLUB_ID` before allowing browser-owned mutation requests. Move browser-verifier durable fixtures from sessionStorage v4 to localStorage v5 with explicit owner metadata. Update the contract test from “club keys differ” to “the key is global and ownership is explicit,” and add a static safeguard for the UI verifier’s v5/localStorage contract.
6. Re-run the named tests, `npm run test -w @mafia/web -- src/session-outbox.test.ts`, and `npm run test:verifier-contracts`; expect GREEN before continuing.

### Task 2: Add bounded, loss-aware legacy migration

**Objective:** Convert all known v3/v4 browser game copies into one verified v5 record without mixing games or silently discarding offline work.

**Files:**
- Add: `apps/web/src/browser-game-storage.ts`
- Add: `apps/web/src/browser-game-storage.test.ts`
- Modify only for narrow parse/upgrade helpers: `apps/web/src/session-outbox.ts`

**Steps:**
1. Add table-driven and generated source-order/property cases for zero candidates; one local v4; one session v3/v4; identical duplicates; multiple synced games; exactly one unsynced game; multiple unsynced games; malformed values; failed destination writes/readback; and unrelated keys.
2. Run `npm run test -w @mafia/web -- src/browser-game-storage.test.ts`; expect RED because the coordinator does not exist.
3. Implement exact-prefix key discovery and candidate parsing through the outbox’s canonical validators. Infer legacy `clubId` only from the exact key suffix/default-club mapping, never from selected UI state.
4. Implement the documented stable winner policy and a typed blocking-conflict result. For ambiguity, return candidate summaries while leaving source bytes untouched; for a winner, write/validate/read back v5 before removing all bounded source keys.
5. Implement explicit conflict selection, safe local release, stale-owner discard, and game-key-only cleanup as compare-before-write/remove operations. Keep all destination writes in localStorage and preserve claim/preference/unrelated keys.
6. Re-run the new file and `session-outbox.test.ts`; expect GREEN.

### Task 3: Restore the owner first and gate cross-club navigation

**Objective:** Prevent a wrong-club workspace from mounting and provide an accessible path back to or safely away from the attached game.

**Files:**
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/i18n/messages/shell.ts`
- Modify: `apps/web/src/styles/app.css`

**Steps:**
1. Add `WelcomeApp` tests with two clubs proving that reload migrates/opens the stored owner, clicking another club does not mount it, “return to attached game” restores the owner, safe release opens the requested club without a server delete, and an unsynced attachment disables release and preserves bytes.
2. Add separate RED cases for multiple-unsynced migration and a stored owner absent from `listClubs`, requiring a blocking recovery dialog and no workspace/API mutation before resolution.
3. Run those tests by name with `npm run test -w @mafia/web -- src/App.test.tsx -t "browser game|legacy game conflict|stored game owner"`; expect RED.
4. After clubs load, prepare/migrate the browser record and select the owning club before rendering. Gate `openClub` through a fresh compare-before-act owner read; never rely on stale React state for a storage safety decision.
5. Render localized English/Russian conflict/attachment UI above `ClubPortal`, reusing the established claim-dialog accessibility pattern where practical. Focus its heading/action, make the blocked surface inert, and expose only actions valid for the current pending/saved/stale state.
6. Wire explicit migration choice and release to the coordinator, refresh the storage decision after success, and mount only the resulting owner/requested club. Report storage failures without deleting sources or falling through to the target club.
7. Re-run the named App tests and then the full `App.test.tsx`; expect GREEN.

### Task 4: Apply the singleton to game lifecycle paths

**Objective:** Preserve existing save/claim behavior while proving no second local game or stale session copy can reappear.

**Files:**
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/session-outbox.test.ts`
- Modify if copy is needed for blocked resume: `apps/web/src/i18n/messages/shell.ts`
- Modify if verifier integration expectations need final adjustment: `scripts/session-verifier-contracts.test.mjs`

**Steps:**
1. Update the existing authoritative-session tests to expect the global v5 key and explicit club owner. Add RED assertions that a same-club resume of another remote game is blocked, an offline outbox remains byte-identical across reload/cross-club attempts, and no game-session key is written to sessionStorage.
2. Replace `ClubWorkspace`’s club-derived v4/v3 migration with the global v5 outbox plus explicit `clubId`. Translate a different-local-game restore failure into actionable UI instead of generic active-session failure, without weakening claim conflicts or takeover.
3. Extend completion, explicit active-game clear, sign-out, club deletion, and stale-copy tests. Owning-club deletion clears v5 plus its legacy sources; deletion of any unrelated club leaves the attachment intact; sign-out clears all bounded game keys while unrelated data survives; Clear all retains its intentionally broad behavior.
4. Preserve the existing durable-clear tombstone, latest-request-wins, stale-browser-context, normalization, claim-generation, canonical replay, and retry semantics while changing key/version expectations only where ownership requires it.
5. Run `npm run test -w @mafia/web -- src/browser-game-storage.test.ts src/session-outbox.test.ts src/App.test.tsx` and `npm run test:verifier-contracts`; expect GREEN.

### Task 5: Verify the issue-scoped implementation

**Objective:** Establish focused and repository-wide confidence before direct-main delivery.

**Files:**
- Verify only; do not modify unrelated failures or artifacts.

**Steps:**
1. Run `npm run test -w @mafia/web -- src/browser-game-storage.test.ts src/session-outbox.test.ts src/App.test.tsx`; expect every focused file to pass.
2. Run `npm run test:verifier-contracts`; expect the browser-storage verifier contract and all sibling verifier contracts to pass.
3. Run `npm run typecheck -w @mafia/web`; expect exit 0.
4. Run `npm run check`; expect formatting, lint, typecheck, all tests, and all builds to pass.
5. Inspect `git diff --check`, `git diff --stat`, `git status --short --untracked-files=all`, and the exact canonical-base diff. Confirm there are no server/domain/database changes, sessionStorage game writes, unrelated preference removals, generated artifacts, or weakening of claim/club isolation.
6. Hand off to `.AI/plans/2026-09-04_163803-issue-52-delivery-closeout.md` for isolated plan preservation, final plan cleanup, direct-main push, shared-index reconciliation, remote verification, and close-last issue mutation.

## Risks and tradeoffs

- **Migration data loss:** Multiple old records can each carry unique offline operations. Auto-select only when one candidate is uniquely loss-bearing; otherwise preserve all bytes until a named explicit choice and verify v5 before cleanup.
- **Wrong-club API leakage:** Constructing `ClubWorkspace` before owner resolution would bind save/read/clear callbacks to the selected club. Keep the gate in parent `App` and require outbox-level `clubId` validation as defense in depth.
- **Stale cross-tab decisions:** Another tab can change the global key after a dialog renders. Every release, migration choice, restore, and clear must compare the current durable snapshot immediately before mutation and fail closed on mismatch.
- **Claim storage confusion:** `GameSessionClaimController` intentionally uses sessionStorage for tab identity. The prohibition applies to durable game state, not claim coordination; key-scoped tests must preserve that distinction.
- **Safe release versus server deletion:** Releasing this browser must leave the remote active session intact. Existing “Start new game” remains the explicit server-deletion path and must not be reused for local-only release.
- **Large existing persistence suite:** Updating serialization expectations can create broad mechanical churn. Keep v3/v4 fixtures as legacy inputs, centralize v5 construction in test helpers, and avoid reformatting unrelated tests.
- **Untracked shared plans:** Implementation must occur in an isolated worktree after approval, copy only the approved issue #52 plan pair by exact hash, and keep the shared index untracked.

## Open questions

None. Michael confirmed the default backlog workflow, and the live issue plus the conservative migration/release rules above define the implementation and closeout boundaries.
