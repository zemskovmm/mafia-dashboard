import { evaluateVictory, getDayOrder, markPlayerInactive } from "./game.js";
import { transitionToNight } from "./night-transition.js";
import type { GameState, NightShotResult, SecretCheckResult, ShotAssignment } from "./types.js";

const playerAt = (game: GameState, seat: number) => {
  const player = game.players.find((candidate) => candidate.seat === seat);
  if (player === undefined) throw new Error(`Seat ${seat} is not seated`);
  return player;
};

export const isNightCheckEligible = (game: GameState, role: "don" | "sheriff"): boolean => {
  const snapshot = game.nightCheckEligibility?.[role];
  if (snapshot !== undefined) return snapshot;
  const owner = game.players.find(({ role: playerRole }) => playerRole === role);
  return (
    owner?.status === "active" ||
    owner?.status === "eliminated" ||
    (game.nightResult?.kind === "kill" && game.nightResult.targetSeat === owner?.seat)
  );
};

const resultForTargets = (game: GameState, targets: ReadonlySet<number>): NightShotResult => {
  if (targets.size !== 1) return { kind: "miss" };
  const targetSeat = [...targets][0]!;
  return playerAt(game, targetSeat).status === "active"
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
    game.phase !== "day" &&
    game.phase !== "voting" &&
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
): { game: GameState; result: NightShotResult; secretShots: readonly ShotAssignment[] } => {
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
    secretShots.length === shooters.length
      ? resultForTargets(game, targets)
      : { kind: "miss" as const };

  return {
    game: { ...game, phase: "night-mafia-result" },
    result,
    secretShots,
  };
};

export const getMafiaShotResult = (game: GameState): NightShotResult => {
  if (game.phase !== "night-mafia-result") {
    throw new Error("Mafia shot results are only available after evaluation");
  }
  const shooters = game.players.filter(
    ({ team, status }) => team === "black" && status === "active",
  );
  const assignedTargets = shooters.flatMap(({ seat }) => {
    const targetSeat = game.shotAssignments[seat];
    return targetSeat === undefined ? [] : [targetSeat];
  });
  if (assignedTargets.length !== shooters.length) return { kind: "miss" };
  const targets = new Set(assignedTargets);
  return resultForTargets(game, targets);
};

export const completeMafiaShots = (game: GameState): GameState => {
  if (game.phase !== "night-mafia-result") {
    throw new Error("Mafia shots can only complete after evaluation");
  }
  const result = getMafiaShotResult(game);
  const resolvedGame =
    result.kind === "kill" ? markPlayerInactive(game, result.targetSeat, "eliminated") : game;
  const withResult = { ...resolvedGame, nightResult: result };
  return {
    ...withResult,
    phase: nextPrivatePhase(withResult),
    shotAssignments: {},
    winner: null,
  };
};

export const performDonCheck = (
  game: GameState,
  targetSeat: number,
): { game: GameState; result: SecretCheckResult } => {
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
  return { ...game, phase, checkResult: undefined };
};

export const skipDonCheck = (game: GameState): GameState => {
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
): { game: GameState; result: SecretCheckResult } => {
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
    game: { ...game, phase: "night-sheriff-result", checkResult: result },
    result,
  };
};

export const continueSheriffCheck = (game: GameState): GameState => {
  if (game.phase !== "night-sheriff-result" || game.checkResult?.kind !== "sheriff-check") {
    throw new Error("The Sheriff result is not ready to continue");
  }
  if (!isNightCheckEligible(game, "sheriff")) throw new Error("There is no available Sheriff");
  return { ...game, phase: "night-resolution", checkResult: undefined };
};

export const skipSheriffCheck = (game: GameState): GameState => {
  if (game.phase !== "night-sheriff") throw new Error("The Sheriff check is not active");
  if (game.nightCheckEligibility !== undefined && !isNightCheckEligible(game, "sheriff")) {
    throw new Error("There is no available Sheriff");
  }
  return { ...game, phase: "night-resolution", checkResult: undefined };
};

export const completeNight = (game: GameState): GameState => {
  if (game.phase !== "night-resolution") {
    throw new Error("Night can only complete after all available checks");
  }
  const day = game.day + 1;
  const players = game.players.map((player) =>
    player.mutePending ? { ...player, mutePending: false } : player,
  );
  const previousOpeningSeat = game.dayOpeningSeat ?? getDayOrder(game.players, game.day)[0] ?? 1;
  const turnOrder = getDayOrder(players, previousOpeningSeat + 1);
  const dayState: GameState = {
    ...game,
    day,
    players,
    cyclesWithoutElimination: game.eliminationOccurredThisCycle
      ? 0
      : (game.cyclesWithoutElimination ?? 0) + 1,
    eliminationOccurredThisCycle: false,
    dayOpeningSeat: turnOrder[0],
    turnOrder,
    currentTurnIndex: 0,
    nominations: [],
    voteAssignments: {},
    shotAssignments: {},
    nightCheckEligibility: undefined,
    checkResult: undefined,
    redCardIssuedThisDay: undefined,
  };
  if (game.nightResult?.kind === "kill") {
    return game.day === 1 && game.bestMoveEnabled !== false
      ? {
          ...dayState,
          phase: "best-move",
          goodbyeSeats: [game.nightResult.targetSeat],
          goodbyeNext: "day",
          bestMove: { playerSeat: game.nightResult.targetSeat, selectedSeats: [] },
        }
      : {
          ...dayState,
          phase: "goodbye-speech",
          goodbyeSeats: [game.nightResult.targetSeat],
          goodbyeNext: "day",
        };
  }
  return {
    ...dayState,
    phase: "day",
    goodbyeSeats: undefined,
    goodbyeNext: undefined,
    nightResult: undefined,
  };
};

export const toggleBestMoveSeat = (game: GameState, seat: number): GameState => {
  if (game.phase !== "best-move" || game.bestMove === undefined) {
    throw new Error("Best move selections require the Best move phase");
  }
  if (seat === game.bestMove.playerSeat) {
    throw new Error("The Best move owner cannot select themselves");
  }
  if (playerAt(game, seat).status !== "active") {
    throw new Error("A Best move may select only active players");
  }
  const selected = game.bestMove.selectedSeats;
  const selectedSeats = selected.includes(seat)
    ? selected.filter((candidate) => candidate !== seat)
    : selected.length >= 3
      ? (() => {
          throw new Error("A Best move contains exactly three players");
        })()
      : [...selected, seat];
  return { ...game, bestMove: { ...game.bestMove, selectedSeats } };
};

export const completeBestMove = (game: GameState): GameState => {
  if (game.phase !== "best-move" || game.bestMove === undefined) {
    throw new Error("Only a Best move can be completed");
  }
  if (game.bestMove.selectedSeats.length !== 3) {
    throw new Error("A Best move must name exactly three players");
  }
  const mafiaHits = game.bestMove.selectedSeats.filter(
    (seat) => playerAt(game, seat).team === "black",
  ).length;
  return {
    ...game,
    phase: "goodbye-speech",
    bestMove: { ...game.bestMove, mafiaHits },
    dayNotice: undefined,
  };
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
