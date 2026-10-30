import { assertCasperRole } from "./casper.js";
import {
  announceDisciplinaryRemovals,
  assertRemovalObservation,
  observeDisciplinaryRemoval,
} from "./federation-discipline.js";
import {
  acceptBestMoveSeat,
  acceptFederationVote,
  adjudicateOpponentVictory,
  advanceFederationCandidate,
  announceVotingOrder,
  assertJudgeReason,
  correctAcceptedVote,
  correctBestMoveSlip,
  disputeVotingCount,
  finalizeBestMove,
  inspectFederationCandidate,
  selectHostVotingCandidate,
  recordHostVote,
  mentionVotingCandidate,
  recordActualMultipleShot,
  recordBestMove,
  recordShotObservations,
  ruleOnVotingDispute,
  skipBestMove,
  stopVotingCandidate,
  toggleBestMoveSelection,
} from "./federation-actions.js";
import {
  acceptCarCrashBallot,
  acceptCompletedCarCrashCount,
  beginCarCrash,
  beginCarCrashDecision,
  beginSkippedCarCrashDecision,
  completeCarCrashResult,
  completeEliminations,
  issueFoul,
  nominate,
  setNominationSelection,
  resolveCarCrashVote,
  resolveCompletedCarCrashCount,
  resolveVote,
  skipFederationVoting,
} from "./day-actions.js";
import {
  advanceOpeningPhase,
  advanceSetupPhase,
  cancelGame,
  confirmDraw,
  isTerminalGamePhase,
} from "./game.js";
import { GameHistoryError, withHistoryDiagnostic } from "./history-diagnostics.js";
import {
  beginNight,
  completeGoodbyeSpeech,
  completeMafiaShots,
  completeNight,
  continueDonCheck,
  continueSheriffCheck,
  performDonCheck,
  performSheriffCheck,
  recordMafiaShot,
  resolveMafiaShots,
  skipDonCheck,
  skipSheriffCheck,
} from "./night-actions.js";
import { completeCurrentTurn } from "./day-actions.js";
import { toGameRuleError, GameRuleError } from "./rule-error.js";
import type {
  CarCrashVoteResult,
  GamePhase,
  GameState,
  NightShotResult,
  ShotAssignment,
  ShotObservation,
  VoteResult,
  BestMoveCompletionReason,
  LegalVotingSkipReason,
  OpponentVictoryAdjudication,
  RemovalObservation,
} from "./types.js";
/** Canonical serialization shape, never a gameplay selector. */
export const CURRENT_REPLAY_VERSION = 3 as const;
export type ReplayVersion = typeof CURRENT_REPLAY_VERSION;
const assertReplayVersion: (value: unknown) => asserts value is ReplayVersion = (value) => {
  if (value !== CURRENT_REPLAY_VERSION) {
    throw new Error(`Unsupported replay version ${String(value)}`);
  }
};
type ReplayMetadata = {
  readonly replayVersion: ReplayVersion;
};
export const canonicalGameEventTypes = [
  "game.started",
  "game.checkpointed",
  "phase.changed",
  "turn.completed",
  "player.nominated",
  "foul.issued",
  "voting.resolved",
  "car-crash.resolved",
  "car-crash.ballot-resolved",
  "mafia.shots-resolved",
  "don.checked",
  "don.check-skipped",
  "sheriff.checked",
  "sheriff.check-skipped",
  "game.completed",
  "game.drawn",
  "game.cancelled",
  "voting.order-announced",
  "voting.candidate-mentioned",
  "voting.candidate-inspected",
  "voting.candidate-stopped",
  "voting.live-advanced",
  "vote.accepted",
  "vote.recorded",
  "voting.candidate-selected",
  "vote.corrected",
  "voting.count-disputed",
  "voting.count-ruled",
  "voting.legally-skipped",
  "mafia.multiple-shot-observed",
  "best-move.number-accepted",
  "best-move.slip-corrected",
  "best-move.finalized",
  "best-move.selection-toggled",
  "best-move.recorded",
  "best-move.skipped",
  "game.adjudicated",
  "discipline.removal-observed",
  "discipline.removals-announced",
  "discipline.foul-issued",
  "car-crash.count-completed",
  "mafia.shots-observed",
  "nomination.selection-set",
] as const;
export type CanonicalGameEventType = (typeof canonicalGameEventTypes)[number];
interface EventDraft<Type extends CanonicalGameEventType, Payload> {
  readonly type: Type;
  readonly payload: Payload;
}
type WithOptionalDisciplineContext<Payload> =
  | (Payload & {
      readonly phase: GamePhase;
      readonly currentTurnIndex: number;
    })
  | (Payload & {
      readonly phase?: never;
      readonly currentTurnIndex?: never;
    });
export type CanonicalGameEventDraft =
  | EventDraft<"game.started", Record<string, never>>
  | EventDraft<"game.checkpointed", Record<string, never>>
  | EventDraft<
      "phase.changed",
      {
        readonly to: GamePhase;
      }
    >
  | EventDraft<
      "turn.completed",
      {
        readonly seat: number;
      }
    >
  | EventDraft<
      "player.nominated",
      {
        readonly nominatorSeat: number;
        readonly candidateSeat: number;
      }
    >
  | EventDraft<
      "nomination.selection-set",
      {
        readonly nominatorSeat: number;
        readonly candidateSeat: number;
        readonly selected: boolean;
      }
    >
  | EventDraft<
      "foul.issued",
      WithOptionalDisciplineContext<{
        readonly seat: number;
        readonly foulNumber: number;
        readonly redCarded: boolean;
      }>
    >
  | EventDraft<
      "voting.resolved",
      {
        readonly voteAssignments: Readonly<Record<number, number>>;
        readonly result: VoteResult;
      }
    >
  | EventDraft<
      "car-crash.resolved",
      {
        readonly votes: Readonly<Record<number, boolean>>;
        readonly result: CarCrashVoteResult;
      }
    >
  | EventDraft<
      "car-crash.ballot-resolved",
      {
        readonly votes: Readonly<Record<number, boolean>>;
        readonly result: CarCrashVoteResult;
      }
    >
  | EventDraft<
      "mafia.shots-resolved",
      {
        readonly shots: readonly ShotAssignment[];
        readonly result: NightShotResult;
      }
    >
  | EventDraft<
      "don.checked",
      {
        readonly targetSeat: number;
        readonly match: boolean;
      }
    >
  | EventDraft<"don.check-skipped", Record<string, never>>
  | EventDraft<
      "sheriff.checked",
      {
        readonly targetSeat: number;
        readonly match: boolean;
      }
    >
  | EventDraft<"sheriff.check-skipped", Record<string, never>>
  | EventDraft<
      "game.completed",
      {
        readonly winner: "red" | "black";
      }
    >
  | EventDraft<
      "game.drawn",
      {
        readonly reason: string;
      }
    >
  | EventDraft<
      "game.cancelled",
      {
        readonly reason: string;
      }
    >
  | EventDraft<"voting.order-announced", Record<string, never>>
  | EventDraft<
      | "voting.candidate-mentioned"
      | "voting.candidate-inspected"
      | "voting.candidate-stopped"
      | "voting.live-advanced",
      {
        readonly candidateSeat: number;
      }
    >
  | EventDraft<
      "vote.accepted",
      {
        readonly voterSeat: number;
        readonly candidateSeat: number;
      }
    >
  | EventDraft<
      "vote.recorded",
      {
        readonly voterSeat: number;
        readonly candidateSeat: number | null;
      }
    >
  | EventDraft<
      "voting.candidate-selected",
      {
        readonly candidateSeat: number;
      }
    >
  | EventDraft<
      "vote.corrected",
      {
        readonly voterSeat: number;
        readonly candidateSeat: number | null;
        readonly reason: string;
      }
    >
  | EventDraft<
      "voting.count-disputed",
      {
        readonly candidateSeat: number;
        readonly reason: string;
      }
    >
  | EventDraft<
      "voting.count-ruled",
      {
        readonly voteAssignments: Readonly<Record<number, number>>;
        readonly externalReviewAcknowledged: true;
        readonly reason: string;
      }
    >
  | EventDraft<
      "voting.legally-skipped",
      {
        readonly reason: LegalVotingSkipReason;
      }
    >
  | EventDraft<
      "mafia.multiple-shot-observed",
      {
        readonly shooterSeat: number;
      }
    >
  | EventDraft<
      "mafia.shots-observed",
      {
        /** Captures the provisional transcription atomically with the accepted physical facts. */
        readonly shotAssignments: Readonly<Partial<Record<number, number>>>;
        readonly observations: readonly Pick<ShotObservation, "shooterSeat" | "targetSeat">[];
      }
    >
  | EventDraft<
      "car-crash.count-completed",
      {
        readonly votes: Readonly<Record<number, boolean>>;
        readonly result: CarCrashVoteResult;
      }
    >
  | EventDraft<
      "best-move.number-accepted",
      {
        readonly seat: number;
      }
    >
  | EventDraft<
      "best-move.slip-corrected",
      {
        readonly index: number;
        readonly seat: number;
        readonly reason: string;
      }
    >
  | EventDraft<
      "best-move.finalized",
      {
        readonly reason: BestMoveCompletionReason;
        readonly readbackAcknowledged: true;
      }
    >
  | EventDraft<"best-move.selection-toggled", { readonly seat: number }>
  | EventDraft<"best-move.recorded", Record<string, never>>
  | EventDraft<"best-move.skipped", Record<string, never>>
  | EventDraft<"game.adjudicated", OpponentVictoryAdjudication>
  | EventDraft<"discipline.removal-observed", RemovalObservation>
  | EventDraft<
      "discipline.removals-announced",
      {
        readonly seats: readonly number[];
      }
    >
  | EventDraft<
      "discipline.foul-issued",
      {
        readonly seat: number;
        readonly foulNumber: 4;
        readonly redCarded: true;
        readonly removal: RemovalObservation;
      }
    >;
