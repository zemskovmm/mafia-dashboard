import { AzureStorage, type AzureStorageOptions } from "./azure-storage.js";
import { AzureAccountStore } from "./azure-account-store.js";
import { AzureClubStore, AzurePlayerStore } from "./azure-club-player-store.js";
import { AzureEventStore, AzureGameSessionStore } from "./azure-game-session-store.js";
import type { ApplicationStores } from "./storage-contracts.js";

/** Explicit Azure-only composition: no SQL connection, fallback or dual write. */
export const createAzureStores = (options: AzureStorageOptions) => {
  const storage = new AzureStorage(options);
  const accounts = new AzureAccountStore(storage);
  const stores: ApplicationStores = {
    clubs: new AzureClubStore(storage),
    players: new AzurePlayerStore(storage),
    games: new AzureGameSessionStore(storage),
    events: new AzureEventStore(storage),
    ready: () => storage.ready(),
    runAuthorized: (userId, clubId, manager, work) =>
      storage.runAuthorized(userId, clubId, manager, work),
  };
  return {
    stores,
    auth: accounts,
    music: accounts,
    initialize: () => storage.initialize(true),
    ready: () => storage.ready(),
    end: () => storage.end(),
  };
};
