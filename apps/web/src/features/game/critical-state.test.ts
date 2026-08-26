import { describe, expect, it } from "vitest";
import {
  advanceSetupPhase,
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
} from "@mafia/game-domain";
import type { GamePhase, GameState, PlayerInput } from "@mafia/game-domain";
import { isCriticalState } from "./critical-state.js";

const createDayGame = (): GameState => {
  const players: PlayerInput[] = Array.from({ length: 10 }, (_, index) => ({
    id: `player-${index + 1}`,
    name: `Player ${index + 1}`,
    seat: index + 1,
  }));
  let setup = beginRoleDraw(createSetup(players), createSeededRandom(13));
  for (let seat = 1; seat <= 10; seat += 1) setup = drawRoleForSeat(setup, seat);
  return advanceSetupPhase(advanceSetupPhase(createGame(completeRoleDraw(setup))));
};

const withActiveCounts = (
  game: GameState,
  activeCitizens: number,
  activeMafia: number,
  phase: GamePhase = "day",
): GameState => {
  let citizens = 0;
  let mafia = 0;
  return {
    ...game,
    phase,
    players: game.players.map((player) => {
      const active = player.team === "red" ? citizens++ < activeCitizens : mafia++ < activeMafia;
      return { ...player, status: active ? "active" : "eliminated" };
    }),
  };
};

describe("critical state", () => {
  const day = createDayGame();

  it("fires only when one more civilian death would meet the Mafia victory threshold", () => {
    expect(isCriticalState(withActiveCounts(day, 4, 3))).toBe(true);
    expect(isCriticalState(withActiveCounts(day, 5, 3))).toBe(false);
    expect(isCriticalState(withActiveCounts(day, 3, 3))).toBe(false);
    expect(isCriticalState(withActiveCounts(day, 1, 0))).toBe(false);
  });

  it.each<GamePhase>([
    "day",
    "voting",
    "voting-cancelled",
    "car-crash",
    "car-crash-decision",
    "car-crash-result",
    "car-crash-skipped",
    "goodbye-speech",
    "best-move",
  ])("applies during daytime phase %s", (phase) => {
    expect(isCriticalState(withActiveCounts(day, 4, 3, phase))).toBe(true);
  });

  it.each<GamePhase>([
    "mafia-planning",
    "sheriff-wake",
    "night-mafia",
    "night-mafia-result",
    "night-don",
    "night-don-result",
    "night-sheriff",
    "night-sheriff-result",
    "night-resolution",
    "finished",
  ])("does not expose team balance during phase %s", (phase) => {
    expect(isCriticalState(withActiveCounts(day, 4, 3, phase))).toBe(false);
  });
});
