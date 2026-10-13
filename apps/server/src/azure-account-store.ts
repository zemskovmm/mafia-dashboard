import type { AppUser, GoogleAccountStore } from "./google-auth.js";
import type { MusicCredential, YouTubeCredentialStore } from "./youtube-oauth.js";
import {
  digest,
  uuidKey,
  type AzureStorage,
  type AzureTransaction,
  type BlobReference,
} from "./azure-storage.js";

type UserRow = {
  id: string;
  email: string;
  name: string;
  picture?: string;
  createdAt: Date;
  updatedAt: Date;
};
type Reservation = { userId: string };
type SessionRow = { userId: string; expiresAt: Date };
type MusicRow = {
  accessTokenEncrypted?: Buffer;
  refreshTokenEncrypted?: Buffer;
  tokenBlobName?: string;
  tokenBlobSha256?: string;
  tokenBlobLength?: number;
  expiresAt: Date;
  accountLabel: string;
  scope?: string;
  createdAt: Date;
  updatedAt: Date;
};
const tokenBlob = (row: MusicRow): BlobReference | null => {
  if (row.tokenBlobName === undefined) return null;
  if (typeof row.tokenBlobSha256 !== "string" || typeof row.tokenBlobLength !== "number")
    throw new Error("Invalid encrypted token reference");
  return { name: row.tokenBlobName, sha256: row.tokenBlobSha256, length: row.tokenBlobLength };
};
const encryptedTokens = async (
  ctx: AzureTransaction,
  row: MusicRow,
): Promise<{ access: Buffer; refresh: Buffer }> => {
  const ref = tokenBlob(row);
  if (ref !== null) {
    const encoded = await ctx.readBlob<{ access: string; refresh: string }>(ref);
    if (typeof encoded.access !== "string" || typeof encoded.refresh !== "string")
      throw new Error("Invalid encrypted token Blob");
    return {
      access: Buffer.from(encoded.access, "base64"),
      refresh: Buffer.from(encoded.refresh, "base64"),
    };
  }
  if (
    !(row.accessTokenEncrypted instanceof Uint8Array) ||
    !(row.refreshTokenEncrypted instanceof Uint8Array)
  )
    throw new Error("Invalid encrypted music credential");
  return {
    access: Buffer.from(row.accessTokenEncrypted),
    refresh: Buffer.from(row.refreshTokenEncrypted),
  };
};
const tokenFields = async (
  ctx: AzureTransaction,
  access: Buffer,
  refresh: Buffer,
): Promise<object> => {
  if (access.length <= 65_536 && refresh.length <= 65_536)
    return { accessTokenEncrypted: access, refreshTokenEncrypted: refresh };
  const ref = await ctx.writeBlob(
    { access: access.toString("base64"), refresh: refresh.toString("base64") },
    "music",
  );
  return { tokenBlobName: ref.name, tokenBlobSha256: ref.sha256, tokenBlobLength: ref.length };
};
const userKey = (id: string) => `user:${uuidKey(id)}`;
const musicKey = (id: string) => `music:${uuidKey(id)}`;
const sessionKey = (hash: Buffer) => {
  if (hash.length !== 32) throw new Error("Invalid session digest");
  return `session:${hash.toString("hex")}`;
};
const userView = (row: UserRow): AppUser => ({
  id: row.id,
  email: row.email,
  name: row.name,
  picture: row.picture ?? null,
});

/** One engine transaction owns every reservation and account write. */
export class AzureAccountStore implements GoogleAccountStore, YouTubeCredentialStore {
  public constructor(private readonly storage: AzureStorage) {}

