import { describe, expect, it } from "vitest";
import fixture from "./fixtures/current-replays.json";
import * as domain from "./index.js";
import type {
  CanonicalGameEventDraft,
  GameLogEntry,
  GameState,
  InitialGameBaseline,
} from "./index.js";

const create = (): GameState => {
  let setup = domain.beginRoleDraw(
    domain.createSetup(Array.from({ length: 10 }, (_, i) => ({ id: `p${i + 1}`, seat: i + 1 }))),
    domain.createSeededRandom(71),
  );
  for (let seat = 1; seat <= 10; seat++) setup = domain.drawRoleForSeat(setup, seat);
  return domain.createGame(domain.completeRoleDraw(setup));
};
const day = (): GameState => domain.advanceOpeningPhase(domain.advanceOpeningPhase(create()));
const remove = (seat: number, reason = "other"): CanonicalGameEventDraft =>
  ({ type: "player.manually-removed", payload: { seat, reason } }) as CanonicalGameEventDraft;
const phase = (to: GameState["phase"]): CanonicalGameEventDraft => ({
  type: "phase.changed",
  payload: { to },
});
const history = (initial: GameState) => {
  let game = initial;
  const baseline = domain.createInitialGameBaseline(game);
  const entries: GameLogEntry[] = [];
  const accept = (draft: CanonicalGameEventDraft) => {
    const next = domain.createGameLogEntry({
      gameId: "manual-removal",
      id: `e${entries.length + 1}`,
      sequence: entries.length + 1,
      parentEventId: entries.at(-1)?.id ?? null,
      createdAt: "2026-11-12T16:00:00Z",
      before: game,
      draft,
    });
    entries.push(next.entry);
    game = next.after;
    expect(
      domain.replayGameLog(
        JSON.parse(JSON.stringify(baseline)),
        JSON.parse(JSON.stringify(entries)),
      ).game,
    ).toEqual(JSON.parse(JSON.stringify(game)));
    expect(
      domain.replayGameLog(domain.createInitialGameBaseline(JSON.parse(JSON.stringify(game))), [])
        .game,
    ).toEqual(JSON.parse(JSON.stringify(game)));
    return game;
  };
  accept({ type: "game.checkpointed", payload: {} });
  return {
    get game() {
      return game;
    },
    baseline,
    entries,
    accept,
  };
};
const ballot = (initial = day()): GameState => {
  let game = initial;
  for (const seat of [1, 2, 3])
    game = domain.applyGameEvent(game, {
      type: "player.nominated",
      payload: { nominatorSeat: seat, candidateSeat: seat },
    });
  return domain.applyGameEvent(game, phase("voting"));
};
const population = (game: GameState, red: number, black: number): GameState => {
  const retained = [
    ...game.players.filter((p) => p.team === "red").slice(0, red),
    ...game.players.filter((p) => p.team === "black").slice(0, black),
  ].map((p) => p.seat);
  const players = game.players.map((p) =>
    retained.includes(p.seat)
      ? p
      : {
          ...p,
          status: "eliminated" as const,
        },
  );
  return { ...game, players, turnOrder: domain.getDayOrder(players, 1), currentTurnIndex: 0 };
};

