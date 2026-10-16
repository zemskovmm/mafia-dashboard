import type { GamePhase, GameState, RemovalOccurrenceStage } from "@mafia/game-domain";

// Permitted observed boundaries; the shortcut supplies a current-screen default for confirmation.
export const removalStagesForPhase = (phase: GamePhase): readonly RemovalOccurrenceStage[] => {
  switch (phase) {
    case "mafia-planning":
    case "mafia-sleep":
    case "don-identification":
    case "sheriff-identification":
    case "free-seating":
      return ["agreement"];
    case "night-mafia":
      return ["before-shooting-count", "shooting-count", "after-voting-result"];
    case "night-mafia-result":
      return ["after-shooting-result"];
    case "night-don":
    case "night-don-result":
      return ["don-check"];
    case "night-sheriff":
    case "night-sheriff-result":
      return ["sheriff-check"];
    case "day":
      return ["day-discussion"];
    case "voting":
    case "car-crash":
    case "car-crash-decision":
    case "voting-cancelled":
      return ["open-voting"];
    case "car-crash-result":
    case "car-crash-skipped":
      return ["after-voting-result"];
    case "goodbye-speech":
      return ["after-voting-result", "farewell"];
    case "best-move":
    case "night-resolution":
      return ["farewell"];
    default:
      return [];
  }
};
export const defaultRemovalStage = (phase: GamePhase): RemovalOccurrenceStage | "" =>
  phase === "night-mafia"
    ? "shooting-count"
    : phase === "goodbye-speech"
      ? "farewell"
      : (removalStagesForPhase(phase)[0] ?? "");

export const hasImmediateRemovalAnnouncement = (game: GameState): boolean =>
  game.disciplinaryRemovals?.some(
    (removal) =>
      removal.announcement === "pending" &&
      !["shooting-count", "don-check", "sheriff-check"].includes(removal.stage),
  ) ?? false;
