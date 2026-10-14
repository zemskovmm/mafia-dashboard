import { assertCompleteRoleAssignments } from "./setup.js";
import { assertRulesEdition, isFederationGame, type RulesEdition } from "./rules-edition.js";
import type {
  GameState,
  PlayerState,
  PlayerStatus,
  Role,
  SetupState,
  Team,
  Winner,
} from "./types.js";

export const getRoleTeam = (role: Role): Team =>
  role === "mafia" || role === "don" ? "black" : "red";

export const getDayOrder = (players: readonly PlayerState[], requestedStart: number): number[] => {
  if (!Number.isInteger(requestedStart) || requestedStart < 1) {
    throw new Error("Starting seat must be a positive integer");
  }

  const normalizedStart = ((requestedStart - 1) % 10) + 1;
  const clockwiseSeats = Array.from(
    { length: 10 },
    (_, offset) => ((normalizedStart - 1 + offset) % 10) + 1,
  );
  const activeSeats = new Set(
    players.filter(({ status }) => status === "active").map(({ seat }) => seat),
  );
  return clockwiseSeats.filter((seat) => activeSeats.has(seat));
};

export const createGame = (
  setup: SetupState,
  {
    bestMoveEnabled = true,
    rulesEdition,
  }: { readonly bestMoveEnabled?: boolean; readonly rulesEdition?: RulesEdition } = {},
): GameState => {
  if (setup.step !== "mafia-planning" || Object.keys(setup.assignments).length !== 10) {
    throw new Error("Role setup must be complete before a game is created");
  }
  assertCompleteRoleAssignments(setup);
  if (rulesEdition !== undefined) assertRulesEdition(rulesEdition);
  if (
    setup.rulesEdition !== undefined &&
    rulesEdition !== undefined &&
    setup.rulesEdition !== rulesEdition
  ) {
    throw new Error("Game rules edition must match the captured setup rules edition");
  }
  const capturedEdition = rulesEdition ?? setup.rulesEdition;

  const players: PlayerState[] = setup.players.map((player) => {
    const role = setup.assignments[player.seat];
    if (role === undefined) {
      throw new Error(`Seat ${player.seat} does not have a role`);
    }
    return {
      id: player.id,
      seat: player.seat,
      role,
      team: getRoleTeam(role),
      status: "active",
      fouls: 0,
      mutePending: false,
    };
  });

  return {
    ...(capturedEdition === undefined ? {} : { rulesEdition: capturedEdition }),
    ...(capturedEdition === undefined
      ? {}
      : {
          completedGameNights: 0,
          sheriffChecksPerformed: 0,
          firstDayDepartureSeats: [],
          currentSpeechRestricted: false,
        }),
    phase: "mafia-planning",
    day: 0,
    bestMoveEnabled,
    skipCasperBestMove: true,
    cyclesWithoutElimination: 0,
    eliminationOccurredThisCycle: false,
    players,
    turnOrder: [],
    currentTurnIndex: 0,
    nominations: [],
    voteAssignments: {},
    shotAssignments: {},
    winner: null,
  };
};

export const getCurrentTurnDuration = (game: GameState): 0 | 10 | 30 | 60 => {
  if (game.phase === "car-crash") return 30;
  if (game.phase !== "day") {
    throw new Error("A turn timer is only available during the day or car crash");
  }
  const seat = game.turnOrder[game.currentTurnIndex];
  const player = game.players.find((candidate) => candidate.seat === seat);
  if (player === undefined || player.status !== "active") {
    throw new Error("The current turn does not reference an active player");
  }
  if (isFederationGame(game)) {
    if (!game.currentSpeechRestricted) return 60;
    const active = game.players.filter((p) => p.status === "active").length;
    return active === 3 || active === 4 ? 30 : 0;
  }
  return player.mutePending ? 10 : 60;
};

export const advanceSetupPhase = (game: GameState): GameState => {
  if (isFederationGame(game)) {
    const phases = [
      "mafia-planning",
      "mafia-sleep",
      "don-identification",
      "sheriff-identification",
      "free-seating",
    ] as const;
    const index = phases.indexOf(game.phase as (typeof phases)[number]);
    if (index < 0) throw new Error(`Cannot advance setup from phase ${game.phase}`);
    if (index < phases.length - 1) return { ...game, phase: phases[index + 1]! };
    const turnOrder = getDayOrder(game.players, 1);
    const completed = completeFederationGameNight(game);
    if (completed.phase === "draw") return completed;
    return {
      ...completed,
      phase: "day",
      day: 1,
      dayOpeningSeat: turnOrder[0],
      turnOrder,
      currentTurnIndex: 0,
      currentSpeechRestricted:
        game.players.find((p) => p.seat === turnOrder[0])?.mutePending ?? false,
    };
  }
  if (game.phase === "mafia-planning") {
    return { ...game, phase: "sheriff-wake" };
  }
  if (game.phase === "sheriff-wake") {
    const turnOrder = getDayOrder(game.players, 1);
    return {
      ...game,
      phase: "day",
      day: 1,
      dayOpeningSeat: turnOrder[0],
      turnOrder,
      currentTurnIndex: 0,
    };
  }
  throw new Error(`Cannot advance setup from phase ${game.phase}`);
};

