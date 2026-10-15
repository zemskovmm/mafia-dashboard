# Federation domain integration contract

Scope: `rulesEdition: "mafgame-2026-07-01"`, except the explicitly shared nomination/support contract below. Missing edition remains legacy. `createSetup` has no new default. `CURRENT_REPLAY_VERSION` remains 1; derive the baseline/event edition through `createInitialGameBaseline` and `createGameLogEntry` rather than hardcoding the constant. The v1 fixtures and hashes are unchanged.

## Lifecycle and state

`advanceOpeningPhase` is the current host flow: `mafia-planning → sheriff-identification → day`. The first action confirms that the host put Mafia to sleep; the separate Sheriff greeting recommends ten seconds before **Begin round zero**. These are not role checks or shots. The final action counts game night one exactly once and enters the zero round (stored `day: 1`). This streamlined club opening is not a claim of exact rulebook opening-procedure compliance.

`advanceSetupPhase` retains the recorded five-step contract: `mafia-planning → mafia-sleep → don-identification → sheriff-identification → free-seating → day`. Existing canonical `phase.changed {to}` events and their hashes remain valid. Canonical replay accepts only the explicit short destinations in addition to the original transitions; it does not generally allow meaningful-phase skipping. Restored `mafia-sleep` or `don-identification` can explicitly continue to the Sheriff greeting, and restored `free-seating` can complete normally. No saved record is rewritten on restoration. Legacy callers retain their original two-step behavior.

New federation state (exported from `types.ts`):

- Required on valid v2 snapshots: `completedGameNights: number`, `sheriffChecksPerformed: number`, `firstDayDepartureSeats: readonly number[]`, `currentSpeechRestricted: boolean`. `createGame` supplies them. Planning counts as completed game night one. Only accepted Sheriff checks increment the check counter; skips and identification do not.
- `actualMultipleShotSeats?: readonly number[]`: an observed actual multiple shot, not a clerical target edit. Any eligible shooter with this observation causes a miss. Ordinary `recordMafiaShot`/toggles remain clerical corrections.
- `ballot?: FederationBallot`, `ballotSkipReason?: LegalVotingSkipReason`, `ballotCancellationDay?: number` (the one day owed a cancelled ballot).
- `disciplinaryRemovals?: readonly DisciplinaryRemoval[]`: the reasoned occurrence/effective-exclusion/physical-departure/public-announcement ledger below.
- `bestMove` retains `playerSeat`, `selectedSeats`, optional `mafiaHits`, and adds optional `completionReason: BestMoveCompletionReason`, `readbackAcknowledged: boolean`.
- `adjudication?: OpponentVictoryAdjudication` exactly `{losingTeam:'red'|'black', offenderSeat?:number, rule:string, reason:string, committeeApproved:boolean}`.
- `rulesDrawReason?: RulesDrawReason` exactly `{rule:'6.5.6', completedGameNights:number, consecutiveUnchangedNights:3}`. **Use this exact field for Finish/save/result reason**, not `shouldSuggestDraw` or a fabricated `game.drawn` action. Automatic termination occurs on the third unchanged completed game night, including planning. A real departure resets the streak immediately.

Persist all domain fields unchanged. V2 baseline/event admission validates their shape and consistency, including counters, STOP prefixes, ballot voter/candidate eligibility, reviewed rulings, removal ledgers, transcript-derived Best Move score, draw basis and adjudication/winner agreement. Federation-specific fields/phases/events are not admitted under v1. V2 canonical actions validate their input and output states.

## Reversible nomination/support attribution (both supported editions)

This additive observation/correction contract is **not a new rules edition**. The package root exports:

```ts
interface Nomination {
  readonly nominatorSeat: number;
  readonly candidateSeat: number;
  readonly order: number;
  readonly supporterSeats?: readonly number[];
}
setNominationSelection(
  game: GameState,
  nominatorSeat: number,
  candidateSeat: number,
  selected: boolean,
): GameState;
// CanonicalGameEventDraft:
// { type: 'nomination.selection-set',
//   payload: { nominatorSeat: number, candidateSeat: number, selected: boolean } }
```

