import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("does not trust forwarding headers by default", () => {
    expect(loadConfig({}).TRUST_PROXY_HOPS).toBe(0);
  });

  it("accepts one trusted proxy hop", () => {
    expect(loadConfig({ TRUST_PROXY_HOPS: "1" }).TRUST_PROXY_HOPS).toBe(1);
  });

  it("rejects trust beyond the supported single proxy hop", () => {
    expect(() => loadConfig({ TRUST_PROXY_HOPS: "2" })).toThrow();
  });

  it("builds Google sign-in configuration from the public app URL", () => {
    const config = loadConfig({
      PUBLIC_APP_URL: "https://mafia.example.test",
      GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "client-secret",
    });

    expect(config.googleAuth).toEqual({
      clientId: "client-id.apps.googleusercontent.com",
      clientSecret: "client-secret",
      redirectUri: "https://mafia.example.test/api/auth/google/callback",
    });
    expect(config.youtubeOAuth).toBeUndefined();
  });

  it("builds the YouTube OAuth configuration from a complete secret set", () => {
    const encryptionKey = Buffer.alloc(32, 9).toString("base64url");

    const config = loadConfig({
      DATABASE_URL: "postgresql://mafia:mafia@db:5432/mafia",
      HOST: "0.0.0.0",
      PORT: "3000",
      GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "client-secret",
      GOOGLE_OAUTH_REDIRECT_URI: "https://mbp16.tail102fab.ts.net/api/music/oauth/callback",
      MUSIC_TOKEN_ENCRYPTION_KEY: encryptionKey,
    });

    expect(config.youtubeOAuth).toEqual({
      clientId: "client-id.apps.googleusercontent.com",
      clientSecret: "client-secret",
      redirectUri: "https://mbp16.tail102fab.ts.net/api/music/oauth/callback",
      encryptionKey: Buffer.alloc(32, 9),
    });
  });

  it("rejects unpaired Google client credentials", () => {
    expect(() =>
      loadConfig({
        GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
      }),
    ).toThrow(/client id and secret must be set together/i);
  });

  it("treats empty Compose OAuth variables as unconfigured", () => {
    const config = loadConfig({
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      GOOGLE_OAUTH_REDIRECT_URI: "",
      MUSIC_TOKEN_ENCRYPTION_KEY: "",
    });

    expect(config.youtubeOAuth).toBeUndefined();
  });

  it("loads the canonical public app URL used for secure browser redirects", () => {
    const config = loadConfig({
      PUBLIC_APP_URL: "https://mbp16.tail102fab.ts.net",
    });

    expect(config.PUBLIC_APP_URL).toBe("https://mbp16.tail102fab.ts.net");
  });
});
