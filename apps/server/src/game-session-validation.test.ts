import { describe, expect, it } from "vitest";
import { createGameLogEntry } from "@mafia/game-domain";
import {
  gameSessionCompleteMutationSchema,
  gameSessionMutationSchema,
  setupSessionStateSchema,
} from "./game-session-validation.js";
import * as validationSchemas from "./game-session-validation.js";

const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

const clubRoles = [
  "sheriff",
  "citizen",
  "citizen",
  "citizen",
  "citizen",
  "citizen",
  "citizen",
  "mafia",
  "mafia",
  "don",
] as const;

const liveGame = (day: number) => ({
  phase: "day" as const,
  day,
  players: clubRoles.map((role, index) => ({
    id: uuid(index + 1),
    name: `Player ${index + 1}`,
    seat: index + 1,
    role,
    team: role === "mafia" || role === "don" ? ("black" as const) : ("red" as const),
    status: "active" as const,
    fouls: 0,
    mutePending: false,
  })),
  turnOrder: Array.from({ length: 10 }, (_, index) => index + 1),
  currentTurnIndex: 0,
  nominations: [],
  voteAssignments: {},
  shotAssignments: {},
  winner: null,
});

describe("game session validation", () => {
  it("requires only an idempotency UUID and base revision to normalize a session", () => {
    const schema = (
      validationSchemas as unknown as {
        readonly gameSessionNormalizeMutationSchema?: {
          readonly safeParse: (value: unknown) => { readonly success: boolean };
        };
      }
    ).gameSessionNormalizeMutationSchema;

    expect(schema?.safeParse({ mutationId: uuid(89), baseRevision: 3 }).success).toBe(true);
    expect(schema?.safeParse({ mutationId: "not-a-uuid", baseRevision: 3 }).success).toBe(false);
    expect(schema?.safeParse({ mutationId: uuid(89), baseRevision: -1 }).success).toBe(false);
    expect(
      schema?.safeParse({ mutationId: uuid(89), baseRevision: 3, state: liveGame(1) }).success,
    ).toBe(false);
  });

  it("accepts one verified lifecycle root and its immutable baseline", () => {
    const gameId = uuid(88);
    const initialGame = { replayVersion: 1 as const, game: liveGame(1) };
    const { entry } = createGameLogEntry({
      gameId,
      id: uuid(87),
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-08-25T00:00:00.000Z",
      before: initialGame.game,
      draft: { type: "game.checkpointed", payload: {} },
    });
    const schema = (
      validationSchemas as unknown as {
        readonly gameSessionStartMutationSchema?: {
          readonly safeParse: (value: unknown) => { readonly success: boolean };
        };
      }
    ).gameSessionStartMutationSchema;

    const valid = { mutationId: uuid(86), baseRevision: 4, initialGame, event: entry };
    expect(schema?.safeParse(valid).success).toBe(true);
    expect(
      schema?.safeParse({
        ...valid,
        event: { ...entry, type: "turn.completed", payload: { seat: 1 } },
      }).success,
    ).toBe(false);
    expect(
      schema?.safeParse({ ...valid, event: { ...entry, parentEventId: uuid(85) } }).success,
    ).toBe(false);
    expect(schema?.safeParse({ ...valid, cumulativeGame: liveGame(2) }).success).toBe(false);
  });

  it("accepts exactly one canonical non-root replay entry for append", () => {
    const gameId = uuid(84);
    const before = liveGame(1);
    const { entry } = createGameLogEntry({
      gameId,
      id: uuid(83),
      sequence: 2,
      parentEventId: uuid(82),
      createdAt: "2026-08-25T00:01:00.000Z",
      before,
      draft: { type: "turn.completed", payload: { seat: 1 } },
    });
    const schema = (
      validationSchemas as unknown as {
        readonly gameSessionEventMutationSchema?: {
          readonly safeParse: (value: unknown) => { readonly success: boolean };
        };
      }
    ).gameSessionEventMutationSchema;
    const valid = { mutationId: uuid(81), baseRevision: 5, event: entry };

    expect(schema?.safeParse(valid).success).toBe(true);
    const drawn = createGameLogEntry({
      gameId,
      id: uuid(80),
      sequence: 2,
      parentEventId: uuid(82),
      createdAt: "2026-08-25T00:02:00.000Z",
      before,
      draft: { type: "game.drawn", payload: { reason: "Three quiet cycles" } },
    }).entry;
    expect(schema?.safeParse({ ...valid, event: drawn }).success).toBe(true);
    expect(
      schema?.safeParse({
        ...valid,
        event: { ...drawn, payload: { reason: "   " } },
      }).success,
    ).toBe(false);
    expect(schema?.safeParse({ ...valid, event: [entry, entry] }).success).toBe(false);
    expect(
      schema?.safeParse({ ...valid, event: { ...entry, type: "vote.assigned" } }).success,
    ).toBe(false);
    expect(schema?.safeParse({ ...valid, events: [entry] }).success).toBe(false);
  });

  it("enforces canonical payload and hash contracts at runtime", () => {
    const gameId = uuid(84);
    const before = liveGame(1);
    const { entry } = createGameLogEntry({
      gameId,
      id: uuid(83),
      sequence: 2,
      parentEventId: uuid(82),
      createdAt: "2026-08-25T00:01:00.000Z",
      before,
      draft: { type: "turn.completed", payload: { seat: 1 } },
    });
    const schema = validationSchemas.gameSessionEventMutationSchema;
    const request = { mutationId: uuid(81), baseRevision: 5, event: entry };

    expect(
      schema.safeParse({
        ...request,
        event: { ...entry, stateHashAfter: `sha256:${"a".repeat(64)}` },
      }).success,
    ).toBe(true);

    expect(
      schema.safeParse({
        ...request,
        event: {
          ...entry,
          type: "mafia.shots-resolved",
          payload: {
            shots: [{ shooterSeat: 8, targetSeat: 1, secret: true }],
            result: { kind: "kill", targetSeat: 1 },
          },
        },
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        ...request,
        event: { ...entry, payload: { seat: 1, injected: true } },
      }).success,
    ).toBe(false);

    expect(
      schema.safeParse({
        ...request,
        event: { ...entry, stateHashAfter: `sha256:${"A".repeat(64)}` },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...request,
        event: { ...entry, stateHashAfter: "a".repeat(64) },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...request,
        event: { ...entry, stateHashAfter: "deadbeef" },
      }).success,
    ).toBe(false);
  });

  it("accepts only reachable-head movement reasons and a UUID target", () => {
    const schema = (
      validationSchemas as unknown as {
        readonly gameSessionHeadMutationSchema?: {
          readonly safeParse: (value: unknown) => { readonly success: boolean };
        };
      }
    ).gameSessionHeadMutationSchema;
    const base = { mutationId: uuid(80), baseRevision: 6, targetEventId: uuid(79) };

    for (const reason of ["undo", "reset", "restore-reset"]) {
      expect(schema?.safeParse({ ...base, reason }).success).toBe(true);
    }
    expect(schema?.safeParse({ ...base, reason: "redo" }).success).toBe(false);
    expect(schema?.safeParse({ ...base, targetEventId: null, reason: "reset" }).success).toBe(
      false,
    );
    expect(schema?.safeParse({ ...base, reason: "reset", game: liveGame(1) }).success).toBe(false);
  });

  it("accepts completion results without a cumulative game snapshot", () => {
    const game = liveGame(1);
    const results = {
      hostPlayerId: uuid(11),
      winner: "red" as const,
      playedAt: "2026-08-25T00:02:00.000Z",
      players: game.players.map(({ id, seat, role, team, status, fouls }) => ({
        playerId: id,
        seat,
        role,
        team,
        status,
        fouls,
        bestMoveHits: null,
      })),
    };
    const schema = (
      validationSchemas as unknown as {
        readonly gameSessionCompleteMutationSchema?: {
          readonly safeParse: (value: unknown) => { readonly success: boolean };
        };
      }
    ).gameSessionCompleteMutationSchema;
    const valid = { mutationId: uuid(78), baseRevision: 7, results };

    expect(schema?.safeParse(valid).success).toBe(true);
    expect(schema?.safeParse({ ...valid, results: null }).success).toBe(false);
    expect(schema?.safeParse({ ...valid, state: { game } }).success).toBe(false);
  });

  it("validates winner, draw, and cancellation completion shapes while accepting legacy wins", () => {
    const game = liveGame(1);
    const players = game.players.map(({ id, seat, role, team, status, fouls }) => ({
      playerId: id,
      seat,
      role,
      team,
      status,
      fouls,
      bestMoveHits: null,
    }));
    const base = {
      mutationId: uuid(78),
      baseRevision: 7,
      results: {
        hostPlayerId: uuid(11),
        playedAt: "2026-08-25T00:02:00.000Z",
        players,
      },
    };

    expect(
      gameSessionCompleteMutationSchema.safeParse({
        ...base,
        results: { ...base.results, outcome: "red", winner: "red", reason: null },
      }).success,
    ).toBe(true);
    expect(
      gameSessionCompleteMutationSchema.safeParse({
        ...base,
        results: { ...base.results, outcome: "draw", winner: null, reason: "Three quiet cycles" },
      }).success,
    ).toBe(true);
    expect(
      gameSessionCompleteMutationSchema.safeParse({
        ...base,
        results: { ...base.results, outcome: "cancelled", winner: null, reason: "Venue closed" },
      }).success,
    ).toBe(true);
    expect(
      gameSessionCompleteMutationSchema.safeParse({
        ...base,
        results: { ...base.results, outcome: "draw", winner: null, reason: null },
      }).success,
    ).toBe(false);
    expect(
      gameSessionCompleteMutationSchema.safeParse({
        ...base,
        results: { ...base.results, outcome: "draw", winner: null, reason: " padded " },
      }).success,
    ).toBe(false);
    expect(
      gameSessionCompleteMutationSchema.safeParse({
        ...base,
        results: { ...base.results, outcome: "red", winner: "black", reason: null },
      }).success,
    ).toBe(false);
  });

  it("requires a reasoned snapshot result to match its canonical terminal event", () => {
    const gameId = uuid(120);
    const before = liveGame(1);
    const initialGame = { replayVersion: 1 as const, game: before };
    const root = createGameLogEntry({
      gameId,
      id: uuid(121),
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-08-25T00:01:00.000Z",
      before,
      draft: { type: "game.checkpointed", payload: {} },
    });
    const drawn = createGameLogEntry({
      gameId,
      id: uuid(122),
      sequence: 2,
      parentEventId: root.entry.id,
      createdAt: "2026-08-25T00:02:00.000Z",
      before: root.after,
      draft: { type: "game.drawn", payload: { reason: "Three quiet cycles" } },
    });
    const results = {
      hostPlayerId: uuid(11),
      outcome: "draw" as const,
      winner: null,
      reason: "Three quiet cycles",
      playedAt: drawn.entry.createdAt,
      players: drawn.after.players.map(({ id, seat, role, team, status, fouls }) => ({
        playerId: id,
        seat,
        role,
        team,
        status,
        fouls,
        bestMoveHits: null,
      })),
    };
    const request = {
      name: "Canonical draw",
      mutationId: uuid(123),
      baseRevision: 2,
      state: {
        setup: null,
        game: drawn.after,
        hostPlayerId: uuid(11),
        hostName: "Host",
        playlistId: "",
        log: [],
        undoHistory: [],
        initialGame,
        events: [root.entry, drawn.entry],
        headEventId: drawn.entry.id,
      },
      results,
    };

    expect(gameSessionMutationSchema.safeParse(request).success).toBe(true);
    expect(gameSessionMutationSchema.safeParse({ ...request, results: null }).success).toBe(false);
    expect(
      gameSessionMutationSchema.safeParse({
        ...request,
        results: { ...results, reason: "Different ruling" },
      }).success,
    ).toBe(false);
  });

  it("allows a winning session to wait for explicit result confirmation", () => {
    const base = liveGame(3);
    const finished = {
      ...base,
      phase: "finished" as const,
      winner: "red" as const,
      players: base.players.map((player) =>
        player.team === "black" ? { ...player, status: "eliminated" as const } : player,
      ),
      turnOrder: base.turnOrder.filter((seat) => seat <= 7),
    };
    const parsed = gameSessionMutationSchema.safeParse({
      name: "Awaiting finish confirmation",
      mutationId: uuid(90),
      baseRevision: 4,
      state: {
        setup: null,
        game: finished,
        hostPlayerId: uuid(11),
        hostName: "Host",
        playlistId: "",
        log: [],
        undoHistory: [],
      },
      results: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("treats the full game snapshot as authoritative when semantic history replays to another valid state", () => {
    const gameId = uuid(92);
    const baselineGame = liveGame(1);
    const initialGame = { replayVersion: 1 as const, game: baselineGame };
    const { entry } = createGameLogEntry({
      gameId,
      id: uuid(93),
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-08-31T15:00:00.000Z",
      before: baselineGame,
      draft: { type: "game.checkpointed", payload: {} },
    });
    const snapshot = liveGame(3);
    const finished = {
      ...snapshot,
      phase: "finished" as const,
      winner: "red" as const,
      players: snapshot.players.map((player) =>
        player.team === "black" ? { ...player, status: "eliminated" as const } : player,
      ),
      turnOrder: snapshot.turnOrder.filter((seat) => seat <= 7),
    };
    const results = {
      hostPlayerId: uuid(11),
      winner: "red" as const,
      playedAt: "2026-08-31T15:01:00.000Z",
      players: finished.players.map(({ id, seat, role, team, status, fouls }) => ({
        playerId: id,
        seat,
        role,
        team,
        status,
        fouls,
        bestMoveHits: null,
      })),
    };

    const parsed = gameSessionMutationSchema.safeParse({
      name: "Authoritative browser snapshot",
      mutationId: uuid(94),
      state: {
        setup: null,
        game: finished,
        hostPlayerId: uuid(11),
        hostName: "Host",
        playlistId: "",
        log: [],
        undoHistory: [],
        initialGame,
        events: [entry],
        headEventId: entry.id,
      },
      results,
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const inactiveRoot = { ...entry, id: uuid(95) };
    expect(
      gameSessionMutationSchema.safeParse({
        ...parsed.data,
        state: { ...parsed.data.state, events: [entry, inactiveRoot] },
      }).success,
    ).toBe(false);
    expect(
      gameSessionMutationSchema.safeParse({
        ...parsed.data,
        state: { ...parsed.data.state, resetReturnEventId: uuid(96) },
      }).success,
    ).toBe(false);
  });

  it("conserves the role deck for partial manual role assignments", () => {
    const selectedPlayerIds = Array.from({ length: 10 }, (_, index) => uuid(index + 1));
    const valid = {
      step: "roles",
      hostPlayerId: uuid(11),
      selectedPlayerIds,
      setup: {
        step: "role-draw",
        players: selectedPlayerIds.map((id, index) => ({
          id,
          name: `Player ${index + 1}`,
          seat: index + 1,
        })),
        roleDeck: clubRoles,
        remainingRoles: clubRoles.filter((role) => role !== "sheriff"),
        assignments: { "1": "sheriff" },
      },
    };
    expect(setupSessionStateSchema.safeParse(valid).success).toBe(true);
    expect(
      setupSessionStateSchema.safeParse({
        ...valid,
        setup: { ...valid.setup, assignments: { "01": "sheriff" } },
      }).success,
    ).toBe(false);
    expect(
      setupSessionStateSchema.safeParse({
        ...valid,
        setup: { ...valid.setup, remainingRoles: valid.setup.remainingRoles.slice(1) },
      }).success,
    ).toBe(false);
  });

  it("enforces the persisted voting candidate cursor and final auto-fill", () => {
    const base = liveGame(1);
    const voting = {
      ...base,
      phase: "voting",
      nominations: [
        { nominatorSeat: 1, candidateSeat: 4, order: 1 },
        { nominatorSeat: 2, candidateSeat: 6, order: 2 },
      ],
      turnOrder: [4, 6],
      currentTurnIndex: 0,
      votingRound: "initial",
      voteAssignments: { "1": 4 },
    };
    const parse = (game: object) =>
      gameSessionMutationSchema.safeParse({
        name: "Voting cursor",
        mutationId: uuid(95),
        baseRevision: 0,
        state: {
          setup: null,
          game,
          hostPlayerId: uuid(11),
          hostName: "Host",
          playlistId: "",
          log: [],
          undoHistory: [],
        },
        results: null,
      });

    expect(parse(voting).success).toBe(true);
    expect(parse({ ...voting, turnOrder: base.turnOrder }).success).toBe(false);
    expect(parse({ ...voting, voteAssignments: { "1": 6 } }).success).toBe(false);
    expect(parse({ ...voting, voteAssignments: { "01": 4 } }).success).toBe(false);
    expect(parse({ ...voting, currentTurnIndex: 1 }).success).toBe(false);
  });

  it("preserves a persisted voting cancellation reason", () => {
    const base = liveGame(1);
    const parsed = gameSessionMutationSchema.safeParse({
      name: "Cancelled voting",
      mutationId: uuid(96),
      baseRevision: 0,
      state: {
        setup: null,
        game: {
          ...base,
          phase: "voting-cancelled",
          players: base.players.map((player) =>
            player.seat === 1 ? { ...player, status: "red-carded" } : player,
          ),
          turnOrder: base.turnOrder.filter((seat) => seat !== 1),
          votingCancellation: { reason: "red-card" },
          redCardIssuedThisDay: true,
        },
        hostPlayerId: uuid(11),
        hostName: "Host",
        playlistId: "",
        log: [],
        undoHistory: [],
      },
      results: null,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.state.game?.votingCancellation).toEqual({ reason: "red-card" });
      expect(parsed.data.state.game?.redCardIssuedThisDay).toBe(true);
    }
  });

  it("accepts a persisted evaluated Mafia result with its provisional victim", () => {
    const base = liveGame(1);
    const parsed = gameSessionMutationSchema.safeParse({
      name: "Evaluated Mafia result",
      mutationId: uuid(97),
      baseRevision: 0,
      state: {
        setup: null,
        game: {
          ...base,
          phase: "night-mafia-result",
          shotAssignments: { "8": 1, "9": 1, "10": 1 },
        },
        hostPlayerId: uuid(11),
        hostName: "Host",
        playlistId: "",
        log: [],
        undoHistory: [],
      },
      results: null,
    });

    expect(parsed.success).toBe(true);
  });

  it("validates persisted check-result and Best move phases", () => {
    const base = liveGame(1);
    const parse = (game: unknown) =>
      gameSessionMutationSchema.safeParse({
        name: "Persisted special phase",
        mutationId: uuid(94),
        baseRevision: 0,
        state: {
          setup: null,
          game,
          hostPlayerId: uuid(11),
          hostName: "Host",
          playlistId: "",
          log: [],
          undoHistory: [],
        },
        results: null,
      });

    expect(
      parse({
        ...base,
        phase: "night-don-result",
        checkResult: { kind: "don-check", targetSeat: 1, match: false, secret: true },
      }).success,
    ).toBe(true);
    expect(parse({ ...base, phase: "night-don-result" }).success).toBe(false);

    const bestMove = {
      ...base,
      phase: "best-move",
      day: 2,
      players: base.players.map((player) =>
        player.seat === 1 ? { ...player, status: "eliminated" as const } : player,
      ),
      turnOrder: base.turnOrder.filter((seat) => seat !== 1),
      bestMove: { playerSeat: 1, selectedSeats: [2, 3] },
    };
    expect(parse(bestMove).success).toBe(true);
    expect(parse({ ...bestMove, bestMove: { ...bestMove.bestMove, mafiaHits: 1 } }).success).toBe(
      false,
    );
  });

  it("rejects a persisted goodbye phase without a speaker", () => {
    const base = liveGame(2);
    const parse = (goodbyeSeats: readonly number[]) =>
      gameSessionMutationSchema.safeParse({
        name: "Persisted goodbye phase",
        mutationId: uuid(95),
        baseRevision: 0,
        state: {
          setup: null,
          game: {
            ...base,
            phase: "goodbye-speech",
            players: base.players.map((player) =>
              player.seat === 1 ? { ...player, status: "eliminated" as const } : player,
            ),
            turnOrder: base.turnOrder.filter((seat) => seat !== 1),
            goodbyeSeats,
            goodbyeNext: "day",
          },
          hostPlayerId: uuid(11),
          hostName: "Host",
          playlistId: "",
          log: [],
          undoHistory: [],
        },
        results: null,
      });

    expect(parse([1]).success).toBe(true);
    expect(parse([]).success).toBe(false);
  });

  it("accepts incomplete Mafia result assignments while rejecting aliases", () => {
    const base = liveGame(1);
    const parse = (game: unknown) =>
      gameSessionMutationSchema.safeParse({
        name: "Mafia result",
        mutationId: uuid(96),
        baseRevision: 0,
        state: {
          setup: null,
          game,
          hostPlayerId: uuid(11),
          hostName: "Host",
          playlistId: "",
          log: [],
          undoHistory: [],
        },
        results: null,
      });

    expect(
      parse({ ...base, phase: "night-mafia-result", shotAssignments: { "8": 1, "9": 1 } }).success,
    ).toBe(true);
    expect(
      parse({
        ...base,
        phase: "night-mafia-result",
        shotAssignments: { "08": 1, "9": 1, "10": 1 },
      }).success,
    ).toBe(false);

    const inactiveTarget = {
      ...base,
      phase: "night-mafia-result",
      players: base.players.map((player) =>
        player.seat === 1 ? { ...player, status: "eliminated" as const } : player,
      ),
      turnOrder: base.turnOrder.filter((seat) => seat !== 1),
      shotAssignments: { "8": 1, "9": 1, "10": 1 },
    };
    const parsed = gameSessionMutationSchema.safeParse({
      name: "Mafia result on inactive target",
      mutationId: uuid(95),
      baseRevision: 0,
      state: {
        setup: null,
        game: inactiveTarget,
        hostPlayerId: uuid(11),
        hostName: "Host",
        playlistId: "",
        log: [],
        undoHistory: [],
      },
      results: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects non-canonical car-crash voter keys", () => {
    const parsed = gameSessionMutationSchema.safeParse({
      name: "Aliased car-crash voter",
      mutationId: uuid(98),
      baseRevision: 0,
      state: {
        setup: null,
        game: {
          ...liveGame(1),
          phase: "car-crash-decision",
          carCrashSeats: [4, 6],
          carCrashVotes: { "1": true, "01": true },
        },
        hostPlayerId: uuid(11),
        hostName: "Host",
        playlistId: "",
        log: [],
        undoHistory: [],
      },
      results: null,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map(({ message }) => message)).toContain(
        "Car-crash vote keys must use canonical seat numbers",
      );
    }
  });

  it("rejects car-crash decision votes from non-active seats", () => {
    const parsed = gameSessionMutationSchema.safeParse({
      name: "Invalid car-crash voter",
      mutationId: uuid(99),
      baseRevision: 0,
      state: {
        setup: null,
        game: {
          ...liveGame(1),
          phase: "car-crash-decision",
          carCrashSeats: [4, 6],
          carCrashVotes: { "11": true },
        },
        hostPlayerId: uuid(11),
        hostName: "Host",
        playlistId: "",
        log: [],
        undoHistory: [],
      },
      results: null,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map(({ message }) => message)).toContain(
        "Only active players may vote in a car crash decision",
      );
    }
  });

  it("accepts a complete provisional car-crash result phase", () => {
    const votes = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [index + 1, index < 6]),
    );
    const parsed = gameSessionMutationSchema.safeParse({
      name: "Reviewed car crash",
      mutationId: uuid(100),
      baseRevision: 0,
      state: {
        setup: null,
        game: {
          ...liveGame(1),
          phase: "car-crash-result",
          nominations: [
            { nominatorSeat: 1, candidateSeat: 4, order: 1 },
            { nominatorSeat: 2, candidateSeat: 6, order: 2 },
          ],
          votingRound: "repeat",
          carCrashSeats: [4, 6],
          carCrashVotes: votes,
          carCrashResult: {
            eliminate: true,
            seats: [4, 6],
            yesVotes: 6,
            eligibleVoters: 10,
          },
        },
        hostPlayerId: uuid(11),
        hostName: "Host",
        playlistId: "",
        log: [],
        undoHistory: [],
      },
      results: null,
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects a setup whose visible players do not match the selected players", () => {
    const roles = [
      "sheriff",
      "citizen",
      "citizen",
      "citizen",
      "citizen",
      "citizen",
      "citizen",
      "mafia",
      "mafia",
      "don",
    ] as const;
    const parsed = gameSessionMutationSchema.safeParse({
      name: "Mismatched setup players",
      mutationId: uuid(99),
      baseRevision: 0,
      state: {
        setup: {
          step: "roles",
          hostPlayerId: uuid(11),
          selectedPlayerIds: Array.from({ length: 10 }, () => ""),
          setup: {
            step: "role-draw",
            players: roles.map((_, index) => ({
              id: uuid(index + 1),
              name: `Player ${index + 1}`,
              seat: index + 1,
            })),
            musicState: "paused",
            roleDeck: roles,
            remainingRoles: roles,
            assignments: {},
          },
        },
        game: null,
        hostPlayerId: uuid(11),
        hostName: "Host",
        playlistId: "playlist",
        log: [],
        undoHistory: [],
      },
      results: null,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: "Setup players must match the selected players" }),
        ]),
      );
    }
  });

  it("rejects a live snapshot whose role distribution is not Club Mafia", () => {
    const parsed = gameSessionMutationSchema.safeParse({
      name: "Invalid roles",
      mutationId: uuid(99),
      baseRevision: 0,
      state: {
        setup: null,
        game: {
          phase: "day",
          day: 1,
          players: Array.from({ length: 10 }, (_, index) => ({
            id: uuid(index + 1),
            name: `Player ${index + 1}`,
            seat: index + 1,
            role: "citizen",
            team: "red",
            status: "active",
            fouls: 0,
            mutePending: false,
          })),
          turnOrder: Array.from({ length: 10 }, (_, index) => index + 1),
          currentTurnIndex: 0,
          nominations: [],
          voteAssignments: {},
          shotAssignments: {},
          winner: null,
        },
        hostPlayerId: uuid(11),
        hostName: "Host",
        playlistId: "",
        log: [],
        undoHistory: [],
      },
      results: null,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ message: "Expected 1 sheriff" })]),
      );
    }
  });

  it("rejects undo history across a day checkpoint or outside the retained log prefix", () => {
    const parsed = gameSessionMutationSchema.safeParse({
      name: "Invalid undo checkpoint",
      mutationId: uuid(99),
      baseRevision: 2,
      state: {
        setup: null,
        game: liveGame(2),
        hostPlayerId: uuid(11),
        hostName: "Host",
        playlistId: "",
        log: [
          {
            id: uuid(50),
            sequence: 1,
            type: "day.started",
            phase: "day",
            payload: { day: 2 },
            createdAt: "2026-08-18T10:00:00.000Z",
          },
        ],
        undoHistory: [{ game: liveGame(1), logLength: 2, sequence: 3 }],
      },
      results: null,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: "Undo history cannot cross a day checkpoint" }),
          expect.objectContaining({
            message: "Undo snapshot must reference a retained log prefix",
          }),
        ]),
      );
    }
  });

  it("rejects a day snapshot with no legal current turn and phase-inappropriate actions", () => {
    const parsed = gameSessionMutationSchema.safeParse({
      name: "Impossible game",
      mutationId: uuid(71),
      baseRevision: 0,
      state: {
        setup: null,
        game: {
          ...liveGame(1),
          turnOrder: [],
          currentTurnIndex: 10,
          nominations: [{ nominatorSeat: 1, candidateSeat: 1, order: 1 }],
          voteAssignments: { "1": 10 },
          shotAssignments: { "1": 10 },
        },
        hostPlayerId: uuid(11),
        hostName: "Host",
        playlistId: "",
        log: [],
        undoHistory: [],
      },
      results: null,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map(({ message }) => message)).toEqual(
        expect.arrayContaining([
          "Day turn order must contain every active player",
          "The current day turn must reference an active player",
          "Votes are not valid during the day phase",
          "Night shots are not valid during the day phase",
        ]),
      );
    }
  });

  it("rejects a setup host that differs from the authoritative session host", () => {
    const parsed = gameSessionMutationSchema.safeParse({
      name: "Mismatched host",
      mutationId: uuid(72),
      baseRevision: 0,
      state: {
        setup: {
          step: "players",
          hostPlayerId: uuid(12),
          selectedPlayerIds: Array.from({ length: 10 }, () => ""),
          setup: null,
        },
        game: null,
        hostPlayerId: uuid(11),
        hostName: "Host Eleven",
        playlistId: "",
        log: [],
        undoHistory: [],
      },
      results: null,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map(({ message }) => message)).toContain(
        "Setup host must match the authoritative session host",
      );
    }
  });

  it("rejects action collections outside the phases that can create them", () => {
    const setupPhase = gameSessionMutationSchema.safeParse({
      name: "Invalid setup actions",
      mutationId: uuid(73),
      baseRevision: 0,
      state: {
        setup: null,
        game: {
          ...liveGame(1),
          phase: "mafia-planning",
          day: 0,
          turnOrder: [],
          currentTurnIndex: 0,
          nominations: [{ nominatorSeat: 1, candidateSeat: 2, order: 1 }],
          voteAssignments: { "1": 2 },
          shotAssignments: { "8": 2 },
        },
        hostPlayerId: uuid(11),
        hostName: "Host",
        playlistId: "",
        log: [],
        undoHistory: [],
      },
      results: null,
    });
    const votingPhase = gameSessionMutationSchema.safeParse({
      name: "Invalid voting shots",
      mutationId: uuid(74),
      baseRevision: 0,
      state: {
        setup: null,
        game: {
          ...liveGame(2),
          phase: "voting",
          nominations: [{ nominatorSeat: 1, candidateSeat: 2, order: 1 }],
          shotAssignments: { "8": 2 },
        },
        hostPlayerId: uuid(11),
        hostName: "Host",
        playlistId: "",
        log: [],
        undoHistory: [],
      },
      results: null,
    });

    expect(setupPhase.success).toBe(false);
    expect(votingPhase.success).toBe(false);
    if (!setupPhase.success) {
      expect(setupPhase.error.issues.map(({ message }) => message)).toEqual(
        expect.arrayContaining([
          "Nominations are not valid during setup phases",
          "Votes are not valid during setup phases",
          "Night shots are not valid before night",
        ]),
      );
    }
    if (!votingPhase.success) {
      expect(votingPhase.error.issues.map(({ message }) => message)).toContain(
        "Night shots are not valid before night",
      );
    }
  });
});
