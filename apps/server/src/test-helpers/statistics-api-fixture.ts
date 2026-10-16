import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expect } from "vitest";
import { buildApp } from "../app.js";
import { AzureAccountStore } from "../azure-account-store.js";
import { createAzureStores } from "../azure-stores.js";
import type { AppUser } from "../google-auth.js";
import { initializeSchema } from "../initialize-schema.js";
import { createPostgresStores } from "../storage-contracts.js";
import { createStorageFixture } from "./storage-fixture.js";

export const createStatisticsApiFixture = async (provider: "postgres" | "azure") => {
  let pool: Pool | undefined;
  let sqlOwner: Pool | undefined;
  let storageFixture: Awaited<ReturnType<typeof createStorageFixture>> | undefined;
  let azure: ReturnType<typeof createAzureStores> | undefined;
  const schema = `statistics_api_${randomUUID().replaceAll("-", "")}`;
  const owner: AppUser = {
    id: "00000000-0000-4000-8000-000000000001",
    email: "owner@mafiamalaga.es",
    name: "Mafia Malaga owner",
    picture: null,
  };
  const member: AppUser = {
    id: randomUUID(),
    email: `${randomUUID()}@example.test`,
    name: "Consented member",
    picture: null,
  };
  if (provider === "postgres") {
    const url = process.env.TEST_DATABASE_URL;
    if (url === undefined) throw new Error("Use the owned test:local wrapper for SQL fixtures");
    sqlOwner = new Pool({ connectionString: url });
    await sqlOwner.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
    await initializeSchema(pool);
    await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)", [
      member.id,
      member.email,
      member.name,
    ]);
  } else {
    storageFixture = await createStorageFixture();
    const accounts = new AzureAccountStore(storageFixture.storage);
    for (const user of [owner, member])
      await accounts.upsertUser({ ...user, subject: randomUUID() });
    azure = createAzureStores(storageFixture.options);
  }
  const stores = pool === undefined ? azure!.stores : createPostgresStores(pool);
  let actor: AppUser | null = owner;
  const app = await buildApp({ stores, authenticateRequest: async () => actor });
  await app.ready();
  return {
    app,
    stores,
    owner,
    member,
    pool,
    setActor: (value: AppUser | null) => {
      actor = value;
    },
    createClub: async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/clubs",
        payload: {
          name: `Statistics ${randomUUID()}`,
          city: "Fixture",
          language: "en",
          headerLogo: null,
          cardLogo: null,
          ownerConsent: true,
        },
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json().club.id as string;
    },
    removeProjection: async (clubId: string, gameId: string) => {
      if (pool !== undefined)
        await pool.query("DELETE FROM game_results WHERE club_id = $1 AND game_id = $2", [
          clubId,
          gameId,
        ]);
      else
        await storageFixture!.storage.mutate(async (tx) => {
          for (const row of await tx.list(`club:${clubId}:result:${gameId}:`))
            await tx.delete(row.rowKey);
        });
    },
    close: async () => {
      await app.close();
      await azure?.end();
      await storageFixture?.close();
      if (pool !== undefined) {
        await pool.end();
        await sqlOwner!.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await sqlOwner!.end();
      }
    },
  };
};
