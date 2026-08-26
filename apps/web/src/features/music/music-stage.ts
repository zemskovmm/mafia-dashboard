import type { GamePhase } from "@mafia/game-domain";
import type { MusicStage } from "./music-preferences.js";

export const musicStageForPhase = (phase: GamePhase): MusicStage | null => {
  switch (phase) {
    case "day":
    case "goodbye-speech":
    case "best-move":
      return "day";
    case "voting":
    case "voting-cancelled":
    case "car-crash":
    case "car-crash-decision":
    case "car-crash-result":
    case "car-crash-skipped":
      return "voting";
    case "mafia-planning":
    case "sheriff-wake":
    case "night-mafia":
    case "night-mafia-result":
    case "night-don":
    case "night-don-result":
    case "night-sheriff":
    case "night-sheriff-result":
    case "night-resolution":
      return "night";
    case "finished":
      return null;
  }

  const exhaustivePhase: never = phase;
  return exhaustivePhase;
};
