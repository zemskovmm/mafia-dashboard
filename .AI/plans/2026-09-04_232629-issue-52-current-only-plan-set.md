# Issue #52 Current-Version-Only Plan Set

## Goal

Deliver issue #52's one durable browser game while removing historical data compatibility across the application, under the same ticket and one unmerged feature-branch PR.

## Plain-language summary

The app will support only the formats its current version writes. Old browser game records, old theme/music formats, historical game/API/replay conversions and database upgrade/backfill logic will be removed. Current games must still survive offline work, reloads and club/tab switching without data loss. A fresh/current database remains usable; no existing environment will be reset or deployed as part of this work.

**Status:** Regenerated plan only; awaiting explicit approval of this complete set. No new ticket, source implementation, issue edit or delivery is authorized by the planning request.

## Authority and scope replacement

- Ticket: [#52 — Enforce one durable local game per browser](https://github.com/zemskovmm/mafia-dashboard/issues/52), currently OPEN.
- Latest instruction: “Redo planning in the scope of the same ticket including the newest requirements.”
- Included requirement: “Drop all support for legacy data - its not important - regenerate plan assuming the data is always going to be in actual version.”
- Keep **one ticket**. Semantic splitting below is for implementation/review clarity, not publication of new issues or independent partial delivery.
- This set replaces the old migration/tombstone/v3-conflict remediation task and the browser-only scope exemption for server/domain/database compatibility.
- The issue's live body still promises bounded migration/conflict recovery. Update that body to the draft contract below **only after approval**, then read it back before source implementation.
- Earlier migration-candidate test totals and review verdicts do not verify this unimplemented redesign.

## Explicitly proposed assumptions requiring approval

The latest clarification form timed out. These are proposed boundaries, **not answers attributed to Michael**:

1. **Database starting state:** Support a fresh application schema or the exact current schema with current-format rows. Remove historical upgrades/backfills; reject unsupported existing schema rather than repairing or resetting it.
2. **Old artifacts:** Obsolete browser keys are ignored and left untouched, not scanned/imported/deleted. No database cutover, historical-row sweep, table drop or existing-volume reset is authorized. The current explicit Clear all browser data action remains a user-invoked exception for browser keys.
3. **Invalid current game bytes:** Invalid/unsupported global v5 blocks play. Explicit local clearing must compare the exact displayed raw value again after acquiring the browser lock. Invalid preferences may retain their current best-effort defaults instead.
4. **Current features are not legacy support:** Keep current authoritative snapshots, setup/activity logs (currently named `legacyLog`), current `legacy` lighting renderer, valid null/empty setup states and server deletion tombstones. Remove historical adapters/fallbacks around them. This is a semantic removal, not a repository-wide ban on the word `legacy` or on version number 1.
5. **Delivery:** Keep `issue-52-browser-game-singleton` → PR to `main`; no main push, merge, auto-merge, deployment or issue closure. Use `Refs #52`, not automatic closure. Current staging and shared artifacts must remain protected.

Approval of this set includes these assumptions. If they are not acceptable, revise the relevant slice before any implementation; do not infer destructive permission from abandoning compatibility.

## Plan inventory and order

All paths below are relative to `.AI/plans/`. This table plus this index is the exact ticket plan-history transport set; the shared backlog index and historical review are excluded.

| Order | One-goal plan | Boundary and dependency |
| --- | --- | --- |
| 1 | [Current game data and replay](./2026-09-04_232629-issue-52-current-game-contract.md) | Define strict current game/API/server/replay representation; remove historical adapters. Establish this contract before finalizing browser and schema integration. |
| 2 | [V5 browser singleton](./2026-09-02_142916-browser-local-game-singleton.md) | One global current-v5 owner/outbox; remove v3/v4 discovery/migration/conflicts; retain invalid-data and cross-tab safeguards. Integrates plan 1. |
| 3 | [Current database bootstrap](./2026-09-04_232629-issue-52-current-schema.md) | Fresh/current-schema initialization without old-schema conversion; preserve current constraints and seeds. Align persisted contract with plan 1. |
| 4 | [Current browser preferences](./2026-09-04_232629-issue-52-current-preferences.md) | Remove old theme/music format adapters; preserve current preference and lighting behavior. Independent implementation slice. |
| 5 | [Feature-branch/PR closeout](./2026-09-04_163803-issue-52-delivery-closeout.md) | Exact reviewed artifact plus approved plan-history transport, verified feature push and open PR. Depends on every implementation slice and integrated qualification. |

No slice may be treated as completing #52 on its own. Tests and current invariants are retained per subsystem rather than creating a generic all-purpose rewrite.

## Refreshed repository state

Read-only inspection on 2026-09-04 found:

- Primary checkout: `/Users/Michael/Repos/Mafia Dashboard`, branch `main`, untracked `.AI/plans/` and `.AI/reviews/`.
- Isolated implementation checkout: `/Users/Michael/Repos/Mafia Dashboard.issue-52`, branch `issue-52-browser-game-singleton`, HEAD `a072794e74e0fc7c173edfe21524834189a37832` (earlier plan-only commit).
- Remote canonical `main`: `3ab810850aed528bc7c700049d629008b8f9682f`; no remote feature branch appeared in the read-only remote query.
- Existing staged implementation contains migration-capable browser work, not this redesign. Two earlier plan paths are staged deleted. `scripts/verify-session-state.mjs` is also in the current staged set; do not rely on the older summary's file count.
- Staged binary diff against HEAD SHA-256: `f8157d15d303e68eeea01aff09377167d53f67a066f3fd4633ff46b0f80f7d04`. This is a preservation fingerprint, **not** a passing review digest. The unstaged diff was empty.
- Preserve existing staging and primary shared artifacts. Do not reset/stash/clean or reconstruct source from chat. Recheck state before approved implementation.

## Revised issue-body draft

After approval, replace #52's body with the following complete semantic contract. Retain its existing title, priority/labels, relationships, native open state and intake marker. Do not create another ticket or remove unrelated issue metadata.

### Goal

Enforce one durable local game per browser and support only current application data formats across browser persistence, game/replay/API/server storage, PostgreSQL initialization and browser preferences.

### Plain-language summary

The browser has one game record with explicit club/game ownership. Current games remain safe through offline work, reloads and tab/club changes. Historical data is no longer migrated, repaired or interpreted; only current data and fresh/current database schemas are supported. This change does not reset or deploy any existing environment.

### Scope

- Sole durable browser game key: `localStorage["mafia-dashboard.game-session.v5"]`, strict current shape, explicit `clubId` and `gameId`.
- Remove all v3/v4 game-envelope parsing, fallback storage-area reads, migration/normalization, candidate ranking/selection, migration tombstones, compatibility UI and verifier fallback.
- Remove historical game/session/result hydration, normalize API/operation paths, old hash acceptance and historical replay/rule adapters. Keep only current writer-supported representations and operations, including current authoritative snapshots and activity logs.
- Remove obsolete raw aggregate mutation routes without losing current read-only history, session mutation, claim, security or projection behavior.
- Replace historical SQL repair/upgrade/backfill with fresh/current-schema bootstrap. Keep current integrity, isolation, idempotency, claim, ruleset and deletion safeguards.
- Remove old theme keys and old music-field fallback support. Preserve current preference keys, defaults, queue behavior and all currently selectable lighting renderers.

### Acceptance criteria

1. At most one supported browser game aggregate exists; restore its owner before allowing gameplay. No second start/restore silently overwrites it; an absent record is allowed.
2. Absent v5 is empty; strict valid v5 is ready; invalid/unsupported v5 blocks until explicit exact-byte-checked local clear under Web Locks. Unsupported locking fails safely.
3. Old browser game/preference records never affect current state and remain unchanged during normal operations. No game-state sessionStorage fallback remains; current tab-claim identity storage is allowed.
4. Current unsynced outbox, claim/takeover, club isolation, exact stale-write/release/discard checks, completion/reload/sign-out/deletion/clear-all behavior remain verified. Release after another tab removed the expected attachment refreshes the UI and opens the captured target; replacement/invalid/error cases do not.
5. Current setup, active, intermediate-draft and completed states save/reload/replay end to end. Replay accepts only current SHA-256/event semantics. Historical hash/shape/normalize/result payloads are rejected without durable mutation or conversion.
6. Fresh bootstrap and populated current-schema reruns preserve required constraints/data. Old/incomplete schema is rejected without partial changes, backfill or destructive cleanup.
7. Current theme/music/lighting behavior passes, while old preference aliases are ignored and never migrated.
8. Focused domain/server/web/DB/verifier tests, controlled local browser lifecycle evidence and `npm run check` pass; fresh immutable reviews certify the same exact candidate.
9. Delivery is feature-branch plus open unmerged PR only; #52 stays open and `main`/existing environments stay unchanged.

### Verification

Use regression-first negative tests for unsupported formats and positive current-format lifecycle tests. Run focused suites from the saved plan set, real disposable-PostgreSQL bootstrap/rerun/failure tests, browser singleton/claim/offline/invalid-state cases, verifier contracts, then `npm run check`. Publish only actual results tied to the exact reviewed commit.

### Non-goals and deployment warning

No historical import/migration/reset utility, no environment/database cleanup, no current game-rule or lighting-feature removal, no new concurrency model, no pipeline change, no merge/deploy/automatic issue closure. Existing historical installations are not asserted compatible; deployment is a separate explicit decision.

### Relationships

Retain #50 setup-durability and #53 claim/lock relationships and the existing issue intake marker. Do not reopen or broaden those closed tickets.

## Integrated qualification and review

1. Run RED–GREEN–REFACTOR per behavior change; when removing a compatibility-positive test, retain current safety assertions and add an old-input rejection/ignore test. Do not just delete failures until the suite is green.
2. Run each plan's focused suites. Real PostgreSQL tests must execute against an isolated disposable current-schema database; unavailable/skipped DB coverage is a blocker. Never read/print secrets or infer existing deployments are safe test targets.
3. Run `npm run test:verifier-contracts`, `npm run test:backup-contracts`, and `npm run check` in the isolated worktree. The latter includes format, lint, typecheck, all workspace/contract tests and build; do not reintroduce removed audit/scan CI gates.
4. Inspect `scripts/verify-ui.mjs` and `scripts/verify-session-state.mjs` documented prerequisites before launching them against a controlled local app. Obtain real browser evidence for a current-v5 restore, offline queue/reload, two-tab ownership race, strict invalid-v5 blocking/changed-byte clear refusal, stale release with target navigation, and setup/current timeline behavior. Use local fixtures only; never fabricate output or point mutating UI verification at Production.
5. Audit the runtime compatibility surface with semantic searches for old keys, aliases, hashes, normalize endpoints and SQL backfills. Remaining current `legacyLog` activity, current lighting enum, current projection and generic value-normalization uses must be distinguishable from historical data acceptance. Static checks supplement—not replace—behavioral proof.
6. Freeze exact canonical base, staged paths, tree, binary patch and SHA-256; require empty unstaged source diff and non-printing secret/diff checks. Preserve original review evidence as superseded; no old passing suite/review certifies this candidate.
7. Obtain fresh independent immutable review coverage for **browser/outbox/UI**, **domain/API/server contracts and privacy**, and **database/bootstrap safety**. Every reviewer names the same full patch/tree/digest and reports scope, findings and verdict. No reviewer mutates the candidate.
8. Allow at most one bounded fix/review cycle for concrete accepted-scope P0/P1 findings; any source change invalidates prior hashes/verdicts. Re-run affected tests plus `npm run check`, freeze and review again. Stop for further approval on material scope drift or exhausted budget; no stale legacy-migration blocker resurrection.
9. Closeout begins only when every slice and integrated acceptance criterion is verified. It publishes an unmerged PR and leaves #52 open.

## Definition of Ready

- Michael approves this exact plan set, including the labeled safety assumptions and current-feature distinctions.
- Live issue body is reconciled and read back before implementation.
- Worktree/source/remote drift is classified; current staged work and shared artifacts are preserved.
- Disposable test prerequisites can be satisfied without mutating existing environments; no credential values are logged.

## Definition of Done for this delivery boundary

- Every revised issue acceptance criterion is demonstrated on one immutable candidate.
- Approved plans are preserved in branch history; completed ticket plans are pruned only through the scoped closeout procedure, not mixed with shared artifacts.
- Feature branch and PR are read back at the reviewed commit, PR open with `Refs #52`, no auto-merge, issue open, canonical `main` unchanged and no deployment triggered.
- Final response reports the PR URL, exact commit, actual test/review evidence and any unverified remote checks honestly.

## Superseded work and retained defect

- Cancel the old `verify` task to repair loser tombstones and v3 conflict identity: those mechanisms are removed, not repaired.
- Replace the old delivery task with this all-slices gate; no implementation starts during planning.
- Keep the current-version stale release UI defect in the browser acceptance contract.
- Keep historical review files unchanged as local reference; they are not approval or a current blocker list.

## Approval request

Approve this complete same-ticket plan set to implement removal of historical browser, game/replay/API/server, database and preference compatibility while preserving current gameplay and safety. Approval also confirms current-schema-only/non-destructive assumptions and feature-branch/PR-only closeout. Until then, no source, GitHub or implementation Git mutation proceeds.
