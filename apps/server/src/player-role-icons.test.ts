import { randomUUID } from "node:crypto";
import { crc32 } from "node:zlib";
import { mkdir, mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { DEFAULT_CLUB_ID } from "./club-store.js";
import { AzureClubStore, AzurePlayerStore } from "./azure-club-player-store.js";
import type { ApplicationStores } from "./storage-contracts.js";
import { AzureStorage, blobReference, digest } from "./azure-storage.js";
import { collectStorageGarbage } from "./azure-storage-maintenance.js";
import { captureStorageBackup, restoreStorageBackup } from "./storage-backup.js";
import { createApplicationStorageFixture } from "./test-helpers/storage-fixture.js";
import { BUILTIN_ROLE_ICON_IDS, PLAYER_ICON_ROLES } from "./player-role-icon-contracts.js";
import type { PlayerRoleIconBundle } from "./player-role-icon-contracts.js";

const owner = { id: randomUUID(), name: "Icon Owner", email: "owner@example.test", picture: null };
const member = { ...owner, id: randomUUID(), email: "member@example.test" };
const outsider = { ...owner, id: randomUUID(), email: "other@example.test" };
let fixture: Awaited<ReturnType<typeof createApplicationStorageFixture>>;
let app: Awaited<ReturnType<typeof buildApp>>;
let players: AzurePlayerStore;
let stores: ApplicationStores;
let png: string;
const basic = () => ({ nickname: `Icons ${randomUUID()}`, consent: false });
const consented = () => ({
  ...basic(),
  consent: true,
  firstName: "Icon",
  lastName: "Player",
  email: "icon@example.test",
});
const headers = (actor: string = owner.id, clubId = DEFAULT_CLUB_ID) => ({
  "x-test-user": actor,
  "x-club-id": clubId,
});
const post = (payload: object) =>
  app.inject({ method: "POST", url: "/api/players", headers: headers(), payload });
const put = (id: string, payload: object, actor: string = owner.id, clubId = DEFAULT_CLUB_ID) =>
  app.inject({
    method: "PUT",
    url: `/api/players/${id}`,
    headers: headers(actor, clubId),
    payload,
  });
const get = (id: string, actor: string = owner.id, clubId = DEFAULT_CLUB_ID) =>
  app.inject({
    method: "GET",
    url: `/api/players/${id}/role-icons`,
    headers: headers(actor, clubId),
  });
const row = (id: string) =>
  fixture.storage.read((tx) =>
    tx.get<Record<string, unknown>>(`club:${DEFAULT_CLUB_ID}:player:${id}`),
  );
const image = (dataUrl: string) => ({ kind: "image" as const, dataUrl });
const dataUrl = (bytes: Buffer, type = "png") =>
  `data:image/${type};base64,${bytes.toString("base64")}`;
const createUploaded = async () => {
  const input = consented();
  const result = await post({
    ...input,
    roleIcons: { citizen: image(png), mafia: { kind: "builtin", id: "cat" } },
  });
  expect(result.statusCode, result.body).toBe(201);
  return { input, player: result.json().player };
};

beforeAll(async () => {
  fixture = await createApplicationStorageFixture(owner);
  players = new AzurePlayerStore(fixture.storage);
  stores = {
    ...fixture.stores,
    players,
    clubs: new AzureClubStore(fixture.storage),
    runAuthorized: (userId, clubId, manager, work) =>
      fixture.storage.runAuthorized(userId, clubId, manager, work),
  };
  for (const account of [member, outsider])
    await fixture.accounts.upsertUser({ ...account, subject: account.id });
  await fixture.storage.mutate((tx) =>
    tx.set(`club:${DEFAULT_CLUB_ID}:member:${member.id}`, { userId: member.id, role: "user" }),
  );
  app = await buildApp({
    stores,
    defaultClubId: DEFAULT_CLUB_ID,
    authenticateRequest: async (request) =>
      [owner, member, outsider].find((account) => account.id === request.headers["x-test-user"]) ??
      null,
  });
  await app.ready();
  png = dataUrl(
    await sharp({ create: { width: 512, height: 256, channels: 4, background: "#ff000080" } })
      .withMetadata({ exif: { IFD0: { Artist: "Private original author" } } })
      .png()
      .toBuffer(),
  );
}, 60_000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await app?.close();
  await fixture?.close();
});