- Direct calls require a day-phase active current speaker and an active seated target. Each speaker may create one new nominee and additionally support any number of existing nominees, once per target. Support does not consume the new-nomination allowance. The original nominator is never an additional supporter; candidates may support their own candidacy when nominated by someone else.
- `selected: false` removes only the actor's support, or their own original nomination (restoring their allowance). Removing an original nominee removes that entry and renumbers survivors; it never replaces another nominee. Surviving supporters retain insertion order. Existing edition-specific candidate-removal cleanup remains unchanged. Inactive original nominators/supporters remain attributed on surviving candidates, not eligible as current actors or ballot votes.
- Direct duplicate selections, absent deselections and attempts at a second new nominee return the **identical `game` object**. Check this before recording a card action. Canonical admission rejects those no-ops with `GameRuleError.code === 'duplicate-action'` and message `Nomination selection must change the actor's relation`; `tryApplyGameEvent` returns `{ok:false,error}`. Do not append a no-op or discard later unrelated accepted events to implement a correction.
- Canonical application folds omitted provisional day turns forward to the payload actor using the same normalization as `player.nominated`. Earlier, inactive and unreachable actors are rejected; the application must take the actor from its displayed current speaker, not arbitrary card input. The direct helper never advances the speaker.
- The new canonical event is meaningful and **secret/host-only**. Admission validates exact payload keys, a boolean selection, seats 1–10 and unique additional supporters. Use each game's captured replay/rules metadata through `createGameLogEntry`; v1 remains v1 and v2 remains v2.
- `supporterSeats` is optional on both editions. Missing remains missing, including after legacy actions; removing the last support omits the property. Snapshot admission rejects duplicate/out-of-range/non-integer supporters and nominators also listed as supporters. Existing `nominate` / `player.nominated` keep their old strict meaning, secrecy, JSON shapes and hashes. No historical supporters are invented and there is no metadata/version bump.
- Counts/summaries derive surviving `nominations` relations, not the number of selection events. Turn changes keep relations; existing round/night transitions clear current-round nominations while earlier replay frames retain attribution. Supports never modify `voteAssignments`, actual ballot totals or outcome/rating rules.

## Ordered ballot APIs and events

The current host UI uses `voting.candidate-selected {candidateSeat}` (`selectHostVotingCandidate`) and `vote.recorded {voterSeat,candidateSeat:number|null}` (`recordHostVote`). Both are private canonical events. They enable optional `ballot.hostRecording:true` without changing or inventing any recorded announcement/mention/STOP facts. The selected nominee receives taps; null clears a transcription. Deliberate selection of the final unreviewed nominee assigns the remaining eligible votes. Restoration never does. A dispute pauses recording/selection/resolution, and a reviewed candidate's count cannot be changed through ordinary recording. Other candidates can still be recorded. Dispute and final-ruling reasons remain mandatory.

The APIs below retain their historical ceremonial meaning and unchanged replay hashes. The host UI does not require or emit these ceremony events; older saved ballots can continue through the explicit new actions. `currentTurnIndex` retains the old ordered-call meaning; host navigation uses `selectedCandidateSeat` only.

`FederationBallot` is `{orderAnnouncements:0|1|2, mention:0|1|2, stopped:boolean, selectedCandidateSeat:number, acceptedCandidateSeats:readonly number[], reviewedCandidateSeats:readonly number[], dispute?:{candidateSeat:number,reason:string}, finalRuling?:{candidateSeat:number,reason:string,externalReviewAcknowledged:true}}`.

`currentTurnIndex` remains the **live ordered cursor**. Inspection uses `ballot.selectedCandidateSeat`; do not set the live cursor from inspected cards.

| Reducer                                                                        | V2 canonical draft                                                            | Secret        |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------- |
| `announceVotingOrder(game)`                                                    | `voting.order-announced {}`                                                   | yes           |
| `mentionVotingCandidate(game)`                                                 | `voting.candidate-mentioned {candidateSeat}`                                  | no            |
| `selectVotingCandidate(game, seat)` / `inspectFederationCandidate(game, seat)` | `voting.candidate-inspected {candidateSeat}`                                  | yes           |
| `assignVote(game,voter,candidate)` / `acceptFederationVote(...)`               | `vote.accepted {voterSeat,candidateSeat}`                                     | no            |
| `stopVotingCandidate(game)`                                                    | `voting.candidate-stopped {candidateSeat}`                                    | no            |
| `advanceVotingCandidate(game)` / `advanceFederationCandidate(game)`            | `voting.live-advanced {candidateSeat}`                                        | no            |
| `correctAcceptedVote(game,voter,candidateOrNull,reason)`                       | `vote.corrected {voterSeat,candidateSeat:number                               | null,reason}` | yes |
| `disputeVotingCount(game,candidate,reason)`                                    | `voting.count-disputed {candidateSeat,reason}`                                | no            |
| `ruleOnVotingDispute(game,assignments,externalReviewAcknowledged,reason)`      | `voting.count-ruled {voteAssignments,externalReviewAcknowledged:true,reason}` | yes           |
| `skipFederationVoting(game,reason)`                                            | `voting.legally-skipped {reason}`                                             | no            |

