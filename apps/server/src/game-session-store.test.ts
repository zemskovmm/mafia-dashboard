import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { GameSessionStore } from "./game-session-store.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgresql://mafia:mafia@127.0.0.1:54329/mafia_test";
const pool = new Pool({ connectionString: databaseUrl });
const store = new GameSessionStore(pool);

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
      })),
    },
  };
};

describe("GameSessionStore", () => {
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
    const results = await pool.query<{ winner: string; participants: number }>(
      `SELECT result.winner, COUNT(player_result.player_id)::int AS participants
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
    expect(results.rows).toEqual([{ winner: "red", participants: 10 }]);
    expect(events.rows).toEqual([
      { sequence: 1, event_type: "game.created" },
      { sequence: 2, event_type: "game.finished" },
    ]);
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
