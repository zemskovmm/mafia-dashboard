import { describe, expect, it } from "vitest";
import { advanceSetupPhase, createGame, getCurrentTurnDuration } from "./game.js";
import {
  assignVote,
  completeCurrentTurn,
  countVotes,
  issueFoul,
  nominate,
  redCard,
  resolveVote,
  startVoting,
} from "./day-actions.js";
import {
  beginRoleDraw,
  completeRoleDraw,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
} from "./setup.js";
import type { GameState, PlayerInput, SetupState } from "./types.js";

const players = (): PlayerInput[] =>
  Array.from({ length: 10 }, (_, index) => ({
    id: `player-${index + 1}`,
    name: `Player ${index + 1}`,
    seat: index + 1,
  }));

const completedSetup = (): SetupState => {
  let setup = beginRoleDraw(createSetup(players()), createSeededRandom(5));
  for (let seat = 1; seat <= 10; seat += 1) {
    setup = drawRoleForSeat(setup, seat);
  }
  return completeRoleDraw(setup);
};

const dayOne = (): GameState => advanceSetupPhase(advanceSetupPhase(createGame(completedSetup())));

describe("day actions", () => {
  it("accepts nominations only from the current speaker and preserves unique candidate order", () => {
    let game = dayOne();

    expect(() => nominate(game, 2, 4)).toThrow(/current speaker/i);
    expect(() => nominate(game, 1, 1)).toThrow(/another active player/i);

    game = nominate(game, 1, 4);
    game = completeCurrentTurn(game);
    game = nominate(game, 2, 6);
    game = completeCurrentTurn(game);

    expect(() => nominate(game, 3, 4)).toThrow(/already nominated/i);
    expect(game.nominations.map(({ candidateSeat }) => candidateSeat)).toEqual([4, 6]);
  });

  it("turns the next normal turn into one 10-second nomination-only turn after three fouls", () => {
    let game = dayOne();
    game = issueFoul(issueFoul(issueFoul(game, 2), 2), 2);
    expect(game.players.find(({ seat }) => seat === 2)?.mutePending).toBe(true);

    game = completeCurrentTurn(game);
    expect(game.turnOrder[game.currentTurnIndex]).toBe(2);
    expect(getCurrentTurnDuration(game)).toBe(10);

    game = completeCurrentTurn(game);
    expect(game.players.find(({ seat }) => seat === 2)?.mutePending).toBe(false);
    expect(game.turnOrder[game.currentTurnIndex]).toBe(3);
  });

  it("red-cards an active player immediately and evaluates victory", () => {
    let game = dayOne();
    const blackSeats = game.players.filter(({ team }) => team === "black").map(({ seat }) => seat);

    for (const seat of blackSeats) {
      game = redCard(game, seat);
    }

    expect(game.winner).toBe("red");
    expect(game.phase).toBe("finished");
    expect(game.players.filter(({ status }) => status === "red-carded")).toHaveLength(3);
  });

  it("advances immediately when the current speaker receives a red card", () => {
    const game = redCard(dayOne(), 1);

    expect(game.phase).toBe("day");
    expect(game.turnOrder).not.toContain(1);
    expect(game.turnOrder[game.currentTurnIndex]).toBe(2);
    expect(() => getCurrentTurnDuration(game)).not.toThrow();
  });

  it("skips a future speaker who received a red card", () => {
    let game = redCard(dayOne(), 2);

    expect(game.turnOrder).not.toContain(2);
    game = completeCurrentTurn(game);
    expect(game.turnOrder[game.currentTurnIndex]).toBe(3);
  });

  it("assigns each eligible voter once and derives totals", () => {
    let game = dayOne();
    game = nominate(game, 1, 4);
    game = completeCurrentTurn(game);
    game = nominate(game, 2, 6);
    game = startVoting(game);

    game = assignVote(game, 1, 4);
    expect(() => assignVote(game, 1, 6)).toThrow(/already voted/i);

    for (const seat of [2, 3, 4, 5, 6, 7]) {
      game = assignVote(game, seat, 4);
    }
    for (const seat of [8, 9, 10]) {
      game = assignVote(game, seat, 6);
    }

    expect(countVotes(game)).toEqual({ 4: 7, 6: 3 });
    expect(resolveVote(game)).toEqual({ kind: "winner", seats: [4], totals: { 4: 7, 6: 3 } });
  });

  it("represents a tied vote without choosing a random winner", () => {
    let game = dayOne();
    game = nominate(game, 1, 4);
    game = completeCurrentTurn(game);
    game = nominate(game, 2, 6);
    game = startVoting(game);

    for (const seat of [1, 2, 3, 4, 5]) {
      game = assignVote(game, seat, 4);
    }
    for (const seat of [6, 7, 8, 9, 10]) {
      game = assignVote(game, seat, 6);
    }

    expect(resolveVote(game)).toEqual({ kind: "tie", seats: [4, 6], totals: { 4: 5, 6: 5 } });
  });
});
