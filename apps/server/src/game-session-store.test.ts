import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import {
  createGameLogEntry,
  hashGameState,
  type GameLogEntry,
  type GameState,
} from "@mafia/game-domain";
import { GameSessionStore } from "./game-session-store.js";
import { ClubStore, DEFAULT_CLUB_ID } from "./club-store.js";

const legacyOwnerId = "00000000-0000-4000-8000-000000000001";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgresql://mafia:mafia@127.0.0.1:54329/mafia_test";
const pool = new Pool({ connectionString: databaseUrl });
const store = new GameSessionStore(pool);

const waitForPlayerLockWaiter = async (blockerPid: number, attempts = 100): Promise<void> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const waiting = await pool.query(
      `SELECT 1
         FROM pg_stat_activity AS waiter
        WHERE waiter.datname = current_database()
          AND waiter.pid <> pg_backend_pid()
          AND $1 = ANY(pg_blocking_pids(waiter.pid))`,
      [blockerPid],
    );
    if (waiting.rowCount !== 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `Timed out waiting for a player projection lock blocked by backend ${blockerPid}`,
  );
};

beforeAll(async () => {
  await store.initialize();
});

afterAll(async () => {
  await pool.end();
});

const emptyState = {
  setup: null,
  game: null,
  hostPlayerId: null,
  hostName: null,
  playlistId: "",
  log: [],
  undoHistory: [],
} as const;

const canonicalJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
  );
};

