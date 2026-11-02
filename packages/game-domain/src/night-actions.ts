import { settleCheckRemoval, settleShootingRemovals } from "./federation-discipline.js";
import { acceptBestMoveSeat, finalizeBestMove, prepareBestMove } from "./federation-actions.js";
import {
  completeFederationGameNight,
  evaluateVictory,
  getDayOrder,
  markPlayerInactive,
} from "./game.js";

import { transitionToNight } from "./night-transition.js";
import type { GameState, NightShotResult, SecretCheckResult, ShotAssignment } from "./types.js";
const playerAt = (game: GameState, seat: number) => {
  const player = game.players.find((candidate) => candidate.seat === seat);
  if (player === undefined) throw new Error(`Seat ${seat} is not seated`);
  return player;
};
export const isNightCheckEligible = (game: GameState, role: "don" | "sheriff"): boolean => {
  const ownerStatus = game.players.find((p) => p.role === role)?.status;
  if (ownerStatus === "red-carded") {
    const owner = game.players.find((p) => p.role === role);
    return (
      (game.phase === `night-${role}` || game.phase === `night-${role}-result`) &&
      !!game.disciplinaryRemovals?.some((r) => r.seat === owner?.seat && r.checkCompletionPending)
    );
  }
  const snapshot = game.nightCheckEligibility?.[role];
  if (snapshot !== undefined) return snapshot;
  const owner = game.players.find(({ role: playerRole }) => playerRole === role);
  return (
    owner?.status === "active" ||
    (game.nightResult?.kind === "kill" && game.nightResult.targetSeat === owner?.seat)
  );
};
const resultForTargets = (game: GameState, targets: ReadonlySet<number>): NightShotResult => {
  if (targets.size !== 1) return { kind: "miss" };
  const targetSeat = [...targets][0]!;
  const simultaneousDisqualification = game.disciplinaryRemovals?.some(
    (r) => r.seat === targetSeat && r.stage === "shooting-count" && r.day === game.day,
  );
  return playerAt(game, targetSeat).status === "active" || simultaneousDisqualification
    ? { kind: "kill", targetSeat }
    : { kind: "no-effect", targetSeat };
};
const nextPrivatePhase = (game: GameState): GameState["phase"] => {
  if (isNightCheckEligible(game, "don")) return "night-don";
  if (isNightCheckEligible(game, "sheriff")) return "night-sheriff";
  return "night-resolution";
};
export const beginNight = (game: GameState): GameState => {
  if (
    game.phase === "voting" ||
    (game.phase === "day" &&
      (game.nominations.length >= 2 || (game.day > 1 && game.nominations.length === 1)) &&
      game.ballotCancellationDay !== game.day)
  )
    throw new Error(
      "An unresolved federation ballot cannot be bypassed; accept its result or a named legal cancellation",
    );
  if (
    game.phase !== "day" &&
    game.phase !== "voting-cancelled" &&
    game.phase !== "car-crash-skipped" &&
    game.phase !== "goodbye-speech"
  ) {
    throw new Error(`Cannot begin night from phase ${game.phase}`);
  }
  return transitionToNight(game);
};
export const recordMafiaShot = (
  game: GameState,
  shooterSeat: number,
  targetSeat: number,
): GameState => {
  if (game.phase !== "night-mafia") {
    throw new Error("Mafia shots can only be recorded during the Mafia night phase");
  }
  const shooter = game.players.find((candidate) => candidate.seat === shooterSeat);
  if (shooter === undefined || shooter.status !== "active" || shooter.team !== "black") {
    throw new Error("The shooter must be an active Mafia-aligned player");
  }
  playerAt(game, targetSeat);
  if (game.shotAssignments[shooterSeat] !== undefined) {
    throw new Error(`A shot is already recorded for seat ${shooterSeat}`);
  }
  return {
    ...game,
    shotAssignments: { ...game.shotAssignments, [shooterSeat]: targetSeat },
  };
};
export const toggleMafiaShot = (
  game: GameState,
  shooterSeat: number,
  targetSeat: number,
): GameState => {
  if (game.phase !== "night-mafia") {
    throw new Error("Mafia shots can only be changed during the Mafia night phase");
  }
  const shooter = game.players.find((candidate) => candidate.seat === shooterSeat);
  if (shooter === undefined || shooter.status !== "active" || shooter.team !== "black") {
    throw new Error("The shooter must be an active Mafia-aligned player");
  }
  playerAt(game, targetSeat);
  const shotAssignments = { ...game.shotAssignments };
  if (shotAssignments[shooterSeat] === targetSeat) delete shotAssignments[shooterSeat];
  else shotAssignments[shooterSeat] = targetSeat;
  return { ...game, shotAssignments };
};
export const toggleAllMafiaShotsForTarget = (game: GameState, targetSeat: number): GameState => {
  if (game.phase !== "night-mafia") {
    throw new Error("Mafia shots can only be changed during the Mafia night phase");
  }
  playerAt(game, targetSeat);
  const shooters = game.players.filter(
    ({ status, team }) => status === "active" && team === "black",
  );
  const selected = shooters.every(({ seat }) => game.shotAssignments[seat] === targetSeat);
  const shotAssignments = { ...game.shotAssignments };
  for (const { seat } of shooters) {
    if (selected) delete shotAssignments[seat];
    else shotAssignments[seat] = targetSeat;
  }
  return { ...game, shotAssignments };
};
export const resolveMafiaShots = (
  game: GameState,
): {
  game: GameState;
  result: NightShotResult;
  secretShots: readonly ShotAssignment[];
} => {
  if (game.phase !== "night-mafia") {
    throw new Error("Mafia shots can only be resolved during the Mafia night phase");
  }
  const shooters = game.players.filter(
    ({ team, status }) => team === "black" && status === "active",
  );
  const secretShots: ShotAssignment[] = shooters.flatMap(({ seat }) => {
    const targetSeat = game.shotAssignments[seat];
    return targetSeat === undefined ? [] : [{ shooterSeat: seat, targetSeat, secret: true }];
  });
  const targets = new Set(secretShots.map(({ targetSeat }) => targetSeat));
  const result =
    secretShots.length === shooters.length &&
    !game.actualMultipleShotSeats?.length &&
    !game.shotObservations?.some(
      (shot) => shot.additional && shooters.some((p) => p.seat === shot.shooterSeat),
    )
      ? resultForTargets(game, targets)
      : { kind: "miss" as const };
  return {
    game: settleShootingRemovals(
      { ...game, phase: "night-mafia-result", nightResult: result },
      result.kind === "kill" ? result.targetSeat : undefined,
    ),
    result,
    secretShots,
  };
};
export const getMafiaShotResult = (game: GameState): NightShotResult => {
  if (game.phase !== "night-mafia-result") {
    throw new Error("Mafia shot results are only available after evaluation");
  }
  if (game.nightResult !== undefined) return game.nightResult;
  const shooters = game.players.filter(
    ({ team, status }) => team === "black" && status === "active",
  );
  const assignedTargets = shooters.flatMap(({ seat }) => {
    const targetSeat = game.shotAssignments[seat];
    return targetSeat === undefined ? [] : [targetSeat];
  });
  if (
    assignedTargets.length !== shooters.length ||
    game.actualMultipleShotSeats?.length ||
    game.shotObservations?.some(
      (shot) => shot.additional && shooters.some((p) => p.seat === shot.shooterSeat),
    )
  )
    return { kind: "miss" };
  const targets = new Set(assignedTargets);
  return resultForTargets(game, targets);
};
export const completeMafiaShots = (game: GameState): GameState => {
  // Unrecorded public speech is not acknowledgement debt; physical departures
  // and any underway private check still have to settle at their own boundary.
  if (game.disciplinaryRemovals?.some((r) => r.departure === "pending" || r.checkCompletionPending))
    throw new Error("A pending disciplinary departure/check must settle before private checks");
  if (game.phase !== "night-mafia-result") {
    throw new Error("Mafia shots can only complete after evaluation");
  }
  const result = getMafiaShotResult(game);
  const resolvedGame =
    result.kind === "kill" && playerAt(game, result.targetSeat).status === "active"
      ? markPlayerInactive(game, result.targetSeat, "eliminated")
      : game;
  const withResult = { ...resolvedGame, nightResult: result, shotAssignments: {} };
  const winner = evaluateVictory(withResult.players);
  if (winner !== null) return { ...withResult, phase: "finished", winner };
  return { ...withResult, phase: nextPrivatePhase(withResult), winner: null };
};
const consumeSheriffCheckWindow = (game: GameState): GameState =>
  game.pendingSheriffCheckDay === undefined ? game : { ...game, pendingSheriffCheckDay: undefined };

