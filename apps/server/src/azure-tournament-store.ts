import { randomUUID } from "node:crypto";
import type { ClubTournament } from "@mafia/game-domain";
import { type AzureStorage, uuidKey } from "./azure-storage.js";
import { GameSessionNotFoundError } from "./game-session-store.js";
import {
  azureListTournaments,
  azureTournament,
  gameTournamentKey,
  tournamentKey,
  tournamentName,
  tournamentNameKey,
} from "./tournament-metadata.js";

export class AzureTournamentStore {
  public constructor(private readonly storage: AzureStorage) {}
  public async list(clubId: string): Promise<readonly ClubTournament[]> {
    return this.storage.read(async (tx) =>
      (await tx.get(`deleted-club:${uuidKey(clubId)}`)) ? [] : azureListTournaments(tx, clubId),
    );
  }
  public async create(name: string, clubId: string): Promise<ClubTournament> {
    const normalized = tournamentName(name);
    return this.storage.mutate(async (tx) => {
      if (
        (await tx.get(`deleted-club:${uuidKey(clubId)}`)) ||
        !(await tx.get(`club:${uuidKey(clubId)}:meta`))
      )
        throw new Error("Club does not exist");
      const key = tournamentNameKey(clubId, normalized.nameKey);
      const existing = await tx.get<{ tournamentId: string }>(key);
      if (existing) return azureTournament(tx, clubId, existing.tournamentId);
      const item = { id: randomUUID(), name: normalized.name };
      await tx.set(tournamentKey(clubId, item.id), { ...item, nameKey: normalized.nameKey });
      await tx.set(key, { tournamentId: item.id });
      return item;
    });
  }
  public async assign(
    gameId: string,
    tournamentId: string | null,
    clubId: string,
  ): Promise<string | null> {
    return this.storage.mutate(async (tx) => {
      if (
        (await tx.get(`deleted-club:${uuidKey(clubId)}`)) ||
        !(await tx.get(`club:${uuidKey(clubId)}:game:${uuidKey(gameId)}`))
      )
        throw new GameSessionNotFoundError();
      const key = gameTournamentKey(clubId, gameId);
      if (tournamentId === null) {
        await tx.delete(key);
        return null;
      }
      const target = await azureTournament(tx, clubId, tournamentId);
      await tx.set(key, { gameId: uuidKey(gameId), tournamentId: target.id });
      return target.id;
    });
  }
}