describe("non-disciplinary manual removal", () => {
  it.each(["voted-out", "mafia-kill", "other"] as const)(
    "records %s publicly, skips farewell and preserves foul/mute and unrelated state",
    (reason) => {
      const original = day();
      const initial = {
        ...original,
        players: original.players.map((p) =>
          p.seat === 1 ? { ...p, fouls: 3, mutePending: true } : p,
        ),
        currentSpeechRestricted: true,
      };
      const before = JSON.stringify(initial);
      const h = history(initial);
      const result = h.accept(remove(1, reason));
      expect(result.phase).toBe("day");
      expect(result.players.find((p) => p.seat === 1)).toEqual({
        ...initial.players[0],
        status: "eliminated",
      });
      expect(result.manualRemovals).toEqual([{ seat: 1, reason }]);
      expect(result.firstDayDepartureSeats).toEqual([1]);
      expect(result.turnOrder[result.currentTurnIndex]).toBe(2);
      expect(result.currentSpeechRestricted).toBe(false);
      expect(result.disciplinaryRemovals).toBeUndefined();
      expect(result.ballotCancellationDay).toBeUndefined();
      expect(result.redCardIssuedThisDay).toBeUndefined();
      expect(result.votingCancellation).toBeUndefined();
      expect(result.goodbyeSeats).toBeUndefined();
      expect(result.bestMove).toBeUndefined();
      expect(JSON.stringify(initial)).toBe(before);
      expect(domain.manuallyRemovePlayer(initial, { seat: 1, reason })).toEqual(result);
      expect(domain.isCanonicalGameEventType("player.manually-removed")).toBe(true);
      expect(domain.isSecretGameEventType("player.manually-removed")).toBe(false);
      expect(h.entries.at(-1)?.payload).toEqual({ seat: 1, reason });
      h.accept({ type: "turn.completed", payload: { seat: 2 } });
      expect(h.game.phase).toBe("day");
    },
  );

  it("rejects unknown/repeated/inactive subjects, invalid reasons and terminal actions", () => {
    const initial = day();
    const removed = domain.applyGameEvent(initial, remove(1));
    for (const seat of [0, 11, 1.5, NaN])
      expect(domain.tryApplyGameEvent(initial, remove(seat)).ok).toBe(false);
    expect(domain.tryApplyGameEvent(removed, remove(1)).ok).toBe(false);
    for (const reason of ["left-voluntarily", "Voted out", "", "other ", "red-card"])
      expect(domain.tryApplyGameEvent(initial, remove(1, reason)).ok).toBe(false);
    for (const terminal of [
      domain.cancelGame(initial, "Cancelled"),
      domain.confirmDraw(initial, "Draw"),
      { ...initial, phase: "finished" as const, winner: "red" as const },
    ])
      expect(domain.tryApplyGameEvent(terminal, remove(1)).ok).toBe(false);
    expect(
      domain.tryApplyGameEvent(
        {
          ...initial,
          players: initial.players.map((p) => (p.seat === 1 ? { ...p, status: "eliminated" } : p)),
        },
        remove(1),
      ).ok,
    ).toBe(false);
  });

  it("admits only exact unique known inactive removal metadata", () => {
    const initial = domain.applyGameEvent(day(), remove(1));
    for (const manualRemovals of [
      null,
      {},
      [{ seat: 1, reason: "other", role: "citizen" }],
      [{ seat: 1, reason: "left-voluntarily" }],
      [{ seat: 11, reason: "other" }],
      [{ seat: 2, reason: "other" }],
      [
        { seat: 1, reason: "other" },
        { seat: 1, reason: "mafia-kill" },
      ],
    ])
      expect(() =>
        domain.createInitialGameBaseline({ ...initial, manualRemovals } as GameState),
      ).toThrow();
    expect(() =>
      domain.assertCanonicalGameEventDraft({
        type: "player.manually-removed",
        payload: { seat: 1, reason: "other", rule: "6.2.3" },
      }),
    ).toThrow();
    expect(() =>
      domain.assertCanonicalGameEventDraft({
        type: "player.manually-removed",
        payload: { seat: 1 },
      }),
    ).toThrow();
  });

  it("does not repeat or rewind discussion and keeps prior nomination/support attribution", () => {
    const original = day();
    const initial: GameState = {
      ...original,
      currentTurnIndex: 4,
      nominations: [
        { nominatorSeat: 1, candidateSeat: 7, order: 1, supporterSeats: [2, 3] },
        { nominatorSeat: 4, candidateSeat: 2, order: 2 },
      ],
    };
    const h = history(initial);
    h.accept(remove(2));
    expect(h.game.turnOrder[h.game.currentTurnIndex]).toBe(5);
    expect(h.game.nominations).toEqual([initial.nominations[0]]);
    h.accept(remove(5));
    expect(h.game.turnOrder[h.game.currentTurnIndex]).toBe(6);
    h.accept(remove(9));
    expect(h.game.turnOrder[h.game.currentTurnIndex]).toBe(6);
  });

  it("follows normal sole-nominee progression when removing the last day speaker", () => {
    const initial = {
      ...day(),
      day: 2,
      completedGameNights: 2,
      currentTurnIndex: 9,
      nominations: [{ nominatorSeat: 1, candidateSeat: 2, order: 1 }],
    };
    const h = history(initial);
    h.accept(remove(10));
    expect(h.game.phase).toBe("goodbye-speech");
    expect(h.game.goodbyeSeats).toEqual([2]);
    expect(h.game.manualRemovals).toEqual([{ seat: 10, reason: "other" }]);
    expect(h.game.players.find((p) => p.seat === 2)?.status).toBe("eliminated");
  });

  it.each([
    { nominations: [] },
    { nominations: [{ nominatorSeat: 1, candidateSeat: 2, order: 1 }] },
  ])(
    "proceeds from exhausted zero-round discussion by a legal skip, never cancellation: %j",
    ({ nominations }) => {
      const h = history({ ...day(), currentTurnIndex: 9, nominations });
      h.accept(remove(10));
      expect(h.game.phase).toBe("night-mafia");
      expect(h.game.votingCancellation).toBeUndefined();
      expect(h.game.ballotSkipReason).toBe(
        nominations.length ? "zero-round-sole-nominee" : "no-nominees",
      );
    },
  );

  it("prunes only invalid live ballot voters/candidates and preserves the accepted call prefix", () => {
    let initial = ballot();
    const drafts: CanonicalGameEventDraft[] = [
      { type: "voting.order-announced", payload: {} },
      { type: "voting.order-announced", payload: {} },
      { type: "voting.candidate-mentioned", payload: { candidateSeat: 1 } },
      { type: "voting.candidate-mentioned", payload: { candidateSeat: 1 } },
      { type: "vote.accepted", payload: { voterSeat: 4, candidateSeat: 1 } },
      { type: "voting.candidate-stopped", payload: { candidateSeat: 1 } },
      { type: "voting.live-advanced", payload: { candidateSeat: 2 } },
      { type: "voting.candidate-mentioned", payload: { candidateSeat: 2 } },
      { type: "voting.candidate-mentioned", payload: { candidateSeat: 2 } },
      { type: "vote.accepted", payload: { voterSeat: 5, candidateSeat: 2 } },
    ];
    for (const draft of drafts) initial = domain.applyGameEvent(initial, draft);
    const h = history(initial);
    h.accept(remove(2, "voted-out"));
    expect(h.game.phase).toBe("voting");
    expect(h.game.turnOrder).toEqual([1, 3]);
    expect(h.game.currentTurnIndex).toBe(1);
    expect(h.game.voteAssignments).toEqual({ 4: 1 });
    expect(h.game.ballot).toMatchObject({
      selectedCandidateSeat: 3,
      acceptedCandidateSeats: [1],
      mention: 0,
      stopped: false,
      orderAnnouncements: 2,
    });
    h.accept(remove(4));
    expect(h.game.voteAssignments).toEqual({});
    h.accept({ type: "voting.candidate-mentioned", payload: { candidateSeat: 3 } });
    h.accept({ type: "voting.candidate-mentioned", payload: { candidateSeat: 3 } });
    h.accept({ type: "voting.candidate-stopped", payload: { candidateSeat: 3 } });
    h.accept(remove(3));
    expect(h.game.ballot).toMatchObject({ acceptedCandidateSeats: [1], mention: 2, stopped: true });
    expect(h.game.voteAssignments).toEqual({});
    expect(domain.resolveVote(h.game)).toEqual({ kind: "winner", seats: [1], totals: { 1: 0 } });
  });

  it("keeps unrelated host selection, review and votes without filling the new last candidate", () => {
    const initial: GameState = {
      ...ballot(),
      voteAssignments: { 4: 1, 5: 2, 6: 3 },
      ballot: {
        ...domain.createFederationBallot(3),
        hostRecording: true,
        reviewedCandidateSeats: [1],
        finalRuling: { candidateSeat: 1, reason: "Reviewed", externalReviewAcknowledged: true },
      },
    };
    const h = history(initial);
    h.accept(remove(2));
    expect(h.game.voteAssignments).toEqual({ 4: 1, 6: 3 });
    expect(h.game.ballot).toEqual(initial.ballot);
    expect(h.game.turnOrder).toEqual([1, 3]);
  });

  it("ends an empty pending ballot without a fabricated vote/result/cancellation", () => {
    const h = history(ballot());
    for (const seat of [1, 2, 3]) h.accept(remove(seat));
    expect(h.game.phase).toBe("night-mafia");
    expect(h.game.votingCancellation).toBeUndefined();
    expect(h.game.ballotCancellationDay).toBeUndefined();
    expect(h.entries.filter((entry) => entry.type === "voting.resolved")).toEqual([]);
  });

  it("declares numerical wins immediately, without farewell, Best Move or penalty debt", () => {
    for (const [red, black, team, expected] of [
      [3, 2, "red", "black"],
      [3, 1, "black", "red"],
    ] as const) {
      const initial = population(day(), red, black);
      const seat = initial.players.find((p) => p.status === "active" && p.team === team)!.seat;
      const h = history(initial);
      h.accept(remove(seat));
      expect(h.game.phase).toBe("finished");
      expect(h.game.winner).toBe(expected);
      expect(h.game.goodbyeSeats).toBeUndefined();
      expect(h.game.ballotCancellationDay).toBeUndefined();
    }
  });

  it("preserves an accepted kill for a manually removed victim but never offers that victim Best Move or farewell", () => {
    const initial = domain.beginNight(day());
    const victim = initial.players.find((p) => p.role === "citizen")!.seat;
    const h = history(initial);
    h.accept({
      type: "mafia.shots-observed",
      payload: {
        shotAssignments: {},
        observations: initial.players
          .filter((p) => p.team === "black")
          .map((p) => ({ shooterSeat: p.seat, targetSeat: victim })),
      },
    });
    h.accept({
      type: "mafia.shots-resolved",
      payload: {
        shots: h.game.players
          .filter((p) => p.team === "black")
          .map((p) => ({ shooterSeat: p.seat, targetSeat: victim, secret: true })),
        result: { kind: "kill", targetSeat: victim },
      },
    });
    const accepted = {
      result: h.game.nightResult,
      observations: h.game.shotObservations,
      assignments: h.game.shotAssignments,
    };
    h.accept(remove(victim, "mafia-kill"));
    expect(h.game.phase).toBe("night-mafia-result");
    expect({
      result: h.game.nightResult,
      observations: h.game.shotObservations,
      assignments: h.game.shotAssignments,
    }).toEqual(accepted);
    h.accept({ type: "don.check-skipped", payload: {} });
    h.accept({ type: "sheriff.check-skipped", payload: {} });
    h.accept(phase("day"));
    expect(h.game.day).toBe(2);
    expect(h.game.bestMove).toBeUndefined();
    expect(h.game.goodbyeSeats).toBeUndefined();
    expect(h.game.firstDayDepartureSeats).toEqual([]);
  });

  it("applies a pending accepted kill before choosing the winner, even if the correction first creates parity", () => {
    const initial = population(day(), 3, 2);
    const black = initial.players.filter((p) => p.status === "active" && p.team === "black");
    const red = initial.players.find((p) => p.status === "active" && p.team === "red")!;

    // A checkpoint after the physical shooting result, before its accepted departure.
    const resultState: GameState = {
      ...initial,
      phase: "night-mafia-result",
      nightResult: { kind: "kill", targetSeat: black[0]!.seat },
    };
    const pending = history(resultState);
    pending.accept(remove(red.seat));
    expect(pending.game.phase).toBe("night-mafia-result");
    expect(pending.game.winner).toBeNull();
    pending.accept(phase("night-don"));
    expect(pending.game.winner).toBeNull();
    expect(pending.game.players.find((p) => p.seat === black[0]!.seat)?.status).toBe("eliminated");
  });

  it("retains accepted collective result/votes and applies remaining group departures once", () => {
    const initial = population(day(), 4, 2);
    const active = initial.players.filter((p) => p.status === "active");
    const red = active.filter((p) => p.team === "red");
    const black = active.filter((p) => p.team === "black");
    const seats = [red[0]!.seat, black[0]!.seat];
    const resultState: GameState = {
      ...initial,
      phase: "car-crash-result",
      carCrashSeats: seats,
      carCrashVotes: { [red[1]!.seat]: true },
      carCrashResult: { eliminate: true, seats, yesVotes: 4, eligibleVoters: 6 },
    };
    const h = history(resultState);
    h.accept(remove(red[1]!.seat));
    h.accept(remove(red[0]!.seat, "voted-out"));
    expect(h.game.phase).toBe("car-crash-result");
    expect(h.game.carCrashResult).toEqual(resultState.carCrashResult);
    expect(h.game.carCrashVotes).toEqual(resultState.carCrashVotes);
    h.accept(phase("goodbye-speech"));
    expect(h.game.winner).toBeNull();
    expect(h.game.goodbyeSeats).toEqual([black[0]!.seat]);
    expect(h.game.firstDayDepartureSeats).toHaveLength(3);
    expect(new Set(h.game.firstDayDepartureSeats).size).toBe(3);
  });

  it("evaluates the correction at Continue even when the accepted collective result was no lift", () => {
    const initial = population(day(), 3, 2);
    const red = initial.players.filter((p) => p.status === "active" && p.team === "red");
    const resultState: GameState = {
      ...initial,
      phase: "car-crash-result",
      carCrashSeats: [1, 2],
      carCrashVotes: { [red[1]!.seat]: true },
      carCrashResult: {
        eliminate: false,
        seats: [1, 2],
        yesVotes: 1,
        eligibleVoters: 5,
      },
    };
    const h = history(resultState);
    h.accept(remove(red[0]!.seat));
    expect(h.game.phase).toBe("car-crash-result");
    expect(h.game.carCrashResult).toEqual(resultState.carCrashResult);
    h.accept(phase("finished"));
    expect(h.game.winner).toBe("black");
    expect(h.game.carCrashResult).toBeUndefined();
  });

  it("preserves unrelated pending hands and discards only the manually removed voter", () => {
    const initial = {
      ...ballot(),
      phase: "car-crash-decision" as const,
      ballot: undefined,
      carCrashSeats: [1, 2],
      carCrashVotes: { 3: true, 4: false, 5: true },
    };
    const h = history(initial);
    h.accept(remove(3));
    expect(h.game.phase).toBe("car-crash-decision");
    expect(h.game.carCrashVotes).toEqual({ 4: false, 5: true });
    expect(h.game.carCrashSeats).toEqual([1, 2]);
    h.accept({
      type: "car-crash.count-completed",
      payload: {
        votes: h.game.carCrashVotes as Record<number, boolean>,
        result: domain.resolveCompletedCarCrashCount(h.game),
      },
    });
    expect(h.game.carCrashResult?.yesVotes).toBe(1);
    expect(h.game.carCrashResult?.eligibleVoters).toBe(9);
  });

  it("exits a collective ballot with fewer than two candidates without a fabricated result", () => {
    const initial = {
      ...ballot(),
      phase: "car-crash-decision" as const,
      ballot: undefined,
      carCrashSeats: [1, 2],
      carCrashVotes: { 3: true },
    };
    const h = history(initial);
    h.accept(remove(1));
    expect(h.game.phase).toBe("night-mafia");
    expect(h.game.players.find((p) => p.seat === 2)?.status).toBe("active");
    expect(h.game.carCrashResult).toBeUndefined();
    expect(h.game.votingCancellation).toBeUndefined();
  });

  it("repairs live collective candidate/turn references while retaining the surviving hand count", () => {
    const initial = {
      ...ballot(),
      phase: "car-crash-decision" as const,
      ballot: undefined,
      carCrashSeats: [1, 2, 3],
      carCrashVotes: { 4: true },
      currentTurnIndex: 0,
    };
    const h = history(initial);
    h.accept(remove(1));
    expect(h.game.phase).toBe("car-crash-decision");
    expect(h.game.carCrashSeats).toEqual([2, 3]);
    expect(h.game.turnOrder).toEqual([2, 3]);
    expect(h.game.carCrashVotes).toEqual({ 4: true });
    expect(h.game.turnOrder[h.game.currentTurnIndex]).toBe(2);
  });

  it("shows the existing legal skip when a correction makes a pending collective lift prohibited", () => {
    const initial = {
      ...ballot(),
      phase: "car-crash-decision" as const,
      ballot: undefined,
      carCrashSeats: [1, 2, 3],
      carCrashVotes: { 4: true },
    };
    const h = history(initial);
    h.accept(remove(10));
    expect(h.game.phase).toBe("car-crash-skipped");
    expect(h.game.ballotSkipReason).toBe("nine-three-restricted");
    expect(h.game.carCrashVotes).toEqual({ 4: true });
    expect(h.game.carCrashResult).toBeUndefined();
    expect(h.game.votingCancellation).toBeUndefined();
    h.accept(phase("night-mafia"));
  });

  it("preserves surviving nomination order and attribution in a canonical contiguous queue", () => {
    const initial = ballot();
    const h = history(initial);
    h.accept(remove(1));
    expect(h.game.nominations).toEqual(
      initial.nominations.slice(1).map((entry, index) => ({ ...entry, order: index + 1 })),
    );
  });

  it("repairs tie speech queues without replaying an earlier speaker or resolving the new vote", () => {
    const initial = {
      ...ballot(),
      phase: "car-crash" as const,
      ballot: undefined,
      votingRound: "repeat" as const,
      carCrashSeats: [1, 2, 3],
      currentTurnIndex: 2,
    };
    const h = history(initial);
    h.accept(remove(3));
    expect(h.game.phase).toBe("voting");
    expect(h.game.turnOrder).toEqual([1, 2]);
    expect(h.game.votingRound).toBe("repeat");
    expect(h.game.voteAssignments).toEqual({});
    expect(h.game.ballot).toEqual(domain.createFederationBallot(1));
  });

  it("does not consume or apply a day mute to a replacement tie speaker", () => {
    const original = ballot();
    const h = history({
      ...original,
      phase: "car-crash",
      ballot: undefined,
      votingRound: "repeat",
      carCrashSeats: [1, 2, 3],
      currentTurnIndex: 0,
      players: original.players.map((p) => (p.seat === 2 ? { ...p, mutePending: true } : p)),
    });
    h.accept(remove(1));
    expect(h.game.phase).toBe("car-crash");
    expect(h.game.turnOrder[h.game.currentTurnIndex]).toBe(2);
    expect(h.game.currentSpeechRestricted).toBe(false);
    expect(h.game.players.find((p) => p.seat === 2)?.mutePending).toBe(true);
    h.accept({ type: "turn.completed", payload: { seat: 2 } });
    expect(h.game.players.find((p) => p.seat === 2)?.mutePending).toBe(true);
  });

  it("preserves all accepted physical shots and provisional shooting corrections", () => {
    const initial = domain.beginNight(day());
    const black = initial.players.find((p) => p.team === "black")!.seat;
    const victim = initial.players.find((p) => p.team === "red")!.seat;
    const observed = domain.applyGameEvent(initial, {
      type: "mafia.shots-observed",
      payload: {
        shotAssignments: { [black]: victim },
        observations: [
          { shooterSeat: black, targetSeat: victim },
          { shooterSeat: black, targetSeat: victim },
        ],
      },
    });
    const h = history(observed);
    h.accept(remove(black));
    expect(h.game.phase).toBe("night-mafia");
    expect(h.game.shotAssignments).toEqual(observed.shotAssignments);
    expect(h.game.shotObservations).toEqual(observed.shotObservations);
    expect(h.game.actualMultipleShotSeats).toEqual(observed.actualMultipleShotSeats);
    expect(h.game.shotObservations?.map((shot) => shot.additional)).toEqual([true, true]);
  });

  it("accepts further active-shooter observations after a recorded shooter is manually removed", () => {
    const h = history(domain.beginNight(day()));
    const [removed, remaining] = h.game.players.filter((p) => p.team === "black");
    const target = h.game.players.find((p) => p.team === "red")!.seat;
    h.accept({
      type: "mafia.shots-observed",
      payload: {
        shotAssignments: {},
        observations: [{ shooterSeat: removed!.seat, targetSeat: target }],
      },
    });
    const earlier = h.game.shotObservations;
    h.accept(remove(removed!.seat));
    h.accept({
      type: "mafia.shots-observed",
      payload: {
        shotAssignments: { ...h.game.shotAssignments },
        observations: [{ shooterSeat: remaining!.seat, targetSeat: target }],
      },
    });
    expect(h.game.shotAssignments).toEqual({ [removed!.seat]: target, [remaining!.seat]: target });
    expect(h.game.shotObservations).toEqual([
      ...earlier!,
      { shooterSeat: remaining!.seat, targetSeat: target, additional: false },
    ]);
    expect(h.game.phase).toBe("night-mafia");
  });

  it("never permits new or changed shots from a manually removed shooter", () => {
    const initial = domain.beginNight(day());
    const [removed, remaining] = initial.players.filter((p) => p.team === "black");
    const [target, otherTarget] = initial.players.filter((p) => p.team === "red");
    const observed = domain.applyGameEvent(initial, {
      type: "mafia.shots-observed",
      payload: {
        shotAssignments: {},
        observations: [{ shooterSeat: removed!.seat, targetSeat: target!.seat }],
      },
    });
    const game = domain.applyGameEvent(observed, remove(removed!.seat));
    const event = (
      shotAssignments: GameState["shotAssignments"],
      shooterSeat: number,
    ): CanonicalGameEventDraft => ({
      type: "mafia.shots-observed",
      payload: { shotAssignments, observations: [{ shooterSeat, targetSeat: target!.seat }] },
    });
    expect(() => domain.applyGameEvent(game, event(game.shotAssignments, removed!.seat))).toThrow();
    expect(() =>
      domain.applyGameEvent(game, event({ [removed!.seat]: otherTarget!.seat }, remaining!.seat)),
    ).toThrow();
    const withoutEarlierShot = domain.applyGameEvent(initial, remove(removed!.seat));
    expect(() =>
      domain.applyGameEvent(
        withoutEarlierShot,
        event({ [removed!.seat]: target!.seat }, remaining!.seat),
      ),
    ).toThrow();
    expect(game.shotObservations).toEqual(observed.shotObservations);
  });

  it("preserves another player's ongoing farewell and the next day's viable speaker", () => {
    const initial = domain.markPlayerInactive(day(), 1, "eliminated");
    const h = history({
      ...initial,
      phase: "goodbye-speech",
      turnOrder: [2, 3, 4, 5, 6, 7, 8, 9, 10],
      goodbyeSeats: [1],
      goodbyeNext: "day",
    });
    h.accept(remove(2));
    expect(h.game.phase).toBe("goodbye-speech");
    expect(h.game.goodbyeSeats).toEqual([1]);
    expect(h.game.turnOrder[h.game.currentTurnIndex]).toBe(3);
    h.accept(phase("day"));
    expect(h.game.turnOrder[h.game.currentTurnIndex]).toBe(3);
  });

  it("retains an already-accepted check result and permits the eliminated owner to continue it", () => {
    const initial = domain.beginNight(day());
    const h = history(initial);
    h.accept({ type: "mafia.shots-resolved", payload: { shots: [], result: { kind: "miss" } } });
    h.accept({ type: "don.check-skipped", payload: {} });
    h.accept({
      type: "sheriff.checked",
      payload: { targetSeat: 1, match: initial.players[0]!.team === "black" },
    });
    const accepted = h.game.checkResult;
    const sheriff = h.game.players.find((p) => p.role === "sheriff")!.seat;
    h.accept(remove(sheriff));
    expect(h.game.phase).toBe("night-sheriff-result");
    expect(h.game.checkResult).toEqual(accepted);
    expect(h.game.sheriffChecksPerformed).toBe(1);
    h.accept(phase("night-resolution"));
    h.accept(phase("day"));
    expect(h.game.sheriffChecksPerformed).toBe(1);
  });

  it("restores the exact pre-removal prefix for Undo without adding absent metadata", () => {
    const h = history(day());
    h.accept({ type: "turn.completed", payload: { seat: 1 } });
    const before = JSON.stringify(h.game);
    const entries = JSON.stringify(h.entries);
    h.accept(remove(3));
    const prefix = h.entries.slice(0, -1);
    expect(JSON.stringify(prefix)).toBe(entries);
    const restored = domain.replayGameLog(h.baseline, prefix).game;
    expect(JSON.stringify(restored)).toBe(before);
    expect(Object.hasOwn(restored, "manualRemovals")).toBe(false);
  });

  it.each(fixture.examples)(
    "admits removal of every active participant at each $name fixture boundary",
    (example) => {
      const baseline = example.baseline as InitialGameBaseline;
      const entries = example.events as GameLogEntry[];
      const replayed = domain.replayGameLog(baseline, entries);
      const states = [baseline.game, ...replayed.frames.map((frame) => frame.after)];
      for (const [index, state] of states.entries()) {
        expect(Object.hasOwn(state, "manualRemovals")).toBe(false);
        if (index === 0) continue; // The retained lifecycle marker is required before a correction.
        if (domain.isTerminalGamePhase(state.phase)) continue;
        const before = JSON.stringify(state);
        for (const player of state.players.filter((p) => p.status === "active")) {
          const next = domain.createGameLogEntry({
            before: state,
            draft: remove(player.seat),
            gameId: entries[0]!.gameId,
            id: `removal-${index}-${player.seat}`,
            sequence: index + 1,
            parentEventId: index ? entries[index - 1]!.id : null,
            createdAt: "2026-11-12T16:00:00Z",
          });
          const prefix = [...entries.slice(0, index), next.entry];
          expect(domain.replayGameLog(baseline, JSON.parse(JSON.stringify(prefix))).game).toEqual(
            JSON.parse(JSON.stringify(next.after)),
          );
          expect(() =>
            domain.createInitialGameBaseline(JSON.parse(JSON.stringify(next.after))),
          ).not.toThrow();
          expect(next.after.players.find((p) => p.seat === player.seat)).toEqual({
            ...player,
            status: "eliminated",
          });
          expect(next.after.manualRemovals).toEqual([{ seat: player.seat, reason: "other" }]);
          expect(JSON.stringify(state)).toBe(before);
        }
      }
    },
  );

  it.each(["don", "sheriff"] as const)(
    "preserves the removed %s owner's current and later check entitlement",
    (role) => {
      const initial = domain.beginNight(day());
      const seat = initial.players.find((p) => p.role === role)!.seat;
      const h = history(initial);
      h.accept(remove(seat));
      h.accept({ type: "mafia.shots-resolved", payload: { shots: [], result: { kind: "miss" } } });
      h.accept({ type: "don.check-skipped", payload: {} });
      h.accept({ type: "sheriff.check-skipped", payload: {} });
      h.accept(phase("day"));
      h.accept(phase("night-mafia"));
      h.accept({ type: "mafia.shots-resolved", payload: { shots: [], result: { kind: "miss" } } });
      expect(domain.getNightCheckWindowsToOpen(h.game)).toEqual([role]);
      h.accept({ type: "night.check-windows-opened", payload: { roles: [role] } });
      h.accept({ type: "don.check-skipped", payload: {} });
      h.accept({ type: "sheriff.check-skipped", payload: {} });
      expect(h.game.players.find((p) => p.seat === seat)?.status).toBe("eliminated");
      expect(h.game.sheriffChecksPerformed).toBe(0);
    },
  );

  it.each(["don", "sheriff"] as const)(
    "retains the %s check from an older snapshot without entitlement metadata",
    (role) => {
      const initial = domain.beginNight(day());
      const { nightCheckEligibility, ...older } = initial;
      expect(nightCheckEligibility?.[role]).toBe(true);
      const seat = initial.players.find((p) => p.role === role)!.seat;
      const h = history(older);
      h.accept(remove(seat));
      expect(h.game.nightCheckEligibility?.[role]).toBe(true);
      expect(domain.isNightCheckEligible(h.game, role)).toBe(true);
    },
  );
});
