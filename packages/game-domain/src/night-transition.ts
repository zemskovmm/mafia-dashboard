import { isFederationGame } from "./rules-edition.js";
import type { GameState } from "./types.js";

export const transitionToNight = (game: GameState): GameState => ({
  ...game,
  phase: "night-mafia",
  ...(isFederationGame(game)
    ? {
        actualMultipleShotSeats: [],
        // Do not inject a new default into old hashed snapshots/replays.
        ...(Object.hasOwn(game, "shotObservations") ? { shotObservations: [] } : {}),
        ballot: undefined,
        currentSpeechRestricted: false,
        ballotCancellationDay:
          game.ballotCancellationDay !== undefined && game.ballotCancellationDay <= game.day
            ? undefined
            : game.ballotCancellationDay,
      }
    : {}),
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
      ({ role, status }) =>
        role === "don" &&
        (status === "active" || (!isFederationGame(game) && status === "eliminated")),
    ),
    sheriff: game.players.some(
      ({ role, status }) =>
        role === "sheriff" &&
        (status === "active" || (!isFederationGame(game) && status === "eliminated")),
    ),
  },
  checkResult: undefined,
  nightResult: undefined,
  dayNotice: undefined,
  redCardIssuedThisDay: undefined,
  votingCancellation: undefined,
});
