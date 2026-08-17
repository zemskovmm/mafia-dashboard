import { evaluateVictory, getDayOrder, markPlayerInactive } from "./game.js";
import type { GameState, NightShotResult, SecretCheckResult, ShotAssignment } from "./types.js";

const activePlayerAt = (game: GameState, seat: number) => {
  const player = game.players.find((candidate) => candidate.seat === seat);
  if (player === undefined || player.status !== "active") {
    throw new Error(`Seat ${seat} must be an active target`);
  }
  return player;
};

const nextPrivatePhase = (game: GameState): GameState["phase"] => {
  if (game.players.some(({ role, status }) => role === "don" && status === "active")) {
    return "night-don";
  }
  if (game.players.some(({ role, status }) => role === "sheriff" && status === "active")) {
    return "night-sheriff";
  }
  return "night-resolution";
};

export const beginNight = (game: GameState): GameState => {
  if (game.phase !== "day" && game.phase !== "voting") {
    throw new Error(`Cannot begin night from phase ${game.phase}`);
  }
  return { ...game, phase: "night-mafia", shotAssignments: {} };
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
  activePlayerAt(game, targetSeat);
  if (game.shotAssignments[shooterSeat] !== undefined) {
    throw new Error(`A shot is already recorded for seat ${shooterSeat}`);
  }
  return {
    ...game,
    shotAssignments: { ...game.shotAssignments, [shooterSeat]: targetSeat },
  };
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
  if (shooters.some(({ seat }) => game.shotAssignments[seat] === undefined)) {
    throw new Error("Every active Mafia-aligned player must record one shot");
  }

  const secretShots: ShotAssignment[] = shooters.map(({ seat }) => ({
    shooterSeat: seat,
    targetSeat: game.shotAssignments[seat]!,
    secret: true,
  }));
  const targets = new Set(secretShots.map(({ targetSeat }) => targetSeat));

  if (targets.size !== 1) {
    return {
      game: { ...game, phase: nextPrivatePhase(game) },
      result: { kind: "miss" },
      secretShots,
    };
  }

  const targetSeat = secretShots[0]!.targetSeat;
  const afterKill = markPlayerInactive(game, targetSeat, "eliminated");
  const winner = evaluateVictory(afterKill.players);
  const nextGame =
    winner === null
      ? { ...afterKill, phase: nextPrivatePhase(afterKill) }
      : { ...afterKill, phase: "finished" as const, winner };
  return { game: nextGame, result: { kind: "kill", targetSeat }, secretShots };
};

export const performDonCheck = (
  game: GameState,
  targetSeat: number,
): { game: GameState; result: SecretCheckResult } => {
  if (game.phase !== "night-don") {
    throw new Error("The Don check is not active");
  }
  if (!game.players.some(({ role, status }) => role === "don" && status === "active")) {
    throw new Error("There is no active Don");
  }
  const target = activePlayerAt(game, targetSeat);
  const phase = game.players.some(({ role, status }) => role === "sheriff" && status === "active")
    ? "night-sheriff"
    : "night-resolution";
  return {
    game: { ...game, phase },
    result: {
      kind: "don-check",
      targetSeat,
      match: target.role === "sheriff",
      secret: true,
    },
  };
};

export const performSheriffCheck = (
  game: GameState,
  targetSeat: number,
): { game: GameState; result: SecretCheckResult } => {
  if (game.phase !== "night-sheriff") {
    throw new Error("The Sheriff check is not active");
  }
  if (!game.players.some(({ role, status }) => role === "sheriff" && status === "active")) {
    throw new Error("There is no active Sheriff");
  }
  const target = activePlayerAt(game, targetSeat);
  return {
    game: { ...game, phase: "night-resolution" },
    result: {
      kind: "sheriff-check",
      targetSeat,
      match: target.team === "black",
      secret: true,
    },
  };
};

export const completeNight = (game: GameState): GameState => {
  if (game.phase !== "night-resolution") {
    throw new Error("Night can only complete after all available checks");
  }
  const day = game.day + 1;
  return {
    ...game,
    phase: "day",
    day,
    turnOrder: getDayOrder(game.players, day),
    currentTurnIndex: 0,
    nominations: [],
    voteAssignments: {},
    shotAssignments: {},
  };
};
