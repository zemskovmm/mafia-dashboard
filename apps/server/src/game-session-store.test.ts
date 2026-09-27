import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { GameSessionStore } from "./game-session-store.js";
import { initializeSchema } from "./initialize-schema.js";

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
