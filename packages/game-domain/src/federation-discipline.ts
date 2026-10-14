import { assertFederationAction, assertJudgeReason } from "./federation-actions.js";
import { isFederationGame } from "./rules-edition.js";
import { evaluateVictory, markPlayerInactive } from "./game.js";
import type {
  DisciplinaryRemoval,
  GamePhase,
  GameState,
  RemovalObservation,
  RemovalOccurrenceStage,
} from "./types.js";

export const removalOccurrenceStages: readonly RemovalOccurrenceStage[] = [
  "agreement",
  "before-shooting-count",
  "shooting-count",
  "don-check",
  "sheriff-check",
  "day-discussion",
  "open-voting",
  "after-voting-result",
  "farewell",
];
const stagePhases: Readonly<Record<RemovalOccurrenceStage, readonly GamePhase[]>> = {
  agreement: [
    "mafia-planning",
    "mafia-sleep",
    "don-identification",
    "sheriff-identification",
    "free-seating",
  ],
  "before-shooting-count": ["night-mafia"],
  "shooting-count": ["night-mafia"],
  "don-check": ["night-don", "night-don-result"],
  "sheriff-check": ["night-sheriff", "night-sheriff-result"],
  "day-discussion": ["day"],
  "open-voting": ["voting", "car-crash", "car-crash-decision", "voting-cancelled"],
  "after-voting-result": ["car-crash-result", "car-crash-skipped", "goodbye-speech", "night-mafia"],
  farewell: ["goodbye-speech", "best-move", "night-resolution"],
};
export const assertRemovalObservation = (observation: RemovalObservation): void => {
  if (!Number.isInteger(observation.seat) || observation.seat < 1 || observation.seat > 10)
    throw new Error("Removal seat must be 1–10");
  if (!removalOccurrenceStages.includes(observation.stage))
    throw new Error("A recorded occurrence stage is required");
  if (typeof observation.rule !== "string" || !/^6\.2\.(?:[1-9]|1[0-3])$/.test(observation.rule))
    throw new Error("Removal requires a rule 6.2.1–6.2.13 basis");
  assertJudgeReason(observation.reason);
  if (
    typeof observation.checkInProgress !== "boolean" ||
    (observation.checkInProgress &&
      observation.stage !== "don-check" &&
      observation.stage !== "sheriff-check")
  )
    throw new Error("Check-in-progress requires an explicit current-check observation");
};
const decide = (game: GameState): GameState => {
  // Accepted natural departures are applied atomically before numerical termination.
  if (
    game.phase === "night-mafia-result" ||
    (game.phase === "car-crash-result" &&
      game.carCrashResult?.eliminate &&
      game.carCrashResult.seats.some(
        (seat) => game.players.find((p) => p.seat === seat)?.status === "active",
      ))
  )
    return game;
  const winner = evaluateVictory(game.players);
  // A pending accepted check/count remains authoritative before numerical termination.
  if (
    winner === null ||
    game.disciplinaryRemovals?.some((r) => r.departure === "pending" || r.checkCompletionPending)
  )
    return game;
  return {
    ...game,
    phase: "finished",
    winner,
    goodbyeSeats: undefined,
    goodbyeNext: undefined,
    ballot: undefined,
  };
};
export const observeDisciplinaryRemoval = (
  game: GameState,
  observation: RemovalObservation,
): GameState => {
  assertFederationAction(game);
  assertRemovalObservation(observation);
  if (!stagePhases[observation.stage].includes(game.phase))
    throw new Error("Occurrence stage does not match the current phase");
  const player = game.players.find((p) => p.seat === observation.seat);
  if (
    !player ||
    player.status === "red-carded" ||
    game.disciplinaryRemovals?.some((r) => r.seat === player.seat)
  )
    throw new Error("Removal subject is unknown or already disqualified");
  const acceptedVoteVictim =
    game.phase === "car-crash-result" &&
    game.carCrashResult?.eliminate === true &&
    game.carCrashResult.seats.includes(player.seat);
  const departingVictim =
    acceptedVoteVictim ||
    (player.status === "eliminated" &&
      (game.goodbyeSeats?.includes(player.seat) ||
        (game.nightResult?.kind === "kill" && game.nightResult.targetSeat === player.seat)));
  if (player.status !== "active" && !departingVictim)
    throw new Error("Only an active participant or correctly departing victim can be sanctioned");
  const owner =
    observation.stage === "don-check"
      ? "don"
      : observation.stage === "sheriff-check"
        ? "sheriff"
        : undefined;
  if (observation.checkInProgress && player.role !== owner)
    throw new Error("Only the current check owner may have an already-started check entitlement");
  const checkCompletionPending = observation.checkInProgress;
  const night = [
    "agreement",
    "before-shooting-count",
    "shooting-count",
    "don-check",
    "sheriff-check",
  ].includes(observation.stage);
  const removal: DisciplinaryRemoval = {
    ...observation,
    occurredPhase: game.phase,
    day: game.day,
    effectiveExcluded: true,
    departure:
      observation.stage === "shooting-count" || checkCompletionPending ? "pending" : "departed",
    announcement: "pending",
    shotDeath:
      departingVictim &&
      game.nightResult?.kind === "kill" &&
      game.nightResult.targetSeat === player.seat,
    checkCompletionPending,
  };
  const changed =
    player.status === "eliminated"
      ? {
          ...game,
          players: game.players.map((p) =>
            p.seat === player.seat ? { ...p, status: "red-carded" as const } : p,
          ),
        }
      : markPlayerInactive(game, player.seat, "red-carded");
  const afterResult =
    observation.stage === "after-voting-result" ||
    (observation.stage === "farewell" && game.goodbyeNext === "night");
  const debtDay = night || afterResult ? game.day + 1 : game.day;
  const needsDebt = !departingVictim && observation.stage !== "shooting-count";
  let next: GameState = {
    ...changed,
    disciplinaryRemovals: [...(game.disciplinaryRemovals ?? []), removal],
    ballotCancellationDay: needsDebt
      ? (game.ballotCancellationDay ?? Math.max(1, debtDay))
      : game.ballotCancellationDay,
    redCardIssuedThisDay: needsDebt && !night && !afterResult ? true : game.redCardIssuedThisDay,
    nominations: changed.nominations
      .filter((n) => changed.players.find((p) => p.seat === n.candidateSeat)?.status === "active")
      .map((nomination, index) => ({ ...nomination, order: index + 1 })),
    goodbyeSeats: game.goodbyeSeats?.filter((seat) => seat !== player.seat),
    ...(player.team === "black"
      ? {
          shotAssignments: Object.fromEntries(
            Object.entries(game.shotAssignments).filter(([seat]) => Number(seat) !== player.seat),
          ),
          actualMultipleShotSeats: game.actualMultipleShotSeats?.filter(
            (seat) => seat !== player.seat,
          ),
        }
      : {}),
  };
  if (observation.stage === "open-voting")
    next = {
      ...next,
      phase: "voting-cancelled",
      votingCancellation: { reason: "red-card" },
      ballot: undefined,
      ballotSkipReason: "disciplinary-cancellation",
      turnOrder: [],
      currentTurnIndex: 0,
      voteAssignments: {},
      carCrashSeats: undefined,
      carCrashVotes: undefined,
      carCrashResult: undefined,
    };
  if (game.phase === "day") {
    const removedIndex = game.turnOrder.indexOf(player.seat);
    const turnOrder = game.turnOrder.filter((seat) => seat !== player.seat);
    const currentTurnIndex =
      removedIndex >= 0 && removedIndex < game.currentTurnIndex
        ? game.currentTurnIndex - 1
        : game.currentTurnIndex;
    next = {
      ...next,
      turnOrder,
      currentTurnIndex,
      ...(removedIndex === game.currentTurnIndex
        ? {
            currentSpeechRestricted:
              changed.players.find((p) => p.seat === turnOrder[currentTurnIndex])?.mutePending ??
              false,
          }
        : {}),
    };
    if (currentTurnIndex >= turnOrder.length)
      next = {
        ...next,
        phase: "voting-cancelled",
        votingCancellation: { reason: "red-card" },
        ballotSkipReason: "disciplinary-cancellation",
        ballot: undefined,
      };
  }
  if (!checkCompletionPending && owner === player.role)
    next = {
      ...next,
      phase:
        owner === "don" && next.players.some((p) => p.role === "sheriff" && p.status === "active")
          ? "night-sheriff"
          : "night-resolution",
      checkResult: undefined,
    };
  return decide(next);
};
export const settleShootingRemovals = (
  game: GameState,
  killedSeat: number | undefined,
): GameState => {
  const disciplinaryRemovals = game.disciplinaryRemovals?.map((r) =>
    r.stage === "shooting-count" && r.day === game.day && r.departure === "pending"
      ? { ...r, departure: "departed" as const, shotDeath: r.seat === killedSeat }
      : r,
  );
  const requiresDebt = disciplinaryRemovals?.some(
    (r) => r.stage === "shooting-count" && r.day === game.day && !r.shotDeath,
  );
  return {
    ...game,
    disciplinaryRemovals,
    ballotCancellationDay: requiresDebt
      ? (game.ballotCancellationDay ?? game.day + 1)
      : game.ballotCancellationDay,
  };
};
export const settleCheckRemoval = (game: GameState, owner: "don" | "sheriff"): GameState => {
  const seat = game.players.find((p) => p.role === owner)?.seat;
  return decide({
    ...game,
    disciplinaryRemovals: game.disciplinaryRemovals?.map((r) =>
      r.seat === seat && r.checkCompletionPending
        ? { ...r, departure: "departed", checkCompletionPending: false }
        : r,
    ),
  });
};
export const announceDisciplinaryRemovals = (
  game: GameState,
  seats?: readonly number[],
): GameState => {
  if (game.phase === "finished") {
    if (!isFederationGame(game)) throw new Error("Federation rules are required");
  } else assertFederationAction(game);
  const pending = game.disciplinaryRemovals?.filter((r) => r.announcement === "pending") ?? [];
  const requested = seats ?? pending.map((r) => r.seat);
  if (
    !requested.length ||
    new Set(requested).size !== requested.length ||
    requested.some((seat) => !pending.some((r) => r.seat === seat))
  )
    throw new Error("Announcement requires pending distinct removal seats");
  for (const removal of pending.filter((r) => requested.includes(r.seat))) {
    if (
      removal.departure !== "departed" ||
      removal.checkCompletionPending ||
      (removal.stage === "shooting-count"
        ? ![
            "night-mafia-result",
            "night-don",
            "night-don-result",
            "night-sheriff",
            "night-sheriff-result",
            "night-resolution",
            "best-move",
            "finished",
          ].includes(game.phase)
        : (removal.stage === "don-check" || removal.stage === "sheriff-check") &&
          !["night-resolution", "best-move", "finished"].includes(game.phase))
    )
      throw new Error("Removal announcement must wait for its rule-backed count/check boundary");
  }
  return decide({
    ...game,
    disciplinaryRemovals: game.disciplinaryRemovals?.map((r) =>
      requested.includes(r.seat) ? { ...r, announcement: "announced" } : r,
    ),
  });
};
