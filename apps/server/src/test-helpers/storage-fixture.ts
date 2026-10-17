import { randomUUID } from "node:crypto";
import { AzureStorage, type AzureStorageOptions } from "../azure-storage.js";
import { startAzurite } from "../../../../scripts/local-azurite.mjs";
import { AzureAccountStore } from "../azure-account-store.js";
import { createAzureStores } from "../azure-stores.js";
import { DEFAULT_CLUB_ID } from "../club-store.js";
import type { AppUser } from "../google-auth.js";

/** Own an isolated namespace; never adopt a production storage credential. */
export const createStorageFixture = async (): Promise<{
  readonly storage: AzureStorage;
  readonly options: AzureStorageOptions;
  close(): Promise<void>;
}> => {
  const emulator = await startAzurite({ mode: "test" });
  const suffix = randomUUID().replaceAll("-", "");
  const options: AzureStorageOptions = {
    connectionString: emulator.environment.AZURE_STORAGE_CONNECTION_STRING,
    tableName: `MafiaTest${suffix}`,
    containerName: `mafia-test-${suffix}`,
    partitionKey: `test-${suffix}`,
  };
  const storage = new AzureStorage(options);
  try {
    await storage.initialize(true);
  } catch (error) {
    await emulator.stop();
    throw error;
  }
  let closed = false;
  return {
    storage,
    options,
    close: async () => {
      if (closed) return;
      closed = true;
      await storage.end();
      await emulator.stop();
    },
  };
};

/** A real account and default club, seeded only in an owned test namespace. */
export const createApplicationStorageFixture = async (owner: AppUser) => {
  const fixture = await createStorageFixture();
  const azure = createAzureStores(fixture.options);
  const accounts = new AzureAccountStore(fixture.storage);
  try {
    await accounts.upsertUser({ ...owner, subject: randomUUID() });
    const now = new Date();
    const playerId = randomUUID();
    await fixture.storage.mutate(async (tx) => {
      await tx.set(`club:${DEFAULT_CLUB_ID}:meta`, {
        id: DEFAULT_CLUB_ID,
        name: "Mafia Malaga",
        city: "Málaga",
        language: "en",
        bestMoveEnabled: true,
        createdBy: owner.id,
        createdAt: now,
        updatedAt: now,
      });
      await tx.set(`club:${DEFAULT_CLUB_ID}:member:${owner.id}`, {
        userId: owner.id,
        role: "manager",
      });
      const [firstName, ...rest] = owner.name.split(" ");
      await tx.set(`club:${DEFAULT_CLUB_ID}:player:${playerId}`, {
        id: playerId,
        nickname: "Owner",
        userId: owner.id,
        clubAccess: "manager",
        consent: true,
        consentAt: now,
        firstName,
        lastName: rest.join(" ") || firstName,
        email: owner.email,
        createdAt: now,
        updatedAt: now,
      });
    });
    return {
      ...fixture,
      stores: azure.stores,
      accounts,
      close: async () => {
        await azure.end();
        await fixture.close();
      },
    };
  } catch (error) {
    await azure.end();
    await fixture.close();
    throw error;
  }
};
