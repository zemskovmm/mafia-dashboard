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
  FEDERATION_RULES_EDITION,
  hashGameState,
  isSecretGameEventType,
  replayGameLog,
} from "./index.js";
import type { CanonicalGameEventDraft, GameLogEntry, GameState } from "./index.js";
const opening = (): GameState => {
  let setup = beginRoleDraw(
    createSetup(
      Array.from({ length: 10 }, (_, i) => ({ id: `p${i + 1}`, seat: i + 1 })),
      { rulesEdition: FEDERATION_RULES_EDITION },
    ),
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
  it("v2-only events and phases never expand the accepted v1 contract", () => {
    const event = { type: "best-move.number-accepted", payload: { seat: 1 } };
    expect(() => assertCanonicalGameEventDraft(event, 1)).toThrow();
    expect(() => assertCanonicalGameEventDraft(event, 2)).not.toThrow();
    expect(isSecretGameEventType(event.type)).toBe(true);
    expect(() =>
      assertCanonicalGameEventDraft({ type: "phase.changed", payload: { to: "free-seating" } }, 1),
    ).toThrow();
    expect(() => createInitialGameBaseline({ ...opening(), rulesEdition: undefined })).toThrow();
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
    const legacy = { ...state } as { rulesEdition?: string } & GameState;
    delete legacy.rulesEdition;
    expect(() => createInitialGameBaseline(legacy)).toThrow();
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
      assertCanonicalGameEventDraft(
        {
          type: "discipline.removal-observed",
          payload: {
            seat: 1,
            stage: "shooting-count",
            rule: "6.2.3",
            reason: "Night violation",
            checkInProgress: false,
            profile: "Copied name",
          },
        },
        2,
      ),
    ).toThrow();
  });
  it("replays a fourth foul with a reasoned occurrence observation and rejects v1 expansion", () => {
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
    expect(() => assertCanonicalGameEventDraft(event, 1)).toThrow();
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