export type InitialGameBaseline = ReplayMetadata & {
  readonly game: GameState;
};
export type GameLogEntry = CanonicalGameEventDraft &
  ReplayMetadata & {
    readonly id: string;
    readonly gameId: string;
    readonly sequence: number;
    readonly parentEventId: string | null;
    readonly phaseBefore: GamePhase;
    readonly phaseAfter: GamePhase;
    readonly dayBefore: number;
    readonly dayAfter: number;
    readonly stateHashAfter: string;
    readonly createdAt: string;
  };
export interface ReplayFrame {
  readonly entry: GameLogEntry;
  readonly before: GameState;
  readonly after: GameState;
}
const canonicalGameEventTypeSet = new Set<string>(canonicalGameEventTypes);
export const isCanonicalGameEventType = (value: string): value is CanonicalGameEventType =>
  canonicalGameEventTypeSet.has(value);
export const isProvisionalInteractionType = (value: string): boolean =>
  value === "vote.assigned" ||
  value === "vote.removed" ||
  value === "voting.candidate-advanced" ||
  value === "car-crash.vote-assigned" ||
  value === "mafia.shot-recorded" ||
  value.startsWith("setup.") ||
  value.startsWith("timer.") ||
  value.startsWith("music.");
const intermediatePhaseTargets = new Set<GamePhase>([
  "voting-cancelled",
  "night-don",
  "night-sheriff",
  "best-move",
]);
export const isMeaningfulGameEventDraft = (event: CanonicalGameEventDraft): boolean =>
  event.type !== "turn.completed" &&
  (event.type !== "phase.changed" || !intermediatePhaseTargets.has(event.payload.to));
export const canonicalGameEventSecrecy = {
  "game.started": true,
  "game.checkpointed": true,
  "phase.changed": false,
  "turn.completed": false,
  "player.nominated": false,
  "foul.issued": false,
  "voting.resolved": false,
  "car-crash.resolved": false,
  "car-crash.ballot-resolved": false,
  "mafia.shots-resolved": true,
  "don.checked": true,
  "don.check-skipped": true,
  "sheriff.checked": true,
  "sheriff.check-skipped": true,
  "game.completed": false,
  "game.drawn": false,
  "game.cancelled": false,
  "voting.order-announced": true,
  "voting.candidate-mentioned": false,
  "voting.candidate-inspected": true,
  "voting.candidate-stopped": false,
  "voting.live-advanced": false,
  "vote.accepted": false,
  "vote.recorded": true,
  "voting.candidate-selected": true,
  "vote.corrected": true,
  "voting.count-disputed": false,
  "voting.count-ruled": true,
  "voting.legally-skipped": false,
  "mafia.multiple-shot-observed": true,
  "best-move.number-accepted": true,
  "best-move.slip-corrected": true,
  "best-move.finalized": true,
  "best-move.selection-toggled": true,
  "best-move.recorded": true,
  "best-move.skipped": true,
  "game.adjudicated": false,
  "discipline.removal-observed": true,
  "discipline.removals-announced": false,
  "discipline.foul-issued": true,
  "car-crash.count-completed": false,
  "mafia.shots-observed": true,
  "nomination.selection-set": true,
} as const satisfies Readonly<Record<CanonicalGameEventType, boolean>>;
export const canonicalSecretGameEventTypes = canonicalGameEventTypes.filter(
  (type) => canonicalGameEventSecrecy[type],
);
type UnknownRecord = Record<string, unknown>;
export const isSecretGameEventType = (value: string): boolean =>
  !isCanonicalGameEventType(value) || canonicalGameEventSecrecy[value];
