import type { GamePhase, GameState } from "@mafia/game-domain";

const nonPlayingPhases = new Set<GamePhase>([
  "mafia-planning",
  "mafia-sleep",
  "don-identification",
  "sheriff-identification",
  "free-seating",
  "finished",
  "draw",
  "cancelled",
]);

export const isCriticalState = (game: GameState): boolean => {
  if (nonPlayingPhases.has(game.phase) || game.winner !== null) return false;
  const activeCitizens = game.players.filter(
    ({ team, status }) => team === "red" && status === "active",
  ).length;
  const activeMafia = game.players.filter(
    ({ team, status }) => team === "black" && status === "active",
  ).length;
  return activeMafia > 0 && activeCitizens === activeMafia + 1;
};
