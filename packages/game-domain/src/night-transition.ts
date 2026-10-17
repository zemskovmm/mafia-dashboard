import type { GameState } from "./types.js";
export const transitionToNight = (game: GameState): GameState => ({
  ...game,
  phase: "night-mafia",
  actualMultipleShotSeats: [],
  // Absence means no physical-shot ledger was recorded in this game yet.
  ...(Object.hasOwn(game, "shotObservations") ? { shotObservations: [] } : {}),
  ballot: undefined,
  currentSpeechRestricted: false,
  ballotCancellationDay:
    game.ballotCancellationDay !== undefined && game.ballotCancellationDay <= game.day
      ? undefined
      : game.ballotCancellationDay,
  nominations: [],
  voteAssignments: {},
  votingRound: undefined,
  carCrashSeats: undefined,
  carCrashVotes: undefined,
  carCrashResult: undefined,
  goodbyeSeats: undefined,
  goodbyeNext: undefined,
  shotAssignments: {},
  nightCheckEligibility: {
    don: game.players.some(({ role, status }) => role === "don" && status === "active"),
    sheriff: game.players.some(({ role, status }) => role === "sheriff" && status === "active"),
  },
  checkResult: undefined,
  nightResult: undefined,
  dayNotice: undefined,
  redCardIssuedThisDay: undefined,
  votingCancellation: undefined,
});
