import { randomUUID } from "node:crypto";
import type { AppUser } from "./google-auth.js";
import type { Club, ClubInput, ClubRole } from "./club-store.js";
import type { PlayerProfile, PlayerProfileInput, PlayerClubAccess } from "./player-store.js";
import {
  ClubAccessConsentRequiredError,
  ManagerLockedError,
  OwnerProfileForbiddenError,
} from "./player-store.js";
import { inspectGameIdentities } from "./game-session-identity.js";
import type { AzureStorage, AzureTransaction } from "./azure-storage.js";
import { blobReference, digest, uuidKey } from "./azure-storage.js";
import { DEFAULT_CLUB_ID } from "./club-store.js";

interface ClubRow {
  id: string;
  name: string;
  city: string;
  language: "en" | "ru";
  bestMoveEnabled: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  headerBlobName?: string;
  headerBlobSha256?: string;
  headerBlobLength?: number;
  cardBlobName?: string;
  cardBlobSha256?: string;
  cardBlobLength?: number;
}
interface MemberRow {
  userId: string;
  role: ClubRole;
  accessPlayerId?: string;
}
interface PlayerRow {
  id: string;
  nickname?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  userId?: string;
  clubAccess: PlayerClubAccess;
  consent: boolean;
  consentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  retiredAt?: Date;
}
interface UserRow {
  id: string;
  email: string;
  name: string;
  picture?: string;
  createdAt: Date;
  updatedAt: Date;
}
interface ResultRow {
  rowKey: string;
  gameId: string;
  playerId: string;
  isHost: boolean;
  playedAt: Date;
  outcome: string;
  winner?: string;
  role?: string;
  team?: string;
  status?: string;
  fouls?: number;
  won?: boolean;
  bestMoveHits?: number;
}

const clubPrefix = (clubId: string) => `club:${uuidKey(clubId)}:`;
const clubKey = (clubId: string) => `${clubPrefix(clubId)}meta`;
const memberKey = (clubId: string, userId: string) =>
  `${clubPrefix(clubId)}member:${uuidKey(userId)}`;
const playerKey = (clubId: string, playerId: string) =>
  `${clubPrefix(clubId)}player:${uuidKey(playerId)}`;
const nicknameKey = (clubId: string, nickname: string) =>
  `${clubPrefix(clubId)}nickname:${digest(nickname.trim().toLowerCase())}`;
const isDeleted = (tx: AzureTransaction, clubId: string) =>
  tx.get(`deleted-club:${uuidKey(clubId)}`);
const available = async (tx: AzureTransaction, clubId: string) =>
  !(await isDeleted(tx, clubId)) && !!(await tx.get(clubKey(clubId)));
const optional = (value: string | null) => value ?? undefined;
const checkViolation = (constraint: string): Error & { code: string; constraint: string } =>
  Object.assign(new Error(`new row violates check constraint ${constraint}`), {
    code: "23514",
    constraint,
  });
const validateProfileInput = (input: PlayerProfileInput) => {
  if (!input.nickname.trim()) throw checkViolation("players_nickname_check");
  if (input.consent) {
    if (!input.firstName?.trim() || !input.lastName?.trim() || !input.email?.trim())
      throw checkViolation("players_check");
  } else if (input.firstName !== null || input.lastName !== null || input.email !== null) {
    throw checkViolation("players_check");
  }
};
const normalized = (value: string) => value.trim().toLowerCase();
const unique = (constraint: string): Error & { code: string; constraint: string } =>
  Object.assign(new Error(`duplicate key value violates unique constraint ${constraint}`), {
    code: "23505",
    constraint,
  });
