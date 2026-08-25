import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createGameLogEntry } from "@mafia/game-domain";
import { GameSessionStore } from "./game-session-store.js";
import { ClubStore, DEFAULT_CLUB_ID } from "./club-store.js";

const legacyOwnerId = "00000000-0000-4000-8000-000000000001";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgresql://mafia:mafia@127.0.0.1:54329/mafia_test";
const pool = new Pool({ connectionString: databaseUrl });
const store = new GameSessionStore(pool);

const waitForPlayerLockWaiter = async (): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await pool.query(
      `SELECT 1
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND (query LIKE '%UPDATE players AS p%' OR query LIKE '%SELECT id FROM players%')`,
    );
    if (waiting.rowCount !== 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for the player projection lock");
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

const createCompletedSession = async (gameId: string, clubId = DEFAULT_CLUB_ID) => {
  const hostPlayerId = randomUUID();
  const playerIds = Array.from({ length: 10 }, () => randomUUID());
  const allIds = [hostPlayerId, ...playerIds];
  for (const [index, id] of allIds.entries()) {
    await pool.query("INSERT INTO players (id, club_id, nickname) VALUES ($1, $2, $3)", [
      id,
      clubId,
      `Aggregate ${gameId} ${index}`,
    ]);
  }
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
          secret: false,
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

const createStartedDaySessionWithTurns = async (gameId: string) => {
  const completed = await createCompletedSession(gameId);
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
    draft: { type: "game.checkpointed", payload: {}, secret: true },
  });
  await store.start({
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
    draft: { type: "turn.completed", payload: { seat: 1 }, secret: false },
  });
  await store.appendEvent({
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
    draft: { type: "turn.completed", payload: { seat: 2 }, secret: false },
  });
  await store.appendEvent({
    gameId,
    mutationId: randomUUID(),
    baseRevision: 3,
    event: second.entry,
  });
  return { completed, initialGame, started, first, second };
};

