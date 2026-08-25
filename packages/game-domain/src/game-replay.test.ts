import { describe, expect, it } from "vitest";
import { advanceSetupPhase, createGame } from "./game.js";
import {
  applyGameEvent,
  createGameLogEntry,
  hashGameState,
  isProvisionalInteractionType,
  replayGameLog,
  type CanonicalGameEventDraft,
  type GameLogEntry,
  type InitialGameBaseline,
} from "./game-events.js";
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

const legacyStateHash = (game: GameState): string => {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value === null || typeof value !== "object"
        ? value
        : Object.fromEntries(
            Object.entries(value)
              .filter(([, entry]) => entry !== undefined)
              .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
              .map(([key, entry]) => [key, canonical(entry)]),
          );
  const text = JSON.stringify(canonical(game));
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

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

  it("rejects a secret event whose caller marks it public", () => {
    const game = { ...dayOne(), phase: "night-don" as const };
    const target = game.players.find(({ role }) => role === "sheriff")!;

    expect(() =>
      applyGameEvent(game, {
        type: "don.checked",
        payload: { targetSeat: target.seat, match: true },
        secret: false,
      } as unknown as CanonicalGameEventDraft),
    ).toThrow(/secret/i);
    expect(() =>
      applyGameEvent(game, {
        type: "don.checked",
        payload: { targetSeat: target.seat, match: true },
        secret: true,
      }),
    ).not.toThrow();
    expect(() =>
      applyGameEvent(dayOne(), {
        type: "game.started",
        payload: {},
        secret: false,
      } as unknown as CanonicalGameEventDraft),
    ).toThrow(/secret/i);
    expect(() =>
      applyGameEvent(dayOne(), {
        type: "turn.completed",
        payload: { seat: 1 },
        secret: true,
      } as unknown as CanonicalGameEventDraft),
    ).toThrow(/secret/i);
  });

  it("rejects unknown event types and ignored payload fields", () => {
    expect(() =>
      applyGameEvent(dayOne(), {
        type: "player.nominated",
        payload: { nominatorSeat: 1, candidateSeat: 4, note: "ignored" },
        secret: false,
      } as unknown as CanonicalGameEventDraft),
    ).toThrow(/payload/i);
    expect(() =>
      applyGameEvent(dayOne(), {
        type: "player.red-carded",
        payload: { seat: 4, source: "ignored" },
        secret: false,
      } as unknown as CanonicalGameEventDraft),
    ).toThrow(/payload/i);
    expect(() =>
      applyGameEvent(dayOne(), {
        type: "game.corrupted",
        payload: {},
        secret: false,
      } as unknown as CanonicalGameEventDraft),
    ).toThrow(/event type/i);
    expect(() =>
      applyGameEvent(dayOne(), {
        type: "player.nominated",
        payload: { nominatorSeat: 1, candidateSeat: 11 },
        secret: false,
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
          secret: true,
        },
      ),
    ).toThrow(/duplicate shooterSeat/i);
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
        secret: false,
      }),
    ).toThrow(/cannot replay a phase change/i);
    expect(() =>
      applyGameEvent(dayOne(), {
        type: "phase.changed",
        payload: { to: "night-mafia" },
        secret: false,
      }),
    ).toThrow(/cannot replay a phase change/i);
  });

  it("rejects malformed event envelopes and non-integer sequences", () => {
    const initial = dayOne();
    const first = entry(initial, 1, {
      type: "player.nominated",
      payload: { nominatorSeat: 1, candidateSeat: 4 },
      secret: false,
    });

    expect(() =>
      createGameLogEntry({
        gameId: first.entry.gameId,
        id: id(2),
        sequence: 1.5,
        parentEventId: first.entry.id,
        createdAt: "2026-08-25T00:02:00.000Z",
        before: first.after,
        draft: { type: "turn.completed", payload: { seat: 1 }, secret: false },
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
      secret: false,
    };

    const after = applyGameEvent(initial, draft);

    expect(after.nominations).toEqual([{ nominatorSeat: 1, candidateSeat: 4, order: 1 }]);
    expect(initial.nominations).toEqual([]);
  });

  it("captures fourth-foul red-card consequences in one event", () => {
    let game = dayOne();
    const target = game.players.find(({ role }) => role === "citizen")!;
    for (let number = 1; number <= 3; number += 1) {
      game = applyGameEvent(game, {
        type: "foul.issued",
        payload: { seat: target.seat, foulNumber: number, redCarded: false },
        secret: false,
      });
    }

    const after = applyGameEvent(game, {
      type: "foul.issued",
      payload: { seat: target.seat, foulNumber: 4, redCarded: true },
      secret: false,
    });

    expect(after.players.find(({ seat }) => seat === target.seat)).toMatchObject({
      fouls: 4,
      status: "red-carded",
    });
  });

  it("reconstructs a secret Best move independently of provisional selections", () => {
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
      secret: true as const,
    };

    expect(applyGameEvent(bestMove, draft)).toMatchObject({
      phase: "goodbye-speech",
      bestMove: { playerSeat: owner.seat, selectedSeats, mafiaHits },
    });
    expect(() => applyGameEvent(bestMove, { ...draft, secret: false } as never)).toThrow(
      /secret=true/i,
    );
  });

  it("replays evaluated Mafia shots as one event", () => {
    const skipped = applyGameEvent(dayOne(), {
      type: "voting.skipped",
      payload: { reason: "host-skipped" },
      secret: false,
    });
    const night = applyGameEvent(skipped, {
      type: "phase.changed",
      payload: { to: "night-mafia" },
      secret: false,
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
      secret: true,
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
      secret: true,
    });
    const first = entry(
      root.after,
      2,
      {
        type: "player.nominated",
        payload: { nominatorSeat: 1, candidateSeat: 4 },
        secret: false,
      },
      root.entry.id,
    );
    const second = entry(
      first.after,
      3,
      { type: "turn.completed", payload: { seat: 1 }, secret: false },
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

  it("replays legacy 8-hex state hashes without generating new weak hashes", () => {
    const initial = dayOne();
    const first = entry(initial, 1, {
      type: "player.nominated",
      payload: { nominatorSeat: 1, candidateSeat: 4 },
      secret: false,
    });
    const legacyEntry = { ...first.entry, stateHashAfter: legacyStateHash(first.after) };

    expect(replayGameLog(baseline(initial), [legacyEntry]).game).toEqual(first.after);
    expect(hashGameState(first.after)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("replays a persisted legacy chain followed by a canonical SHA event", () => {
    const initial = dayOne();
    const first = entry(initial, 1, {
      type: "player.nominated",
      payload: { nominatorSeat: 1, candidateSeat: 4 },
      secret: false,
    });
    const legacyParent = { ...first.entry, stateHashAfter: legacyStateHash(first.after) };

    const second = entry(
      first.after,
      2,
      { type: "turn.completed", payload: { seat: 1 }, secret: false },
      legacyParent.id,
    );

    expect(replayGameLog(baseline(initial), [legacyParent, second.entry]).game).toEqual(
      second.after,
    );
  });

  it("rejects integrity downgrades and malformed modern lifecycle roots", () => {
    const initial = dayOne();
    const root = entry(initial, 1, {
      type: "game.checkpointed",
      payload: {},
      secret: true,
    });
    const next = entry(
      root.after,
      2,
      {
        type: "player.nominated",
        payload: { nominatorSeat: 1, candidateSeat: 4 },
        secret: false,
      },
      root.entry.id,
    );

    expect(() =>
      replayGameLog(baseline(initial), [
        root.entry,
        { ...next.entry, stateHashAfter: legacyStateHash(next.after) },
      ]),
    ).toThrow(/legacy state hash.*after sha/i);
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
      secret: false,
    });
    expect(() =>
      applyGameEvent(cancelled, {
        type: "voting.skipped",
        payload: { reason: "host-skipped" },
        secret: false,
      }),
    ).toThrow(/day phase/i);
  });

  it("replays a legacy check made by an owner eliminated before that night", () => {
    const initial = dayOne();
    const sheriff = initial.players.find(({ role }) => role === "sheriff")!;
    const target = initial.players.find(({ team }) => team === "black")!;
    const before: GameState = {
      ...initial,
      phase: "night-sheriff",
      players: initial.players.map((player) =>
        player.seat === sheriff.seat ? { ...player, status: "eliminated" as const } : player,
      ),
    };
    const after: GameState = {
      ...before,
      phase: "night-sheriff-result",
      checkResult: {
        kind: "sheriff-check",
        targetSeat: target.seat,
        match: true,
        secret: true,
      },
    };
    const legacyEntry: GameLogEntry = {
      replayVersion: 1,
      id: id(1),
      gameId: "00000000-0000-4000-8000-000000000999",
      sequence: 1,
      parentEventId: null,
      type: "sheriff.checked",
      payload: { targetSeat: target.seat, match: true },
      secret: true,
      phaseBefore: before.phase,
      phaseAfter: after.phase,
      dayBefore: before.day,
      dayAfter: after.day,
      stateHashAfter: legacyStateHash(after),
      createdAt: "2026-08-18T08:01:00.000Z",
    };

    expect(replayGameLog(baseline(before), [legacyEntry]).game).toEqual(after);
    expect(
      replayGameLog(baseline(before), [
        { ...legacyEntry, secret: false } as unknown as GameLogEntry,
      ]).game,
    ).toEqual(after);
    expect(() =>
      replayGameLog(baseline({ ...before, phase: "day" }), [
        { ...legacyEntry, phaseBefore: "day" },
      ]),
    ).toThrow(/cannot replay from day/i);
  });

  it("replays legacy car-crash decisions whose omitted voters meant no", () => {
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
      secret: false,
    });
    const legacyVotes = Object.fromEntries(Object.entries(votes).filter(([, vote]) => vote));
    const legacyAfter =
      accepted.after.carCrashVotes === undefined
        ? accepted.after
        : { ...accepted.after, carCrashVotes: legacyVotes };
    const legacyEntry = {
      ...accepted.entry,
      payload: { ...accepted.entry.payload, votes: legacyVotes },
      stateHashAfter: legacyStateHash(legacyAfter),
    } as GameLogEntry;

    expect(replayGameLog(baseline(decision), [legacyEntry]).game).toEqual(legacyAfter);
  });

  it("supports independent append-only branches from one parent", () => {
    const initial = dayOne();
    const root = entry(initial, 1, { type: "game.checkpointed", payload: {}, secret: true });
    const parent = entry(
      root.after,
      2,
      {
        type: "player.nominated",
        payload: { nominatorSeat: 1, candidateSeat: 4 },
        secret: false,
      },
      root.entry.id,
    );
    const left = entry(
      parent.after,
      3,
      { type: "turn.completed", payload: { seat: 1 }, secret: false },
      parent.entry.id,
    );
    const right = entry(
      parent.after,
      4,
      { type: "foul.issued", payload: { seat: 5, foulNumber: 1, redCarded: false }, secret: false },
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
    const root = entry(initial, 1, { type: "game.checkpointed", payload: {}, secret: true });
    const parent = entry(
      root.after,
      2,
      {
        type: "player.nominated",
        payload: { nominatorSeat: 1, candidateSeat: 4 },
        secret: false,
      },
      root.entry.id,
    );
    const child = entry(
      parent.after,
      4,
      { type: "turn.completed", payload: { seat: 1 }, secret: false },
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
      secret: false,
    });
    const second = entry(
      first.after,
      2,
      { type: "turn.completed", payload: { seat: 1 }, secret: false },
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

  it("validates completion markers and classifies vote removal as provisional", () => {
    expect(() =>
      applyGameEvent(dayOne(), {
        type: "game.completed",
        payload: { winner: "red" },
        secret: false,
      }),
    ).toThrow(/finished/i);
    expect(() =>
      applyGameEvent(
        { ...dayOne(), phase: "finished", winner: "red" },
        { type: "game.completed", payload: { winner: "black" }, secret: false },
      ),
    ).toThrow(/winner/i);
    expect(isProvisionalInteractionType("vote.removed")).toBe(true);
  });
});