const saveLogo = async (
  tx: AzureTransaction,
  value: string | null,
  prefix: string,
  field: "header" | "card",
) => {
  if (value === null) return {};
  const ref = await tx.writeBlob(value, prefix);
  return field === "header"
    ? { headerBlobName: ref.name, headerBlobSha256: ref.sha256, headerBlobLength: ref.length }
    : { cardBlobName: ref.name, cardBlobSha256: ref.sha256, cardBlobLength: ref.length };
};
const splitName = (name: string): readonly [string, string] => {
  const trimmed = name.trim();
  const separator = trimmed.search(/\s/);
  return separator < 0
    ? [trimmed, trimmed]
    : [trimmed.slice(0, separator), trimmed.slice(separator).trim()];
};
const logoRef = (row: ClubRow, field: "header" | "card") => {
  const name = row[`${field}BlobName`];
  if (name === undefined) return null;
  return blobReference({
    blobName: name,
    blobSha256: row[`${field}BlobSha256`],
    blobLength: row[`${field}BlobLength`],
  });
};
const logo = async (tx: AzureTransaction, row: ClubRow, field: "header" | "card") => {
  const ref = logoRef(row, field);
  return ref ? tx.readBlob<string>(ref) : null;
};
const removeBlob = async (storage: AzureStorage, ref: NonNullable<ReturnType<typeof logoRef>>) => {
  try {
    await storage.deleteBlob(ref);
  } catch (error) {
    // A crash after deleting a blob but before publishing the Table chunk is
    // retried with the original row; only an absent blob is idempotent.
    if (!error || typeof error !== "object" || !("statusCode" in error) || error.statusCode !== 404)
      throw error;
  }
};

const mapClub = async (tx: AzureTransaction, row: ClubRow, role: ClubRole): Promise<Club> => ({
  id: row.id,
  name: row.name,
  city: row.city,
  headerLogo: await logo(tx, row, "header"),
  cardLogo: await logo(tx, row, "card"),
  language: row.language,
  bestMoveEnabled: row.bestMoveEnabled,
  role,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
const ownerLocked = (row: PlayerRow, club: ClubRow | undefined): boolean =>
  row.clubAccess === "manager" && row.userId !== undefined && row.userId === club?.createdBy;
const playerRows = (tx: AzureTransaction, clubId: string) =>
  tx.list<PlayerRow>(`${clubPrefix(clubId)}player:`);
const ensureUniquePlayer = async (
  tx: AzureTransaction,
  clubId: string,
  nickname: string,
  access: PlayerClubAccess,
  email: string | null,
  userId: string | undefined,
  excludeId?: string,
) => {
  const rows = await playerRows(tx, clubId);
  for (const row of rows) {
    if (row.id === excludeId || row.retiredAt) continue;
    if (normalized(row.nickname ?? "") === normalized(nickname))
      throw unique("players_club_nickname_unique_idx");
    if (
      access !== "none" &&
      email !== null &&
      row.clubAccess !== "none" &&
      row.email &&
      normalized(row.email) === normalized(email)
    )
      throw unique("players_club_access_email_unique_idx");
    if (userId && row.userId === userId) throw unique("players_club_linked_user_unique_idx");
  }
};
const matchingUser = async (
  tx: AzureTransaction,
  email: string | null,
  access: PlayerClubAccess,
): Promise<UserRow | undefined> => {
  if (email === null || access === "none") return undefined;
  const users = await tx.list<UserRow>("user:");
  return users
    .filter((user) => normalized(user.email) === normalized(email))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))[0];
};
const updateLinkedMember = async (
  tx: AzureTransaction,
  clubId: string,
  id: string,
  formerId: string | undefined,
  linkedId: string | undefined,
  role: ClubRole | "none",
) => {
  if (formerId && formerId !== linkedId) {
    const key = memberKey(clubId, formerId);
    const member = await tx.get<MemberRow>(key);
    if (member?.accessPlayerId === id) await tx.delete(key);
  }
  if (!linkedId || role === "none") return;
  const key = memberKey(clubId, linkedId);
  const existing = await tx.get<MemberRow>(key);
  if (!existing) await tx.set(key, { userId: linkedId, role, accessPlayerId: id });
  else if (existing.accessPlayerId === id) await tx.set(key, { ...existing, role });
};

export class AzureClubStore {
  public constructor(private readonly storage: AzureStorage) {}

