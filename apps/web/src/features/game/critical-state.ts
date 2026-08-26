import type { GamePhase, GameState } from "@mafia/game-domain";

const criticalPhases = new Set<GamePhase>([
  "day",
  "voting",
  "voting-cancelled",
  "car-crash",
  "car-crash-decision",
  "car-crash-result",
  "car-crash-skipped",
  "goodbye-speech",
  "best-move",
]);

export const isCriticalState = (game: GameState): boolean => {
  if (!criticalPhases.has(game.phase) || game.winner !== null) return false;
  const activeCitizens = game.players.filter(
    ({ team, status }) => team === "red" && status === "active",
  ).length;
  const activeMafia = game.players.filter(
    ({ team, status }) => team === "black" && status === "active",
  ).length;
  return activeMafia > 0 && activeCitizens === activeMafia + 1;
};
