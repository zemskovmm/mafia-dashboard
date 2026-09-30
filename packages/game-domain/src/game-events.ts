import { assertCasperRole } from "./casper.js";
import {
  acceptCarCrashBallot,
  beginCarCrash,
  beginCarCrashDecision,
  beginSkippedCarCrashDecision,
  completeCarCrashResult,
  completeEliminations,
  issueFoul,
  nominate,
  redCard,
  resolveCarCrashVote,
  resolveVote,
  skipVoting,
} from "./day-actions.js";
import { advanceSetupPhase, cancelGame, confirmDraw, isTerminalGamePhase } from "./game.js";
import { GameHistoryError, withHistoryDiagnostic } from "./history-diagnostics.js";
import {
  beginNight,
  completeBestMove,
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
  toggleBestMoveSeat,
} from "./night-actions.js";
import { completeCurrentTurn } from "./day-actions.js";
import { toGameRuleError, type GameRuleError } from "./rule-error.js";
import type {
  CarCrashVoteResult,
  GamePhase,
  GameState,
  NightShotResult,
  ShotAssignment,
  VoteResult,
} from "./types.js";

export const CURRENT_REPLAY_VERSION = 1 as const;

export const canonicalGameEventTypes = [
  "game.started",
  "game.checkpointed",
  "phase.changed",
  "turn.completed",
  "player.nominated",
  "foul.issued",
  "player.red-carded",
  "voting.skipped",
  "voting.resolved",
  "car-crash.resolved",
  "car-crash.ballot-resolved",
  "mafia.shots-resolved",
  "don.checked",
  "don.check-skipped",
  "sheriff.checked",
  "sheriff.check-skipped",
  "best-move.completed",
  "game.completed",
  "game.drawn",
  "game.cancelled",
] as const;

export type CanonicalGameEventType = (typeof canonicalGameEventTypes)[number];

interface EventDraft<Type extends CanonicalGameEventType, Payload> {
  readonly type: Type;
  readonly payload: Payload;
}

type WithOptionalDisciplineContext<Payload> =
  | (Payload & { readonly phase: GamePhase; readonly currentTurnIndex: number })
  | (Payload & { readonly phase?: never; readonly currentTurnIndex?: never });

export type CanonicalGameEventDraft =
  | EventDraft<"game.started", Record<string, never>>
  | EventDraft<"game.checkpointed", Record<string, never>>
  | EventDraft<"phase.changed", { readonly to: GamePhase }>
  | EventDraft<"turn.completed", { readonly seat: number }>
  | EventDraft<
      "player.nominated",
      { readonly nominatorSeat: number; readonly candidateSeat: number }
    >
  | EventDraft<
      "foul.issued",
      WithOptionalDisciplineContext<{
        readonly seat: number;
        readonly foulNumber: number;
        readonly redCarded: boolean;
      }>
    >
  | EventDraft<"player.red-carded", WithOptionalDisciplineContext<{ readonly seat: number }>>
  | EventDraft<"voting.skipped", { readonly reason: "host-skipped" }>
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
      { readonly shots: readonly ShotAssignment[]; readonly result: NightShotResult }
    >
  | EventDraft<"don.checked", { readonly targetSeat: number; readonly match: boolean }>
  | EventDraft<"don.check-skipped", Record<string, never>>
  | EventDraft<"sheriff.checked", { readonly targetSeat: number; readonly match: boolean }>
  | EventDraft<"sheriff.check-skipped", Record<string, never>>
  | EventDraft<
      "best-move.completed",
      {
        readonly playerSeat: number;
        readonly selectedSeats: readonly number[];
        readonly mafiaHits: number;
      }
    >
  | EventDraft<"game.completed", { readonly winner: "red" | "black" }>
  | EventDraft<"game.drawn", { readonly reason: string }>
  | EventDraft<"game.cancelled", { readonly reason: string }>;

export interface InitialGameBaseline {
  readonly replayVersion: typeof CURRENT_REPLAY_VERSION;
  readonly game: GameState;
}

export type GameLogEntry = CanonicalGameEventDraft & {
  readonly replayVersion: typeof CURRENT_REPLAY_VERSION;
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
  "sheriff-wake",
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
  "player.red-carded": false,
  "voting.skipped": false,
  "voting.resolved": false,
  "car-crash.resolved": false,
  "car-crash.ballot-resolved": false,
  "mafia.shots-resolved": true,
  "don.checked": true,
  "don.check-skipped": true,
  "sheriff.checked": true,
  "sheriff.check-skipped": true,
  "best-move.completed": true,
  "game.completed": false,
  "game.drawn": false,
  "game.cancelled": false,
} as const satisfies Readonly<Record<CanonicalGameEventType, boolean>>;

export const canonicalSecretGameEventTypes = canonicalGameEventTypes.filter(
  (type) => canonicalGameEventSecrecy[type],
);

