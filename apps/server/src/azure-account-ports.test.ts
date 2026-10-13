import { describe, expect, it, vi } from "vitest";
import { GoogleAuthService, type GoogleAccountStore } from "./google-auth.js";
import { YouTubeOAuthService, type YouTubeCredentialStore } from "./youtube-oauth.js";

const googleConfig = {
  clientId: "client",
  clientSecret: "secret",
  redirectUri: "https://example.test/callback",
};
const musicConfig = { ...googleConfig, encryptionKey: Buffer.alloc(32, 5) };
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

it("uses an account port for stable identity and hashed expiring sessions", async () => {
  const account: GoogleAccountStore = {
    upsertUser: vi.fn(async (identity) => ({
      id: "00000000-0000-4000-8000-000000000001",
      email: identity.email,
      name: identity.name,
      picture: identity.picture,
    })),
    saveSession: vi.fn(async () => undefined),
    findSession: vi.fn(async () => null),
    removeSession: vi.fn(async () => undefined),
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ access_token: "access" }))
    .mockResolvedValueOnce(
      json({ sub: "subject", email: "owner@example.test", email_verified: true, name: "Owner" }),
    );
  const service = new GoogleAuthService(account, googleConfig, fetcher);
  const result = await service.completeAuthorization("code");
  expect(account.upsertUser).toHaveBeenCalledWith(
    expect.objectContaining({ subject: "subject", email: "owner@example.test" }),
  );
  expect(account.saveSession).toHaveBeenCalledWith(
    result.user.id,
    expect.any(Buffer),
    result.expiresAt,
  );
  expect(vi.mocked(account.saveSession).mock.calls[0]![1]).toHaveLength(32);
  await service.endSession(result.sessionToken);
  expect(account.removeSession).toHaveBeenCalledWith(
    vi.mocked(account.saveSession).mock.calls[0]![1],
  );
});

describe("credential port", () => {
  it("stores encrypted binary tokens without passing plaintext to persistence", async () => {
    const credentials: YouTubeCredentialStore = {
      putCredential: vi.fn(async () => undefined),
      getCredential: vi.fn(async () => null),
      refreshCredential: vi.fn(async () => undefined),
      deleteCredential: vi.fn(async () => undefined),
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          access_token: "secret-access",
          refresh_token: "secret-refresh",
          expires_in: 3600,
          token_type: "Bearer",
        }),
      )
      .mockResolvedValueOnce(json({ items: [{ snippet: { title: "Host" } }] }));
    const service = new YouTubeOAuthService(credentials, musicConfig, fetcher);
    await service.exchangeCode("00000000-0000-4000-8000-000000000001", "code");
    const saved = vi.mocked(credentials.putCredential).mock.calls[0]![1];
    expect(saved.accessTokenEncrypted).toBeInstanceOf(Buffer);
    expect(saved.refreshTokenEncrypted).toBeInstanceOf(Buffer);
    expect(saved.accessTokenEncrypted.toString()).not.toContain("secret-access");
    expect(saved.refreshTokenEncrypted.toString()).not.toContain("secret-refresh");
    expect(saved.accountLabel).toBe("Host");
  });
});
