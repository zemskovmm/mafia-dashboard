import { randomUUID } from "node:crypto";
import { AzureStorage, type AzureStorageOptions } from "../azure-storage.js";
import { startAzurite } from "../../../../scripts/local-azurite.mjs";

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
