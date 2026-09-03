# Issue #53 plan set: one claimed active game per club

> **For agent:** REQUIRED SUB-SKILL: Use subagent-driven-development (fresh subagent per task, two-stage review) to implement this plan.

## Goal

Deliver GitHub issue [#53](https://github.com/zemskovmm/mafia-dashboard/issues/53) as one coherent concurrency contract: a club has at most one active game, exactly one current browser claim can write it, and an authenticated moderator can explicitly take over from another or expired claim.

## Status

Approved by Michael on 2026-09-03. Implementation has started in an isolated ticket worktree; no production behavior has changed yet.

## Plain-language summary

The database will prevent two live games for the same club. The current browser will hold a short renewable lease on that game; another browser must choose **Take over** before it can write, and the displaced browser will be stopped rather than silently replaying changes over the new host.

## Why this issue was selected

- Live backlog inspection on 2026-09-03 found six open issues: #23, #48, #49, #51, #52, and #53.
- #23 is a qualification umbrella with several independent outcomes, so it is not a single implementation-ready item.
- #48 is still P0, but commits `9dc30c5` and `dda769a` implemented and hardened terminal persistence after #48 was filed; it needs a fresh real-path reproduction before it can be treated as ready rather than duplicated.
- #53 is therefore the highest-priority implementation-ready P0 item. Its dependency #50 is closed in commits `bbe2c15` and `50bf0ac`.
- Searches by issue number, “active game lock,” and “session takeover lease” found no open or closed pull request implementing #53.

## Confirmed implementation decisions

- Keep the existing HTTP/polling architecture; do not introduce WebSocket infrastructure for this issue.
- Renew a live claim every 15 seconds and expire it after 45 seconds. The server clock and database row are authoritative.
- Use a client-generated opaque UUID plus a server-maintained monotonically increasing generation as the fencing credential. It is an ownership marker, not an authentication secret; authentication and club membership remain separate checks.
- Send the claim ID and generation on every game-session mutation. Generation `0` is valid only for the first atomic create-and-claim request; the server returns generation `1`.
- Check exact idempotent mutation retries before rejecting a stale claim. A previously committed retry may read its duplicate response, but a new stale mutation may not write.
- Conflict responses expose only the holder's display name and claim/acquisition/expiry times. They do not expose email, user ID, claim ID, cookies, or tokens.
- Keep `GET /api/game-sessions` returning an array for compatibility, but enforce that the active result contains at most one row per selected club.
- A populated migration with duplicate active rows must fail closed without changing or deleting either row. The deployment guide will require a backup, explicit operator selection of the canonical row, removal of only the chosen obsolete row(s), and a migration retry.
- Completion clears the live claim atomically; deletion removes it with the session; explicit release and sign-out make a best-effort release, with the 45-second expiry as the crash/network fallback.
- A claim conflict never rewrites queued offline work automatically. **Take over** is the explicit authorization that updates this browser's fence and allows its retained queue to retry.

## Semantically split implementation plans

1. [Database-backed single-active-session invariant](./2026-09-03_174007-issue-53-active-session-invariant.md)
2. [Server claim lease and stale-writer fencing](./2026-09-03_174007-issue-53-claim-fencing.md)
3. [Browser takeover, heartbeat, and offline-conflict UX](./2026-09-03_174007-issue-53-takeover-ui.md)
4. [Verified direct-main delivery and closure](./2026-09-03_174007-issue-53-delivery-closeout.md)

The plans are ordered dependencies. Issue #53 closes only after all three plans pass their acceptance criteria together.

## Shared invariants

- Club isolation and current manager/user authorization behavior remain unchanged.
- Canonical replay, browser-authoritative snapshots, mutation idempotency, terminal result/statistics exactness, and deleted-game tombstones remain authoritative.
- Heartbeats do not increment the game revision or create canonical game events.
- A stale claim can neither write nor renew after takeover.
- A network outage preserves local game state and outbox work; a server ownership conflict is a distinct blocked state.
- No migration fabricates completion results, chooses a winner among duplicate active rows, or silently discards a session.

## Integrated acceptance criteria

- Concurrent first saves for different game IDs in one club yield one active session and one stable conflict; concurrent saves in different clubs both succeed.
- A second browser receives safe conflict metadata and cannot mutate before explicit takeover.
- Takeover increments the fence, enables the new holder, and deterministically rejects the displaced holder's writes and renewals.
- An abandoned claim becomes acquirable after 45 seconds without database intervention.
- Completion, supported deletion/cancellation paths, explicit release, and sign-out clear or safely expire ownership.
- Displaced offline work remains local and blocked until the user explicitly takes over; it is never silently replayed under a newer fence.
- Fresh, populated-compatible, duplicate-populated failure, repaired-populated, and second-run schema paths are verified semantically.
- Focused server/web tests and `npm run check` pass; a two-client UI scenario is exercised before delivery.

## Delivery boundary

- Preserve every pre-existing staged/untracked artifact except this selected #53 plan set, which may be removed only after verified implementation as required by `AGENTS.md`.
- After all checks pass, remove these successfully implemented #53 plan files as required by `AGENTS.md`.
- Commit only #53 source/test/documentation changes on `main`, push `main`, verify the remote SHA, then close #53 with the exact local verification results. Do not open a pull request.