export const markPlayerInactive = (
  game: GameState,
  seat: number,
  status: Exclude<PlayerStatus, "active">,
): GameState => {
  const player = game.players.find((candidate) => candidate.seat === seat);
  if (player === undefined) {
    throw new Error(`Seat ${seat} is not part of this game`);
  }
  if (player.status !== "active") {
    throw new Error(`Seat ${seat} is already inactive`);
  }

  return {
    ...game,
    eliminationOccurredThisCycle: true,
    ...(isFederationGame(game)
      ? {
          cyclesWithoutElimination: 0,
          firstDayDepartureSeats:
            game.day === 1 &&
            [
              "day",
              "voting",
              "car-crash",
              "car-crash-decision",
              "car-crash-result",
              "goodbye-speech",
              "voting-cancelled",
              "car-crash-skipped",
            ].includes(game.phase)
              ? [...(game.firstDayDepartureSeats ?? []), seat]
              : game.firstDayDepartureSeats,
        }
      : {}),
    players: game.players.map((candidate) =>
      candidate.seat === seat ? { ...candidate, status } : candidate,
    ),
  };
};

export const isTerminalGamePhase = (phase: GameState["phase"]): boolean =>
  phase === "finished" || phase === "draw" || phase === "cancelled";

export const shouldSuggestDraw = (game: GameState): boolean =>
  !isFederationGame(game) &&
  !isTerminalGamePhase(game.phase) &&
  (game.cyclesWithoutElimination ?? 0) >= 3;

const assertRulingReason = (reason: string): void => {
  if (reason.length === 0 || reason !== reason.trim() || reason.length > 500) {
    throw new Error("A moderator ruling requires a trimmed reason of at most 500 characters");
  }
};

const terminalize = (game: GameState, phase: "draw" | "cancelled"): GameState => ({
  ...game,
  phase,
  turnOrder: [],
  currentTurnIndex: 0,
  nominations: [],
  voteAssignments: {},
  votingCancellation: undefined,
  votingRound: undefined,
  carCrashSeats: undefined,
  carCrashVotes: undefined,
  carCrashResult: undefined,
  goodbyeSeats: undefined,
  goodbyeNext: undefined,
  shotAssignments: {},
  checkResult: undefined,
  nightResult: undefined,
  dayNotice: undefined,
  redCardIssuedThisDay: undefined,
  bestMove: undefined,
  winner: null,
});

const assertNotTerminal = (game: GameState): void => {
  if (isTerminalGamePhase(game.phase))
    throw new Error("A terminal game cannot accept more actions");
};

/** Called only at the explicit planning/free-seating or shooting-night completion boundary. */
export const completeFederationGameNight = (game: GameState): GameState => {
  if (
    !isFederationGame(game) ||
    (game.phase !== "free-seating" && game.phase !== "night-resolution")
  )
    throw new Error("A federation night completion boundary is required");
  const completedGameNights = (game.completedGameNights ?? 0) + 1;
  const cyclesWithoutElimination = game.eliminationOccurredThisCycle
    ? 0
    : (game.cyclesWithoutElimination ?? 0) + 1;
  const next = {
    ...game,
    completedGameNights,
    cyclesWithoutElimination,
    eliminationOccurredThisCycle: false,
  };
  return cyclesWithoutElimination >= 3
    ? {
        ...terminalize(next, "draw"),
        ballot: undefined,
        rulesDrawReason: { rule: "6.5.6", completedGameNights, consecutiveUnchangedNights: 3 },
      }
    : next;
};

export const confirmDraw = (game: GameState, reason: string): GameState => {
  assertNotTerminal(game);
  if (game.day < 1) throw new Error("A draw requires active play");
  assertRulingReason(reason);
  return terminalize(game, "draw");
};

export const cancelGame = (game: GameState, reason: string): GameState => {
  assertNotTerminal(game);
  assertRulingReason(reason);
  return terminalize(game, "cancelled");
};

export const evaluateVictory = (players: readonly PlayerState[]): Winner => {
  const active = players.filter(({ status }) => status === "active");
  const black = active.filter(({ team }) => team === "black").length;
  const red = active.length - black;

  if (black === 0) {
    return "red";
  }
  if (black >= red) {
    return "black";
  }
  return null;
};
