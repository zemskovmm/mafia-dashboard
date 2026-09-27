import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { GameSessionStore } from "./game-session-store.js";
import { initializeSchema } from "./initialize-schema.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgresql://mafia@127.0.0.1:54329/mafia_test";
const schemaName = `game_records_invariants_${randomUUID().replaceAll("-", "")}`;
const schemaPool = new Pool({ connectionString: databaseUrl });
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
const store = new GameSessionStore(pool);

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

describe("game record invariants", () => {
  it("serializes competing saves with no revision or ownership fence", async () => {
    const created = await store.create({
      creationId: randomUUID(),
      name: "Race",
      state: { writer: "initial" },
      results: null,
    });
    const writes = await Promise.all(
      ["one", "two", "three"].map((writer) =>
        store.save({
          gameId: created.gameId,
          name: writer,
          mutationId: randomUUID(),
          state: { writer },
          results: null,
        }),
      ),
    );

    expect(writes.map(({ revision }) => revision).sort()).toEqual([2, 3, 4]);
    expect(await store.get(created.gameId)).toMatchObject({ revision: 4 });
  });

  it("makes deletion idempotent and keeps the creation mapping tombstoned", async () => {
    const creationId = randomUUID();
    const created = await store.create({
      creationId,
      name: "Delete",
      state: { local: true },
      results: null,
    });

    await Promise.all([
      store.clear({ gameId: created.gameId }),
      store
        .save({
          gameId: created.gameId,
          name: "late snapshot",
          mutationId: randomUUID(),
          state: { local: "late" },
          results: null,
        })
        .catch((error: unknown) => error),
    ]);
    await store.clear({ gameId: created.gameId });

    await expect(store.get(created.gameId)).resolves.toBeNull();
    await expect(
      store.create({ creationId, name: "retry", state: { local: "retry" }, results: null }),
    ).rejects.toMatchObject({ code: "game_deleted" });
  });
});
