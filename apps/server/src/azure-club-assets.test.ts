import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AzureClubStore } from "./azure-club-player-store.js";
import { createStorageFixture } from "./test-helpers/storage-fixture.js";

let fixture: Awaited<ReturnType<typeof createStorageFixture>>;
let clubs: AzureClubStore;
const settings = {
  name: "Assets",
  city: "London",
  language: "en" as const,
  headerLogo: null,
  cardLogo: null,
  ownerConsent: true as const,
};
const createClub = async () => {
  const account = {
    id: randomUUID(),
    email: `${randomUUID()}@example.test`,
    name: "Manager",
    picture: null,
  };
  await fixture.storage.mutate((tx) =>
    tx.set(`user:${account.id}`, { ...account, createdAt: new Date(), updatedAt: new Date() }),
  );
  return { account, club: await clubs.create(account, settings) };
};
beforeAll(async () => {
  fixture = await createStorageFixture();
  clubs = new AzureClubStore(fixture.storage);
});
afterAll(async () => {
  await fixture?.close();
});

// Real owned-emulator readbacks prove physical deletion, not only hidden metadata.
describe("club asset purge ownership", () => {
  it("purges replaced and cleared logos across case-variant club IDs", async () => {
    const { account, club } = await createClub();
    await clubs.update(account.id, club.id.toUpperCase(), {
      ...settings,
      headerLogo: "old header",
      cardLogo: "old card",
    });
    const old = await fixture.storage.read((tx) =>
      tx.get<{ headerBlobName: string; cardBlobName: string }>(`club:${club.id}:meta`),
    );
    await clubs.update(account.id, club.id, {
      ...settings,
      headerLogo: "new header",
      cardLogo: null,
    });
    const current = await fixture.storage.read((tx) =>
      tx.get<{ headerBlobName: string }>(`club:${club.id}:meta`),
    );
    const names = [old!.headerBlobName, old!.cardBlobName, current!.headerBlobName];
    for (const name of names)
      expect(await fixture.storage.blobs.getBlockBlobClient(name).exists()).toBe(true);
    expect(await clubs.delete(account.id, club.id)).toBe(true);
    for (const name of names)
      expect(await fixture.storage.blobs.getBlockBlobClient(name).exists()).toBe(false);
    expect(await fixture.storage.read((tx) => tx.list("cleanup:"))).toEqual([]);
    expect(await fixture.storage.read((tx) => tx.list(`club:${club.id}:`))).toEqual([]);
  });

  it("purges legacy uppercase asset paths without deleting another club's retired assets", async () => {
    const doomed = await createClub();
    const survivor = await createClub();
    const retire = (clubId: string) =>
      fixture.storage.mutate(async (tx) => {
        const ref = await tx.writeBlob("legacy logo", `club/${clubId.toUpperCase()}/header`);
        await tx.retireBlob(ref);
        return ref;
      });
    const retired = await retire(doomed.club.id);
    const preserved = await retire(survivor.club.id);
    expect(await clubs.delete(doomed.account.id, doomed.club.id.toUpperCase())).toBe(true);
    expect(await fixture.storage.blobs.getBlockBlobClient(retired.name).exists()).toBe(false);
    expect(await fixture.storage.blobs.getBlockBlobClient(preserved.name).exists()).toBe(true);
    expect(
      await fixture.storage.read((tx) => tx.list<{ blobName: string }>("cleanup:")),
    ).toMatchObject([{ blobName: preserved.name }]);
    expect(await clubs.getRole(survivor.account.id, survivor.club.id)).toBe("manager");
    expect(await clubs.delete(survivor.account.id, survivor.club.id)).toBe(true);
    expect(await fixture.storage.blobs.getBlockBlobClient(preserved.name).exists()).toBe(false);
  });
});
