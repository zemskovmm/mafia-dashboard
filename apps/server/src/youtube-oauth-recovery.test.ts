import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { buildApp } from "./app.js";
import { EventStore } from "./event-store.js";
import { YouTubeOAuthService } from "./youtube-oauth.js";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const user = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "owner@mafiamalaga.es",
  name: "Mafia host",
  picture: null,
};
const config = {
  clientId: "test-client",
  clientSecret: "test-secret",
  redirectUri: "https://example.test/api/music/oauth/callback",
  encryptionKey: Buffer.alloc(32, 7),
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const tokens = {
  access_token: "test-access",
  refresh_token: "test-refresh",
  expires_in: 3600,
  scope: "https://www.googleapis.com/auth/youtube.readonly",
  token_type: "Bearer",
};

beforeAll(async () => {
  await new EventStore(pool).initialize();
});
afterAll(async () => pool.end());

describe("YouTube authorization recovery through the music API", () => {
  it.each([
    [
      "revoked grant",
      400,
      { error: "invalid_grant", error_description: "private-provider-detail" },
      409,
    ],
    ["invalid client", 400, { error: "invalid_client" }, 500],
    ["quota failure", 429, { error: "invalid_grant" }, 500],
    ["provider outage", 503, { error: "invalid_grant" }, 500],
    ["malformed provider response", 400, "not-json", 500],
    ["network failure", 0, null, 500],
  ])(
    "handles %s without deleting credentials or leaking provider data",
    async (_label, status, body, expectedStatus) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json(tokens))
        .mockResolvedValueOnce(json({ items: [{ snippet: { title: "Test host" } }] }));
      const service = new YouTubeOAuthService(pool, config, fetcher);
      await service.exchangeCode(user.id, "test-code");
      await pool.query(
        "UPDATE youtube_oauth_credentials SET expires_at = '2000-01-01' WHERE user_id = $1",
        [user.id],
      );
      const before = await pool.query(
        "SELECT * FROM youtube_oauth_credentials WHERE user_id = $1",
        [user.id],
      );
      fetcher.mockImplementation(async () => {
        if (status === 0) throw new Error("private-network-detail");
        return body === "not-json"
          ? new Response("private-provider-detail", { status })
          : json(body, status);
      });
      const app = await buildApp({
        pool,
        youtubeOAuth: service,
        authenticateRequest: async () => user,
      });
      try {
        for (const url of ["/api/music/playlists", "/api/music/playlists/PL-test/items"]) {
          const response = await app.inject({ method: "GET", url });
          expect(response.statusCode).toBe(expectedStatus);
          expect(response.json()).toEqual({
            error: expectedStatus === 409 ? "youtube_reconnect_required" : "internal_server_error",
          });
          expect(response.headers["set-cookie"]).toBeUndefined();
        }
        const after = await pool.query(
          "SELECT * FROM youtube_oauth_credentials WHERE user_id = $1",
          [user.id],
        );
        expect(after.rows).toEqual(before.rows);
        // Reconnecting replaces the invalid token through the existing OAuth flow.
        if (expectedStatus === 409) {
          fetcher
            .mockReset()
            .mockResolvedValueOnce(json({ ...tokens, refresh_token: "replacement-refresh" }))
            .mockResolvedValueOnce(json({ items: [{ snippet: { title: "Test host" } }] }))
            .mockResolvedValueOnce(json({ items: [] }));
          await service.exchangeCode(user.id, "replacement-code");
          const recovered = await app.inject({ method: "GET", url: "/api/music/playlists" });
          expect(recovered.statusCode).toBe(200);
          expect(recovered.json()).toEqual({ playlists: [] });
        }
      } finally {
        await app.close();
      }
    },
  );
});
