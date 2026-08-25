import { describe, expect, it } from "vitest";
import { advanceSetupPhase, createGame, getCurrentTurnDuration } from "./game.js";
import { beginNight } from "./night-actions.js";
import {
  assignCarCrashVote,
  assignVote,
  advanceVotingCandidate,
  completeCurrentTurn,
  countVotes,
  issueFoul,
  getCurrentVotingCandidateSeat,
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

    game = nominate(game, 1, 4);
    game = completeCurrentTurn(game);
    game = nominate(game, 2, 6);
    game = completeCurrentTurn(game);

    expect(() => nominate(game, 3, 4)).toThrow(/already nominated/i);
    expect(game.nominations.map(({ candidateSeat }) => candidateSeat)).toEqual([4, 6]);
  });

  it("allows the current speaker to nominate themself", () => {
    const game = nominate(dayOne(), 1, 1);

    expect(game.nominations).toEqual([{ nominatorSeat: 1, candidateSeat: 1, order: 1 }]);
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

  it("treats a fourth foul as a red card and suppresses voting for that day", () => {
    let game = dayOne();
    const redCardSeat = game.players.find(
      ({ seat, team }) => seat !== 1 && seat !== 4 && team === "red",
    )!.seat;
    game = nominate(game, 1, 4);

    for (let foul = 0; foul < 4; foul += 1) game = issueFoul(game, redCardSeat);

    expect(game.players.find(({ seat }) => seat === redCardSeat)).toMatchObject({
      fouls: 4,
      status: "red-carded",
    });
    expect(game.redCardIssuedThisDay).toBe(true);
    while (game.phase === "day") game = completeCurrentTurn(game);
    expect(game).toMatchObject({
      phase: "voting-cancelled",
      votingCancellation: { reason: "red-card" },
    });
    expect(beginNight(game)).toMatchObject({ phase: "night-mafia", nominations: [] });
  });

  it("suppresses voting after any manual red card during the day", () => {
    let game = nominate(dayOne(), 1, 4);
    const redCardSeat = game.players.find(
      ({ seat, team }) => seat !== 1 && seat !== 4 && team === "red",
    )!.seat;

    game = redCard(game, redCardSeat);
    while (game.phase === "day") game = completeCurrentTurn(game);

    expect(game).toMatchObject({
      phase: "voting-cancelled",
      votingCancellation: { reason: "red-card" },
    });
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

  it("allows night exclusions outside Mafia shooting and skips an excluded private role", () => {
    const day = dayOne();
    const donSeat = day.players.find(({ role }) => role === "don")!.seat;
    const night: GameState = { ...day, phase: "night-don" };

    const excluded = redCard(night, donSeat);

    expect(excluded.players.find(({ seat }) => seat === donSeat)?.status).toBe("red-carded");
    expect(excluded.phase).toBe("night-sheriff");
  });

  it("accepts red cards in every active gameplay phase from day one", () => {
    const phases: readonly GameState["phase"][] = [
      "day",
      "voting",
      "voting-cancelled",
      "car-crash",
      "car-crash-decision",
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
    ];

    for (const phase of phases) {
      const game = dayOne();
      const target = game.players.find(({ role }) => role === "citizen")!;
      const excluded = redCard({ ...game, phase }, target.seat);

      expect(excluded.players.find(({ seat }) => seat === target.seat)?.status, phase).toBe(
        "red-carded",
      );
    }
  });

  it("cancels an in-progress voting sequence when a player gets a red card", () => {
    const phases: readonly GameState["phase"][] = [
      "voting",
      "car-crash",
      "car-crash-decision",
      "car-crash-skipped",
    ];

    for (const phase of phases) {
      const game = dayOne();
      const target = game.players.find(({ role }) => role === "citizen")!;
      const excluded = redCard(
        {
          ...game,
          phase,
          nominations: [{ nominatorSeat: 1, candidateSeat: target.seat, order: 1 }],
          turnOrder: [target.seat],
          carCrashSeats: [target.seat, 10],
        },
        target.seat,
      );

      expect(excluded, phase).toMatchObject({
        phase: "voting-cancelled",
        votingCancellation: { reason: "red-card" },
        turnOrder: [target.seat],
      });
    }
  });

  it("keeps a one-person voting screen and assigns every active vote", () => {
    let game = nominate(dayOne(), 1, 4);

    while (game.phase === "day") game = completeCurrentTurn(game);

    expect(game.phase).toBe("voting");
    expect(game.players.find(({ seat }) => seat === 4)?.status).toBe("active");
    expect(game.turnOrder).toEqual([4]);
    expect(Object.values(game.voteAssignments)).toEqual(Array.from({ length: 10 }, () => 4));
  });

  it("removes a red-carded nominee instead of entering an unresolvable vote", () => {
    let game = nominate(dayOne(), 1, 4);
    game = redCard(game, 4);

    while (game.phase === "day") game = completeCurrentTurn(game);

    expect(game.phase).toBe("voting-cancelled");
    expect(game.votingCancellation).toEqual({ reason: "red-card" });
    expect(game.nominations).toEqual([]);
  });

  it("assigns each eligible voter once and derives totals", () => {
    let game = dayOne();
    game = nominate(game, 1, 4);
    game = completeCurrentTurn(game);
    game = nominate(game, 2, 6);
    game = startVoting(game);

    expect(game.turnOrder).toEqual([4, 6]);
    expect(getCurrentVotingCandidateSeat(game)).toBe(4);
    game = assignVote(game, 1, 4);
    game = assignVote(game, 4, 4);
    expect(game.voteAssignments[4]).toBe(4);
    expect(() => assignVote(game, 1, 6)).toThrow(/already voted/i);
    expect(() => assignVote(game, 2, 6)).toThrow(/current voting candidate/i);

    for (const seat of [2, 3, 5, 6, 7]) {
      game = assignVote(game, seat, 4);
    }
    game = advanceVotingCandidate(game);
    expect(getCurrentVotingCandidateSeat(game)).toBe(6);
    expect(game.voteAssignments).toMatchObject({ 8: 6, 9: 6, 10: 6 });

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
    game = advanceVotingCandidate(game);

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
    game = { ...startVoting(game), votingRound: "repeat", carCrashSeats: [4, 6] };

    for (const seat of [1, 2, 3, 4, 5]) game = assignVote(game, seat, 4);
    game = advanceVotingCandidate(game);

    expect(resolveVote(game)).toEqual({
      kind: "eliminate-both-vote",
      seats: [4, 6],
      totals: { 4: 5, 6: 5 },
    });
  });

  it("skips the eliminate-all ballot when every active player is tied", () => {
    const base = dayOne();
    const activeSeats = base.players
      .filter(({ status }) => status === "active")
      .map(({ seat }) => seat);
    const game: GameState = {
      ...base,
      phase: "voting",
      nominations: activeSeats.map((seat, index) => ({
        nominatorSeat: seat,
        candidateSeat: seat,
        order: index + 1,
      })),
      turnOrder: activeSeats,
      currentTurnIndex: activeSeats.length - 1,
      votingRound: "repeat",
      carCrashSeats: activeSeats,
      voteAssignments: Object.fromEntries(activeSeats.map((seat) => [seat, seat])),
    };

    expect(resolveVote(game)).toEqual({
      kind: "eliminate-all-skipped",
      seats: activeSeats,
      totals: Object.fromEntries(activeSeats.map((seat) => [seat, 1])),
    });
  });

  it("runs another car crash when a repeated tie shrinks to a smaller subset", () => {
    const game: GameState = {
      ...dayOne(),
      phase: "voting",
      nominations: [
        { nominatorSeat: 1, candidateSeat: 4, order: 1 },
        { nominatorSeat: 2, candidateSeat: 6, order: 2 },
        { nominatorSeat: 3, candidateSeat: 8, order: 3 },
      ],
      turnOrder: [4, 6, 8],
      currentTurnIndex: 2,
      votingRound: "repeat",
      carCrashSeats: [4, 6, 8],
      voteAssignments: Object.fromEntries(
        Array.from({ length: 10 }, (_, index) => [index + 1, index < 5 ? 4 : 6]),
      ),
    };

    expect(resolveVote(game)).toEqual({
      kind: "car-crash",
      seats: [4, 6],
      totals: { 4: 5, 6: 5, 8: 0 },
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

  it("rejects aliased voter keys and votes for non-nominees", () => {
    const voting = (): GameState => ({
      ...dayOne(),
      phase: "voting",
      nominations: [
        { nominatorSeat: 1, candidateSeat: 4, order: 1 },
        { nominatorSeat: 2, candidateSeat: 6, order: 2 },
      ],
      turnOrder: [4, 6],
      currentTurnIndex: 1,
      votingRound: "initial",
      voteAssignments: Object.fromEntries(
        Array.from({ length: 10 }, (_, index) => [index + 1, index < 5 ? 4 : 6]),
      ),
    });

    const aliasedAssignments = { ...voting().voteAssignments } as Record<string, number>;
    delete aliasedAssignments["1"];
    aliasedAssignments["01"] = 4;
    expect(() =>
      resolveVote({
        ...voting(),
        voteAssignments: aliasedAssignments as unknown as GameState["voteAssignments"],
      }),
    ).toThrow(/canonical seat numbers/i);

    expect(() =>
      resolveVote({
        ...voting(),
        voteAssignments: { ...voting().voteAssignments, 1: 9 },
      }),
    ).toThrow(/nominated player/i);
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

    expect(() => resolveCarCrashVote(decision())).toThrow(/every eligible player/i);
    const aliasedDecision = fillDecision(5);
    const aliasedVotes = { ...aliasedDecision.carCrashVotes } as Record<string, boolean>;
    delete aliasedVotes["1"];
    aliasedVotes["01"] = true;
    expect(() =>
      resolveCarCrashVote({
        ...aliasedDecision,
        carCrashVotes: aliasedVotes as unknown as GameState["carCrashVotes"],
      }),
    ).toThrow(/canonical seat numbers/i);
    expect(resolveCarCrashVote(fillDecision(5)).eliminate).toBe(false);
    expect(resolveCarCrashVote(fillDecision(6))).toMatchObject({
      eliminate: true,
      seats: [4, 6],
      yesVotes: 6,
      eligibleVoters: 10,
    });
  });
});
