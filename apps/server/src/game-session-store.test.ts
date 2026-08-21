import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { GameSessionStore } from "./game-session-store.js";
import { ClubStore } from "./club-store.js";

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

const createCompletedSession = async (gameId: string) => {
  const hostPlayerId = randomUUID();
  const playerIds = Array.from({ length: 10 }, () => randomUUID());
  const allIds = [hostPlayerId, ...playerIds];
  for (const [index, id] of allIds.entries()) {
    await pool.query("INSERT INTO players (id, nickname) VALUES ($1, $2)", [
      id,
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

describe("GameSessionStore", () => {
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

  it("returns the coherent current aggregate when an old mutation is retried after newer saves", async () => {
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