const canonicalGamePhaseSet = new Set<string>([
  "mafia-planning",
  "mafia-sleep",
  "don-identification",
  "sheriff-identification",
  "free-seating",
  "day",
  "voting",
  "voting-cancelled",
  "car-crash",
  "car-crash-decision",
  "car-crash-result",
  "car-crash-skipped",
  "goodbye-speech",
  "best-move",
  "night-mafia",
  "night-mafia-result",
  "night-don",
  "night-don-result",
  "night-sheriff",
  "night-sheriff-result",
  "night-resolution",
  "finished",
  "draw",
  "cancelled",
] satisfies readonly GamePhase[]);
const requireRecord = (value: unknown, context: string): UnknownRecord => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as UnknownRecord;
};
const assertExactKeys = (
  value: UnknownRecord,
  expectedKeys: readonly string[],
  context: string,
): void => {
  const expected = new Set(expectedKeys);
  const actual = Object.keys(value);
  const unexpected = actual.filter((key) => !expected.has(key));
  const missing = expectedKeys.filter((key) => !Object.hasOwn(value, key));
  if (unexpected.length > 0 || missing.length > 0) {
    const details = [
      unexpected.length > 0 ? `unexpected ${unexpected.join(", ")}` : "",
      missing.length > 0 ? `missing ${missing.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    throw new Error(`${context} has invalid fields (${details})`);
  }
};
const assertObjectKeys = (
  value: UnknownRecord,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  context: string,
): void => {
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = requiredKeys.filter((key) => !Object.hasOwn(value, key));
  if (unexpected.length > 0 || missing.length > 0) {
    const details = [
      unexpected.length > 0 ? `unexpected ${unexpected.join(", ")}` : "",
      missing.length > 0 ? `missing ${missing.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    throw new Error(`${context} has invalid fields (${details})`);
  }
};
const assertBoolean: (value: unknown, context: string) => asserts value is boolean = (
  value,
  context,
) => {
  if (typeof value !== "boolean") throw new Error(`${context} must be a boolean`);
};
const assertSafeInteger: (
  value: unknown,
  context: string,
  minimum: number,
) => asserts value is number = (value, context, minimum) => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${context} must be a safe integer of at least ${minimum}`);
  }
};
const assertSeat: (value: unknown, context: string) => asserts value is number = (
  value,
  context,
) => {
  assertSafeInteger(value, context, 1);
  if (value > 10) throw new Error(`${context} must be between 1 and 10`);
};
const assertSeatArray: (value: unknown, context: string) => asserts value is number[] = (
  value,
  context,
) => {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  for (const [index, seat] of value.entries()) assertSeat(seat, `${context}[${index}]`);
  if (new Set(value).size !== value.length)
    throw new Error(`${context} must not contain duplicates`);
};
const assertCanonicalSeatRecord = (
  value: unknown,
  context: string,
  assertValue: (entry: unknown, entryContext: string) => void,
): void => {
  const record = requireRecord(value, context);
  for (const [key, entry] of Object.entries(record)) {
    const seat = Number(key);
    if (!Number.isSafeInteger(seat) || String(seat) !== key) {
      throw new Error(`${context} keys must use canonical seat numbers`);
    }
    assertSeat(seat, `${context} key ${key}`);
    assertValue(entry, `${context}[${key}]`);
  }
};
const assertVoteResult = (value: unknown, context: string): void => {
  const result = requireRecord(value, context);
  assertObjectKeys(result, ["kind", "seats", "totals"], ["skipReason"], context);
  if (
    result.skipReason !== undefined &&
    (result.kind !== "eliminate-all-skipped" ||
      !["all-active", "nine-three-restricted", "zero-round-five"].includes(
        result.skipReason as string,
      ))
  )
    throw new Error(`${context}.skipReason is invalid`);
  if (
    result.kind !== "winner" &&
    result.kind !== "car-crash" &&
    result.kind !== "eliminate-both-vote" &&
    result.kind !== "eliminate-all-skipped"
  ) {
    throw new Error(`${context}.kind is invalid`);
  }
  assertSeatArray(result.seats, `${context}.seats`);
  assertCanonicalSeatRecord(result.totals, `${context}.totals`, (entry, entryContext) =>
    assertSafeInteger(entry, entryContext, 0),
  );
};
const assertCarCrashVoteResult = (value: unknown, context: string): void => {
  const result = requireRecord(value, context);
  assertExactKeys(result, ["eliminate", "seats", "yesVotes", "eligibleVoters"], context);
  assertBoolean(result.eliminate, `${context}.eliminate`);
  assertSeatArray(result.seats, `${context}.seats`);
  assertSafeInteger(result.yesVotes, `${context}.yesVotes`, 0);
  assertSafeInteger(result.eligibleVoters, `${context}.eligibleVoters`, 0);
};
const assertNightShotResult = (value: unknown, context: string): void => {
  const result = requireRecord(value, context);
  if (result.kind === "miss") {
    assertExactKeys(result, ["kind"], context);
    return;
  }
  if (result.kind !== "kill" && result.kind !== "no-effect") {
    throw new Error(`${context}.kind is invalid`);
  }
  assertExactKeys(result, ["kind", "targetSeat"], context);
  assertSeat(result.targetSeat, `${context}.targetSeat`);
};
const assertOptionalDisciplineContext = (payload: UnknownRecord, context: string): void => {
  const hasPhase = Object.hasOwn(payload, "phase");
  const hasCurrentTurnIndex = Object.hasOwn(payload, "currentTurnIndex");
  if (hasPhase !== hasCurrentTurnIndex) {
    throw new Error(`${context} must provide phase and currentTurnIndex together`);
  }
  if (!hasPhase) return;
  if (typeof payload.phase !== "string" || !canonicalGamePhaseSet.has(payload.phase)) {
    throw new Error(`${context}.phase is not a canonical game phase`);
  }
  assertSafeInteger(payload.currentTurnIndex, `${context}.currentTurnIndex`, 0);
};
const openingPhases = new Set<string>([
  "mafia-sleep",
  "don-identification",
  "sheriff-identification",
  "free-seating",
]);
const bestMoveCompletionReasons = [
  "complete-list",
  "interrupted",
  "time-expired",
  "declined",
  "finished-early",
];
const legalVotingSkipReasons = [
  "all-active",
  "nine-three-restricted",
  "zero-round-five",
  "no-nominees",
  "zero-round-sole-nominee",
  "disciplinary-cancellation",
];
const assertAdjudication = (value: unknown, context: string): void => {
  const ruling = requireRecord(value, context);
  assertObjectKeys(
    ruling,
    ["losingTeam", "rule", "reason", "committeeApproved"],
    ["offenderSeat"],
    context,
  );
  if (ruling.losingTeam !== "red" && ruling.losingTeam !== "black")
    throw new Error(`${context}.losingTeam is invalid`);
  if (typeof ruling.rule !== "string" || !/^(6\.3\.[1-5]|6\.6\.4)$/.test(ruling.rule))
    throw new Error(`${context}.rule is invalid`);
  assertJudgeReason(ruling.reason as string);
  assertBoolean(ruling.committeeApproved, `${context}.committeeApproved`);
  if (ruling.rule === "6.3.5" && !ruling.committeeApproved)
    throw new Error("Rule 6.3.5 requires committee agreement");
  if (ruling.offenderSeat !== undefined) assertSeat(ruling.offenderSeat, `${context}.offenderSeat`);
};
const assertCanonicalPayload = (type: CanonicalGameEventType, value: unknown): void => {
  const payload = requireRecord(value, `${type} payload`);
  switch (type) {
    case "discipline.foul-issued": {
      assertExactKeys(payload, ["seat", "foulNumber", "redCarded", "removal"], `${type} payload`);
      assertSeat(payload.seat, `${type}.seat`);
      const removal = requireRecord(payload.removal, `${type}.removal`);
      assertExactKeys(
        removal,
        ["seat", "stage", "rule", "reason", "checkInProgress"],
        `${type}.removal`,
      );
      assertRemovalObservation(removal as unknown as RemovalObservation);
      if (
        payload.foulNumber !== 4 ||
        payload.redCarded !== true ||
        removal.seat !== payload.seat ||
        removal.rule !== "6.2.1"
      )
        throw new Error("Fourth-foul removal metadata contradicts the action");
      return;
    }
    case "discipline.removal-observed":
      assertExactKeys(
        payload,
        ["seat", "stage", "rule", "reason", "checkInProgress"],
        `${type} payload`,
      );
      assertRemovalObservation(payload as unknown as RemovalObservation);
      return;
    case "discipline.removals-announced":
      assertExactKeys(payload, ["seats"], `${type} payload`);
      assertSeatArray(payload.seats, `${type}.seats`);
      if (!payload.seats.length) throw new Error("A removal announcement needs seats");
      return;
    case "voting.order-announced":
      assertExactKeys(payload, [], `${type} payload`);
      return;
    case "voting.candidate-mentioned":
    case "voting.candidate-inspected":
    case "voting.candidate-selected":
    case "voting.candidate-stopped":
    case "voting.live-advanced":
      assertExactKeys(payload, ["candidateSeat"], `${type} payload`);
      assertSeat(payload.candidateSeat, `${type}.candidateSeat`);
      return;
    case "vote.accepted":
      assertExactKeys(payload, ["voterSeat", "candidateSeat"], `${type} payload`);
      assertSeat(payload.voterSeat, `${type}.voterSeat`);
      assertSeat(payload.candidateSeat, `${type}.candidateSeat`);
      return;
    case "vote.recorded":
      assertExactKeys(payload, ["voterSeat", "candidateSeat"], `${type} payload`);
      assertSeat(payload.voterSeat, `${type}.voterSeat`);
      if (payload.candidateSeat !== null)
        assertSeat(payload.candidateSeat, `${type}.candidateSeat`);
      return;
    case "vote.corrected":
      assertExactKeys(payload, ["voterSeat", "candidateSeat", "reason"], `${type} payload`);
      assertSeat(payload.voterSeat, `${type}.voterSeat`);
      if (payload.candidateSeat !== null)
        assertSeat(payload.candidateSeat, `${type}.candidateSeat`);
      assertJudgeReason(payload.reason as string);
      return;
    case "voting.count-disputed":
      assertExactKeys(payload, ["candidateSeat", "reason"], `${type} payload`);
      assertSeat(payload.candidateSeat, `${type}.candidateSeat`);
      assertJudgeReason(payload.reason as string);
      return;
    case "voting.count-ruled":
      assertExactKeys(
        payload,
        ["voteAssignments", "externalReviewAcknowledged", "reason"],
        `${type} payload`,
      );
      assertCanonicalSeatRecord(payload.voteAssignments, `${type}.voteAssignments`, assertSeat);
      if (payload.externalReviewAcknowledged !== true)
        throw new Error("External recording review requires explicit judge acknowledgement");
      assertJudgeReason(payload.reason as string);
      return;
    case "voting.legally-skipped":
      assertExactKeys(payload, ["reason"], `${type} payload`);
      if (!legalVotingSkipReasons.includes(payload.reason as string))
        throw new Error("A named legal skip reason is required");
      return;
    case "mafia.multiple-shot-observed":
      assertExactKeys(payload, ["shooterSeat"], `${type} payload`);
      assertSeat(payload.shooterSeat, `${type}.shooterSeat`);
      return;
    case "mafia.shots-observed":
      assertExactKeys(payload, ["shotAssignments", "observations"], `${type} payload`);
      assertCanonicalSeatRecord(payload.shotAssignments, `${type}.shotAssignments`, assertSeat);
      if (!Array.isArray(payload.observations) || payload.observations.length === 0)
        throw new Error("Physical-shot observations require a nonempty array");
      for (const [index, value] of payload.observations.entries()) {
        const shot = requireRecord(value, `${type}.observations[${index}]`);
        assertExactKeys(shot, ["shooterSeat", "targetSeat"], `${type}.observations[${index}]`);
        assertSeat(shot.shooterSeat, `${type}.observations[${index}].shooterSeat`);
        assertSeat(shot.targetSeat, `${type}.observations[${index}].targetSeat`);
      }
      return;
    case "best-move.number-accepted":
    case "best-move.selection-toggled":
      assertExactKeys(payload, ["seat"], `${type} payload`);
      assertSeat(payload.seat, `${type}.seat`);
      return;
    case "best-move.slip-corrected":
      assertExactKeys(payload, ["index", "seat", "reason"], `${type} payload`);
      assertSafeInteger(payload.index, `${type}.index`, 0);
      if (payload.index > 2) throw new Error("Slip index exceeds three-entry transcript");
      assertSeat(payload.seat, `${type}.seat`);
      assertJudgeReason(payload.reason as string);
      return;
    case "best-move.finalized":
      assertExactKeys(payload, ["reason", "readbackAcknowledged"], `${type} payload`);
      if (
        !bestMoveCompletionReasons.includes(payload.reason as string) ||
        payload.readbackAcknowledged !== true
      )
        throw new Error("Best Move completion requires legal cutoff and acknowledged readback");
      return;
    case "game.adjudicated":
      assertAdjudication(payload, `${type} payload`);
      return;
    case "game.started":
    case "game.checkpointed":
    case "best-move.recorded":
    case "best-move.skipped":
    case "don.check-skipped":
    case "sheriff.check-skipped":
      assertExactKeys(payload, [], `${type} payload`);
      return;
    case "phase.changed":
      assertExactKeys(payload, ["to"], `${type} payload`);
      if (typeof payload.to !== "string" || !canonicalGamePhaseSet.has(payload.to)) {
        throw new Error(`${type} payload.to is not a canonical game phase`);
      }
      return;
    case "turn.completed":
      assertExactKeys(payload, ["seat"], `${type} payload`);
      assertSeat(payload.seat, `${type} payload.seat`);
      return;
    case "player.nominated":
      assertExactKeys(payload, ["nominatorSeat", "candidateSeat"], `${type} payload`);
      assertSeat(payload.nominatorSeat, `${type} payload.nominatorSeat`);
      assertSeat(payload.candidateSeat, `${type} payload.candidateSeat`);
      return;
    case "nomination.selection-set":
      assertExactKeys(payload, ["nominatorSeat", "candidateSeat", "selected"], `${type} payload`);
      assertSeat(payload.nominatorSeat, `${type} payload.nominatorSeat`);
      assertSeat(payload.candidateSeat, `${type} payload.candidateSeat`);
      assertBoolean(payload.selected, `${type} payload.selected`);
      return;
    case "foul.issued":
      assertObjectKeys(
        payload,
        ["seat", "foulNumber", "redCarded"],
        ["phase", "currentTurnIndex"],
        `${type} payload`,
      );
      assertSeat(payload.seat, `${type} payload.seat`);
      assertSafeInteger(payload.foulNumber, `${type} payload.foulNumber`, 1);
      assertBoolean(payload.redCarded, `${type} payload.redCarded`);
      assertOptionalDisciplineContext(payload, `${type} payload`);
      return;
    case "voting.resolved":
      assertExactKeys(payload, ["voteAssignments", "result"], `${type} payload`);
      assertCanonicalSeatRecord(
        payload.voteAssignments,
        `${type} payload.voteAssignments`,
        (entry, entryContext) => assertSeat(entry, entryContext),
      );
      assertVoteResult(payload.result, `${type} payload.result`);
      return;
    case "car-crash.resolved":
    case "car-crash.ballot-resolved":
    case "car-crash.count-completed":
      assertExactKeys(payload, ["votes", "result"], `${type} payload`);
      assertCanonicalSeatRecord(payload.votes, `${type} payload.votes`, assertBoolean);
      assertCarCrashVoteResult(payload.result, `${type} payload.result`);
      return;
    case "mafia.shots-resolved": {
      assertExactKeys(payload, ["shots", "result"], `${type} payload`);
      if (!Array.isArray(payload.shots)) throw new Error(`${type} payload.shots must be an array`);
      const shooterSeats = new Set<number>();
      for (const [index, value] of payload.shots.entries()) {
        const shot = requireRecord(value, `${type} payload.shots[${index}]`);
        assertExactKeys(
          shot,
          ["shooterSeat", "targetSeat", "secret"],
          `${type} payload.shots[${index}]`,
        );
        assertSeat(shot.shooterSeat, `${type} payload.shots[${index}].shooterSeat`);
        if (shooterSeats.has(shot.shooterSeat)) {
          throw new Error(`${type} payload.shots contains a duplicate shooterSeat`);
        }
        shooterSeats.add(shot.shooterSeat);
        assertSeat(shot.targetSeat, `${type} payload.shots[${index}].targetSeat`);
        if (shot.secret !== true) {
          throw new Error(`${type} payload.shots[${index}].secret must be true`);
        }
      }
      assertNightShotResult(payload.result, `${type} payload.result`);
      return;
    }
    case "don.checked":
    case "sheriff.checked":
      assertExactKeys(payload, ["targetSeat", "match"], `${type} payload`);
      assertSeat(payload.targetSeat, `${type} payload.targetSeat`);
      assertBoolean(payload.match, `${type} payload.match`);
      return;
    case "game.completed":
      assertExactKeys(payload, ["winner"], `${type} payload`);
      if (payload.winner !== "red" && payload.winner !== "black") {
        throw new Error(`${type} payload.winner is invalid`);
      }
      return;
    case "game.drawn":
    case "game.cancelled":
      assertExactKeys(payload, ["reason"], `${type} payload`);
      if (
        typeof payload.reason !== "string" ||
        payload.reason.length === 0 ||
        payload.reason !== payload.reason.trim() ||
        payload.reason.length > 500
      ) {
        throw new Error(
          `${type} payload.reason must be a trimmed reason of at most 500 characters`,
        );
      }
      return;
  }
};
export const assertCanonicalGameEventDraft: (
  value: unknown,
) => asserts value is CanonicalGameEventDraft = (value) => {
  const event = requireRecord(value, "Canonical event draft");
  assertExactKeys(event, ["type", "payload"], "Canonical event draft");
  if (typeof event.type !== "string" || !isCanonicalGameEventType(event.type)) {
    throw new Error("Canonical event type is invalid");
  }
  assertCanonicalPayload(event.type, event.payload);
};
const gameLogEntryKeys = [
  "type",
  "payload",
  "replayVersion",
  "id",
  "gameId",
  "sequence",
  "parentEventId",
  "phaseBefore",
  "phaseAfter",
  "dayBefore",
  "dayAfter",
  "stateHashAfter",
  "createdAt",
] as const;
const assertNonEmptyString: (value: unknown, context: string) => asserts value is string = (
  value,
  context,
) => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
};
const assertReplaySequence: (value: unknown) => asserts value is number = (value) =>
  assertSafeInteger(value, "Event sequence", 1);
const assertCreatedAt: (value: unknown) => asserts value is string = (value) => {
  assertNonEmptyString(value, "Event createdAt");
  if (!Number.isFinite(Date.parse(value))) throw new Error("Event createdAt must be a valid date");
};
const assertGamePhase: (value: unknown, context: string) => asserts value is GamePhase = (
  value,
  context,
) => {
  if (typeof value !== "string" || !canonicalGamePhaseSet.has(value)) {
    throw new Error(`${context} must be a canonical game phase`);
  }
};
const assertGameState: (value: unknown, context: string) => asserts value is GameState = (
  value,
  context,
) => {
  const game = requireRecord(value, context);
  assertObjectKeys(
    game,
    [
      "phase",
      "day",
      "players",
      "turnOrder",
      "currentTurnIndex",
      "nominations",
      "voteAssignments",
      "shotAssignments",
      "winner",
    ],
    [
      "completedGameNights",
      "sheriffChecksPerformed",
      "firstDayDepartureSeats",
      "currentSpeechRestricted",
      "actualMultipleShotSeats",
      "shotObservations",
      "ballot",
      "ballotSkipReason",
      "ballotCancellationDay",
      "adjudication",
      "rulesDrawReason",
      "disciplinaryRemovals",
      "votingCancellation",
      "votingRound",
      "carCrashSeats",
      "carCrashVotes",
      "carCrashResult",
      "goodbyeSeats",
      "goodbyeNext",
      "nightCheckEligibility",
      "checkResult",
      "nightResult",
      "dayNotice",
      "redCardIssuedThisDay",
      "bestMove",
      "bestMoveEnabled",
      "cyclesWithoutElimination",
      "eliminationOccurredThisCycle",
      "dayOpeningSeat",
    ],
    context,
  );
  assertGamePhase(game.phase, `${context}.phase`);
  assertSafeInteger(game.day, `${context}.day`, 0);
  if (game.bestMoveEnabled !== undefined) {
    assertBoolean(game.bestMoveEnabled, `${context}.bestMoveEnabled`);
  }
  if (game.cyclesWithoutElimination !== undefined) {
    assertSafeInteger(game.cyclesWithoutElimination, `${context}.cyclesWithoutElimination`, 0);
  }
  if (game.eliminationOccurredThisCycle !== undefined) {
    assertBoolean(game.eliminationOccurredThisCycle, `${context}.eliminationOccurredThisCycle`);
  }
  if (game.dayOpeningSeat !== undefined) {
    assertSeat(game.dayOpeningSeat, `${context}.dayOpeningSeat`);
  }
  if (!Array.isArray(game.players) || game.players.length !== 10) {
    throw new Error(`${context}.players must contain exactly 10 players`);
  }
  const playerIds = new Set<string>();
  const playerSeats = new Set<number>();
  const roleCounts = { sheriff: 0, citizen: 0, mafia: 0, don: 0 };
  for (const [index, value] of game.players.entries()) {
    const player = requireRecord(value, `${context}.players[${index}]`);
    assertExactKeys(
      player,
      ["id", "seat", "role", "team", "status", "fouls", "mutePending"],
      `${context}.players[${index}]`,
    );
    assertNonEmptyString(player.id, `${context}.players[${index}].id`);
    assertSeat(player.seat, `${context}.players[${index}].seat`);
    if (
      player.role !== "sheriff" &&
      player.role !== "citizen" &&
      player.role !== "mafia" &&
      player.role !== "don"
    ) {
      throw new Error(`${context}.players[${index}].role is invalid`);
    }
    assertCasperRole({ id: player.id, seat: player.seat }, player.role);
    const expectedTeam = player.role === "mafia" || player.role === "don" ? "black" : "red";
    if (player.team !== expectedTeam) {
      throw new Error(`${context}.players[${index}].team does not match role`);
    }
    roleCounts[player.role] += 1;
    if (
      player.status !== "active" &&
      player.status !== "eliminated" &&
      player.status !== "red-carded"
    ) {
      throw new Error(`${context}.players[${index}].status is invalid`);
    }
    assertSafeInteger(player.fouls, `${context}.players[${index}].fouls`, 0);
    if (player.fouls > 4) throw new Error(`${context}.players[${index}].fouls exceeds 4`);
    assertBoolean(player.mutePending, `${context}.players[${index}].mutePending`);
    if (playerIds.has(player.id) || playerSeats.has(player.seat)) {
      throw new Error(`${context}.players must have unique IDs and seats`);
    }
    playerIds.add(player.id);
    playerSeats.add(player.seat);
  }
  if (
    roleCounts.sheriff !== 1 ||
    roleCounts.citizen !== 6 ||
    roleCounts.mafia !== 2 ||
    roleCounts.don !== 1
  ) {
    throw new Error(`${context}.players must contain the canonical role distribution`);
  }
  assertSafeInteger(game.completedGameNights, `${context}.completedGameNights`, 0);
  assertSafeInteger(game.sheriffChecksPerformed, `${context}.sheriffChecksPerformed`, 0);
  assertBoolean(game.currentSpeechRestricted, `${context}.currentSpeechRestricted`);
  assertSeatArray(game.firstDayDepartureSeats, `${context}.firstDayDepartureSeats`);
  if (
    game.sheriffChecksPerformed > game.completedGameNights ||
    (game.day === 0 && game.completedGameNights !== 0) ||
    (game.day > 0 &&
      game.completedGameNights !== game.day &&
      !(game.phase === "draw" && game.completedGameNights === game.day + 1))
  )
    throw new Error("Federation night/check counters are inconsistent with lifecycle");
  if (
    game.firstDayDepartureSeats.some(
      (seat) =>
        (game.players as GameState["players"]).find((p) => p.seat === seat)?.status === "active",
    )
  )
    throw new Error("First-day departures must identify inactive players");
  if (game.disciplinaryRemovals !== undefined) {
    if (!Array.isArray(game.disciplinaryRemovals))
      throw new Error("Disciplinary removal ledger must be an array");
    const seen = new Set<number>();
    for (const item of game.disciplinaryRemovals) {
      const removal = requireRecord(item, `${context}.disciplinaryRemovals`);
      assertExactKeys(
        removal,
        [
          "seat",
          "stage",
          "rule",
          "reason",
          "checkInProgress",
          "occurredPhase",
          "day",
          "effectiveExcluded",
          "departure",
          "announcement",
          "shotDeath",
          "checkCompletionPending",
        ],
        `${context}.disciplinaryRemovals`,
      );
      assertRemovalObservation(removal as unknown as RemovalObservation);
      assertGamePhase(removal.occurredPhase, `${context}.disciplinaryRemovals.occurredPhase`);
      assertSafeInteger(removal.day, `${context}.disciplinaryRemovals.day`, 0);
      assertBoolean(removal.shotDeath, `${context}.disciplinaryRemovals.shotDeath`);
      assertBoolean(
        removal.checkCompletionPending,
        `${context}.disciplinaryRemovals.checkCompletionPending`,
      );
      if (
        seen.has(removal.seat as number) ||
        removal.day > game.day ||
        removal.effectiveExcluded !== true ||
        !["pending", "departed"].includes(removal.departure as string) ||
        !["pending", "announced"].includes(removal.announcement as string)
      )
        throw new Error("Disciplinary removal ledger is inconsistent");
      seen.add(removal.seat as number);
      if (
        (game.players as GameState["players"]).find((p) => p.seat === removal.seat)?.status !==
          "red-carded" ||
        (removal.checkCompletionPending &&
          (!removal.checkInProgress || removal.departure !== "pending")) ||
        (removal.announcement === "announced" && removal.departure !== "departed")
      )
        throw new Error("Disciplinary exclusion/departure/announcement disagree");
      if (removal.stage === "after-shooting-result") {
        if (
          removal.occurredPhase !== "night-mafia-result" ||
          removal.departure !== "departed" ||
          removal.checkCompletionPending
        )
          throw new Error(
            "Post-result removal requires a completed shooting boundary and departure",
          );
        if (game.phase === "night-mafia-result" && removal.day === game.day) {
          const result = game.nightResult as GameState["nightResult"];
          if (
            !result ||
            removal.shotDeath !== (result.kind === "kill" && result.targetSeat === removal.seat)
          )
            throw new Error(
              "Post-result removal must retain its accepted shooting result and victim",
            );
        }
      }
    }
  }
  if (game.actualMultipleShotSeats !== undefined) {
    assertSeatArray(game.actualMultipleShotSeats, `${context}.actualMultipleShotSeats`);
    if (
      game.actualMultipleShotSeats.some(
        (seat) =>
          (game.players as GameState["players"]).find((p) => p.seat === seat)?.team !== "black",
      )
    )
      throw new Error("Multiple shooting requires a black-team shooter");
  }
  if (game.shotObservations !== undefined) {
    if (!Array.isArray(game.shotObservations))
      throw new Error("Shot observations must be an array");
    const observedShooters = new Set<number>();
    for (const [index, value] of game.shotObservations.entries()) {
      const shot = requireRecord(value, `${context}.shotObservations[${index}]`);
      assertExactKeys(
        shot,
        ["shooterSeat", "targetSeat", "additional"],
        `${context}.shotObservations[${index}]`,
      );
      assertSeat(shot.shooterSeat, `${context}.shotObservations[${index}].shooterSeat`);
      assertSeat(shot.targetSeat, `${context}.shotObservations[${index}].targetSeat`);
      assertBoolean(shot.additional, `${context}.shotObservations[${index}].additional`);
      if (
        (game.players as GameState["players"]).find((p) => p.seat === shot.shooterSeat)?.team !==
          "black" ||
        !(game.players as GameState["players"]).some((p) => p.seat === shot.targetSeat) ||
        (observedShooters.has(shot.shooterSeat) && shot.additional !== true)
      )
        throw new Error("Physical-shot observation ledger is inconsistent");
      observedShooters.add(shot.shooterSeat);
    }
  }
  if (game.ballotCancellationDay !== undefined)
    assertSafeInteger(game.ballotCancellationDay, `${context}.ballotCancellationDay`, 1);
  if (
    game.ballotSkipReason !== undefined &&
    !legalVotingSkipReasons.includes(game.ballotSkipReason as string)
  )
    throw new Error("Invalid legal ballot skip reason");
  if (game.adjudication !== undefined) {
    assertAdjudication(game.adjudication, `${context}.adjudication`);
    const ruling = game.adjudication as OpponentVictoryAdjudication;
    if (
      game.phase !== "finished" ||
      game.winner !== (ruling.losingTeam === "red" ? "black" : "red")
    )
      throw new Error("Adjudication and terminal winner disagree");
    if (
      ruling.offenderSeat !== undefined &&
      (game.players as GameState["players"]).find((p) => p.seat === ruling.offenderSeat)?.team !==
        ruling.losingTeam
    )
      throw new Error("Adjudication offender and losing team disagree");
  }
  if (game.rulesDrawReason !== undefined) {
    const reason = requireRecord(game.rulesDrawReason, `${context}.rulesDrawReason`);
    assertExactKeys(
      reason,
      ["rule", "completedGameNights", "consecutiveUnchangedNights"],
      `${context}.rulesDrawReason`,
    );
    if (
      game.phase !== "draw" ||
      reason.rule !== "6.5.6" ||
      reason.consecutiveUnchangedNights !== 3 ||
      reason.completedGameNights !== game.completedGameNights ||
      game.cyclesWithoutElimination !== 3
    )
      throw new Error("Rules draw basis and lifecycle disagree");
  }
  if (game.phase === "voting" && !game.ballot)
    throw new Error("Federation voting requires ordered ballot state");
  if (game.ballot !== undefined) {
    const ballot = requireRecord(game.ballot, `${context}.ballot`);
    assertObjectKeys(
      ballot,
      [
        "orderAnnouncements",
        "mention",
        "stopped",
        "selectedCandidateSeat",
        "acceptedCandidateSeats",
        "reviewedCandidateSeats",
      ],
      ["dispute", "finalRuling", "hostRecording"],
      `${context}.ballot`,
    );
    if (
      ![0, 1, 2].includes(ballot.orderAnnouncements as number) ||
      ![0, 1, 2].includes(ballot.mention as number)
    )
      throw new Error("Ballot announcements/mentions are invalid");
    if (ballot.hostRecording !== undefined && ballot.hostRecording !== true)
      throw new Error("Host recording must be explicitly enabled");
    assertBoolean(ballot.stopped, `${context}.ballot.stopped`);
    assertSeat(ballot.selectedCandidateSeat, `${context}.ballot.selectedCandidateSeat`);
    assertSeatArray(ballot.acceptedCandidateSeats, `${context}.ballot.acceptedCandidateSeats`);
    assertSeatArray(ballot.reviewedCandidateSeats, `${context}.ballot.reviewedCandidateSeats`);
    if (
      game.phase === "voting" &&
      (!(game.turnOrder as number[]).includes(ballot.selectedCandidateSeat) ||
        (ballot.mention !== 0 && ballot.orderAnnouncements !== 2) ||
        (ballot.stopped && ballot.mention !== 2) ||
        ballot.acceptedCandidateSeats.some((seat) => !(game.turnOrder as number[]).includes(seat)))
    )
      throw new Error("Ordered ballot state is inconsistent");
    if (game.phase === "voting") {
      const order = game.turnOrder as number[];
      const index = game.currentTurnIndex as number;
      if (
        index >= order.length ||
        !sameValue(ballot.acceptedCandidateSeats, order.slice(0, index + (ballot.stopped ? 1 : 0)))
      )
        throw new Error("Accepted STOP seats must match the ordered live prefix");
      for (const [voter, candidate] of Object.entries(
        game.voteAssignments as Readonly<Record<number, number>>,
      )) {
        if (
          (game.players as GameState["players"]).find((p) => p.seat === Number(voter))?.status !==
            "active" ||
          !order.includes(candidate)
        )
          throw new Error(
            "Accepted ballot assignments require eligible voters and actual candidates",
          );
      }
    }
    if (ballot.dispute !== undefined) {
      const dispute = requireRecord(ballot.dispute, `${context}.ballot.dispute`);
      assertExactKeys(dispute, ["candidateSeat", "reason"], `${context}.ballot.dispute`);
      assertSeat(dispute.candidateSeat, `${context}.ballot.dispute.candidateSeat`);
      assertJudgeReason(dispute.reason as string);
      const candidateIndex = (game.turnOrder as number[]).indexOf(dispute.candidateSeat);
      if (
        game.phase !== "voting" ||
        candidateIndex < 0 ||
        (!ballot.hostRecording &&
          (candidateIndex > (game.currentTurnIndex as number) ||
            (candidateIndex === game.currentTurnIndex && ballot.mention !== 2)))
      )
        throw new Error("A pending dispute must refer to an actually called live count");
      if (ballot.reviewedCandidateSeats.includes(dispute.candidateSeat))
        throw new Error("A final ruling cannot be reappealed");
    }
    if (ballot.finalRuling !== undefined) {
      const ruling = requireRecord(ballot.finalRuling, `${context}.ballot.finalRuling`);
      assertExactKeys(
        ruling,
        ["candidateSeat", "reason", "externalReviewAcknowledged"],
        `${context}.ballot.finalRuling`,
      );
      assertSeat(ruling.candidateSeat, `${context}.ballot.finalRuling.candidateSeat`);
      assertJudgeReason(ruling.reason as string);
      if (
        ruling.externalReviewAcknowledged !== true ||
        !ballot.reviewedCandidateSeats.includes(ruling.candidateSeat)
      )
        throw new Error("Final reviewed count lacks human acknowledgement");
    }
  }
  assertSeatArray(game.turnOrder, `${context}.turnOrder`);
  assertSafeInteger(game.currentTurnIndex, `${context}.currentTurnIndex`, 0);
  if (game.currentTurnIndex > game.turnOrder.length) {
    throw new Error(`${context}.currentTurnIndex exceeds turnOrder`);
  }
  if (!Array.isArray(game.nominations)) throw new Error(`${context}.nominations must be an array`);
  const nominationCandidates = new Set<number>();
  const nominationSpeakers = new Set<number>();
  for (const [index, value] of game.nominations.entries()) {
    const nomination = requireRecord(value, `${context}.nominations[${index}]`);
    assertObjectKeys(
      nomination,
      ["nominatorSeat", "candidateSeat", "order"],
      ["supporterSeats"],
      `${context}.nominations[${index}]`,
    );
    assertSeat(nomination.nominatorSeat, `${context}.nominations[${index}].nominatorSeat`);
    assertSeat(nomination.candidateSeat, `${context}.nominations[${index}].candidateSeat`);
    assertSafeInteger(nomination.order, `${context}.nominations[${index}].order`, 1);
    if (Object.hasOwn(nomination, "supporterSeats")) {
      assertSeatArray(nomination.supporterSeats, `${context}.nominations[${index}].supporterSeats`);
      if (nomination.supporterSeats.includes(nomination.nominatorSeat))
        throw new Error("An original nominator cannot also be an additional supporter");
    }
    if (
      nominationCandidates.has(nomination.candidateSeat) ||
      nominationSpeakers.has(nomination.nominatorSeat) ||
      nomination.order !== index + 1
    ) {
      throw new Error(`${context}.nominations are duplicated or out of order`);
    }
    nominationCandidates.add(nomination.candidateSeat);
    nominationSpeakers.add(nomination.nominatorSeat);
  }
  assertCanonicalSeatRecord(game.voteAssignments, `${context}.voteAssignments`, (entry, name) =>
    assertSeat(entry, name),
  );
  assertCanonicalSeatRecord(game.shotAssignments, `${context}.shotAssignments`, (entry, name) =>
    assertSeat(entry, name),
  );
  if (game.votingCancellation !== undefined) {
    const cancellation = requireRecord(game.votingCancellation, `${context}.votingCancellation`);
    assertExactKeys(cancellation, ["reason"], `${context}.votingCancellation`);
    if (cancellation.reason !== "red-card" && cancellation.reason !== "host-skipped") {
      throw new Error(`${context}.votingCancellation.reason is invalid`);
    }
  }
  if (
    game.votingRound !== undefined &&
    game.votingRound !== "initial" &&
    game.votingRound !== "repeat"
  ) {
    throw new Error(`${context}.votingRound is invalid`);
  }
  if (game.phase === "voting") {
    if (
      game.turnOrder.length === 0 ||
      game.votingRound === undefined ||
      game.currentTurnIndex >= game.turnOrder.length ||
      game.turnOrder.some((seat) => !nominationCandidates.has(seat))
    ) {
      throw new Error(`${context}.voting phase fields are inconsistent`);
    }
    const activeSeats = new Set(
      game.players.filter(({ status }) => status === "active").map(({ seat }) => seat),
    );
    for (const [voter, candidate] of Object.entries(
      game.voteAssignments as Record<string, number>,
    )) {
      if (!activeSeats.has(Number(voter)) || !game.turnOrder.includes(candidate)) {
        throw new Error(`${context}.voteAssignments are ineligible for this voting round`);
      }
    }
  }
  if (game.carCrashSeats !== undefined)
    assertSeatArray(game.carCrashSeats, `${context}.carCrashSeats`);
  if (
    game.phase === "car-crash" &&
    (game.votingRound !== "repeat" ||
      !Array.isArray(game.carCrashSeats) ||
      game.carCrashSeats.length === 0 ||
      !sameValue(game.turnOrder, game.carCrashSeats))
  ) {
    throw new Error(`${context}.car-crash turn order must match the tied nominees`);
  }
  if (game.carCrashVotes !== undefined) {
    assertCanonicalSeatRecord(game.carCrashVotes, `${context}.carCrashVotes`, assertBoolean);
  }
  if (game.carCrashResult !== undefined) {
    assertCarCrashVoteResult(game.carCrashResult, `${context}.carCrashResult`);
  }
  if ((game.phase === "car-crash-result") !== (game.carCrashResult !== undefined)) {
    throw new Error(`${context}.carCrashResult must exist only in the car-crash result phase`);
  }
  if (game.goodbyeSeats !== undefined)
    assertSeatArray(game.goodbyeSeats, `${context}.goodbyeSeats`);
  if (
    game.goodbyeNext !== undefined &&
    game.goodbyeNext !== "day" &&
    game.goodbyeNext !== "night"
  ) {
    throw new Error(`${context}.goodbyeNext is invalid`);
  }
  if (game.nightCheckEligibility !== undefined) {
    const eligibility = requireRecord(
      game.nightCheckEligibility,
      `${context}.nightCheckEligibility`,
    );
    assertExactKeys(eligibility, ["don", "sheriff"], `${context}.nightCheckEligibility`);
    assertBoolean(eligibility.don, `${context}.nightCheckEligibility.don`);
    assertBoolean(eligibility.sheriff, `${context}.nightCheckEligibility.sheriff`);
  }
  if (game.checkResult !== undefined) {
    const result = requireRecord(game.checkResult, `${context}.checkResult`);
    assertExactKeys(result, ["kind", "targetSeat", "match", "secret"], `${context}.checkResult`);
    if (result.kind !== "don-check" && result.kind !== "sheriff-check") {
      throw new Error(`${context}.checkResult.kind is invalid`);
    }
    assertSeat(result.targetSeat, `${context}.checkResult.targetSeat`);
    assertBoolean(result.match, `${context}.checkResult.match`);
    if (result.secret !== true) throw new Error(`${context}.checkResult.secret must be true`);
  }
  if (game.nightResult !== undefined)
    assertNightShotResult(game.nightResult, `${context}.nightResult`);
  if (game.dayNotice !== undefined && game.dayNotice !== "happy") {
    throw new Error(`${context}.dayNotice is invalid`);
  }
  if (game.redCardIssuedThisDay !== undefined) {
    assertBoolean(game.redCardIssuedThisDay, `${context}.redCardIssuedThisDay`);
  }
  if (game.bestMove !== undefined) {
    const bestMove = requireRecord(game.bestMove, `${context}.bestMove`);
    assertObjectKeys(
      bestMove,
      ["playerSeat", "selectedSeats"],
      ["mafiaHits", "completionReason", "readbackAcknowledged"],
      `${context}.bestMove`,
    );
    assertSeat(bestMove.playerSeat, `${context}.bestMove.playerSeat`);
    if (!Array.isArray(bestMove.selectedSeats) || bestMove.selectedSeats.length > 3)
      throw new Error("Best Move contains at most three accepted numbers");
    for (const seat of bestMove.selectedSeats)
      assertSeat(seat, `${context}.bestMove.selectedSeats`);
    const completed = bestMove.completionReason !== undefined;
    const hostCompletion = completed && bestMove.readbackAcknowledged === undefined;
    if (completed) {
      if (!bestMoveCompletionReasons.includes(bestMove.completionReason as string))
        throw new Error("Completed Best Move needs a legal completion reason");
      if (hostCompletion) {
        if (
          !["complete-list", "declined"].includes(bestMove.completionReason as string) ||
          new Set(bestMove.selectedSeats).size !== bestMove.selectedSeats.length ||
          bestMove.selectedSeats.includes(bestMove.playerSeat)
        )
          throw new Error("Recorded Best Move requires distinct other players or an empty skip");
      } else if (bestMove.readbackAcknowledged !== true) {
        throw new Error("Completed Best Move needs accepted readback");
      }
    }
    if (bestMove.completionReason === "declined" && bestMove.selectedSeats.length !== 0)
      throw new Error("A declined Best Move has zero accepted entries");
    if (bestMove.completionReason === "complete-list" && bestMove.selectedSeats.length !== 3)
      throw new Error("Complete Best Move contains three entries");
    if (bestMove.mafiaHits !== undefined) {
      assertSafeInteger(bestMove.mafiaHits, `${context}.bestMove.mafiaHits`, 0);
    }
    const expectedHits = (game.players as GameState["players"]).filter(
      (p) => p.team === "black" && new Set(bestMove.selectedSeats as number[]).has(p.seat),
    ).length;
    if (
      completed && !(hostCompletion && bestMove.completionReason === "declined")
        ? bestMove.mafiaHits !== expectedHits
        : bestMove.mafiaHits !== undefined
    )
      throw new Error("Best Move score must derive from the accepted finalized transcript");
  }
  if (game.winner !== null && game.winner !== "red" && game.winner !== "black") {
    throw new Error(`${context}.winner is invalid`);
  }
  if ((game.phase === "finished") !== (game.winner !== null)) {
    throw new Error(`${context}.phase and winner are inconsistent`);
  }
  if (
    game.day === 0 &&
    game.phase !== "mafia-planning" &&
    !(openingPhases.has(game.phase) || isTerminalGamePhase(game.phase))
  ) {
    throw new Error(`${context}.day zero has an invalid phase`);
  }
};
export const assertGameLogEntry: (value: unknown) => asserts value is GameLogEntry = (value) => {
  const entry = requireRecord(value, "Game event envelope");
  assertExactKeys(entry, gameLogEntryKeys, "Game event envelope");
  assertReplayVersion(entry.replayVersion);
  assertCanonicalGameEventDraft({
    type: entry.type,
    payload: entry.payload,
  });
  assertNonEmptyString(entry.id, "Event id");
  assertNonEmptyString(entry.gameId, "Event gameId");
  assertReplaySequence(entry.sequence);
  if (entry.parentEventId !== null)
    assertNonEmptyString(entry.parentEventId, "Event parentEventId");
  assertGamePhase(entry.phaseBefore, "Event phaseBefore");
  assertGamePhase(entry.phaseAfter, "Event phaseAfter");
  assertSafeInteger(entry.dayBefore, "Event dayBefore", 0);
  assertSafeInteger(entry.dayAfter, "Event dayAfter", 0);
  if (
    typeof entry.stateHashAfter !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(entry.stateHashAfter)
  ) {
    throw new Error("Event stateHashAfter must use sha256:<64 lowercase hex characters>");
  }
  assertCreatedAt(entry.createdAt);
};
const canonicalJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
  );
};
const SHA_256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotateRight = (value: number, bits: number): number =>
  (value >>> bits) | (value << (32 - bits));
const sha256Hex = (text: string): string => {
  const input = new TextEncoder().encode(text);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = input.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 4294967296));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const word15 = words[index - 15]!;
      const word2 = words[index - 2]!;
      const sigma0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3);
      const sigma1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }
    let a = hash[0]!;
    let b = hash[1]!;
    let c = hash[2]!;
    let d = hash[3]!;
    let e = hash[4]!;
    let f = hash[5]!;
    let g = hash[6]!;
    let h = hash[7]!;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 =
        (h + sum1 + choice + SHA_256_ROUND_CONSTANTS[index]! + words[index]!) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    hash[0] = (hash[0]! + a) >>> 0;
    hash[1] = (hash[1]! + b) >>> 0;
    hash[2] = (hash[2]! + c) >>> 0;
    hash[3] = (hash[3]! + d) >>> 0;
    hash[4] = (hash[4]! + e) >>> 0;
    hash[5] = (hash[5]! + f) >>> 0;
    hash[6] = (hash[6]! + g) >>> 0;
    hash[7] = (hash[7]! + h) >>> 0;
  }
  return [...hash].map((word) => word.toString(16).padStart(8, "0")).join("");
};
export const hashGameState = (game: GameState): string => {
  const text = JSON.stringify(canonicalJsonValue(game));
  return `sha256:${sha256Hex(text)}`;
};
const matchesStateHash = (game: GameState, hash: string): boolean => hashGameState(game) === hash;
const matchesRecordedState = (game: GameState, entry: GameLogEntry): boolean =>
  game.phase === entry.phaseAfter &&
  game.day === entry.dayAfter &&
  matchesStateHash(game, entry.stateHashAfter);
const sameValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(canonicalJsonValue(left)) === JSON.stringify(canonicalJsonValue(right));
const advancePhaseOnce = (game: GameState): GameState => {
  if (game.phase === "mafia-planning" || openingPhases.has(game.phase)) {
    return advanceSetupPhase(game);
  }
  if (game.phase === "day" || game.phase === "car-crash") return completeCurrentTurn(game);
  if (game.phase === "voting-cancelled" || game.phase === "car-crash-skipped") {
    return beginNight(game);
  }
  if (game.phase === "car-crash-result") return completeCarCrashResult(game);
  if (game.phase === "night-mafia-result") return completeMafiaShots(game);
  if (game.phase === "night-don-result") return continueDonCheck(game);
  if (game.phase === "night-sheriff-result") return continueSheriffCheck(game);
  if (game.phase === "night-resolution") return completeNight(game);
  if (game.phase === "goodbye-speech") return completeGoodbyeSpeech(game);
  throw new Error(`Cannot replay a phase change from ${game.phase}`);
};
const applyPhaseChange = (game: GameState, to: GamePhase): GameState => {
  if (game.phase === to) throw new Error(`Phase change must advance from ${game.phase}`);
  if (
    ["mafia-planning", "mafia-sleep", "don-identification", "sheriff-identification"].includes(
      game.phase,
    )
  ) {
    const opening = advanceOpeningPhase(game);
    if (opening.phase === to) return opening;
  }
  let next = game;
  for (let step = 0; step < 20 && next.phase !== to; step += 1) {
    const phaseBeforeStep = next.phase;
    next = advancePhaseOnce(next);
    if (
      next.phase !== to &&
      next.phase !== phaseBeforeStep &&
      !intermediatePhaseTargets.has(next.phase)
    ) {
      throw new Error(`Phase change to ${to} cannot skip meaningful phase ${next.phase}`);
    }
  }
  if (next.phase !== to)
    throw new Error(`Phase change expected ${to} but domain produced ${next.phase}`);
  return next;
};
const advanceToDaySpeaker = (game: GameState, seat: number): GameState => {
  let next = game;
  for (let step = 0; step < next.turnOrder.length && next.phase === "day"; step += 1) {
    if (next.turnOrder[next.currentTurnIndex] === seat) return next;
    next = completeCurrentTurn(next);
  }
  throw new Error(`Only an upcoming day speaker may create a semantic checkpoint for seat ${seat}`);
};
const advanceToVoting = (game: GameState): GameState => {
  let next = game;
  for (let step = 0; step < 20 && (next.phase === "day" || next.phase === "car-crash"); step += 1) {
    next = completeCurrentTurn(next);
  }
  return next;
};
const advanceToMafiaShots = (game: GameState): GameState => advanceToVoting(game);
const advanceToDonCheck = (game: GameState): GameState =>
  game.phase === "night-mafia-result" ? completeMafiaShots(game) : game;
const advanceToSheriffCheck = (game: GameState): GameState => {
  const afterMafia = game.phase === "night-mafia-result" ? completeMafiaShots(game) : game;
  return afterMafia.phase === "night-don-result" ? continueDonCheck(afterMafia) : afterMafia;
};
const applyDisciplineContext = (
  game: GameState,
  context: {
    readonly phase?: GamePhase;
    readonly currentTurnIndex?: number;
  },
): GameState => {
  if (context.phase === undefined || context.currentTurnIndex === undefined) return game;
  if (context.phase !== game.phase || context.currentTurnIndex !== game.currentTurnIndex)
    throw new Error("Discipline context cannot advance the ordered live state");
  return game;
};
const applyValidatedGameEvent = (game: GameState, event: CanonicalGameEventDraft): GameState => {
  assertCanonicalGameEventDraft(event);
  if (
    isTerminalGamePhase(game.phase) &&
    event.type !== "game.checkpointed" &&
    !(game.phase === "finished" && event.type === "game.completed") &&
    !(game.phase === "finished" && event.type === "discipline.removals-announced")
  ) {
    throw new Error("A terminal game is outside active play and cannot accept more actions");
  }
  switch (event.type) {
    case "discipline.foul-issued": {
      const next = issueFoul(game, event.payload.seat, event.payload.removal);
      if (next.players.find((p) => p.seat === event.payload.seat)?.fouls !== 4)
        throw new Error("Fourth-foul event does not match the subject counter");
      return next;
    }
    case "discipline.removal-observed":
      return observeDisciplinaryRemoval(game, event.payload);
    case "discipline.removals-announced":
      return announceDisciplinaryRemovals(game, event.payload.seats);
    case "voting.order-announced":
      return announceVotingOrder(game);
    case "voting.candidate-selected":
      return selectHostVotingCandidate(game, event.payload.candidateSeat);
    case "vote.recorded":
      return recordHostVote(game, event.payload.voterSeat, event.payload.candidateSeat);
    case "voting.candidate-inspected":
      return inspectFederationCandidate(game, event.payload.candidateSeat);
    case "voting.candidate-mentioned":
      if (game.turnOrder[game.currentTurnIndex] !== event.payload.candidateSeat)
        throw new Error("The mentioned candidate must match the live cursor");
      return mentionVotingCandidate(game);
    case "voting.candidate-stopped":
      if (game.turnOrder[game.currentTurnIndex] !== event.payload.candidateSeat)
        throw new Error("STOP must match the live candidate");
      return stopVotingCandidate(game);
    case "voting.live-advanced": {
      const next = advanceFederationCandidate(game);
      if (next.turnOrder[next.currentTurnIndex] !== event.payload.candidateSeat)
        throw new Error("Live advancement must follow nomination order");
      return next;
    }
    case "vote.accepted":
      return acceptFederationVote(game, event.payload.voterSeat, event.payload.candidateSeat);
    case "vote.corrected":
      return correctAcceptedVote(
        game,
        event.payload.voterSeat,
        event.payload.candidateSeat,
        event.payload.reason,
      );
    case "voting.count-disputed":
      return disputeVotingCount(game, event.payload.candidateSeat, event.payload.reason);
    case "voting.count-ruled":
      return ruleOnVotingDispute(
        game,
        event.payload.voteAssignments,
        event.payload.externalReviewAcknowledged,
        event.payload.reason,
      );
    case "voting.legally-skipped":
      return skipFederationVoting(game, event.payload.reason);
    case "mafia.multiple-shot-observed":
      return recordActualMultipleShot(game, event.payload.shooterSeat);
    case "mafia.shots-observed": {
      // Unlike ordinary corrections, these physical facts are accepted immediately.
      // Carry the displayed assignments into canonical state so a draft/acceptance
      // race cannot turn an extra physical shot into a first shot or discard its basis.
      let observed: GameState = { ...game, shotAssignments: {} };
      for (const [shooter, target] of Object.entries(event.payload.shotAssignments))
        observed = recordMafiaShot(observed, Number(shooter), target!);
      return recordShotObservations(observed, event.payload.observations);
    }
    case "best-move.number-accepted":
      return acceptBestMoveSeat(game, event.payload.seat);
    case "best-move.slip-corrected":
      return correctBestMoveSlip(
        game,
        event.payload.index,
        event.payload.seat,
        event.payload.reason,
      );
    case "best-move.finalized":
      return finalizeBestMove(game, event.payload.reason, event.payload.readbackAcknowledged);
    case "best-move.selection-toggled":
      return toggleBestMoveSelection(game, event.payload.seat);
    case "best-move.recorded":
      return recordBestMove(game);
    case "best-move.skipped":
      return skipBestMove(game);
    case "game.adjudicated":
      return adjudicateOpponentVictory(game, event.payload);
    case "game.started":
      if (game.phase !== "mafia-planning") {
        throw new Error("game.started requires a mafia-planning state");
      }
      return game;
    case "game.checkpointed":
      return game;
    case "game.completed":
      if (game.phase !== "finished") {
        throw new Error("A game completion marker requires a finished game");
      }
      if (game.winner !== event.payload.winner) {
        throw new Error("The completion winner does not match the finished game");
      }
      return game;
    case "game.drawn":
      return confirmDraw(game, event.payload.reason);
    case "game.cancelled":
      return cancelGame(game, event.payload.reason);
    case "phase.changed":
      return applyPhaseChange(game, event.payload.to);
    case "turn.completed": {
      const currentSeat = game.turnOrder[game.currentTurnIndex];
      if (currentSeat !== event.payload.seat) {
        throw new Error(`Turn event expected seat ${currentSeat ?? "none"}`);
      }
      return completeCurrentTurn(game);
    }
    case "player.nominated":
      return nominate(
        advanceToDaySpeaker(game, event.payload.nominatorSeat),
        event.payload.nominatorSeat,
        event.payload.candidateSeat,
      );
    case "nomination.selection-set": {
      const prepared = advanceToDaySpeaker(game, event.payload.nominatorSeat);
      const next = setNominationSelection(
        prepared,
        event.payload.nominatorSeat,
        event.payload.candidateSeat,
        event.payload.selected,
      );
      if (next === prepared)
        throw new GameRuleError(
          "duplicate-action",
          "Nomination selection must change the actor's relation",
          {
            eventType: event.type,
            phase: game.phase,
            day: game.day,
          },
        );
      return next;
    }
    case "foul.issued": {
      const next = issueFoul(applyDisciplineContext(game, event.payload), event.payload.seat);
      const player = next.players.find(({ seat }) => seat === event.payload.seat);
      if (
        player?.fouls !== event.payload.foulNumber ||
        (player.status === "red-carded") !== event.payload.redCarded
      ) {
        throw new Error("Foul event consequences do not match the domain state");
      }
      return next;
    }
    case "voting.resolved": {
      const prepared = game;
      if (!sameValue(game.voteAssignments, event.payload.voteAssignments))
        throw new Error("A result summary cannot rewrite accepted votes");
      const voting: GameState = prepared;
      const result = resolveVote(voting);
      if (!sameValue(result, event.payload.result)) {
        throw new Error("Voting result payload does not match the accepted votes");
      }
      if (result.kind === "car-crash") return beginCarCrash(voting, result.seats);
      if (result.kind === "eliminate-both-vote") {
        return beginCarCrashDecision(voting, result.seats);
      }
      if (result.kind === "eliminate-all-skipped") {
        return beginSkippedCarCrashDecision(voting, result.seats);
      }
      return completeEliminations(voting, result.seats);
    }
    case "car-crash.resolved": {
      const decision: GameState = { ...game, carCrashVotes: { ...event.payload.votes } };
      const result = resolveCarCrashVote(decision);
      if (!sameValue(result, event.payload.result)) {
        throw new Error("Car-crash result payload does not match the accepted votes");
      }
      return completeEliminations(decision, result.eliminate ? result.seats : []);
    }
    case "car-crash.ballot-resolved": {
      const decision: GameState = { ...game, carCrashVotes: { ...event.payload.votes } };
      const result = resolveCarCrashVote(decision);
      if (!sameValue(result, event.payload.result)) {
        throw new Error("Car-crash result payload does not match the accepted votes");
      }
      return acceptCarCrashBallot(decision);
    }
    case "car-crash.count-completed": {
      const decision: GameState = { ...game, carCrashVotes: { ...event.payload.votes } };
      const result = resolveCompletedCarCrashCount(decision);
      if (!sameValue(result, event.payload.result))
        throw new Error("Completed hand-count result does not match the observed support");
      return acceptCompletedCarCrashCount(decision);
    }
    case "mafia.shots-resolved": {
      let shotGame: GameState = { ...advanceToMafiaShots(game), shotAssignments: {} };
      for (const shot of event.payload.shots) {
        shotGame = recordMafiaShot(shotGame, shot.shooterSeat, shot.targetSeat);
      }
      const resolution = resolveMafiaShots(shotGame);
      if (!sameValue(resolution.result, event.payload.result)) {
        throw new Error("Mafia result payload does not match the accepted shots");
      }
      return resolution.game;
    }
    case "don.checked": {
      const result = performDonCheck(advanceToDonCheck(game), event.payload.targetSeat);
      if (result.result.match !== event.payload.match) {
        throw new Error("Don check payload does not match the immutable roles");
      }
      return result.game;
    }
    case "don.check-skipped":
      return skipDonCheck(advanceToDonCheck(game));
    case "sheriff.checked": {
      const result = performSheriffCheck(advanceToSheriffCheck(game), event.payload.targetSeat);
      if (result.result.match !== event.payload.match) {
        throw new Error("Sheriff check payload does not match the immutable roles");
      }
      return result.game;
    }
    case "sheriff.check-skipped":
      return skipSheriffCheck(advanceToSheriffCheck(game));
  }
};
export type GameActionResult =
  | {
      readonly ok: true;
      readonly game: GameState;
    }
  | {
      readonly ok: false;
      readonly error: GameRuleError;
    };
export const tryApplyGameEvent = (
  game: GameState,
  event: CanonicalGameEventDraft,
): GameActionResult => {
  try {
    assertGameState(game, "Federation action before state");
    const next = applyValidatedGameEvent(game, event);
    assertGameState(next, "Federation action after state");
    return { ok: true, game: next };
  } catch (error) {
    return {
      ok: false,
      error: toGameRuleError(error, {
        eventType: typeof event?.type === "string" ? event.type : "unknown",
        phase: game.phase,
        day: game.day,
      }),
    };
  }
};
export const applyGameEvent = (game: GameState, event: CanonicalGameEventDraft): GameState => {
  const result = tryApplyGameEvent(game, event);
  if (!result.ok) throw result.error;
  return result.game;
};
interface CreateGameLogEntryInput {
  readonly gameId: string;
  readonly id: string;
  readonly sequence: number;
  readonly parentEventId: string | null;
  readonly createdAt: string;
  readonly before: GameState;
  readonly draft: CanonicalGameEventDraft;
}
export const createInitialGameBaseline = (game: GameState): InitialGameBaseline => {
  assertGameState(game, "Initial game baseline.game");
  return { replayVersion: CURRENT_REPLAY_VERSION, game };
};
export const createGameLogEntry = (
  input: CreateGameLogEntryInput,
): {
  readonly entry: GameLogEntry;
  readonly after: GameState;
} => {
  assertNonEmptyString(input.gameId, "Event gameId");
  assertNonEmptyString(input.id, "Event id");
  assertReplaySequence(input.sequence);
  if (input.parentEventId !== null) {
    assertNonEmptyString(input.parentEventId, "Event parentEventId");
    if (input.parentEventId === input.id) {
      throw new Error("Event parentEventId must differ from its own ID");
    }
  }
  assertCreatedAt(input.createdAt);
  assertGameState(input.before, "Event before state");
  assertCanonicalGameEventDraft(input.draft);
  const after = applyGameEvent(input.before, input.draft);
  const entry = {
    ...input.draft,
    replayVersion: CURRENT_REPLAY_VERSION,
    id: input.id,
    gameId: input.gameId,
    sequence: input.sequence,
    parentEventId: input.parentEventId,
    phaseBefore: input.before.phase,
    phaseAfter: after.phase,
    dayBefore: input.before.day,
    dayAfter: after.day,
    stateHashAfter: hashGameState(after),
    createdAt: input.createdAt,
  } as GameLogEntry;
  assertGameLogEntry(entry);
  return {
    after,
    entry,
  };
};
export const applyCurrentGameLogEntry = (game: GameState, entry: GameLogEntry): GameState => {
  assertGameLogEntry(entry);
  if (entry.phaseBefore !== game.phase || entry.dayBefore !== game.day) {
    throw new Error(`Event ${entry.id} does not start from the current game state`);
  }
  const after = applyGameEvent(game, {
    type: entry.type,
    payload: entry.payload,
  } as CanonicalGameEventDraft);
  if (!matchesRecordedState(after, entry)) {
    throw new Error(`Event ${entry.id} does not match current rule semantics`);
  }
  return after;
};
export const replayGameLog = (
  baseline: InitialGameBaseline,
  entries: readonly GameLogEntry[],
  expectedGameId?: string,
): {
  readonly game: GameState;
  readonly frames: readonly ReplayFrame[];
} => {
  withHistoryDiagnostic({ code: "history.invalid_baseline" }, () => {
    const baselineRecord = requireRecord(baseline, "Initial game baseline");
    assertExactKeys(baselineRecord, ["replayVersion", "game"], "Initial game baseline");
    assertReplayVersion(baselineRecord.replayVersion);
    assertGameState(baselineRecord.game, "Initial game baseline.game");
  });
  let game = baseline.game;
  let parentEventId: string | null = null;
  let previousSequence = 0;
  let replayGameId: string | null = null;
  const seenIds = new Set<string>();
  const frames: ReplayFrame[] = [];
  if (entries.length > 0) {
    const rootMarkerIndexes = entries.flatMap(({ type }, index) =>
      type === "game.started" || type === "game.checkpointed" ? [index] : [],
    );
    if (
      rootMarkerIndexes.length > 1 ||
      (rootMarkerIndexes.length === 1 && rootMarkerIndexes[0] !== 0)
    ) {
      throw new GameHistoryError(
        "A canonical lifecycle marker may appear only at the replay root",
        {
          code: "history.lifecycle",
          replayIndex: rootMarkerIndexes.find((index) => index !== 0),
        },
      );
    }
    if (entries[0]!.type === "game.started" && baseline.game.phase !== "mafia-planning") {
      throw new GameHistoryError("game.started requires a mafia-planning baseline", {
        code: "history.lifecycle",
        replayIndex: 0,
      });
    }
    const terminalIndexes = entries.flatMap(({ type }, index) =>
      type === "game.completed" || type === "game.drawn" || type === "game.cancelled"
        ? [index]
        : [],
    );
    if (
      terminalIndexes.length > 1 ||
      (terminalIndexes.length === 1 && terminalIndexes[0] !== entries.length - 1)
    ) {
      throw new GameHistoryError("A terminal game event may appear only once at the active head", {
        code: "history.terminal_position",
        replayIndex: terminalIndexes[0],
      });
    }
  }
  for (const [replayIndex, entry] of entries.entries()) {
    withHistoryDiagnostic({ code: "history.invalid_event", replayIndex }, () =>
      assertGameLogEntry(entry),
    );
    if (seenIds.has(entry.id))
      throw new GameHistoryError(`Duplicate event ID ${entry.id}`, {
        code: "history.duplicate_event",
        replayIndex,
      });
    seenIds.add(entry.id);
    if (replayGameId === null) replayGameId = entry.gameId;
    else if (entry.gameId !== replayGameId) {
      throw new GameHistoryError(`Cross-game event link at ${entry.id}`, {
        code: "history.cross_game",
        replayIndex,
      });
    }
    if (expectedGameId !== undefined && entry.gameId !== expectedGameId) {
      throw new GameHistoryError(`Event ${entry.id} does not belong to game ${expectedGameId}`, {
        code: "history.cross_game",
        replayIndex,
      });
    }
    if (entry.parentEventId !== parentEventId) {
      throw new GameHistoryError(`Broken parent link at event ${entry.id}`, {
        code: "history.parent_link",
        replayIndex,
      });
    }
    if (entry.sequence <= previousSequence) {
      throw new GameHistoryError(`Event sequence is not increasing at ${entry.id}`, {
        code: "history.sequence",
        replayIndex,
      });
    }
    if (entry.phaseBefore !== game.phase || entry.dayBefore !== game.day) {
      throw new GameHistoryError(`Event ${entry.id} does not start from the replayed state`, {
        code: "history.before_state",
        replayIndex,
      });
    }
    const before = game;
    const after = withHistoryDiagnostic({ code: "history.action_failed", replayIndex }, () =>
      applyGameEvent(before, {
        type: entry.type,
        payload: entry.payload,
      } as CanonicalGameEventDraft),
    );
    if (entry.phaseAfter !== after.phase || entry.dayAfter !== after.day) {
      throw new GameHistoryError(`Event ${entry.id} phase/day metadata does not match replay`, {
        code: "history.after_state",
        replayIndex,
      });
    }
    if (!matchesStateHash(after, entry.stateHashAfter)) {
      throw new GameHistoryError(`State hash mismatch at event ${entry.id}`, {
        code: "history.hash_mismatch",
        replayIndex,
      });
    }
    frames.push({ entry, before, after });
    game = after;
    parentEventId = entry.id;
    previousSequence = entry.sequence;
  }
  if (
    entries.length > 0 &&
    entries[0]!.type !== "game.started" &&
    entries[0]!.type !== "game.checkpointed"
  ) {
    throw new GameHistoryError("A current replay chain requires a lifecycle root marker", {
      code: "history.lifecycle",
      replayIndex: 0,
    });
  }
  return { game, frames };
};
