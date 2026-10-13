import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";

export interface AppUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly picture: string | null;
}

export interface GoogleAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

export interface CompletedGoogleAuthorization {
  readonly user: AppUser;
  readonly sessionToken: string;
  readonly expiresAt: Date;
}

export const APPLICATION_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

const tokenResponse = z.object({
  access_token: z.string().min(1),
});

const userInfoResponse = z.object({
  sub: z.string().min(1),
  email: z.email(),
  email_verified: z.literal(true),
  name: z.string().trim().min(1),
  picture: z.url().optional(),
});

interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly display_name: string;
  readonly picture: string | null;
}

export interface GoogleAccountStore {
  upsertUser(identity: {
    readonly id: string;
    readonly subject: string;
    readonly email: string;
    readonly name: string;
    readonly picture: string | null;
  }): Promise<AppUser>;
  saveSession(userId: string, hash: Buffer, expiresAt: Date): Promise<void>;
  findSession(hash: Buffer, now: Date): Promise<AppUser | null>;
  removeSession(hash: Buffer): Promise<void>;
}
export type GoogleAuthPort = Pick<
  GoogleAuthService,
  | "configured"
  | "createAuthorizationUrl"
  | "completeAuthorization"
  | "getUserForSession"
  | "endSession"
>;

const mapUser = (row: UserRow): AppUser => ({
  id: row.id,
  email: row.email,
  name: row.display_name,
  picture: row.picture,
});

export class PostgresGoogleAccountStore implements GoogleAccountStore {
  public constructor(private readonly pool: Pool) {}
  public async upsertUser(
    identity: Parameters<GoogleAccountStore["upsertUser"]>[0],
  ): Promise<AppUser> {
    const result = await this.pool.query<UserRow>(
      `INSERT INTO users (id, google_subject, email, display_name, picture)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (google_subject) DO UPDATE
         SET email = EXCLUDED.email,
             display_name = EXCLUDED.display_name,
             picture = EXCLUDED.picture,
             updated_at = NOW()
       RETURNING id, email, display_name, picture`,
      [identity.id, identity.subject, identity.email, identity.name, identity.picture],
    );
    const user = result.rows[0];
    if (user === undefined) throw new Error("Google user could not be persisted");
    return mapUser(user);
  }
  public async saveSession(userId: string, hash: Buffer, expiresAt: Date): Promise<void> {
    await this.pool.query("DELETE FROM user_sessions WHERE expires_at <= NOW()");
    await this.pool.query(
      `INSERT INTO user_sessions (id, token_hash, user_id, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), hash, userId, expiresAt],
    );
  }
  public async findSession(hash: Buffer, now: Date): Promise<AppUser | null> {
    void now; // PostgreSQL uses its own database clock for expiry, preserving legacy behavior.
    const result = await this.pool.query<UserRow>(
      `SELECT app_user.id, app_user.email, app_user.display_name, app_user.picture
         FROM user_sessions AS session
         JOIN users AS app_user ON app_user.id = session.user_id
        WHERE session.token_hash = $1 AND session.expires_at > NOW()`,
      [hash],
    );
    return result.rows[0] === undefined ? null : mapUser(result.rows[0]);
  }
  public async removeSession(hash: Buffer): Promise<void> {
    await this.pool.query("DELETE FROM user_sessions WHERE token_hash = $1", [hash]);
  }
}

const sessionHash = (token: string): Buffer => createHash("sha256").update(token).digest();

const parseProviderResponse = async <Value>(
  response: Response,
  schema: z.ZodType<Value>,
  operation: string,
): Promise<Value> => {
  if (!response.ok) throw new Error(`Google ${operation} failed`);
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) throw new Error(`Google ${operation} returned an invalid response`);
  return parsed.data;
};

export class GoogleAuthService {
  public readonly configured = true;

  public constructor(
    poolOrStore: Pool | GoogleAccountStore,
    private readonly config: GoogleAuthConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.accounts =
      "query" in poolOrStore ? new PostgresGoogleAccountStore(poolOrStore) : poolOrStore;
  }
  private readonly accounts: GoogleAccountStore;

  public createAuthorizationUrl(state: string): string {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      include_granted_scopes: "true",
    }).toString();
    return url.toString();
  }

  public async completeAuthorization(code: string): Promise<CompletedGoogleAuthorization> {
    const token = await parseProviderResponse(
      await this.fetcher("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          redirect_uri: this.config.redirectUri,
          grant_type: "authorization_code",
        }),
      }),
      tokenResponse,
      "authorization-code exchange",
    );
    const profileResponse = await this.fetcher("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    if (!profileResponse.ok) throw new Error("Google user profile request failed");
    const rawProfile: unknown = await profileResponse.json();
    const profile = userInfoResponse.safeParse(rawProfile);
    if (!profile.success) {
      const unverified = z
        .object({ email: z.email().optional(), email_verified: z.boolean().optional() })
        .safeParse(rawProfile);
      if (unverified.success && unverified.data.email_verified === false) {
        throw new Error("A verified Google email is required");
      }
      throw new Error("Google user profile returned an invalid identity");
    }

    const user = await this.accounts.upsertUser({
      id: randomUUID(),
      subject: profile.data.sub,
      email: profile.data.email,
      name: profile.data.name,
      picture: profile.data.picture ?? null,
    });
    const sessionToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.now().getTime() + APPLICATION_SESSION_TTL_MS);
    await this.accounts.saveSession(user.id, sessionHash(sessionToken), expiresAt);
    return { user, sessionToken, expiresAt };
  }

  public async getUserForSession(token: string | null): Promise<AppUser | null> {
    if (token === null || token.length === 0) return null;
    return this.accounts.findSession(sessionHash(token), this.now());
  }

  public async endSession(token: string | null): Promise<void> {
    if (token === null || token.length === 0) return;
    await this.accounts.removeSession(sessionHash(token));
  }
}