const legacyHashGameState = (game: unknown): string => {
  const text = JSON.stringify(canonicalJsonValue(game));
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const fixedLegacyGameState = {
  phase: "day",
  day: 1,
  players: [
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
  ].map((role, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    name: `Historical Player ${index + 1}`,
    seat: index + 1,
    role,
    team: index >= 7 ? "black" : "red",
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
};

const createCompletedSession = async (gameId: string, clubId = DEFAULT_CLUB_ID) => {
  const hostPlayerId = randomUUID();
  const playerIds = Array.from({ length: 10 }, () => randomUUID());
  const allIds = [hostPlayerId, ...playerIds];
  await pool.query(
    `INSERT INTO players (id, club_id, nickname)
     SELECT fixture.id, $2, fixture.nickname
       FROM UNNEST($1::uuid[], $3::text[]) AS fixture(id, nickname)`,
    [allIds, clubId, allIds.map((_id, index) => `Aggregate ${gameId} ${index}`)],
  );
  const roles = ["sheriff", ...Array(6).fill("citizen"), "mafia", "mafia", "don"] as const;
  const players = playerIds.map((id, index) => ({
    id,
    name: `Player ${index + 1}`,
    seat: index + 1,
    role: roles[index]!,
    team: index >= 7 ? ("black" as const) : ("red" as const),
    status: "active" as const,
    fouls: 0,
    mutePending: false,
  }));
  const game = {
    phase: "finished" as const,
    day: 2,
    players,
    turnOrder: playerIds.map((_id, index) => index + 1),
    currentTurnIndex: 0,
    nominations: [],
    voteAssignments: {},
    shotAssignments: {},
    bestMove: { playerSeat: 1, selectedSeats: [2, 3, 4], mafiaHits: 2 },
    winner: "red" as const,
  };
  return {
    hostPlayerId,
    state: {
      ...emptyState,
      game,
      hostPlayerId,
      hostName: "Aggregate Host",
      log: [
        {
          id: randomUUID(),
          sequence: 1,
          type: "game.finished",
          phase: "finished",
          payload: { winner: "red" },
          createdAt: "2026-08-18T08:00:00.000Z",
        },
      ],
    },
    results: {
      hostPlayerId,
      winner: "red" as const,
      playedAt: "2026-08-18T08:00:00.000Z",
      players: players.map(({ id, seat, role, team, status, fouls }) => ({
        playerId: id,
        seat,
        role,
        team,
        status,
        fouls,
        bestMoveHits: seat === 1 ? 2 : null,
      })),
    },
  };
};

const createStartedDaySessionWithCheckpoints = async (gameId: string, clubId = DEFAULT_CLUB_ID) => {
  const completed = await createCompletedSession(gameId, clubId);
  const game = {
    ...completed.state.game,
    phase: "day" as const,
    day: 1,
    winner: null,
    bestMove: undefined,
    turnOrder: Array.from({ length: 10 }, (_, index) => index + 1),
    currentTurnIndex: 0,
  };
  await store.save({
    clubId,
    gameId,
    name: "Head operation table",
    mutationId: randomUUID(),
    baseRevision: 0,
    state: {
      ...emptyState,
      hostPlayerId: completed.hostPlayerId,
      hostName: "Head Host",
    },
    results: null,
  });
  const initialGame = { replayVersion: 1 as const, game };
  const started = createGameLogEntry({
    gameId,
    id: randomUUID(),
    sequence: 1,
    parentEventId: null,
    createdAt: "2026-08-18T07:59:00.000Z",
    before: game,
    draft: { type: "game.checkpointed", payload: {} },
  });
  await store.start({
    clubId,
    gameId,
    mutationId: randomUUID(),
    baseRevision: 1,
    initialGame,
    event: started.entry,
  });
  const first = createGameLogEntry({
    gameId,
    id: randomUUID(),
    sequence: 2,
    parentEventId: started.entry.id,
    createdAt: "2026-08-18T08:00:00.000Z",
    before: started.after,
    draft: {
      type: "foul.issued",
      payload: { seat: 1, foulNumber: 1, redCarded: false },
    },
  });
  await store.appendEvent({
    clubId,
    gameId,
    mutationId: randomUUID(),
    baseRevision: 2,
    event: first.entry,
  });
  const second = createGameLogEntry({
    gameId,
    id: randomUUID(),
    sequence: 3,
    parentEventId: first.entry.id,
    createdAt: "2026-08-18T08:01:00.000Z",
    before: first.after,
    draft: {
      type: "foul.issued",
      payload: { seat: 2, foulNumber: 1, redCarded: false },
    },
  });
  await store.appendEvent({
    clubId,
    gameId,
    mutationId: randomUUID(),
    baseRevision: 3,
    event: second.entry,
  });
  return { completed, initialGame, started, first, second };
};

const createValidOperationFixtures = async (gameId: string, clubId: string) => {
  const completed = await createCompletedSession(gameId, clubId);
  const game = {
    ...completed.state.game,
    phase: "day" as const,
    day: 1,
    winner: null,
    bestMove: undefined,
    turnOrder: Array.from({ length: 10 }, (_, index) => index + 1),
    currentTurnIndex: 0,
  };
  const initialGame = { replayVersion: 1 as const, game };
  const root = createGameLogEntry({
    gameId,
    id: randomUUID(),
    sequence: 1,
    parentEventId: null,
    createdAt: "2026-08-18T07:59:00.000Z",
    before: game,
    draft: { type: "game.checkpointed", payload: {} },
  });
  const event = createGameLogEntry({
    gameId,
    id: randomUUID(),
    sequence: 2,
    parentEventId: root.entry.id,
    createdAt: "2026-08-18T08:00:00.000Z",
    before: root.after,
    draft: {
      type: "foul.issued",
      payload: { seat: 1, foulNumber: 1, redCarded: false },
    },
  });
  return { initialGame, root, event, results: completed.results };
};

const createCanonicalCompletedSession = async (
  gameId: string,
  clubId = DEFAULT_CLUB_ID,
  persistResults = true,
) => {
  const completed = await createCompletedSession(gameId, clubId);
  await store.save({
    clubId,
    gameId,
    name: "Completed query table",
    mutationId: randomUUID(),
    baseRevision: 0,
    state: {
      ...emptyState,
      hostPlayerId: completed.hostPlayerId,
      hostName: "Completed Query Host",
    },
    results: null,
  });
  const initialGame = { replayVersion: 1 as const, game: completed.state.game };
  const started = createGameLogEntry({
    gameId,
    id: randomUUID(),
    sequence: 1,
    parentEventId: null,
    createdAt: "2026-08-18T07:59:00.000Z",
    before: initialGame.game,
    draft: { type: "game.checkpointed", payload: {} },
  });
  await store.start({
    clubId,
    gameId,
    mutationId: randomUUID(),
    baseRevision: 1,
    initialGame,
    event: started.entry,
  });
  const completion = createGameLogEntry({
    gameId,
    id: randomUUID(),
    sequence: 2,
    parentEventId: started.entry.id,
    createdAt: "2026-08-18T08:00:00.000Z",
    before: started.after,
    draft: { type: "game.completed", payload: { winner: "red" } },
  });
  await store.appendEvent({
    clubId,
    gameId,
    mutationId: randomUUID(),
    baseRevision: 2,
    event: completion.entry,
  });
  const results = { ...completed.results, playedAt: completion.entry.createdAt };
  if (persistResults) {
    await store.complete({
      clubId,
      gameId,
      mutationId: randomUUID(),
      baseRevision: 3,
      results,
    });
  }
  return { completed, completion, results };
};

describe("GameSessionStore", () => {
  it("pins the legacy FNV hash to a fixed historical game snapshot", () => {
    expect(legacyHashGameState(fixedLegacyGameState)).toBe("3143cd5f");
  });

  it("rejects a newly appended event that uses pre-fix mute semantics", async () => {
    const gameId = randomUUID();
    const completed = await createCompletedSession(gameId);
    const candidate = completed.state.game.players.find(({ role }) => role === "citizen")!;
    const voteAssignments = Object.fromEntries(
      completed.state.game.players.map(({ seat }) => [seat, candidate.seat]),
    );
    const voting: GameState = {
      ...completed.state.game,
      phase: "voting",
      day: 1,
      players: completed.state.game.players.map((player) =>
        player.seat === candidate.seat ? { ...player, mutePending: true } : player,
      ),
      turnOrder: [candidate.seat],
      currentTurnIndex: 0,
      nominations: [{ nominatorSeat: 1, candidateSeat: candidate.seat, order: 1 }],
      voteAssignments,
      votingRound: "initial",
      bestMove: undefined,
      winner: null,
    };
    try {
      await store.save({
        gameId,
        name: "Current rule semantics",
        mutationId: randomUUID(),
        baseRevision: 0,
        state: {
          ...emptyState,
          hostPlayerId: completed.hostPlayerId,
          hostName: "Current Rule Host",
        },
        results: null,
      });
      const root = createGameLogEntry({
        gameId,
        id: randomUUID(),
        sequence: 1,
        parentEventId: null,
        createdAt: "2026-09-02T12:00:00.000Z",
        before: voting,
        draft: { type: "game.checkpointed", payload: {} },
      });
      await store.start({
        gameId,
        mutationId: randomUUID(),
        baseRevision: 1,
        initialGame: { replayVersion: 1, game: voting },
        event: root.entry,
      });
      const current = createGameLogEntry({
        gameId,
        id: randomUUID(),
        sequence: 2,
        parentEventId: root.entry.id,
        createdAt: "2026-09-02T12:01:00.000Z",
        before: root.after,
        draft: {
          type: "voting.resolved",
          payload: {
            voteAssignments,
            result: {
              kind: "winner",
              seats: [candidate.seat],
              totals: { [candidate.seat]: voting.players.length },
            },
          },
        },
      });
      const oldAfter: GameState = {
        ...voting,
        phase: "goodbye-speech",
        players: voting.players.map((player) =>
          player.seat === candidate.seat ? { ...player, status: "eliminated" as const } : player,
        ),
        eliminationOccurredThisCycle: true,
        goodbyeSeats: [candidate.seat],
        goodbyeNext: "night",
      };
      const oldEvent: GameLogEntry = {
        ...current.entry,
        phaseAfter: oldAfter.phase,
        stateHashAfter: hashGameState(oldAfter),
      };

      await expect(
        store.appendEvent({
          gameId,
          mutationId: randomUUID(),
          baseRevision: 2,
          event: oldEvent,
        }),
      ).rejects.toMatchObject({
        name: "GameSessionOperationError",
        code: "game_session_replay_invalid",
      });
      await expect(store.get(gameId)).resolves.toMatchObject({
        revision: 2,
        state: { headEventId: root.entry.id },
      });
    } finally {
      await pool.query("DELETE FROM game_sessions WHERE id = $1", [gameId]);
    }
  });

  it("installs the additive replay reconstruction columns and scoped indexes idempotently", async () => {
    await store.initialize();

    const columns = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (table_name, column_name) IN (
            ('game_events', 'replay_sequence'),
            ('game_events', 'phase_after'),
            ('game_events', 'day_before'),
            ('game_events', 'day_after'),
            ('game_sessions', 'replay_base_event_id')
          )
        ORDER BY table_name, column_name`,
    );
    expect(columns.rows).toEqual([
      { table_name: "game_events", column_name: "day_after" },
      { table_name: "game_events", column_name: "day_before" },
      { table_name: "game_events", column_name: "phase_after" },
      { table_name: "game_events", column_name: "replay_sequence" },
      { table_name: "game_sessions", column_name: "replay_base_event_id" },
    ]);

    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN (
            'game_events_club_game_parent_idx',
            'game_events_club_game_replay_sequence_idx',
            'game_sessions_club_head_idx'
          )
        ORDER BY indexname`,
    );
    expect(indexes.rows).toEqual([
      { indexname: "game_events_club_game_parent_idx" },
      { indexname: "game_events_club_game_replay_sequence_idx" },
      { indexname: "game_sessions_club_head_idx" },
    ]);
  });

  it("preserves legacy FNV replay history while backfilling canonical order", async () => {
    const gameId = randomUUID();
    const createdId = randomUUID();
    const startedId = randomUUID();
    const turnId = randomUUID();
    try {
      await pool.query(
        `INSERT INTO game_events
           (id, game_id, sequence, idempotency_key, event_type, phase, phase_after,
            day_before, day_after, payload, state_hash_after)
         VALUES
           ($1, $4, 1, 'legacy-created', 'game.created', 'setup-players', NULL,
            NULL, NULL, '{}'::jsonb, NULL),
           ($2, $4, 2, 'canonical-started', 'game.started', 'day', 'day',
            1, 1, '{}'::jsonb, $5),
           ($3, $4, 3, 'canonical-turn', 'turn.completed', 'day', 'day',
            1, 1, '{"seat": 1}'::jsonb, $6)`,
        [createdId, startedId, turnId, gameId, "deadbeef", "cafebabe"],
      );

      await store.initialize();
      await store.initialize();

      const rows = await pool.query<{
        id: string;
        parent_event_id: string | null;
        replay_sequence: number | null;
        state_hash_after: string | null;
      }>(
        `SELECT id, parent_event_id, replay_sequence, state_hash_after
           FROM game_events
          WHERE game_id = $1
          ORDER BY sequence`,
        [gameId],
      );
      expect(rows.rows).toEqual([
        {
          id: createdId,
          parent_event_id: null,
          replay_sequence: null,
          state_hash_after: null,
        },
        {
          id: startedId,
          parent_event_id: null,
          replay_sequence: 1,
          state_hash_after: "deadbeef",
        },
        {
          id: turnId,
          parent_event_id: startedId,
          replay_sequence: 2,
          state_hash_after: "cafebabe",
        },
      ]);
    } finally {
      await pool.query("DELETE FROM game_events WHERE game_id = $1", [gameId]);
    }
  });

  it("keeps a valid legacy FNV replay readable after schema initialization", async () => {
    const gameId = randomUUID();
    const completed = await createCompletedSession(gameId);
    const initialGame = { replayVersion: 1 as const, game: completed.state.game };
    const started = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-08-18T07:59:00.000Z",
      before: initialGame.game,
      draft: { type: "game.checkpointed", payload: {} },
    });
    const legacyStarted = {
      ...started.entry,
      stateHashAfter: legacyHashGameState(started.after),
    };
    await store.save({
      gameId,
      name: "Legacy FNV resume",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: {
        ...completed.state,
        game: null,
        log: [],
      },
      results: null,
    });
    await store.start({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 1,
      initialGame,
      event: legacyStarted,
    });

    await store.initialize();
    const restored = await store.get(gameId);

    expect(restored).toMatchObject({
      revision: 2,
      state: {
        game: initialGame.game,
        events: [{ id: legacyStarted.id, stateHashAfter: legacyStarted.stateHashAfter }],
        headEventId: legacyStarted.id,
      },
    });
  });

  it("hydrates a persisted legacy Best Move chain without rewriting its events", async () => {
    const gameId = randomUUID();
    const completed = await createCompletedSession(gameId);
    const owner = completed.state.game.players[0]!;
    const inactive = completed.state.game.players[1]!;
    const activeMafia = completed.state.game.players.find(
      ({ team, status }) => team === "black" && status === "active",
    )!;
    const players = completed.state.game.players.map((player) =>
      player.seat === owner.seat || player.seat === inactive.seat
        ? { ...player, status: "eliminated" as const }
        : player,
    );
    const before = {
      ...completed.state.game,
      phase: "best-move",
      winner: null,
      players,
      turnOrder: completed.state.game.turnOrder.filter(
        (seat) => seat !== owner.seat && seat !== inactive.seat,
      ),
      goodbyeSeats: [owner.seat],
      goodbyeNext: "day",
      bestMove: { playerSeat: owner.seat, selectedSeats: [] },
    } satisfies GameState;
    const selectedSeats = [owner.seat, inactive.seat, activeMafia.seat];
    const after = {
      ...before,
      phase: "goodbye-speech",
      bestMove: { playerSeat: owner.seat, selectedSeats, mafiaHits: 1 },
      dayNotice: undefined,
    } satisfies GameState;
    const initialGame = { replayVersion: 1 as const, game: before };
    const started = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-08-18T07:59:00.000Z",
      before,
      draft: { type: "game.checkpointed", payload: {} },
    });
    const legacyStarted = {
      ...started.entry,
      stateHashAfter: legacyHashGameState(started.after),
    };
    const legacyBestMove = {
      replayVersion: 1,
      id: randomUUID(),
      gameId,
      sequence: 2,
      parentEventId: legacyStarted.id,
      type: "best-move.completed",
      payload: { playerSeat: owner.seat, selectedSeats, mafiaHits: 1 },
      phaseBefore: before.phase,
      phaseAfter: after.phase,
      dayBefore: before.day,
      dayAfter: after.day,
      stateHashAfter: legacyHashGameState(after),
      createdAt: "2026-08-18T08:00:00.000Z",
    } satisfies GameLogEntry;

    await store.save({
      gameId,
      name: "Legacy Best Move hydration",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: {
        ...emptyState,
        hostPlayerId: completed.hostPlayerId,
        hostName: "Legacy Best Move Host",
      },
      results: null,
    });
    await store.start({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 1,
      initialGame,
      event: legacyStarted,
    });
    await pool.query(
      `INSERT INTO game_events
         (id, club_id, game_id, sequence, idempotency_key, event_type, phase, phase_after,
          day_before, day_after, payload, parent_event_id, replay_version, replay_sequence,
          state_hash_after, created_at)
       VALUES (
         $1, $2, $3,
         (SELECT COALESCE(MAX(sequence), 0) + 1
            FROM game_events
           WHERE club_id = $2 AND game_id = $3),
         $13, $4, $5, $6, $7, $8, $9::jsonb, $10, 1, 2, $11, $12
       )`,
      [
        legacyBestMove.id,
        DEFAULT_CLUB_ID,
        gameId,
        legacyBestMove.type,
        legacyBestMove.phaseBefore,
        legacyBestMove.phaseAfter,
        legacyBestMove.dayBefore,
        legacyBestMove.dayAfter,
        JSON.stringify(legacyBestMove.payload),
        legacyBestMove.parentEventId,
        legacyBestMove.stateHashAfter,
        legacyBestMove.createdAt,
        legacyBestMove.id,
      ],
    );
    await pool.query("UPDATE game_sessions SET head_event_id = $1 WHERE id = $2 AND club_id = $3", [
      legacyBestMove.id,
      gameId,
      DEFAULT_CLUB_ID,
    ]);

    await store.initialize();
    const restored = await store.get(gameId);

    expect(restored).toMatchObject({
      state: {
        game: after,
        headEventId: legacyBestMove.id,
        events: [
          { id: legacyStarted.id, stateHashAfter: legacyStarted.stateHashAfter },
          {
            id: legacyBestMove.id,
            payload: legacyBestMove.payload,
            stateHashAfter: legacyBestMove.stateHashAfter,
          },
        ],
        log: [
          { id: legacyStarted.id, type: "game.checkpointed" },
          { id: legacyBestMove.id, type: "best-move.completed" },
        ],
      },
    });
  });

  it("repairs partial canonical metadata from stored events and constrains replay rows", async () => {
    const gameId = randomUUID();
    const completed = await createCompletedSession(gameId);
    const initialGame = { replayVersion: 1 as const, game: completed.state.game };
    const started = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-08-18T07:59:00.000Z",
      before: initialGame.game,
      draft: { type: "game.checkpointed", payload: {} },
    });
    await pool.query(
      "ALTER TABLE game_events DROP CONSTRAINT IF EXISTS game_events_replay_metadata_ck",
    );
    try {
      await pool.query(
        `INSERT INTO game_sessions
           (id, name, revision, last_mutation_id, state, status, initial_game,
            replay_base_event_id, head_event_id)
         VALUES ($1, 'Partial upgrade', 1, $2, $3::jsonb, 'active', NULL, NULL, NULL)`,
        [
          gameId,
          randomUUID(),
          JSON.stringify({
            ...emptyState,
            hostPlayerId: completed.hostPlayerId,
            hostName: "Partial Upgrade Host",
            initialGame,
            events: [started.entry],
            headEventId: started.entry.id,
          }),
        ],
      );
      await pool.query(
        `INSERT INTO game_events
           (id, game_id, sequence, idempotency_key, event_type, phase, payload,
            replay_sequence, created_at)
         VALUES ($1::uuid, $2, 1, $1::text, $3, $4, $5::jsonb, 1, $6)`,
        [
          started.entry.id,
          gameId,
          started.entry.type,
          started.entry.phaseBefore,
          JSON.stringify(started.entry.payload),
          started.entry.createdAt,
        ],
      );

      await store.initialize();
      await store.initialize();

      const event = await pool.query<{
        replay_sequence: number;
        phase_after: string | null;
        day_before: number | null;
        day_after: number | null;
        state_hash_after: string | null;
      }>(
        `SELECT replay_sequence, phase_after, day_before, day_after, state_hash_after
           FROM game_events
          WHERE id = $1`,
        [started.entry.id],
      );
      expect(event.rows).toEqual([
        {
          replay_sequence: 1,
          phase_after: started.entry.phaseAfter,
          day_before: started.entry.dayBefore,
          day_after: started.entry.dayAfter,
          state_hash_after: started.entry.stateHashAfter,
        },
      ]);
      const session = await pool.query<{
        initial_game: unknown;
        replay_base_event_id: string | null;
        head_event_id: string | null;
      }>(
        "SELECT initial_game, replay_base_event_id, head_event_id FROM game_sessions WHERE id = $1",
        [gameId],
      );
      expect(session.rows[0]).toMatchObject({
        initial_game: initialGame,
        replay_base_event_id: started.entry.id,
        head_event_id: started.entry.id,
      });
      await expect(
        pool.query("UPDATE game_events SET phase_after = NULL WHERE id = $1", [started.entry.id]),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await pool.query("DELETE FROM game_events WHERE game_id = $1", [gameId]);
      await pool.query("DELETE FROM game_sessions WHERE id = $1", [gameId]);
      await store.initialize();
    }
  });

  it("normalizes partial replay state into canonical rows and metadata-only session JSON", async () => {
    const gameId = randomUUID();
    const completed = await createCompletedSession(gameId);
    const initialGame = { replayVersion: 1 as const, game: completed.state.game };
    await store.save({
      gameId,
      name: "Partial replay table",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: {
        ...completed.state,
      },
      results: null,
    });
    const normalized = await store.normalize({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 1,
    });

    expect(normalized).toMatchObject({ revision: 2, duplicate: false });
    const stored = await pool.query<{
      state: Record<string, unknown>;
      initial_game: unknown;
      replay_base_event_id: string | null;
      head_event_id: string | null;
    }>(
      `SELECT state, initial_game, replay_base_event_id, head_event_id
         FROM game_sessions
        WHERE id = $1`,
      [gameId],
    );
    expect(stored.rows[0]?.state).not.toHaveProperty("game");
    expect(stored.rows[0]?.state).not.toHaveProperty("log");
    expect(stored.rows[0]?.state).not.toHaveProperty("events");
    expect(stored.rows[0]?.state).not.toHaveProperty("initialGame");
    expect(stored.rows[0]).toMatchObject({
      initial_game: initialGame,
      replay_base_event_id: expect.any(String),
      head_event_id: expect.any(String),
    });
    const rows = await pool.query<{
      id: string;
      replay_sequence: number;
      phase_after: string;
      day_before: number;
      day_after: number;
    }>(
      `SELECT id, replay_sequence, phase_after, day_before, day_after
         FROM game_events
        WHERE game_id = $1 AND replay_sequence IS NOT NULL`,
      [gameId],
    );
    expect(rows.rows).toEqual([
      {
        id: stored.rows[0]?.head_event_id,
        replay_sequence: 1,
        phase_after: initialGame.game.phase,
        day_before: initialGame.game.day,
        day_after: initialGame.game.day,
      },
    ]);
    await expect(store.get(gameId)).resolves.toMatchObject({
      revision: 2,
      state: {
        game: initialGame.game,
        initialGame,
        events: [expect.objectContaining({ id: stored.rows[0]?.head_event_id })],
        headEventId: stored.rows[0]?.head_event_id,
      },
    });
  });

  it("normalizes supplied JSON replay events without an unused canonical read", async () => {
    const club = await new ClubStore(pool).create(legacyOwnerId, {
      name: `Normalization query count ${randomUUID().slice(0, 8)}`,
      city: "Granada",
      headerLogo: null,
      cardLogo: null,
      language: "en",
      ownerConsent: true,
    });
    const gameId = randomUUID();
    const completed = await createCompletedSession(gameId, club.id);
    const initialGame = { replayVersion: 1 as const, game: completed.state.game };
    const started = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-08-18T07:59:00.000Z",
      before: initialGame.game,
      draft: { type: "game.checkpointed", payload: {} },
    });
    await pool.query(
      `INSERT INTO game_sessions
         (id, club_id, name, revision, last_mutation_id, state, status)
       VALUES ($1, $2, 'Supplied replay events', 1, $3, $4::jsonb, 'active')`,
      [
        gameId,
        club.id,
        randomUUID(),
        JSON.stringify({
          ...emptyState,
          hostPlayerId: completed.hostPlayerId,
          hostName: "Supplied Event Host",
          initialGame,
          events: [started.entry],
          headEventId: started.entry.id,
        }),
      ],
    );

    const recordingPool = new Pool({ connectionString: databaseUrl });
    let calls = (): readonly unknown[][] => [];
    let restoreQuery: () => void = () => undefined;
    recordingPool.on("connect", (client) => {
      const query = vi.spyOn(client, "query");
      calls = () => query.mock.calls;
      restoreQuery = () => query.mockRestore();
    });
    const recordingStore = new GameSessionStore(recordingPool);
    try {
      const normalized = await recordingStore.normalize({
        clubId: club.id,
        gameId,
        mutationId: randomUUID(),
        baseRevision: 1,
      });
      const canonicalReads = calls().filter(
        ([statement]) =>
          typeof statement === "string" &&
          statement.includes("FROM game_events") &&
          statement.includes("replay_sequence IS NOT NULL"),
      );

      expect(canonicalReads).toHaveLength(1);
      expect(normalized).toMatchObject({
        revision: 2,
        state: {
          game: initialGame.game,
          initialGame,
          events: [expect.objectContaining({ id: started.entry.id })],
          headEventId: started.entry.id,
        },
      });
      await expect(
        pool.query<{ id: string }>(
          `SELECT id
             FROM game_events
            WHERE club_id = $1 AND game_id = $2 AND replay_sequence IS NOT NULL`,
          [club.id, gameId],
        ),
      ).resolves.toMatchObject({ rows: [{ id: started.entry.id }] });
      await expect(
        pool.query<{ state: Record<string, unknown> }>(
          "SELECT state FROM game_sessions WHERE club_id = $1 AND id = $2",
          [club.id, gameId],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            state: expect.not.objectContaining({
              events: expect.anything(),
              initialGame: expect.anything(),
            }),
          },
        ],
      });
    } finally {
      restoreQuery();
      await recordingPool.end();
    }
  });

  it("keeps setup-only normalization explicit, repeatable, and startable", async () => {
    const gameId = randomUUID();
    const completed = await createCompletedSession(gameId);
    await store.save({
      gameId,
      name: "Normalized setup table",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: {
        ...emptyState,
        hostPlayerId: completed.hostPlayerId,
        hostName: "Setup Host",
      },
      results: null,
    });
    const firstMutationId = randomUUID();

    const first = await store.normalize({ gameId, mutationId: firstMutationId, baseRevision: 1 });
    const retry = await store.normalize({ gameId, mutationId: firstMutationId, baseRevision: 1 });
    const second = await store.normalize({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 2,
    });

    expect(first).toMatchObject({ revision: 2, duplicate: false, state: { game: null } });
    expect(retry).toMatchObject({ revision: 2, duplicate: true, state: { game: null } });
    expect(second).toMatchObject({ revision: 3, duplicate: false, state: { game: null } });
    const stored = await pool.query<{
      state: Record<string, unknown>;
      initial_game: unknown;
      replay_base_event_id: string | null;
      head_event_id: string | null;
    }>(
      `SELECT state, initial_game, replay_base_event_id, head_event_id
         FROM game_sessions
        WHERE id = $1`,
      [gameId],
    );
    expect(stored.rows).toEqual([
      {
        state: {
          setup: null,
          game: null,
          hostPlayerId: completed.hostPlayerId,
          hostName: "Setup Host",
          playlistId: "",
        },
        initial_game: null,
        replay_base_event_id: null,
        head_event_id: null,
      },
    ]);
    const initialGame = { replayVersion: 1 as const, game: completed.state.game };
    const started = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-08-28T17:30:00.000Z",
      before: initialGame.game,
      draft: { type: "game.checkpointed", payload: {} },
    });

    await expect(
      store.start({
        gameId,
        mutationId: randomUUID(),
        baseRevision: 3,
        initialGame,
        event: started.entry,
      }),
    ).resolves.toMatchObject({ revision: 4, state: { headEventId: started.entry.id } });
  });

  it("repairs an initial baseline without a lifecycle root exactly once", async () => {
    const gameId = randomUUID();
    const completed = await createCompletedSession(gameId);
    const { bestMove, ...completedGame } = completed.state.game;
    if (bestMove === undefined) throw new Error("Completed fixture is missing its best move");
    const initialGame = {
      replayVersion: 1 as const,
      game: {
        ...completedGame,
        phase: "day" as const,
        day: 1,
        winner: null,
        turnOrder: Array.from({ length: 10 }, (_, index) => index + 1),
        currentTurnIndex: 0,
      },
    };
    await store.save({
      gameId,
      name: "Partial baseline table",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: {
        ...emptyState,
        hostPlayerId: completed.hostPlayerId,
        hostName: "Partial Baseline Host",
      },
      results: null,
    });
    await pool.query("UPDATE game_sessions SET initial_game = $2::jsonb WHERE id = $1", [
      gameId,
      JSON.stringify(initialGame),
    ]);
    const historical = await pool.query<{ id: string }>(
      "SELECT id FROM game_events WHERE game_id = $1 AND replay_sequence IS NULL",
      [gameId],
    );
    const historicalEventId = historical.rows[0]?.id;
    if (historicalEventId === undefined) throw new Error("Setup event was not persisted");

    const first = await store.normalize({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 1,
    });
    const second = await store.normalize({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 2,
    });
    const rootId = first.state.headEventId;
    if (rootId == null) throw new Error("Normalization did not create a lifecycle root");

    expect(first).toMatchObject({
      revision: 2,
      state: {
        game: initialGame.game,
        initialGame,
        events: [
          expect.objectContaining({
            gameId,
            sequence: 1,
            parentEventId: null,
            type: "game.checkpointed",
          }),
        ],
      },
    });
    expect(second).toMatchObject({
      revision: 3,
      state: {
        events: [expect.objectContaining({ id: rootId })],
        headEventId: rootId,
      },
    });
    const rows = await pool.query<{ id: string; sequence: number; replay_sequence: number | null }>(
      `SELECT id, sequence, replay_sequence
         FROM game_events
        WHERE game_id = $1
        ORDER BY sequence`,
      [gameId],
    );
    expect(rows.rows).toEqual([
      { id: historicalEventId, sequence: 1, replay_sequence: null },
      { id: rootId, sequence: 2, replay_sequence: 1 },
    ]);
    const checkpoint = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 2,
      parentEventId: rootId,
      createdAt: "2026-08-28T17:31:00.000Z",
      before: first.state.game!,
      draft: {
        type: "foul.issued",
        payload: { seat: 1, foulNumber: 1, redCarded: false },
      },
    });

    await expect(
      store.appendEvent({
        gameId,
        mutationId: randomUUID(),
        baseRevision: 3,
        event: checkpoint.entry,
      }),
    ).resolves.toMatchObject({ revision: 4, state: { headEventId: checkpoint.entry.id } });
  });

  it("rejects corrupt partial replay roots without changing aggregate or mutation state", async () => {
    const gameId = randomUUID();
    const completed = await createCompletedSession(gameId);
    const initialGame = { replayVersion: 1 as const, game: completed.state.game };
    await store.save({
      gameId,
      name: "Corrupt partial roots",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: {
        ...emptyState,
        hostPlayerId: completed.hostPlayerId,
        hostName: "Corrupt Roots Host",
      },
      results: null,
    });
    const roots = [0, 1].map((index) =>
      createGameLogEntry({
        gameId,
        id: randomUUID(),
        sequence: index + 1,
        parentEventId: null,
        createdAt: `2026-08-28T17:3${index + 2}:00.000Z`,
        before: initialGame.game,
        draft: { type: "game.checkpointed", payload: {} },
      }),
    );
    await pool.query(
      `UPDATE game_sessions
          SET state = $2::jsonb, initial_game = $3::jsonb
        WHERE id = $1`,
      [
        gameId,
        JSON.stringify({
          setup: null,
          hostPlayerId: completed.hostPlayerId,
          hostName: "Corrupt Roots Host",
          playlistId: "",
          events: roots.map(({ entry }) => entry),
        }),
        JSON.stringify(initialGame),
      ],
    );
    const before = await pool.query<{
      revision: number;
      last_mutation_id: string;
      state: unknown;
      initial_game: unknown;
      replay_base_event_id: string | null;
      head_event_id: string | null;
    }>(
      `SELECT revision, last_mutation_id, state, initial_game,
              replay_base_event_id, head_event_id
         FROM game_sessions
        WHERE id = $1`,
      [gameId],
    );
    const mutationId = randomUUID();

    await expect(store.normalize({ gameId, mutationId, baseRevision: 1 })).rejects.toMatchObject({
      name: "GameSessionOperationError",
      code: "game_session_replay_invalid",
    });

    const after = await pool.query(
      `SELECT revision, last_mutation_id, state, initial_game,
              replay_base_event_id, head_event_id
         FROM game_sessions
        WHERE id = $1`,
      [gameId],
    );
    expect(after.rows).toEqual(before.rows);
    await expect(
      pool.query(
        `SELECT mutation_id
           FROM game_session_mutations
          WHERE game_id = $1 AND mutation_id = $2`,
        [gameId, mutationId],
      ),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      pool.query("SELECT id FROM game_events WHERE game_id = $1 AND replay_sequence IS NOT NULL", [
        gameId,
      ]),
    ).resolves.toMatchObject({ rows: [] });
  });

  it("rejects malformed canonical event rows at the persistence boundary", async () => {
    const gameId = randomUUID();
    const history = await createStartedDaySessionWithCheckpoints(gameId);
    await pool.query("UPDATE game_events SET payload = 'null'::jsonb WHERE id = $1", [
      history.first.entry.id,
    ]);
    try {
      const mutationId = randomUUID();
      const before = await pool.query(
        `SELECT revision, last_mutation_id, state, initial_game, head_event_id
           FROM game_sessions
          WHERE id = $1`,
        [gameId],
      );
      const beforeEvents = await pool.query(
        `SELECT id, payload, replay_sequence
           FROM game_events
          WHERE game_id = $1
          ORDER BY sequence`,
        [gameId],
      );
      const beforePlayers = await pool.query(
        `SELECT player_id, seat, is_host
           FROM game_session_players
          WHERE game_id = $1
          ORDER BY is_host DESC, seat`,
        [gameId],
      );

      await expect(store.normalize({ gameId, mutationId, baseRevision: 4 })).rejects.toMatchObject({
        name: "GameSessionOperationError",
        code: "game_session_replay_invalid",
      });

      const after = await pool.query(
        `SELECT revision, last_mutation_id, state, initial_game, head_event_id
           FROM game_sessions
          WHERE id = $1`,
        [gameId],
      );
      expect(after.rows).toEqual(before.rows);
      await expect(
        pool.query(
          `SELECT id, payload, replay_sequence
             FROM game_events
            WHERE game_id = $1
            ORDER BY sequence`,
          [gameId],
        ),
      ).resolves.toMatchObject({ rows: beforeEvents.rows });
      await expect(
        pool.query(
          `SELECT player_id, seat, is_host
             FROM game_session_players
            WHERE game_id = $1
            ORDER BY is_host DESC, seat`,
          [gameId],
        ),
      ).resolves.toMatchObject({ rows: beforePlayers.rows });
      await expect(
        pool.query(
          "SELECT mutation_id FROM game_session_mutations WHERE game_id = $1 AND mutation_id = $2",
          [gameId, mutationId],
        ),
      ).resolves.toMatchObject({ rows: [] });
    } finally {
      await pool.query("UPDATE game_events SET payload = $2::jsonb WHERE id = $1", [
        history.first.entry.id,
        JSON.stringify(history.first.entry.payload),
      ]);
    }
  });

  it("rejects malformed legacy JSON replay entries on read", async () => {
    const gameId = randomUUID();
    const completed = await createCompletedSession(gameId);
    await store.save({
      gameId,
      name: "Malformed JSON replay",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: emptyState,
      results: null,
    });
    await pool.query("UPDATE game_sessions SET state = $2::jsonb WHERE id = $1", [
      gameId,
      JSON.stringify({
        ...emptyState,
        initialGame: { replayVersion: 1, game: completed.state.game },
        events: [null],
        headEventId: randomUUID(),
      }),
    ]);
    try {
      await expect(store.get(gameId)).rejects.toMatchObject({
        name: "GameSessionOperationError",
        code: "game_session_replay_invalid",
      });
    } finally {
      await pool.query("DELETE FROM game_sessions WHERE id = $1", [gameId]);
    }
  });

  it("rejects non-finite canonical event timestamps at the persistence boundary", async () => {
    const gameId = randomUUID();
    const history = await createStartedDaySessionWithCheckpoints(gameId);
    await pool.query("UPDATE game_events SET created_at = 'infinity' WHERE id = $1", [
      history.first.entry.id,
    ]);
    try {
      await expect(store.get(gameId)).rejects.toMatchObject({
        name: "GameSessionOperationError",
        code: "game_session_replay_invalid",
      });
    } finally {
      await pool.query("UPDATE game_events SET created_at = $2 WHERE id = $1", [
        history.first.entry.id,
        history.first.entry.createdAt,
      ]);
    }
  });

  it("rejects malformed persisted player selections at the persistence boundary", async () => {
    const gameId = randomUUID();
    await store.save({
      gameId,
      name: "Malformed player selection",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: emptyState,
      results: null,
    });
    await pool.query("UPDATE game_sessions SET state = $2::jsonb WHERE id = $1", [
      gameId,
      JSON.stringify({
        ...emptyState,
        setup: {
          step: "players",
          hostPlayerId: "",
          selectedPlayerIds: [42],
          setup: null,
        },
      }),
    ]);
    try {
      await expect(store.get(gameId)).rejects.toMatchObject({
        name: "GameSessionOperationError",
        code: "game_session_replay_invalid",
      });
    } finally {
      await pool.query("DELETE FROM game_sessions WHERE id = $1", [gameId]);
    }
  });

  it("rejects contradictory JSON and canonical replay sources without writing", async () => {
    const gameId = randomUUID();
    const history = await createStartedDaySessionWithCheckpoints(gameId);
    const alternateRoot = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-08-18T08:05:00.000Z",
      before: history.initialGame.game,
      draft: { type: "game.checkpointed", payload: {} },
    });
    await pool.query(
      `UPDATE game_sessions
          SET state = $2::jsonb, head_event_id = $3
        WHERE id = $1`,
      [
        gameId,
        JSON.stringify({
          ...emptyState,
          hostPlayerId: history.completed.hostPlayerId,
          hostName: "Contradictory Replay Host",
          initialGame: history.initialGame,
          events: [alternateRoot.entry],
          headEventId: alternateRoot.entry.id,
        }),
        alternateRoot.entry.id,
      ],
    );
    try {
      const beforeSession = await pool.query(
        `SELECT revision, last_mutation_id, state, initial_game,
                replay_base_event_id, head_event_id
           FROM game_sessions
          WHERE id = $1`,
        [gameId],
      );
      const beforeEvents = await pool.query(
        "SELECT id, replay_sequence FROM game_events WHERE game_id = $1 ORDER BY sequence",
        [gameId],
      );
      const mutationId = randomUUID();

      await expect(store.normalize({ gameId, mutationId, baseRevision: 4 })).rejects.toMatchObject({
        name: "GameSessionOperationError",
        code: "game_session_replay_invalid",
      });

      await expect(
        pool.query(
          `SELECT revision, last_mutation_id, state, initial_game,
                  replay_base_event_id, head_event_id
             FROM game_sessions
            WHERE id = $1`,
          [gameId],
        ),
      ).resolves.toMatchObject({ rows: beforeSession.rows });
      await expect(
        pool.query(
          "SELECT id, replay_sequence FROM game_events WHERE game_id = $1 ORDER BY sequence",
          [gameId],
        ),
      ).resolves.toMatchObject({ rows: beforeEvents.rows });
      await expect(
        pool.query(
          "SELECT mutation_id FROM game_session_mutations WHERE game_id = $1 AND mutation_id = $2",
          [gameId, mutationId],
        ),
      ).resolves.toMatchObject({ rows: [] });
    } finally {
      await pool.query("DELETE FROM game_sessions WHERE id = $1", [gameId]);
    }
  });

  it("normalizes a legacy current snapshot as one honest compatibility checkpoint", async () => {
    const gameId = randomUUID();
    const completed = await createCompletedSession(gameId);
    const legacyLog = [
      {
        id: randomUUID(),
        sequence: 1,
        type: "legacy.action",
        phase: "finished",
        payload: { historical: true },
        createdAt: "2026-08-18T07:58:00.000Z",
      },
    ] as const;
    await store.save({
      gameId,
      name: "Legacy checkpoint table",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: { ...completed.state, log: legacyLog },
      results: null,
    });
    const mutationId = randomUUID();
    const normalized = await store.normalize({
      gameId,
      mutationId,
      baseRevision: 1,
    });
    const retry = await store.normalize({ gameId, mutationId, baseRevision: 1 });
    const renormalized = await store.normalize({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 2,
    });

    expect(normalized.revision).toBe(2);
    expect(normalized.replayBaseEventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(normalized.previewableFromEventId).toBe(normalized.replayBaseEventId);
    expect(retry).toMatchObject({
      revision: 2,
      duplicate: true,
      replayBaseEventId: normalized.replayBaseEventId,
      state: { legacyLog },
    });
    expect(renormalized).toMatchObject({
      revision: 3,
      duplicate: false,
      replayBaseEventId: normalized.replayBaseEventId,
      state: {
        legacyLog,
        events: [expect.objectContaining({ id: normalized.replayBaseEventId })],
      },
    });
    const stored = await pool.query<{
      state: Record<string, unknown>;
      initial_game: { replayVersion: number; game: unknown };
    }>("SELECT state, initial_game FROM game_sessions WHERE id = $1", [gameId]);
    expect(stored.rows[0]?.state).not.toHaveProperty("game");
    expect(stored.rows[0]?.state).not.toHaveProperty("log");
    expect(stored.rows[0]?.state).toMatchObject({ legacyLog });
    expect(stored.rows[0]?.initial_game).toEqual({ replayVersion: 1, game: completed.state.game });
    const events = await pool.query<{
      id: string;
      event_type: string;
      parent_event_id: string | null;
      replay_sequence: number | null;
    }>(
      `SELECT id, event_type, parent_event_id, replay_sequence
         FROM game_events
        WHERE game_id = $1
        ORDER BY sequence`,
      [gameId],
    );
    expect(events.rows.filter(({ replay_sequence }) => replay_sequence !== null)).toEqual([
      {
        id: normalized.replayBaseEventId,
        event_type: "game.checkpointed",
        parent_event_id: null,
        replay_sequence: 1,
      },
    ]);
    expect(
      events.rows
        .filter(({ id }) => id !== normalized.replayBaseEventId)
        .every(({ replay_sequence }) => replay_sequence === null),
    ).toBe(true);
    await expect(store.get(gameId)).resolves.toMatchObject({
      state: {
        game: completed.state.game,
        legacyLog,
        events: [expect.objectContaining({ id: normalized.replayBaseEventId })],
      },
    });
  });

  it("starts an existing setup session with one immutable baseline and one root", async () => {
    const gameId = randomUUID();
    const completed = await createCompletedSession(gameId);
    await store.save({
      gameId,
      name: "Operation start table",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: {
        ...emptyState,
        hostPlayerId: completed.hostPlayerId,
        hostName: "Operation Host",
      },
      results: null,
    });
    const initialGame = { replayVersion: 1 as const, game: completed.state.game };
    const started = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-08-18T07:59:00.000Z",
      before: initialGame.game,
      draft: { type: "game.checkpointed", payload: {} },
    });
    const response = await store.start({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 1,
      initialGame,
      event: started.entry,
    });

    expect(response).toMatchObject({ revision: 2, state: { game: initialGame.game } });
    const session = await pool.query<{
      state: Record<string, unknown>;
      replay_base_event_id: string;
      head_event_id: string;
    }>("SELECT state, replay_base_event_id, head_event_id FROM game_sessions WHERE id = $1", [
      gameId,
    ]);
    expect(session.rows[0]?.state).not.toHaveProperty("game");
    expect(session.rows[0]?.state).not.toHaveProperty("events");
    expect(session.rows[0]).toMatchObject({
      replay_base_event_id: started.entry.id,
      head_event_id: started.entry.id,
    });
    const events = await pool.query<{
      event_type: string;
      parent_event_id: string | null;
      replay_sequence: number | null;
    }>(
      `SELECT event_type, parent_event_id, replay_sequence
         FROM game_events
        WHERE game_id = $1
        ORDER BY sequence`,
      [gameId],
    );
    expect(events.rows).toEqual([
      { event_type: "game.created", parent_event_id: null, replay_sequence: null },
      { event_type: "game.checkpointed", parent_event_id: null, replay_sequence: 1 },
    ]);
  });

  it("rejects a valid intermediate replay event instead of storing it as history", async () => {
    const gameId = randomUUID();
    const completed = await createCompletedSession(gameId);
    const liveGame = {
      ...completed.state.game,
      phase: "day" as const,
      day: 1,
      winner: null,
      bestMove: undefined,
      turnOrder: Array.from({ length: 10 }, (_, index) => index + 1),
      currentTurnIndex: 0,
    };
    await store.save({
      gameId,
      name: "Append operation table",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: {
        ...emptyState,
        hostPlayerId: completed.hostPlayerId,
        hostName: "Append Host",
      },
      results: null,
    });
    const initialGame = { replayVersion: 1 as const, game: liveGame };
    const started = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-08-18T07:59:00.000Z",
      before: liveGame,
      draft: { type: "game.checkpointed", payload: {} },
    });
    await store.start({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 1,
      initialGame,
      event: started.entry,
    });
    const turn = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 2,
      parentEventId: started.entry.id,
      createdAt: "2026-08-18T08:00:00.000Z",
      before: started.after,
      draft: { type: "turn.completed", payload: { seat: 1 } },
    });
    await expect(
      store.appendEvent({
        gameId,
        mutationId: randomUUID(),
        baseRevision: 2,
        event: turn.entry,
      }),
    ).rejects.toThrow(/meaningful semantic checkpoint/i);
    const events = await pool.query<{ replay_sequence: number | null }>(
      "SELECT replay_sequence FROM game_events WHERE game_id = $1 ORDER BY sequence",
      [gameId],
    );
    expect(events.rows).toEqual([{ replay_sequence: null }, { replay_sequence: 1 }]);
  });

  it("moves reset head without deleting future rows and records reset recovery", async () => {
    const gameId = randomUUID();
    const history = await createStartedDaySessionWithCheckpoints(gameId);
    const response = await store.moveHead({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 4,
      targetEventId: history.started.entry.id,
      reason: "reset",
    });

    expect(response).toMatchObject({
      revision: 5,
      state: {
        game: { currentTurnIndex: 0 },
        headEventId: history.started.entry.id,
        resetReturnEventId: history.second.entry.id,
      },
    });
    const stored = await pool.query<{
      head_event_id: string;
      reset_return_event_id: string;
      canonical_count: number;
    }>(
      `SELECT head_event_id, reset_return_event_id,
              (SELECT COUNT(*)::int
                 FROM game_events
                WHERE game_id = $1 AND replay_sequence IS NOT NULL) AS canonical_count
         FROM game_sessions
        WHERE id = $1`,
      [gameId],
    );
    expect(stored.rows).toEqual([
      {
        head_event_id: history.started.entry.id,
        reset_return_event_id: history.second.entry.id,
        canonical_count: 3,
      },
    ]);
  });

  it("appends a new branch after reset while retaining inactive future rows", async () => {
    const gameId = randomUUID();
    const history = await createStartedDaySessionWithCheckpoints(gameId);
    await store.moveHead({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 4,
      targetEventId: history.started.entry.id,
      reason: "reset",
    });
    const branch = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 4,
      parentEventId: history.started.entry.id,
      createdAt: "2026-08-18T08:02:00.000Z",
      before: history.started.after,
      draft: {
        type: "foul.issued",
        payload: { seat: 3, foulNumber: 1, redCarded: false },
      },
    });

    const response = await store.appendEvent({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 5,
      event: branch.entry,
    });

    expect(response).toMatchObject({
      revision: 6,
      state: {
        game: expect.objectContaining({
          players: expect.arrayContaining([expect.objectContaining({ seat: 3, fouls: 1 })]),
        }),
        headEventId: branch.entry.id,
        resetReturnEventId: null,
      },
    });
    const events = await pool.query<{
      id: string;
      parent_event_id: string | null;
      replay_sequence: number;
    }>(
      `SELECT id, parent_event_id, replay_sequence
         FROM game_events
        WHERE game_id = $1 AND replay_sequence IS NOT NULL
        ORDER BY replay_sequence`,
      [gameId],
    );
    expect(events.rows).toEqual([
      { id: history.started.entry.id, parent_event_id: null, replay_sequence: 1 },
      {
        id: history.first.entry.id,
        parent_event_id: history.started.entry.id,
        replay_sequence: 2,
      },
      {
        id: history.second.entry.id,
        parent_event_id: history.first.entry.id,
        replay_sequence: 3,
      },
      { id: branch.entry.id, parent_event_id: history.started.entry.id, replay_sequence: 4 },
    ]);
    expect(response.state.log.map(({ id }) => id)).toEqual([
      history.started.entry.id,
      branch.entry.id,
    ]);
  });

  it("never rewrites an inactive canonical event when its ID is reused", async () => {
    const gameId = randomUUID();
    const history = await createStartedDaySessionWithCheckpoints(gameId);
    await store.moveHead({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 4,
      targetEventId: history.started.entry.id,
      reason: "reset",
    });
    const reused = createGameLogEntry({
      gameId,
      id: history.first.entry.id,
      sequence: 4,
      parentEventId: history.started.entry.id,
      createdAt: "2026-08-18T09:00:00.000Z",
      before: history.started.after,
      draft: {
        type: "foul.issued",
        payload: { seat: 1, foulNumber: 1, redCarded: false },
      },
    });

    await expect(
      store.appendEvent({
        gameId,
        mutationId: randomUUID(),
        baseRevision: 5,
        event: reused.entry,
      }),
    ).rejects.toMatchObject({
      name: "GameSessionOperationError",
      code: "game_session_event_conflict",
    });
    const row = await pool.query<{
      replay_sequence: number;
      parent_event_id: string | null;
      created_at: Date;
    }>("SELECT replay_sequence, parent_event_id, created_at FROM game_events WHERE id = $1", [
      history.first.entry.id,
    ]);
    expect(row.rows).toEqual([
      {
        replay_sequence: 2,
        parent_event_id: history.started.entry.id,
        created_at: new Date(history.first.entry.createdAt),
      },
    ]);
    await expect(store.get(gameId)).resolves.toMatchObject({ revision: 5 });
  });

  it("serializes concurrent appends to one head so exactly one wins", async () => {
    const gameId = randomUUID();
    const history = await createStartedDaySessionWithCheckpoints(gameId);
    await store.moveHead({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 4,
      targetEventId: history.started.entry.id,
      reason: "reset",
    });
    const entries = [0, 1].map(
      (index) =>
        createGameLogEntry({
          gameId,
          id: randomUUID(),
          sequence: 4,
          parentEventId: history.started.entry.id,
          createdAt: `2026-08-18T08:0${index + 2}:00.000Z`,
          before: history.started.after,
          draft: {
            type: "foul.issued",
            payload: { seat: 3, foulNumber: 1, redCarded: false },
          },
        }).entry,
    );

    const settled = await Promise.allSettled(
      entries.map((event) =>
        store.appendEvent({
          gameId,
          mutationId: randomUUID(),
          baseRevision: 5,
          event,
        }),
      ),
    );

    expect(settled.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { name: "GameSessionConflictError", currentRevision: 6 },
    });
    const rows = await pool.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM game_events WHERE game_id = $1 AND replay_sequence = 4",
      [gameId],
    );
    expect(rows.rows).toEqual([{ count: 1 }]);
  });

  it("completes from the replayed finished head without storing another snapshot or event", async () => {
    const gameId = randomUUID();
    const completed = await createCompletedSession(gameId);
    await store.save({
      gameId,
      name: "Complete operation table",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: {
        ...emptyState,
        hostPlayerId: completed.hostPlayerId,
        hostName: "Complete Host",
      },
      results: null,
    });
    const initialGame = { replayVersion: 1 as const, game: completed.state.game };
    const started = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-08-18T07:59:00.000Z",
      before: initialGame.game,
      draft: { type: "game.checkpointed", payload: {} },
    });
    await store.start({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 1,
      initialGame,
      event: started.entry,
    });
    const completedEvent = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 2,
      parentEventId: started.entry.id,
      createdAt: "2026-08-18T08:00:00.000Z",
      before: started.after,
      draft: { type: "game.completed", payload: { winner: "red" } },
    });
    await store.appendEvent({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 2,
      event: completedEvent.entry,
    });
    const completionResults = {
      ...completed.results,
      playedAt: completedEvent.entry.createdAt,
    };
    const mutationId = randomUUID();

    const response = await store.complete({
      gameId,
      mutationId,
      baseRevision: 3,
      results: completionResults,
    });
    const retry = await store.complete({
      gameId,
      mutationId,
      baseRevision: 3,
      results: completionResults,
    });

    expect(response).toMatchObject({
      revision: 4,
      status: "completed",
      results: completionResults,
    });
    expect(retry).toMatchObject({ revision: 4, duplicate: true });
    await expect(
      store.complete({
        gameId,
        mutationId: randomUUID(),
        baseRevision: 4,
        results: completionResults,
      }),
    ).rejects.toMatchObject({ code: "game_session_completion_invalid" });
    const stored = await pool.query<{
      status: string;
      state: Record<string, unknown>;
      event_count: number;
      result_count: number;
    }>(
      `SELECT status, state,
              (SELECT COUNT(*)::int FROM game_events WHERE game_id = $1) AS event_count,
              (SELECT COUNT(*)::int FROM game_player_results WHERE game_id = $1) AS result_count
         FROM game_sessions
        WHERE id = $1`,
      [gameId],
    );
    expect(stored.rows[0]).toMatchObject({
      status: "completed",
      event_count: 3,
      result_count: 10,
    });
    expect(stored.rows[0]?.state).not.toHaveProperty("game");
    expect(stored.rows[0]?.state).not.toHaveProperty("events");
  });

  it("retracts completion projections when the head moves before completion", async () => {
    const gameId = randomUUID();
    const completed = await createCompletedSession(gameId);
    await store.save({
      gameId,
      name: "Completion reset table",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: {
        ...emptyState,
        hostPlayerId: completed.hostPlayerId,
        hostName: "Completion Reset Host",
      },
      results: null,
    });
    const initialGame = { replayVersion: 1 as const, game: completed.state.game };
    const started = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-08-18T07:59:00.000Z",
      before: initialGame.game,
      draft: { type: "game.checkpointed", payload: {} },
    });
    await store.start({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 1,
      initialGame,
      event: started.entry,
    });
    const completionEvent = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 2,
      parentEventId: started.entry.id,
      createdAt: "2026-08-18T08:00:00.000Z",
      before: started.after,
      draft: { type: "game.completed", payload: { winner: "red" } },
    });
    await store.appendEvent({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 2,
      event: completionEvent.entry,
    });
    await store.complete({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 3,
      results: completed.results,
    });

    const reset = await store.moveHead({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 4,
      targetEventId: started.entry.id,
      reason: "reset",
    });

    expect(reset).toMatchObject({ revision: 5, status: "active", results: null });
    const projections = await pool.query<{
      result_count: number;
      player_count: number;
      assigned_role_count: number;
    }>(
      `SELECT
         (SELECT COUNT(*)::int FROM game_results WHERE game_id = $1) AS result_count,
         (SELECT COUNT(*)::int FROM game_session_players WHERE game_id = $1) AS player_count,
         (SELECT COUNT(*)::int FROM game_session_players
           WHERE game_id = $1 AND role IS NOT NULL) AS assigned_role_count`,
      [gameId],
    );
    expect(projections.rows).toEqual([
      { result_count: 0, player_count: 11, assigned_role_count: 10 },
    ]);

    const restored = await store.moveHead({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 5,
      targetEventId: completionEvent.entry.id,
      reason: "restore-reset",
    });
    expect(restored).toMatchObject({
      revision: 6,
      status: "completed",
      results: { winner: "red", playedAt: completionEvent.entry.createdAt },
    });
    expect(
      await pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM game_results WHERE game_id = $1) AS result_count,
           (SELECT COUNT(*)::int FROM game_player_results WHERE game_id = $1) AS player_result_count,
           (SELECT COUNT(*)::int FROM game_session_players WHERE game_id = $1) AS player_count`,
        [gameId],
      ),
    ).toMatchObject({ rows: [{ result_count: 1, player_result_count: 10, player_count: 0 }] });
  });

  it("does not complete an unconfirmed finished head through reset recovery", async () => {
    const gameId = randomUUID();
    const completed = await createCompletedSession(gameId);
    await store.save({
      gameId,
      name: "Unconfirmed completion reset",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: {
        ...emptyState,
        hostPlayerId: completed.hostPlayerId,
        hostName: "Unconfirmed Completion Host",
      },
      results: null,
    });
    const initialGame = { replayVersion: 1 as const, game: completed.state.game };
    const root = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-08-18T07:59:00.000Z",
      before: initialGame.game,
      draft: { type: "game.checkpointed", payload: {} },
    });
    await store.start({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 1,
      initialGame,
      event: root.entry,
    });
    const completion = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 2,
      parentEventId: root.entry.id,
      createdAt: "2026-08-18T08:00:00.000Z",
      before: root.after,
      draft: { type: "game.completed", payload: { winner: "red" } },
    });
    await store.appendEvent({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 2,
      event: completion.entry,
    });
    await store.moveHead({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 3,
      targetEventId: root.entry.id,
      reason: "reset",
    });

    const restored = await store.moveHead({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 4,
      targetEventId: completion.entry.id,
      reason: "restore-reset",
    });

    expect(restored).toMatchObject({ revision: 5, status: "active", results: null });
    expect(restored.state.game).toEqual(completion.after);
  });

  it("stores one replay baseline and appends events without persisting per-step game snapshots", async () => {
    const gameId = randomUUID();
    const completed = await createCompletedSession(gameId);
    const baseline = { replayVersion: 1 as const, game: completed.state.game };
    const started = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-08-18T07:59:00.000Z",
      before: completed.state.game,
      draft: { type: "game.checkpointed", payload: {} },
    });
    await store.save({
      gameId,
      name: "Incremental table",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: {
        ...completed.state,
        game: null,
        log: [],
      },
      results: null,
    });
    await store.start({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 1,
      initialGame: baseline,
      event: started.entry,
    });
    const completedEvent = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 2,
      parentEventId: started.entry.id,
      createdAt: "2026-08-18T08:00:00.000Z",
      before: started.after,
      draft: { type: "game.completed", payload: { winner: "red" } },
    });
    await store.appendEvent({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 2,
      event: completedEvent.entry,
    });
    await store.complete({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 3,
      results: { ...completed.results, playedAt: completedEvent.entry.createdAt },
    });

    const stored = await pool.query<{
      has_game: boolean;
      has_log: boolean;
      has_events: boolean;
      event_count: number;
      replay_count: number;
      head_event_id: string | null;
    }>(
      `SELECT state ? 'game' AS has_game,
              state ? 'log' AS has_log,
              state ? 'events' AS has_events,
              (SELECT COUNT(*)::int FROM game_events WHERE game_id = $1) AS event_count,
              (SELECT COUNT(*)::int
                 FROM game_events
                WHERE game_id = $1 AND replay_sequence IS NOT NULL) AS replay_count,
              head_event_id
         FROM game_sessions WHERE id = $1`,
      [gameId],
    );
    expect(stored.rows[0]).toEqual({
      has_game: false,
      has_log: false,
      has_events: false,
      event_count: 3,
      replay_count: 2,
      head_event_id: completedEvent.entry.id,
    });
    expect(await store.get(gameId)).toMatchObject({
      state: { game: expect.objectContaining({ phase: "finished", winner: "red" }) },
    });
    expect(await store.listCompleted()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gameId,
          winner: "red",
          day: 2,
          eventCount: 3,
        }),
      ]),
    );
  });

  it("isolates active sessions by club", async () => {
    const club = await new ClubStore(pool).create(legacyOwnerId, {
      name: `Isolated ${randomUUID().slice(0, 8)}`,
      city: "Granada",
      headerLogo: null,
      cardLogo: null,
      language: "en",
      ownerConsent: true,
    });
    const gameId = randomUUID();
    await store.save({
      clubId: club.id,
      gameId,
      name: "Isolated table",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: emptyState,
      results: null,
    });

    expect(await store.get(gameId)).toBeNull();
    expect(await store.get(gameId, club.id)).toMatchObject({ gameId });
    expect((await store.listActive()).map(({ gameId: id }) => id)).not.toContain(gameId);
    expect((await store.listActive(club.id)).map(({ gameId: id }) => id)).toContain(gameId);
  });

  it("does not expose another club's deleted session through incremental operations", async () => {
    const club = await new ClubStore(pool).create(legacyOwnerId, {
      name: `Deleted isolation ${randomUUID().slice(0, 8)}`,
      city: "Granada",
      headerLogo: null,
      cardLogo: null,
      language: "en",
      ownerConsent: true,
    });
    const gameId = randomUUID();
    const fixtures = await createValidOperationFixtures(gameId, club.id);
    await store.save({
      clubId: club.id,
      gameId,
      name: "Deleted isolated table",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: emptyState,
      results: null,
    });
    await store.clear(gameId, 1, club.id);

    await expect(
      store.start({
        gameId,
        mutationId: randomUUID(),
        baseRevision: 0,
        initialGame: fixtures.initialGame,
        event: fixtures.root.entry,
      }),
    ).rejects.toMatchObject({
      name: "GameSessionNotFoundError",
      code: "game_session_not_found",
    });
  });

  it("keeps every incremental operation scoped to the selected club", async () => {
    const club = await new ClubStore(pool).create(legacyOwnerId, {
      name: `Operation isolation ${randomUUID().slice(0, 8)}`,
      city: "Granada",
      headerLogo: null,
      cardLogo: null,
      language: "en",
      ownerConsent: true,
    });
    const gameId = randomUUID();
    const fixtures = await createValidOperationFixtures(gameId, club.id);
    await store.save({
      clubId: club.id,
      gameId,
      name: "Operation isolated table",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: emptyState,
      results: null,
    });

    const operations = [
      () => store.normalize({ gameId, mutationId: randomUUID(), baseRevision: 1 }),
      () =>
        store.start({
          gameId,
          mutationId: randomUUID(),
          baseRevision: 1,
          initialGame: fixtures.initialGame,
          event: fixtures.root.entry,
        }),
      () =>
        store.appendEvent({
          gameId,
          mutationId: randomUUID(),
          baseRevision: 1,
          event: fixtures.event.entry,
        }),
      () =>
        store.moveHead({
          gameId,
          mutationId: randomUUID(),
          baseRevision: 1,
          targetEventId: fixtures.root.entry.id,
          reason: "reset",
        }),
      () =>
        store.complete({
          gameId,
          mutationId: randomUUID(),
          baseRevision: 1,
          results: fixtures.results,
        }),
    ];
    for (const operation of operations) {
      await expect(operation()).rejects.toMatchObject({
        name: "GameSessionNotFoundError",
        code: "game_session_not_found",
      });
    }
    await expect(store.get(gameId, club.id)).resolves.toMatchObject({ revision: 1 });
  });

  it("allows the same client event ID in independent clubs without revealing either tenant", async () => {
    const club = await new ClubStore(pool).create(legacyOwnerId, {
      name: `Event ID isolation ${randomUUID().slice(0, 8)}`,
      city: "Granada",
      headerLogo: null,
      cardLogo: null,
      language: "en",
      ownerConsent: true,
    });
    const sharedEventId = randomUUID();
    const foreignGameId = randomUUID();
    const localGameId = randomUUID();
    const foreignCompleted = await createCompletedSession(randomUUID(), club.id);
    const localCompleted = await createCompletedSession(randomUUID());
    const foreignInitialGame = { replayVersion: 1 as const, game: foreignCompleted.state.game };
    const localInitialGame = { replayVersion: 1 as const, game: localCompleted.state.game };
    await store.save({
      clubId: club.id,
      gameId: foreignGameId,
      name: "Foreign event ID table",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: emptyState,
      results: null,
    });
    await store.save({
      gameId: localGameId,
      name: "Local event ID table",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: emptyState,
      results: null,
    });
    const foreignRoot = createGameLogEntry({
      gameId: foreignGameId,
      id: sharedEventId,
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-08-18T07:59:00.000Z",
      before: foreignInitialGame.game,
      draft: { type: "game.checkpointed", payload: {} },
    });
    const localRoot = createGameLogEntry({
      gameId: localGameId,
      id: sharedEventId,
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-08-18T08:00:00.000Z",
      before: localInitialGame.game,
      draft: { type: "game.checkpointed", payload: {} },
    });

    await store.start({
      clubId: club.id,
      gameId: foreignGameId,
      mutationId: randomUUID(),
      baseRevision: 1,
      initialGame: foreignInitialGame,
      event: foreignRoot.entry,
    });
    await store.start({
      gameId: localGameId,
      mutationId: randomUUID(),
      baseRevision: 1,
      initialGame: localInitialGame,
      event: localRoot.entry,
    });

    const rows = await pool.query<{ club_id: string }>(
      "SELECT club_id FROM game_events WHERE id = $1 ORDER BY club_id",
      [sharedEventId],
    );
    expect(rows.rows).toHaveLength(2);
    expect(new Set(rows.rows.map(({ club_id }) => club_id))).toEqual(
      new Set([DEFAULT_CLUB_ID, club.id]),
    );
  });

  it("supports one complete session UUID and mutation IDs independently in each club", async () => {
    const club = await new ClubStore(pool).create(legacyOwnerId, {
      name: `Session collision ${randomUUID().slice(0, 8)}`,
      city: "Granada",
      headerLogo: null,
      cardLogo: null,
      language: "en",
      ownerConsent: true,
    });
    const gameId = randomUUID();
    const mutationId = randomUUID();
    const localHostId = randomUUID();
    const foreignHostId = randomUUID();
    await pool.query(
      `INSERT INTO players (id, club_id, nickname)
       VALUES ($1, $2, $3), ($4, $5, $6)`,
      [
        localHostId,
        DEFAULT_CLUB_ID,
        `Local collision host ${gameId}`,
        foreignHostId,
        club.id,
        `Foreign collision host ${gameId}`,
      ],
    );

    await store.save({
      gameId,
      name: "Local collision table",
      mutationId,
      baseRevision: 0,
      state: { ...emptyState, hostPlayerId: localHostId, hostName: "Local host" },
      results: null,
    });
    await store.save({
      clubId: club.id,
      gameId,
      name: "Foreign collision table",
      mutationId,
      baseRevision: 0,
      state: { ...emptyState, hostPlayerId: foreignHostId, hostName: "Foreign host" },
      results: null,
    });

    const activeGraph = await pool.query<{
      club_id: string;
      mutations: number;
      players: number;
      events: number;
    }>(
      `SELECT session.club_id,
              (SELECT COUNT(*)::int FROM game_session_mutations AS mutation
                WHERE mutation.club_id = session.club_id AND mutation.game_id = session.id) AS mutations,
              (SELECT COUNT(*)::int FROM game_session_players AS player
                WHERE player.club_id = session.club_id AND player.game_id = session.id) AS players,
              (SELECT COUNT(*)::int FROM game_events AS event
                WHERE event.club_id = session.club_id AND event.game_id = session.id) AS events
         FROM game_sessions AS session
        WHERE session.id = $1
        ORDER BY session.club_id`,
      [gameId],
    );
    expect(activeGraph.rows).toHaveLength(2);
    expect(activeGraph.rows).toEqual(
      expect.arrayContaining([
        { club_id: DEFAULT_CLUB_ID, mutations: 1, players: 1, events: 1 },
        { club_id: club.id, mutations: 1, players: 1, events: 1 },
      ]),
    );

    const localCompleted = await createCompletedSession(gameId, DEFAULT_CLUB_ID);
    const foreignCompleted = await createCompletedSession(gameId, club.id);
    const completionMutationId = randomUUID();
    await store.save({
      gameId,
      name: "Local collision table",
      mutationId: completionMutationId,
      baseRevision: 1,
      state: localCompleted.state,
      results: localCompleted.results,
    });
    await store.save({
      clubId: club.id,
      gameId,
      name: "Foreign collision table",
      mutationId: completionMutationId,
      baseRevision: 1,
      state: foreignCompleted.state,
      results: foreignCompleted.results,
    });

    expect(
      await pool.query(
        `SELECT club_id, COUNT(*)::int AS games,
                (SELECT COUNT(*)::int FROM game_player_results AS player_result
                  WHERE player_result.club_id = result.club_id
                    AND player_result.game_id = result.game_id) AS players
           FROM game_results AS result
          WHERE game_id = $1
          GROUP BY club_id, game_id
          ORDER BY club_id`,
        [gameId],
      ),
    ).toMatchObject({
      rows: expect.arrayContaining([
        { club_id: DEFAULT_CLUB_ID, games: 1, players: 10 },
        { club_id: club.id, games: 1, players: 10 },
      ]),
    });

    await store.clear(gameId, 2, DEFAULT_CLUB_ID);
    await expect(store.get(gameId, DEFAULT_CLUB_ID)).resolves.toBeNull();
    await expect(store.get(gameId, club.id)).resolves.toMatchObject({ revision: 2 });
    expect(
      await pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM game_sessions WHERE club_id = $1 AND id = $2) AS sessions,
           (SELECT COUNT(*)::int FROM game_session_mutations WHERE club_id = $1 AND game_id = $2) AS mutations,
           (SELECT COUNT(*)::int FROM game_results WHERE club_id = $1 AND game_id = $2) AS results,
           (SELECT COUNT(*)::int FROM game_player_results WHERE club_id = $1 AND game_id = $2) AS player_results,
           (SELECT COUNT(*)::int FROM game_events WHERE club_id = $1 AND game_id = $2) AS events`,
        [club.id, gameId],
      ),
    ).toMatchObject({
      rows: [{ sessions: 1, mutations: 2, results: 1, player_results: 10, events: 2 }],
    });
    await store.clear(gameId, 2, club.id);
    expect(
      await pool.query<{ club_id: string }>(
        "SELECT club_id FROM deleted_games WHERE game_id = $1 ORDER BY club_id",
        [gameId],
      ),
    ).toMatchObject({ rows: [{ club_id: DEFAULT_CLUB_ID }, { club_id: club.id }] });
  });

  it("keeps legacy PUT event synchronization append-only", async () => {
    const gameId = randomUUID();
    const first = {
      id: randomUUID(),
      sequence: 1,
      type: "turn.completed",
      phase: "day",
      payload: { seat: 1 },
      createdAt: "2026-08-18T08:00:00.000Z",
    } as const;
    const abandoned = {
      id: randomUUID(),
      sequence: 2,
      type: "foul.issued",
      phase: "day",
      payload: { seat: 2 },
      createdAt: "2026-08-18T08:01:00.000Z",
    } as const;
    const replacement = {
      id: randomUUID(),
      sequence: 2,
      type: "foul.issued",
      phase: "day",
      payload: { seat: 3 },
      createdAt: "2026-08-18T08:02:00.000Z",
    } as const;
    await store.save({
      gameId,
      name: "Append-only legacy table",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: { ...emptyState, log: [first, abandoned] },
      results: null,
    });
    await store.save({
      gameId,
      name: "Append-only legacy table",
      mutationId: randomUUID(),
      baseRevision: 1,
      state: { ...emptyState, log: [first] },
      results: null,
    });
    await store.save({
      gameId,
      name: "Append-only legacy table",
      mutationId: randomUUID(),
      baseRevision: 2,
      state: { ...emptyState, log: [first, replacement] },
      results: null,
    });

    const events = await pool.query<{ id: string; sequence: number; payload: unknown }>(
      `SELECT id, sequence, payload
         FROM game_events
        WHERE club_id = $1 AND game_id = $2
        ORDER BY sequence`,
      [DEFAULT_CLUB_ID, gameId],
    );
    expect(events.rows).toEqual([
      expect.objectContaining({ sequence: 1 }),
      { id: first.id, sequence: 2, payload: first.payload },
      { id: abandoned.id, sequence: 3, payload: abandoned.payload },
      { id: replacement.id, sequence: 4, payload: replacement.payload },
    ]);

    await expect(
      store.save({
        gameId,
        name: "Append-only legacy table",
        mutationId: randomUUID(),
        baseRevision: 3,
        state: { ...emptyState, log: [{ ...first, payload: { seat: 9 } }, replacement] },
        results: null,
      }),
    ).rejects.toMatchObject({
      name: "GameSessionOperationError",
      code: "game_session_event_conflict",
    });
    await expect(store.get(gameId)).resolves.toMatchObject({ revision: 3 });
    await expect(
      pool.query(
        "SELECT COUNT(*)::int AS count FROM game_events WHERE club_id = $1 AND game_id = $2",
        [DEFAULT_CLUB_ID, gameId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 4 }] });
  });

  it("creates one revision for a retry of the same session mutation", async () => {
    const gameId = randomUUID();
    const mutationId = randomUUID();
    const input = {
      gameId,
      name: "Friday table",
      mutationId,
      baseRevision: 0,
      state: emptyState,
      results: null,
    } as const;

    const first = await store.save(input);
    const retry = await store.save(input);

    expect(first).toMatchObject({ gameId, revision: 1, duplicate: false, state: emptyState });
    expect(retry).toMatchObject({ gameId, revision: 1, duplicate: true, state: emptyState });
    const events = await pool.query<{ event_type: string }>(
      "SELECT event_type FROM game_events WHERE game_id = $1 ORDER BY sequence",
      [gameId],
    );
    expect(events.rows).toEqual([{ event_type: "game.created" }]);
  });

  it("returns the current replay aggregate and revision for an older legacy retry", async () => {
    const gameId = randomUUID();
    const completed = await createCompletedSession(gameId);
    const original = {
      gameId,
      name: "Legacy retry after start",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: {
        ...emptyState,
        hostPlayerId: completed.hostPlayerId,
        hostName: "Retry Host",
      },
      results: null,
    } as const;
    await store.save(original);
    const initialGame = { replayVersion: 1 as const, game: completed.state.game };
    const started = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-08-18T07:59:00.000Z",
      before: initialGame.game,
      draft: { type: "game.checkpointed", payload: {} },
    });
    await store.start({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 1,
      initialGame,
      event: started.entry,
    });

    const retry = await store.save(original);

    expect(retry).toMatchObject({
      revision: 2,
      duplicate: true,
      state: {
        game: initialGame.game,
        events: [started.entry],
        headEventId: started.entry.id,
      },
    });
    await expect(store.get(gameId)).resolves.toMatchObject({ revision: 2 });
  });

  it("accepts a stale full browser snapshot after dedicated start and mirrors it as current state", async () => {
    const gameId = randomUUID();
    const completed = await createCompletedSession(gameId);
    await store.save({
      gameId,
      name: "Legacy setup only",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: {
        ...emptyState,
        hostPlayerId: completed.hostPlayerId,
        hostName: "Legacy Setup Host",
      },
      results: null,
    });
    const initialGame = { replayVersion: 1 as const, game: completed.state.game };
    const started = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-08-18T07:59:00.000Z",
      before: initialGame.game,
      draft: { type: "game.checkpointed", payload: {} },
    });
    await store.start({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 1,
      initialGame,
      event: started.entry,
    });
    const later = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 2,
      parentEventId: started.entry.id,
      createdAt: "2026-08-18T08:00:00.000Z",
      before: started.after,
      draft: { type: "game.completed", payload: { winner: "red" } },
    });
    await store.appendEvent({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 2,
      event: later.entry,
    });

    const snapshotState = {
      ...completed.state,
      game: completed.state.game,
      initialGame,
      events: [started.entry],
      headEventId: started.entry.id,
      resetReturnEventId: null,
    };
    const saved = await store.save({
      gameId,
      name: "Legacy setup only",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: snapshotState,
      results: null,
    });

    expect(saved).toMatchObject({
      revision: 4,
      duplicate: false,
      state: snapshotState,
    });
    const events = await pool.query<{ id: string }>(
      "SELECT id FROM game_events WHERE game_id = $1 AND replay_sequence IS NOT NULL",
      [gameId],
    );
    expect(events.rows).toEqual([{ id: started.entry.id }]);
    await expect(store.get(gameId)).resolves.toMatchObject({ revision: 4, state: snapshotState });
    await store.save({
      gameId,
      name: "Legacy setup only",
      mutationId: randomUUID(),
      state: { ...completed.state, game: completed.state.game },
      results: null,
    });
    await expect(
      pool.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM game_events WHERE game_id = $1 AND replay_sequence IS NOT NULL",
        [gameId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("rejects a browser snapshot that mutates immutable event content", async () => {
    const gameId = randomUUID();
    const completed = await createCompletedSession(gameId);
    await store.save({
      gameId,
      name: "Protected replay",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: {
        ...emptyState,
        hostPlayerId: completed.hostPlayerId,
        hostName: "Protected Replay Host",
      },
      results: null,
    });
    const initialGame = { replayVersion: 1 as const, game: completed.state.game };
    const started = createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-08-18T07:59:00.000Z",
      before: initialGame.game,
      draft: { type: "game.checkpointed", payload: {} },
    });
    await store.start({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 1,
      initialGame,
      event: started.entry,
    });

    await expect(
      store.save({
        gameId,
        name: "Protected replay",
        mutationId: randomUUID(),
        baseRevision: 2,
        state: {
          ...completed.state,
          initialGame,
          events: [{ ...started.entry, createdAt: "2027-01-01T00:00:00.000Z" }],
          headEventId: started.entry.id,
        },
        results: null,
      }),
    ).rejects.toMatchObject({
      name: "GameSessionOperationError",
      code: "game_session_event_conflict",
    });
    await expect(
      store.save({
        gameId,
        name: "Protected replay",
        mutationId: randomUUID(),
        state: {
          ...completed.state,
          initialGame,
          events: [{ ...started.entry, gameId: randomUUID() }],
          headEventId: started.entry.id,
        },
        results: null,
      }),
    ).rejects.toMatchObject({
      name: "GameSessionOperationError",
      code: "game_session_event_conflict",
    });
    const stored = await pool.query<{ created_at: Date }>(
      "SELECT created_at FROM game_events WHERE id = $1",
      [started.entry.id],
    );
    expect(stored.rows[0]?.created_at.toISOString()).toBe(started.entry.createdAt);
    await expect(store.get(gameId)).resolves.toMatchObject({ revision: 2 });
  });

  it("allocates concurrent dated names once and preserves the canonical name", async () => {
    await pool.query(
      "DELETE FROM game_daily_counters WHERE game_date = TO_DATE('12.02.26', 'DD.MM.YY')",
    );
    const gameIds = [randomUUID(), randomUUID()];
    const created = await Promise.all(
      gameIds.map((gameId) =>
        store.save({
          gameId,
          name: "12.02.26 #1",
          mutationId: randomUUID(),
          baseRevision: 0,
          state: emptyState,
          results: null,
        }),
      ),
    );
    expect(created.map(({ name }) => name).sort()).toEqual(["12.02.26 #1", "12.02.26 #2"]);

    const updated = await store.save({
      gameId: created[0]!.gameId,
      name: "12.02.26 #99",
      mutationId: randomUUID(),
      baseRevision: 1,
      state: { ...emptyState, playlistId: "updated" },
      results: null,
    });
    expect(updated.name).toBe(created[0]!.name);
  });

  it("rejects reuse of a mutation id with a different full snapshot", async () => {
    const gameId = randomUUID();
    const mutationId = randomUUID();
    await store.save({
      gameId,
      name: "Exact retry table",
      mutationId,
      baseRevision: 0,
      state: emptyState,
      results: null,
    });

    await expect(
      store.save({
        gameId,
        name: "Exact retry table",
        mutationId,
        baseRevision: 0,
        state: { ...emptyState, playlistId: "different" },
        results: null,
      }),
    ).rejects.toMatchObject({ name: "GameSessionMutationMismatchError" });
    await expect(store.get(gameId)).resolves.toMatchObject({ state: emptyState, revision: 1 });
  });

  it("returns the coherent current aggregate and revision after newer saves", async () => {
    const gameId = randomUUID();
    const original = {
      gameId,
      name: "Retry table",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: emptyState,
      results: null,
    } as const;
    await store.save(original);
    await store.save({
      ...original,
      mutationId: randomUUID(),
      baseRevision: 1,
      state: { ...emptyState, playlistId: "newer" },
    });

    const retry = await store.save(original);

    expect(retry).toMatchObject({
      gameId,
      revision: 2,
      duplicate: true,
      state: { playlistId: "newer" },
    });
    await expect(store.get(gameId)).resolves.toMatchObject({
      revision: 2,
      state: { playlistId: "newer" },
    });
  });

  it("lets the last valid browser snapshot win over a newer server revision", async () => {
    const gameId = randomUUID();
    const first = await store.save({
      gameId,
      name: "Conflict table",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: emptyState,
      results: null,
    });
    const newerState = { ...emptyState, playlistId: "playlist-new" };
    await store.save({
      gameId,
      name: "Conflict table",
      mutationId: randomUUID(),
      baseRevision: first.revision,
      state: newerState,
      results: null,
    });

    const lastState = { ...emptyState, playlistId: "playlist-last" };
    const saved = await store.save({
      gameId,
      name: "Conflict table",
      mutationId: randomUUID(),
      baseRevision: first.revision,
      state: lastState,
      results: null,
    });

    expect(saved).toMatchObject({ revision: 3, state: lastState });
    await expect(store.get(gameId)).resolves.toMatchObject({ revision: 3, state: lastState });
  });

  it("rejects a stale clear without tombstoning the newer session", async () => {
    const gameId = randomUUID();
    const first = await store.save({
      gameId,
      name: "Stale clear table",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: emptyState,
      results: null,
    });
    const second = await store.save({
      gameId,
      name: "Stale clear table",
      mutationId: randomUUID(),
      baseRevision: first.revision,
      state: { ...emptyState, playlistId: "newer" },
      results: null,
    });

    await expect(store.clear(gameId, first.revision)).rejects.toMatchObject({
      name: "GameSessionConflictError",
      currentRevision: second.revision,
    });
    await expect(store.get(gameId)).resolves.toMatchObject({
      revision: second.revision,
      state: { playlistId: "newer" },
    });

    await store.clear(gameId, second.revision);
    await expect(store.get(gameId)).resolves.toBeNull();
  });

  it("derives active players from setup player foreign keys", async () => {
    const gameId = randomUUID();
    const hostPlayerId = randomUUID();
    const seatedPlayerId = randomUUID();
    await pool.query(`INSERT INTO players (id, nickname) VALUES ($1, $2), ($3, $4)`, [
      hostPlayerId,
      `Host ${hostPlayerId}`,
      seatedPlayerId,
      `Seat ${seatedPlayerId}`,
    ]);
    await store.save({
      gameId,
      name: "Player table",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: {
        ...emptyState,
        setup: {
          step: "players",
          hostPlayerId,
          selectedPlayerIds: [seatedPlayerId],
          setup: null,
        },
        hostPlayerId,
        hostName: "Host",
      },
      results: null,
    });

    const selectedPlayers = await pool.query<{
      player_id: string;
      seat: number | null;
      is_host: boolean;
      role: string | null;
    }>(
      `SELECT player_id, seat, is_host, role
         FROM game_session_players
        WHERE game_id = $1
        ORDER BY is_host DESC, seat`,
      [gameId],
    );
    expect(selectedPlayers.rows).toEqual([
      { player_id: hostPlayerId, seat: null, is_host: true, role: null },
      { player_id: seatedPlayerId, seat: 1, is_host: false, role: null },
    ]);
  });

  it("uses canonical game players before setup rosters and selected IDs", async () => {
    const gameId = randomUUID();
    const completed = await createCompletedSession(gameId);
    const setupPlayerId = randomUUID();
    const selectedPlayerId = randomUUID();
    await pool.query(`INSERT INTO players (id, nickname) VALUES ($1, $2), ($3, $4)`, [
      setupPlayerId,
      `Setup ${setupPlayerId}`,
      selectedPlayerId,
      `Selected ${selectedPlayerId}`,
    ]);
    const setup = {
      step: "roles",
      hostPlayerId: completed.hostPlayerId,
      selectedPlayerIds: [selectedPlayerId],
      setup: { players: [{ id: setupPlayerId, seat: 1 }], assignments: { 1: "mafia" } },
    } as const;
    const projectedPlayers = async () =>
      (
        await pool.query<{ player_id: string; seat: number; role: string | null }>(
          `SELECT player_id, seat, role
             FROM game_session_players
            WHERE game_id = $1 AND NOT is_host
            ORDER BY seat`,
          [gameId],
        )
      ).rows;

    await store.save({
      gameId,
      name: "Projection precedence",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: { ...completed.state, setup },
      results: null,
    });
    expect(await projectedPlayers()).toEqual(
      completed.state.game.players.map(({ id, seat, role }) => ({ player_id: id, seat, role })),
    );

    await store.save({
      gameId,
      name: "Projection precedence",
      mutationId: randomUUID(),
      baseRevision: 1,
      state: { ...emptyState, hostPlayerId: completed.hostPlayerId, setup },
      results: null,
    });
    expect(await projectedPlayers()).toEqual([
      { player_id: setupPlayerId, seat: 1, role: "mafia" },
    ]);

    await store.save({
      gameId,
      name: "Projection precedence",
      mutationId: randomUUID(),
      baseRevision: 2,
      state: {
        ...emptyState,
        hostPlayerId: completed.hostPlayerId,
        setup: { ...setup, setup: null },
      },
      results: null,
    });
    expect(await projectedPlayers()).toEqual([
      { player_id: selectedPlayerId, seat: 1, role: null },
    ]);
  });

  it("atomically finalizes results and removes active players", async () => {
    const gameId = randomUUID();
    const completed = await createCompletedSession(gameId);

    await store.save({
      gameId,
      name: "Completed table",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: completed.state,
      results: completed.results,
    });

    const session = await pool.query<{ status: string }>(
      "SELECT status FROM game_sessions WHERE id = $1",
      [gameId],
    );
    const selectedPlayers = await pool.query(
      "SELECT 1 FROM game_session_players WHERE game_id = $1",
      [gameId],
    );
    const results = await pool.query<{
      winner: string;
      participants: number;
      best_move_hits: number;
    }>(
      `SELECT result.winner, COUNT(player_result.player_id)::int AS participants,
              COALESCE(SUM(player_result.best_move_hits), 0)::int AS best_move_hits
         FROM game_results AS result
         JOIN game_player_results AS player_result ON player_result.game_id = result.game_id
        WHERE result.game_id = $1
        GROUP BY result.winner`,
      [gameId],
    );
    const events = await pool.query<{ sequence: number; event_type: string }>(
      "SELECT sequence, event_type FROM game_events WHERE game_id = $1 ORDER BY sequence",
      [gameId],
    );
    expect(session.rows).toEqual([{ status: "completed" }]);
    expect(selectedPlayers.rowCount).toBe(0);
    expect(results.rows).toEqual([{ winner: "red", participants: 10, best_move_hits: 2 }]);
    expect(events.rows).toEqual([
      { sequence: 1, event_type: "game.created" },
      { sequence: 2, event_type: "game.finished" },
    ]);
  });

  it("does not accept a player waiter blocked by another backend", async () => {
    const playerId = randomUUID();
    await pool.query("INSERT INTO players (id, nickname) VALUES ($1, $2)", [
      playerId,
      `Unrelated waiter ${playerId}`,
    ]);
    const unrelatedBlocker = await pool.connect();
    const targetBlocker = await pool.connect();
    let waiter: Promise<unknown> | undefined;
    try {
      await unrelatedBlocker.query("BEGIN");
      await unrelatedBlocker.query("SELECT id FROM players WHERE id = $1 FOR UPDATE", [playerId]);
      const targetPid = await targetBlocker.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      waiter = pool.query(
        "SELECT id FROM players WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE",
        [[playerId]],
      );

      await expect(waitForPlayerLockWaiter(targetPid.rows[0]!.pid, 5)).rejects.toThrow(
        `Timed out waiting for a player projection lock blocked by backend ${targetPid.rows[0]!.pid}`,
      );
    } finally {
      await unrelatedBlocker.query("ROLLBACK");
      unrelatedBlocker.release();
      targetBlocker.release();
      await waiter;
    }
  });

  it("recomputes player timestamps after a concurrent result commits", async () => {
    const clearedGameId = randomUUID();
    const completed = await createCompletedSession(clearedGameId);
    await store.save({
      gameId: clearedGameId,
      name: "Cleared table",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: completed.state,
      results: completed.results,
    });
    const hostPlayerId = completed.hostPlayerId;
    const participantId = completed.results.players[0]!.playerId;
    const newerGameId = randomUUID();
    const newerPlayedAt = new Date("2026-08-18T09:00:00.000Z");
    const blocker = await pool.connect();
    let committed = false;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT id FROM players WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE",
        [[hostPlayerId, participantId]],
      );
      await blocker.query(
        `INSERT INTO game_results (game_id, winner, played_at, host_player_id)
         VALUES ($1, 'red', $2, $3)`,
        [newerGameId, newerPlayedAt, hostPlayerId],
      );
      await blocker.query(
        `INSERT INTO game_player_results
           (game_id, player_id, seat, role, team, final_status, fouls, won)
         VALUES ($1, $2, 1, 'citizen', 'red', 'active', 0, TRUE)`,
        [newerGameId, participantId],
      );

      const blockerPid = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const clearing = store.clear(clearedGameId, 1);
      await waitForPlayerLockWaiter(blockerPid.rows[0]!.pid);
      await blocker.query("COMMIT");
      committed = true;
      await clearing;

      const players = await pool.query<{ id: string; last_played_at: Date | null }>(
        "SELECT id, last_played_at FROM players WHERE id = ANY($1::uuid[]) ORDER BY id",
        [[hostPlayerId, participantId]],
      );
      expect(players.rows).toHaveLength(2);
      expect(players.rows.map(({ last_played_at }) => last_played_at?.toISOString())).toEqual([
        newerPlayedAt.toISOString(),
        newerPlayedAt.toISOString(),
      ]);
    } finally {
      if (!committed) await blocker.query("ROLLBACK");
      blocker.release();
    }
  });

  it("tombstones a known client game id before its first save and rejects the late mutation", async () => {
    const gameId = randomUUID();

    await store.clear(gameId);

    await expect(
      store.save({
        gameId,
        name: "Too late",
        mutationId: randomUUID(),
        baseRevision: 0,
        state: emptyState,
        results: null,
      }),
    ).rejects.toMatchObject({ name: "DeletedGameError", code: "game_deleted" });
    const sessions = await pool.query("SELECT 1 FROM game_sessions WHERE id = $1", [gameId]);
    const events = await pool.query("SELECT 1 FROM game_events WHERE game_id = $1", [gameId]);
    expect(sessions.rowCount).toBe(0);
    expect(events.rowCount).toBe(0);
  });

  it("lists only active restorable sessions with the latest update first", async () => {
    const targetClub = await new ClubStore(pool).create(legacyOwnerId, {
      name: `Ordered sessions ${randomUUID().slice(0, 8)}`,
      city: "Granada",
      headerLogo: null,
      cardLogo: null,
      language: "en",
      ownerConsent: true,
    });
    const foreignClub = await new ClubStore(pool).create(legacyOwnerId, {
      name: `Foreign ordered sessions ${randomUUID().slice(0, 8)}`,
      city: "Granada",
      headerLogo: null,
      cardLogo: null,
      language: "en",
      ownerConsent: true,
    });
    const foreignId = randomUUID();
    await store.save({
      clubId: foreignClub.id,
      gameId: foreignId,
      name: "Foreign newer",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: emptyState,
      results: null,
    });
    await pool.query(
      "UPDATE game_sessions SET updated_at = '2097-01-01T00:00:00Z' WHERE club_id = $1 AND id = $2",
      [foreignClub.id, foreignId],
    );
    const foreignBefore = await pool.query<{ status: string; updated_at: Date }>(
      "SELECT status, updated_at FROM game_sessions WHERE club_id = $1 AND id = $2",
      [foreignClub.id, foreignId],
    );
    const olderId = randomUUID();
    const newerId = randomUUID();
    const completedId = randomUUID();
    for (const [gameId, name] of [
      [olderId, "Older"],
      [newerId, "Newer"],
      [completedId, "Completed"],
    ] as const) {
      await store.save({
        clubId: targetClub.id,
        gameId,
        name,
        mutationId: randomUUID(),
        baseRevision: 0,
        state: { ...emptyState, hostName: `${name} host` },
        results: null,
      });
    }
    await pool.query(
      `UPDATE game_sessions
          SET updated_at = CASE id
            WHEN $1 THEN '2098-01-01T00:00:00Z'::timestamptz
            WHEN $2 THEN '2099-01-01T00:00:00Z'::timestamptz
            ELSE updated_at
          END,
          status = CASE WHEN id = $3 THEN 'completed' ELSE status END
        WHERE club_id = $5 AND id = ANY($4::uuid[])`,
      [olderId, newerId, completedId, [olderId, newerId, completedId], targetClub.id],
    );

    const active = await store.listActive(targetClub.id);

    expect(active.slice(0, 2)).toEqual([
      expect.objectContaining({ gameId: newerId, name: "Newer", hostName: "Newer host" }),
      expect.objectContaining({ gameId: olderId, name: "Older", hostName: "Older host" }),
    ]);
    expect(active.some(({ gameId }) => gameId === completedId)).toBe(false);
    expect(active.some(({ gameId }) => gameId === foreignId)).toBe(false);
    await expect(
      pool.query<{ status: string; updated_at: Date }>(
        "SELECT status, updated_at FROM game_sessions WHERE club_id = $1 AND id = $2",
        [foreignClub.id, foreignId],
      ),
    ).resolves.toMatchObject({ rows: foreignBefore.rows });
  });

  it("keeps active-session query count constant as replay sessions grow", async () => {
    const club = await new ClubStore(pool).create(legacyOwnerId, {
      name: `Active query count ${randomUUID().slice(0, 8)}`,
      city: "Granada",
      headerLogo: null,
      cardLogo: null,
      language: "en",
      ownerConsent: true,
    });
    const gameIds = Array.from({ length: 3 }, () => randomUUID());
    for (const gameId of gameIds) await createStartedDaySessionWithCheckpoints(gameId, club.id);

    const recordingPool = new Pool({ connectionString: databaseUrl });
    const recordingStore = new GameSessionStore(recordingPool);
    const query = vi.spyOn(recordingPool, "query");
    try {
      const active = await recordingStore.listActive(club.id);

      expect(query).toHaveBeenCalledTimes(2);
      expect(new Set(active.map(({ gameId }) => gameId))).toEqual(new Set(gameIds));
      expect(active).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ phase: "day", day: 1, hostName: "Head Host" }),
        ]),
      );
    } finally {
      query.mockRestore();
      await recordingPool.end();
    }
  });

  it("keeps completed-session query count constant as replay sessions grow", async () => {
    const club = await new ClubStore(pool).create(legacyOwnerId, {
      name: `Completed query count ${randomUUID().slice(0, 8)}`,
      city: "Granada",
      headerLogo: null,
      cardLogo: null,
      language: "en",
      ownerConsent: true,
    });
    const gameIds = Array.from({ length: 3 }, () => randomUUID());
    for (const gameId of gameIds) await createCanonicalCompletedSession(gameId, club.id);

    const recordingPool = new Pool({ connectionString: databaseUrl });
    const recordingStore = new GameSessionStore(recordingPool);
    const query = vi.spyOn(recordingPool, "query");
    try {
      const completed = await recordingStore.listCompleted(club.id);

      expect(query).toHaveBeenCalledTimes(2);
      expect(new Set(completed.map(({ gameId }) => gameId))).toEqual(new Set(gameIds));
      expect(completed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            winner: "red",
            day: 2,
            eventCount: 3,
            hostName: "Completed Query Host",
          }),
        ]),
      );
    } finally {
      query.mockRestore();
      await recordingPool.end();
    }
  });

  it("persists every completion player projection with one insert statement", async () => {
    const club = await new ClubStore(pool).create(legacyOwnerId, {
      name: `Completion insert count ${randomUUID().slice(0, 8)}`,
      city: "Granada",
      headerLogo: null,
      cardLogo: null,
      language: "en",
      ownerConsent: true,
    });
    const gameId = randomUUID();
    const candidate = await createCanonicalCompletedSession(gameId, club.id, false);
    const mutationId = randomUUID();
    const recordingPool = new Pool({ connectionString: databaseUrl });
    let calls = (): readonly unknown[][] => [];
    let restoreQuery: () => void = () => undefined;
    recordingPool.on("connect", (client) => {
      const query = vi.spyOn(client, "query");
      calls = () => query.mock.calls;
      restoreQuery = () => query.mockRestore();
    });
    const recordingStore = new GameSessionStore(recordingPool);
    try {
      const completed = await recordingStore.complete({
        clubId: club.id,
        gameId,
        mutationId,
        baseRevision: 3,
        results: candidate.results,
      });
      const playerResultInserts = calls().filter(([statement]) =>
        typeof statement === "string"
          ? statement.includes("INSERT INTO game_player_results")
          : false,
      );

      expect(playerResultInserts).toHaveLength(1);
      expect(completed).toMatchObject({
        status: "completed",
        revision: 4,
        results: candidate.results,
      });
      await expect(
        pool.query<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM game_player_results WHERE club_id = $1 AND game_id = $2",
          [club.id, gameId],
        ),
      ).resolves.toMatchObject({ rows: [{ count: 10 }] });

      const callsBeforeRetry = calls().length;
      await expect(
        recordingStore.complete({
          clubId: club.id,
          gameId,
          mutationId,
          baseRevision: 3,
          results: candidate.results,
        }),
      ).resolves.toMatchObject({ duplicate: true, revision: 4 });
      expect(
        calls()
          .slice(callsBeforeRetry)
          .filter(([statement]) =>
            typeof statement === "string"
              ? statement.includes("INSERT INTO game_player_results")
              : false,
          ),
      ).toHaveLength(0);
    } finally {
      restoreQuery();
      await recordingPool.end();
    }
  });
});