  public async upsertUser(
    identity: Parameters<GoogleAccountStore["upsertUser"]>[0],
  ): Promise<AppUser> {
    const incomingId = uuidKey(identity.id);
    if (!identity.subject || !identity.email || !identity.name)
      throw new Error("Incomplete verified Google identity");
    const subjectKey = `subject:${digest(identity.subject)}`;
    const emailKey = `email:${digest(identity.email)}`;
    return this.storage.mutate(async (ctx) => {
      const subject = await ctx.get<Reservation>(subjectKey);
      const id = subject === undefined ? incomingId : uuidKey(subject.userId);
      const previous = await ctx.get<UserRow>(userKey(id));
      if (
        (subject === undefined && previous !== undefined) ||
        (subject !== undefined && previous === undefined)
      ) {
        throw new Error("Conflicting Google account reservation");
      }
      const email = await ctx.get<Reservation>(emailKey);
      if (email !== undefined && uuidKey(email.userId) !== id)
        throw new Error("Email already belongs to another user");
      const now = new Date();
      const row: UserRow = {
        id,
        email: identity.email,
        name: identity.name,
        ...(identity.picture === null ? {} : { picture: identity.picture }),
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      if (previous !== undefined && previous.email !== identity.email) {
        const oldKey = `email:${digest(previous.email)}`;
        const old = await ctx.get<Reservation>(oldKey);
        if (old?.userId !== id) throw new Error("Conflicting prior email reservation");
        await ctx.delete(oldKey);
      }
      await ctx.set(userKey(id), row);
      if (subject === undefined) await ctx.set(subjectKey, { userId: id });
      if (email === undefined) await ctx.set(emailKey, { userId: id });
      return userView(row);
    });
  }

  public async saveSession(userId: string, hash: Buffer, expiresAt: Date): Promise<void> {
    const id = uuidKey(userId);
    if (!(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime()))
      throw new Error("Invalid session expiry");
    await this.storage.mutate(async (ctx) => {
      if ((await ctx.get<UserRow>(userKey(id))) === undefined)
        throw new Error("Session user not found");
      await ctx.set(sessionKey(hash), { userId: id, expiresAt });
    });
  }
  public async findSession(hash: Buffer, now: Date): Promise<AppUser | null> {
    return this.storage.read(async (ctx) => {
      const session = await ctx.get<SessionRow>(sessionKey(hash));
      if (
        session === undefined ||
        !(session.expiresAt instanceof Date) ||
        session.expiresAt.getTime() <= now.getTime()
      )
        return null;
      const user = await ctx.get<UserRow>(userKey(session.userId));
      return user === undefined ? null : userView(user);
    });
  }
  public async removeSession(hash: Buffer): Promise<void> {
    await this.storage.mutate(async (ctx) => {
      await ctx.delete(sessionKey(hash));
    });
  }

  public async putCredential(userId: string, credential: MusicCredential): Promise<void> {
    const key = musicKey(userId);
    await this.storage.mutate(async (ctx) => {
      const prior = await ctx.get<MusicRow>(key);
      const now = new Date();
      await ctx.set(key, {
        ...(await tokenFields(
          ctx,
          credential.accessTokenEncrypted,
          credential.refreshTokenEncrypted,
        )),
        expiresAt: credential.expiresAt,
        accountLabel: credential.accountLabel,
        ...(credential.scope === null ? {} : { scope: credential.scope }),
        createdAt: prior?.createdAt ?? now,
        updatedAt: now,
      });
      if (prior !== undefined) {
        const old = tokenBlob(prior);
        if (old !== null) await ctx.retireBlob(old);
      }
    });
  }
  public async getCredential(userId: string): Promise<MusicCredential | null> {
    return this.storage.read(async (ctx) => {
      const row = await ctx.get<MusicRow>(musicKey(userId));
      if (row === undefined) return null;
      if (!(row.expiresAt instanceof Date)) throw new Error("Invalid encrypted music credential");
      const tokens = await encryptedTokens(ctx, row);
      return {
        accessTokenEncrypted: tokens.access,
        refreshTokenEncrypted: tokens.refresh,
        expiresAt: row.expiresAt,
        accountLabel: row.accountLabel,
        scope: row.scope ?? null,
      };
    });
  }
  public async refreshCredential(
    userId: string,
    update: Parameters<YouTubeCredentialStore["refreshCredential"]>[1],
  ): Promise<void> {
    await this.storage.mutate(async (ctx) => {
      const key = musicKey(userId);
      const row = await ctx.get<MusicRow>(key);
      if (row === undefined) throw new Error("YouTube account is not connected");
      const tokens = await encryptedTokens(ctx, row);
      await ctx.set(key, {
        ...(await tokenFields(ctx, update.accessTokenEncrypted, tokens.refresh)),
        expiresAt: update.expiresAt,
        accountLabel: row.accountLabel,
        ...(update.scope === undefined
          ? row.scope === undefined
            ? {}
            : { scope: row.scope }
          : { scope: update.scope }),
        createdAt: row.createdAt,
        updatedAt: new Date(),
      });
      const old = tokenBlob(row);
      if (old !== null) await ctx.retireBlob(old);
    });
  }
  public async deleteCredential(userId: string): Promise<void> {
    await this.storage.mutate(async (ctx) => {
      const key = musicKey(userId);
      const row = await ctx.get<MusicRow>(key);
      await ctx.delete(key);
      if (row !== undefined) {
        const old = tokenBlob(row);
        if (old !== null) await ctx.retireBlob(old);
      }
    });
  }
}