describe("private player role icons through HTTP and real Table/Blob", () => {
  it("allows every catalog builtin without consent, rejects unknown keys/variants, and resets independently", async () => {
    for (const id of BUILTIN_ROLE_ICON_IDS) {
      const input = basic();
      const roleIcons = Object.fromEntries(
        PLAYER_ICON_ROLES.map((role) => [role, { kind: "builtin", id }]),
      );
      const created = await post({ ...input, roleIcons });
      expect(created.statusCode, created.body).toBe(201);
      const player = created.json().player;
      expect(player.roleIcons).toEqual(roleIcons);
      expect(player.roleIconsVersion).toBeNull();
      expect((await get(player.id)).json()).toEqual({ version: null, images: {} });
      expect(
        (await put(player.id, { ...input, roleIcons: { citizen: null } })).json().player.roleIcons,
      ).toEqual({ mafia: roleIcons.mafia, don: roleIcons.don, sheriff: roleIcons.sheriff });
    }
    for (const roleIcons of [
      { ghost: null },
      { citizen: { kind: "builtin", id: "unknown" } },
      { citizen: { kind: "builtin", id: "cat", url: "x" } },
      { citizen: { kind: "url", id: "cat" } },
      null,
      [],
    ]) {
      expect((await post({ ...basic(), roleIcons })).statusCode).toBe(400);
    }
    expect((await post({ ...basic(), unexpected: true })).statusCode).toBe(400);
  });

  it("normalizes four formats/slots, strips metadata, persists scalar selectors/private verified bytes and supports fresh readers", async () => {
    const input = consented();
    const jpeg = dataUrl(
      await sharp(Buffer.from(png.split(",")[1]!, "base64"))
        .jpeg()
        .toBuffer(),
      "jpeg",
    );
    const webp = dataUrl(
      await sharp(Buffer.from(png.split(",")[1]!, "base64"))
        .webp()
        .toBuffer(),
      "webp",
    );
    const created = await post({
      ...input,
      roleIcons: { citizen: image(png), mafia: image(jpeg), don: image(webp), sheriff: image(png) },
    });
    expect(created.statusCode, created.body).toBe(201);
    const profile = created.json().player;
    expect(Object.keys(profile.roleIcons)).toEqual(PLAYER_ICON_ROLES);
    expect(JSON.stringify(profile)).not.toContain("data:image");
    const response = await get(profile.id, member.id);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    const bundle = response.json<PlayerRoleIconBundle>();
    expect(bundle.version).toBe(profile.roleIconsVersion);
    expect(Object.keys(bundle.images)).toHaveLength(4);
    for (const value of Object.values(bundle.images)) {
      expect(value).toMatch(/^data:image\/webp;base64,/);
      const metadata = await sharp(Buffer.from(value.split(",")[1]!, "base64")).metadata();
      expect(metadata.width).toBeLessThanOrEqual(256);
      expect(metadata.height).toBeLessThanOrEqual(256);
      expect(metadata.width! / metadata.height!).toBe(2);
      expect(metadata.exif).toBeUndefined();
      expect(metadata.icc).toBeUndefined();
      expect(metadata.xmp).toBeUndefined();
    }
    const stored = (await row(profile.id))!;
    expect(typeof stored.roleIcons).toBe("string");
    expect(stored).not.toHaveProperty("images");
    const ref = blobReference(stored);
    const bytes = await fixture.storage.blobs.getBlockBlobClient(ref.name).downloadToBuffer();
    expect(bytes.length).toBe(ref.length);
    expect(digest(bytes)).toBe(ref.sha256);
    expect(JSON.parse(bytes.toString())).toMatchObject({
      clubId: DEFAULT_CLUB_ID,
      playerId: profile.id,
      version: bundle.version,
      images: bundle.images,
    });
    const reopened = new AzureStorage(fixture.options);
    expect(await new AzurePlayerStore(reopened).getRoleIcons(profile.id, DEFAULT_CLUB_ID)).toEqual(
      bundle,
    );
    await reopened.end();
    expect((await put(profile.id, input)).json().player.roleIcons).toEqual(profile.roleIcons);
    expect((await get(profile.id)).json()).toEqual(bundle);
    const retained = profile.roleIcons.citizen;
    expect(
      (await put(profile.id, { ...input, roleIcons: { don: retained, mafia: null } })).statusCode,
    ).toBe(200);
    expect((await get(profile.id)).json().images[retained.id]).toBe(bundle.images[retained.id]);
  });

  it("accepts four maximum-size transport slots under the existing aggregate HTTP ceiling", async () => {
    const original = Buffer.from(png.split(",")[1]!, "base64");
    const padding = Buffer.alloc(512 * 1024 - original.length);
    padding.writeUInt32BE(padding.length - 12);
    padding.write("npAD", 4, "ascii");
    padding.writeUInt32BE(crc32(padding.subarray(4, -4)), padding.length - 4);
    const max = dataUrl(Buffer.concat([original.subarray(0, 33), padding, original.subarray(33)]));
    const payload = {
      ...consented(),
      roleIcons: Object.fromEntries(PLAYER_ICON_ROLES.map((role) => [role, image(max)])),
    };
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(4 * 1024 * 1024);
    const response = await post(payload);
    expect(response.statusCode, response.body).toBe(201);
    expect(Object.keys((await get(response.json().player.id)).json().images)).toHaveLength(4);
    expect(
      JSON.stringify(
        (await app.inject({ method: "GET", url: "/api/players", headers: headers() })).json(),
      ),
    ).not.toContain("data:image");
  });

  it("enforces manager/member/anonymous/foreign-club reads and writes and exact player-owned refs", async () => {
    const { player, input } = await createUploaded();
    expect((await get(player.id, "anonymous")).statusCode).toBe(401);
    expect((await get(player.id, outsider.id)).statusCode).toBe(403);
    expect((await get(player.id, owner.id, randomUUID())).statusCode).toBe(403);
    expect((await put(player.id, input, member.id)).statusCode).toBe(403);
    expect((await put(player.id, input, outsider.id)).statusCode).toBe(403);
    const other = (await post(consented())).json().player;
    const before = await row(other.id);
    expect(
      (
        await put(other.id, {
          ...input,
          nickname: other.nickname,
          roleIcons: { citizen: player.roleIcons.citizen },
        })
      ).statusCode,
    ).toBe(400);
    expect(await row(other.id)).toEqual(before);
    expect(
      (await post({ ...consented(), roleIcons: { citizen: player.roleIcons.citizen } })).statusCode,
    ).toBe(400);
    const otherClub = await stores.clubs.create(owner, {
      name: "Other",
      city: "Test",
      language: "en",
      headerLogo: null,
      cardLogo: null,
      ownerConsent: true,
    });
    expect((await get(player.id, owner.id, otherClub.id)).statusCode).toBe(404);
    expect((await get(randomUUID())).statusCode).toBe(404);
    expect((await get("not-a-uuid")).statusCode).toBe(400);
  });

  it("rejects unsafe transport and decoder inputs without modifying profile/media", async () => {
    const { player, input } = await createUploaded();
    const before = await row(player.id);
    const bundle = (await get(player.id)).json();
    const hugePixels = dataUrl(
      await sharp({ create: { width: 2001, height: 2000, channels: 3, background: "white" } })
        .png()
        .toBuffer(),
    );
    const frames = Buffer.alloc(512);
    for (let offset = 0; offset < 256; offset += 4) {
      frames[offset] = 255;
      frames[offset + 1] = 0;
      frames[offset + 2] = 0;
      frames[offset + 3] = 255;
    }
    for (let offset = 256; offset < 512; offset += 4) {
      frames[offset] = 0;
      frames[offset + 1] = 0;
      frames[offset + 2] = 255;
      frames[offset + 3] = 255;
    }
    const animatedBytes = await sharp(frames, {
      raw: { width: 8, height: 16, channels: 4, pageHeight: 8 },
    })
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();
    expect((await sharp(animatedBytes).metadata()).pages).toBe(2);
    const animated = dataUrl(animatedBytes, "webp");
    const invalid = [
      "https://example.test/icon.png",
      "data:image/svg+xml;base64,PHN2Zy8+",
      png.replace("image/png", "image/jpeg"),
      "data:image/png;base64,%%%%",
      png + "\n",
      "data:image/png;base64,AAAA=",
      dataUrl(Buffer.from("not an image")),
      dataUrl(Buffer.from(png.split(",")[1]!, "base64").subarray(0, 50)),
      dataUrl(Buffer.alloc(512 * 1024 + 1)),
      hugePixels,
      animated,
    ];
    for (const bad of invalid) {
      const result = await put(player.id, {
        ...input,
        nickname: "Must not publish",
        roleIcons: { don: image(png), citizen: image(bad) },
      });
      expect(result.statusCode, bad.slice(0, 60) + result.body).toBe(400);
      expect(await row(player.id)).toEqual(before);
      expect((await get(player.id)).json()).toEqual(bundle);
    }
    expect((await post({ ...basic(), roleIcons: { citizen: image(png) } })).statusCode).toBe(400);
    expect(
      (await post({ ...basic(), consent: true, roleIcons: { citizen: image(png) } })).statusCode,
    ).toBe(400);
    expect(
      (await post({ ...input, roleIcons: { citizen: image("x".repeat(4 * 1024 * 1024)) } }))
        .statusCode,
    ).toBe(413);
  });

  it("preserves prior publication on failed staging, retries safely, retires replacements and protects live media under GC", async () => {
    const { player, input } = await createUploaded();
    const before = (await row(player.id))!;
    const original = fixture.storage.blobs.getBlockBlobClient.bind(fixture.storage.blobs);
    const spy = vi.spyOn(fixture.storage.blobs, "getBlockBlobClient").mockImplementation((name) => {
      const client = original(name);
      if (name !== before.blobName)
        vi.spyOn(client, "uploadData").mockRejectedValue(new Error("synthetic staging outage"));
      return client;
    });
    const failed = await put(player.id, { ...input, roleIcons: { citizen: image(png) } });
    expect(failed.statusCode).toBe(500);
    spy.mockRestore();
    expect(await row(player.id)).toEqual(before);
    const retried = await put(player.id, { ...input, roleIcons: { citizen: image(png) } });
    expect(retried.statusCode, retried.body).toBe(200);
    const current = (await row(player.id))!;
    expect(current.blobName).not.toBe(before.blobName);
    expect(await fixture.storage.read((tx) => tx.list("cleanup:"))).toEqual(
      expect.arrayContaining([expect.objectContaining({ blobName: before.blobName })]),
    );
    await collectStorageGarbage(fixture.storage);
    expect(await original(before.blobName as string).exists()).toBe(false);
    expect(await original(current.blobName as string).exists()).toBe(true);
    expect((await get(player.id)).statusCode).toBe(200);
  });

  it("detaches one upload at a time and rejects stale retained refs after the final reset", async () => {
    const { player, input } = await createUploaded();
    const retained = player.roleIcons.citizen;
    const original = (await row(player.id))!;
    expect((await put(player.id, { ...input, roleIcons: { don: retained } })).statusCode).toBe(200);
    expect((await get(player.id)).json().version).toBe(original.roleIconsVersion);
    const reset = await put(player.id, { ...input, roleIcons: { citizen: null } });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().player.roleIcons).toEqual({
      mafia: { kind: "builtin", id: "cat" },
      don: retained,
    });
    expect(Object.keys((await get(player.id)).json().images)).toEqual([retained.id]);
    expect((await put(player.id, { ...input, roleIcons: { don: null } })).statusCode).toBe(200);
    expect((await get(player.id)).json()).toEqual({ version: null, images: {} });
    expect(await row(player.id)).not.toHaveProperty("blobName");
    expect((await put(player.id, { ...input, roleIcons: { sheriff: retained } })).statusCode).toBe(
      400,
    );
    await collectStorageGarbage(fixture.storage);
    expect(
      await fixture.storage.blobs.getBlockBlobClient(original.blobName as string).exists(),
    ).toBe(false);
  });

  it("leaves failed Table publication orphaned, proves a lost commit response and collects only unreferenced staging", async () => {
    const { player, input } = await createUploaded();
    const before = (await row(player.id))!;
    const oldBundle = (await get(player.id)).json();
    const failedSubmit = vi
      .spyOn(fixture.storage.table, "submitTransaction")
      .mockRejectedValueOnce(new Error("synthetic Table outage"));
    expect(
      (await put(player.id, { ...input, roleIcons: { citizen: image(png) } })).statusCode,
    ).toBe(500);
    failedSubmit.mockRestore();
    expect(await row(player.id)).toEqual(before);
    expect((await get(player.id)).json()).toEqual(oldBundle);
    const staged: string[] = [];
    for await (const blob of fixture.storage.blobs.listBlobsFlat())
      if (blob.name.includes(`/player/${player.id}/role-icons/`)) staged.push(blob.name);
    expect(staged).toHaveLength(2);
    const submit = fixture.storage.table.submitTransaction.bind(fixture.storage.table);
    vi.spyOn(fixture.storage.table, "submitTransaction").mockImplementationOnce(async (...args) => {
      await submit(...args);
      throw new Error("response lost after real commit");
    });
    const successful = await put(player.id, { ...input, roleIcons: { citizen: image(png) } });
    expect(successful.statusCode, successful.body).toBe(200);
    const published = (await row(player.id))!;
    expect((await get(player.id)).json().version).toBe(successful.json().player.roleIconsVersion);
    vi.restoreAllMocks();
    await collectStorageGarbage(fixture.storage);
    for (const name of staged)
      expect(await fixture.storage.blobs.getBlockBlobClient(name).exists()).toBe(false);
    expect(
      await fixture.storage.blobs.getBlockBlobClient(published.blobName as string).exists(),
    ).toBe(true);
  });

  it("re-resolves retained refs after competing withdrawal rather than resurrecting erased media", async () => {
    const { player, input } = await createUploaded();
    const competing = new AzureStorage(fixture.options);
    const submit = fixture.storage.table.submitTransaction.bind(fixture.storage.table);
    vi.spyOn(fixture.storage.table, "submitTransaction").mockImplementationOnce(async (...args) => {
      await new AzurePlayerStore(competing).update(
        player.id,
        { nickname: player.nickname, consent: false, firstName: null, lastName: null, email: null },
        DEFAULT_CLUB_ID,
        owner.id,
      );
      return submit(...args);
    });
    const stale = await put(player.id, { ...input, roleIcons: { don: player.roleIcons.citizen } });
    expect(stale.statusCode, stale.body).toBe(400);
    expect((await row(player.id))!.consent).toBe(false);
    expect((await get(player.id)).json()).toEqual({ version: null, images: {} });
    expect((await row(player.id))!).not.toHaveProperty("blobName");
    await competing.end();
  });

  it("fails closed for missing/corrupt/foreign private authority without a default-data fallback", async () => {
    const { player, input } = await createUploaded();
    const original = (await row(player.id))!;
    const ref = blobReference(original);
    const client = fixture.storage.blobs.getBlockBlobClient(ref.name);
    const bytes = await client.downloadToBuffer();
    await client.uploadData(Buffer.from("corrupt bytes"));
    expect((await get(player.id)).statusCode).toBe(500);
    expect((await put(player.id, input)).statusCode).toBe(500);
    expect(await row(player.id)).toEqual(original);
    await client.delete();
    expect((await get(player.id)).statusCode).toBe(500);
    await client.uploadData(bytes);
    const foreign = await createUploaded();
    const foreignRow = (await row(foreign.player.id))!;
    await fixture.storage.mutate((tx) =>
      tx.set(`club:${DEFAULT_CLUB_ID}:player:${player.id}`, {
        ...original,
        blobName: foreignRow.blobName,
        blobSha256: foreignRow.blobSha256,
        blobLength: foreignRow.blobLength,
      }),
    );
    expect((await get(player.id)).statusCode).toBe(500);
    await fixture.storage.mutate((tx) =>
      tx.set(`club:${DEFAULT_CLUB_ID}:player:${player.id}`, original),
    );
    expect((await get(player.id)).statusCode).toBe(200);
  });

  it("withdraws omitted uploads, preserves builtins, protects linked Owner and clears retirement/purge authority", async () => {
    const { player } = await createUploaded();
    const before = (await row(player.id))!;
    const withdrawn = await put(player.id, { nickname: player.nickname, consent: false });
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    expect(withdrawn.json().player.roleIcons).toEqual({ mafia: { kind: "builtin", id: "cat" } });
    expect((await row(player.id))!).not.toHaveProperty("blobName");
    expect((await get(player.id)).json()).toEqual({ version: null, images: {} });
    const locked = (await players.list(DEFAULT_CLUB_ID)).find((p) => p.managerLocked)!;
    const ownerInput = {
      nickname: "Owner",
      consent: true,
      firstName: "Icon",
      lastName: "Owner",
      email: owner.email,
      clubAccess: "manager",
      roleIcons: { citizen: image(png), sheriff: { kind: "builtin", id: "shield" } },
    };
    expect((await put(locked.id, ownerInput)).statusCode).toBe(200);
    await fixture.storage.mutate((tx) =>
      tx.set(`club:${DEFAULT_CLUB_ID}:member:${outsider.id}`, {
        userId: outsider.id,
        role: "manager",
      }),
    );
    expect((await put(locked.id, ownerInput, outsider.id)).statusCode).toBe(403);
    expect(
      (await put(locked.id, { nickname: "Owner", consent: false, clubAccess: "manager" }))
        .statusCode,
    ).toBe(200);
    expect((await get(locked.id)).json()).toEqual({ version: null, images: {} });
    expect(await stores.clubs.getRole(owner.id, DEFAULT_CLUB_ID)).toBe("manager");
    expect(await players.delete(player.id, DEFAULT_CLUB_ID)).toBe("deleted");
    expect((await get(player.id)).statusCode).toBe(404);
    expect(await row(player.id)).not.toHaveProperty("roleIcons");
    const uploaded = await createUploaded();
    const live = (await row(uploaded.player.id))!;
    expect(await players.delete(uploaded.player.id, DEFAULT_CLUB_ID)).toBe("deleted");
    expect(await row(uploaded.player.id)).not.toHaveProperty("blobName");
    await collectStorageGarbage(fixture.storage);
    expect(await fixture.storage.blobs.getBlockBlobClient(before.blobName as string).exists()).toBe(
      false,
    );
    expect(await fixture.storage.blobs.getBlockBlobClient(live.blobName as string).exists()).toBe(
      false,
    );
  });

  it("purges failed-create/update staging on club deletion, resumes orphan failures and preserves foreign staging", async () => {
    const createClub = (name: string) =>
      stores.clubs.create(owner, {
        name,
        city: "Test",
        language: "en",
        headerLogo: null,
        cardLogo: null,
        ownerConsent: true,
      });
    const doomed = await createClub("Orphan purge");
    const survivor = await createClub("Unrelated staging");
    const input = () => ({ ...consented(), roleIcons: { citizen: image(png) } });
    const live = await players.create(input(), doomed.id);
    await players.create(input(), survivor.id);
    const failPublication = async (work: () => Promise<unknown>) => {
      const submit = vi
        .spyOn(fixture.storage.table, "submitTransaction")
        .mockRejectedValueOnce(new Error("staging-only write"));
      await expect(work()).rejects.toThrow("Storage publication failed");
      submit.mockRestore();
    };
    await failPublication(() => players.create(input(), doomed.id));
    await failPublication(() =>
      players.update(live.id, { ...input(), nickname: live.nickname }, doomed.id, owner.id),
    );
    await failPublication(() => players.create(input(), survivor.id));
    const blobs = async (clubId: string) => {
      const result: string[] = [];
      const prefix = `${fixture.storage.blobPrefix(await fixture.storage.getControl())}/club/${clubId}/`;
      for await (const blob of fixture.storage.blobs.listBlobsFlat({ prefix }))
        result.push(blob.name);
      return result.sort();
    };
    const owned = await blobs(doomed.id);
    const foreign = await blobs(survivor.id);
    expect(owned).toHaveLength(3);
    expect(foreign).toHaveLength(2);
    const liveRow = await fixture.storage.read((tx) =>
      tx.get<Record<string, unknown>>(`club:${doomed.id}:player:${live.id}`),
    );
    const orphan = owned.find((name) => name !== liveRow!.blobName)!;
    const remove = fixture.storage.deleteOwnedBlob.bind(fixture.storage);
    const failPurge = vi
      .spyOn(fixture.storage, "deleteOwnedBlob")
      .mockImplementation(async (name) => {
        if (name === orphan) throw new Error("orphan purge interrupted");
        return remove(name);
      });
    await expect(stores.clubs.delete(owner.id, doomed.id)).rejects.toThrow(
      "orphan purge interrupted",
    );
    failPurge.mockRestore();
    expect((await get(live.id, owner.id, doomed.id)).statusCode).toBe(403);
    expect(await stores.clubs.resumeDeletion!(owner.id, doomed.id)).toBe(true);
    expect(await blobs(doomed.id)).toEqual([]);
    expect(await blobs(survivor.id)).toEqual(foreign);
    for (const name of foreign)
      expect(await fixture.storage.blobs.getBlockBlobClient(name).exists()).toBe(true);
  });

  it.each(["create", "update"] as const)(
    "reports unguaranteed physical cleanup when a late %s upload overlaps club deletion",
    async (operation) => {
      const doomed = await stores.clubs.create(owner, {
        name: "Late staging",
        city: "Test",
        language: "en",
        headerLogo: null,
        cardLogo: null,
        ownerConsent: true,
      });
      const target = await players.create(consented(), doomed.id);
      const survivor = await createUploaded();
      const survivorBundle = await players.getRoleIcons(survivor.player.id, DEFAULT_CLUB_ID);
      // An independent SDK/client instance rules out an in-process mutex fix.
      const writerStorage = new AzureStorage(fixture.options);
      const writer = new AzurePlayerStore(writerStorage);
      const client = writerStorage.blobs.getBlockBlobClient.bind(writerStorage.blobs);
      let release!: () => void;
      const pendingUpload = new Promise<void>((resolve) => {
        release = resolve;
      });
      let lateName: string | undefined;
      const intercept = vi
        .spyOn(writerStorage.blobs, "getBlockBlobClient")
        .mockImplementation((name) => {
          const blob = client(name);
          if (name.includes(`/club/${doomed.id}/player/`)) {
            const upload = blob.uploadData.bind(blob);
            vi.spyOn(blob, "uploadData").mockImplementation(async (...args) => {
              if (!lateName) {
                lateName = name;
                await pendingUpload;
              }
              return upload(...args);
            });
          }
          return blob;
        });
      const input = { ...consented(), roleIcons: { citizen: image(png) } };
      const writing = (
        operation === "create"
          ? writer.create(input, doomed.id)
          : writer.update(target.id, input, doomed.id, owner.id)
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await vi.waitFor(() => expect(lateName).toBeDefined());
        // Do not release bytes until the deletion attempt has returned.
        const deletion = await app.inject({
          method: "DELETE",
          url: `/api/clubs/${doomed.id}`,
          headers: headers(owner.id, doomed.id),
        });
        expect(deletion.statusCode, deletion.body).toBe(200);
        expect(deletion.json()).toEqual({ deleted: true, physicalCleanup: "not_guaranteed" });
        expect((await get(target.id, owner.id, doomed.id)).statusCode).toBe(403);
      } finally {
        release();
        await writing;
        intercept.mockRestore();
        await writerStorage.end();
      }
      const outcome = await writing;
      expect("error" in outcome || outcome.value === null, "stale save must not publish").toBe(
        true,
      );
      // Physical bytes may remain: this result promises access revocation, not erasure.
      expect((await get(target.id, owner.id, doomed.id)).statusCode).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/players",
            headers: headers(owner.id, doomed.id),
            payload: input,
          })
        ).statusCode,
      ).toBe(403);
      expect(await players.list(doomed.id)).toEqual([]);
      expect(await players.getRoleIcons(survivor.player.id, DEFAULT_CLUB_ID)).toEqual(
        survivorBundle,
      );
    },
  );

  it("backs up/restores exact live player envelopes and resumably purges only the deleted club's media", async () => {
    const { player } = await createUploaded();
    const original = (await row(player.id))!;
    const bundle = (await get(player.id)).json();
    const root = fileURLToPath(new URL("../../../.AI/role-icon-tests/", import.meta.url));
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = join(await mkdtemp(join(root, "run-")), "backup");
    const manifest = await captureStorageBackup(fixture.storage, directory, {
      applicationVersion: "role-icons-test",
      applicationCommit: "synthetic",
    });
    expect(manifest.blobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: original.blobName,
          sha256: original.blobSha256,
          length: original.blobLength,
        }),
      ]),
    );
    const suffix = randomUUID().replaceAll("-", "");
    const target = new AzureStorage({
      ...fixture.options,
      tableName: `Restore${suffix}`,
      containerName: `restore-${suffix}`,
    });
    await restoreStorageBackup(target, directory);
    expect(await new AzurePlayerStore(target).getRoleIcons(player.id, DEFAULT_CLUB_ID)).toEqual(
      bundle,
    );
    await target.end();
    const survivor = await stores.clubs.create(owner, {
      name: "Survivor",
      city: "Test",
      language: "en",
      headerLogo: null,
      cardLogo: null,
      ownerConsent: true,
    });
    const survivorPlayer = await players.create(
      { ...consented(), roleIcons: { don: image(png) } },
      survivor.id,
    );
    const survivorBefore = await fixture.storage.read((tx) =>
      tx.get<Record<string, unknown>>(`club:${survivor.id}:player:${survivorPlayer.id}`),
    );
    await players.update(
      survivorPlayer.id,
      { ...consented(), roleIcons: { don: image(png) } },
      survivor.id,
      owner.id,
    );
    const preserved = await players.getRoleIcons(survivorPlayer.id, survivor.id);
    const fail = vi
      .spyOn(fixture.storage, "deleteBlob")
      .mockRejectedValueOnce(new Error("synthetic purge outage"));
    await expect(stores.clubs.delete(owner.id, DEFAULT_CLUB_ID)).rejects.toThrow(
      "synthetic purge outage",
    );
    fail.mockRestore();
    expect((await get(player.id)).statusCode).toBe(403);
    expect(await stores.clubs.delete(owner.id, DEFAULT_CLUB_ID)).toBe(true);
    expect(
      await fixture.storage.blobs.getBlockBlobClient(original.blobName as string).exists(),
    ).toBe(false);
    expect(await fixture.storage.read((tx) => tx.list(`club:${DEFAULT_CLUB_ID}:`))).toEqual([]);
    expect(await players.getRoleIcons(survivorPlayer.id, survivor.id)).toEqual(preserved);
    expect(
      await fixture.storage.blobs.getBlockBlobClient(survivorBefore!.blobName as string).exists(),
    ).toBe(true);
    expect(await fixture.storage.read((tx) => tx.list("cleanup:"))).toEqual(
      expect.arrayContaining([expect.objectContaining({ blobName: survivorBefore!.blobName })]),
    );
  }, 60_000);
});