// New windows are opt-in canonical actions. Historical states have no pending
// entitlement marker, so their existing phase/check reducers retain their hashes.
export const getNightCheckWindowsToOpen = (game: GameState): ("don" | "sheriff")[] => {
  if (game.day < 1 || game.winner !== null) return [];
  const don = game.players.find((p) => p.role === "don");
  const pendingSheriff = game.pendingSheriffCheckDay === game.day;
  const fromMafia = game.phase === "night-mafia-result";
  const fromDon =
    game.phase === "night-don-result" &&
    game.checkResult?.kind === "don-check" &&
    isNightCheckEligible(game, "don");
  const fromDonSkip = game.phase === "night-don" && isNightCheckEligible(game, "don");
  // A generic resolution stage cannot be reopened. Require a same-night removal
  // plus either an unopened snapshot or an explicitly opened, unconsumed window.
  const fromDonRemoval =
    game.phase === "night-resolution" &&
    game.nightResult !== undefined &&
    game.checkResult === undefined &&
    (game.nightCheckEligibility?.sheriff === false || pendingSheriff) &&
    don?.status === "red-carded" &&
    game.disciplinaryRemovals?.some(
      (r) =>
        r.seat === don.seat &&
        r.day === game.day &&
        r.stage === "don-check" &&
        (r.occurredPhase === "night-don" || r.occurredPhase === "night-don-result") &&
        r.departure === "departed" &&
        !r.checkCompletionPending,
    );
  if (!fromMafia && !fromDon && !fromDonSkip && !fromDonRemoval) return [];
  if (
    game.disciplinaryRemovals?.some(
      (r) =>
        (r.departure === "pending" || r.checkCompletionPending) &&
        !(fromDon && r.seat === don?.seat && r.stage === "don-check" && r.checkCompletionPending),
    )
  )
    return [];
  // Settle the existing boundary first for outcome precedence, without mutating
  // the input or fabricating an announcement. An underway Don check still ends.
  let continued = game;
  if (fromMafia) continued = completeMafiaShots(game);
  else if (fromDon) continued = continueDonCheck(game);
  else if (fromDonSkip) continued = skipDonCheck(game);
  if (continued.winner !== null || evaluateVictory(continued.players) !== null) return [];
  return (["don", "sheriff"] as const).filter((role) => {
    const owner = game.players.find((p) => p.role === role);
    return (
      (fromMafia || role === "sheriff") &&
      owner?.status === "eliminated" &&
      !game.disciplinaryRemovals?.some((r) => r.seat === owner.seat) &&
      (!isNightCheckEligible(game, role) || (fromDonRemoval && pendingSheriff))
    );
  });
};
export const openNightCheckWindows = (
  game: GameState,
  roles: readonly ("don" | "sheriff")[],
): GameState => {
  const available = getNightCheckWindowsToOpen(game);
  if (
    !available.length ||
    roles.length !== available.length ||
    roles.some((role, index) => role !== available[index])
  )
    throw new Error("Night check windows must match the available unopened roles in order");
  const opened: GameState = {
    ...game,
    nightCheckEligibility: {
      don: roles.includes("don") || isNightCheckEligible(game, "don"),
      sheriff: roles.includes("sheriff") || isNightCheckEligible(game, "sheriff"),
    },
    ...(roles.includes("sheriff") ? { pendingSheriffCheckDay: game.day } : {}),
  };
  if (game.phase === "night-mafia-result") return completeMafiaShots(opened);
  if (game.phase === "night-don-result") return continueDonCheck(opened);
  if (game.phase === "night-don") return skipDonCheck(opened);
  return { ...opened, phase: "night-sheriff" };
};
export const performDonCheck = (
  game: GameState,
  targetSeat: number,
): {
  game: GameState;
  result: SecretCheckResult;
} => {
  if (game.phase !== "night-don") {
    throw new Error("The Don check is not active");
  }
  if (!isNightCheckEligible(game, "don")) {
    throw new Error("There is no available Don");
  }
  const target = playerAt(game, targetSeat);
  const result: SecretCheckResult = {
    kind: "don-check",
    targetSeat,
    match: target.role === "sheriff",
    secret: true,
  };
  return {
    game: { ...game, phase: "night-don-result", checkResult: result },
    result,
  };
};
export const continueDonCheck = (game: GameState): GameState => {
  if (game.phase !== "night-don-result" || game.checkResult?.kind !== "don-check") {
    throw new Error("The Don result is not ready to continue");
  }
  if (!isNightCheckEligible(game, "don")) throw new Error("There is no available Don");
  const phase = isNightCheckEligible(game, "sheriff") ? "night-sheriff" : "night-resolution";
  const continued: GameState = { ...game, phase, checkResult: undefined };
  return settleCheckRemoval(continued, "don");
};
export const skipDonCheck = (game: GameState): GameState => {
  if (game.disciplinaryRemovals?.some((r) => r.stage === "don-check" && r.checkCompletionPending))
    throw new Error("An already-underway sanctioned check must be completed");
  if (game.phase !== "night-don") throw new Error("The Don check is not active");
  if (game.nightCheckEligibility !== undefined && !isNightCheckEligible(game, "don")) {
    throw new Error("There is no available Don");
  }
  return {
    ...game,
    phase: isNightCheckEligible(game, "sheriff") ? "night-sheriff" : "night-resolution",
    checkResult: undefined,
  };
};
export const performSheriffCheck = (
  game: GameState,
  targetSeat: number,
): {
  game: GameState;
  result: SecretCheckResult;
} => {
  if (game.phase !== "night-sheriff") {
    throw new Error("The Sheriff check is not active");
  }
  if (!isNightCheckEligible(game, "sheriff")) {
    throw new Error("There is no available Sheriff");
  }
  const target = playerAt(game, targetSeat);
  const result: SecretCheckResult = {
    kind: "sheriff-check",
    targetSeat,
    match: target.team === "black",
    secret: true,
  };
  return {
    game: {
      ...game,
      phase: "night-sheriff-result",
      checkResult: result,
      sheriffChecksPerformed: game.sheriffChecksPerformed + 1,
    },
    result,
  };
};
export const continueSheriffCheck = (game: GameState): GameState => {
  if (game.phase !== "night-sheriff-result" || game.checkResult?.kind !== "sheriff-check") {
    throw new Error("The Sheriff result is not ready to continue");
  }
  if (!isNightCheckEligible(game, "sheriff")) throw new Error("There is no available Sheriff");
  const continued: GameState = { ...game, phase: "night-resolution", checkResult: undefined };
  return settleCheckRemoval(consumeSheriffCheckWindow(continued), "sheriff");
};
export const skipSheriffCheck = (game: GameState): GameState => {
  if (
    game.disciplinaryRemovals?.some((r) => r.stage === "sheriff-check" && r.checkCompletionPending)
  )
    throw new Error("An already-underway sanctioned check must be completed");
  if (game.phase !== "night-sheriff") throw new Error("The Sheriff check is not active");
  if (game.nightCheckEligibility !== undefined && !isNightCheckEligible(game, "sheriff")) {
    throw new Error("There is no available Sheriff");
  }
  const continued: GameState = { ...game, phase: "night-resolution", checkResult: undefined };
  return settleCheckRemoval(consumeSheriffCheckWindow(continued), "sheriff");
};
export const completeNight = (game: GameState): GameState => {
  if (game.disciplinaryRemovals?.some((r) => r.departure === "pending" || r.checkCompletionPending))
    throw new Error("A pending disciplinary departure/check must settle before morning/Best Move");
  const prepared = prepareBestMove(consumeSheriffCheckWindow(game));
  if (prepared.phase === "best-move") return prepared;
  const completed = completeFederationGameNight(prepared);
  if (completed.phase === "draw") return completed;
  const previousOpeningSeat = game.dayOpeningSeat ?? 1;
  const turnOrder = getDayOrder(game.players, previousOpeningSeat + 1);
  const targetSeat = game.nightResult?.kind === "kill" ? game.nightResult.targetSeat : undefined;
  const victim = game.players.find((p) => p.seat === targetSeat);
  const goodbyeSeats = victim?.status === "eliminated" ? [victim.seat] : [];
  return {
    ...completed,
    phase: goodbyeSeats.length ? "goodbye-speech" : "day",
    day: game.day + 1,
    dayOpeningSeat: turnOrder[0],
    turnOrder,
    currentTurnIndex: 0,
    nominations: [],
    voteAssignments: {},
    shotAssignments: {},
    nightCheckEligibility: undefined,
    checkResult: undefined,
    goodbyeSeats: goodbyeSeats.length ? goodbyeSeats : undefined,
    goodbyeNext: goodbyeSeats.length ? "day" : undefined,
    currentSpeechRestricted:
      game.players.find((p) => p.seat === turnOrder[0])?.mutePending ?? false,
    redCardIssuedThisDay: undefined,
  };
};
export const toggleBestMoveSeat = (game: GameState, seat: number): GameState => {
  return acceptBestMoveSeat(game, seat);
};
export const completeBestMove = (game: GameState): GameState => {
  return finalizeBestMove(
    game,
    game.bestMove?.selectedSeats.length === 0
      ? "declined"
      : game.bestMove?.selectedSeats.length === 3
        ? "complete-list"
        : "finished-early",
    true,
  );
};
export const completeGoodbyeSpeech = (game: GameState): GameState => {
  if (game.phase !== "goodbye-speech") throw new Error("There is no goodbye speech to complete");
  const winner = evaluateVictory(game.players);
  if (winner !== null) {
    return {
      ...game,
      phase: "finished",
      winner,
      goodbyeSeats: undefined,
      goodbyeNext: undefined,
      nightResult: undefined,
      dayNotice: undefined,
    };
  }
  if (game.goodbyeNext !== "day") return beginNight(game);
  return {
    ...game,
    phase: "day",
    goodbyeSeats: undefined,
    goodbyeNext: undefined,
    nightResult: undefined,
    dayNotice: undefined,
  };
};
