import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { AzureAccountStore } from "./azure-account-store.js";
import { createAzureStores } from "./azure-stores.js";
import { createStorageFixture } from "./test-helpers/storage-fixture.js";
import { YouTubeOAuthService } from "./youtube-oauth.js";

let fixture: Awaited<ReturnType<typeof createStorageFixture>>;
let azure: ReturnType<typeof createAzureStores>;
let credentials: AzureAccountStore;
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
  fixture = await createStorageFixture();
  azure = createAzureStores(fixture.options);
  credentials = new AzureAccountStore(fixture.storage);
});
afterAll(async () => {
  await azure?.end();
  await fixture?.close();
});

describe("YouTube authorization recovery through the music API", () => {
  it("binds callback state to the user and recovers token-exchange failure without losing credentials", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(tokens))
      .mockResolvedValueOnce(json({ items: [{ snippet: { title: "Test host" } }] }));
    const service = new YouTubeOAuthService(credentials, config, fetcher);
    await service.exchangeCode(user.id, "initial-code");
    const before = await fixture.storage.read((ctx) => ctx.list("music:"));
    const priorCredential = (await credentials.getCredential(user.id))!;
    let currentUser = user;
    const app = await buildApp({
      stores: azure.stores,
      youtubeOAuth: service,
      authenticateRequest: async () => currentUser,
    });
    try {
      const started = await app.inject("/api/music/oauth/start");
      expect(started.statusCode).toBe(302);
      const state = new URL(String(started.headers.location)).searchParams.get("state")!;
      const cookie = String(started.headers["set-cookie"]).split(";", 1)[0]!;
      for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/api/music/oauth/callback"]) {
        expect(started.headers["set-cookie"]).toContain(flag);
      }
      const callbackUrl = `/api/music/oauth/callback?code=reconnect-code&state=${state}`;
      const invalid = await app.inject({
        url: "/api/music/oauth/callback?code=reconnect-code&state=wrong",
        headers: { cookie },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toEqual({ error: "oauth_state_mismatch" });
      currentUser = { ...user, id: "00000000-0000-4000-8000-000000000002" };
      const changedUser = await app.inject({ url: callbackUrl, headers: { cookie } });
      expect(changedUser.statusCode).toBe(400);
      expect(changedUser.json()).toEqual({ error: "oauth_state_mismatch" });
      expect(fetcher).toHaveBeenCalledTimes(2);
      currentUser = user;
      fetcher.mockResolvedValueOnce(json({ error: "private-provider-detail" }, 400));
      const failed = await app.inject({ url: callbackUrl, headers: { cookie } });
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toEqual({ error: "internal_server_error" });
      expect(failed.headers["set-cookie"]).toBeUndefined();
      expect(await fixture.storage.read((ctx) => ctx.list("music:"))).toEqual(before);

      fetcher
        .mockResolvedValueOnce(json({ ...tokens, refresh_token: "replacement-refresh" }))
        .mockResolvedValueOnce(json({ items: [{ snippet: { title: "Reconnected host" } }] }));
      const recovered = await app.inject({ url: callbackUrl, headers: { cookie } });
      expect(recovered.statusCode).toBe(302);
      expect(recovered.headers.location).toBe("/?music=connected");
      expect(recovered.headers["set-cookie"]).toContain("Max-Age=0");
      await expect(service.getStatus(user.id)).resolves.toEqual({
        configured: true,
        connected: true,
        accountLabel: "Reconnected host",
      });
      expect((await credentials.getCredential(user.id))!.refreshTokenEncrypted).not.toEqual(
        priorCredential.refreshTokenEncrypted,
      );
    } finally {
      await app.close();
    }
  });

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
      const service = new YouTubeOAuthService(credentials, config, fetcher);
      await service.exchangeCode(user.id, "test-code");
      const issued = (await credentials.getCredential(user.id))!;
      await credentials.putCredential(user.id, { ...issued, expiresAt: new Date("2000-01-01") });
      const before = await fixture.storage.read((ctx) => ctx.list("music:"));
      fetcher.mockImplementation(async () => {
        if (status === 0) throw new Error("private-network-detail");
        return body === "not-json"
          ? new Response("private-provider-detail", { status })
          : json(body, status);
      });
      const app = await buildApp({
        stores: azure.stores,
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
        const after = await fixture.storage.read((ctx) => ctx.list("music:"));
        expect(after).toEqual(before);
        await expect(
          new AzureAccountStore(fixture.storage).getCredential(user.id),
        ).resolves.toEqual({
          ...issued,
          expiresAt: new Date("2000-01-01"),
        });
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
          expect((await credentials.getCredential(user.id))!.refreshTokenEncrypted).not.toEqual(
            issued.refreshTokenEncrypted,
          );
        }
      } finally {
        await app.close();
      }
    },
  );
});
