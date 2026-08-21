import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { EventStore } from "./event-store.js";
import { DeletedGameError } from "./game-lifecycle.js";
import { GameSessionStore } from "./game-session-store.js";
import { PlayerStore } from "./player-store.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgresql://mafia:mafia@127.0.0.1:54329/mafia_test";
const pool = new Pool({ connectionString: databaseUrl });
const store = new PlayerStore(pool);

beforeAll(async () => {
  await store.initialize();
});

afterAll(async () => {
  await pool.end();
});

const nickname = (base: string) => `${base}-${randomUUID().slice(0, 8)}`;
const emptyHistoricalState = {
  setup: null,
  game: null,
  hostPlayerId: null,
  hostName: null,
  playlistId: "",
  log: [],
  undoHistory: [],
};

const waitForBlockedQuery = async (queryFragment: string): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND pid <> pg_backend_pid()
           AND wait_event_type = 'Lock'
           AND query LIKE $1
       ) AS blocked`,
      [`%${queryFragment}%`],
    );
    if (result.rows[0]?.blocked === true) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for blocked query: ${queryFragment}`);
};

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

describe("PlayerStore", () => {
  it("stores consent-safe profiles and rejects case-insensitive duplicate nicknames", async () => {
    const aliceNickname = nickname("Alice");
    const alice = await store.create({
      nickname: aliceNickname,
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    expect(alice).toMatchObject({
      nickname: aliceNickname,
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });

    const bob = await store.create({
      nickname: nickname("Bob"),
      consent: true,
      firstName: "Bob",
      lastName: "Player",
      email: "bob@example.test",
    });
    expect(bob).toMatchObject({
      consent: true,
      firstName: "Bob",
      lastName: "Player",
      email: "bob@example.test",
    });

    await expect(
      store.create({
        nickname: aliceNickname.toUpperCase(),
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
      }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("orders profiles by latest play time and then nickname", async () => {
    const never = await store.create({
      nickname: nickname("Zulu"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const older = await store.create({
      nickname: nickname("Alpha"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const newer = await store.create({
      nickname: nickname("Beta"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });

    await store.saveGameResults({
      gameId: randomUUID(),
      winner: "red",
      playedAt: new Date("2026-08-16T20:00:00.000Z"),
      players: [
        {
          playerId: older.id,
          seat: 1,
          role: "citizen",
          team: "red",
          status: "active",
          fouls: 1,
        },
      ],
    });
    await store.saveGameResults({
      gameId: randomUUID(),
      winner: "black",
      playedAt: new Date("2026-08-17T20:00:00.000Z"),
      players: [
        {
          playerId: newer.id,
          seat: 2,
          role: "mafia",
          team: "black",
          status: "active",
          fouls: 0,
        },
      ],
    });

    const orderedIds = (await store.list()).map(({ id }) => id);
    expect(orderedIds.indexOf(newer.id)).toBeLessThan(orderedIds.indexOf(older.id));
    expect(orderedIds.indexOf(older.id)).toBeLessThan(orderedIds.indexOf(never.id));
  });

  it("saves final results idempotently and aggregates player statistics", async () => {
    const player = await store.create({
      nickname: nickname("Stats"),
      consent: true,
      firstName: "Stat",
      lastName: "Player",
      email: "stats@example.test",
    });
    const gameId = randomUUID();
    const result = {
      gameId,
      winner: "red" as const,
      playedAt: new Date("2026-08-17T21:00:00.000Z"),
      players: [
        {
          playerId: player.id,
          seat: 4,
          role: "sheriff" as const,
          team: "red" as const,
          status: "eliminated" as const,
          fouls: 2,
          bestMoveHits: 2,
        },
      ],
    };

    await store.saveGameResults(result);
    await store.saveGameResults(result);

    const saved = (await store.list()).find(({ id }) => id === player.id);
    expect(saved?.statistics).toMatchObject({
      gamesPlayed: 1,
      wins: 1,
      losses: 0,
      redGames: 1,
      redWins: 1,
      blackGames: 0,
      blackWins: 0,
      sheriffGames: 1,
      citizenGames: 0,
      mafiaGames: 0,
      donGames: 0,
      totalFouls: 2,
      eliminations: 1,
      redCards: 0,
      bestMoves: 1,
      bestMoveMafiaHits: 2,
    });
    expect(saved?.lastPlayedAt?.toISOString()).toBe("2026-08-17T21:00:00.000Z");
  });

  it("tracks an idempotent host statistic without counting a played game", async () => {
    const host = await store.create({
      nickname: nickname("Host"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const participant = await store.create({
      nickname: nickname("Participant"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const result = {
      gameId: randomUUID(),
      hostPlayerId: host.id,
      winner: "red" as const,
      playedAt: new Date("2026-08-18T01:00:00.000Z"),
      players: [
        {
          playerId: participant.id,
          seat: 1,
          role: "citizen" as const,
          team: "red" as const,
          status: "active" as const,
          fouls: 0,
        },
      ],
    };

    await store.saveGameResults(result);
    await store.saveGameResults(result);

    const saved = await store.get(host.id);
    expect(saved?.statistics).toMatchObject({ hostedGames: 1, gamesPlayed: 0, wins: 0 });
    expect(saved?.lastPlayedAt?.toISOString()).toBe("2026-08-18T01:00:00.000Z");
  });

  it("retracts an undone final result and recomputes host and player statistics", async () => {
    const host = await store.create({
      nickname: nickname("Undo host"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const participant = await store.create({
      nickname: nickname("Undo participant"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const gameId = randomUUID();
    await store.saveGameResults({
      gameId,
      hostPlayerId: host.id,
      winner: "red",
      playedAt: new Date("2026-08-18T01:30:00.000Z"),
      players: [
        {
          playerId: participant.id,
          seat: 1,
          role: "citizen",
          team: "red",
          status: "active",
          fouls: 0,
        },
      ],
    });

    await store.deleteGameResults(gameId);

    await expect(store.get(host.id)).resolves.toMatchObject({
      lastPlayedAt: null,
      statistics: { hostedGames: 0, gamesPlayed: 0 },
    });
    await expect(store.get(participant.id)).resolves.toMatchObject({
      lastPlayedAt: null,
      statistics: { hostedGames: 0, gamesPlayed: 0 },
    });
    await expect(store.delete(host.id)).resolves.toBe("deleted");
    await expect(store.delete(participant.id)).resolves.toBe("deleted");
  });

  it("serializes result saves and retractions by game id", async () => {
    const participant = await store.create({
      nickname: nickname("Serialized Player"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const host = await store.create({
      nickname: nickname("Serialized Host"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const gameId = randomUUID();
    const input = {
      gameId,
      hostPlayerId: host.id,
      winner: "red" as const,
      playedAt: new Date("2026-08-17T22:00:00.000Z"),
      players: [
        {
          playerId: participant.id,
          seat: 1,
          role: "sheriff" as const,
          team: "red" as const,
          status: "active" as const,
          fouls: 0,
        },
      ],
    };
    const locker = await pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [gameId]);
      let saveSettled = false;
      const save = store.saveGameResults(input).finally(() => {
        saveSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(saveSettled).toBe(false);
      await locker.query("COMMIT");
      await save;

      await locker.query("BEGIN");
      await locker.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [gameId]);
      let deleteSettled = false;
      const deletion = store.deleteGameResults(gameId).finally(() => {
        deleteSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(deleteSettled).toBe(false);
      await locker.query("COMMIT");
      await deletion;
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
  });

  it("avoids the three-transaction event, result-retraction, and player-deletion deadlock", async () => {
    const player = await store.create({
      nickname: nickname("Three party deadlock"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const gameId = randomUUID();
    await store.saveGameResults({
      gameId,
      winner: "red",
      playedAt: new Date("2026-08-18T03:00:00.000Z"),
      players: [
        {
          playerId: player.id,
          seat: 1,
          role: "citizen",
          team: "red",
          status: "active",
          fouls: 0,
        },
      ],
    });

    const advisoryAcquired = deferred();
    const releaseRetraction = deferred();
    const retractionPool = new Pool({ connectionString: databaseUrl });
    const hookedPool = {
      connect: async () => {
        const client = await retractionPool.connect();
        const query = client.query.bind(client);
        client.query = (async (text: string, values?: unknown[]) => {
          const result = await query(text, values);
          if (text.includes("pg_advisory_xact_lock")) {
            advisoryAcquired.resolve();
            await releaseRetraction.promise;
          }
          return result;
        }) as typeof client.query;
        return client;
      },
    } as Pool;

    const retraction = new PlayerStore(hookedPool).deleteGameResults(gameId);
    await advisoryAcquired.promise;

    const append = new EventStore(pool).append({
      gameId,
      idempotencyKey: randomUUID(),
      type: "turn.started",
      phase: "day",
      seat: 1,
      payload: { seat: 1, seconds: 60 },
      secret: false,
    });
    await waitForBlockedQuery("SELECT pg_advisory_xact_lock");

    const deletion = store.delete(player.id);
    await waitForBlockedQuery("LOCK TABLE game_results, game_player_results, game_events");
    releaseRetraction.resolve();

    await expect(Promise.all([retraction, append, deletion])).resolves.toBeDefined();
    await retractionPool.end();
  });

  it("serializes aggregate saves before deleting the same historical session", async () => {
    const player = await store.create({
      nickname: nickname("Aggregate deletion lock"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const gameId = randomUUID();
    const previousMutationId = randomUUID();
    await pool.query(
      `INSERT INTO game_sessions
         (id, name, revision, last_mutation_id, status, state, results, updated_at)
       VALUES ($1, $2, 1, $3, 'completed', $4::jsonb, NULL, NOW())`,
      [gameId, "Historical aggregate", previousMutationId, JSON.stringify(emptyHistoricalState)],
    );
    await pool.query(
      "INSERT INTO game_results (game_id, winner, played_at) VALUES ($1, 'red', NOW())",
      [gameId],
    );
    await pool.query(
      `INSERT INTO game_player_results
         (game_id, player_id, seat, role, team, final_status, fouls, won)
       VALUES ($1, $2, 1, 'citizen', 'red', 'active', 0, TRUE)`,
      [gameId, player.id],
    );

    const operationPool = new Pool({
      connectionString: databaseUrl,
      application_name: `aggregate-delete-${gameId}`,
      options: "-c deadlock_timeout=50ms",
    });
    const locker = await pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT id FROM players WHERE id = $1 FOR UPDATE", [player.id]);
      const deletion = new PlayerStore(operationPool).delete(player.id);
      await waitForBlockedQuery("SELECT id FROM players WHERE id = $1 AND club_id = $2 FOR UPDATE");

      const save = new GameSessionStore(operationPool).save({
        gameId,
        name: "Historical aggregate",
        mutationId: randomUUID(),
        baseRevision: 1,
        state: emptyHistoricalState,
        results: null,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      await locker.query("COMMIT");

      const [deletionOutcome, saveOutcome] = await Promise.allSettled([deletion, save]);
      expect(deletionOutcome).toEqual({ status: "fulfilled", value: "deleted" });
      expect(saveOutcome.status).toBe("rejected");
      if (saveOutcome.status === "rejected") {
        expect(saveOutcome.reason).toBeInstanceOf(DeletedGameError);
      }
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
      await operationPool.end();
      await pool.query("DELETE FROM game_sessions WHERE id = $1", [gameId]);
      await pool.query("DELETE FROM game_results WHERE game_id = $1", [gameId]);
      await pool.query("DELETE FROM deleted_games WHERE game_id = $1", [gameId]);
      await pool.query("DELETE FROM players WHERE id = $1", [player.id]);
    }
  });

  it("recalculates last-played ordering when a finalized roster is corrected", async () => {
    const original = await store.create({
      nickname: nickname("Original"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const replacement = await store.create({
      nickname: nickname("Replacement"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const gameId = randomUUID();
    const common = {
      gameId,
      winner: "red" as const,
      playedAt: new Date("2026-08-17T23:00:00.000Z"),
    };
    await store.saveGameResults({
      ...common,
      players: [
        {
          playerId: original.id,
          seat: 1,
          role: "citizen",
          team: "red",
          status: "active",
          fouls: 0,
        },
      ],
    });
    await store.saveGameResults({
      ...common,
      players: [
        {
          playerId: replacement.id,
          seat: 1,
          role: "citizen",
          team: "red",
          status: "active",
          fouls: 0,
        },
      ],
    });

    const profiles = await store.list();
    expect(profiles.find(({ id }) => id === original.id)?.lastPlayedAt).toBeNull();
    expect(profiles.find(({ id }) => id === replacement.id)?.lastPlayedAt?.toISOString()).toBe(
      "2026-08-17T23:00:00.000Z",
    );
  });

  it("rejects deleting a player referenced by an unfinalized persisted setup roster", async () => {
    const player = await store.create({
      nickname: nickname("Active roster"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const gameId = randomUUID();
    await new GameSessionStore(pool).save({
      gameId,
      name: "Active roster",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: {
        setup: {
          step: "players",
          hostPlayerId: "",
          selectedPlayerIds: [player.id, ...Array.from({ length: 9 }, () => "")],
          setup: null,
        },
        game: null,
        hostPlayerId: null,
        hostName: null,
        playlistId: "",
        log: [],
        undoHistory: [],
      },
      results: null,
    });

    await expect(store.delete(player.id)).resolves.toBe("active_game");
    await expect(store.get(player.id)).resolves.toMatchObject({ id: player.id });
    await expect(new GameSessionStore(pool).get(gameId)).resolves.toMatchObject({ gameId });
  });

  it("rejects deleting a host referenced by an unfinalized persisted setup roster", async () => {
    const host = await store.create({
      nickname: nickname("Active host"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const gameId = randomUUID();
    await new GameSessionStore(pool).save({
      gameId,
      name: "Active host",
      mutationId: randomUUID(),
      baseRevision: 0,
      state: {
        setup: {
          step: "players",
          hostPlayerId: host.id,
          selectedPlayerIds: Array.from({ length: 10 }, () => ""),
          setup: null,
        },
        game: null,
        hostPlayerId: host.id,
        hostName: host.nickname,
        playlistId: "",
        log: [],
        undoHistory: [],
      },
      results: null,
    });

    await expect(store.delete(host.id)).resolves.toBe("active_game");
    await expect(store.get(host.id)).resolves.toMatchObject({ id: host.id });
    await expect(new GameSessionStore(pool).get(gameId)).resolves.toMatchObject({ gameId });
  });

  it("deletes a player with associated game history and recomputes affected profiles", async () => {
    const player = await store.create({
      nickname: nickname("Delete history"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const host = await store.create({
      nickname: nickname("Delete history host"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const peer = await store.create({
      nickname: nickname("Delete history peer"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const gameId = randomUUID();
    await store.saveGameResults({
      gameId,
      hostPlayerId: host.id,
      winner: "red",
      playedAt: new Date("2026-08-18T00:00:00.000Z"),
      players: [
        {
          playerId: player.id,
          seat: 1,
          role: "citizen",
          team: "red",
          status: "active",
          fouls: 0,
        },
        {
          playerId: peer.id,
          seat: 2,
          role: "sheriff",
          team: "red",
          status: "active",
          fouls: 1,
        },
      ],
    });
    await pool.query(
      `INSERT INTO game_sessions (id, name, revision, last_mutation_id, state, status)
       VALUES ($1, 'Historical aggregate', 1, $2, $3::jsonb, 'completed')`,
      [
        gameId,
        randomUUID(),
        JSON.stringify({ ...emptyHistoricalState, game: { phase: "finished" } }),
      ],
    );
    await pool.query(
      `INSERT INTO game_events
         (id, game_id, sequence, idempotency_key, event_type, phase, payload)
       VALUES ($1, $2, 1, $3, 'setup.players-selected', 'setup-players', $4::jsonb)`,
      [
        randomUUID(),
        gameId,
        randomUUID(),
        JSON.stringify({
          hostPlayerId: host.id,
          players: [{ id: player.id, name: player.nickname, seat: 1 }],
        }),
      ],
    );

    await expect(store.delete(player.id)).resolves.toBe("deleted");
    await expect(store.get(player.id)).resolves.toBeNull();
    await expect(store.get(host.id)).resolves.toMatchObject({
      lastPlayedAt: null,
      statistics: { hostedGames: 0, gamesPlayed: 0 },
    });
    await expect(store.get(peer.id)).resolves.toMatchObject({
      lastPlayedAt: null,
      statistics: { gamesPlayed: 0, wins: 0, totalFouls: 0 },
    });
    await expect(
      pool.query<{ count: number }>(
        `SELECT (
           (SELECT COUNT(*) FROM game_results WHERE game_id = $1) +
           (SELECT COUNT(*) FROM game_events WHERE game_id = $1) +
           (SELECT COUNT(*) FROM game_sessions WHERE id = $1)
         )::int AS count`,
        [gameId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(store.delete(player.id)).resolves.toBe("not_found");
  });

  it("rejects an event append that resumes after player history deletion", async () => {
    const player = await store.create({
      nickname: nickname("Delete event race"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const host = await store.create({
      nickname: nickname("Delete event race host"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const gameId = randomUUID();
    await store.saveGameResults({
      gameId,
      hostPlayerId: host.id,
      winner: "red",
      playedAt: new Date("2026-08-18T01:00:00.000Z"),
      players: [
        {
          playerId: player.id,
          seat: 1,
          role: "citizen",
          team: "red",
          status: "active",
          fouls: 0,
        },
      ],
    });

    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE game_events IN ACCESS EXCLUSIVE MODE");

      const deletion = store.delete(player.id);
      await waitForBlockedQuery("LOCK TABLE game_results, game_player_results, game_events");

      const appendOutcome = new EventStore(pool)
        .append({
          gameId,
          idempotencyKey: randomUUID(),
          type: "turn.started",
          phase: "day",
          seat: 1,
          payload: { seat: 1, seconds: 60 },
          secret: false,
        })
        .then(
          () => "appended" as const,
          () => "rejected" as const,
        );
      await waitForBlockedQuery("LOCK TABLE game_events IN ROW EXCLUSIVE MODE");

      await blocker.query("COMMIT");
      await expect(deletion).resolves.toBe("deleted");
      await expect(appendOutcome).resolves.toBe("rejected");
      await expect(
        pool.query<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM game_events WHERE game_id = $1",
          [gameId],
        ),
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
  });

  it("rejects a result save that resumes after player history deletion", async () => {
    const player = await store.create({
      nickname: nickname("Delete result race"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const host = await store.create({
      nickname: nickname("Delete result race host"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const replacement = await store.create({
      nickname: nickname("Delete result race replacement"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const gameId = randomUUID();
    const commonResult = {
      gameId,
      hostPlayerId: host.id,
      winner: "red" as const,
      playedAt: new Date("2026-08-18T02:00:00.000Z"),
    };
    await store.saveGameResults({
      ...commonResult,
      players: [
        {
          playerId: player.id,
          seat: 1,
          role: "citizen",
          team: "red",
          status: "active",
          fouls: 0,
        },
      ],
    });

    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE game_results IN ACCESS EXCLUSIVE MODE");

      const deletion = store.delete(player.id);
      await waitForBlockedQuery("LOCK TABLE game_results, game_player_results, game_events");

      const saveOutcome = store
        .saveGameResults({
          ...commonResult,
          players: [
            {
              playerId: replacement.id,
              seat: 1,
              role: "sheriff",
              team: "red",
              status: "active",
              fouls: 0,
            },
          ],
        })
        .then(
          () => "saved" as const,
          () => "rejected" as const,
        );
      await waitForBlockedQuery(
        "LOCK TABLE game_results, game_player_results IN ROW EXCLUSIVE MODE",
      );

      await blocker.query("COMMIT");
      await expect(deletion).resolves.toBe("deleted");
      await expect(saveOutcome).resolves.toBe("rejected");
      await expect(
        pool.query<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM game_results WHERE game_id = $1",
          [gameId],
        ),
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
  });

  it("clears finalized results while tombstoning the aggregate", async () => {
    const host = await store.create({
      nickname: nickname("Tombstoned result host"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const participant = await store.create({
      nickname: nickname("Tombstoned result player"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const gameId = randomUUID();
    await store.saveGameResults({
      gameId,
      hostPlayerId: host.id,
      winner: "red",
      playedAt: new Date("2026-08-18T03:00:00.000Z"),
      players: [
        {
          playerId: participant.id,
          seat: 1,
          role: "citizen",
          team: "red",
          status: "active",
          fouls: 0,
        },
      ],
    });
    await new GameSessionStore(pool).clear(gameId);

    await expect(store.deleteGameResults(gameId)).rejects.toMatchObject({ code: "game_deleted" });
    await expect(
      pool.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM game_results WHERE game_id = $1",
        [gameId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(store.get(host.id)).resolves.toMatchObject({
      lastPlayedAt: null,
      statistics: { hostedGames: 0, gamesPlayed: 0 },
    });
    await expect(store.get(participant.id)).resolves.toMatchObject({
      lastPlayedAt: null,
      statistics: { hostedGames: 0, gamesPlayed: 0 },
    });
  });
});
