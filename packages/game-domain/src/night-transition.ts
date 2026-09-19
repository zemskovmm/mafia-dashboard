import type { GameState } from "./types.js";

export const transitionToNight = (game: GameState): GameState => ({
  ...game,
  phase: "night-mafia",
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
    don: game.players.some(
      ({ role, status }) => role === "don" && (status === "active" || status === "eliminated"),
    ),
    sheriff: game.players.some(
      ({ role, status }) => role === "sheriff" && (status === "active" || status === "eliminated"),
    ),
  },
  checkResult: undefined,
  nightResult: undefined,
  dayNotice: undefined,
  redCardIssuedThisDay: undefined,
  votingCancellation: undefined,
});
