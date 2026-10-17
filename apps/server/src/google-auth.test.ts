import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AzureAccountStore } from "./azure-account-store.js";
import { APPLICATION_SESSION_TTL_MS, GoogleAuthService } from "./google-auth.js";
import { createStorageFixture } from "./test-helpers/storage-fixture.js";

const config = {
  clientId: "client-id.apps.googleusercontent.com",
  clientSecret: "client-secret",
  redirectUri: "https://mafia.example.test/api/auth/google/callback",
};
let fixture: Awaited<ReturnType<typeof createStorageFixture>>;
let accounts: AzureAccountStore;

beforeAll(async () => {
  fixture = await createStorageFixture();
  accounts = new AzureAccountStore(fixture.storage);
});

afterAll(async () => {
  await fixture?.close();
});

describe("GoogleAuthService", () => {
  it("builds an OpenID Connect authorization request protected by state", () => {
    const service = new GoogleAuthService(accounts, config, vi.fn());

    const authorization = new URL(service.createAuthorizationUrl("unguessable-state"));

    expect(authorization.origin + authorization.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(Object.fromEntries(authorization.searchParams)).toMatchObject({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state: "unguessable-state",
    });
  });

  it("exchanges the code, upserts the stable Google subject, and stores only a session hash", async () => {
    const now = new Date("2026-08-30T12:00:00.000Z");
    const userRow = {
      id: "00000000-0000-4000-8000-000000000099",
      email: "owner@example.test",
      name: "Club owner",
      picture: "https://example.test/avatar.png",
    };
    await accounts.upsertUser({ ...userRow, subject: "google-subject-123" });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "provider-access-token", token_type: "Bearer" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sub: "google-subject-123",
            email: userRow.email,
            email_verified: true,
            name: userRow.name,
            picture: userRow.picture,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const service = new GoogleAuthService(accounts, config, fetcher, () => now);

    const signedIn = await service.completeAuthorization("authorization-code");
    const restoredService = new GoogleAuthService(
      new AzureAccountStore(fixture.storage),
      config,
      vi.fn(),
      () => now,
    );
    const restored = await restoredService.getUserForSession(signedIn.sessionToken);
    const hash = createHash("sha256").update(signedIn.sessionToken).digest();
    const storedSessions = await fixture.storage.read((ctx) =>
      ctx.list<{ userId: string; expiresAt: Date }>("session:"),
    );
    const stored = storedSessions.find(
      ({ rowKey }) => rowKey === `session:${hash.toString("hex")}`,
    );

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "https://openidconnect.googleapis.com/v1/userinfo",
      expect.objectContaining({ headers: { authorization: "Bearer provider-access-token" } }),
    );
    expect(signedIn.user).toEqual({
      id: userRow.id,
      email: userRow.email,
      name: userRow.name,
      picture: userRow.picture,
    });
    expect(restored).toEqual(signedIn.user);
    expect(stored).toEqual({
      rowKey: `session:${hash.toString("hex")}`,
      userId: signedIn.user.id,
      expiresAt: signedIn.expiresAt,
    });
    expect(JSON.stringify(storedSessions)).not.toContain(signedIn.sessionToken);
    expect(signedIn.expiresAt).toEqual(new Date(now.getTime() + APPLICATION_SESSION_TTL_MS));
    const expired = new GoogleAuthService(accounts, config, vi.fn(), () => signedIn.expiresAt);
    await expect(expired.getUserForSession(signedIn.sessionToken)).resolves.toBeNull();
  });

  it("rejects identities whose email is not verified", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "provider-access-token" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sub: "google-subject-123",
            email: "owner@example.test",
            email_verified: false,
            name: "Club owner",
          }),
          { status: 200 },
        ),
      );
    const before = await fixture.storage.read((ctx) => ctx.list("user:"));
    const service = new GoogleAuthService(accounts, config, fetcher);

    await expect(service.completeAuthorization("authorization-code")).rejects.toThrow(
      /verified Google email/i,
    );
    expect(await fixture.storage.read((ctx) => ctx.list("user:"))).toEqual(before);
  });

  it("updates an existing Google subject without creating a duplicate user", async () => {
    const unique = randomUUID();
    const profile = {
      sub: `google-subject-${unique}`,
      email: `owner-${unique}@example.test`,
      email_verified: true,
      name: "Club owner",
    };
    const jsonResponse = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "provider-token-1" }))
      .mockResolvedValueOnce(jsonResponse(profile))
      .mockResolvedValueOnce(jsonResponse({ access_token: "provider-token-2" }))
      .mockResolvedValueOnce(jsonResponse({ ...profile, name: "Updated owner" }));
    const service = new GoogleAuthService(accounts, config, fetcher);

    const first = await service.completeAuthorization("first-code");
    const second = await service.completeAuthorization("second-code");

    expect(second.user.id).toBe(first.user.id);
    expect(second.user.name).toBe("Updated owner");
    const stored = await fixture.storage.read((ctx) =>
      ctx.list<{ id: string; email: string; name: string }>("user:"),
    );
    expect(stored.filter(({ email }) => email === profile.email)).toEqual([
      expect.objectContaining({ id: first.user.id, email: profile.email, name: "Updated owner" }),
    ]);
    await expect(service.getUserForSession(first.sessionToken)).resolves.toEqual(second.user);
  });

  it("revokes only the presented application session", async () => {
    const userId = randomUUID();
    const subject = `google-subject-${randomUUID()}`;
    const email = `sessions-${randomUUID()}@example.test`;
    const firstToken = randomUUID();
    const secondToken = randomUUID();
    await accounts.upsertUser({ id: userId, subject, email, name: "Session owner", picture: null });
    const expiresAt = new Date(Date.now() + APPLICATION_SESSION_TTL_MS);
    for (const token of [firstToken, secondToken]) {
      await accounts.saveSession(userId, createHash("sha256").update(token).digest(), expiresAt);
    }
    const service = new GoogleAuthService(accounts, config, vi.fn());

    await service.endSession(firstToken);

    await expect(service.getUserForSession(firstToken)).resolves.toBeNull();
    await expect(service.getUserForSession(secondToken)).resolves.toMatchObject({
      id: userId,
      email,
    });
  });
});
