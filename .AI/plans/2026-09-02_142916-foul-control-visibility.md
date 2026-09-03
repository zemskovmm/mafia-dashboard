# Foul control visibility outside night play

## Goal

Implement GitHub issue [#46](https://github.com/zemskovmm/mafia-dashboard/issues/46) by keeping the Foul control available for every active player throughout active non-night gameplay, including goodbye speeches, while intentionally excluding Best Move as a night stage.

## Status

Selected for backlog execution from `main` at `dda769a` and revised after the owner’s day-play discipline clarification; implementation has not started. Delivery is a separate dependent goal in [the issue #46 closeout plan](./2026-09-03_022452-issue-46-delivery-closeout.md).

## Plain-language summary

The host will be able to issue a normal foul throughout day play: the speaking day, voting, car-crash, and goodbye screens. Best Move and night are outside day play, so Foul remains unavailable there and the existing immediate-dismissal action remains explicitly labeled Red card.

## Confirmed terminology and discipline behavior

- “Day play” includes `day`, `voting`, `voting-cancelled`, every car-crash phase, and `goodbye-speech`; normal foul counting is the primary penalty throughout these phases.
- Best Move and every `night-*` phase are outside day play. Their minimum penalty is immediate red-card dismissal, exposed through the existing swipe action labeled `Red card`, not through a Foul control.
- A red-carded player receives no goodbye speech.
- If a player leaves the table through a red card during voting or car crash, that voting turn is cancelled.
- These dismissal semantics already exist in the domain and remain regression boundaries rather than new rule changes for issue #46 (`packages/game-domain/src/day-actions.ts:164`; `packages/game-domain/src/day-actions.test.ts:91`, `:137`, `:255`).

## Selection and readiness

- Issue [#23](https://github.com/zemskovmm/mafia-dashboard/issues/23) is older and also P0, but it is the umbrella v1 acceptance/release gate. It must follow the unresolved P0 product defects rather than certify a build that still contains them.
- Issue [#45](https://github.com/zemskovmm/mafia-dashboard/issues/45), the earliest independent item from the current reliability backlog, is already completed and closed.
- Issue #46 is therefore the earliest-created open, independent, implementation-ready P0 defect. It is unassigned, has no explicit dependency or comments changing its scope, and duplicate sweeps by issue number, `foul goodbye`, and `discipline control` found no pull request.

## GitHub issue contract

- **Title:** `[UX] Keep Foul controls available throughout active non-night play`
- **Labels:** `bug`, `area:frontend`, `area:ux`, `priority:P0`
- **Idempotency marker:** `<!-- backlog-intake:2026-09-02:foul-control-visibility -->`

## Current behavior found

- `VotingStage` has one optional Foul renderer and already uses it for `voting`, `voting-cancelled`, `car-crash-decision`, `car-crash-result`, and `car-crash-skipped` (`apps/web/src/features/voting/VotingStage.tsx:58`, `:128`, `:158`, `:187`, `:279`, `:332`).
- `GameScreen` always supplies that callback on the live `VotingStage` path, but its generic `GameTable` path exposes Foul only during `day` and `car-crash`; `goodbye-speech` therefore has no Foul action (`apps/web/src/features/game/GameScreen.tsx:557`, `:568`, `:628`).
- Preview rendering is already a dedicated read-only branch and suppresses all seat actions (`apps/web/src/features/game/GameScreen.tsx:539`; `apps/web/src/features/table/GameTable.tsx:128`, `:257`).
- The existing `disciplineAvailable` predicate governs the immediate-dismissal swipe action, including Best Move and private night phases, and already renders the translated Red card label. Conflating it with Foul visibility would weaken the distinction between day-play fouls and outside-day dismissal (`apps/web/src/features/game/GameScreen.tsx:138`, `:154`).
- `foulPlayer` is already the shared action path for generic and voting screens. It emits the canonical `foul.issued` context when available and otherwise applies `issueFoul` locally (`apps/web/src/features/game/GameScreen.tsx:218`).
- Domain behavior already accepts fouls for active players, applies the third-foul mute, and delegates foul four to `redCard`; red-card phase consequences are covered across active gameplay, including voting cancellation (`packages/game-domain/src/day-actions.ts:113`, `:164`; `packages/game-domain/src/day-actions.test.ts:225`, `:255`, `:619`).

## Implementation approach

1. Define one explicit live Foul-availability policy in `GameScreen.tsx` for exactly `day`, `voting`, `voting-cancelled`, `car-crash`, `car-crash-decision`, `car-crash-result`, `car-crash-skipped`, and `goodbye-speech`, guarded by live mode and day one or later.
2. Derive `foulAvailable` once from that policy. Supply `VotingStage.onFoul` only when it is true, and use the same value for the generic table’s seat actions; retain the existing active-seat check in both renderers.
3. Leave `disciplineAvailable`, its translated Red card action, the shared `foulPlayer` path, canonical event payloads, domain rules, and translations unchanged. This keeps normal day-play fouls separate from immediate dismissal outside day play.
4. Extend `GameScreen.test.tsx` with table-driven included/excluded phase coverage. Build valid fixtures for voting and car-crash variants so the test exercises their actual rendering branches, not a mocked policy helper.
5. Add focused stateful component coverage for third and fourth fouls from a day-play phase other than literal `day`, inactive-seat suppression, preview suppression, and English/Russian accessible names. Add a boundary assertion that an outside-day phase has no Foul action and retains the existing Red card label after swipe. Assert post-action UI/state or accepted event context so stale rendering and event regressions are observable.

## Scope and boundaries

- Include `day`, `voting`, `voting-cancelled`, `car-crash`, `car-crash-decision`, `car-crash-result`, `car-crash-skipped`, and `goodbye-speech`.
- Exclude setup, `best-move`, every `night-*` phase, preview mode, `finished`, `draw`, and `cancelled`; outside-day active play retains the separate Red card action.
- Render Foul only for players whose domain status is `active`, including while another player is provisionally or permanently eliminated.
- Reuse the existing buttons, translations, action handler, canonical event shape, touch layout, and domain consequences.
- Preserve the rule that a red-carded player gets no goodbye, voting/car-crash is cancelled when a player is dismissed, and victory evaluation remains authoritative; do not introduce phase-specific alternatives in the UI.

## Acceptance criteria

- Every active seat has a visible, operable Foul control in every included phase.
- A Foul control is available during voted-out, car-crash, and night-victim goodbye speeches.
- No Foul control appears in any excluded phase, in preview mode, or for an inactive player.
- Foul three and foul four from a supported day-play phase other than literal `day` use the same shared handler and produce the existing mute/red-card canonical behavior without stale controls.
- English and Russian accessible Foul labels remain correct.
- Best Move and night expose no Foul action; their existing swipe action remains labeled Red card and still dismisses immediately.
- Red-carded players receive no goodbye, voting/car-crash dismissal cancels that voting turn, and canonical replay remains unchanged.

## Verification

- Run the focused component file: `npm run test -w @mafia/web -- src/features/game/GameScreen.test.tsx`.
- Prove the phase-matrix regression bites by temporarily restoring the old `day`/`car-crash` rendering condition, confirm the new test fails, then restore the fix and rerun green.
- Run the full web workspace tests because `GameScreen` delegates to voting and table components: `npm run test -w @mafia/web`.
- Run the repository gate on final bytes: `npm run check`.
- Review `git diff --check`, the exact changed-path inventory, and the final diff against issue #46 before delivery.

## Risks and controls

- **Policy drift:** one derived `foulAvailable` value gates both render branches; the phase matrix names every included and excluded phase.
- **Invalid test fixtures:** voting/car-crash cases carry the state required by their real component branches, and assertions target rendered accessible controls.
- **Rule coupling:** no domain function changes are planned; focused third/fourth-foul tests prove the UI still reaches established day-play behavior, while existing domain tests protect dismissal consequences.
- **Scope drift:** red-card swipe availability and labeling deliberately remain on their existing outside-day-capable predicate rather than becoming Foul controls.

## Non-goals

- Showing Foul during Best Move, any night phase, setup, preview, or terminal play; these phases retain immediate Red card dismissal where active-play discipline is available.
- Changing swipe-to-red-card availability, labeling, or interaction design.
- Changing foul counts, mute lifecycle, fourth-foul penalties, voting rules, victory evaluation, canonical event/replay behavior, or translations.
