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

const mapUser = (row: UserRow): AppUser => ({
  id: row.id,
  email: row.email,
  name: row.display_name,
  picture: row.picture,
});

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
    private readonly pool: Pool,
    private readonly config: GoogleAuthConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

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

    const userId = randomUUID();
    const userResult = await this.pool.query<UserRow>(
      `INSERT INTO users (id, google_subject, email, display_name, picture)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (google_subject) DO UPDATE
         SET email = EXCLUDED.email,
             display_name = EXCLUDED.display_name,
             picture = EXCLUDED.picture,
             updated_at = NOW()
       RETURNING id, email, display_name, picture`,
      [
        userId,
        profile.data.sub,
        profile.data.email,
        profile.data.name,
        profile.data.picture ?? null,
      ],
    );
    const user = userResult.rows[0];
    if (user === undefined) throw new Error("Google user could not be persisted");

    const sessionToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.now().getTime() + APPLICATION_SESSION_TTL_MS);
    await this.pool.query("DELETE FROM user_sessions WHERE expires_at <= NOW()");
    await this.pool.query(
      `INSERT INTO user_sessions (id, token_hash, user_id, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), sessionHash(sessionToken), user.id, expiresAt],
    );
    return { user: mapUser(user), sessionToken, expiresAt };
  }

  public async getUserForSession(token: string | null): Promise<AppUser | null> {
    if (token === null || token.length === 0) return null;
    const result = await this.pool.query<UserRow>(
      `SELECT app_user.id, app_user.email, app_user.display_name, app_user.picture
         FROM user_sessions AS session
         JOIN users AS app_user ON app_user.id = session.user_id
        WHERE session.token_hash = $1 AND session.expires_at > NOW()`,
      [sessionHash(token)],
    );
    return result.rows[0] === undefined ? null : mapUser(result.rows[0]);
  }

  public async endSession(token: string | null): Promise<void> {
    if (token === null || token.length === 0) return;
    await this.pool.query("DELETE FROM user_sessions WHERE token_hash = $1", [sessionHash(token)]);
  }
}
