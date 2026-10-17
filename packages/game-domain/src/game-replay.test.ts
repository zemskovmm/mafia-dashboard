import { describe, expect, it } from "vitest";
import { CASPER_NAME, CASPER_PLAYER_ID, CASPER_SEAT } from "./casper.js";
import { completeCurrentTurn } from "./day-actions.js";
import { advanceOpeningPhase, createGame, markPlayerInactive } from "./game.js";
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
import { createFederationBallot } from "./federation-actions.js";
import { GameRuleError } from "./rule-error.js";
import {
  beginRoleDraw,
  completeRoleDraw,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
} from "./setup.js";
import {
  beginNight,
  completeMafiaShots,
  completeNight,
  resolveMafiaShots,
  skipDonCheck,
  skipSheriffCheck,
  toggleAllMafiaShotsForTarget,
} from "./night-actions.js";
import type { GameState, PlayerInput, SetupState } from "./types.js";
const players = (): PlayerInput[] =>
  Array.from({ length: 10 }, (_, index) => ({
    id: `player-${index + 1}`,
    seat: index + 1,
  }));
const completedSetup = (): SetupState => {
  let setup = beginRoleDraw(createSetup(players()), createSeededRandom(41));
  for (let seat = 1; seat <= 10; seat += 1) setup = drawRoleForSeat(setup, seat);
  return completeRoleDraw(setup);
};
const planningGame = (): GameState => createGame(completedSetup());
const dayOne = (): GameState => advanceOpeningPhase(advanceOpeningPhase(planningGame()));
const baseline = (game = dayOne()): InitialGameBaseline => ({
  replayVersion: 3,
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
  it("keeps canonical hashes independent of profile name changes", () => {
    const current = planningGame();
    const hash = hashGameState(current);
    const directory = new Map([[current.players[0]!.id, "Old nickname"]]);
    directory.set(current.players[0]!.id, "New nickname");
    directory.delete(current.players[0]!.id);
    expect(JSON.stringify(current)).not.toContain("Old nickname");
    expect(JSON.stringify(current)).not.toContain('"name"');
    expect(hashGameState(current)).toBe(hash);
  });
  it.each([true, false, "yes", null, 1, {}])(
    "rejects a removed Casper compatibility marker %j",
    (marker) => {
      const initial = { ...planningGame(), skipCasperBestMove: marker } as unknown as GameState;
      expect(() => replayGameLog(baseline(initial), [])).toThrow(/unexpected skipCasperBestMove/);
      expect(() => entry(initial, 1, { type: "game.started", payload: {} })).toThrow(
        /unexpected skipCasperBestMove/,
      );
    },
  );
  it("round-trips a new Casper-kill checkpoint without a Best Move event", () => {
    const roster = players().map((player) =>
      player.seat === CASPER_SEAT ? { id: CASPER_PLAYER_ID, seat: CASPER_SEAT } : player,
    );
    let setup = beginRoleDraw(createSetup(roster), createSeededRandom(41));
    for (let seat = 1; seat < CASPER_SEAT; seat += 1) setup = drawRoleForSeat(setup, seat);
    let before = beginNight(
      advanceOpeningPhase(advanceOpeningPhase(createGame(completeRoleDraw(setup)))),
    );
    before = toggleAllMafiaShotsForTarget(before, CASPER_SEAT);
    before = skipSheriffCheck(skipDonCheck(completeMafiaShots(resolveMafiaShots(before).game)));
    const initial = baseline(before);
    const root = entry(initial.game, 1, { type: "game.checkpointed", payload: {} });
    const speech = entry(root.after, 2, {
      type: "phase.changed",
      payload: { to: "goodbye-speech" },
    });
    expect(speech.after).toMatchObject({
      phase: "goodbye-speech",
      day: 2,
      goodbyeSeats: [CASPER_SEAT],
    });
    expect(speech.after.bestMove).toBeUndefined();
    const day = entry(speech.after, 3, { type: "phase.changed", payload: { to: "day" } });
    const stored = JSON.parse(
      JSON.stringify([root.entry, speech.entry, day.entry]),
    ) as GameLogEntry[];
    const restored = replayGameLog(initial, stored);
    expect(restored.game).toEqual(day.after);
    expect(restored.game).not.toHaveProperty("skipCasperBestMove");
    expect(restored.frames.map(({ entry }) => entry.type)).toEqual([
      "game.checkpointed",
      "phase.changed",
      "phase.changed",
    ]);
    expect(() =>
      applyGameEvent(root.after, {
        type: "best-move.number-accepted",
        payload: { seat: 1 },
      }),
    ).toThrow(/unfinished night-time Best Move/i);
  });
  it("round-trips the committed decisive night from a current ID-only game without a private phase", () => {
    let day = dayOne();
    const red = day.players.filter(({ team }) => team === "red");
    for (const player of red.slice(0, 3)) {
      day = markPlayerInactive(day, player.seat, "eliminated");
    }
    const victim = red[3]!;
    const initial = baseline(beginNight(day));
    const root = entry(initial.game, 1, { type: "game.checkpointed", payload: {} });
    const selected = toggleAllMafiaShotsForTarget(root.after, victim.seat);
    const resolution = resolveMafiaShots(selected);
    const shot = entry(root.after, 2, {
      type: "mafia.shots-resolved",
      payload: { shots: resolution.secretShots, result: resolution.result },
    });
    expect(shot.after).toMatchObject({ phase: "night-mafia-result", winner: null });
    expect(shot.after.players.find(({ seat }) => seat === victim.seat)?.status).toBe("active");
    const outcome = entry(shot.after, 3, { type: "phase.changed", payload: { to: "finished" } });
    expect(outcome.after).toEqual(completeMafiaShots(resolveMafiaShots(selected).game));
    expect(outcome.after).toMatchObject({
      phase: "finished",
      winner: "black",
      nightResult: { kind: "kill", targetSeat: victim.seat },
      shotAssignments: {},
    });
    expect(outcome.entry.stateHashAfter).toBe(hashGameState(outcome.after));
    const stored = JSON.parse(
      JSON.stringify([root.entry, shot.entry, outcome.entry]),
    ) as GameLogEntry[];
    const restored = replayGameLog(JSON.parse(JSON.stringify(initial)), stored);
    expect(restored.game).toEqual(outcome.after);
    expect(restored.frames.map(({ after }) => after.phase)).toEqual([
      "night-mafia",
      "night-mafia-result",
      "finished",
    ]);
    expect(() =>
      replayGameLog(initial, [
        root.entry,
        shot.entry,
        { ...outcome.entry, stateHashAfter: shot.entry.stateHashAfter },
      ]),
    ).toThrow(/state hash mismatch/i);
  });
  it("rejects an invalid synthetic identity in a replay baseline, even with no events", () => {
    const initial = dayOne();
    const casperAtOne = {
      ...initial,
      players: initial.players.map((player) =>
        player.seat === 1 ? { ...player, id: CASPER_PLAYER_ID } : player,
      ),
    };
    expect(() => replayGameLog(baseline(casperAtOne), [])).toThrow(/Casper.*seat 10/i);
    const casperMafia = {
      ...initial,
      players: initial.players.map((player) =>
        player.role === "mafia" ? { ...player, id: CASPER_PLAYER_ID } : player,
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
              role: "mafia" as const,
              team: "black" as const,
            }
          : player,
      ),
    };
    expect(() => replayGameLog(baseline(wrongRole), [])).toThrow(/Casper.*citizen/i);
    const oldNamedCasper = {
      ...initial,
      players: initial.players.map((player) =>
        player.seat === 10 ? { ...player, name: CASPER_NAME } : player,
      ),
    };
    expect(() => replayGameLog(baseline(oldNamedCasper), [])).toThrow();
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
    for (const to of ["voting-cancelled", "night-don", "night-sheriff", "best-move"] as const) {
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
  it("replays a new day from the persisted actual opening seat", () => {
    const initial = advanceOpeningPhase(
      advanceOpeningPhase(markPlayerInactive(planningGame(), 2, "eliminated")),
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
    const initial = advanceOpeningPhase(
      advanceOpeningPhase(markPlayerInactive(planningGame(), 2, "eliminated")),
    );
    const dayTwo = completeNight({ ...initial, phase: "night-resolution" });
    const before: GameState = { ...dayTwo, phase: "night-resolution" };
    delete (
      before as {
        dayOpeningSeat?: number;
      }
    ).dayOpeningSeat;
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
    delete (
      oldAfter as {
        dayOpeningSeat?: number;
      }
    ).dayOpeningSeat;
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
    delete (
      oldAfter as {
        nightCheckEligibility?: unknown;
      }
    ).nightCheckEligibility;
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
      replayVersion: 3,
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
      replayVersion: 3,
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
    ).toThrow(/cannot skip meaningful phase/i);
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
        type: "discipline.removal-observed",
        payload: {
          seat: 4,
          stage: "day-discussion",
          rule: "6.2.4",
          reason: "",
          checkInProgress: false,
          source: "ignored",
        },
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
    expect(() => replayGameLog({ replayVersion: 3, game: {} as GameState }, [])).toThrow(
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
    let voting = dayOne();
    for (const seat of [1, 2])
      voting = applyGameEvent(voting, {
        type: "player.nominated",
        payload: { nominatorSeat: seat, candidateSeat: seat === 1 ? 4 : 6 },
      });
    voting = applyGameEvent(voting, { type: "phase.changed", payload: { to: "voting" } });
    expect(() =>
      applyGameEvent(voting, { type: "phase.changed", payload: { to: "night-mafia" } }),
    ).toThrow(/phase change from voting/i);
    expect(
      applyGameEvent(dayOne(), { type: "phase.changed", payload: { to: "night-mafia" } }),
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
      ballot: createFederationBallot(4),
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
    ).toThrow(/voting phase fields/i);
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
        type: "foul.issued",
        payload: { seat: 1, foulNumber: 1, redCarded: false, currentTurnIndex: 0 },
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
      { type: "phase.changed", payload: { to: "sheriff-identification" } },
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
      ["mafia-planning", "sheriff-identification"],
      ["sheriff-identification", "day"],
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
  it("rejects contradictory voting baselines and duplicate legal skip markers", () => {
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
    ).toThrow(/ordered ballot/i);
    const skipped = applyGameEvent(dayOne(), {
      type: "voting.legally-skipped",
      payload: { reason: "no-nominees" },
    });
    expect(skipped.phase).toBe("night-mafia");
    expect(() =>
      applyGameEvent(skipped, {
        type: "voting.legally-skipped",
        payload: { reason: "no-nominees" },
      }),
    ).toThrow(/discussion skip/i);
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
        replayVersion: 3,
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
    const root = entry(decision, 1, { type: "game.checkpointed", payload: {} });
    const votes = Object.fromEntries(decision.players.map(({ seat }) => [seat, seat <= 6]));
    const accepted = entry(
      root.after,
      2,
      {
        type: "car-crash.resolved",
        payload: {
          votes,
          result: { eliminate: true, seats: [4, 6], yesVotes: 6, eligibleVoters: 10 },
        },
      },
      root.entry.id,
    );
    const omittedVotes = Object.fromEntries(Object.entries(votes).filter(([, vote]) => vote));
    const forged = {
      ...accepted.entry,
      payload: { ...accepted.entry.payload, votes: omittedVotes },
    } as GameLogEntry;
    expect(() => replayGameLog(baseline(decision), [root.entry, forged])).toThrow(
      /state hash mismatch/i,
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
