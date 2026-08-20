import { describe, expect, it } from "vitest";
import { advanceSetupPhase, createGame, getCurrentTurnDuration } from "./game.js";
import {
  assignCarCrashVote,
  assignVote,
  completeCurrentTurn,
  countVotes,
  issueFoul,
  nominate,
  redCard,
  resolveVote,
  resolveCarCrashVote,
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

  it("rejects red cards outside ordinary day speeches", () => {
    const game: GameState = {
      ...dayOne(),
      phase: "car-crash",
      turnOrder: [4, 6],
      currentTurnIndex: 0,
      nominations: [
        { nominatorSeat: 1, candidateSeat: 4, order: 1 },
        { nominatorSeat: 2, candidateSeat: 6, order: 2 },
      ],
      votingRound: "repeat",
      carCrashSeats: [4, 6],
      carCrashVotes: {},
    };

    expect(() => redCard(game, 4)).toThrow("Red cards are only accepted during the day");
  });

  it("skips first-day voting when only one active nominee remains", () => {
    let game = nominate(dayOne(), 1, 4);

    while (game.phase === "day") game = completeCurrentTurn(game);

    expect(game.phase).toBe("night-mafia");
    expect(game.players.find(({ seat }) => seat === 4)?.status).toBe("active");
    expect(game.nominations).toEqual([]);
  });

  it("removes a red-carded nominee instead of entering an unresolvable vote", () => {
    let game = nominate(dayOne(), 1, 4);
    game = redCard(game, 4);

    while (game.phase === "day") game = completeCurrentTurn(game);

    expect(game.phase).toBe("night-mafia");
    expect(game.nominations).toEqual([]);
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

  it("starts a car crash after two nominees tie on the first vote", () => {
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

    expect(resolveVote(game)).toEqual({
      kind: "car-crash",
      seats: [4, 6],
      totals: { 4: 5, 6: 5 },
    });
  });

  it("requests an eliminate-both ballot when the car-crash revote ties again", () => {
    let game = dayOne();
    game = nominate(game, 1, 4);
    game = completeCurrentTurn(game);
    game = nominate(game, 2, 6);
    game = { ...startVoting(game), votingRound: "repeat" };

    for (const seat of [1, 2, 3, 4, 5]) game = assignVote(game, seat, 4);
    for (const seat of [6, 7, 8, 9, 10]) game = assignVote(game, seat, 6);

    expect(resolveVote(game)).toEqual({
      kind: "eliminate-both-vote",
      seats: [4, 6],
      totals: { 4: 5, 6: 5 },
    });
  });

  it("gives tied nominees 30-second turns before a clean revote", () => {
    let game: GameState = {
      ...dayOne(),
      phase: "car-crash",
      turnOrder: [4, 6],
      currentTurnIndex: 0,
      nominations: [
        { nominatorSeat: 1, candidateSeat: 4, order: 1 },
        { nominatorSeat: 2, candidateSeat: 6, order: 2 },
      ],
      voteAssignments: {},
      votingRound: "repeat",
      carCrashSeats: [4, 6],
      carCrashVotes: {},
    };

    expect(getCurrentTurnDuration(game)).toBe(30);
    game = completeCurrentTurn(game);
    expect(game.turnOrder[game.currentTurnIndex]).toBe(6);
    expect(getCurrentTurnDuration(game)).toBe(30);

    game = completeCurrentTurn(game);
    expect(game.phase).toBe("voting");
    expect(game.votingRound).toBe("repeat");
    expect(game.voteAssignments).toEqual({});
  });

  it("rejects aliased car-crash voter keys", () => {
    const game: GameState = {
      ...dayOne(),
      phase: "car-crash-decision",
      carCrashSeats: [4, 6],
      carCrashVotes: {
        "1": true,
        "01": false,
        "2": false,
        "3": false,
        "4": false,
        "5": false,
        "6": false,
        "7": false,
        "8": false,
        "9": false,
      } as unknown as NonNullable<GameState["carCrashVotes"]>,
    };

    expect(() => resolveCarCrashVote(game)).toThrow(
      "Car-crash vote keys must use canonical seat numbers",
    );
  });

  it("eliminates tied nominees only when more than half vote for it", () => {
    const decision = (): GameState => ({
      ...dayOne(),
      phase: "car-crash-decision",
      carCrashSeats: [4, 6],
      carCrashVotes: {},
    });
    const fillDecision = (yesVotes: number): GameState => {
      let game = decision();
      for (let seat = 1; seat <= 10; seat += 1) {
        game = assignCarCrashVote(game, seat, seat <= yesVotes);
      }
      return game;
    };

    expect(resolveCarCrashVote(fillDecision(5)).eliminate).toBe(false);
    expect(resolveCarCrashVote(fillDecision(6))).toMatchObject({
      eliminate: true,
      seats: [4, 6],
      yesVotes: 6,
      eligibleVoters: 10,
    });
  });
});
