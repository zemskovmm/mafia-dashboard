import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const azure = {
  AZURE_STORAGE_ACCOUNT_NAME: "mafiatest01",
  AZURE_STORAGE_PARTITION_KEY: "config-test",
};

describe("loadConfig", () => {
  it("uses build index zero locally and accepts the CI run number", () => {
    expect(loadConfig(azure).APP_BUILD_INDEX).toBe(0);
    expect(loadConfig({ ...azure, APP_BUILD_INDEX: "123" }).APP_BUILD_INDEX).toBe(123);
  });

  it.each(["", "-1", "1.5", "1e3", "01", " 1", "9007199254740992", "build"])(
    "rejects an invalid build index %j",
    (APP_BUILD_INDEX) => {
      expect(() => loadConfig({ ...azure, APP_BUILD_INDEX })).toThrow();
    },
  );

  it("does not trust forwarding headers by default", () => {
    expect(loadConfig(azure).TRUST_PROXY_HOPS).toBe(0);
    expect(loadConfig(azure).APP_COMMIT).toBe("unknown");
  });

  it("accepts only an exact full source commit identity", () => {
    const commit = "a".repeat(40);
    expect(loadConfig({ ...azure, APP_COMMIT: commit }).APP_COMMIT).toBe(commit);
    expect(() => loadConfig({ ...azure, APP_COMMIT: "abc123" })).toThrow();
  });

  it("accepts one trusted proxy hop", () => {
    expect(loadConfig({ ...azure, TRUST_PROXY_HOPS: "1" }).TRUST_PROXY_HOPS).toBe(1);
  });

  it("rejects trust beyond the supported single proxy hop", () => {
    expect(() => loadConfig({ ...azure, TRUST_PROXY_HOPS: "2" })).toThrow();
  });

  it("builds Google sign-in configuration from the public app URL", () => {
    const config = loadConfig({
      ...azure,
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
      ...azure,
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
        ...azure,
        GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
      }),
    ).toThrow(/client id and secret must be set together/i);
  });

  it("treats empty optional OAuth variables as unconfigured", () => {
    const config = loadConfig({
      ...azure,
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      GOOGLE_OAUTH_REDIRECT_URI: "",
      MUSIC_TOKEN_ENCRYPTION_KEY: "",
    });

    expect(config.youtubeOAuth).toBeUndefined();
  });

  it("loads the canonical public app URL used for secure browser redirects", () => {
    const config = loadConfig({
      ...azure,
      PUBLIC_APP_URL: "https://mbp16.tail102fab.ts.net",
    });

    expect(config.PUBLIC_APP_URL).toBe("https://mbp16.tail102fab.ts.net");
  });

  it("does not accept a database URL as a substitute for required Azure settings", () => {
    expect(() => loadConfig({ DATABASE_URL: "postgresql://retired.invalid/unused" })).toThrow(
      /Azure storage/i,
    );
    const config = loadConfig({ ...azure, DATABASE_URL: "postgresql://retired.invalid/unused" });
    expect(config.STORAGE_PROVIDER).toBe("azure");
    expect(config).not.toHaveProperty("DATABASE_URL");
    expect(config).not.toHaveProperty("databaseUrl");
  });
});
