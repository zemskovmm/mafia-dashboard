import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { createAzureStores } from "./azure-stores.js";
import { GoogleAuthService } from "./google-auth.js";
import { createStorageFixture } from "./test-helpers/storage-fixture.js";
import { loadConfig } from "./config.js";

let fixture: Awaited<ReturnType<typeof createStorageFixture>>;
beforeAll(async () => {
  fixture = await createStorageFixture();
});
afterAll(async () => {
  await fixture?.close();
});

it("serves authenticated club reads over Azure and revokes logout without SQL", async () => {
  expect(
    loadConfig({
      STORAGE_PROVIDER: "azure",
      AZURE_STORAGE_CONNECTION_STRING: fixture.options.connectionString,
      AZURE_STORAGE_PARTITION_KEY: fixture.options.partitionKey,
    }).azureStorage,
  ).toMatchObject({ connectionString: fixture.options.connectionString });
  const azure = createAzureStores(fixture.options);
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "provider-access" })))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sub: "owner-subject",
          email: "owner@example.test",
          email_verified: true,
          name: "Owner Example",
        }),
      ),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "provider-access" })))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sub: "outsider-subject",
          email: "outsider@example.test",
          email_verified: true,
          name: "Outsider",
        }),
      ),
    );
  const auth = new GoogleAuthService(
    azure.auth,
    { clientId: "client", clientSecret: "secret", redirectUri: "https://example.test/callback" },
    fetcher,
  );
  const owner = await auth.completeAuthorization("owner-code");
  const outsider = await auth.completeAuthorization("outsider-code");
  const club = await azure.stores.clubs.create(owner.user, {
    name: "Test club",
    city: "London",
    headerLogo: null,
    cardLogo: null,
    language: "en",
    ownerConsent: true,
  });
  const app = await buildApp({ stores: azure.stores, googleAuth: auth });
  const request = (token: string) => ({
    url: "/api/players",
    headers: { "x-club-id": club.id, cookie: `mafia_session=${token}` },
  });
  try {
    const ready = await app.inject("/health/ready");
    expect(ready.statusCode).toBe(200);
    const allowed = await app.inject(request(owner.sessionToken));
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().players).toMatchObject([{ nickname: "Owner" }]);
    const denied = await app.inject(request(outsider.sessionToken));
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: "club_access_denied" });
    await auth.endSession(owner.sessionToken);
    const ended = await app.inject(request(owner.sessionToken));
    expect(ended.statusCode).toBe(401);
  } finally {
    await app.close();
    await azure.end();
  }
});

it("protects Google callbacks, persists secure sessions, and enforces CSRF before logout", async () => {
  const azure = createAzureStores(fixture.options);
  const fetcher = vi.fn<typeof fetch>();
  const auth = new GoogleAuthService(
    azure.auth,
    { clientId: "client", clientSecret: "secret", redirectUri: "https://example.test/callback" },
    fetcher,
  );
  const app = await buildApp({
    stores: azure.stores,
    googleAuth: auth,
    publicAppUrl: "https://example.test",
  });
  try {
    const started = await app.inject("/api/auth/google/start");
    expect(started.statusCode).toBe(302);
    const state = new URL(String(started.headers.location)).searchParams.get("state")!;
    const stateCookie = String(started.headers["set-cookie"]).split(";", 1)[0]!;
    for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/api/auth/google/callback"]) {
      expect(started.headers["set-cookie"]).toContain(flag);
    }
    const callbackUrl = `/api/auth/google/callback?code=code&state=${state}`;
    for (const request of [
      { url: callbackUrl },
      { url: "/api/auth/google/callback?code=code&state=wrong", headers: { cookie: stateCookie } },
    ]) {
      const refused = await app.inject(request);
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toEqual({ error: "oauth_state_mismatch" });
      expect(refused.headers["set-cookie"]).toBeUndefined();
    }
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockRejectedValueOnce(new Error("private-provider-failure"));
    const failed = await app.inject({ url: callbackUrl, headers: { cookie: stateCookie } });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: "internal_server_error" });
    expect(failed.headers["set-cookie"]).toBeUndefined();

    fetcher
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "provider-access" })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sub: "callback-subject",
            email: "callback@example.test",
            email_verified: true,
            name: "Callback owner",
          }),
        ),
      );
    const callback = await app.inject({ url: callbackUrl, headers: { cookie: stateCookie } });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe("/");
    const cookies = callback.headers["set-cookie"] as string[];
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain("Max-Age=0");
    const sessionCookie = cookies.find((value) => value.startsWith("mafia_session="))!;
    for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) {
      expect(sessionCookie).toContain(flag);
    }
    expect(sessionCookie).toMatch(/Max-Age=[1-9]\d*/);
    const cookie = sessionCookie.split(";", 1)[0]!;
    const session = await app.inject({ url: "/api/auth/session", headers: { cookie } });
    expect(session.json()).toMatchObject({
      configured: true,
      user: { email: "callback@example.test" },
    });
    expect(session.headers["cache-control"]).toBe("no-store");

    for (const origin of [undefined, "https://attacker.invalid"]) {
      const refused = await app.inject({
        method: "DELETE",
        url: "/api/auth/session",
        headers: { cookie, ...(origin === undefined ? {} : { origin }) },
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toEqual({ error: "csrf_origin_mismatch" });
      expect(refused.headers["set-cookie"]).toBeUndefined();
      expect(
        (await app.inject({ url: "/api/auth/session", headers: { cookie } })).json().user,
      ).not.toBeNull();
    }
    const logout = await app.inject({
      method: "DELETE",
      url: "/api/auth/session",
      headers: { cookie, origin: "https://example.test" },
    });
    expect(logout.statusCode).toBe(204);
    expect(logout.headers["set-cookie"]).toContain("mafia_session=;");
    expect(logout.headers["set-cookie"]).toContain("Max-Age=0");
    expect((await app.inject({ url: "/api/auth/session", headers: { cookie } })).json()).toEqual({
      configured: true,
      user: null,
    });
  } finally {
    await app.close();
    await azure.end();
  }
});