type UnknownRecord = Record<string, unknown>;

export const isSecretGameEventType = (value: string): boolean =>
  !isCanonicalGameEventType(value) || canonicalGameEventSecrecy[value];

const canonicalGamePhaseSet = new Set<string>([
  "mafia-planning",
  "sheriff-wake",
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
  assertExactKeys(result, ["kind", "seats", "totals"], context);
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

const assertCanonicalPayload = (type: CanonicalGameEventType, value: unknown): void => {
  const payload = requireRecord(value, `${type} payload`);
  switch (type) {
    case "game.started":
    case "game.checkpointed":
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
    case "player.red-carded":
      assertObjectKeys(payload, ["seat"], ["phase", "currentTurnIndex"], `${type} payload`);
      assertSeat(payload.seat, `${type} payload.seat`);
      assertOptionalDisciplineContext(payload, `${type} payload`);
      return;
    case "player.nominated":
      assertExactKeys(payload, ["nominatorSeat", "candidateSeat"], `${type} payload`);
      assertSeat(payload.nominatorSeat, `${type} payload.nominatorSeat`);
      assertSeat(payload.candidateSeat, `${type} payload.candidateSeat`);
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
    case "voting.skipped":
      assertExactKeys(payload, ["reason"], `${type} payload`);
      if (payload.reason !== "host-skipped") {
        throw new Error(`${type} payload.reason must be host-skipped`);
      }
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
    case "best-move.completed":
      assertExactKeys(payload, ["playerSeat", "selectedSeats", "mafiaHits"], `${type} payload`);
      assertSeat(payload.playerSeat, `${type} payload.playerSeat`);
      assertSeatArray(payload.selectedSeats, `${type} payload.selectedSeats`);
      assertSafeInteger(payload.mafiaHits, `${type} payload.mafiaHits`, 0);
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
      "skipCasperBestMove",
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
  if (Object.hasOwn(game, "skipCasperBestMove")) {
    assertBoolean(game.skipCasperBestMove, `${context}.skipCasperBestMove`);
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
    assertExactKeys(
      nomination,
      ["nominatorSeat", "candidateSeat", "order"],
      `${context}.nominations[${index}]`,
    );
    assertSeat(nomination.nominatorSeat, `${context}.nominations[${index}].nominatorSeat`);
    assertSeat(nomination.candidateSeat, `${context}.nominations[${index}].candidateSeat`);
    assertSafeInteger(nomination.order, `${context}.nominations[${index}].order`, 1);
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
      ["mafiaHits"],
      `${context}.bestMove`,
    );
    assertSeat(bestMove.playerSeat, `${context}.bestMove.playerSeat`);
    assertSeatArray(bestMove.selectedSeats, `${context}.bestMove.selectedSeats`);
    if (bestMove.mafiaHits !== undefined) {
      assertSafeInteger(bestMove.mafiaHits, `${context}.bestMove.mafiaHits`, 0);
    }
  }
  if (game.winner !== null && game.winner !== "red" && game.winner !== "black") {
    throw new Error(`${context}.winner is invalid`);
  }
  if ((game.phase === "finished") !== (game.winner !== null)) {
    throw new Error(`${context}.phase and winner are inconsistent`);
  }
  if (game.day === 0 && game.phase !== "mafia-planning" && game.phase !== "sheriff-wake") {
    throw new Error(`${context}.day zero has an invalid phase`);
  }
};

export const assertGameLogEntry: (value: unknown) => asserts value is GameLogEntry = (value) => {
  const entry = requireRecord(value, "Game event envelope");
  assertExactKeys(entry, gameLogEntryKeys, "Game event envelope");
  assertCanonicalGameEventDraft({
    type: entry.type,
    payload: entry.payload,
  });
  if (entry.replayVersion !== CURRENT_REPLAY_VERSION) {
    throw new Error(`Unsupported replay version ${String(entry.replayVersion)}`);
  }
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
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
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
  if (game.phase === "mafia-planning" || game.phase === "sheriff-wake") {
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
  context: { readonly phase?: GamePhase; readonly currentTurnIndex?: number },
): GameState => {
  if (context.phase === undefined || context.currentTurnIndex === undefined) return game;
  if (
    game.day < 1 ||
    context.phase === "mafia-planning" ||
    context.phase === "sheriff-wake" ||
    isTerminalGamePhase(context.phase)
  ) {
    throw new Error("Discipline context must describe active play from day one");
  }
  let next = game;
  if (next.phase === "car-crash") {
    const validTurnOrder =
      next.carCrashSeats !== undefined &&
      next.carCrashSeats.length === next.turnOrder.length &&
      next.nominations.length === next.turnOrder.length &&
      next.turnOrder.every(
        (seat, index) =>
          next.carCrashSeats?.[index] === seat && next.nominations[index]?.candidateSeat === seat,
      );
    if (!validTurnOrder) {
      throw new Error("Discipline context car-crash turn order is invalid");
    }
  }
  for (let step = 0; step <= game.turnOrder.length; step += 1) {
    if (next.phase === context.phase) {
      if (
        (next.phase !== "day" && next.phase !== "car-crash") ||
        next.currentTurnIndex >= context.currentTurnIndex
      ) {
        break;
      }
    }
    if (next.phase !== "day" && next.phase !== "car-crash") break;
    next = completeCurrentTurn(next);
  }
  if (next.phase !== context.phase) {
    const advanced =
      next.phase === "night-mafia-result"
        ? completeMafiaShots(next)
        : next.phase === "night-don-result"
          ? continueDonCheck(next)
          : next.phase === "night-resolution"
            ? completeNight(next)
            : null;
    if (
      advanced !== null &&
      advanced.phase === context.phase &&
      intermediatePhaseTargets.has(advanced.phase)
    ) {
      next = advanced;
    }
  }
  if (next.phase === "voting" && context.phase === "voting") {
    if (game.phase !== "voting") {
      next = { ...next, voteAssignments: {} };
    }
    const validCandidateOrder =
      next.turnOrder.length === next.nominations.length &&
      next.turnOrder.every((seat, index) => next.nominations[index]?.candidateSeat === seat);
    if (
      !validCandidateOrder ||
      context.currentTurnIndex < 0 ||
      context.currentTurnIndex >= next.turnOrder.length
    ) {
      throw new Error("Discipline context voting candidate index is invalid");
    }
    next = { ...next, currentTurnIndex: context.currentTurnIndex };
  }
  if (next.phase !== context.phase || next.currentTurnIndex !== context.currentTurnIndex) {
    throw new Error("Discipline context phase/current turn is not reachable from canonical state");
  }
  return next;
};

const applyValidatedGameEvent = (game: GameState, event: CanonicalGameEventDraft): GameState => {
  assertCanonicalGameEventDraft(event);
  if (
    isTerminalGamePhase(game.phase) &&
    event.type !== "game.checkpointed" &&
    !(game.phase === "finished" && event.type === "game.completed")
  ) {
    throw new Error("A terminal game is outside active play and cannot accept more actions");
  }
  switch (event.type) {
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
    case "player.red-carded":
      return redCard(applyDisciplineContext(game, event.payload), event.payload.seat);
    case "voting.skipped": {
      if (game.phase === "voting-cancelled") {
        throw new Error("Voting skip requires an unresolved day phase");
      }
      return skipVoting(
        game.phase === "day" && game.nominations.length === 0 ? game : advanceToVoting(game),
      );
    }
    case "voting.resolved": {
      const prepared = advanceToVoting(game);
      const voting: GameState = {
        ...prepared,
        voteAssignments: { ...event.payload.voteAssignments },
        currentTurnIndex: prepared.turnOrder.length - 1,
      };
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
    case "best-move.completed": {
      const prepared = game.phase === "night-resolution" ? completeNight(game) : game;
      if (prepared.bestMove?.playerSeat !== event.payload.playerSeat) {
        throw new Error("Best move owner does not match the active state");
      }
      let selected: GameState = {
        ...prepared,
        bestMove: { ...prepared.bestMove, selectedSeats: [] },
      };
      for (const seat of event.payload.selectedSeats) selected = toggleBestMoveSeat(selected, seat);
      const next = completeBestMove(selected);
      if (next.bestMove?.mafiaHits !== event.payload.mafiaHits) {
        throw new Error("Best move hit count does not match the immutable roles");
      }
      return next;
    }
  }
};

export type GameActionResult =
  | { readonly ok: true; readonly game: GameState }
  | { readonly ok: false; readonly error: GameRuleError };

export const tryApplyGameEvent = (
  game: GameState,
  event: CanonicalGameEventDraft,
): GameActionResult => {
  try {
    return { ok: true, game: applyValidatedGameEvent(game, event) };
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

export const createGameLogEntry = (
  input: CreateGameLogEntryInput,
): { readonly entry: GameLogEntry; readonly after: GameState } => {
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
): { readonly game: GameState; readonly frames: readonly ReplayFrame[] } => {
  withHistoryDiagnostic({ code: "history.invalid_baseline" }, () => {
    const baselineRecord = requireRecord(baseline, "Initial game baseline");
    assertExactKeys(baselineRecord, ["replayVersion", "game"], "Initial game baseline");
    if (baseline.replayVersion !== CURRENT_REPLAY_VERSION) {
      throw new Error(`Unsupported replay version ${baseline.replayVersion}`);
    }
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
    if (entry.replayVersion !== baseline.replayVersion) {
      throw new GameHistoryError(`Replay version mismatch at event ${entry.id}`, {
        code: "history.version",
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
