import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { buildApp } from "./app.js";
import { DEFAULT_CLUB_ID } from "./club-store.js";
import { initializeSchema } from "./initialize-schema.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgresql://mafia@127.0.0.1:54329/mafia_test";
const schemaName = `whole_snapshot_save_${randomUUID().replaceAll("-", "")}`;
const schemaPool = new Pool({ connectionString: databaseUrl });
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  await schemaPool.query(`CREATE SCHEMA ${schemaName}`);
  await initializeSchema(pool);
  app = await buildApp({
    pool,
    defaultClubId: DEFAULT_CLUB_ID,
    authenticateRequest: async () => ({
      id: "00000000-0000-4000-8000-000000000001",
      email: "owner@mafiamalaga.es",
      name: "Owner",
      picture: null,
    }),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await schemaPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await schemaPool.end();
});

describe("whole snapshot save", () => {
  it("creates once then persists opaque browser snapshots through PUT", async () => {
    const creation = await app.inject({
      method: "POST",
      url: "/api/game-sessions",
      headers: { "x-club-id": DEFAULT_CLUB_ID },
      payload: {
        creationId: randomUUID(),
        name: "UI",
        state: { setup: { transient: true } },
        results: null,
      },
    });
    expect(creation.statusCode).toBe(201);
    const gameId = creation.json().gameId as string;
    const saved = await app.inject({
      method: "PUT",
      url: `/api/game-sessions/${gameId}`,
      headers: { "x-club-id": DEFAULT_CLUB_ID },
      payload: {
        kind: "snapshot",
        name: "UI saved",
        mutationId: randomUUID(),
        state: { game: { phase: "client-only" }, replay: { notVerified: true } },
        results: null,
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({
      name: "UI saved",
      state: { replay: { notVerified: true } },
    });
  });
});