describe("GameSessionStore", () => {
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
            day_before, day_after, payload, secret, state_hash_after)
         VALUES
           ($1, $4, 1, 'legacy-created', 'game.created', 'setup-players', NULL,
            NULL, NULL, '{}'::jsonb, FALSE, NULL),
           ($2, $4, 2, 'canonical-started', 'game.started', 'day', 'day',
            1, 1, '{}'::jsonb, TRUE, $5),
           ($3, $4, 3, 'canonical-turn', 'turn.completed', 'day', 'day',
            1, 1, '{"seat": 1}'::jsonb, FALSE, $6)`,
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
      draft: { type: "game.checkpointed", payload: {}, secret: true },
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
      draft: { type: "game.checkpointed", payload: {}, secret: true },
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
           (id, game_id, sequence, idempotency_key, event_type, phase, payload, secret,
            replay_sequence, created_at)
         VALUES ($1::uuid, $2, 1, $1::text, $3, $4, $5::jsonb, $6, 1, $7)`,
        [
          started.entry.id,
          gameId,
          started.entry.type,
          started.entry.phaseBefore,
          JSON.stringify(started.entry.payload),
          started.entry.secret,
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
    const normalize = (
      store as unknown as {
        readonly normalize: (input: {
          readonly gameId: string;
          readonly mutationId: string;
          readonly baseRevision: number;
        }) => Promise<{ readonly revision: number; readonly duplicate: boolean }>;
      }
    ).normalize.bind(store);

    const normalized = await normalize({
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
        secret: false,
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
    const normalize = (
      store as unknown as {
        readonly normalize: (input: {
          readonly gameId: string;
          readonly mutationId: string;
          readonly baseRevision: number;
        }) => Promise<{
          readonly revision: number;
          readonly replayBaseEventId?: string | null;
          readonly previewableFromEventId?: string | null;
        }>;
      }
    ).normalize.bind(store);

    const normalized = await normalize({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 1,
    });

    expect(normalized.revision).toBe(2);
    expect(normalized.replayBaseEventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(normalized.previewableFromEventId).toBe(normalized.replayBaseEventId);
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
      draft: { type: "game.checkpointed", payload: {}, secret: true },
    });
    const start = (
      store as unknown as {
        readonly start: (input: {
          readonly gameId: string;
          readonly mutationId: string;
          readonly baseRevision: number;
          readonly initialGame: typeof initialGame;
          readonly event: typeof started.entry;
        }) => Promise<{ readonly revision: number; readonly state: { readonly game: unknown } }>;
      }
    ).start.bind(store);

    const response = await start({
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

  it("appends one validated canonical event without replacing prior rows", async () => {
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
      draft: { type: "game.checkpointed", payload: {}, secret: true },
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
      draft: { type: "turn.completed", payload: { seat: 1 }, secret: false },
    });
    const appendEvent = (
      store as unknown as {
        readonly appendEvent: (input: {
          readonly gameId: string;
          readonly mutationId: string;
          readonly baseRevision: number;
          readonly event: typeof turn.entry;
        }) => Promise<{ readonly revision: number; readonly state: { readonly game: unknown } }>;
      }
    ).appendEvent.bind(store);

    const response = await appendEvent({
      gameId,
      mutationId: randomUUID(),
      baseRevision: 2,
      event: turn.entry,
    });

    expect(response).toMatchObject({
      revision: 3,
      state: { game: expect.objectContaining({ currentTurnIndex: 1 }) },
    });
    const events = await pool.query<{
      id: string;
      replay_sequence: number | null;
      parent_event_id: string | null;
    }>(
      "SELECT id, replay_sequence, parent_event_id FROM game_events WHERE game_id = $1 ORDER BY sequence",
      [gameId],
    );
    expect(events.rows).toEqual([
      expect.objectContaining({ replay_sequence: null }),
      { id: started.entry.id, replay_sequence: 1, parent_event_id: null },
      { id: turn.entry.id, replay_sequence: 2, parent_event_id: started.entry.id },
    ]);
    const stored = await pool.query<{ state: Record<string, unknown> }>(
      "SELECT state FROM game_sessions WHERE id = $1",
      [gameId],
    );
    expect(stored.rows[0]?.state).not.toHaveProperty("game");
    expect(stored.rows[0]?.state).not.toHaveProperty("events");
  });

  it("moves reset head without deleting future rows and records reset recovery", async () => {
    const gameId = randomUUID();
    const history = await createStartedDaySessionWithTurns(gameId);
    const moveHead = (
      store as unknown as {
        readonly moveHead: (input: {
          readonly gameId: string;
          readonly mutationId: string;
          readonly baseRevision: number;
          readonly targetEventId: string;
          readonly reason: "undo" | "reset" | "restore-reset";
        }) => Promise<{
          readonly revision: number;
          readonly state: {
            readonly game: { readonly currentTurnIndex: number };
            readonly headEventId?: string | null;
            readonly resetReturnEventId?: string | null;
          };
        }>;
      }
    ).moveHead.bind(store);

    const response = await moveHead({
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
    const history = await createStartedDaySessionWithTurns(gameId);
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
      draft: { type: "turn.completed", payload: { seat: 1 }, secret: false },
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
        game: expect.objectContaining({ currentTurnIndex: 1 }),
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
    const history = await createStartedDaySessionWithTurns(gameId);
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
      draft: { type: "turn.completed", payload: { seat: 1 }, secret: false },
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
    const history = await createStartedDaySessionWithTurns(gameId);
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
          draft: { type: "turn.completed", payload: { seat: 1 }, secret: false },
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
      draft: { type: "game.checkpointed", payload: {}, secret: true },
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
      draft: { type: "game.completed", payload: { winner: "red" }, secret: false },
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
    const complete = (
      store as unknown as {
        readonly complete: (input: {
          readonly gameId: string;
          readonly mutationId: string;
          readonly baseRevision: number;
          readonly results: typeof completed.results;
        }) => Promise<{
          readonly revision: number;
          readonly status: string;
          readonly results: unknown;
        }>;
      }
    ).complete.bind(store);
    const mutationId = randomUUID();

    const response = await complete({
      gameId,
      mutationId,
      baseRevision: 3,
      results: completionResults,
    });
    const retry = await complete({
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
      complete({
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
      draft: { type: "game.checkpointed", payload: {}, secret: true },
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
      draft: { type: "game.completed", payload: { winner: "red" }, secret: false },
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
      roster_count: number;
    }>(
      `SELECT
         (SELECT COUNT(*)::int FROM game_results WHERE game_id = $1) AS result_count,
         (SELECT COUNT(*)::int FROM game_session_players WHERE game_id = $1) AS roster_count`,
      [gameId],
    );
    expect(projections.rows).toEqual([{ result_count: 0, roster_count: 11 }]);

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
           (SELECT COUNT(*)::int FROM game_session_players WHERE game_id = $1) AS roster_count`,
        [gameId],
      ),
    ).toMatchObject({ rows: [{ result_count: 1, player_result_count: 10, roster_count: 0 }] });
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
      draft: { type: "game.checkpointed", payload: {}, secret: true },
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
      draft: { type: "game.completed", payload: { winner: "red" }, secret: false },
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
      draft: { type: "game.checkpointed", payload: {}, secret: true },
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
      draft: { type: "game.completed", payload: { winner: "red" }, secret: false },
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
    });
    const gameId = randomUUID();
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
        initialGame: {} as never,
        event: {} as never,
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
    });
    const gameId = randomUUID();
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
          initialGame: {} as never,
          event: {} as never,
        }),
      () =>
        store.appendEvent({
          gameId,
          mutationId: randomUUID(),
          baseRevision: 1,
          event: {} as never,
        }),
      () =>
        store.moveHead({
          gameId,
          mutationId: randomUUID(),
          baseRevision: 1,
          targetEventId: randomUUID(),
          reason: "reset",
        }),
      () =>
        store.complete({
          gameId,
          mutationId: randomUUID(),
          baseRevision: 1,
          results: {} as never,
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
      draft: { type: "game.checkpointed", payload: {}, secret: true },
    });
    const localRoot = createGameLogEntry({
      gameId: localGameId,
      id: sharedEventId,
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-08-18T08:00:00.000Z",
      before: localInitialGame.game,
      draft: { type: "game.checkpointed", payload: {}, secret: true },
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
      roster: number;
      events: number;
    }>(
      `SELECT session.club_id,
              (SELECT COUNT(*)::int FROM game_session_mutations AS mutation
                WHERE mutation.club_id = session.club_id AND mutation.game_id = session.id) AS mutations,
              (SELECT COUNT(*)::int FROM game_session_players AS roster
                WHERE roster.club_id = session.club_id AND roster.game_id = session.id) AS roster,
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
        { club_id: DEFAULT_CLUB_ID, mutations: 1, roster: 1, events: 1 },
        { club_id: club.id, mutations: 1, roster: 1, events: 1 },
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
      secret: false,
      createdAt: "2026-08-18T08:00:00.000Z",
    } as const;
    const abandoned = {
      id: randomUUID(),
      sequence: 2,
      type: "foul.issued",
      phase: "day",
      payload: { seat: 2 },
      secret: false,
      createdAt: "2026-08-18T08:01:00.000Z",
    } as const;
    const replacement = {
      id: randomUUID(),
      sequence: 2,
      type: "foul.issued",
      phase: "day",
      payload: { seat: 3 },
      secret: false,
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
      draft: { type: "game.checkpointed", payload: {}, secret: true },
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

  it("keeps legacy PUT for setup but refuses cumulative replacement after dedicated start", async () => {
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
      draft: { type: "game.checkpointed", payload: {}, secret: true },
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
        name: "Legacy setup only",
        mutationId: randomUUID(),
        baseRevision: 2,
        state: {
          ...completed.state,
          game: completed.state.game,
        },
        results: null,
      }),
    ).rejects.toMatchObject({
      name: "GameSessionOperationError",
      code: "game_session_incremental_required",
    });
    const events = await pool.query<{ id: string }>(
      "SELECT id FROM game_events WHERE game_id = $1 AND replay_sequence IS NOT NULL",
      [gameId],
    );
    expect(events.rows).toEqual([{ id: started.entry.id }]);
    await expect(store.get(gameId)).resolves.toMatchObject({ revision: 2 });
  });

  it("refuses legacy PUT replacement even when it supplies canonical events", async () => {
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
      draft: { type: "game.checkpointed", payload: {}, secret: true },
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
      code: "game_session_incremental_required",
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

  it("rejects a stale base revision without overwriting the newer snapshot", async () => {
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

    await expect(
      store.save({
        gameId,
        name: "Conflict table",
        mutationId: randomUUID(),
        baseRevision: first.revision,
        state: { ...emptyState, playlistId: "playlist-stale" },
        results: null,
      }),
    ).rejects.toMatchObject({ name: "GameSessionConflictError", currentRevision: 2 });
    await expect(store.get(gameId)).resolves.toMatchObject({ revision: 2, state: newerState });
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

  it("derives the active roster from setup player foreign keys", async () => {
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
      name: "Roster table",
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

    const roster = await pool.query<{ player_id: string; seat: number | null; is_host: boolean }>(
      `SELECT player_id, seat, is_host
         FROM game_session_players
        WHERE game_id = $1
        ORDER BY is_host DESC, seat`,
      [gameId],
    );
    expect(roster.rows).toEqual([
      { player_id: hostPlayerId, seat: null, is_host: true },
      { player_id: seatedPlayerId, seat: 1, is_host: false },
    ]);
  });

  it("atomically finalizes results and removes the active roster", async () => {
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
    const roster = await pool.query("SELECT 1 FROM game_session_players WHERE game_id = $1", [
      gameId,
    ]);
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
    expect(roster.rowCount).toBe(0);
    expect(results.rows).toEqual([{ winner: "red", participants: 10, best_move_hits: 2 }]);
    expect(events.rows).toEqual([
      { sequence: 1, event_type: "game.created" },
      { sequence: 2, event_type: "game.finished" },
    ]);
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

      const clearing = store.clear(clearedGameId, 1);
      await waitForPlayerLockWaiter();
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
    await pool.query("UPDATE game_sessions SET updated_at = '2000-01-01T00:00:00Z'");
    const olderId = randomUUID();
    const newerId = randomUUID();
    const completedId = randomUUID();
    for (const [gameId, name] of [
      [olderId, "Older"],
      [newerId, "Newer"],
      [completedId, "Completed"],
    ] as const) {
      await store.save({
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
        WHERE id = ANY($4::uuid[])`,
      [olderId, newerId, completedId, [olderId, newerId, completedId]],
    );

    const active = await store.listActive();

    expect(active.slice(0, 2)).toEqual([
      expect.objectContaining({ gameId: newerId, name: "Newer", hostName: "Newer host" }),
      expect.objectContaining({ gameId: olderId, name: "Older", hostName: "Older host" }),
    ]);
    expect(active.some(({ gameId }) => gameId === completedId)).toBe(false);
  });
});
