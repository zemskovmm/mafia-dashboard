import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { EventStore } from "./event-store.js";
import { APPLICATION_SESSION_TTL_MS, GoogleAuthService } from "./google-auth.js";

const config = {
  clientId: "client-id.apps.googleusercontent.com",
  clientSecret: "client-secret",
  redirectUri: "https://mafia.example.test/api/auth/google/callback",
};
const integrationPool = new Pool({
  connectionString:
    process.env.TEST_DATABASE_URL ?? "postgresql://mafia:mafia@127.0.0.1:54329/mafia_test",
});

beforeAll(async () => {
  await new EventStore(integrationPool).initialize();
});

afterAll(async () => {
  await integrationPool.end();
});

describe("GoogleAuthService", () => {
  it("builds an OpenID Connect authorization request protected by state", () => {
    const service = new GoogleAuthService({} as Pool, config, vi.fn());

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
    let storedSessionHash: Buffer | null = null;
    let storedExpiresAt: Date | null = null;
    const now = new Date("2026-08-30T12:00:00.000Z");
    const userRow = {
      id: "00000000-0000-4000-8000-000000000099",
      email: "owner@example.test",
      display_name: "Club owner",
      picture: "https://example.test/avatar.png",
    };
    const pool = {
      query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
        if (sql.startsWith("DELETE FROM user_sessions")) return { rows: [], rowCount: 0 };
        if (sql.includes("INSERT INTO users")) return { rows: [userRow], rowCount: 1 };
        if (sql.includes("INSERT INTO user_sessions")) {
          storedSessionHash = values?.[1] as Buffer;
          storedExpiresAt = values?.[3] as Date;
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("FROM user_sessions AS session")) {
          expect(values?.[0]).toEqual(storedSessionHash);
          return { rows: [userRow], rowCount: 1 };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    } as unknown as Pool;
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
            name: userRow.display_name,
            picture: userRow.picture,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const service = new GoogleAuthService(pool, config, fetcher, () => now);

    const signedIn = await service.completeAuthorization("authorization-code");
    const restored = await service.getUserForSession(signedIn.sessionToken);

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
      name: userRow.display_name,
      picture: userRow.picture,
    });
    expect(restored).toEqual(signedIn.user);
    expect(storedSessionHash).toBeInstanceOf(Buffer);
    expect(storedSessionHash).toHaveLength(32);
    expect(storedSessionHash).toEqual(createHash("sha256").update(signedIn.sessionToken).digest());
    expect((storedSessionHash as Buffer | null)?.toString("base64url")).not.toBe(
      signedIn.sessionToken,
    );
    expect(signedIn.expiresAt).toEqual(new Date(now.getTime() + APPLICATION_SESSION_TTL_MS));
    expect(storedExpiresAt).toEqual(signedIn.expiresAt);
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
    const service = new GoogleAuthService({} as Pool, config, fetcher);

    await expect(service.completeAuthorization("authorization-code")).rejects.toThrow(
      /verified Google email/i,
    );
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
    const service = new GoogleAuthService(integrationPool, config, fetcher);

    const first = await service.completeAuthorization("first-code");
    const second = await service.completeAuthorization("second-code");

    expect(second.user.id).toBe(first.user.id);
    expect(second.user.name).toBe("Updated owner");
    const stored = await integrationPool.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM users WHERE google_subject = $1",
      [profile.sub],
    );
    expect(stored.rows[0]?.count).toBe(1);
    await integrationPool.query("DELETE FROM users WHERE google_subject = $1", [profile.sub]);
  });

  it("revokes only the presented application session", async () => {
    const userId = randomUUID();
    const subject = `google-subject-${randomUUID()}`;
    const email = `sessions-${randomUUID()}@example.test`;
    const firstToken = randomUUID();
    const secondToken = randomUUID();
    await integrationPool.query(
      `INSERT INTO users (id, google_subject, email, display_name)
       VALUES ($1, $2, $3, 'Session owner')`,
      [userId, subject, email],
    );
    await integrationPool.query(
      `INSERT INTO user_sessions (id, token_hash, user_id, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '1 day'),
              ($4, $5, $3, NOW() + INTERVAL '1 day')`,
      [
        randomUUID(),
        createHash("sha256").update(firstToken).digest(),
        userId,
        randomUUID(),
        createHash("sha256").update(secondToken).digest(),
      ],
    );
    const service = new GoogleAuthService(integrationPool, config, vi.fn());

    await service.endSession(firstToken);

    await expect(service.getUserForSession(firstToken)).resolves.toBeNull();
    await expect(service.getUserForSession(secondToken)).resolves.toMatchObject({
      id: userId,
      email,
    });
    await integrationPool.query("DELETE FROM users WHERE id = $1", [userId]);
  });
});
