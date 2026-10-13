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
