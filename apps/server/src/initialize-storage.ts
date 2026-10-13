import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { AzureStorage } from "./azure-storage.js";
import { loadConfig } from "./config.js";

/** Wait for newly assigned data roles, never repair unknown authoritative data. */
export async function initializeStorage(
  storage: AzureStorage,
  allowEmpty: boolean,
  { attempts = 24, pause = () => setTimeout(5000) } = {},
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await storage.initialize(allowEmpty);
      return;
    } catch (error) {
      const status =
        error !== null && typeof error === "object" && "statusCode" in error
          ? error.statusCode
          : undefined;
      if (attempt >= attempts || ![401, 403, 408, 429, 500, 502, 503, 504].includes(Number(status)))
        throw error;
      await pause();
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error("Unexpected arguments");
    const config = loadConfig();
    if (config.STORAGE_PROVIDER !== "azure" || config.azureStorage === undefined)
      throw new Error("Explicit Azure provider required");
    const storage = new AzureStorage(config.azureStorage);
    try {
      await initializeStorage(storage, config.AZURE_STORAGE_INITIALIZE);
      console.log("Authoritative Azure storage ready");
    } finally {
      await storage.end();
    }
  } catch {
    // SDK errors can contain credentials and request headers. Never dump them.
    console.error("Azure storage initialization/readiness failed; no reset attempted");
    process.exitCode = 1;
  }
}
