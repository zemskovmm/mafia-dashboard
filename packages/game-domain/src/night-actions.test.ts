import { describe, expect, it } from "vitest";
import { advanceSetupPhase, createGame, markPlayerInactive, shouldSuggestDraw } from "./game.js";
import {
  beginNight,
  completeMafiaShots,
  completeBestMove,
  completeGoodbyeSpeech,
  completeNight,
  continueDonCheck,
  continueSheriffCheck,
  performDonCheck,
  performSheriffCheck,
  recordMafiaShot,
  resolveMafiaShots,
  skipDonCheck,
  skipSheriffCheck,
  toggleAllMafiaShotsForTarget,
  toggleBestMoveSeat,
  toggleMafiaShot,
} from "./night-actions.js";
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
  let setup = beginRoleDraw(createSetup(players()), createSeededRandom(71));
  for (let seat = 1; seat <= 10; seat += 1) {
    setup = drawRoleForSeat(setup, seat);
  }
  return completeRoleDraw(setup);
};

const dayOne = (): GameState => advanceSetupPhase(advanceSetupPhase(createGame(completedSetup())));

describe("night actions", () => {
  it.each(["car-crash", "car-crash-decision", "car-crash-result"] as const)(
    "rejects beginning night from unresolved %s state",
    (phase) => {
      expect(() => beginNight({ ...dayOne(), phase })).toThrow(
        `Cannot begin night from phase ${phase}`,
      );
    },
  );

  it.each([false, true])(
    "requires the dedicated completion path for a reviewed car-crash result (eliminate: %s)",
    (eliminate) => {
      expect(() =>
        beginNight({
          ...dayOne(),
          phase: "car-crash-result",
          carCrashResult: {
            eliminate,
            seats: [4, 6],
            yesVotes: eliminate ? 6 : 5,
            eligibleVoters: 10,
          },
        }),
      ).toThrow("Cannot begin night from phase car-crash-result");
    },
  );

  it("begins night from resolved voting and car-crash checkpoints", () => {
    for (const phase of ["voting-cancelled", "car-crash-skipped"] as const) {
      expect(beginNight({ ...dayOne(), phase })).toMatchObject({
        phase: "night-mafia",
        carCrashSeats: undefined,
        votingCancellation: undefined,
      });
    }
  });

  it("kills only when every active Mafia-aligned shooter selects the same active target", () => {
    let game = beginNight(dayOne());
    const shooters = game.players.filter(({ team }) => team === "black").map(({ seat }) => seat);
    const target = game.players.find(({ team }) => team === "red")!.seat;

    for (const shooter of shooters) {
      game = recordMafiaShot(game, shooter, target);
    }

    const resolution = resolveMafiaShots(game);
    expect(resolution.result).toEqual({ kind: "kill", targetSeat: target });
    expect(resolution.game.players.find(({ seat }) => seat === target)?.status).toBe("active");
    expect(resolution.game.phase).toBe("night-mafia-result");
    expect(resolution.secretShots).toHaveLength(3);
    expect(resolution.secretShots.every(({ secret }) => secret)).toBe(true);
    expect(
      completeMafiaShots(resolution.game).players.find(({ seat }) => seat === target)?.status,
    ).toBe("eliminated");
  });

  it("records a miss for missing or conflicting shots and rejects duplicate shots", () => {
    let game = beginNight(dayOne());
    const shooters = game.players.filter(({ team }) => team === "black").map(({ seat }) => seat);
    const targets = game.players.filter(({ team }) => team === "red").map(({ seat }) => seat);

    game = recordMafiaShot(game, shooters[0]!, targets[0]!);
    expect(() => recordMafiaShot(game, shooters[0]!, targets[1]!)).toThrow(/already recorded/i);
    expect(resolveMafiaShots(game)).toMatchObject({
      result: { kind: "miss" },
      secretShots: [{ shooterSeat: shooters[0], targetSeat: targets[0], secret: true }],
    });

    game = recordMafiaShot(game, shooters[1]!, targets[1]!);
    game = recordMafiaShot(game, shooters[2]!, targets[0]!);
    const resolution = resolveMafiaShots(game);

    expect(resolution.result).toEqual({ kind: "miss" });
    expect(resolution.game.players.filter(({ status }) => status === "active")).toHaveLength(10);
  });

  it("toggles and reassigns a Mafia shot before evaluation", () => {
    const initial = beginNight(dayOne());
    const shooter = initial.players.find(({ team }) => team === "black")!;
    const [firstTarget, secondTarget] = initial.players.filter(({ team }) => team === "red");

    const selected = toggleMafiaShot(initial, shooter.seat, firstTarget!.seat);
    expect(selected.shotAssignments[shooter.seat]).toBe(firstTarget!.seat);

    const cleared = toggleMafiaShot(selected, shooter.seat, firstTarget!.seat);
    expect(cleared.shotAssignments[shooter.seat]).toBeUndefined();

    const reassigned = toggleMafiaShot(selected, shooter.seat, secondTarget!.seat);
    expect(reassigned.shotAssignments[shooter.seat]).toBe(secondTarget!.seat);
  });

  it("toggles every active Mafia shot by target", () => {
    const initial = beginNight(dayOne());
    const shooters = initial.players.filter(
      ({ team, status }) => team === "black" && status === "active",
    );
    const [target, otherTarget] = initial.players.filter(({ team }) => team === "red");

    const selected = toggleAllMafiaShotsForTarget(initial, target!.seat);
    expect(selected.shotAssignments).toEqual(
      Object.fromEntries(shooters.map(({ seat }) => [seat, target!.seat])),
    );

    const cleared = toggleAllMafiaShotsForTarget(selected, target!.seat);
    expect(cleared.shotAssignments).toEqual({});

    const split = toggleMafiaShot(initial, shooters[0]!.seat, otherTarget!.seat);
    const reassigned = toggleAllMafiaShotsForTarget(split, target!.seat);
    expect(Object.values(reassigned.shotAssignments)).toEqual(
      Array.from({ length: shooters.length }, () => target!.seat),
    );

    const inactive = markPlayerInactive(initial, target!.seat, "eliminated");
    expect(
      Object.values(toggleAllMafiaShotsForTarget(inactive, target!.seat).shotAssignments),
    ).toHaveLength(shooters.length);
  });

  it("advances only after the evaluated Mafia result is confirmed", () => {
    let game = beginNight(dayOne());
    const shooters = game.players.filter(({ team }) => team === "black").map(({ seat }) => seat);
    const targets = game.players.filter(({ team }) => team === "red").map(({ seat }) => seat);
    for (const [index, shooter] of shooters.entries()) {
      game = recordMafiaShot(game, shooter, targets[index % 2]!);
    }

    const evaluated = resolveMafiaShots(game).game;
    expect(evaluated.phase).toBe("night-mafia-result");
    expect(completeMafiaShots(evaluated).phase).toBe("night-don");
  });

  it("finishes a lethal Mafia night only after the victim's goodbye speech", () => {
    let game: GameState = { ...dayOne(), day: 2 };
    const redPlayers = game.players.filter(({ team }) => team === "red");
    for (const player of redPlayers.slice(0, 3)) {
      game = markPlayerInactive(game, player.seat, "eliminated");
    }
    const victim = redPlayers[3]!;
    game = beginNight(game);
    const shooters = game.players.filter(
      ({ team, status }) => team === "black" && status === "active",
    );
    for (const shooter of shooters) game = recordMafiaShot(game, shooter.seat, victim.seat);

    game = completeMafiaShots(resolveMafiaShots(game).game);
    expect(game.phase).not.toBe("finished");
    expect(game.winner).toBeNull();

    if (game.phase === "night-don") {
      game = game.players.some(({ role, status }) => role === "don" && status === "active")
        ? continueDonCheck(performDonCheck(game, victim.seat).game)
        : skipDonCheck(game);
    }
    if (game.phase === "night-sheriff") {
      game = game.players.some(({ role, status }) => role === "sheriff" && status === "active")
        ? continueSheriffCheck(performSheriffCheck(game, shooters[0]!.seat).game)
        : skipSheriffCheck(game);
    }
    game = completeNight(game);
    expect(game).toMatchObject({
      phase: "goodbye-speech",
      goodbyeSeats: [victim.seat],
      winner: null,
    });

    game = completeGoodbyeSpeech(game);
    expect(game).toMatchObject({ phase: "finished", winner: "black" });
  });

  it("opens an ordinary day after a miss and a goodbye before later days after a kill", () => {
    const base = dayOne();
    const happy = completeNight({
      ...base,
      phase: "night-resolution",
      nightResult: { kind: "miss" },
    });
    expect(happy).toMatchObject({ phase: "day", day: 2 });
    expect(happy).not.toHaveProperty("dayNotice");

    const victim = base.players.find(({ team }) => team === "red")!;
    const killed = markPlayerInactive({ ...base, day: 2 }, victim.seat, "eliminated");
    const goodbye = completeNight({
      ...killed,
      phase: "night-resolution",
      nightResult: { kind: "kill", targetSeat: victim.seat },
    });
    expect(goodbye).toMatchObject({
      phase: "goodbye-speech",
      day: 3,
      goodbyeSeats: [victim.seat],
      goodbyeNext: "day",
    });
  });

  it("advances from the actual previous day opener when an earlier seat is inactive", () => {
    let game = advanceSetupPhase(
      advanceSetupPhase(markPlayerInactive(createGame(completedSetup()), 2, "eliminated")),
    );
    expect(game).toMatchObject({ dayOpeningSeat: 1, turnOrder: [1, 3, 4, 5, 6, 7, 8, 9, 10] });

    game = completeNight({ ...game, phase: "night-resolution" });
    expect(game).toMatchObject({ dayOpeningSeat: 3 });
    expect(game.turnOrder[0]).toBe(3);

    game = completeNight({ ...game, phase: "night-resolution" });
    expect(game).toMatchObject({ dayOpeningSeat: 4 });
    expect(game.turnOrder[0]).toBe(4);
  });

  it("retains the opening cursor if that opener later becomes inactive", () => {
    let game = advanceSetupPhase(
      advanceSetupPhase(markPlayerInactive(createGame(completedSetup()), 2, "eliminated")),
    );
    game = markPlayerInactive(game, 1, "red-carded");

    const nextDay = completeNight({ ...game, phase: "night-resolution" });

    expect(nextDay).toMatchObject({ dayOpeningSeat: 3 });
    expect(nextDay.turnOrder[0]).toBe(3);
  });

  it("wraps past consecutive inactive seats and handles one remaining player", () => {
    const base = dayOne();
    const wrapped = completeNight({
      ...base,
      phase: "night-resolution",
      day: 9,
      dayOpeningSeat: 9,
      players: base.players.map((player) =>
        player.seat === 10 || player.seat === 1
          ? { ...player, status: "eliminated" as const }
          : player,
      ),
    });
    expect(wrapped).toMatchObject({ dayOpeningSeat: 2 });
    expect(wrapped.turnOrder[0]).toBe(2);

    const oneRemaining = completeNight({
      ...base,
      phase: "night-resolution",
      dayOpeningSeat: 5,
      players: base.players.map((player) =>
        player.seat === 5 ? player : { ...player, status: "eliminated" as const },
      ),
    });
    expect(oneRemaining).toMatchObject({ dayOpeningSeat: 5, turnOrder: [5] });
  });

  it("expires every pending mute before exposing the next day", () => {
    const base = dayOne();
    const nextDay = completeNight({
      ...base,
      phase: "night-resolution",
      players: base.players.map((player) =>
        player.seat === 2 || player.seat === 7 ? { ...player, mutePending: true } : player,
      ),
      nightResult: { kind: "miss" },
    });

    expect(nextDay).toMatchObject({ phase: "day", day: 2 });
    expect(nextDay.players.every(({ mutePending }) => !mutePending)).toBe(true);
  });

  it.each([
    ["Best Move", true, "best-move"],
    ["goodbye speech", false, "goodbye-speech"],
  ] as const)("expires an overnight victim's stale mute before %s", (_, bestMoveEnabled, phase) => {
    const base = dayOne();
    const victim = base.players.find(({ role }) => role === "citizen")!;
    const killed = markPlayerInactive(
      {
        ...base,
        bestMoveEnabled,
        players: base.players.map((player) =>
          player.seat === victim.seat ? { ...player, mutePending: true } : player,
        ),
      },
      victim.seat,
      "eliminated",
    );

    const nextDay = completeNight({
      ...killed,
      phase: "night-resolution",
      nightResult: { kind: "kill", targetSeat: victim.seat },
    });

    expect(nextDay).toMatchObject({
      phase,
      day: 2,
      goodbyeSeats: [victim.seat],
      players: expect.arrayContaining([
        expect.objectContaining({ seat: victim.seat, mutePending: false }),
      ]),
    });
  });

  it("suggests a draw after three complete cycles without an elimination", () => {
    let game: GameState = { ...dayOne(), phase: "night-resolution" };

    for (let completedCycles = 1; completedCycles <= 3; completedCycles += 1) {
      game = completeNight(game);
      expect(game.cyclesWithoutElimination).toBe(completedCycles);
      expect(game.eliminationOccurredThisCycle).toBe(false);
      expect(shouldSuggestDraw(game)).toBe(completedCycles === 3);
      game = { ...game, phase: "night-resolution" };
    }
  });

  it("resets the draw counter after an elimination and supports legacy projections", () => {
    const legacy = dayOne();
    const { cyclesWithoutElimination, eliminationOccurredThisCycle, ...legacyProjection } = legacy;
    expect(cyclesWithoutElimination).toBe(0);
    expect(eliminationOccurredThisCycle).toBe(false);

    const firstCycle = completeNight({ ...legacyProjection, phase: "night-resolution" });
    expect(firstCycle.cyclesWithoutElimination).toBe(1);

    const victim = firstCycle.players.find(({ team }) => team === "red")!;
    const withElimination = markPlayerInactive(
      { ...firstCycle, phase: "night-resolution", cyclesWithoutElimination: 2 },
      victim.seat,
      "eliminated",
    );
    const reset = completeNight(withElimination);
    expect(reset.cyclesWithoutElimination).toBe(0);
    expect(reset.eliminationOccurredThisCycle).toBe(false);
    expect(shouldSuggestDraw(reset)).toBe(false);
  });

  it("skips first-night Best move when the game snapshot disables it", () => {
    const base = dayOne();
    const victim = base.players.find(({ team }) => team === "red")!;
    const killed = markPlayerInactive(
      { ...base, bestMoveEnabled: false },
      victim.seat,
      "eliminated",
    );

    expect(
      completeNight({
        ...killed,
        phase: "night-resolution",
        nightResult: { kind: "kill", targetSeat: victim.seat },
      }),
    ).toMatchObject({
      phase: "goodbye-speech",
      day: 2,
      goodbyeSeats: [victim.seat],
      goodbyeNext: "day",
    });
  });

  it("allows a Best move to select only active players other than its deceased owner", () => {
    const base = dayOne();
    const [victim, previouslyEliminated] = base.players.filter(({ team }) => team === "red");
    let game = markPlayerInactive(base, victim!.seat, "eliminated");
    game = markPlayerInactive(game, previouslyEliminated!.seat, "eliminated");
    game = {
      ...game,
      phase: "best-move",
      bestMove: { playerSeat: victim!.seat, selectedSeats: [] },
      goodbyeSeats: [victim!.seat],
      goodbyeNext: "day",
    };

    expect(() => toggleBestMoveSeat(game, victim!.seat)).toThrow(/owner/i);
    expect(() => toggleBestMoveSeat(game, previouslyEliminated!.seat)).toThrow(/active/i);
    const active = game.players.find(({ status }) => status === "active")!;
    game = toggleBestMoveSeat(game, active.seat);
    expect(game.bestMove?.selectedSeats).toEqual([active.seat]);
  });

  it("rejects non-Mafia shooters but permits shots at inactive targets", () => {
    const day = dayOne();
    const redSeat = day.players.find(({ team }) => team === "red")!.seat;
    const blackSeat = day.players.find(({ team }) => team === "black")!.seat;
    const inactiveTarget = day.players.find(
      ({ team, seat }) => team === "red" && seat !== redSeat,
    )!.seat;
    const game = beginNight(markPlayerInactive(day, inactiveTarget, "eliminated"));

    expect(() => recordMafiaShot(game, redSeat, blackSeat)).toThrow(/mafia-aligned/i);
    expect(recordMafiaShot(game, blackSeat, inactiveTarget).shotAssignments[blackSeat]).toBe(
      inactiveTarget,
    );
  });

  it("reports no effect when every Mafia shooter targets an inactive player", () => {
    const day = dayOne();
    const inactiveTarget = day.players.find(({ team }) => team === "red")!.seat;
    let game = beginNight(markPlayerInactive(day, inactiveTarget, "eliminated"));
    const shooters = game.players.filter(
      ({ team, status }) => team === "black" && status === "active",
    );
    for (const shooter of shooters) game = recordMafiaShot(game, shooter.seat, inactiveTarget);

    const evaluated = resolveMafiaShots(game);
    expect(evaluated.result).toEqual({ kind: "no-effect", targetSeat: inactiveTarget });
    const completed = completeMafiaShots(evaluated.game);
    expect(completed.players.find(({ seat }) => seat === inactiveTarget)?.status).toBe(
      "eliminated",
    );
    expect(completed.players.filter(({ status }) => status === "active")).toHaveLength(9);
  });

  it("returns private Don and Sheriff results and advances in order", () => {
    let game = beginNight(dayOne());
    const shooters = game.players.filter(({ team }) => team === "black").map(({ seat }) => seat);
    const citizen = game.players.find(({ role, seat }) => role === "citizen" && seat !== 2)!.seat;
    for (const shooter of shooters) {
      game = recordMafiaShot(game, shooter, citizen);
    }
    game = completeMafiaShots(resolveMafiaShots(game).game);

    const sheriffSeat = game.players.find(({ role }) => role === "sheriff")!.seat;
    const deadCitizen = game.players.find(({ seat }) => seat === citizen)!;
    expect(deadCitizen.status).toBe("eliminated");
    const deadCheck = performDonCheck(game, deadCitizen.seat);
    expect(deadCheck.result.match).toBe(false);

    game = { ...deadCheck.game, phase: "night-don" };
    const donResult = performDonCheck(game, sheriffSeat);
    expect(donResult.result).toEqual({
      kind: "don-check",
      targetSeat: sheriffSeat,
      match: true,
      secret: true,
    });
    expect(donResult.game.phase).toBe("night-don-result");

    const mafiaSeat = game.players.find(({ role }) => role === "mafia")!.seat;
    const sheriffStage = continueDonCheck(donResult.game);
    expect(sheriffStage.phase).toBe("night-sheriff");
    expect(performSheriffCheck(sheriffStage, deadCitizen.seat).result.match).toBe(false);
    const sheriffResult = performSheriffCheck(sheriffStage, mafiaSeat);
    expect(sheriffResult.result).toEqual({
      kind: "sheriff-check",
      targetSeat: mafiaSeat,
      match: true,
      secret: true,
    });
    expect(sheriffResult.game.phase).toBe("night-sheriff-result");

    let nextDay = completeNight(continueSheriffCheck(sheriffResult.game));
    expect(nextDay.phase).toBe("best-move");
    const bestMoveTargets = [
      ...nextDay.players
        .filter(({ team, status }) => team === "black" && status === "active")
        .slice(0, 2),
      nextDay.players.find(({ team, status }) => team === "red" && status === "active")!,
    ];
    for (const target of bestMoveTargets) nextDay = toggleBestMoveSeat(nextDay, target.seat);
    nextDay = completeBestMove(nextDay);
    expect(nextDay.phase).toBe("goodbye-speech");
    expect(nextDay.goodbyeSeats).toEqual([citizen]);
    expect(nextDay.bestMove?.mafiaHits).toBe(2);

    nextDay = completeGoodbyeSpeech(nextDay);
    expect(nextDay.phase).toBe("day");
    expect(nextDay.day).toBe(2);
    expect(nextDay.turnOrder[0]).toBe(2);
  });

  it("skips check owners who were inactive before the night began", () => {
    let game = dayOne();
    const don = game.players.find(({ role }) => role === "don")!;
    const sheriff = game.players.find(({ role }) => role === "sheriff")!;
    game = markPlayerInactive(game, don.seat, "eliminated");
    game = markPlayerInactive(game, sheriff.seat, "red-carded");
    game = beginNight(game);
    expect(game.nightCheckEligibility).toEqual({ don: false, sheriff: false });
    const target = game.players.find(({ status, team }) => status === "active" && team === "red")!;
    for (const shooter of game.players.filter(
      ({ status, team }) => status === "active" && team === "black",
    )) {
      game = recordMafiaShot(game, shooter.seat, target.seat);
    }

    game = completeMafiaShots(resolveMafiaShots(game).game);
    expect(game.phase).toBe("night-resolution");
    expect(() => performDonCheck({ ...game, phase: "night-don" }, target.seat)).toThrow(
      /available Don/i,
    );
    expect(() => skipDonCheck({ ...game, phase: "night-don" })).toThrow(/available Don/i);
    expect(() => performSheriffCheck({ ...game, phase: "night-sheriff" }, target.seat)).toThrow(
      /available Sheriff/i,
    );
    expect(() => skipSheriffCheck({ ...game, phase: "night-sheriff" })).toThrow(
      /available Sheriff/i,
    );
  });

  it.each(["don", "sheriff"] as const)(
    "lets a %s killed by the current Mafia shot complete that night's check",
    (role) => {
      let game = beginNight(dayOne());
      const owner = game.players.find(({ role: playerRole }) => playerRole === role)!;
      const target = game.players.find(({ role: playerRole }) => playerRole === "citizen")!;
      for (const shooter of game.players.filter(
        ({ status, team }) => status === "active" && team === "black",
      )) {
        game = recordMafiaShot(game, shooter.seat, owner.seat);
      }

      game = completeMafiaShots(resolveMafiaShots(game).game);
      expect(game.nightCheckEligibility).toEqual({ don: true, sheriff: true });
      expect(game.players.find(({ seat }) => seat === owner.seat)?.status).toBe("eliminated");
      if (role === "don") {
        expect(game.phase).toBe("night-don");
        expect(performDonCheck(game, target.seat).game.phase).toBe("night-don-result");
      } else {
        expect(game.phase).toBe("night-don");
        game = skipDonCheck(game);
        expect(game.phase).toBe("night-sheriff");
        expect(performSheriffCheck(game, target.seat).game.phase).toBe("night-sheriff-result");
      }
    },
  );

  it("recovers same-night eligibility from a pre-snapshot persisted phase", () => {
    const base = dayOne();
    const don = base.players.find(({ role }) => role === "don")!;
    const target = base.players.find(({ role }) => role === "citizen")!;
    const restored: GameState = {
      ...base,
      phase: "night-don",
      players: base.players.map((player) =>
        player.seat === don.seat ? { ...player, status: "eliminated" } : player,
      ),
      nightResult: { kind: "kill", targetSeat: don.seat },
    };

    expect(restored.nightCheckEligibility).toBeUndefined();
    expect(performDonCheck(restored, target.seat).game.phase).toBe("night-don-result");
  });

  it("retains both eligibility decisions for the current night and refreshes them next night", () => {
    let game = beginNight({ ...dayOne(), bestMoveEnabled: false });
    const don = game.players.find(({ role }) => role === "don")!;
    const sheriff = game.players.find(({ role }) => role === "sheriff")!;
    const target = game.players.find(({ role }) => role === "citizen")!;
    game = markPlayerInactive(game, don.seat, "eliminated");
    game = markPlayerInactive(game, sheriff.seat, "red-carded");
    game = {
      ...game,
      phase: "night-don",
      nightResult: { kind: "kill", targetSeat: don.seat },
    };

    game = continueDonCheck(performDonCheck(game, target.seat).game);
    expect(game.phase).toBe("night-sheriff");
    game = continueSheriffCheck(performSheriffCheck(game, target.seat).game);
    game = completeNight(game);
    expect(game.nightCheckEligibility).toBeUndefined();
    game = completeGoodbyeSpeech(game);
    game = beginNight(game);
    expect(game.nightCheckEligibility).toEqual({ don: false, sheriff: false });
    game = completeMafiaShots(resolveMafiaShots(game).game);
    expect(game.phase).toBe("night-resolution");
  });
});
