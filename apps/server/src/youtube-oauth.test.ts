import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { EventStore } from "./event-store.js";
import { YouTubeOAuthService } from "./youtube-oauth.js";

const config = {
  clientId: "client-id.apps.googleusercontent.com",
  clientSecret: "client-secret",
  redirectUri: "https://mbp16.tail102fab.ts.net/api/music/oauth/callback",
  encryptionKey: Buffer.alloc(32, 7),
};
const userId = "00000000-0000-4000-8000-000000000001";
const pool = new Pool({
  connectionString:
    process.env.TEST_DATABASE_URL ?? "postgresql://mafia:mafia@127.0.0.1:54329/mafia_test",
});

beforeAll(async () => {
  await new EventStore(pool).initialize();
});

afterAll(async () => {
  await pool.end();
});

describe("YouTubeOAuthService", () => {
  it("builds the least-privilege offline authorization URL", () => {
    const service = new YouTubeOAuthService(pool, config);

    const url = new URL(service.createAuthorizationUrl("state-value"));

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(config.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/youtube.readonly");
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("exchanges a code and stores encrypted offline credentials", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "access-token-secret",
            refresh_token: "refresh-token-secret",
            expires_in: 3600,
            scope: "https://www.googleapis.com/auth/youtube.readonly",
            token_type: "Bearer",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ snippet: { title: "Mafia Host" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const service = new YouTubeOAuthService(pool, config, fetcher as unknown as typeof fetch);
    await pool.query("DELETE FROM youtube_oauth_credentials");

    await service.exchangeCode(userId, "authorization-code");

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      expect.objectContaining({ headers: { authorization: "Bearer access-token-secret" } }),
    );
    await expect(service.getStatus(userId)).resolves.toEqual({
      configured: true,
      connected: true,
      accountLabel: "Mafia Host",
    });
    await expect(service.getStatus("00000000-0000-4000-8000-000000000002")).resolves.toEqual({
      configured: true,
      connected: false,
      accountLabel: null,
    });

    const stored = await pool.query<{
      access_token_encrypted: Buffer;
      refresh_token_encrypted: Buffer;
    }>(
      "SELECT access_token_encrypted, refresh_token_encrypted FROM youtube_oauth_credentials WHERE user_id = $1",
      [userId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]!.access_token_encrypted.toString()).not.toContain("access-token-secret");
    expect(stored.rows[0]!.refresh_token_encrypted.toString()).not.toContain(
      "refresh-token-secret",
    );
  });

  it("refreshes an expired token and returns every owned playlist page", async () => {
    const jsonResponse = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "expired-access-token",
          refresh_token: "offline-refresh-token",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/youtube.readonly",
          token_type: "Bearer",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ items: [{ snippet: { title: "Mafia Host" } }] }))
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "fresh-access-token",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/youtube.readonly",
          token_type: "Bearer",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          nextPageToken: "next-page",
          items: [
            {
              id: "PL-first",
              snippet: {
                title: "Dinner mix",
                thumbnails: { default: { url: "https://i.ytimg.com/first.jpg" } },
              },
              contentDetails: { itemCount: 12 },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              id: "PL-second",
              snippet: { title: "Late night", thumbnails: {} },
              contentDetails: { itemCount: 8 },
            },
          ],
        }),
      );
    const service = new YouTubeOAuthService(pool, config, fetcher as unknown as typeof fetch);
    await pool.query("DELETE FROM youtube_oauth_credentials");
    await service.exchangeCode(userId, "authorization-code");
    await pool.query(
      "UPDATE youtube_oauth_credentials SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_id = $1",
      [userId],
    );

    await expect(service.listPlaylists(userId)).resolves.toEqual([
      {
        id: "PL-first",
        title: "Dinner mix",
        itemCount: 12,
        thumbnailUrl: "https://i.ytimg.com/first.jpg",
      },
      { id: "PL-second", title: "Late night", itemCount: 8, thumbnailUrl: null },
    ]);

    const refreshCall = fetcher.mock.calls[2]!;
    expect(refreshCall[0]).toBe("https://oauth2.googleapis.com/token");
    expect(String((refreshCall[1] as RequestInit).body)).toContain(
      "refresh_token=offline-refresh-token",
    );
    expect(fetcher.mock.calls[3]![1]).toMatchObject({
      headers: { authorization: "Bearer fresh-access-token" },
    });
    expect(String(fetcher.mock.calls[4]![0])).toContain("pageToken=next-page");
  });

  it("returns every item in the supplied playlist order", async () => {
    const jsonResponse = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "queue-access-token",
          refresh_token: "queue-refresh-token",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/youtube.readonly",
          token_type: "Bearer",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ items: [{ snippet: { title: "Mafia Host" } }] }))
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              id: "PL-queue",
              snippet: { title: "Queue", thumbnails: {} },
              contentDetails: { itemCount: 2 },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          nextPageToken: "queue-page-2",
          items: [
            {
              snippet: {
                title: "Opening track",
                position: 0,
                resourceId: { videoId: "video-1" },
                thumbnails: { default: { url: "https://i.ytimg.com/video-1.jpg" } },
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              snippet: {
                title: "Second track",
                position: 1,
                resourceId: { videoId: "video-2" },
                thumbnails: {},
              },
            },
          ],
        }),
      );
    const service = new YouTubeOAuthService(pool, config, fetcher as unknown as typeof fetch);
    await pool.query("DELETE FROM youtube_oauth_credentials");
    await service.exchangeCode(userId, "authorization-code");

    await expect(service.listPlaylistItems(userId, "PL-queue")).resolves.toEqual([
      {
        videoId: "video-1",
        title: "Opening track",
        position: 0,
        thumbnailUrl: "https://i.ytimg.com/video-1.jpg",
      },
      { videoId: "video-2", title: "Second track", position: 1, thumbnailUrl: null },
    ]);

    expect(String(fetcher.mock.calls[2]![0])).toContain("mine=true");
    expect(String(fetcher.mock.calls[3]![0])).toContain("playlistId=PL-queue");
    expect(String(fetcher.mock.calls[4]![0])).toContain("pageToken=queue-page-2");
  });

  it("rejects playlist item lookup outside the connected account", async () => {
    const jsonResponse = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "owned-access-token",
          refresh_token: "owned-refresh-token",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/youtube.readonly",
          token_type: "Bearer",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ items: [{ snippet: { title: "Mafia Host" } }] }))
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              id: "PL-owned",
              snippet: { title: "Owned", thumbnails: {} },
              contentDetails: { itemCount: 1 },
            },
          ],
        }),
      );
    const service = new YouTubeOAuthService(pool, config, fetcher as unknown as typeof fetch);
    await pool.query("DELETE FROM youtube_oauth_credentials");
    await service.exchangeCode(userId, "authorization-code");

    await expect(service.listPlaylistItems(userId, "PL-other")).rejects.toMatchObject({
      name: "YouTubePlaylistAccessError",
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("bounds playlist item pagination", async () => {
    const jsonResponse = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    let itemPages = 0;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return jsonResponse({
          access_token: "bounded-access-token",
          refresh_token: "bounded-refresh-token",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/youtube.readonly",
          token_type: "Bearer",
        });
      }
      if (url.includes("/youtube/v3/channels")) {
        return jsonResponse({ items: [{ snippet: { title: "Mafia Host" } }] });
      }
      if (url.includes("/youtube/v3/playlists")) {
        return jsonResponse({
          items: [
            {
              id: "PL-owned",
              snippet: { title: "Owned", thumbnails: {} },
              contentDetails: { itemCount: 2000 },
            },
          ],
        });
      }
      itemPages += 1;
      return jsonResponse({
        nextPageToken: itemPages <= 20 ? `page-${itemPages + 1}` : undefined,
        items: [],
      });
    });
    const service = new YouTubeOAuthService(pool, config, fetcher as unknown as typeof fetch);
    await pool.query("DELETE FROM youtube_oauth_credentials");
    await service.exchangeCode(userId, "authorization-code");

    await expect(service.listPlaylistItems(userId, "PL-owned")).rejects.toThrow(
      "YouTube pagination limit exceeded",
    );
    expect(itemPages).toBe(20);
  });

  it("revokes the offline token before removing the connection", async () => {
    const jsonResponse = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "access-token",
          refresh_token: "refresh-token-to-revoke",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/youtube.readonly",
          token_type: "Bearer",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ items: [{ snippet: { title: "Mafia Host" } }] }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const service = new YouTubeOAuthService(pool, config, fetcher as unknown as typeof fetch);
    await pool.query("DELETE FROM youtube_oauth_credentials");
    await service.exchangeCode(userId, "authorization-code");

    await service.disconnect(userId);

    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      "https://oauth2.googleapis.com/revoke",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("token=refresh-token-to-revoke"),
      }),
    );
    await expect(service.getStatus(userId)).resolves.toEqual({
      configured: true,
      connected: false,
      accountLabel: null,
    });
  });
});
