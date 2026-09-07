import { isTerminalGamePhase, type GameState } from "@mafia/game-domain";
import { isCriticalState } from "./critical-state.js";

export const isGuessingState = (game: GameState): boolean =>
  !isTerminalGamePhase(game.phase) &&
  isCriticalState(game) &&
  game.players.filter(({ status }) => status === "active").length === 3;