Announce the whole order twice; each candidate has two mentions; accept that live candidate's hands only between the second mention and STOP. Then advance. Accepted votes cannot be toggled off/recast; corrections require the explicit reasoned correction API. Actual last-candidate second mention fills remaining eligible assignments once. Inspection does not fill or call anything. Dispute pauses acceptance, STOP, advancement and resolution until a human recording-review acknowledgement and final ruling; an ordinary repeat appeal of that reviewed count is rejected. No video API is assumed.

Existing `voting.resolved {voteAssignments,result}` remains the accepted result event, but v2 must summarize the exact already-recorded map, not overwrite it or synthesize a cursor. `resolveVote` requires either explicit host recording or historical STOP, and complete assignments or a mathematically conclusive winner. It never invents missing votes. Existing collective resolution may similarly accept a conclusive partial yes/no map; preserve the supplied decisions and eligible-voter count.

A later sole nominee leaves automatically with the rule's implicit eligible votes as discussion completes, without an open ballot. No nominees and zero-round sole nominees go directly to night with a named basis. Generic `skipVoting` and `cancelVoting(...host-skipped)` are rejected in federation play.

`CollectiveLiftSkipReason` is `'all-active'|'nine-three-restricted'|'zero-round-five'`. `LegalVotingSkipReason` additionally includes `'no-nominees'|'zero-round-sole-nominee'|'disciplinary-cancellation'`. `getCollectiveLiftEligibility(game,seats)` returns `{permitted:true}` or `{permitted:false,reason}`. Nine-player/three-candidate collective lifting needs **both** three completed game nights and two actual Sheriff checks. Zero-round five-candidate lifting and all-active lifting are prohibited. The existing result kind `eliminate-all-skipped` adds v2-only optional `skipReason`; tie speeches/repeat ballots otherwise retain their normal flow.

## Shooting, checks and Best Move

- `recordActualMultipleShot(game,shooterSeat)` → secret v2 event `mafia.multiple-shot-observed {shooterSeat}`. It is not removed by ordinary clerical target edits.
- `transitionToNight` captures only currently eligible check owners in v2. A previously departed owner cannot check; a same-night legitimate shot victim retains the captured check entitlement unless separately disqualified.
- `prepareBestMove(game)` enters Best Move from `night-resolution` while still at the night/day number before morning. `completeNight` returns this preparation when eligible; to obtain a canonical transition use `phase.changed {to:'best-move'}`. First-day two-or-more departures, a disabled setting, a disqualified victim, configured Casper exclusion and a decisive kill exclude it.
- `acceptBestMoveSeat(game,seat)` → secret `best-move.number-accepted {seat}`. Spoken entries append in order, including repeats and any seated number; maximum three. This is not editable active-other-seat selection.
- `correctBestMoveSlip(game,index,seat,reason)` → secret `best-move.slip-corrected {index,seat,reason}`. Changes an existing accepted index only; identifies an obvious spoken slip, not a strategic replacement. A same-night correction after readback recomputes scoring.
- `finalizeBestMove(game,reason,readbackAcknowledged)` → secret `best-move.finalized {reason,readbackAcknowledged:true}`. Reasons: `'complete-list'|'interrupted'|'time-expired'|'declined'|'finished-early'`. Complete-list needs three entries; decline needs zero. Partial Finish early preserves every accepted entry. Acknowledgement is human, not automatic speech recognition.
- `skipBestMove(game)` is the zero-entry decline convenience. `toggleBestMoveSeat` delegates to **append acceptance** in federation play; UI must not present it as a reversible selection. `completeBestMove` is a compatibility convenience choosing decline/complete-list/finished-early and returning `night-resolution`, not farewell. New UI should send explicit finalized drafts. Legacy `best-move.completed` is rejected under v2.
- Finalization returns `night-resolution` without morning advancement. Then `completeNight` (canonical `phase.changed` to the actual next phase) increments the completed-night count and enters morning/farewell. Numerical victory suppresses farewell. Ordinary pending third-foul restriction does not suppress farewell.

## Discipline and publication

`RemovalObservation` is exactly `{seat:number, stage:RemovalOccurrenceStage, rule:string, reason:string, checkInProgress:boolean}`. Rules are `6.2.1`–`6.2.13`; an additional reason is optional, represented by an empty string. Supplied notes are trimmed, at most 500 characters, and preserved. This applies to fourth-foul removals too; other reason-requiring actions are unchanged. Host supplies the physical occurrence/check timing fact explicitly; an app timestamp or timer is not that fact. UI options show the unchanged number plus a localized one/two-word rule description; descriptions are not substituted for host notes in stored events.

