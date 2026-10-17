import type { ClubStatisticsSource, ClubTournament } from "@mafia/game-domain";
import type { Club, ClubInput, ClubRole } from "./club-store.js";
import type { GameEvent } from "./event-store.js";
import type {
  CompletedGameSessionFilters,
  CompletedGameSessionSummary,
  CreateGameSessionInput,
  GameSessionSummary,
  SaveGameSessionInput,
  StoredGameSession,
} from "./game-session-store.js";
import type { AppUser } from "./google-auth.js";
import type { PlayerProfile, PlayerProfileInput } from "./player-store.js";

/** Application-facing ports; no persistence implementation is needed for their types. */
export interface ApplicationStores {
  readonly events: {
    read(
      gameId: string,
      options?: { readonly includeSecrets: boolean },
      clubId?: string,
    ): Promise<readonly GameEvent[]>;
  };
  readonly games: {
    create(input: CreateGameSessionInput): Promise<StoredGameSession>;
    save(input: SaveGameSessionInput): Promise<StoredGameSession>;
    clear(input: { readonly clubId?: string; readonly gameId: string }): Promise<void>;
    get(gameId: string, clubId?: string): Promise<StoredGameSession | null>;
    listActive(clubId?: string): Promise<readonly GameSessionSummary[]>;
    listCompleted(
      clubId?: string,
      filters?: CompletedGameSessionFilters,
    ): Promise<readonly CompletedGameSessionSummary[]>;
    readStatisticsInputs(clubId?: string): Promise<ClubStatisticsSource>;
  };
  readonly tournaments: {
    list(clubId: string): Promise<readonly ClubTournament[]>;
    create(name: string, clubId: string): Promise<ClubTournament>;
    assign(gameId: string, tournamentId: string | null, clubId: string): Promise<string | null>;
  };
  readonly players: {
    list(clubId?: string): Promise<readonly PlayerProfile[]>;
    get(id: string, clubId?: string): Promise<PlayerProfile | null>;
    create(input: PlayerProfileInput, clubId?: string): Promise<PlayerProfile>;
    update(
      id: string,
      input: PlayerProfileInput,
      clubId: string,
      actorUserId: string,
    ): Promise<PlayerProfile | null>;
    delete(
      id: string,
      clubId?: string,
    ): Promise<"deleted" | "not_found" | "active_game" | "manager_locked">;
  };
  readonly clubs: {
    listForUser(userId: string): Promise<readonly Club[]>;
    getRole(userId: string, clubId: string): Promise<ClubRole | null>;
    isMember(userId: string, clubId: string): Promise<boolean>;
    create(userOrId: AppUser | string, input: ClubInput): Promise<Club>;
    claimClubAccess(userId: string, verifiedEmail: string): Promise<void>;
    update(
      userId: string,
      clubId: string,
      input: Omit<ClubInput, "ownerConsent">,
    ): Promise<Club | null>;
    delete(userId: string, clubId: string): Promise<boolean>;
    resumeDeletion?(userId: string, clubId: string): Promise<boolean>;
  };
  ready(): Promise<void>;
  runAuthorized?<T>(
    userId: string,
    clubId: string,
    manager: boolean,
    work: () => Promise<T>,
  ): Promise<T>;
}

export type { AzureStorageOptions } from "./azure-storage.js";
