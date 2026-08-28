import { describe, expect, it } from "vitest";
import { advanceVotingCandidate, completeCurrentTurn, nominate } from "./day-actions.js";
import { advanceSetupPhase, createGame } from "./game.js";
import {
  applyGameEvent,
  canonicalGameEventTypes,
  canonicalSecretGameEventTypes,
  createGameLogEntry,
  hashGameState,
  isMeaningfulGameEventDraft,
  isProvisionalInteractionType,
  isSecretGameEventType,
  replayGameLog,
  type CanonicalGameEventDraft,
  type GameLogEntry,
  type InitialGameBaseline,
} from "./game-events.js";
import * as gameEvents from "./game-events.js";
import {
  beginRoleDraw,
  completeRoleDraw,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
} from "./setup.js";
import { resolveMafiaShots, toggleAllMafiaShotsForTarget } from "./night-actions.js";
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

  it("does not fold Mafia shots across unresolved voting", () => {
    const canonical = nominate(dayOne(), 1, 4);
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
    const canonical = applyGameEvent(dayOne(), {
      type: "player.nominated",
      payload: { nominatorSeat: 1, candidateSeat: 4 },
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
    const canonical = applyGameEvent(dayOne(), {
      type: "player.nominated",
      payload: { nominatorSeat: 1, candidateSeat: 4 },
    });

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

  it("replays legacy 8-hex state hashes without generating new weak hashes", () => {
    const initial = dayOne();
    const first = entry(initial, 1, {
      type: "player.nominated",
      payload: { nominatorSeat: 1, candidateSeat: 4 },
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
    });
    const legacyParent = { ...first.entry, stateHashAfter: legacyStateHash(first.after) };

    const second = entry(
      first.after,
      2,
      { type: "turn.completed", payload: { seat: 1 } },
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
    });
    expect(() =>
      applyGameEvent(cancelled, {
        type: "voting.skipped",
        payload: { reason: "host-skipped" },
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
      phaseBefore: before.phase,
      phaseAfter: after.phase,
      dayBefore: before.day,
      dayAfter: after.day,
      stateHashAfter: legacyStateHash(after),
      createdAt: "2026-08-18T08:01:00.000Z",
    };

    expect(replayGameLog(baseline(before), [legacyEntry]).game).toEqual(after);
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
