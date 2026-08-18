import { describe, expect, it } from "vitest";
import {
  advanceSetupPhase,
  createGame,
  evaluateVictory,
  getDayOrder,
  getRoleTeam,
  markPlayerInactive,
} from "./game.js";
import {
  beginRoleDraw,
  completeRoleDraw,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
} from "./setup.js";
import type { PlayerInput, SetupState } from "./types.js";

const players = (): PlayerInput[] =>
  Array.from({ length: 10 }, (_, index) => ({
    id: `player-${index + 1}`,
    name: `Player ${index + 1}`,
    seat: index + 1,
  }));

const completedSetup = (): SetupState => {
  let setup = beginRoleDraw(createSetup(players()), createSeededRandom(31));
  for (let seat = 1; seat <= 10; seat += 1) {
    setup = drawRoleForSeat(setup, seat);
  }
  return completeRoleDraw(setup);
};

describe("game phases and victory", () => {
  it("advances through negotiation and Sheriff wake-up into day one", () => {
    const game = createGame(completedSetup());
    expect(game.phase).toBe("mafia-negotiation");

    const sheriffWake = advanceSetupPhase(game);
    expect(sheriffWake.phase).toBe("sheriff-wake");

    const day = advanceSetupPhase(sheriffWake);
    expect(day.phase).toBe("day");
    expect(day.day).toBe(1);
    expect(day.turnOrder).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(() => advanceSetupPhase(day)).toThrow(/cannot advance setup/i);
  });

  it("rotates the daily starting seat and skips inactive players", () => {
    const game = createGame(completedSetup());
    const withInactive = markPlayerInactive(
      markPlayerInactive(game, 2, "eliminated"),
      7,
      "red-carded",
    );

    expect(getDayOrder(withInactive.players, 1)).toEqual([1, 3, 4, 5, 6, 8, 9, 10]);
    expect(getDayOrder(withInactive.players, 2)).toEqual([3, 4, 5, 6, 8, 9, 10, 1]);
    expect(getDayOrder(withInactive.players, 3)).toEqual([3, 4, 5, 6, 8, 9, 10, 1]);
    expect(getDayOrder(withInactive.players, 10)).toEqual([10, 1, 3, 4, 5, 6, 8, 9]);
    expect(getDayOrder(withInactive.players, 11)).toEqual([1, 3, 4, 5, 6, 8, 9, 10]);
  });

  it("maps Sheriff and Citizens to red and Mafia and Don to black", () => {
    expect(getRoleTeam("sheriff")).toBe("red");
    expect(getRoleTeam("citizen")).toBe("red");
    expect(getRoleTeam("mafia")).toBe("black");
    expect(getRoleTeam("don")).toBe("black");
  });

  it("declares red victory when no active black players remain", () => {
    let game = createGame(completedSetup());
    const blackSeats = game.players.filter(({ team }) => team === "black").map(({ seat }) => seat);

    for (const seat of blackSeats) {
      game = markPlayerInactive(game, seat, "eliminated");
    }

    expect(evaluateVictory(game.players)).toBe("red");
  });

  it("declares black victory at parity and otherwise continues", () => {
    let game = createGame(completedSetup());
    expect(evaluateVictory(game.players)).toBeNull();

    const redSeats = game.players.filter(({ team }) => team === "red").map(({ seat }) => seat);
    for (const seat of redSeats.slice(0, 4)) {
      game = markPlayerInactive(game, seat, "eliminated");
    }

    expect(evaluateVictory(game.players)).toBe("black");
  });
});