Stages: `'agreement'|'before-shooting-count'|'shooting-count'|'don-check'|'sheriff-check'|'day-discussion'|'open-voting'|'after-voting-result'|'farewell'`.

`DisciplinaryRemoval` adds `{occurredPhase:GamePhase,day:number,effectiveExcluded:true,departure:'pending'|'departed',announcement:'pending'|'announced',shotDeath:boolean,checkCompletionPending:boolean}`.

- `observeDisciplinaryRemoval(game,observation)` → secret `discipline.removal-observed` with that exact observation payload. The player becomes effectively excluded immediately; physical departure and announcement have separate ledger states. Removed shooters never contribute a shot. A count-stage targeted removal may legitimately be both shot-dead and disqualified; a pre-count removal cannot be shot-dead.
- `announceDisciplinaryRemovals(game,seats?)` → **public seat-only** `discipline.removals-announced {seats}`. **Record this immediately after a day/planning/pre-count observation**, before further canonical gameplay. For shooting-count removal announce immediately after the accepted shooting result, before opening private checks; for check removals wait until after Sheriff completion. Night/morning advancement will not bypass pending night announcements. After numerical termination, publication of an already departed pending removal is still permitted; new gameplay/removal observations are not.
- An already-underway Don/Sheriff check can complete once before physical departure; do not use skip-check to dispose of it. Non-started and subsequent checks are ineligible. Completion evaluates the resulting numerical outcome before further gameplay.
- Current/nearest-day cancellation debt coalesces once. Post-result non-victim removal preserves the accepted current result and owes the next day's ballot. Legitimate vote/shot victims have the cancellation exception and are counted once. `beginNight` consumes the applicable current-day debt and preserves future-day debt.
- `redCard(game,seat,observation?)` requires the reasoned observation for federation disqualification. An ordinary fourth foul may infer the known `6.2.1` reason/stage; night fourth fouls require explicit timing. No generic rule/violation is guessed for other removals.
- `issueFoul(game,seat,removalObservation?)` supports explicit fourth-foul timing. Secret v2 `discipline.foul-issued {seat,foulNumber:4,redCarded:true,removal:RemovalObservation}` carries private timing metadata; existing public `foul.issued` remains available for ordinary foul notices. The legacy unreasoned `player.red-carded` event has no usable federation removal path: use the observed event.
- Third foul uses existing `PlayerState.mutePending` as unconsumed nearest-ordinary-turn debt; `currentSpeechRestricted` snapshots entitlement at turn start. It survives nights, does not retroactively shorten the current speech, and tie speech does not consume it. `getCurrentTurnDuration` adds **0** for nomination-only, 30 at three/four active players, otherwise 60. Do not run a zero-second countdown or automatically complete the nomination opportunity.

## Adjudication and result handoff

`adjudicateOpponentVictory(game,adjudication)` → public v2 `game.adjudicated` with exactly the adjudication object above. Applicable rules are `6.3.1`–`6.3.5` and `6.6.4`. Rule `6.3.5` requires `committeeApproved:true`. Winner is opposite losing team; optional offender must belong to that losing team. Player statuses are unchanged. `game.completed {winner}` preserves the adjudication and refuses contradictory winners; subsequent ordinary gameplay is rejected.

Authoritative result JSON should carry `game.adjudication` additively; keep win projection `reason:null`. Automatic draw result should derive its display/save reason from `game.rulesDrawReason`; terminal automatic draws do not need or admit a manual confirmation action.

## Exported support functions

`assertFederationAction`, `assertJudgeReason`, `requireFederationBallot`, `createFederationBallot`, `validateFederationVotes`, `assertRemovalObservation`, `removalOccurrenceStages`, `settleShootingRemovals`, `settleCheckRemoval`, and `completeFederationGameNight` are exported implementation/support primitives. UI should normally use accepted canonical events rather than invoking settlement/night-completion helpers independently. Settlement helpers are internal rule-boundary operations, not referee commands.

## Verification / remaining integration

Domain unit and JSON/hash replay tests exercise lifecycle, legacy pins, ordered acceptance/corrections/disputes, conclusive close, restricted ties, partial/zero Best Move, sanctions, shot-plus-DQ, deferred checks/announcements, cancellation debt, automatic draw and adjudication. Domain typecheck, eslint, formatting and build are task-local gates. Parent still owns the full `.idd/verification.yaml` `npm run check:local` integration gate, UI/timer/event wiring, real-browser flows and authoritative server/store result round trips. No app/default activation, commit, push or deployment belongs to this change.
