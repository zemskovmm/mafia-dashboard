import { describe, expect, it } from "vitest";
import {
  advanceSetupPhase,
  cancelGame,
  confirmDraw,
  createGame,
  evaluateVictory,
  getDayOrder,
  getRoleTeam,
  markPlayerInactive,
  shouldSuggestDraw,
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
  it("initializes draw-cycle tracking without suggesting a draw", () => {
    const game = createGame(completedSetup());

    expect(game.cyclesWithoutElimination).toBe(0);
    expect(game.eliminationOccurredThisCycle).toBe(false);
    expect(shouldSuggestDraw(game)).toBe(false);
  });

  it("requires explained draw and cancellation rulings and makes them terminal", () => {
    const active = {
      ...advanceSetupPhase(advanceSetupPhase(createGame(completedSetup()))),
      cyclesWithoutElimination: 3,
    };
    const drawn = confirmDraw(active, "Three quiet cycles");

    expect(drawn).toMatchObject({
      phase: "draw",
      winner: null,
    });
    expect(shouldSuggestDraw(active)).toBe(true);
    expect(shouldSuggestDraw(drawn)).toBe(false);
    expect(cancelGame(active, "Venue closed")).toMatchObject({
      phase: "cancelled",
      winner: null,
    });
    expect(() => confirmDraw(active, "   ")).toThrow(/reason/i);
    expect(() => cancelGame(active, "")).toThrow(/reason/i);
    expect(() => cancelGame(confirmDraw(active, "Agreed draw"), "Changed mind")).toThrow(
      /terminal/i,
    );
  });

  it("snapshots the Best move rule and defaults it on", () => {
    expect(createGame(completedSetup()).bestMoveEnabled).toBe(true);
    expect(createGame(completedSetup(), { bestMoveEnabled: false }).bestMoveEnabled).toBe(false);

    const clubRules = { bestMoveEnabled: false };
    const active = createGame(completedSetup(), clubRules);
    clubRules.bestMoveEnabled = true;
    expect(active.bestMoveEnabled).toBe(false);
    expect({ ...active, phase: "finished" as const, winner: "red" as const }.bestMoveEnabled).toBe(
      false,
    );
  });

  it("advances through negotiation and Sheriff wake-up into day one", () => {
    const game = createGame(completedSetup());
    expect(game.phase).toBe("mafia-planning");

    const sheriffWake = advanceSetupPhase(game);
    expect(sheriffWake.phase).toBe("sheriff-wake");

    const day = advanceSetupPhase(sheriffWake);
    expect(day.phase).toBe("day");
    expect(day.day).toBe(1);
    expect(day.turnOrder).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(() => advanceSetupPhase(day)).toThrow(/cannot advance setup/i);
  });

  it("orders active players clockwise from a requested seat", () => {
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
