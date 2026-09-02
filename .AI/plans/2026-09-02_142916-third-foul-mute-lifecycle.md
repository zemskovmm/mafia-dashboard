# Third-foul mute lifecycle and goodbye suppression

## Goal

Make a third-foul mute apply for the remainder of the current day, suppress any goodbye speech while it is active, and guarantee that no mute survives into the next day.

## Status

Selected for backlog execution from `main` at `fc7a371`; implementation has not started. Delivery is a separate dependent plan in [the issue #45 closeout plan](./2026-09-02_154210-issue-45-delivery-closeout.md).

## Plain-language summary

A player who reaches three fouls must not receive a voted-out goodbye speech during that day. If the mute was not otherwise consumed, it expires when the next day begins so it cannot mute a later day unexpectedly.

## Selection and readiness

- Issue [#17](https://github.com/zemskovmm/mafia-dashboard/issues/17) is older but is not implementation-ready: its JSON/CSV acceptance refers to “approved fields” without defining them, and its completed-game correction policy remains a product decision rather than an executable contract.
- Issue [#23](https://github.com/zemskovmm/mafia-dashboard/issues/23) is the next oldest but remains an umbrella release gate that depends on the unresolved export work in #17 and the current P0 backlog.
- Issue [#45](https://github.com/zemskovmm/mafia-dashboard/issues/45) is therefore the earliest-created open, implementation-ready issue. It is unassigned, has no explicit dependency, and duplicate sweeps by issue number, `third foul mute`, and `muted goodbye speech` found no pull request.

## Planned GitHub issue

- **Title:** `[Rules] Expire third-foul mute at the next day and suppress muted goodbye speeches`
- **Labels:** `bug`, `area:rules`, `priority:P0`
- **Idempotency marker:** `<!-- backlog-intake:2026-09-02:third-foul-mute-lifecycle -->`

## Current behavior found

- `issueFoul` sets `mutePending` on foul three (`packages/game-domain/src/day-actions.ts:113`).
- The flag is currently cleared only when that player’s normal Day turn completes (`packages/game-domain/src/day-actions.ts:131`).
- Live car-crash completion and canonical vote/car-crash replay construct `goodbyeSeats` independently and neither filters `mutePending` (`packages/game-domain/src/day-actions.ts:526`, `packages/game-domain/src/game-events.ts:951`).
- `completeNight` increments the day without clearing pending mutes, then exposes Best Move, goodbye, or Day state (`packages/game-domain/src/night-actions.ts:240`).
- `completeGoodbyeSpeech` correctly assumes at least one speaker (`packages/game-domain/src/night-actions.ts:324`), and server validation rejects a `goodbye-speech` state with no `goodbyeSeats` (`apps/server/src/game-session-validation.ts:581`). The fix must skip that phase rather than emit an empty list.
- Existing SHA-256 event hashes cover post-event state. Correcting these transitions without a narrow replay fallback would make pre-fix persisted chains fail canonical integrity checks.

## Implementation approach

1. Centralize voted/car-crash elimination completion in `packages/game-domain/src/day-actions.ts`: preserve elimination order, filter only currently muted players from goodbye speakers, keep victory behavior unchanged, and transition directly to Night when no eligible speaker remains.
2. Reuse that transition from `completeCarCrashResult` and from canonical `voting.resolved` / `car-crash.resolved` application in `packages/game-domain/src/game-events.ts`, eliminating the current live/replay behavior split.
3. In `packages/game-domain/src/night-actions.ts`, clear every unconsumed `mutePending` flag as part of the day increment before constructing Best Move, goodbye, or ordinary Day state. This deliberately allows a player killed overnight to receive the new day’s goodbye speech.
4. Preserve immutable persisted replay: new events use corrected semantics, while `replayGameLog` may select a narrowly reconstructed pre-fix transition only when the corrected state does not match an affected stored event’s existing `stateHashAfter`; reject the event if neither state matches. Do not weaken parent, phase/day, or hash validation and do not rewrite stored events.
5. Add focused live-domain, canonical replay, and server-validation regressions. Include fixed pre-change SHA-256 fixtures for affected old chains so compatibility is proven independently of newly generated events.

## Scope and boundaries

- Preserve the current ten-second nomination-only behavior when a muted player reaches their normal turn.
- If a currently muted player is eliminated by the current day’s vote, omit that player from `goodbyeSeats`.
- With several eliminated players, retain the order and goodbye speeches of unmuted players; if none remain, transition directly to the correct next phase.
- Clear any unconsumed mute at the day increment before the new day’s Best Move/goodbye/day flow is exposed.
- Preserve fourth-foul red-card behavior; red-carded players still receive no final speech under the existing rule.
- Keep canonical event/replay behavior deterministic and compatible with persisted games.

## Acceptance criteria

- A player on exactly three fouls who is voted out that day receives no goodbye speech.
- Other unmuted eliminated players still receive their ordered goodbye speeches.
- If every would-be goodbye speaker is muted, the game skips an empty goodbye phase and advances correctly.
- A mute is cleared when its muted turn is consumed and, in all cases, is false once the next day begins.
- A player killed during the night is evaluated after next-day mute expiry and is not incorrectly denied the new-day goodbye because of a stale prior-day mute.
- Fourth-foul/red-card and victory transitions remain unchanged.
- Canonical replay produces the same state as live execution.

## Verification

- Add focused domain regressions in `day-actions.test.ts` for one muted voted-out player, mixed muted/unmuted multi-elimination with stable order, all-muted elimination skipping goodbye, and unchanged fourth-foul/victory behavior.
- Add `night-actions.test.ts` coverage proving ordinary Day, Best Move, and overnight-victim goodbye states all expose the new day with every stale mute cleared.
- Add `game-replay.test.ts` coverage for corrected vote/car-crash/day-increment transitions, live/replay equality, and fixed pre-fix SHA-256 chains that still replay to their recorded states.
- Add or retain a focused `game-session-validation.test.ts` assertion that an empty `goodbyeSeats` array is rejected in the `goodbye-speech` phase.
- Prove the new regressions fail against the pre-fix transition behavior, restore the implementation, and rerun them green.
- Run the affected workspace tests, then the repository gate `npm run check`.

## Risks and controls

- **Replay integrity:** hash-aware compatibility is limited to the event types and transition shapes changed here; every other mismatch remains a hard failure.
- **Rule coupling:** one shared elimination transition prevents live car-crash and canonical vote replay from drifting again.
- **Phase validity:** no path may produce `phase: "goodbye-speech"` with zero speakers.
- **Scope:** no UI, foul-count, timer, fourth-foul, winner, database-schema, or API behavior changes are included.

## Non-goals

- Changing foul counts, the fourth-foul penalty, timer lengths, or red-card final-speech policy.
- Changing when a player becomes muted beyond foul three.
