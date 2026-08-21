import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";

const YOUTUBE_READONLY_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
const MAX_YOUTUBE_PAGE_COUNT = 20;

export class YouTubePlaylistAccessError extends Error {
  public constructor(playlistId: string) {
    super(`Playlist ${playlistId} is not in the connected YouTube account`);
    this.name = "YouTubePlaylistAccessError";
  }
}

export interface YouTubeOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly encryptionKey: Buffer;
}

const accessTokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  scope: z.string().optional(),
  token_type: z.string(),
});

const authorizationTokenResponse = accessTokenResponse.extend({
  refresh_token: z.string().min(1),
});

const channelResponse = z.object({
  items: z.array(z.object({ snippet: z.object({ title: z.string().min(1) }) })).min(1),
});

const playlistPageResponse = z.object({
  nextPageToken: z.string().optional(),
  items: z.array(
    z.object({
      id: z.string().min(1),
      snippet: z.object({
        title: z.string(),
        thumbnails: z.object({ default: z.object({ url: z.string() }).optional() }).default({}),
      }),
      contentDetails: z.object({ itemCount: z.number().int().min(0) }),
    }),
  ),
});
const playlistItemPageResponse = z.object({
  nextPageToken: z.string().optional(),
  items: z.array(
    z.object({
      snippet: z.object({
        title: z.string(),
        position: z.number().int().min(0),
        resourceId: z.object({ videoId: z.string().min(1).optional() }),
        thumbnails: z.object({ default: z.object({ url: z.string() }).optional() }).default({}),
      }),
    }),
  ),
});

const encrypt = (plaintext: string, key: Buffer): Buffer => {
  const initializationVector = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, initializationVector);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), initializationVector, cipher.getAuthTag(), ciphertext]);
};

