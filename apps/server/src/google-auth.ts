import { createHash, randomBytes, randomUUID } from "node:crypto";
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
    private readonly accounts: GoogleAccountStore,
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
