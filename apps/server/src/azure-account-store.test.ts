import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AzureAccountStore } from "./azure-account-store.js";
import { digest } from "./azure-storage.js";
import { createStorageFixture } from "./test-helpers/storage-fixture.js";

const id1 = "00000000-0000-4000-8000-000000000001";
const id2 = "00000000-0000-4000-8000-000000000002";
let fixture: Awaited<ReturnType<typeof createStorageFixture>>;
let accounts: AzureAccountStore;
beforeAll(async () => {
  fixture = await createStorageFixture();
  accounts = new AzureAccountStore(fixture.storage);
});
afterAll(async () => {
  await fixture?.close();
});

describe("Azure account persistence", () => {
  it("reserves exact emails and provider subjects atomically; updates stable user identity", async () => {
    const first = await accounts.upsertUser({
      id: id1,
      subject: "google-subject",
      email: "Owner@example.test",
      name: "Owner",
      picture: null,
    });
    expect(first).toMatchObject({ id: id1, email: "Owner@example.test" });
    const repeated = await accounts.upsertUser({
      id: id2,
      subject: "google-subject",
      email: "new@example.test",
      name: "Owner two",
      picture: "https://example.test/p.png",
    });
    expect(repeated).toMatchObject({
      id: id1,
      email: "new@example.test",
      picture: "https://example.test/p.png",
    });
    const user = await fixture.storage.read((ctx) =>
      ctx.get<{ email: string; picture?: string }>(`user:${id1}`),
    );
    expect(user).toMatchObject({
      email: "new@example.test",
      picture: "https://example.test/p.png",
    });
    expect(
      await fixture.storage.read((ctx) => ctx.get(`email:${digest("Owner@example.test")}`)),
    ).toBeUndefined();
    await expect(
      accounts.upsertUser({
        id: id2,
        subject: "another-subject",
        email: "new@example.test",
        name: "Other",
        picture: null,
      }),
    ).rejects.toThrow();
    expect(
      await fixture.storage.read((ctx) => ctx.get(`subject:${digest("another-subject")}`)),
    ).toBeUndefined();
  });
  it("stores only session digests, honors expiry, and invalidates logout", async () => {
    const hash = Buffer.alloc(32, 8);
    const key = `session:${hash.toString("hex")}`;
    await accounts.saveSession(id1, hash, new Date(Date.now() + 60_000));
    expect(await fixture.storage.read((ctx) => ctx.get(key))).toMatchObject({ userId: id1 });
    expect(await accounts.findSession(hash, new Date())).toMatchObject({ id: id1 });
    expect(await accounts.findSession(hash, new Date(Date.now() + 120_000))).toBeNull();
    await accounts.removeSession(hash);
    expect(await accounts.findSession(hash, new Date())).toBeNull();
  });
  it("persists encrypted token binaries and retains refresh token during access refresh", async () => {
    const encrypted = Buffer.from([1, 2, 3, 4]);
    await accounts.putCredential(id1, {
      accessTokenEncrypted: encrypted,
      refreshTokenEncrypted: Buffer.from([5, 6, 7]),
      expiresAt: new Date("2030-01-01"),
      accountLabel: "Host",
      scope: null,
    });
    expect(await accounts.getCredential(id1)).toMatchObject({
      accessTokenEncrypted: encrypted,
      refreshTokenEncrypted: Buffer.from([5, 6, 7]),
      accountLabel: "Host",
    });
    await accounts.refreshCredential(id1, {
      accessTokenEncrypted: Buffer.from([8, 9]),
      expiresAt: new Date("2031-01-01"),
      scope: "readonly",
    });
    expect(await accounts.getCredential(id1)).toMatchObject({
      accessTokenEncrypted: Buffer.from([8, 9]),
      refreshTokenEncrypted: Buffer.from([5, 6, 7]),
      scope: "readonly",
    });
    await accounts.deleteCredential(id1);
    expect(await accounts.getCredential(id1)).toBeNull();
  });
  it("stores oversized encrypted credentials as an integrity-checked Blob", async () => {
    const oversized = Buffer.alloc(70_000, 13);
    const refresh = Buffer.from([2, 3, 4]);
    await accounts.putCredential(id2, {
      accessTokenEncrypted: oversized,
      refreshTokenEncrypted: refresh,
      expiresAt: new Date("2030-01-01"),
      accountLabel: "Large",
      scope: null,
    });
    expect(await accounts.getCredential(id2)).toMatchObject({
      accessTokenEncrypted: oversized,
      refreshTokenEncrypted: refresh,
    });
    const row = await fixture.storage.read((ctx) =>
      ctx.get<{ tokenBlobName: string; accessTokenEncrypted?: Buffer }>(`music:${id2}`),
    );
    expect(row?.tokenBlobName).toContain("/music/");
    expect(row?.accessTokenEncrypted).toBeUndefined();
    await accounts.refreshCredential(id2, {
      accessTokenEncrypted: Buffer.from([8]),
      expiresAt: new Date("2031-01-01"),
    });
    expect(await accounts.getCredential(id2)).toMatchObject({
      accessTokenEncrypted: Buffer.from([8]),
      refreshTokenEncrypted: refresh,
    });
  });
});