const decrypt = (payload: Buffer, key: Buffer): string => {
  if (payload[0] !== 1 || payload.length < 30) throw new Error("Unsupported encrypted token");
  const initializationVector = payload.subarray(1, 13);
  const authenticationTag = payload.subarray(13, 29);
  const ciphertext = payload.subarray(29);
  const decipher = createDecipheriv("aes-256-gcm", key, initializationVector);
  decipher.setAuthTag(authenticationTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
};

export interface YouTubePlaylist {
  readonly id: string;
  readonly title: string;
  readonly itemCount: number;
  readonly thumbnailUrl: string | null;
}

export interface YouTubePlaylistItem {
  readonly videoId: string;
  readonly title: string;
  readonly position: number;
  readonly thumbnailUrl: string | null;
}

export class YouTubeOAuthService {
  public constructor(
    private readonly pool: Pool,
    private readonly config: YouTubeOAuthConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  public createAuthorizationUrl(state: string): string {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      scope: YOUTUBE_READONLY_SCOPE,
      state,
      access_type: "offline",
      include_granted_scopes: "true",
      prompt: "consent",
    }).toString();
    return url.toString();
  }

  public async exchangeCode(userId: string, code: string): Promise<void> {
    const response = await this.fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: this.config.redirectUri,
        grant_type: "authorization_code",
      }),
    });
    if (!response.ok) throw new Error(`Google token exchange failed with HTTP ${response.status}`);
    const tokens = authorizationTokenResponse.parse(await response.json());

    const accountResponse = await this.fetcher(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      { headers: { authorization: `Bearer ${tokens.access_token}` } },
    );
    if (!accountResponse.ok) {
      throw new Error(`YouTube channel lookup failed with HTTP ${accountResponse.status}`);
    }
    const account = channelResponse.parse(await accountResponse.json());
    await this.pool.query(
      `INSERT INTO youtube_oauth_credentials
         (user_id, singleton, access_token_encrypted, refresh_token_encrypted, expires_at, account_label, scope)
       VALUES ($1, TRUE, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE
         SET access_token_encrypted = EXCLUDED.access_token_encrypted,
             refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
             expires_at = EXCLUDED.expires_at,
             account_label = EXCLUDED.account_label,
             scope = EXCLUDED.scope,
             updated_at = NOW()`,
      [
        userId,
        encrypt(tokens.access_token, this.config.encryptionKey),
        encrypt(tokens.refresh_token, this.config.encryptionKey),
        new Date(Date.now() + tokens.expires_in * 1_000),
        account.items[0]!.snippet.title,
        tokens.scope,
      ],
    );
  }

  public async getStatus(userId: string): Promise<{
    readonly configured: true;
    readonly connected: boolean;
    readonly accountLabel: string | null;
  }> {
    const result = await this.pool.query<{ account_label: string }>(
      "SELECT account_label FROM youtube_oauth_credentials WHERE user_id = $1",
      [userId],
    );
    return {
      configured: true,
      connected: result.rowCount === 1,
      accountLabel: result.rows[0]?.account_label ?? null,
    };
  }

  public async listPlaylists(userId: string): Promise<readonly YouTubePlaylist[]> {
    const accessToken = await this.getAccessToken(userId);
    const playlists: YouTubePlaylist[] = [];
    let pageToken: string | undefined;
    let pageCount = 0;
    do {
      if (pageCount >= MAX_YOUTUBE_PAGE_COUNT) {
        throw new Error("YouTube pagination limit exceeded");
      }
      pageCount += 1;
      const url = new URL("https://www.googleapis.com/youtube/v3/playlists");
      url.search = new URLSearchParams({
        part: "snippet,contentDetails",
        mine: "true",
        maxResults: "50",
        ...(pageToken === undefined ? {} : { pageToken }),
      }).toString();
      const response = await this.fetcher(url.toString(), {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok)
        throw new Error(`YouTube playlist lookup failed with HTTP ${response.status}`);
      const page = playlistPageResponse.parse(await response.json());
      playlists.push(
        ...page.items.map((playlist) => ({
          id: playlist.id,
          title: playlist.snippet.title,
          itemCount: playlist.contentDetails.itemCount,
          thumbnailUrl: playlist.snippet.thumbnails.default?.url ?? null,
        })),
      );
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);
    return playlists;
  }

  public async listPlaylistItems(
    userId: string,
    playlistId: string,
  ): Promise<readonly YouTubePlaylistItem[]> {
    const ownedPlaylists = await this.listPlaylists(userId);
    if (!ownedPlaylists.some(({ id }) => id === playlistId)) {
      throw new YouTubePlaylistAccessError(playlistId);
    }
    const accessToken = await this.getAccessToken(userId);
    const items: YouTubePlaylistItem[] = [];
    let pageToken: string | undefined;
    let pageCount = 0;
    do {
      if (pageCount >= MAX_YOUTUBE_PAGE_COUNT) {
        throw new Error("YouTube pagination limit exceeded");
      }
      pageCount += 1;
      const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
      url.search = new URLSearchParams({
        part: "snippet",
        playlistId,
        maxResults: "50",
        ...(pageToken === undefined ? {} : { pageToken }),
      }).toString();
      const response = await this.fetcher(url.toString(), {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok)
        throw new Error(`YouTube playlist item lookup failed with HTTP ${response.status}`);
      const page = playlistItemPageResponse.parse(await response.json());
      items.push(
        ...page.items.flatMap(({ snippet }) =>
          snippet.resourceId.videoId === undefined
            ? []
            : [
                {
                  videoId: snippet.resourceId.videoId,
                  title: snippet.title,
                  position: snippet.position,
                  thumbnailUrl: snippet.thumbnails.default?.url ?? null,
                },
              ],
        ),
      );
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);
    return items.sort((left, right) => left.position - right.position);
  }

  public async disconnect(userId: string): Promise<void> {
    const result = await this.pool.query<{ refresh_token_encrypted: Buffer }>(
      "SELECT refresh_token_encrypted FROM youtube_oauth_credentials WHERE user_id = $1",
      [userId],
    );
    const credentials = result.rows[0];
    if (credentials === undefined) return;
    const response = await this.fetcher("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: decrypt(credentials.refresh_token_encrypted, this.config.encryptionKey),
      }).toString(),
    });
    if (!response.ok)
      throw new Error(`Google token revocation failed with HTTP ${response.status}`);
    await this.pool.query("DELETE FROM youtube_oauth_credentials WHERE user_id = $1", [userId]);
  }

  private async getAccessToken(userId: string): Promise<string> {
    const result = await this.pool.query<{
      access_token_encrypted: Buffer;
      refresh_token_encrypted: Buffer;
      expires_at: Date;
    }>(
      `SELECT access_token_encrypted, refresh_token_encrypted, expires_at
         FROM youtube_oauth_credentials
        WHERE user_id = $1`,
      [userId],
    );
    const credentials = result.rows[0];
    if (credentials === undefined) throw new Error("YouTube account is not connected");
    if (credentials.expires_at.getTime() > Date.now() + 60_000) {
      return decrypt(credentials.access_token_encrypted, this.config.encryptionKey);
    }

    const response = await this.fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: decrypt(credentials.refresh_token_encrypted, this.config.encryptionKey),
        grant_type: "refresh_token",
      }),
    });
    if (!response.ok) throw new Error(`Google token refresh failed with HTTP ${response.status}`);
    const tokens = accessTokenResponse.parse(await response.json());
    await this.pool.query(
      `UPDATE youtube_oauth_credentials
          SET access_token_encrypted = $1,
              expires_at = $2,
              scope = COALESCE($3, scope),
              updated_at = NOW()
        WHERE user_id = $4`,
      [
        encrypt(tokens.access_token, this.config.encryptionKey),
        new Date(Date.now() + tokens.expires_in * 1_000),
        tokens.scope ?? null,
        userId,
      ],
    );
    return tokens.access_token;
  }
}
