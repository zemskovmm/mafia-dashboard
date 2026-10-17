import { describe, expect, it } from "vitest";
import {
  applyGameEvent,
  assertCanonicalGameEventDraft,
  createGame,
  createGameLogEntry,
  createInitialGameBaseline,
  createSetup,
  beginRoleDraw,
  completeRoleDraw,
  drawRoleForSeat,
  createSeededRandom,
  hashGameState,
  isSecretGameEventType,
  replayGameLog,
} from "./index.js";
import type { CanonicalGameEventDraft, GameLogEntry, GameState } from "./index.js";
import { completeMafiaShots, isNightCheckEligible } from "./night-actions.js";
import * as domain from "./index.js";
const opening = (): GameState => {
  let setup = beginRoleDraw(
    createSetup(Array.from({ length: 10 }, (_, i) => ({ id: `p${i + 1}`, seat: i + 1 }))),
    createSeededRandom(71),
  );
  for (let seat = 1; seat <= 10; seat++) setup = drawRoleForSeat(setup, seat);
  return createGame(completeRoleDraw(setup));
};
const chain = (initial: GameState, drafts: readonly CanonicalGameEventDraft[]) => {
  const baseline = createInitialGameBaseline(initial);
  let game = initial;
  const entries: GameLogEntry[] = [];
  for (const draft of [{ type: "game.checkpointed", payload: {} } as const, ...drafts]) {
    const result = createGameLogEntry({
      gameId: "federation",
      id: `e${entries.length + 1}`,
      sequence: entries.length + 1,
      parentEventId: entries.at(-1)?.id ?? null,
      createdAt: "2026-10-14T10:00:00Z",
      before: game,
      draft,
    });
    game = result.after;
    entries.push(result.entry);
    expect(
      replayGameLog(JSON.parse(JSON.stringify(baseline)), JSON.parse(JSON.stringify(entries))).game,
    ).toEqual(JSON.parse(JSON.stringify(game)));
  }
  return { game, baseline, entries };
};
const day = () =>
  chain(
    opening(),
    ["mafia-sleep", "don-identification", "sheriff-identification", "free-seating", "day"].map(
      (to) => ({ type: "phase.changed", payload: { to } }) as CanonicalGameEventDraft,
    ),
  ).game;
