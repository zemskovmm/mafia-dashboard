import type { Pool } from "pg";
import { EventStore } from "./event-store.js";
import { GameSessionStore } from "./game-session-store.js";
import { PlayerStore } from "./player-store.js";
import { ClubStore } from "./club-store.js";

export interface ApplicationStores {
  readonly events: Pick<EventStore, "read">;
  readonly games: Pick<
    GameSessionStore,
    "create" | "save" | "clear" | "get" | "listActive" | "listCompleted"
  >;
  readonly players: Pick<PlayerStore, "list" | "get" | "create" | "update" | "delete">;
  readonly clubs: Pick<
    ClubStore,
    "listForUser" | "getRole" | "isMember" | "create" | "claimClubAccess" | "update" | "delete"
  > & { resumeDeletion?(userId: string, clubId: string): Promise<boolean> };
  ready(): Promise<void>;
  runAuthorized?<T>(
    userId: string,
    clubId: string,
    manager: boolean,
    work: () => Promise<T>,
  ): Promise<T>;
}

export const createPostgresStores = (pool: Pool): ApplicationStores => ({
  events: new EventStore(pool),
  games: new GameSessionStore(pool),
  players: new PlayerStore(pool),
  clubs: new ClubStore(pool),
  async ready() {
    await pool.query("SELECT 1");
  },
});

export type { AzureStorageOptions } from "./azure-storage.js";
