import { randomUUID } from "node:crypto";

import { expect } from "vitest";
import { buildApp } from "../app.js";
import { AzureAccountStore } from "../azure-account-store.js";
import { createAzureStores } from "../azure-stores.js";
import type { AppUser } from "../google-auth.js";

import { createStorageFixture } from "./storage-fixture.js";

export const createStatisticsApiFixture = async () => {
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
  const storageFixture = await createStorageFixture();
  const accounts = new AzureAccountStore(storageFixture.storage);
  for (const user of [owner, member]) await accounts.upsertUser({ ...user, subject: randomUUID() });
  const azure = createAzureStores(storageFixture.options);
  const stores = azure.stores;
  let actor: AppUser | null = owner;
  const app = await buildApp({ stores, authenticateRequest: async () => actor });
  await app.ready();
  return {
    app,
    stores,
    owner,
    member,

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
      await storageFixture.storage.mutate(async (tx) => {
        for (const row of await tx.list(`club:${clubId}:result:${gameId}:`))
          await tx.delete(row.rowKey);
      });
    },
    close: async () => {
      await app.close();
      await azure.end();
      await storageFixture.close();
    },
  };
};