describe("strict federation canonical replay", () => {
  it.each([
    { subject: "victim", multiple: false },
    { subject: "don", multiple: false },
    { subject: "other", multiple: false },
    { subject: "don", multiple: true },
    { subject: "don", multiple: true, marker: true },
  ])(
    "replays a post-shooting-result sanction: $subject, multiple=$multiple, marker=$marker",
    ({ subject, multiple, marker }) => {
      const initial = day();
      const victim = initial.players.find((p) => p.role === "sheriff")!.seat;
      const don = initial.players.find((p) => p.role === "don")!.seat;
      const seat =
        subject === "victim"
          ? victim
          : subject === "don"
            ? don
            : initial.players.find((p) => p.role === "citizen")!.seat;
      const shots = initial.players
        .filter((p) => p.team === "black")
        .map((p) => ({ shooterSeat: p.seat, targetSeat: victim, secret: true as const }));
      const result = multiple
        ? { kind: "miss" as const }
        : { kind: "kill" as const, targetSeat: victim };
      const prefix: CanonicalGameEventDraft[] = [
        { type: "phase.changed", payload: { to: "night-mafia" } },
        ...(multiple
          ? marker
            ? [{ type: "mafia.multiple-shot-observed" as const, payload: { shooterSeat: don } }]
            : [
                {
                  type: "mafia.shots-observed" as const,
                  payload: {
                    shotAssignments: Object.fromEntries(
                      shots.map((s) => [s.shooterSeat, s.targetSeat]),
                    ),
                    observations: [{ shooterSeat: don, targetSeat: victim }],
                  },
                },
              ]
          : []),
        { type: "mafia.shots-resolved", payload: { shots, result } },
      ];
      const resolved = chain(initial, prefix).game;
      const removal: CanonicalGameEventDraft = {
        type: "discipline.removal-observed",
        payload: {
          seat,
          stage: "after-shooting-result",
          rule: "6.2.3",
          reason: "",
          checkInProgress: false,
        },
      };
      expect(() => assertCanonicalGameEventDraft(removal)).not.toThrow();
      expect(() => applyGameEvent(initial, removal)).toThrow();
      expect(() => applyGameEvent({ ...resolved, nightResult: undefined }, removal)).toThrow();
      expect(() =>
        assertCanonicalGameEventDraft({
          ...removal,
          payload: { ...removal.payload, checkInProgress: true },
        }),
      ).toThrow();
      const removed = chain(initial, [...prefix, removal]).game;
      expect(removed.nightResult).toEqual(resolved.nightResult);
      expect(removed.shotAssignments).toEqual(resolved.shotAssignments);
      expect(removed.shotObservations).toEqual(resolved.shotObservations);
      expect(removed.actualMultipleShotSeats).toEqual(resolved.actualMultipleShotSeats);
      if (marker) expect(removed.actualMultipleShotSeats).toEqual([don]);
      for (const corruption of [
        { departure: "pending" },
        { occurredPhase: "day" },
        { checkCompletionPending: true },
        { shotDeath: !removed.disciplinaryRemovals![0]!.shotDeath },
      ]) {
        const malformed = {
          ...removed,
          disciplinaryRemovals: [{ ...removed.disciplinaryRemovals![0], ...corruption }],
        } as GameState;
        expect(() => chain(malformed, [])).toThrow();
      }
      expect(() => chain({ ...removed, nightResult: undefined }, [])).toThrow();
      expect(removed.disciplinaryRemovals?.[0]).toMatchObject({
        shotDeath: subject === "victim",
        departure: "departed",
        checkCompletionPending: false,
        announcement: "pending",
      });
      expect(removed.ballotCancellationDay).toBe(
        subject === "victim" ? undefined : initial.day + 1,
      );
      expect(() => completeMafiaShots(removed)).toThrow(/announcement/);
      expect(() => applyGameEvent(removed, removal)).toThrow();
      const announcement: CanonicalGameEventDraft = {
        type: "discipline.removals-announced",
        payload: { seats: [seat] },
      };
      const announced = chain(initial, [...prefix, removal, announcement]).game;
      expect(announced.phase).toBe("night-mafia-result");
      const nextPhase = completeMafiaShots(announced).phase;
      const completed = chain(initial, [
        ...prefix,
        removal,
        announcement,
        { type: "phase.changed", payload: { to: nextPhase } },
      ]).game;
      expect(completed.players.filter((p) => p.status !== "active")).toHaveLength(
        subject === "victim" || multiple ? 1 : 2,
      );
      expect(isNightCheckEligible(completed, "sheriff")).toBe(subject !== "victim");
      expect(isNightCheckEligible(completed, "don")).toBe(subject !== "don");
    },
  );
  it.each(["victim", "two-offenders", "deciding"])(
    "preserves post-result consequences through later boundaries: %s",
    (scenario) => {
      let initial = day();
      const reds = initial.players.filter((p) => p.role === "citizen").map((p) => p.seat);
      if (scenario === "deciding")
        for (const seat of reds.slice(2, 5))
          initial = domain.markPlayerInactive(initial, seat, "eliminated");
      const victim = reds[0]!;
      const offenders =
        scenario === "victim"
          ? [victim]
          : scenario === "deciding"
            ? [reds[1]!]
            : initial.players
                .filter((p) => p.team === "black")
                .slice(0, 2)
                .map((p) => p.seat);
      const drafts: CanonicalGameEventDraft[] = [];
      let game = initial;
      const accept = (draft: CanonicalGameEventDraft) => {
        drafts.push(draft);
        game = chain(initial, drafts).game;
      };
      accept({ type: "phase.changed", payload: { to: "night-mafia" } });
      accept({
        type: "mafia.shots-resolved",
        payload: {
          shots: initial.players
            .filter((p) => p.team === "black")
            .map((p) => ({ shooterSeat: p.seat, targetSeat: victim, secret: true })),
          result: { kind: "kill", targetSeat: victim },
        },
      });
      for (const seat of offenders)
        accept({
          type: "discipline.removal-observed",
          payload: {
            seat,
            stage: "after-shooting-result",
            rule: "6.2.3",
            reason: "",
            checkInProgress: false,
          },
        });
      expect(game).toMatchObject({ phase: "night-mafia-result", winner: null });
      accept({ type: "discipline.removals-announced", payload: { seats: offenders } });
      expect(game.phase).toBe("night-mafia-result");
      accept({ type: "phase.changed", payload: { to: completeMafiaShots(game).phase } });
      if (scenario === "deciding") {
        expect(game).toMatchObject({ phase: "finished", winner: "black" });
        expect(game.players.find((p) => p.seat === victim)?.status).toBe("eliminated");
        expect(game.players.find((p) => p.seat === offenders[0])?.status).toBe("red-carded");
        return;
      }
      if (game.phase === "night-don") accept({ type: "don.check-skipped", payload: {} });
      if (game.phase === "night-sheriff") accept({ type: "sheriff.check-skipped", payload: {} });
      accept({ type: "phase.changed", payload: { to: domain.completeNight(game).phase } });
      if (scenario === "victim") {
        expect(game.phase).toBe("day");
        expect(game.bestMove).toBeUndefined();
        expect(game.goodbyeSeats).toBeUndefined();
        expect(game.ballotCancellationDay).toBeUndefined();
        expect(game.players.filter((p) => p.status !== "active")).toHaveLength(1);
      } else {
        if (game.phase === "best-move") {
          accept({
            type: "best-move.finalized",
            payload: { reason: "declined", readbackAcknowledged: true },
          });
          accept({ type: "phase.changed", payload: { to: domain.completeNight(game).phase } });
        }
        expect(game.phase).toBe("goodbye-speech");
        accept({ type: "phase.changed", payload: { to: "day" } });
        expect(game.ballotCancellationDay).toBe(2);
        for (let turns = 0; game.phase === "day" && turns < 10; turns++)
          accept({
            type: "turn.completed",
            payload: { seat: game.turnOrder[game.currentTurnIndex]! },
          });
        expect(game.phase).toBe("voting-cancelled");
        accept({ type: "phase.changed", payload: { to: "night-mafia" } });
        expect(game.ballotCancellationDay).toBeUndefined();
        expect(game.nightResult).toBeUndefined();
        const miss = domain.resolveMafiaShots(game);
        accept({
          type: "mafia.shots-resolved",
          payload: { shots: miss.secretShots, result: miss.result },
        });
        accept({ type: "phase.changed", payload: { to: completeMafiaShots(game).phase } });
        if (game.phase === "night-don") accept({ type: "don.check-skipped", payload: {} });
        if (game.phase === "night-sheriff") accept({ type: "sheriff.check-skipped", payload: {} });
        accept({ type: "phase.changed", payload: { to: domain.completeNight(game).phase } });
        for (let turns = 0; game.phase === "day" && turns < 10; turns++)
          accept({
            type: "turn.completed",
            payload: { seat: game.turnOrder[game.currentTurnIndex]! },
          });
        expect(game.phase).toBe("night-mafia");
        expect(game.ballotCancellationDay).toBeUndefined();
      }
    },
  );
  it("pins current five-step opening hashes", () => {
    const { entries } = chain(
      opening(),
      ["mafia-sleep", "don-identification", "sheriff-identification", "free-seating", "day"].map(
        (to) => ({ type: "phase.changed", payload: { to } }) as CanonicalGameEventDraft,
      ),
    );
    expect(entries.map((entry) => entry.stateHashAfter)).toEqual([
      "sha256:5ff8f6d50d4998dc5e49d11e32b5b9b7408775ccf592f2972d714f5c175f4a18",
      "sha256:f2460596aac7f9173d34abab2c114a50809dbd7a808b0d37f214f921896e06c8",
      "sha256:02f3b7aa87bfe1ef1222b2e9072182260a1efd083e3ac753e29b411200b738ef",
      "sha256:bb7646f4fc85f58bc4c34e8fbe78d9b1f8593a0e4e70e652bfb22453acc208c2",
      "sha256:2076138a4c98d55125abbad9d6df73edefef22977ea904dc7c55d62b3e47113d",
      "sha256:e696022642d3d84c84ae2284bd445d5aeb69a7bde47017a2015ddb57acc2cbbb",
    ]);
  });
  it.each(["mafia-sleep", "don-identification"] as const)(
    "continues a restored %s explicitly without rewriting its recorded prefix",
    (phase) => {
      const prefix = ["mafia-sleep", "don-identification"].slice(
        0,
        phase === "mafia-sleep" ? 1 : 2,
      );
      const { game, entries } = chain(opening(), [
        ...prefix.map(
          (to) => ({ type: "phase.changed", payload: { to } }) as CanonicalGameEventDraft,
        ),
        { type: "phase.changed", payload: { to: "sheriff-identification" } },
        { type: "phase.changed", payload: { to: "day" } },
      ]);
      expect(entries[1]?.stateHashAfter).toBe(
        "sha256:f2460596aac7f9173d34abab2c114a50809dbd7a808b0d37f214f921896e06c8",
      );
      expect(game).toEqual(day());
    },
  );
  it("replays a separate Sheriff greeting followed directly by round zero", () => {
    const initial = opening();
    const { game, entries } = chain(initial, [
      { type: "phase.changed", payload: { to: "sheriff-identification" } },
      { type: "phase.changed", payload: { to: "day" } },
    ]);
    expect(entries).toHaveLength(3);
    expect(game).toEqual(day());
    expect(game).toMatchObject({ completedGameNights: 1, sheriffChecksPerformed: 0 });
    expect(game.players).toEqual(initial.players);
    for (const to of ["day", "free-seating", "night-mafia", "sheriff-wake"] as const) {
      expect(() =>
        applyGameEvent(initial, {
          type: "phase.changed",
          payload: { to },
        } as unknown as CanonicalGameEventDraft),
      ).toThrow();
    }
  });
  it("round-trips every accepted ordered call, clerical correction and reviewed count", () => {
    let game = day();
    game = applyGameEvent(game, {
      type: "player.nominated",
      payload: { nominatorSeat: 1, candidateSeat: 1 },
    });
    game = applyGameEvent(game, {
      type: "player.nominated",
      payload: { nominatorSeat: 2, candidateSeat: 2 },
    });
    const result = chain(game, [
      { type: "phase.changed", payload: { to: "voting" } },
      { type: "voting.order-announced", payload: {} },
      { type: "voting.order-announced", payload: {} },
      { type: "voting.candidate-inspected", payload: { candidateSeat: 2 } },
      { type: "voting.candidate-mentioned", payload: { candidateSeat: 1 } },
      { type: "voting.candidate-mentioned", payload: { candidateSeat: 1 } },
      { type: "vote.accepted", payload: { voterSeat: 1, candidateSeat: 1 } },
      { type: "voting.count-disputed", payload: { candidateSeat: 1, reason: "Missed hand" } },
      {
        type: "voting.count-ruled",
        payload: {
          voteAssignments: { 1: 1 },
          externalReviewAcknowledged: true,
          reason: "Final reviewed count",
        },
      },
      { type: "voting.candidate-stopped", payload: { candidateSeat: 1 } },
      {
        type: "vote.corrected",
        payload: { voterSeat: 1, candidateSeat: 2, reason: "Clerical slip" },
      },
      { type: "voting.live-advanced", payload: { candidateSeat: 2 } },
    ]);
    expect(result.game.voteAssignments).toEqual({ 1: 2 });
    expect(result.game.ballot?.reviewedCandidateSeats).toEqual([1]);
  });
  it("accepts current events and phases without engine metadata", () => {
    const event = { type: "best-move.number-accepted", payload: { seat: 1 } };
    expect(() => assertCanonicalGameEventDraft(event)).not.toThrow();
    expect(() => assertCanonicalGameEventDraft(event)).not.toThrow();
    expect(isSecretGameEventType(event.type)).toBe(true);
    expect(() =>
      assertCanonicalGameEventDraft({ type: "phase.changed", payload: { to: "free-seating" } }),
    ).not.toThrow();
    expect(() =>
      createInitialGameBaseline({ ...opening(), rulesEdition: undefined } as GameState),
    ).toThrow();
  });
  it("rejects invalid federation state instead of silently accepting defaults or profile fields", () => {
    const state = day();
    for (const invalid of [
      { ...state, completedGameNights: -1 },
      { ...state, sheriffChecksPerformed: 4 },
      { ...state, firstDayDepartureSeats: [1, 1] },
      { ...state, currentSpeechRestricted: "yes" },
      {
        ...state,
        adjudication: {
          losingTeam: "red",
          rule: "6.3.1",
          reason: "Ruling",
          committeeApproved: false,
          name: "Secret profile",
        },
      },
    ])
      expect(() => createInitialGameBaseline(invalid as GameState)).toThrow();
    const incomplete = { ...state, completedGameNights: undefined };
    expect(() => createInitialGameBaseline(incomplete as unknown as GameState)).toThrow();
  });
  it("retains reasoned adjudication through completion without changing player statuses", () => {
    const initial = day();
    const { game } = chain(initial, [
      {
        type: "game.adjudicated",
        payload: {
          losingTeam: "black",
          rule: "6.3.1",
          reason: "Referee disciplinary ruling",
          committeeApproved: false,
        },
      },
      { type: "game.completed", payload: { winner: "red" } },
    ]);
    expect(game.players).toEqual(initial.players);
    expect(game.adjudication?.reason).toBe("Referee disciplinary ruling");
  });
  it("round-trips secret accepted Best Move transcripts before the morning boundary", () => {
    const initial = day();
    const victim = initial.players.find((p) => p.team === "red")!.seat;
    const shots = initial.players
      .filter((p) => p.team === "black")
      .map((p) => ({ shooterSeat: p.seat, targetSeat: victim, secret: true as const }));
    const { game } = chain(initial, [
      { type: "phase.changed", payload: { to: "night-mafia" } },
      {
        type: "mafia.shots-resolved",
        payload: { shots, result: { kind: "kill", targetSeat: victim } },
      },
      { type: "phase.changed", payload: { to: "night-don" } },
      { type: "don.check-skipped", payload: {} },
      { type: "sheriff.check-skipped", payload: {} },
      { type: "phase.changed", payload: { to: "best-move" } },
      { type: "best-move.number-accepted", payload: { seat: victim } },
      { type: "best-move.number-accepted", payload: { seat: victim } },
      {
        type: "best-move.slip-corrected",
        payload: { index: 1, seat: 2, reason: "Obvious spoken slip" },
      },
      {
        type: "best-move.finalized",
        payload: { reason: "finished-early", readbackAcknowledged: true },
      },
      { type: "phase.changed", payload: { to: "goodbye-speech" } },
      { type: "phase.changed", payload: { to: "day" } },
    ]);
    expect(game).toMatchObject({
      day: 2,
      completedGameNights: 2,
      bestMove: { selectedSeats: [victim, 2], completionReason: "finished-early" },
    });
  });
  it("round-trips private removal observations and delayed public seat-only announcements", () => {
    const initial = day();
    const victim = initial.players.find((p) => p.team === "red")!.seat;
    const shots = initial.players
      .filter((p) => p.team === "black")
      .map((p) => ({ shooterSeat: p.seat, targetSeat: victim, secret: true as const }));
    const { game } = chain(initial, [
      { type: "phase.changed", payload: { to: "night-mafia" } },
      {
        type: "discipline.removal-observed",
        payload: {
          seat: victim,
          stage: "shooting-count",
          rule: "6.2.3",
          reason: "Night violation",
          checkInProgress: false,
        },
      },
      {
        type: "mafia.shots-resolved",
        payload: { shots, result: { kind: "kill", targetSeat: victim } },
      },
      { type: "discipline.removals-announced", payload: { seats: [victim] } },
    ]);
    expect(game.disciplinaryRemovals?.[0]).toMatchObject({
      shotDeath: true,
      departure: "departed",
      announcement: "announced",
    });
    expect(game.ballotCancellationDay).toBeUndefined();
    expect(isSecretGameEventType("discipline.removal-observed")).toBe(true);
    expect(isSecretGameEventType("discipline.removals-announced")).toBe(false);
  });
  it.each([
    { stage: "day-discussion", fourthFoul: false },
    { stage: "day-discussion", fourthFoul: true },
    { stage: "open-voting", fourthFoul: false },
    { stage: "open-voting", fourthFoul: true },
  ] as const)(
    "admits $stage removal (fourth foul: $fourthFoul) after the first nominee is removed",
    ({ stage, fourthFoul }) => {
      const initial = day();
      const removal = {
        seat: 2,
        stage,
        rule: fourthFoul ? "6.2.1" : "6.2.4",
        reason: fourthFoul ? "Fourth foul" : "Left the table without authorization",
        checkInProgress: false,
      } as const;
      const { game, entries } = chain(initial, [
        { type: "player.nominated", payload: { nominatorSeat: 1, candidateSeat: 2 } },
        { type: "player.nominated", payload: { nominatorSeat: 2, candidateSeat: 4 } },
        ...(fourthFoul
          ? [1, 2, 3].map(
              (foulNumber) =>
                ({
                  type: "foul.issued",
                  payload: { seat: 2, foulNumber, redCarded: false },
                }) as CanonicalGameEventDraft,
            )
          : []),
        ...(stage === "open-voting"
          ? [{ type: "phase.changed", payload: { to: "voting" } } as const]
          : []),
        fourthFoul
          ? {
              type: "discipline.foul-issued",
              payload: { seat: 2, foulNumber: 4, redCarded: true, removal },
            }
          : { type: "discipline.removal-observed", payload: removal },
      ]);
      expect(game.nominations).toEqual([{ nominatorSeat: 2, candidateSeat: 4, order: 1 }]);
      expect(game.players.find((p) => p.seat === 2)?.status).toBe("red-carded");
      expect(game).toMatchObject({
        phase: stage === "day-discussion" ? "day" : "voting-cancelled",
        ballotCancellationDay: initial.day,
        redCardIssuedThisDay: true,
        disciplinaryRemovals: [{ ...removal, departure: "departed", announcement: "pending" }],
      });
      expect(entries.at(-1)?.stateHashAfter).toBe(hashGameState(game));
      expect(() =>
        applyGameEvent(game, { type: "phase.changed", payload: { to: "night-mafia" } }),
      ).toThrow(/immediate public removal announcement/i);
      const announced = chain(game, [
        { type: "discipline.removals-announced", payload: { seats: [2] } },
        ...(stage === "day-discussion"
          ? [
              {
                type: "player.nominated",
                payload: { nominatorSeat: 3, candidateSeat: 5 },
              } as const,
              { type: "phase.changed", payload: { to: "voting-cancelled" } } as const,
            ]
          : []),
      ]);
      expect(announced.game).toMatchObject({
        phase: "voting-cancelled",
        ballotCancellationDay: initial.day,
        votingCancellation: { reason: "red-card" },
        disciplinaryRemovals: [{ announcement: "announced" }],
      });
      expect(announced.game.nominations).toEqual([
        { nominatorSeat: 2, candidateSeat: 4, order: 1 },
        ...(stage === "day-discussion" ? [{ nominatorSeat: 3, candidateSeat: 5, order: 2 }] : []),
      ]);
      const night = chain(announced.game, [
        { type: "phase.changed", payload: { to: "night-mafia" } },
      ]);
      expect(night.game.ballotCancellationDay).toBeUndefined();
      expect(night.entries.at(-1)?.stateHashAfter).toBe(hashGameState(night.game));
    },
  );
  it("rejects impossible paused-ballot snapshots and unreasoned removal metadata", () => {
    const initial = day();
    expect(() =>
      createInitialGameBaseline({
        ...initial,
        disciplinaryRemovals: [{ seat: 1, rule: "bad" }],
      } as unknown as GameState),
    ).toThrow();
    expect(() =>
      assertCanonicalGameEventDraft({
        type: "discipline.removal-observed",
        payload: {
          seat: 1,
          stage: "shooting-count",
          rule: "6.2.3",
          reason: "Night violation",
          checkInProgress: false,
          profile: "Copied name",
        },
      }),
    ).toThrow();
  });
  it("replays a fourth foul with a reasoned occurrence observation without engine dispatch", () => {
    const initial = day();
    const { game } = chain(initial, [
      { type: "foul.issued", payload: { seat: 1, foulNumber: 1, redCarded: false } },
      { type: "foul.issued", payload: { seat: 1, foulNumber: 2, redCarded: false } },
      { type: "foul.issued", payload: { seat: 1, foulNumber: 3, redCarded: false } },
      { type: "phase.changed", payload: { to: "night-mafia" } },
      {
        type: "discipline.foul-issued",
        payload: {
          seat: 1,
          foulNumber: 4,
          redCarded: true,
          removal: {
            seat: 1,
            stage: "before-shooting-count",
            rule: "6.2.1",
            reason: "Fourth foul",
            checkInProgress: false,
          },
        },
      },
    ]);
    expect(game).toMatchObject({
      ballotCancellationDay: 2,
      disciplinaryRemovals: [{ rule: "6.2.1" }],
    });
    const event = {
      type: "discipline.foul-issued",
      payload: {
        seat: 1,
        foulNumber: 4,
        redCarded: true,
        removal: {
          seat: 1,
          stage: "before-shooting-count",
          rule: "6.2.1",
          reason: "Fourth foul",
          checkInProgress: false,
        },
      },
    };
    expect(() => assertCanonicalGameEventDraft(event)).not.toThrow();
  });
  it("does not advance a paused live ballot by synthetic discipline context or phase change", () => {
    let game = day();
    game = applyGameEvent(game, {
      type: "player.nominated",
      payload: { nominatorSeat: 1, candidateSeat: 1 },
    });
    game = applyGameEvent(game, {
      type: "player.nominated",
      payload: { nominatorSeat: 2, candidateSeat: 2 },
    });
    game = chain(game, [
      { type: "phase.changed", payload: { to: "voting" } },
      { type: "voting.order-announced", payload: {} },
      { type: "voting.order-announced", payload: {} },
      { type: "voting.candidate-mentioned", payload: { candidateSeat: 1 } },
      { type: "voting.candidate-mentioned", payload: { candidateSeat: 1 } },
      { type: "voting.count-disputed", payload: { candidateSeat: 1, reason: "Disputed hand" } },
    ]).game;
    expect(() =>
      applyGameEvent(game, {
        type: "foul.issued",
        payload: { seat: 3, foulNumber: 1, redCarded: false, phase: "voting", currentTurnIndex: 1 },
      }),
    ).toThrow();
    expect(() =>
      applyGameEvent(game, { type: "phase.changed", payload: { to: "night-mafia" } }),
    ).toThrow();
    expect(() =>
      applyGameEvent(game, { type: "phase.changed", payload: { to: "car-crash-decision" } }),
    ).toThrow();
  });
  it("round-trips the automatic planning-plus-two-miss draw basis", () => {
    const initial = day();
    const night: CanonicalGameEventDraft[] = [
      { type: "phase.changed", payload: { to: "night-mafia" } },
      { type: "mafia.shots-resolved", payload: { shots: [], result: { kind: "miss" } } },
      { type: "phase.changed", payload: { to: "night-don" } },
      { type: "don.check-skipped", payload: {} },
      { type: "sheriff.check-skipped", payload: {} },
    ];
    const { game } = chain(initial, [
      ...night,
      { type: "phase.changed", payload: { to: "day" } },
      ...night,
      { type: "phase.changed", payload: { to: "draw" } },
    ]);
    expect(game).toMatchObject({
      phase: "draw",
      rulesDrawReason: { rule: "6.5.6", completedGameNights: 3, consecutiveUnchangedNights: 3 },
    });
    expect(() =>
      createInitialGameBaseline({
        ...game,
        rulesDrawReason: { ...game.rulesDrawReason!, completedGameNights: 2 },
      }),
    ).toThrow();
  });
  it("canonical replay retains pending nearest-speech entitlement without retroactively shortening", () => {
    const initial = day();
    const { game } = chain(initial, [
      { type: "foul.issued", payload: { seat: 3, foulNumber: 1, redCarded: false } },
      { type: "foul.issued", payload: { seat: 3, foulNumber: 2, redCarded: false } },
      { type: "foul.issued", payload: { seat: 3, foulNumber: 3, redCarded: false } },
      { type: "turn.completed", payload: { seat: 1 } },
      { type: "turn.completed", payload: { seat: 2 } },
    ]);
    expect(game).toMatchObject({ currentSpeechRestricted: true, currentTurnIndex: 2 });
    const consumed = chain(game, [{ type: "turn.completed", payload: { seat: 3 } }]).game;
    expect(consumed.players.find((p) => p.seat === 3)?.mutePending).toBe(false);
  });
  it("rejects a ballot checkpoint whose accepted STOP prefix or voter eligibility contradicts live state", () => {
    let game = day();
    game = applyGameEvent(game, {
      type: "player.nominated",
      payload: { nominatorSeat: 1, candidateSeat: 1 },
    });
    game = applyGameEvent(game, {
      type: "player.nominated",
      payload: { nominatorSeat: 2, candidateSeat: 2 },
    });
    game = chain(game, [
      { type: "phase.changed", payload: { to: "voting" } },
      { type: "voting.order-announced", payload: {} },
      { type: "voting.order-announced", payload: {} },
      { type: "voting.candidate-mentioned", payload: { candidateSeat: 1 } },
      { type: "voting.candidate-mentioned", payload: { candidateSeat: 1 } },
      { type: "voting.candidate-stopped", payload: { candidateSeat: 1 } },
    ]).game;
    expect(() =>
      createInitialGameBaseline({
        ...game,
        ballot: { ...game.ballot!, acceptedCandidateSeats: [2] },
      }),
    ).toThrow();
    expect(() => createInitialGameBaseline({ ...game, voteAssignments: { 1: 3 } })).toThrow();
    expect(() =>
      createInitialGameBaseline({
        ...game,
        ballot: { ...game.ballot!, dispute: { candidateSeat: 2, reason: "Not yet called" } },
      }),
    ).toThrow();
  });
  it("validates completed Best Move scoring from accepted transcript rather than trusting a forged total", () => {
    const initial = day();
    const victim = initial.players.find((p) => p.team === "red")!.seat;
    const shots = initial.players
      .filter((p) => p.team === "black")
      .map((p) => ({ shooterSeat: p.seat, targetSeat: victim, secret: true as const }));
    const { game } = chain(initial, [
      { type: "phase.changed", payload: { to: "night-mafia" } },
      {
        type: "mafia.shots-resolved",
        payload: { shots, result: { kind: "kill", targetSeat: victim } },
      },
      { type: "phase.changed", payload: { to: "night-don" } },
      { type: "don.check-skipped", payload: {} },
      { type: "sheriff.check-skipped", payload: {} },
      { type: "phase.changed", payload: { to: "best-move" } },
      { type: "best-move.number-accepted", payload: { seat: victim } },
      {
        type: "best-move.finalized",
        payload: { reason: "finished-early", readbackAcknowledged: true },
      },
    ]);
    expect(game.bestMove?.mafiaHits).toBe(0);
    expect(() =>
      createInitialGameBaseline({ ...game, bestMove: { ...game.bestMove!, mafiaHits: 3 } }),
    ).toThrow();
  });
  it("cannot rewrite accepted assignments in a v2 resolution summary", () => {
    const game = day();
    expect(() =>
      applyGameEvent(game, {
        type: "voting.resolved",
        payload: {
          voteAssignments: { 1: 1 },
          result: { kind: "winner", seats: [1], totals: { 1: 1 } },
        },
      }),
    ).toThrow();
    expect(hashGameState(game)).toBe(hashGameState(structuredClone(game)));
  });
});
