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
import type { GamePhase, GameState } from "@mafia/game-domain";
import { isGuessingState } from "./guessing-state.js";
import { isCriticalState } from "./critical-state.js";

let setup = beginRoleDraw(
  createSetup(
    Array.from({ length: 10 }, (_, i) => ({ id: `p-${i}`, name: `Player ${i}`, seat: i + 1 })),
  ),
  createSeededRandom(13),
);
for (let seat = 1; seat <= 10; seat += 1) setup = drawRoleForSeat(setup, seat);
const day = advanceSetupPhase(advanceSetupPhase(createGame(completeRoleDraw(setup))));
const balance = (citizens: number, mafia: number): GameState => {
  let red = 0;
  let black = 0;
  return {
    ...day,
    players: day.players.map((player) => ({
      ...player,
      status: (player.team === "red" ? red++ < citizens : black++ < mafia)
        ? "active"
        : "eliminated",
    })),
  };
};

describe("Guessing Game condition", () => {
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
    "night-mafia",
    "night-mafia-result",
    "night-don",
    "night-don-result",
    "night-sheriff",
    "night-sheriff-result",
    "night-resolution",
  ])("recognizes two citizens and one Mafia during %s without changing Critical", (phase) => {
    const game = { ...balance(2, 1), phase };
    expect(isGuessingState(game)).toBe(true);
    expect(isCriticalState(game)).toBe(true);
  });

  it.each([
    [3, 1],
    [4, 3],
    [1, 2],
    [3, 0],
    [1, 1],
    [0, 0],
  ])("rejects other balances: %i citizens, %i Mafia", (citizens, mafia) => {
    expect(isGuessingState(balance(citizens, mafia))).toBe(false);
  });

  it.each<GamePhase>(["mafia-planning", "sheriff-wake", "finished", "draw", "cancelled"])(
    "rejects %s",
    (phase) => {
      expect(isGuessingState({ ...balance(2, 1), phase })).toBe(false);
    },
  );

  it("counts a living Don as Mafia and excludes eliminated/red-carded players", () => {
    const game = balance(2, 1);
    const players = game.players.map((player) =>
      player.team === "black"
        ? {
            ...player,
            status: player.role === "don" ? ("active" as const) : ("red-carded" as const),
          }
        : player,
    );
    expect(isGuessingState({ ...game, players })).toBe(true);
    expect(isGuessingState({ ...game, winner: "red" })).toBe(false);
  });
});
