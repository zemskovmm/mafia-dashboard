import { describe, expect, it } from "vitest";
import { CASPER_NAME, CASPER_PLAYER_ID, CASPER_SEAT } from "./casper.js";
import { advanceVotingCandidate, completeCurrentTurn } from "./day-actions.js";
import { advanceSetupPhase, createGame, evaluateVictory, markPlayerInactive } from "./game.js";
import {
  applyCurrentGameLogEntry,
  applyGameEvent,
  canonicalGameEventTypes,
  canonicalSecretGameEventTypes,
  createGameLogEntry,
  hashGameState,
  isMeaningfulGameEventDraft,
  isProvisionalInteractionType,
  isSecretGameEventType,
  replayGameLog,
  tryApplyGameEvent,
  type CanonicalGameEventDraft,
  type GameLogEntry,
  type InitialGameBaseline,
} from "./game-events.js";
import * as gameEvents from "./game-events.js";
import { GameRuleError } from "./rule-error.js";
import {
  beginRoleDraw,
  completeRoleDraw,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
} from "./setup.js";
import {
  completeMafiaShots,
  completeNight,
  resolveMafiaShots,
  toggleAllMafiaShotsForTarget,
} from "./night-actions.js";
import type { GameState, PlayerInput, SetupState } from "./types.js";

const players = (): PlayerInput[] =>
  Array.from({ length: 10 }, (_, index) => ({
    id: `player-${index + 1}`,
    name: `Player ${index + 1}`,
    seat: index + 1,
  }));

const completedSetup = (): SetupState => {
  let setup = beginRoleDraw(createSetup(players()), createSeededRandom(41));
  for (let seat = 1; seat <= 10; seat += 1) setup = drawRoleForSeat(setup, seat);
  return completeRoleDraw(setup);
};

const planningGame = (): GameState => createGame(completedSetup());
const dayOne = (): GameState => advanceSetupPhase(advanceSetupPhase(planningGame()));

const baseline = (game = dayOne()): InitialGameBaseline => ({
  replayVersion: 1,
  game,
});

