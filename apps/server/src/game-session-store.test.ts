import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { GameSessionStore } from "./game-session-store.js";
import { initializeSchema } from "./initialize-schema.js";
import { DEFAULT_CLUB_ID } from "./club-store.js";
import { EventStore } from "./event-store.js";
import { PlayerStore } from "./player-store.js";
import { federationRecord } from "./test-helpers/federation-record.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgresql://mafia@127.0.0.1:54329/mafia_test";
const schemaName = `game_session_store_${randomUUID().replaceAll("-", "")}`;
const schemaPool = new Pool({ connectionString: databaseUrl });
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
const store = new GameSessionStore(pool);
const state = (value: string) => ({ clientSnapshot: value, game: { phase: "anything" } });

beforeAll(async () => {
  await schemaPool.query(`CREATE SCHEMA ${schemaName}`);
  await initializeSchema(pool);
});

afterEach(async () => {
  await pool.query(
    "TRUNCATE game_session_mutations, game_session_players, game_sessions, game_session_creations, game_events, game_player_results, game_results, deleted_games CASCADE",
  );
});

afterAll(async () => {
  await pool.end();
  await schemaPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await schemaPool.end();
});

describe("GameSessionStore server-backed records", () => {
  it.each(["red", "black"] as const)(
    "round-trips federation snapshots and a %s-team ruling without changing win projections",
    async (losingTeam) => {
      const fixture = federationRecord(losingTeam);
      const { state: initial, completedState, results, hostPlayerId, players, winner } = fixture;
      for (const id of [hostPlayerId, ...players.map(({ id }) => id)]) {
        await pool.query("INSERT INTO players (id, club_id, nickname) VALUES ($1, $2, $3)", [
          id,
          DEFAULT_CLUB_ID,
          id,
        ]);
      }
      const creationId = randomUUID();
      const created = await store.create({
        creationId,
        name: "Federation",
        state: initial,
        results: null,
      });
      expect(created.state).toEqual(initial);
      expect(created).toMatchObject({ status: "active", revision: 1, results: null });
      const resumed = new GameSessionStore(pool);
      expect((await resumed.get(created.gameId))?.state).toEqual(initial);
      expect(await resumed.listActive()).toContainEqual(
        expect.objectContaining({ gameId: created.gameId, phase: "voting" }),
      );
      const operation = {
        gameId: created.gameId,
        name: "Referee ruling",
        mutationId: randomUUID(),
        state: completedState,
        results,
      };
      const saved = await resumed.save(operation);
      expect(saved.state).toEqual(completedState);
      expect(saved.results).toEqual(results);
      expect(saved).toMatchObject({ status: "completed", revision: 2 });
      // Saves remain last-commit-wins: a repeated mutation advances revision,
      // but replaces derived rows instead of double-counting the win.
      const retried = await resumed.save(operation);
      expect(retried).toMatchObject({ revision: 3, duplicate: false });
      const creationRetry = await resumed.create({
        creationId,
        name: "Stale",
        state: {},
        results: null,
      });
      expect(creationRetry).toMatchObject({ gameId: created.gameId, revision: 3, duplicate: true });
      expect(creationRetry.state).toEqual(completedState);
      expect(creationRetry.results).toEqual(results);
      const loaded = await new GameSessionStore(pool).get(created.gameId);
      expect(loaded?.state).toEqual(completedState);
      expect(loaded?.results).toEqual(results);
      const raw = (
        await pool.query("SELECT state, results FROM game_sessions WHERE id = $1", [created.gameId])
      ).rows[0];
      expect(raw).toEqual({ state: completedState, results });
      const projection = (
        await pool.query("SELECT outcome, winner, reason FROM game_results WHERE game_id = $1", [
          created.gameId,
        ])
      ).rows;
      expect(projection).toEqual([{ outcome: winner, winner, reason: null }]);
      const playerRows = (
        await pool.query(
          "SELECT player_id, seat, final_status, won FROM game_player_results WHERE game_id = $1 ORDER BY seat",
          [created.gameId],
        )
      ).rows;
      expect(playerRows).toEqual(
        players.map(({ id, seat, status, team }) => ({
          player_id: id,
          seat,
          final_status: status,
          won: team === winner,
        })),
      );
      const directory = new PlayerStore(pool);
      for (const player of players) {
        expect((await directory.get(player.id))?.statistics).toMatchObject({
          gamesPlayed: 1,
          wins: player.team === winner ? 1 : 0,
          losses: player.team === winner ? 0 : 1,
          redWins: player.team === "red" && winner === "red" ? 1 : 0,
          blackWins: player.team === "black" && winner === "black" ? 1 : 0,
          eliminations: 0,
          redCards: 0,
        });
      }
      expect((await directory.get(hostPlayerId))?.statistics).toMatchObject({
        hostedGames: 1,
        gamesPlayed: 0,
      });
      expect(await resumed.listActive()).toEqual([]);
      expect(await resumed.listCompleted()).toEqual([
        expect.objectContaining({
          gameId: created.gameId,
          winner,
          outcome: winner,
          reason: null,
          eventCount: 2,
        }),
      ]);
      const eventView = await new EventStore(pool).read(created.gameId);
      expect(eventView).toHaveLength(2);
      expect(eventView.every(({ replayVersion }) => replayVersion === 1)).toBe(true);
      expect(completedState.initialGame.replayVersion).toBe(2);
      expect(completedState.events.every(({ replayVersion }) => replayVersion === 2)).toBe(true);
      expect(loaded?.state.events).toEqual(completedState.events);

      const completedCreation = await resumed.create({
        creationId: randomUUID(),
        name: "Created completed",
        state: completedState,
        results,
      });
      expect(completedCreation.results).toEqual(results);
      expect((await resumed.get(completedCreation.gameId))?.state).toEqual(completedState);
      expect((await resumed.get(completedCreation.gameId))?.results).toEqual(results);
      expect(
        (
          await pool.query("SELECT outcome, winner, reason FROM game_results WHERE game_id = $1", [
            completedCreation.gameId,
          ])
        ).rows,
      ).toEqual([{ outcome: winner, winner, reason: null }]);
    },
  );

  it("preserves discriminator-free legacy baselines across create, save and resume", async () => {
    const legacy = {
      game: { phase: "legacy-client-phase", marker: null },
      initialGame: { replayVersion: 1, game: { phase: "legacy-client-phase", marker: null } },
      events: [{ id: randomUUID(), replayVersion: 1, sequence: 1, payload: {} }],
      undoHistory: [{ phase: "legacy-client-phase" }],
    };
    const created = await store.create({
      creationId: randomUUID(),
      name: "Legacy",
      state: legacy,
      results: null,
    });
    const saved = await store.save({
      gameId: created.gameId,
      mutationId: randomUUID(),
      name: "Legacy",
      state: legacy,
      results: { winner: "red", reason: null },
    });
    expect(saved.state).toEqual(legacy);
    expect(saved.results).toEqual({ winner: "red", reason: null });
    const loaded = await new GameSessionStore(pool).get(created.gameId);
    expect(loaded?.state).toEqual(legacy);
    expect(loaded?.results).not.toHaveProperty("adjudication");
    expect(loaded?.state.initialGame).not.toHaveProperty("rulesEdition");
    expect(loaded?.state.game).not.toHaveProperty("rulesEdition");
  });

  it("creates with a server GUID and returns the original record for an idempotent creation retry", async () => {
    const creationId = randomUUID();
    const first = await store.create({
      creationId,
      name: "First",
      state: state("first"),
      results: null,
    });
    const retry = await store.create({
      creationId,
      name: "Changed",
      state: state("changed"),
      results: null,
    });

    expect(first).toMatchObject({
      name: "First",
      revision: 1,
      duplicate: false,
      state: state("first"),
    });
    expect(retry).toMatchObject({ gameId: first.gameId, name: "First", duplicate: true });
  });

  it("permits several active records and makes every save an update-only last committed snapshot", async () => {
    const first = await store.create({
      creationId: randomUUID(),
      name: "A",
      state: state("a"),
      results: null,
    });
    const second = await store.create({
      creationId: randomUUID(),
      name: "B",
      state: state("b"),
      results: null,
    });
    await store.save({
      gameId: first.gameId,
      name: "Writer one",
      mutationId: randomUUID(),
      state: state("one"),
      results: null,
    });
    const final = await store.save({
      gameId: first.gameId,
      name: "Writer two",
      mutationId: randomUUID(),
      state: state("two"),
      results: null,
    });

    expect((await store.listActive()).map(({ gameId }) => gameId).sort()).toEqual(
      [first.gameId, second.gameId].sort(),
    );
    expect(final).toMatchObject({ revision: 3, name: "Writer two", state: state("two") });
  });

  it("rejects malformed adjudication before publishing or replacing an accepted snapshot", async () => {
    const creationId = randomUUID();
    const invalid = {
      adjudication: {
        losingTeam: "red",
        rule: "6.3.1",
        reason: "r".repeat(501),
        committeeApproved: false,
      },
    };
    await expect(
      store.create({ creationId, name: "Invalid", state: state("invalid"), results: invalid }),
    ).rejects.toMatchObject({ code: "invalid_game_adjudication" });
    expect((await pool.query("SELECT id FROM game_sessions")).rows).toEqual([]);
    expect((await pool.query("SELECT game_id FROM game_session_creations")).rows).toEqual([]);
    const accepted = await store.create({
      creationId,
      name: "Accepted",
      state: state("accepted"),
      results: null,
    });
    await expect(
      store.save({
        gameId: accepted.gameId,
        mutationId: randomUUID(),
        name: "Invalid",
        state: state("invalid"),
        results: invalid,
      }),
    ).rejects.toMatchObject({ code: "invalid_game_adjudication" });
    expect(await store.get(accepted.gameId)).toEqual(accepted);
  });

  it("keeps records club-scoped and never turns an update into an upsert", async () => {
    const otherClub = randomUUID();
    await pool.query(
      "INSERT INTO clubs (id, name, city, created_by) VALUES ($1, 'Other', 'Málaga', $2)",
      [otherClub, "00000000-0000-4000-8000-000000000001"],
    );
    const created = await store.create({
      creationId: randomUUID(),
      name: "Scoped",
      state: state("x"),
      results: null,
    });

    await expect(store.get(created.gameId, otherClub)).resolves.toBeNull();
    await expect(
      store.save({
        clubId: otherClub,
        gameId: created.gameId,
        name: "wrong club",
        mutationId: randomUUID(),
        state: state("wrong"),
        results: null,
      }),
    ).rejects.toMatchObject({ code: "game_session_not_found" });
  });
});
