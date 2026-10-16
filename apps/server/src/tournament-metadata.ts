import {
  digest,
  uuidKey,
  StorageUnavailableError,
  type AzureTransaction,
} from "./azure-storage.js";
import type { ClubTournament } from "@mafia/game-domain";

export class TournamentNotFoundError extends Error {
  public readonly code = "tournament_not_found";
  public constructor() {
    super("The tournament does not exist in the selected club");
  }
}
export class InvalidTournamentNameError extends Error {
  public readonly code = "invalid_tournament_name";
  public constructor() {
    super("Tournament name must contain 1 to 100 characters");
  }
}
/** JS trim + locale-independent Unicode lowercase, identical on both providers. */
export const tournamentName = (name: string) => {
  const display = name.trim();
  if (!display || display.length > 100) throw new InvalidTournamentNameError();
  return { name: display, nameKey: display.toLowerCase() };
};
export const tournamentKey = (clubId: string, id: string) =>
  `club:${uuidKey(clubId)}:tournament:${uuidKey(id)}`;
export const tournamentNameKey = (clubId: string, key: string) =>
  `club:${uuidKey(clubId)}:tournament-name:${digest(key)}`;
export const gameTournamentKey = (clubId: string, gameId: string) =>
  `club:${uuidKey(clubId)}:game-tournament:${uuidKey(gameId)}`;
export const sortTournaments = (items: readonly ClubTournament[]): ClubTournament[] =>
  [...items].sort(
    (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id),
  );
export const azureTournament = async (tx: AzureTransaction, clubId: string, id: string) => {
  const row = await tx.get<ClubTournament>(tournamentKey(clubId, id));
  if (!row) throw new TournamentNotFoundError();
  if (
    row.id !== uuidKey(id) ||
    typeof row.name !== "string" ||
    tournamentName(row.name).name !== row.name
  )
    throw new StorageUnavailableError("Invalid tournament metadata");
  return { id: row.id, name: row.name };
};
export const azureGameTournament = async (
  tx: AzureTransaction,
  clubId: string,
  gameId: string,
): Promise<string | null> => {
  const link = await tx.get<{ tournamentId: string }>(gameTournamentKey(clubId, gameId));
  if (!link) return null;
  await azureTournament(tx, clubId, link.tournamentId);
  return uuidKey(link.tournamentId);
};
export const azureListTournaments = async (
  tx: AzureTransaction,
  clubId: string,
): Promise<readonly ClubTournament[]> => {
  const rows = await tx.list<ClubTournament>(`club:${uuidKey(clubId)}:tournament:`);
  const items: ClubTournament[] = [];
  for (const row of rows) items.push(await azureTournament(tx, clubId, row.id));
  return sortTournaments(items);
};