const id = (sequence: number) => `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;

const entry = (
  game: GameState,
  sequence: number,
  draft: CanonicalGameEventDraft,
  parentEventId: string | null = sequence === 1 ? null : id(sequence - 1),
) =>
  createGameLogEntry({
    gameId: "00000000-0000-4000-8000-000000000999",
    id: id(sequence),
    sequence,
    parentEventId,
    createdAt: new Date(Date.UTC(2026, 7, 24, 20, sequence)).toISOString(),
    before: game,
    draft,
  });

describe("canonical game replay", () => {
  it("replays Casper speaking, voting, and being eliminated under ordinary rules", () => {
    const roster = players().map((player) =>
      player.seat === CASPER_SEAT
        ? { id: CASPER_PLAYER_ID, name: CASPER_NAME, seat: CASPER_SEAT }
        : player,
    );
    let setup = beginRoleDraw(createSetup(roster), createSeededRandom(41));
    for (let seat = 1; seat < CASPER_SEAT; seat += 1) setup = drawRoleForSeat(setup, seat);
    const initial = createGame(completeRoleDraw(setup));
    const events: GameLogEntry[] = [];
    let current = initial;
    const append = (draft: CanonicalGameEventDraft) => {
      const next = entry(current, events.length + 1, draft);
      events.push(next.entry);
      current = next.after;
    };
    append({ type: "game.started", payload: {} });
    append({ type: "phase.changed", payload: { to: "day" } });
    expect(current.turnOrder).toContain(CASPER_SEAT);
    append({ type: "player.nominated", payload: { nominatorSeat: 1, candidateSeat: CASPER_SEAT } });
    append({ type: "player.nominated", payload: { nominatorSeat: CASPER_SEAT, candidateSeat: 1 } });
    const votes = Object.fromEntries(current.players.map(({ seat }) => [seat, CASPER_SEAT]));
    append({
      type: "voting.resolved",
      payload: {
        voteAssignments: votes,
        result: { kind: "winner", seats: [CASPER_SEAT], totals: { [CASPER_SEAT]: 10, 1: 0 } },
      },
    });
    expect(current.players.find(({ id }) => id === CASPER_PLAYER_ID)?.status).toBe("eliminated");
    expect(current.winner).toBeNull();
    const restored = replayGameLog(
      { replayVersion: 1, game: initial },
      JSON.parse(JSON.stringify(events)) as GameLogEntry[],
    );
    expect(restored.game).toEqual(current);
    expect(restored.frames).toHaveLength(events.length);
    expect(evaluateVictory(restored.game.players)).toBeNull();
    let redWin = restored.game;
    for (const { seat } of redWin.players.filter(({ team }) => team === "black")) {
      redWin = markPlayerInactive(redWin, seat, "eliminated");
    }
    expect(evaluateVictory(redWin.players)).toBe("red");
  });

  it("rejects an invalid synthetic identity in a replay baseline, even with no events", () => {
    const initial = dayOne();
    const casperAtOne = {
      ...initial,
      players: initial.players.map((player) =>
        player.seat === 1 ? { ...player, id: CASPER_PLAYER_ID, name: CASPER_NAME } : player,
      ),
    };
    expect(() => replayGameLog(baseline(casperAtOne), [])).toThrow(/Casper.*seat 10/i);
    const casperMafia = {
      ...initial,
      players: initial.players.map((player) =>
        player.role === "mafia" ? { ...player, id: CASPER_PLAYER_ID, name: CASPER_NAME } : player,
      ),
    };
    expect(() => replayGameLog(baseline(casperMafia), [])).toThrow();
    const wrongRole = {
      ...initial,
      players: initial.players.map((player) =>
        player.seat === CASPER_SEAT
          ? {
              ...player,
              id: CASPER_PLAYER_ID,
              name: CASPER_NAME,
              role: "mafia" as const,
              team: "black" as const,
            }
          : player,
      ),
    };
    expect(() => replayGameLog(baseline(wrongRole), [])).toThrow(/Casper.*citizen/i);
    const realNamedCasper = {
      ...initial,
      players: initial.players.map((player) =>
        player.seat === 10 ? { ...player, name: CASPER_NAME } : player,
      ),
    };
    expect(replayGameLog(baseline(realNamedCasper), []).game).toEqual(realNamedCasper);
  });
  it.each([
    [{ phaseBefore: "voting" }, "history.before_state"],
    [{ dayAfter: 99 }, "history.after_state"],
    [{ parentEventId: id(99) }, "history.parent_link"],
    [{ createdAt: "PRIVATE-CANARY" }, "history.invalid_event"],
  ] as const)("labels replay failure %j at its active position", (change, code) => {
    const initial = baseline();
    const root = entry(initial.game, 1, { type: "game.checkpointed", payload: {} });
    expect(() => replayGameLog(initial, [{ ...root.entry, ...change }])).toThrow(
      expect.objectContaining({ diagnostic: { code, replayIndex: 0 } }),
    );
  });

  it("labels action application failures without classifying their private exception text", () => {
    const initial = baseline();
    const root = entry(initial.game, 1, { type: "game.checkpointed", payload: {} });
    const next = entry(root.after, 2, { type: "turn.completed", payload: { seat: 1 } });
    const invalid = { ...next.entry, payload: { seat: 2 } } as GameLogEntry;
    expect(() => replayGameLog(initial, [root.entry, invalid])).toThrow(
      expect.objectContaining({ diagnostic: { code: "history.action_failed", replayIndex: 1 } }),
    );
  });

  it("identifies a replay hash failure without including event values in diagnostics", () => {
    const initial = baseline();
    const root = entry(initial.game, 1, { type: "game.checkpointed", payload: {} });
    const invalid = { ...root.entry, stateHashAfter: hashGameState({ ...initial.game, day: 2 }) };
    let failure: unknown;
    try {
      replayGameLog(initial, [invalid]);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      message: `State hash mismatch at event ${invalid.id}`,
      diagnostic: { code: "history.hash_mismatch", replayIndex: 0 },
    });
  });

  it("derives secrecy from event type and fails closed for unknown types", () => {
    const secrecy = (
      gameEvents as typeof gameEvents & {
        readonly canonicalGameEventSecrecy?: Readonly<Record<string, boolean>>;
      }
    ).canonicalGameEventSecrecy;

    expect(secrecy).toBeDefined();
    if (secrecy === undefined) return;
    expect(Object.keys(secrecy)).toEqual([...canonicalGameEventTypes]);
    const secretTypes = new Set<string>(canonicalSecretGameEventTypes);
    for (const type of canonicalGameEventTypes) {
      expect(isSecretGameEventType(type)).toBe(secrecy[type]);
      expect(secretTypes.has(type)).toBe(secrecy[type]);
    }
    expect(isSecretGameEventType("legacy.unknown")).toBe(true);
  });

  it("classifies only meaningful semantic checkpoints as persistable history", () => {
    expect(
      isMeaningfulGameEventDraft({
        type: "turn.completed",
        payload: { seat: 1 },
      }),
    ).toBe(false);
    for (const to of [
      "sheriff-wake",
      "voting-cancelled",
      "night-don",
      "night-sheriff",
      "best-move",
    ] as const) {
      expect(isMeaningfulGameEventDraft({ type: "phase.changed", payload: { to } })).toBe(false);
    }
    expect(
      isMeaningfulGameEventDraft({
        type: "phase.changed",
        payload: { to: "night-mafia" },
      }),
    ).toBe(true);
    expect(
      isMeaningfulGameEventDraft({
        type: "player.nominated",
        payload: { nominatorSeat: 3, candidateSeat: 4 },
      }),
    ).toBe(true);
  });

  it("folds omitted intermediate turns and private-phase advances into semantic checkpoints", () => {
    const nominated = applyGameEvent(dayOne(), {
      type: "player.nominated",
      payload: { nominatorSeat: 3, candidateSeat: 4 },
    });
    expect(nominated.currentTurnIndex).toBe(2);
    expect(nominated.nominations).toEqual([{ nominatorSeat: 3, candidateSeat: 4, order: 1 }]);

    const day = applyGameEvent(planningGame(), {
      type: "phase.changed",
      payload: { to: "day" },
    });
    expect(day).toMatchObject({ phase: "day", day: 1 });

    const night: GameState = { ...dayOne(), phase: "night-mafia", day: 1 };
    const mafiaPlayers = night.players.filter(
      ({ status, team }) => status === "active" && team === "black",
    );
    const target = night.players.find(({ team, role }) => team === "red" && role !== "sheriff")!;
    const mafiaResult = applyGameEvent(night, {
      type: "mafia.shots-resolved",
      payload: {
        shots: mafiaPlayers.map(({ seat }) => ({
          shooterSeat: seat,
          targetSeat: target.seat,
          secret: true,
        })),
        result: { kind: "kill", targetSeat: target.seat },
      },
    });
    const sheriff = mafiaResult.players.find(({ role }) => role === "sheriff")!;
    const donResult = applyGameEvent(mafiaResult, {
      type: "don.checked",
      payload: { targetSeat: sheriff.seat, match: true },
    });
    expect(donResult.phase).toBe("night-don-result");

    const mafia = donResult.players.find(
      ({ team, status }) => team === "black" && status === "active",
    )!;
    const sheriffResult = applyGameEvent(donResult, {
      type: "sheriff.checked",
      payload: { targetSeat: mafia.seat, match: true },
    });
    expect(sheriffResult.phase).toBe("night-sheriff-result");

    const resolution = {
      ...dayOne(),
      day: 1,
      phase: "night-resolution" as const,
      players: dayOne().players.map((player) =>
        player.seat === target.seat ? { ...player, status: "eliminated" as const } : player,
      ),
      nightResult: { kind: "kill" as const, targetSeat: target.seat },
    };
    const selectedSeats = resolution.players
      .filter(({ status }) => status === "active")
      .slice(0, 3)
      .map(({ seat }) => seat);
    const mafiaHits = selectedSeats.filter(
      (seat) => resolution.players.find((player) => player.seat === seat)?.team === "black",
    ).length;
    const bestMove = applyGameEvent(resolution, {
      type: "best-move.completed",
      payload: { playerSeat: target.seat, selectedSeats, mafiaHits },
    });
    expect(bestMove).toMatchObject({ phase: "goodbye-speech", day: 2 });
  });

  it("folds omitted no-nomination day turns into the Mafia shot checkpoint", () => {
    const canonical = dayOne();
    let displayed = canonical;
    while (displayed.phase === "day") displayed = completeCurrentTurn(displayed);
    const target = displayed.players.find(
      ({ team, status }) => team === "red" && status === "active",
    )!;
    displayed = toggleAllMafiaShotsForTarget(displayed, target.seat);
    const resolution = resolveMafiaShots(displayed);
    const draft: CanonicalGameEventDraft = {
      type: "mafia.shots-resolved",
      payload: { shots: resolution.secretShots, result: resolution.result },
    };

    expect(applyGameEvent(canonical, draft)).toEqual(applyGameEvent(displayed, draft));
    expect(applyGameEvent(canonical, draft)).toMatchObject({
      phase: "night-mafia-result",
      shotAssignments: Object.fromEntries(
        resolution.secretShots.map(({ shooterSeat, targetSeat }) => [shooterSeat, targetSeat]),
      ),
      players: expect.arrayContaining([
        expect.objectContaining({ seat: target.seat, status: "active" }),
      ]),
    });
  });

  it("suppresses a muted voting winner's goodbye in canonical event application", () => {
    let initial = dayOne();
    const candidate = initial.players.find(({ role }) => role === "citizen")!;
    for (let foulNumber = 1; foulNumber <= 3; foulNumber += 1) {
      initial = applyGameEvent(initial, {
        type: "foul.issued",
        payload: { seat: candidate.seat, foulNumber, redCarded: false },
      });
    }
    const voteAssignments = Object.fromEntries(
      initial.players.map(({ seat }) => [seat, candidate.seat]),
    );
    const voting: GameState = {
      ...initial,
      phase: "voting",
      nominations: [{ nominatorSeat: 1, candidateSeat: candidate.seat, order: 1 }],
      turnOrder: [candidate.seat],
      currentTurnIndex: 0,
      voteAssignments,
      votingRound: "initial",
    };

    const draft: CanonicalGameEventDraft = {
      type: "voting.resolved",
      payload: {
        voteAssignments,
        result: {
          kind: "winner",
          seats: [candidate.seat],
          totals: { [candidate.seat]: initial.players.length },
        },
      },
    };
    const corrected = applyGameEvent(voting, draft);
    expect(corrected).toMatchObject({
      phase: "night-mafia",
      goodbyeSeats: undefined,
      goodbyeNext: undefined,
      players: expect.arrayContaining([
        expect.objectContaining({ seat: candidate.seat, status: "eliminated" }),
      ]),
    });
    const root = entry(voting, 1, { type: "game.checkpointed", payload: {} });
    const resolved = entry(root.after, 2, draft, root.entry.id);
    expect(applyCurrentGameLogEntry(root.after, resolved.entry)).toEqual(corrected);
    expect(replayGameLog(baseline(voting), [root.entry, resolved.entry]).game).toEqual(corrected);
  });

  it("rejects persisted snapshots that retain a muted goodbye speaker", () => {
    const initial = dayOne();
    const candidate = initial.players.find(({ role }) => role === "citizen")!;
    const voteAssignments = Object.fromEntries(
      initial.players.map(({ seat }) => [seat, candidate.seat]),
    );
    const voting: GameState = {
      ...initial,
      phase: "voting",
      players: initial.players.map((player) =>
        player.seat === candidate.seat ? { ...player, mutePending: true } : player,
      ),
      nominations: [{ nominatorSeat: 1, candidateSeat: candidate.seat, order: 1 }],
      turnOrder: [candidate.seat],
      currentTurnIndex: 0,
      voteAssignments,
      votingRound: "initial",
    };
    const root = entry(voting, 1, { type: "game.checkpointed", payload: {} });
    const draft: CanonicalGameEventDraft = {
      type: "voting.resolved",
      payload: {
        voteAssignments,
        result: {
          kind: "winner",
          seats: [candidate.seat],
          totals: { [candidate.seat]: initial.players.length },
        },
      },
    };
    const current = entry(root.after, 2, draft, root.entry.id);
    const oldAfter: GameState = {
      ...markPlayerInactive(root.after, candidate.seat, "eliminated"),
      phase: "goodbye-speech",
      goodbyeSeats: [candidate.seat],
      goodbyeNext: "night",
    };
    const storedEntry: GameLogEntry = {
      ...current.entry,
      phaseAfter: oldAfter.phase,
      stateHashAfter: hashGameState(oldAfter),
    };

    expect(() => replayGameLog(baseline(voting), [root.entry, storedEntry])).toThrow(
      /phase\/day metadata/i,
    );
    expect(() => applyCurrentGameLogEntry(root.after, storedEntry)).toThrow(
      /current rule semantics/i,
    );
  });

  it("rejects persisted day transitions that retain expired mutes", () => {
    const initial = dayOne();
    const before: GameState = {
      ...initial,
      phase: "night-resolution",
      players: initial.players.map((player) =>
        player.seat === 2 || player.seat === 7 ? { ...player, mutePending: true } : player,
      ),
      nightResult: { kind: "miss" },
    };
    const root = entry(before, 1, { type: "game.checkpointed", payload: {} });
    const current = entry(
      root.after,
      2,
      { type: "phase.changed", payload: { to: "day" } },
      root.entry.id,
    );
    expect(replayGameLog(baseline(before), [root.entry, current.entry]).game).toEqual(
      current.after,
    );
    const oldAfter: GameState = {
      ...current.after,
      players: current.after.players.map((player) =>
        player.seat === 2 || player.seat === 7 ? { ...player, mutePending: true } : player,
      ),
    };
    const storedEntry: GameLogEntry = {
      ...current.entry,
      stateHashAfter: hashGameState(oldAfter),
    };

    expect(() => replayGameLog(baseline(before), [root.entry, storedEntry])).toThrow(
      /state hash mismatch/i,
    );
  });

  it("replays a new day from the persisted actual opening seat", () => {
    const initial = advanceSetupPhase(
      advanceSetupPhase(markPlayerInactive(planningGame(), 2, "eliminated")),
    );
    const before: GameState = { ...initial, phase: "night-resolution" };
    const root = entry(before, 1, { type: "game.checkpointed", payload: {} });
    const nextDay = entry(
      root.after,
      2,
      { type: "phase.changed", payload: { to: "day" } },
      root.entry.id,
    );

    expect(nextDay.after).toMatchObject({ day: 2, dayOpeningSeat: 3 });
    expect(nextDay.after.turnOrder).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 1]);
    expect(replayGameLog(baseline(before), [root.entry, nextDay.entry]).game).toEqual(
      nextDay.after,
    );
  });

  it("rejects persisted day transitions without the current opening cursor", () => {
    const initial = advanceSetupPhase(
      advanceSetupPhase(markPlayerInactive(planningGame(), 2, "eliminated")),
    );
    const dayTwo = completeNight({ ...initial, phase: "night-resolution" });
    const before: GameState = { ...dayTwo, phase: "night-resolution" };
    delete (before as { dayOpeningSeat?: number }).dayOpeningSeat;
    const root = entry(before, 1, { type: "game.checkpointed", payload: {} });
    const current = entry(
      root.after,
      2,
      { type: "phase.changed", payload: { to: "day" } },
      root.entry.id,
    );
    const oldAfter: GameState = {
      ...current.after,
      turnOrder: [3, 4, 5, 6, 7, 8, 9, 10, 1],
    };
    delete (oldAfter as { dayOpeningSeat?: number }).dayOpeningSeat;
    const storedEntry = { ...current.entry, stateHashAfter: hashGameState(oldAfter) };

    expect(() => replayGameLog(baseline(before), [root.entry, storedEntry])).toThrow(
      /state hash mismatch/i,
    );
  });

  it("rejects persisted night transitions without the current eligibility snapshot", () => {
    const before = dayOne();
    const root = entry(before, 1, { type: "game.checkpointed", payload: {} });
    const current = entry(
      root.after,
      2,
      { type: "phase.changed", payload: { to: "night-mafia" } },
      root.entry.id,
    );
    const oldAfter = { ...current.after };
    delete (oldAfter as { nightCheckEligibility?: unknown }).nightCheckEligibility;
    const storedEntry = { ...current.entry, stateHashAfter: hashGameState(oldAfter) };

    expect(() => replayGameLog(baseline(before), [root.entry, storedEntry])).toThrow(
      /state hash mismatch/i,
    );
    expect(() => applyCurrentGameLogEntry(root.after, storedEntry)).toThrow(
      /current rule semantics/i,
    );
  });

  it("rejects check-skip routing to a red-carded Sheriff without an eligibility snapshot", () => {
    const base = dayOne();
    const before: GameState = {
      ...base,
      phase: "night-don",
      players: base.players.map((player) =>
        player.role === "don" || player.role === "sheriff"
          ? { ...player, status: "red-carded" }
          : player,
      ),
    };
    const root = entry(before, 1, { type: "game.checkpointed", payload: {} });
    const afterDon = { ...root.after, phase: "night-sheriff" as const };
    const donSkip: GameLogEntry = {
      type: "don.check-skipped",
      payload: {},
      replayVersion: 1,
      id: id(2),
      gameId: root.entry.gameId,
      sequence: 2,
      parentEventId: root.entry.id,
      phaseBefore: "night-don",
      phaseAfter: "night-sheriff",
      dayBefore: before.day,
      dayAfter: before.day,
      stateHashAfter: hashGameState(afterDon),
      createdAt: "2026-08-24T20:02:00.000Z",
    };
    expect(() => replayGameLog(baseline(before), [root.entry, donSkip])).toThrow(
      /phase\/day metadata/i,
    );
    expect(() => applyCurrentGameLogEntry(root.after, donSkip)).toThrow(/current rule semantics/i);
  });

  it("rejects private-phase routing for a previously red-carded Don", () => {
    const before = markPlayerInactive(
      dayOne(),
      dayOne().players.find(({ role }) => role === "don")!.seat,
      "red-carded",
    );
    const root = entry(before, 1, { type: "game.checkpointed", payload: {} });
    const currentNight = entry(
      root.after,
      2,
      { type: "phase.changed", payload: { to: "night-mafia" } },
      root.entry.id,
    );
    const mafiaResult = entry(
      currentNight.after,
      3,
      { type: "mafia.shots-resolved", payload: { shots: [], result: { kind: "miss" } } },
      currentNight.entry.id,
    );
    const modernAfter = completeMafiaShots(mafiaResult.after);
    expect(modernAfter.phase).toBe("night-sheriff");
    const oldAfter = { ...modernAfter, phase: "night-don" as const };
    const transition: GameLogEntry = {
      type: "phase.changed",
      payload: { to: "night-don" },
      replayVersion: 1,
      id: id(4),
      gameId: root.entry.gameId,
      sequence: 4,
      parentEventId: mafiaResult.entry.id,
      phaseBefore: "night-mafia-result",
      phaseAfter: "night-don",
      dayBefore: before.day,
      dayAfter: before.day,
      stateHashAfter: hashGameState(oldAfter),
      createdAt: "2026-08-24T20:04:00.000Z",
    };

    expect(() =>
      replayGameLog(baseline(before), [
        root.entry,
        currentNight.entry,
        mafiaResult.entry,
        transition,
      ]),
    ).toThrow(/cannot replay a phase change/i);
  });

  it("replays checks and skips on successive nights after both owners died", () => {
    let game = dayOne();
    const don = game.players.find(({ role }) => role === "don")!;
    const sheriff = game.players.find(({ role }) => role === "sheriff")!;
    game = markPlayerInactive(
      markPlayerInactive(game, don.seat, "eliminated"),
      sheriff.seat,
      "eliminated",
    );
    const initial = baseline(game);
    const events: GameLogEntry[] = [];
    const append = (draft: CanonicalGameEventDraft) => {
      const next = entry(game, events.length + 1, draft);
      events.push(next.entry);
      game = next.after;
      expect(replayGameLog(initial, JSON.parse(JSON.stringify(events))).game).toEqual(game);
    };
    append({ type: "game.checkpointed", payload: {} });
    for (let night = 0; night < 2; night += 1) {
      append({ type: "phase.changed", payload: { to: "night-mafia" } });
      append({ type: "mafia.shots-resolved", payload: { shots: [], result: { kind: "miss" } } });
      append({ type: "phase.changed", payload: { to: "night-don" } });
      if (night === 0) {
        append({ type: "don.checked", payload: { targetSeat: sheriff.seat, match: true } });
        expect(game.checkResult?.secret).toBe(true);
        append({ type: "phase.changed", payload: { to: "night-sheriff" } });
        expect(game.checkResult).toBeUndefined();
        append({ type: "sheriff.checked", payload: { targetSeat: don.seat, match: true } });
        expect(game.checkResult?.secret).toBe(true);
        append({ type: "phase.changed", payload: { to: "night-resolution" } });
      } else {
        append({ type: "don.check-skipped", payload: {} });
        append({ type: "sheriff.check-skipped", payload: {} });
      }
      append({ type: "phase.changed", payload: { to: "day" } });
      expect(game.checkResult).toBeUndefined();
      expect(game.players).toEqual(initial.game.players);
    }
  });

  it("rejects old night-transition hashes that excluded deceased check owners", () => {
    const before = markPlayerInactive(
      dayOne(),
      dayOne().players.find(({ role }) => role === "don")!.seat,
      "eliminated",
    );
    const root = entry(before, 1, { type: "game.checkpointed", payload: {} });
    const night = entry(root.after, 2, { type: "phase.changed", payload: { to: "night-mafia" } });
    const oldAfter = { ...night.after, nightCheckEligibility: { don: false, sheriff: true } };
    const storedEntry = { ...night.entry, stateHashAfter: hashGameState(oldAfter) };
    expect(() => replayGameLog(baseline(before), [root.entry, storedEntry])).toThrow(
      /state hash mismatch/i,
    );
    expect(() => applyCurrentGameLogEntry(root.after, storedEntry)).toThrow(
      /current rule semantics/i,
    );
  });

  it("replays same-night killed role checks exactly through the canonical chain", () => {
    const root = entry(dayOne(), 1, { type: "game.checkpointed", payload: {} });
    const night = entry(
      root.after,
      2,
      { type: "phase.changed", payload: { to: "night-mafia" } },
      root.entry.id,
    );
    const don = night.after.players.find(({ role }) => role === "don")!;
    const shots = night.after.players
      .filter(({ status, team }) => status === "active" && team === "black")
      .map(({ seat }) => ({ shooterSeat: seat, targetSeat: don.seat, secret: true as const }));
    const mafiaResult = entry(
      night.after,
      3,
      {
        type: "mafia.shots-resolved",
        payload: { shots, result: { kind: "kill", targetSeat: don.seat } },
      },
      night.entry.id,
    );
    const donPhase = entry(
      mafiaResult.after,
      4,
      { type: "phase.changed", payload: { to: "night-don" } },
      mafiaResult.entry.id,
    );
    const sheriff = donPhase.after.players.find(({ role }) => role === "sheriff")!;
    const donResult = entry(
      donPhase.after,
      5,
      { type: "don.checked", payload: { targetSeat: sheriff.seat, match: true } },
      donPhase.entry.id,
    );
    const sheriffPhase = entry(
      donResult.after,
      6,
      { type: "phase.changed", payload: { to: "night-sheriff" } },
      donResult.entry.id,
    );
    const replay = replayGameLog(baseline(), [
      root.entry,
      night.entry,
      mafiaResult.entry,
      donPhase.entry,
      donResult.entry,
      sheriffPhase.entry,
    ]);

    expect(donPhase.after.players.find(({ seat }) => seat === don.seat)?.status).toBe("eliminated");
    expect(donResult.after.checkResult).toMatchObject({ kind: "don-check", match: true });
    expect(replay.game).toEqual(sheriffPhase.after);
    expect(replay.frames.map(({ after }) => after)).toEqual([
      root.after,
      night.after,
      mafiaResult.after,
      donPhase.after,
      donResult.after,
      sheriffPhase.after,
    ]);
  });

  it("rejects persisted Best Moves that retain an expired mute", () => {
    const initial = dayOne();
    const victim = initial.players.find(({ role }) => role === "citizen")!;
    const killed = markPlayerInactive(initial, victim.seat, "eliminated");
    const before = {
      ...killed,
      phase: "night-resolution" as const,
      players: killed.players.map((player) =>
        player.seat === victim.seat ? { ...player, mutePending: true } : player,
      ),
      nightResult: { kind: "kill" as const, targetSeat: victim.seat },
    };
    const selectedSeats = before.players
      .filter(({ status }) => status === "active")
      .slice(0, 3)
      .map(({ seat }) => seat);
    const mafiaHits = selectedSeats.filter(
      (seat) => before.players.find((player) => player.seat === seat)?.team === "black",
    ).length;
    const root = entry(before, 1, { type: "game.checkpointed", payload: {} });
    const current = entry(
      root.after,
      2,
      {
        type: "best-move.completed",
        payload: { playerSeat: victim.seat, selectedSeats, mafiaHits },
      },
      root.entry.id,
    );
    expect(replayGameLog(baseline(before), [root.entry, current.entry]).game).toEqual(
      current.after,
    );
    const oldAfter: GameState = {
      ...current.after,
      players: current.after.players.map((player) =>
        player.seat === victim.seat ? { ...player, mutePending: true } : player,
      ),
    };
    const storedEntry: GameLogEntry = {
      ...current.entry,
      stateHashAfter: hashGameState(oldAfter),
    };

    expect(() => replayGameLog(baseline(before), [root.entry, storedEntry])).toThrow(
      /state hash mismatch/i,
    );
  });

  it("folds a single day-one nominee and omitted turns into the Mafia shot checkpoint", () => {
    const canonical = applyGameEvent(dayOne(), {
      type: "player.nominated",
      payload: { nominatorSeat: 1, candidateSeat: 4 },
    });
    let displayed = canonical;
    while (displayed.phase === "day") displayed = completeCurrentTurn(displayed);
    expect(displayed).toMatchObject({
      phase: "night-mafia",
      nominations: [],
      voteAssignments: {},
    });
    expect(displayed.players.find(({ seat }) => seat === 4)?.status).toBe("active");

    const target = displayed.players.find(
      ({ team, status }) => team === "red" && status === "active",
    )!;
    displayed = toggleAllMafiaShotsForTarget(displayed, target.seat);
    const resolution = resolveMafiaShots(displayed);
    const draft: CanonicalGameEventDraft = {
      type: "mafia.shots-resolved",
      payload: { shots: resolution.secretShots, result: resolution.result },
    };

    expect(applyGameEvent(canonical, draft)).toEqual(applyGameEvent(displayed, draft));
    expect(applyGameEvent(canonical, draft).voteAssignments).toEqual({});
  });

  it("does not fold Mafia shots across unresolved voting", () => {
    const firstNomination = applyGameEvent(dayOne(), {
      type: "player.nominated",
      payload: { nominatorSeat: 1, candidateSeat: 4 },
    });
    const canonical = applyGameEvent(firstNomination, {
      type: "player.nominated",
      payload: { nominatorSeat: 2, candidateSeat: 6 },
    });
    const shots = canonical.players
      .filter(({ team, status }) => team === "black" && status === "active")
      .map(({ seat }) => ({ shooterSeat: seat, targetSeat: 4, secret: true as const }));

    expect(() =>
      applyGameEvent(canonical, {
        type: "mafia.shots-resolved",
        payload: { shots, result: { kind: "kill", targetSeat: 4 } },
      }),
    ).toThrow(/Mafia night phase/i);
  });

  it("rejects phase changes that do not advance", () => {
    expect(() =>
      applyGameEvent(dayOne(), {
        type: "phase.changed",
        payload: { to: "day" },
      }),
    ).toThrow(/advance/i);
  });

  it("returns structured rule errors without mutating the supplied projection", () => {
    const game = dayOne();
    const before = structuredClone(game);
    const result = tryApplyGameEvent(game, {
      type: "phase.changed",
      payload: { to: "day" },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "invalid-phase",
        details: { eventType: "phase.changed", phase: "day", day: 1 },
      },
    });
    expect(
      tryApplyGameEvent(
        { ...game, phase: "draw" },
        {
          type: "turn.completed",
          payload: { seat: 1 },
        },
      ),
    ).toMatchObject({ ok: false, error: { code: "terminal-game" } });

    try {
      applyGameEvent(game, { type: "phase.changed", payload: { to: "day" } });
      expect.fail("Expected the illegal action to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(GameRuleError);
      expect(error).toMatchObject({
        code: "invalid-phase",
        details: { eventType: "phase.changed", phase: "day", day: 1 },
      });
    }
    expect(game).toEqual(before);
  });

  it("rejects phase changes that skip a meaningful phase", () => {
    expect(() =>
      applyGameEvent(planningGame(), {
        type: "phase.changed",
        payload: { to: "night-mafia" },
      }),
    ).toThrow(/meaningful phase day/i);
  });

  it("folds a red-card voting cancellation into the following night checkpoint", () => {
    const nominated = applyGameEvent(dayOne(), {
      type: "player.nominated",
      payload: { nominatorSeat: 3, candidateSeat: 4 },
    });
    const cancelled = applyGameEvent(nominated, {
      type: "player.red-carded",
      payload: { seat: 4 },
    });

    expect(() =>
      applyGameEvent(cancelled, {
        type: "phase.changed",
        payload: { to: "night-mafia" },
      }),
    ).not.toThrow();
  });

  it("hashes canonical UTF-8 state as a prefixed SHA-256 digest", () => {
    expect(hashGameState({ b: 2, a: 1 } as unknown as GameState)).toBe(
      "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
    expect(hashGameState({ message: "café 😈" } as unknown as GameState)).toBe(
      "sha256:9f568266ac06689f82f73e61f3392b213559aff13efe0709144c50c892537607",
    );
    expect(hashGameState({ message: "a".repeat(100) } as unknown as GameState)).toBe(
      "sha256:e137c528d9bb76eb7e95b7324964a41bfb2a8467b7fd4b57e0650306af48a59a",
    );
  });

  it("rejects unknown event types and ignored payload fields", () => {
    expect(() =>
      applyGameEvent(dayOne(), {
        type: "player.nominated",
        payload: { nominatorSeat: 1, candidateSeat: 4, note: "ignored" },
      } as unknown as CanonicalGameEventDraft),
    ).toThrow(/payload/i);
    expect(() =>
      applyGameEvent(dayOne(), {
        type: "player.red-carded",
        payload: { seat: 4, source: "ignored" },
      } as unknown as CanonicalGameEventDraft),
    ).toThrow(/payload/i);
    expect(() =>
      applyGameEvent(dayOne(), {
        type: "game.corrupted",
        payload: {},
      } as unknown as CanonicalGameEventDraft),
    ).toThrow(/event type/i);
    expect(() =>
      applyGameEvent(dayOne(), {
        type: "player.nominated",
        payload: { nominatorSeat: 1, candidateSeat: 11 },
      }),
    ).toThrow(/between 1 and 10/i);
    expect(() =>
      applyGameEvent(
        { ...dayOne(), phase: "night-mafia" },
        {
          type: "mafia.shots-resolved",
          payload: {
            shots: [
              { shooterSeat: 8, targetSeat: 1, secret: true },
              { shooterSeat: 8, targetSeat: 2, secret: true },
            ],
            result: { kind: "miss" },
          },
        },
      ),
    ).toThrow(/duplicate shooterSeat/i);
  });

  it("replays an incomplete Mafia assignment as a canonical miss", () => {
    const game: GameState = { ...dayOne(), phase: "night-mafia" };
    const shooter = game.players.find(
      ({ status, team }) => status === "active" && team === "black",
    )!;
    const target = game.players.find(({ status, team }) => status === "active" && team === "red")!;

    expect(
      applyGameEvent(game, {
        type: "mafia.shots-resolved",
        payload: {
          shots: [{ shooterSeat: shooter.seat, targetSeat: target.seat, secret: true }],
          result: { kind: "miss" },
        },
      }),
    ).toMatchObject({
      phase: "night-mafia-result",
      shotAssignments: { [shooter.seat]: target.seat },
    });
  });

  it("rejects malformed replay baselines even when the event list is empty", () => {
    expect(() => replayGameLog({ replayVersion: 1, game: {} as GameState }, [])).toThrow(
      /initial game baseline\.game/i,
    );
    const invalidRoles = {
      ...dayOne(),
      players: dayOne().players.map((player) => ({
        ...player,
        role: "citizen" as const,
        team: "red" as const,
      })),
    };
    expect(() => replayGameLog(baseline(invalidRoles), [])).toThrow(/role distribution/i);
  });

  it("rejects a phase change that bypasses unresolved voting", () => {
    const voting: GameState = {
      ...dayOne(),
      day: 2,
      phase: "voting",
      nominations: [{ nominatorSeat: 1, candidateSeat: 4, order: 1 }],
      turnOrder: [4],
      currentTurnIndex: 0,
      votingRound: "initial",
    };
    expect(() =>
      applyGameEvent(voting, {
        type: "phase.changed",
        payload: { to: "night-mafia" },
      }),
    ).toThrow(/cannot replay a phase change/i);
    expect(
      applyGameEvent(dayOne(), {
        type: "phase.changed",
        payload: { to: "night-mafia" },
      }),
    ).toMatchObject({ phase: "night-mafia", day: 1 });
  });

  it("rejects malformed event envelopes and non-integer sequences", () => {
    const initial = dayOne();
    const first = entry(initial, 1, {
      type: "player.nominated",
      payload: { nominatorSeat: 1, candidateSeat: 4 },
    });

    expect(() =>
      createGameLogEntry({
        gameId: first.entry.gameId,
        id: id(2),
        sequence: 1.5,
        parentEventId: first.entry.id,
        createdAt: "2026-08-25T00:02:00.000Z",
        before: first.after,
        draft: { type: "turn.completed", payload: { seat: 1 } },
      }),
    ).toThrow(/sequence/i);
    expect(() =>
      replayGameLog(baseline(initial), [{ ...first.entry, createdAt: "not-a-date" }]),
    ).toThrow(/createdAt/i);
    expect(() =>
      replayGameLog(baseline(initial), [
        { ...first.entry, ignoredEnvelopeField: true } as unknown as typeof first.entry,
      ]),
    ).toThrow(/envelope/i);
  });

  it("replays nominations without mutating the baseline", () => {
    const initial = dayOne();
    const draft: CanonicalGameEventDraft = {
      type: "player.nominated",
      payload: { nominatorSeat: 1, candidateSeat: 4 },
    };

    const after = applyGameEvent(initial, draft);

    expect(after.nominations).toEqual([{ nominatorSeat: 1, candidateSeat: 4, order: 1 }]);
    expect(initial.nominations).toEqual([]);
  });

  it("reconstructs one omitted day turn before a foul checkpoint", () => {
    const canonical = dayOne();
    const root = entry(canonical, 1, {
      type: "game.checkpointed",
      payload: {},
    });
    const live = applyGameEvent(root.after, {
      type: "turn.completed",
      payload: { seat: canonical.turnOrder[canonical.currentTurnIndex]! },
    });
    const target = live.players.find(({ role }) => role === "citizen")!;
    const direct = applyGameEvent(live, {
      type: "foul.issued",
      payload: { seat: target.seat, foulNumber: 1, redCarded: false },
    });
    const checkpoint = entry(
      root.after,
      2,
      {
        type: "foul.issued",
        payload: {
          seat: target.seat,
          foulNumber: 1,
          redCarded: false,
          phase: live.phase,
          currentTurnIndex: live.currentTurnIndex,
        },
      },
      root.entry.id,
    );

    const replayed = replayGameLog(baseline(canonical), [root.entry, checkpoint.entry]).game;

    expect(replayed.currentTurnIndex).toBe(direct.currentTurnIndex);
    expect(replayed.players.find(({ seat }) => seat === target.seat)).toEqual(
      direct.players.find(({ seat }) => seat === target.seat),
    );
  });

  it("reconstructs omitted day completion into voting before a red card", () => {
    const firstNomination = applyGameEvent(dayOne(), {
      type: "player.nominated",
      payload: { nominatorSeat: 1, candidateSeat: 4 },
    });
    const canonical = applyGameEvent(firstNomination, {
      type: "player.nominated",
      payload: { nominatorSeat: 2, candidateSeat: 6 },
    });
    let live = canonical;
    while (live.phase === "day") {
      live = applyGameEvent(live, {
        type: "turn.completed",
        payload: { seat: live.turnOrder[live.currentTurnIndex]! },
      });
    }
    const target = live.players.find(({ role, seat }) => role === "citizen" && seat !== 4)!;
    const direct = applyGameEvent(live, {
      type: "player.red-carded",
      payload: { seat: target.seat },
    });

    const replayed = applyGameEvent(canonical, {
      type: "player.red-carded",
      payload: {
        seat: target.seat,
        phase: live.phase,
        currentTurnIndex: live.currentTurnIndex,
      },
    });

    expect(live.phase).toBe("voting");
    expect(replayed).toEqual(direct);
  });

  it("does not carry generated provisional votes into a contextual foul checkpoint", () => {
    const canonical = applyGameEvent(
      { ...dayOne(), day: 2 },
      {
        type: "player.nominated",
        payload: { nominatorSeat: 1, candidateSeat: 4 },
      },
    );

    const replayed = applyGameEvent(canonical, {
      type: "foul.issued",
      payload: {
        seat: 1,
        foulNumber: 1,
        redCarded: false,
        phase: "voting",
        currentTurnIndex: 0,
      },
    });

    expect(replayed).toMatchObject({ phase: "voting", currentTurnIndex: 0 });
    expect(replayed.players.find(({ seat }) => seat === 1)?.fouls).toBe(1);
    expect(replayed.voteAssignments).toEqual({});
  });

  it("reconstructs a validated omitted voting-candidate advance before a red card", () => {
    const firstNomination = applyGameEvent(dayOne(), {
      type: "player.nominated",
      payload: { nominatorSeat: 1, candidateSeat: 4 },
    });
    const canonical = applyGameEvent(firstNomination, {
      type: "player.nominated",
      payload: { nominatorSeat: 2, candidateSeat: 6 },
    });
    let voting = canonical;
    while (voting.phase === "day") {
      voting = applyGameEvent(voting, {
        type: "turn.completed",
        payload: { seat: voting.turnOrder[voting.currentTurnIndex]! },
      });
    }
    const live = advanceVotingCandidate(voting);
    const target = live.players.find(({ role, seat }) => role === "citizen" && seat !== 4)!;
    const direct = applyGameEvent(live, {
      type: "player.red-carded",
      payload: { seat: target.seat },
    });

    const replayed = applyGameEvent(canonical, {
      type: "player.red-carded",
      payload: {
        seat: target.seat,
        phase: live.phase,
        currentTurnIndex: live.currentTurnIndex,
      },
    });

    expect(live.turnOrder[live.currentTurnIndex]).toBe(6);
    expect(replayed).toEqual(direct);
  });

  it("folds an omitted private-phase advance into a foul checkpoint", () => {
    const night: GameState = { ...dayOne(), phase: "night-mafia" };
    const mafiaPlayers = night.players.filter(
      ({ status, team }) => status === "active" && team === "black",
    );
    const victim = night.players.find(({ team }) => team === "red")!;
    const target = night.players.find(({ team, seat }) => team === "red" && seat !== victim.seat)!;
    const canonical = applyGameEvent(night, {
      type: "mafia.shots-resolved",
      payload: {
        shots: mafiaPlayers.map(({ seat }) => ({
          shooterSeat: seat,
          targetSeat: victim.seat,
          secret: true,
        })),
        result: { kind: "kill", targetSeat: victim.seat },
      },
    });
    const live = applyGameEvent(canonical, {
      type: "phase.changed",
      payload: { to: "night-don" },
    });
    const direct = applyGameEvent(live, {
      type: "foul.issued",
      payload: { seat: target.seat, foulNumber: 1, redCarded: false },
    });

    const replayed = applyGameEvent(canonical, {
      type: "foul.issued",
      payload: {
        seat: target.seat,
        foulNumber: 1,
        redCarded: false,
        phase: live.phase,
        currentTurnIndex: live.currentTurnIndex,
      },
    });

    expect(live.phase).toBe("night-don");
    expect(replayed).toEqual(direct);
  });

  it("simulates an omitted car-crash turn before a foul checkpoint", () => {
    const canonical: GameState = {
      ...dayOne(),
      phase: "car-crash",
      nominations: [
        { nominatorSeat: 1, candidateSeat: 4, order: 1 },
        { nominatorSeat: 2, candidateSeat: 6, order: 2 },
      ],
      turnOrder: [4, 6],
      currentTurnIndex: 0,
      votingRound: "repeat",
      carCrashSeats: [4, 6],
      carCrashVotes: {},
    };
    const live = applyGameEvent(canonical, {
      type: "turn.completed",
      payload: { seat: 4 },
    });
    const direct = applyGameEvent(live, {
      type: "foul.issued",
      payload: { seat: 1, foulNumber: 1, redCarded: false },
    });

    const replayed = applyGameEvent(canonical, {
      type: "foul.issued",
      payload: {
        seat: 1,
        foulNumber: 1,
        redCarded: false,
        phase: "car-crash",
        currentTurnIndex: 1,
      },
    });

    expect(replayed).toEqual(direct);
  });

  it("rejects a car-crash context whose turn order contradicts tied nominees", () => {
    const malformed: GameState = {
      ...dayOne(),
      phase: "car-crash",
      nominations: [
        { nominatorSeat: 1, candidateSeat: 4, order: 1 },
        { nominatorSeat: 2, candidateSeat: 6, order: 2 },
      ],
      turnOrder: [4, 8],
      currentTurnIndex: 0,
      votingRound: "repeat",
      carCrashSeats: [4, 6],
      carCrashVotes: {},
    };

    expect(() =>
      applyGameEvent(malformed, {
        type: "foul.issued",
        payload: {
          seat: 1,
          foulNumber: 1,
          redCarded: false,
          phase: "car-crash",
          currentTurnIndex: 1,
        },
      }),
    ).toThrow(/car-crash turn order/i);
  });

  it("rejects a discipline context whose voting cursor contradicts nomination order", () => {
    const malformedVoting: GameState = {
      ...dayOne(),
      phase: "voting",
      nominations: [
        { nominatorSeat: 1, candidateSeat: 4, order: 1 },
        { nominatorSeat: 2, candidateSeat: 8, order: 2 },
      ],
      turnOrder: [4, 6],
      currentTurnIndex: 0,
      votingRound: "initial",
    };

    expect(() =>
      applyGameEvent(malformedVoting, {
        type: "foul.issued",
        payload: {
          seat: 1,
          foulNumber: 1,
          redCarded: false,
          phase: "voting",
          currentTurnIndex: 1,
        },
      }),
    ).toThrow(/voting candidate/i);
  });

  it("requires discipline phase and current-turn context fields together", () => {
    expect(() =>
      applyGameEvent(dayOne(), {
        type: "foul.issued",
        payload: {
          seat: 1,
          foulNumber: 1,
          redCarded: false,
          phase: "day",
        },
      } as unknown as CanonicalGameEventDraft),
    ).toThrow(/phase and currentTurnIndex together/i);
    expect(() =>
      applyGameEvent(dayOne(), {
        type: "player.red-carded",
        payload: { seat: 1, currentTurnIndex: 0 },
      } as unknown as CanonicalGameEventDraft),
    ).toThrow(/phase and currentTurnIndex together/i);
  });

  it("rejects a contextual foul checkpoint outside active play", () => {
    const finished: GameState = { ...dayOne(), phase: "finished", winner: "red" };

    expect(() =>
      applyGameEvent(finished, {
        type: "foul.issued",
        payload: {
          seat: 1,
          foulNumber: 1,
          redCarded: false,
          phase: "finished",
          currentTurnIndex: finished.currentTurnIndex,
        },
      }),
    ).toThrow(/active play/i);
  });

  it("captures fourth-foul red-card consequences in one event", () => {
    let game = dayOne();
    const target = game.players.find(({ role }) => role === "citizen")!;
    for (let number = 1; number <= 3; number += 1) {
      game = applyGameEvent(game, {
        type: "foul.issued",
        payload: { seat: target.seat, foulNumber: number, redCarded: false },
      });
    }

    const after = applyGameEvent(game, {
      type: "foul.issued",
      payload: { seat: target.seat, foulNumber: 4, redCarded: true },
    });

    expect(after.players.find(({ seat }) => seat === target.seat)).toMatchObject({
      fouls: 4,
      status: "red-carded",
    });
  });

  it("reconstructs Best move independently of provisional selections", () => {
    const initial = dayOne();
    const owner = initial.players[0]!;
    const targets = initial.players.filter(({ seat }) => seat !== owner.seat).slice(0, 3);
    const selectedSeats = targets.map(({ seat }) => seat);
    const mafiaHits = targets.filter(({ team }) => team === "black").length;
    const bestMove: GameState = {
      ...initial,
      phase: "best-move",
      bestMove: { playerSeat: owner.seat, selectedSeats },
    };
    const draft = {
      type: "best-move.completed" as const,
      payload: { playerSeat: owner.seat, selectedSeats, mafiaHits },
    };

    expect(applyGameEvent(bestMove, draft)).toMatchObject({
      phase: "goodbye-speech",
      bestMove: { playerSeat: owner.seat, selectedSeats, mafiaHits },
    });
  });

  it("replays evaluated Mafia shots as one event", () => {
    const skipped = applyGameEvent(dayOne(), {
      type: "voting.skipped",
      payload: { reason: "host-skipped" },
    });
    const night = applyGameEvent(skipped, {
      type: "phase.changed",
      payload: { to: "night-mafia" },
    });
    const shooters = night.players.filter(({ team }) => team === "black");
    const target = night.players.find(({ team }) => team === "red")!;
    const shots = shooters.map(({ seat }) => ({
      shooterSeat: seat,
      targetSeat: target.seat,
      secret: true as const,
    }));

    const evaluated = applyGameEvent(night, {
      type: "mafia.shots-resolved",
      payload: { shots, result: { kind: "kill", targetSeat: target.seat } },
    });

    expect(evaluated.phase).toBe("night-mafia-result");
    expect(evaluated.players.find(({ seat }) => seat === target.seat)?.status).toBe("active");
    expect(evaluated.shotAssignments).toEqual(
      Object.fromEntries(shooters.map(({ seat }) => [seat, target.seat])),
    );
  });

  it("builds replay frames and verifies parent links and state hashes", () => {
    const initial = dayOne();
    const root = entry(initial, 1, {
      type: "game.checkpointed",
      payload: {},
    });
    const first = entry(
      root.after,
      2,
      {
        type: "player.nominated",
        payload: { nominatorSeat: 1, candidateSeat: 4 },
      },
      root.entry.id,
    );
    const second = entry(
      first.after,
      3,
      { type: "turn.completed", payload: { seat: 1 } },
      first.entry.id,
    );

    const replayed = replayGameLog(baseline(initial), [root.entry, first.entry, second.entry]);

    expect(replayed.game).toEqual(second.after);
    expect(replayed.frames).toHaveLength(3);
    expect(replayed.frames[1]).toMatchObject({ before: initial, after: first.after });
    expect(replayed.frames[2]).toMatchObject({ before: first.after, after: second.after });
    expect(second.entry.parentEventId).toBe(first.entry.id);
    expect(second.entry.stateHashAfter).toBe(hashGameState(second.after));

    expect(() =>
      replayGameLog(baseline(initial), [
        root.entry,
        { ...second.entry, parentEventId: "missing-parent" },
      ]),
    ).toThrow(/parent/i);
    expect(() =>
      replayGameLog(baseline(initial), [
        root.entry,
        { ...first.entry, stateHashAfter: "bad-hash" },
      ]),
    ).toThrow(/hash/i);
  });

  it("rejects recorded weak state hashes", () => {
    const initial = dayOne();
    const first = entry(initial, 1, {
      type: "player.nominated",
      payload: { nominatorSeat: 1, candidateSeat: 4 },
    });
    const weakEntry = { ...first.entry, stateHashAfter: "00000000" };

    expect(() => replayGameLog(baseline(initial), [weakEntry])).toThrow(/sha256/i);
  });

  it("rejects a weak hash anywhere in a replay chain", () => {
    const initial = dayOne();
    const first = entry(initial, 1, {
      type: "player.nominated",
      payload: { nominatorSeat: 1, candidateSeat: 4 },
    });
    const weakParent = { ...first.entry, stateHashAfter: "00000000" };

    const second = entry(
      first.after,
      2,
      { type: "turn.completed", payload: { seat: 1 } },
      weakParent.id,
    );

    expect(() => replayGameLog(baseline(initial), [weakParent, second.entry])).toThrow(/sha256/i);
  });

  it("rejects game.started outside Mafia planning at every domain write boundary", () => {
    const day = dayOne();
    const draft = { type: "game.started" as const, payload: {} };

    expect(() => applyGameEvent(day, draft)).toThrow(/mafia-planning/i);
    expect(() => entry(day, 1, draft)).toThrow(/mafia-planning/i);

    const planning = planningGame();
    const started = entry(planning, 1, draft);
    expect(started.after).toEqual(planning);
    expect(replayGameLog(baseline(planning), [started.entry]).game).toEqual(planning);
  });

  it("restores every documented setup lifecycle checkpoint", () => {
    const planning = planningGame();
    const started = entry(planning, 1, { type: "game.started", payload: {} });
    const sheriffWake = entry(
      started.after,
      2,
      { type: "phase.changed", payload: { to: "sheriff-wake" } },
      started.entry.id,
    );
    const day = entry(
      sheriffWake.after,
      3,
      { type: "phase.changed", payload: { to: "day" } },
      sheriffWake.entry.id,
    );

    const replayed = replayGameLog(baseline(planning), [
      started.entry,
      sheriffWake.entry,
      day.entry,
    ]);

    expect(replayed.frames.map(({ before, after }) => [before.phase, after.phase])).toEqual([
      ["mafia-planning", "mafia-planning"],
      ["mafia-planning", "sheriff-wake"],
      ["sheriff-wake", "day"],
    ]);
    expect(replayed.game).toEqual(day.after);
  });

  it("rejects integrity downgrades and malformed modern lifecycle roots", () => {
    const initial = dayOne();
    const root = entry(initial, 1, {
      type: "game.checkpointed",
      payload: {},
    });
    const next = entry(
      root.after,
      2,
      {
        type: "player.nominated",
        payload: { nominatorSeat: 1, candidateSeat: 4 },
      },
      root.entry.id,
    );

    expect(() =>
      replayGameLog(baseline(initial), [root.entry, { ...next.entry, stateHashAfter: "00000000" }]),
    ).toThrow(/sha256/i);
    expect(() =>
      replayGameLog(baseline(initial), [{ ...next.entry, sequence: 1, parentEventId: null }]),
    ).toThrow(/lifecycle root/i);
    expect(() =>
      replayGameLog(baseline(initial), [
        { ...root.entry, type: "game.started" as const } as GameLogEntry,
      ]),
    ).toThrow(/mafia-planning baseline/i);
    expect(() =>
      replayGameLog({ ...baseline(initial), ignored: true } as unknown as InitialGameBaseline, [
        root.entry,
      ]),
    ).toThrow(/invalid fields/i);
    expect(() =>
      replayGameLog(baseline(initial), [root.entry], "00000000-0000-4000-8000-000000000998"),
    ).toThrow(/does not belong/i);
  });

  it("rejects contradictory voting baselines and duplicate skip markers", () => {
    expect(() =>
      replayGameLog(
        baseline({
          ...dayOne(),
          phase: "voting",
          turnOrder: [],
          votingRound: undefined,
          currentTurnIndex: 0,
        }),
        [],
      ),
    ).toThrow(/voting phase fields/i);
    const cancelled = applyGameEvent(dayOne(), {
      type: "voting.skipped",
      payload: { reason: "host-skipped" },
    });
    expect(() =>
      applyGameEvent(cancelled, {
        type: "voting.skipped",
        payload: { reason: "host-skipped" },
      }),
    ).toThrow(/day phase/i);
  });

  it("rejects a Best Move containing its owner and an inactive selection", () => {
    const initial = dayOne();
    const owner = initial.players[0]!;
    const inactive = initial.players[1]!;
    const active = initial.players[2]!;
    const players = initial.players.map((player) =>
      player.seat === owner.seat || player.seat === inactive.seat
        ? { ...player, status: "eliminated" as const }
        : player,
    );
    const before: GameState = {
      ...initial,
      day: 2,
      phase: "best-move",
      players,
      turnOrder: initial.turnOrder.filter((seat) => seat !== owner.seat && seat !== inactive.seat),
      goodbyeSeats: [owner.seat],
      goodbyeNext: "day",
      bestMove: { playerSeat: owner.seat, selectedSeats: [] },
    };
    const selectedSeats = [owner.seat, inactive.seat, active.seat];
    const mafiaHits = selectedSeats.filter(
      (seat) => players.find((player) => player.seat === seat)?.team === "black",
    ).length;
    const after: GameState = {
      ...before,
      phase: "goodbye-speech",
      bestMove: { playerSeat: owner.seat, selectedSeats, mafiaHits },
      dayNotice: undefined,
    };
    const storedEntry: GameLogEntry = {
      replayVersion: 1,
      id: id(1),
      gameId: "00000000-0000-4000-8000-000000000999",
      sequence: 1,
      parentEventId: null,
      type: "best-move.completed",
      payload: { playerSeat: owner.seat, selectedSeats, mafiaHits },
      phaseBefore: before.phase,
      phaseAfter: after.phase,
      dayBefore: before.day,
      dayAfter: after.day,
      stateHashAfter: hashGameState(after),
      createdAt: "2026-08-18T08:00:00.000Z",
    };

    expect(() => replayGameLog(baseline(before), [storedEntry])).toThrow();
  });

  it("rejects Don and Sheriff checks made by eliminated role owners", () => {
    const variants = [
      {
        type: "don.checked",
        phase: "night-don",
        resultPhase: "night-don-result",
        ownerRole: "don",
        targetRole: "sheriff",
        resultKind: "don-check",
      },
      {
        type: "sheriff.checked",
        phase: "night-sheriff",
        resultPhase: "night-sheriff-result",
        ownerRole: "sheriff",
        targetRole: "mafia",
        resultKind: "sheriff-check",
      },
    ] as const;

    for (const variant of variants) {
      const initial = dayOne();
      const owner = initial.players.find(({ role }) => role === variant.ownerRole)!;
      const target = initial.players.find(({ role }) => role === variant.targetRole)!;
      const before: GameState = {
        ...initial,
        phase: variant.phase,
        players: initial.players.map((player) =>
          player.seat === owner.seat ? { ...player, status: "eliminated" as const } : player,
        ),
      };
      const after: GameState = {
        ...before,
        phase: variant.resultPhase,
        checkResult: {
          kind: variant.resultKind,
          targetSeat: target.seat,
          match: true,
          secret: true,
        },
      };
      const storedEntry: GameLogEntry = {
        replayVersion: 1,
        id: id(1),
        gameId: "00000000-0000-4000-8000-000000000999",
        sequence: 1,
        parentEventId: null,
        type: variant.type,
        payload: { targetSeat: target.seat, match: true },
        phaseBefore: before.phase,
        phaseAfter: after.phase,
        dayBefore: before.day,
        dayAfter: after.day,
        stateHashAfter: hashGameState(after),
        createdAt: "2026-08-18T08:01:00.000Z",
      };

      expect(() => replayGameLog(baseline(before), [storedEntry])).toThrow();
      expect(() =>
        replayGameLog(baseline({ ...before, phase: "day" }), [
          { ...storedEntry, phaseBefore: "day" },
        ]),
      ).toThrow();
    }
  });

  it("rejects car-crash decisions whose omitted voters change the snapshot", () => {
    const decision: GameState = {
      ...dayOne(),
      phase: "car-crash-decision",
      carCrashSeats: [4, 6],
      carCrashVotes: {},
    };
    const votes = Object.fromEntries(decision.players.map(({ seat }) => [seat, seat <= 6]));
    const accepted = entry(decision, 1, {
      type: "car-crash.resolved",
      payload: {
        votes,
        result: { eliminate: true, seats: [4, 6], yesVotes: 6, eligibleVoters: 10 },
      },
    });
    const legacyVotes = Object.fromEntries(Object.entries(votes).filter(([, vote]) => vote));
    const legacyAfter =
      accepted.after.carCrashVotes === undefined
        ? accepted.after
        : { ...accepted.after, carCrashVotes: legacyVotes };
    const legacyEntry = {
      ...accepted.entry,
      payload: { ...accepted.entry.payload, votes: legacyVotes },
      stateHashAfter: hashGameState(legacyAfter),
    } as GameLogEntry;

    expect(() => replayGameLog(baseline(decision), [legacyEntry])).toThrow(
      /every eligible player must vote/i,
    );
  });

  it("replays new car-crash ballots through a review phase before elimination", () => {
    const decision: GameState = {
      ...dayOne(),
      phase: "car-crash-decision",
      nominations: [
        { nominatorSeat: 1, candidateSeat: 4, order: 1 },
        { nominatorSeat: 2, candidateSeat: 6, order: 2 },
      ],
      votingRound: "repeat",
      carCrashSeats: [4, 6],
      carCrashVotes: {},
    };
    const votes = Object.fromEntries(decision.players.map(({ seat }) => [seat, seat <= 6]));
    const result = { eliminate: true, seats: [4, 6], yesVotes: 6, eligibleVoters: 10 };

    const reviewed = applyGameEvent(decision, {
      type: "car-crash.ballot-resolved",
      payload: { votes, result },
    } as CanonicalGameEventDraft);
    expect(reviewed).toMatchObject({ phase: "car-crash-result", carCrashResult: result });
    expect(reviewed.players.find(({ seat }) => seat === 4)?.status).toBe("active");

    const continued = applyGameEvent(reviewed, {
      type: "phase.changed",
      payload: { to: "goodbye-speech" },
    });
    expect(continued.players.find(({ seat }) => seat === 4)?.status).toBe("eliminated");
    expect(continued.phase).toBe("goodbye-speech");
  });

  it("suppresses muted car-crash goodbye speakers in canonical phase advancement", () => {
    const initial = dayOne();
    const reviewed: GameState = {
      ...initial,
      phase: "car-crash-result",
      players: initial.players.map((player) =>
        player.seat === 4 ? { ...player, mutePending: true } : player,
      ),
      carCrashSeats: [4, 6],
      carCrashVotes: {},
      carCrashResult: {
        eliminate: true,
        seats: [4, 6],
        yesVotes: 6,
        eligibleVoters: 10,
      },
    };

    const draft: CanonicalGameEventDraft = {
      type: "phase.changed",
      payload: { to: "goodbye-speech" },
    };
    const corrected = applyGameEvent(reviewed, draft);
    expect(corrected).toMatchObject({
      phase: "goodbye-speech",
      goodbyeSeats: [6],
      goodbyeNext: "night",
    });
    const root = entry(reviewed, 1, { type: "game.checkpointed", payload: {} });
    const resolved = entry(root.after, 2, draft, root.entry.id);
    expect(replayGameLog(baseline(reviewed), [root.entry, resolved.entry]).game).toEqual(corrected);
  });

  it("rejects car-crash goodbyes that retain a muted speaker", () => {
    const initial = dayOne();
    const reviewed: GameState = {
      ...initial,
      phase: "car-crash-result",
      players: initial.players.map((player) =>
        player.seat === 4 ? { ...player, mutePending: true } : player,
      ),
      carCrashSeats: [4, 6],
      carCrashVotes: {},
      carCrashResult: {
        eliminate: true,
        seats: [4, 6],
        yesVotes: 6,
        eligibleVoters: 10,
      },
    };
    const root = entry(reviewed, 1, { type: "game.checkpointed", payload: {} });
    const current = entry(
      root.after,
      2,
      { type: "phase.changed", payload: { to: "goodbye-speech" } },
      root.entry.id,
    );
    const oldAfter: GameState = { ...current.after, goodbyeSeats: [4, 6] };
    const storedEntry: GameLogEntry = {
      ...current.entry,
      stateHashAfter: hashGameState(oldAfter),
    };

    expect(() => replayGameLog(baseline(reviewed), [root.entry, storedEntry])).toThrow(
      /state hash mismatch/i,
    );
  });

  it("supports independent append-only branches from one parent", () => {
    const initial = dayOne();
    const root = entry(initial, 1, { type: "game.checkpointed", payload: {} });
    const parent = entry(
      root.after,
      2,
      {
        type: "player.nominated",
        payload: { nominatorSeat: 1, candidateSeat: 4 },
      },
      root.entry.id,
    );
    const left = entry(
      parent.after,
      3,
      { type: "turn.completed", payload: { seat: 1 } },
      parent.entry.id,
    );
    const right = entry(
      parent.after,
      4,
      { type: "foul.issued", payload: { seat: 5, foulNumber: 1, redCarded: false } },
      parent.entry.id,
    );

    expect(
      replayGameLog(baseline(initial), [root.entry, parent.entry, left.entry]).game
        .currentTurnIndex,
    ).toBe(1);
    expect(
      replayGameLog(baseline(initial), [root.entry, parent.entry, right.entry]).game.players.find(
        ({ seat }) => seat === 5,
      )?.fouls,
    ).toBe(1);
  });

  it("allows append-sequence gaps along a valid branch", () => {
    const initial = dayOne();
    const root = entry(initial, 1, { type: "game.checkpointed", payload: {} });
    const parent = entry(
      root.after,
      2,
      {
        type: "player.nominated",
        payload: { nominatorSeat: 1, candidateSeat: 4 },
      },
      root.entry.id,
    );
    const child = entry(
      parent.after,
      4,
      { type: "turn.completed", payload: { seat: 1 } },
      parent.entry.id,
    );

    expect(replayGameLog(baseline(initial), [root.entry, parent.entry, child.entry]).game).toEqual(
      child.after,
    );
  });

  it("rejects duplicate IDs and cross-game links in a replay chain", () => {
    const initial = dayOne();
    const first = entry(initial, 1, {
      type: "player.nominated",
      payload: { nominatorSeat: 1, candidateSeat: 4 },
    });
    const second = entry(
      first.after,
      2,
      { type: "turn.completed", payload: { seat: 1 } },
      first.entry.id,
    );

    expect(() =>
      replayGameLog(baseline(initial), [first.entry, { ...second.entry, id: first.entry.id }]),
    ).toThrow(/duplicate/i);
    expect(() =>
      replayGameLog(baseline(initial), [
        first.entry,
        { ...second.entry, gameId: "00000000-0000-4000-8000-000000000998" },
      ]),
    ).toThrow(/game/i);
  });

  it("replays explained draw and cancellation rulings as public terminal events", () => {
    const initial = dayOne();
    const root = entry(initial, 1, { type: "game.checkpointed", payload: {} });
    const drawn = entry(
      root.after,
      2,
      { type: "game.drawn", payload: { reason: "Three quiet cycles" } },
      root.entry.id,
    );

    expect(drawn.after).toMatchObject({ phase: "draw", winner: null });
    expect(replayGameLog(baseline(initial), [root.entry, drawn.entry]).game).toEqual(drawn.after);
    expect(isMeaningfulGameEventDraft(drawn.entry)).toBe(true);
    expect(isSecretGameEventType("game.drawn")).toBe(false);

    const planning = planningGame();
    const planningRoot = entry(planning, 1, { type: "game.checkpointed", payload: {} });
    const cancelled = entry(
      planningRoot.after,
      2,
      { type: "game.cancelled", payload: { reason: "Venue closed" } },
      planningRoot.entry.id,
    );
    expect(cancelled.after).toMatchObject({ phase: "cancelled", day: 0, winner: null });
    expect(replayGameLog(baseline(planning), [planningRoot.entry, cancelled.entry]).game).toEqual(
      cancelled.after,
    );
    expect(() =>
      applyGameEvent(initial, { type: "game.drawn", payload: { reason: "   " } }),
    ).toThrow(/reason/i);

    const laterEvent: GameLogEntry = {
      ...drawn.entry,
      type: "turn.completed",
      payload: { seat: 1 },
      id: id(3),
      sequence: 3,
      parentEventId: drawn.entry.id,
      phaseBefore: "draw",
      phaseAfter: "draw",
    };
    expect(() => replayGameLog(baseline(initial), [root.entry, drawn.entry, laterEvent])).toThrow(
      /terminal/i,
    );
  });

  it("validates completion markers and classifies vote removal as provisional", () => {
    expect(() =>
      applyGameEvent(dayOne(), {
        type: "game.completed",
        payload: { winner: "red" },
      }),
    ).toThrow(/finished/i);
    expect(() =>
      applyGameEvent(
        { ...dayOne(), phase: "finished", winner: "red" },
        { type: "game.completed", payload: { winner: "black" } },
      ),
    ).toThrow(/winner/i);
    expect(isProvisionalInteractionType("vote.removed")).toBe(true);
  });
});