  public listForUser(userId: string): Promise<readonly Club[]> {
    return this.storage.read(async (tx) => {
      const memberships = await tx.list<MemberRow>("club:");
      const target = `:member:${uuidKey(userId)}`;
      const clubs: Club[] = [];
      for (const membership of memberships) {
        if (!membership.rowKey.endsWith(target)) continue;
        const clubId = membership.rowKey.slice(5, -target.length);
        if (await isDeleted(tx, clubId)) continue;
        const row = await tx.get<ClubRow>(clubKey(clubId));
        if (row) clubs.push(await mapClub(tx, row, membership.role));
      }
      return clubs.sort(
        (a, b) =>
          a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id),
      );
    });
  }

  public async isMember(userId: string, clubId: string): Promise<boolean> {
    return (await this.getRole(userId, clubId)) !== null;
  }

  public getRole(userId: string, clubId: string): Promise<ClubRole | null> {
    return this.storage.read(async (tx) => {
      if (!(await available(tx, clubId))) return null;
      return (await tx.get<MemberRow>(memberKey(clubId, userId)))?.role ?? null;
    });
  }

  public create(userOrId: AppUser | string, input: ClubInput): Promise<Club> {
    const clubId = randomUUID();
    const ownerId = randomUUID();
    return this.storage.mutate(async (tx) => {
      const user = await tx.get<UserRow>(
        `user:${uuidKey(typeof userOrId === "string" ? userOrId : userOrId.id)}`,
      );
      if (!user) throw new Error("Club creator user was not found");
      const now = new Date();
      const [firstName, lastName] = splitName(user.name);
      const row: ClubRow = {
        id: clubId,
        name: input.name.trim(),
        city: input.city.trim(),
        language: input.language,
        bestMoveEnabled: input.bestMoveEnabled ?? true,
        createdBy: user.id,
        createdAt: now,
        updatedAt: now,
        ...(await saveLogo(tx, input.headerLogo, `club/${uuidKey(clubId)}/header`, "header")),
        ...(await saveLogo(tx, input.cardLogo, `club/${uuidKey(clubId)}/card`, "card")),
      };
      await tx.set(clubKey(clubId), row);
      await tx.set(memberKey(clubId, user.id), { userId: user.id, role: "manager" });
      await tx.set(playerKey(clubId, ownerId), {
        id: ownerId,
        nickname: "Owner",
        firstName,
        lastName,
        email: user.email,
        userId: user.id,
        clubAccess: "manager",
        consent: true,
        consentAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await tx.set(nicknameKey(clubId, "Owner"), { playerId: ownerId });
      return mapClub(tx, row, "manager");
    });
  }
  public update(
    userId: string,
    clubId: string,
    input: Omit<ClubInput, "ownerConsent">,
  ): Promise<Club | null> {
    return this.storage.mutate(async (tx) => {
      if (!(await available(tx, clubId))) return null;
      const member = await tx.get<MemberRow>(memberKey(clubId, userId));
      if (member?.role !== "manager") return null;
      const previous = (await tx.get<ClubRow>(clubKey(clubId)))!;
      const row: ClubRow = {
        id: previous.id,
        name: input.name.trim(),
        city: input.city.trim(),
        language: input.language,
        bestMoveEnabled: input.bestMoveEnabled ?? previous.bestMoveEnabled,
        createdBy: previous.createdBy,
        createdAt: previous.createdAt,
        updatedAt: new Date(),
        ...(await saveLogo(tx, input.headerLogo, `club/${uuidKey(clubId)}/header`, "header")),
        ...(await saveLogo(tx, input.cardLogo, `club/${uuidKey(clubId)}/card`, "card")),
      };
      await tx.set(clubKey(clubId), row);
      for (const field of ["header", "card"] as const) {
        const ref = logoRef(previous, field);
        if (ref) await tx.retireBlob(ref);
      }
      return mapClub(tx, row, "manager");
    });
  }

  public claimClubAccess(userId: string, verifiedEmail: string): Promise<void> {
    return this.storage.mutate(async (tx) => {
      const account = await tx.get<UserRow>(`user:${uuidKey(userId)}`);
      if (!account) {
        throw Object.assign(new Error("Club access user was not found"), {
          code: "23503",
          constraint: "players_user_fk",
        });
      }
      // One commit for every affected profile and membership: never accept a prefix.
      const players = await tx.list<PlayerRow>("club:");
      const matches = players
        .filter(
          (row) =>
            row.rowKey.includes(":player:") &&
            row.clubAccess !== "none" &&
            row.email &&
            normalized(row.email) === normalized(verifiedEmail),
        )
        .sort((a, b) => a.rowKey.localeCompare(b.rowKey));
      for (const row of matches) {
        const clubId = row.rowKey.slice(5).split(":", 1)[0]!;
        if (
          !(await available(tx, clubId)) ||
          (row.userId && uuidKey(row.userId) !== uuidKey(account.id))
        )
          continue;
        if (!row.userId)
          await tx.set(row.rowKey, {
            ...row,
            userId: account.id,
            updatedAt: new Date(),
          });
        await updateLinkedMember(tx, clubId, row.id, undefined, account.id, row.clubAccess);
      }
    });
  }

  public async resumeDeletion(userId: string, clubId: string): Promise<boolean> {
    const allowed = await this.storage.read(
      async (tx) =>
        (await tx.get<{ userId: string }>(`deleted-club:${uuidKey(clubId)}`))?.userId ===
        uuidKey(userId),
    );
    return allowed ? this.delete(userId, clubId) : false;
  }

  public async delete(userId: string, clubId: string): Promise<boolean> {
    const tombstoneKey = `deleted-club:${uuidKey(clubId)}`;
    const actor = uuidKey(userId);
    const permitted = await this.storage.mutate(async (tx) => {
      const tombstone = await tx.get<{ userId: string }>(tombstoneKey);
      if (tombstone) return tombstone.userId === actor;
      const member = await tx.get<MemberRow>(memberKey(clubId, actor));
      if (member?.role !== "manager" || !(await tx.get<ClubRow>(clubKey(clubId)))) return false;
      await tx.set(tombstoneKey, { userId: actor, deletedAt: new Date() });
      return true;
    });
    if (!permitted) return false;
    return this.storage.withMaintenanceFreeze(async () => {
      // The marker hides every endpoint before the first physical purge. Re-entry
      // is authorized by its durable actor even after the membership was removed.
      for (;;) {
        const purged = await this.storage.mutate(async (tx) => {
          const marker = await tx.get<{ userId: string }>(tombstoneKey);
          if (marker?.userId !== actor) return false;
          const rows = (await tx.list<Record<string, unknown>>(clubPrefix(clubId))).slice(0, 80);
          if (rows.length === 0) return false;
          for (const row of rows) {
            const refs = row.rowKey.endsWith(":meta")
              ? [
                  logoRef(row as unknown as ClubRow, "header"),
                  logoRef(row as unknown as ClubRow, "card"),
                ].filter((ref) => ref !== null)
              : row.rowKey.includes(":game:")
                ? [blobReference(row)]
                : [];
            for (const ref of refs) await removeBlob(this.storage, ref);
            await tx.delete(row.rowKey);
          }
          return true;
        });
        if (!purged) break;
      }
      // Superseded immutable assets live in the global cleanup family, not in
      // the club family. Only the exact club purpose path belongs to this purge.
      const ownedPurpose = `/club/${uuidKey(clubId)}/`;
      for (;;) {
        const purged = await this.storage.mutate(async (tx) => {
          const marker = await tx.get<{ userId: string }>(tombstoneKey);
          if (marker?.userId !== actor) return false;
          const rows = (
            await tx.list<{ blobName: string; blobSha256: string; blobLength: number }>("cleanup:")
          )
            .filter((row) => row.blobName.toLowerCase().includes(ownedPurpose))
            .slice(0, 80);
          if (rows.length === 0) return false;
          for (const row of rows) {
            await removeBlob(this.storage, blobReference(row));
            await tx.delete(row.rowKey);
          }
          return true;
        });
        if (!purged) break;
      }
      return this.storage.read(async (tx) => {
        const marker = await tx.get<{ userId: string }>(tombstoneKey);
        return (
          marker?.userId === actor &&
          (await tx.list(clubPrefix(clubId))).length === 0 &&
          !(await tx.list<{ blobName: string }>("cleanup:")).some((row) =>
            row.blobName.toLowerCase().includes(ownedPurpose),
          )
        );
      });
    });
  }
}

const statisticsFor = (results: readonly ResultRow[]) => {
  const participants = results.filter((r) => !r.isHost);
  const count = (test: (row: ResultRow) => boolean) => participants.filter(test).length;
  return {
    hostedGames: results.filter((r) => r.isHost && r.outcome !== "cancelled").length,
    gamesPlayed: participants.length,
    wins: count((r) => r.won === true),
    losses: count((r) => r.won === false),
    redGames: count((r) => r.team === "red"),
    redWins: count((r) => r.team === "red" && r.won === true),
    blackGames: count((r) => r.team === "black"),
    blackWins: count((r) => r.team === "black" && r.won === true),
    sheriffGames: count((r) => r.role === "sheriff"),
    citizenGames: count((r) => r.role === "citizen"),
    mafiaGames: count((r) => r.role === "mafia"),
    donGames: count((r) => r.role === "don"),
    totalFouls: participants.reduce((n, r) => n + (r.fouls ?? 0), 0),
    eliminations: count((r) => r.status === "eliminated"),
    redCards: count((r) => r.status === "red-carded"),
    bestMoves: count((r) => r.bestMoveHits !== undefined),
    bestMoveMafiaHits: participants.reduce((n, r) => n + (r.bestMoveHits ?? 0), 0),
  };
};

export class AzurePlayerStore {
  public constructor(private readonly storage: AzureStorage) {}
  public async initialize(): Promise<void> {
    /* AzureStorage owns schema initialization. */
  }

  private async profiles(tx: AzureTransaction, clubId: string): Promise<PlayerProfile[]> {
    if (!(await available(tx, clubId))) return [];
    const club = await tx.get<ClubRow>(clubKey(clubId));
    const rows = await playerRows(tx, clubId);
    // Scan the result family once; retain anonymous retired result rows for surviving peers.
    const results = await tx.list<ResultRow>(`${clubPrefix(clubId)}result:`);
    const byPlayer = new Map<string, ResultRow[]>();
    for (const result of results) {
      const key = uuidKey(result.playerId);
      const group = byPlayer.get(key) ?? [];
      group.push(result);
      byPlayer.set(key, group);
    }
    return rows
      .filter((row) => !row.retiredAt)
      .map((row) => {
        const own = byPlayer.get(uuidKey(row.id)) ?? [];
        const played = own.reduce<Date | null>(
          (latest, r) => (!latest || r.playedAt > latest ? r.playedAt : latest),
          null,
        );
        return {
          id: row.id,
          nickname: row.nickname!,
          firstName: row.firstName ?? null,
          lastName: row.lastName ?? null,
          email: row.email ?? null,
          consent: row.consent,
          clubAccess: row.clubAccess,
          managerLocked: ownerLocked(row, club),
          consentAt: row.consentAt ?? null,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          lastPlayedAt: played,
          statistics: statisticsFor(own),
        };
      })
      .sort(
        (a, b) =>
          (b.lastPlayedAt?.getTime() ?? -Infinity) - (a.lastPlayedAt?.getTime() ?? -Infinity) ||
          a.nickname.toLowerCase().localeCompare(b.nickname.toLowerCase()) ||
          a.id.localeCompare(b.id),
      );
  }

  public list(clubId = DEFAULT_CLUB_ID): Promise<readonly PlayerProfile[]> {
    return this.storage.read((tx) => this.profiles(tx, clubId));
  }

  public get(id: string, clubId = DEFAULT_CLUB_ID): Promise<PlayerProfile | null> {
    return this.storage.read(
      async (tx) =>
        (await this.profiles(tx, clubId)).find((row) => uuidKey(row.id) === uuidKey(id)) ?? null,
    );
  }

  public async create(input: PlayerProfileInput, clubId = DEFAULT_CLUB_ID): Promise<PlayerProfile> {
    const id = randomUUID();
    await this.storage.mutate(async (tx) => {
      validateProfileInput(input);
      if (!(await available(tx, clubId))) throw new Error("Club was not found");
      const clubAccess = input.clubAccess ?? "none";
      if (clubAccess !== "none" && !input.consent) throw new ClubAccessConsentRequiredError();
      const linked = await matchingUser(tx, input.email, clubAccess);
      await ensureUniquePlayer(tx, clubId, input.nickname, clubAccess, input.email, linked?.id);
      const now = new Date();
      const row: PlayerRow = {
        id,
        nickname: input.nickname.trim(),
        firstName: optional(input.firstName),
        lastName: optional(input.lastName),
        email: optional(input.email),
        userId: linked?.id,
        clubAccess,
        consent: input.consent,
        consentAt: input.consent ? now : undefined,
        createdAt: now,
        updatedAt: now,
      };
      await tx.set(playerKey(clubId, id), row);
      await tx.set(nicknameKey(clubId, input.nickname), { playerId: id });
      await updateLinkedMember(tx, clubId, id, undefined, linked?.id, clubAccess);
    });
    const profile = await this.get(id, clubId);
    if (!profile) throw new Error("Created player was not found");
    return profile;
  }

  public async update(
    id: string,
    input: PlayerProfileInput,
    clubId: string,
    actorUserId: string,
  ): Promise<PlayerProfile | null> {
    const updated = await this.storage.mutate(async (tx) => {
      if (!(await available(tx, clubId))) return false;
      const existing = await tx.get<PlayerRow>(playerKey(clubId, id));
      if (!existing || existing.retiredAt) return false;
      validateProfileInput(input);
      const club = await tx.get<ClubRow>(clubKey(clubId));
      const locked = ownerLocked(existing, club);
      const access = input.clubAccess ?? "none";
      if (locked && existing.userId !== actorUserId) throw new OwnerProfileForbiddenError();
      if (locked && access !== "manager") throw new ManagerLockedError();
      if (access !== "none" && !input.consent && !locked)
        throw new ClubAccessConsentRequiredError();
      const linked = locked ? existing.userId : (await matchingUser(tx, input.email, access))?.id;
      await ensureUniquePlayer(
        tx,
        clubId,
        input.nickname,
        access,
        input.email,
        linked,
        existing.id,
      );
      const oldNicknameKey = nicknameKey(clubId, existing.nickname!);
      const newNicknameKey = nicknameKey(clubId, input.nickname);
      if (oldNicknameKey !== newNicknameKey) {
        await tx.delete(oldNicknameKey);
        await tx.set(newNicknameKey, { playerId: existing.id });
      }
      await updateLinkedMember(tx, clubId, existing.id, existing.userId, linked, access);
      await tx.set(playerKey(clubId, id), {
        id: existing.id,
        nickname: input.nickname.trim(),
        firstName: optional(input.firstName),
        lastName: optional(input.lastName),
        email: optional(input.email),
        userId: linked,
        clubAccess: access,
        consent: input.consent,
        consentAt: input.consent ? (existing.consentAt ?? new Date()) : undefined,
        createdAt: existing.createdAt,
        updatedAt: new Date(),
      });
      return true;
    });
    return updated ? this.get(id, clubId) : null;
  }

  public delete(
    id: string,
    clubId = DEFAULT_CLUB_ID,
  ): Promise<"deleted" | "not_found" | "active_game" | "manager_locked"> {
    return this.storage.mutate(async (tx) => {
      if (!(await available(tx, clubId))) return "not_found" as const;
      const row = await tx.get<PlayerRow>(playerKey(clubId, id));
      if (!row || row.retiredAt) return "not_found" as const;
      if (ownerLocked(row, await tx.get<ClubRow>(clubKey(clubId))))
        return "manager_locked" as const;
      const games = await tx.list<{
        status: string;
        blobName: string;
        blobSha256: string;
        blobLength: number;
      }>(`${clubPrefix(clubId)}game:`);
      for (const game of games) {
        if (game.status !== "active") continue;
        const snapshot = await tx.readBlob<{ session: { state: unknown } }>(blobReference(game)!);
        if (
          [...inspectGameIdentities(snapshot.session.state, null).all].some(
            (referenceId) => uuidKey(referenceId) === uuidKey(row.id),
          )
        )
          return "active_game" as const;
      }
      if (row.userId) await updateLinkedMember(tx, clubId, id, row.userId, undefined, "none");
      await tx.delete(nicknameKey(clubId, row.nickname!));
      await tx.set(playerKey(clubId, id), {
        id: row.id,
        clubAccess: "none",
        consent: false,
        createdAt: row.createdAt,
        updatedAt: new Date(),
        retiredAt: new Date(),
      });
      return "deleted" as const;
    });
  }
}
