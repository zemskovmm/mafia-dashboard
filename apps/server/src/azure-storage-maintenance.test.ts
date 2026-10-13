import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AzureStorage, blobFields, type BlobReference } from "./azure-storage.js";
import { AzureClubStore } from "./azure-club-player-store.js";
import { collectStorageGarbage } from "./azure-storage-maintenance.js";
import { createStorageFixture } from "./test-helpers/storage-fixture.js";

let fixture: Awaited<ReturnType<typeof createStorageFixture>>;
beforeAll(async () => {
  fixture = await createStorageFixture();
});
afterAll(async () => {
  await fixture?.close();
});

// Real emulator roots/deletions; shared fixture is collected after each scenario.
describe("frozen bounded storage garbage collection", () => {
  it("deletes orphans and retired objects but preserves game/logo/music/protected roots and foreign namespaces", async () => {
    const { storage, options } = fixture;
    let orphan!: BlobReference;
    let retired!: BlobReference;
    let protectedRef!: BlobReference;
    const live: BlobReference[] = [];
    await storage.mutate(async (tx) => {
      orphan = await tx.writeBlob({ orphan: true });
      retired = await tx.writeBlob("retired");
      await tx.retireBlob(retired);
      protectedRef = await tx.writeBlob({ backup: true });
      for (const kind of ["game", "header", "card", "token"]) {
        const ref = await tx.writeBlob(kind);
        live.push(ref);
        await tx.set(
          `sample:gc:${kind}`,
          kind === "game"
            ? blobFields(ref)
            : {
                [`${kind}BlobName`]: ref.name,
                [`${kind}BlobSha256`]: ref.sha256,
                [`${kind}BlobLength`]: ref.length,
              },
        );
      }
      // A stale retirement record must not override a committed live root.
      await tx.retireBlob(live[0]!);
    });
    const other = new AzureStorage({ ...options, partitionKey: `other-${randomUUID()}` });
    await other.initialize(true);
    const foreign = await other.mutate((tx) => tx.writeBlob({ foreign: true }));
    const backupName = `backups/${randomUUID()}/manifest.json`;
    await storage.blobs
      .getBlockBlobClient(backupName)
      .uploadData(Buffer.from("independent backup"));
    const receipts = await storage.read((tx) => tx.list("commit:"));
    expect(await collectStorageGarbage(storage, [protectedRef])).toEqual({
      deletedBlobs: 2,
      deletedRows: 1,
    });
    for (const ref of [orphan, retired])
      expect(await storage.blobs.getBlockBlobClient(ref.name).exists()).toBe(false);
    for (const ref of [...live, protectedRef, foreign])
      expect(await storage.blobs.getBlockBlobClient(ref.name).exists()).toBe(true);
    expect(await storage.blobs.getBlockBlobClient(backupName).exists()).toBe(true);
    for (const receipt of receipts) expect(await storage.getEntity(receipt.rowKey)).toBeDefined();
    expect(await collectStorageGarbage(storage, [protectedRef])).toEqual({
      deletedBlobs: 0,
      deletedRows: 0,
    });
    await storage.mutate(async (tx) => {
      for (const kind of ["game", "header", "card", "token"]) await tx.delete(`sample:gc:${kind}`);
    });
    await collectStorageGarbage(storage);
  });

  it("cleans more than one Table batch including already-missing retired objects", async () => {
    const { storage } = fixture;
    for (let start = 0; start < 110; start += 55)
      await storage.mutate(async (tx) => {
        for (let i = start; i < start + 55; i++) {
          const ref = await tx.writeBlob({ i });
          await tx.retireBlob(ref);
          await storage.blobs.deleteBlob(ref.name);
        }
      });
    const submit = vi.spyOn(storage.table, "submitTransaction");
    try {
      expect(await collectStorageGarbage(storage)).toEqual({ deletedBlobs: 0, deletedRows: 110 });
      expect(submit.mock.calls.length).toBeGreaterThan(3);
      expect(submit.mock.calls.every(([actions]) => actions.length <= 100)).toBe(true);
      expect(await storage.read((tx) => tx.list("cleanup:"))).toEqual([]);
    } finally {
      submit.mockRestore();
    }
  });

  it("does no physical cleanup when live/protected authority is malformed or foreign", async () => {
    const { storage } = fixture;
    const ref = await storage.mutate(async (tx) => {
      await tx.set("sample:gc:invalid", { headerBlobName: "invalid" });
      return tx.writeBlob({ preserveOnError: true });
    });
    await expect(collectStorageGarbage(storage)).rejects.toThrow(/reference/i);
    expect(await storage.blobs.getBlockBlobClient(ref.name).exists()).toBe(true);
    expect((await storage.getControl()).writeMode).toBe("normal");
    await storage.mutate((tx) => tx.delete("sample:gc:invalid"));
    await expect(
      collectStorageGarbage(storage, [{ ...ref, name: "backups/foreign" }]),
    ).rejects.toThrow(/dataset/i);
    expect(await storage.blobs.getBlockBlobClient(ref.name).exists()).toBe(true);
    await collectStorageGarbage(storage);
  });

  it("fails explicitly before collecting anything when a live referenced object is missing", async () => {
    const { storage } = fixture;
    let live!: BlobReference;
    const orphan = await storage.mutate(async (tx) => {
      live = await tx.writeBlob("missing live object");
      await tx.set("sample:gc:missing", blobFields(live));
      return tx.writeBlob("must survive validation failure");
    });
    await storage.blobs.deleteBlob(live.name);
    try {
      await expect(collectStorageGarbage(storage)).rejects.toThrow(
        /missing|unreadable|authoritative/i,
      );
      expect(await storage.blobs.getBlockBlobClient(orphan.name).exists()).toBe(true);
    } finally {
      await storage.mutate((tx) => tx.delete("sample:gc:missing"));
      await collectStorageGarbage(storage);
    }
  });

  it("restages an async upload that completes after a maintenance cycle", async () => {
    const { storage, options } = fixture;
    const maintenance = new AzureStorage(options);
    const getClient = storage.blobs.getBlockBlobClient.bind(storage.blobs);
    const uploadedNames: string[] = [];
    let delayed = false;
    const clients = vi.spyOn(storage.blobs, "getBlockBlobClient").mockImplementation((name) => {
      const client = getClient(name);
      const upload = client.uploadData.bind(client);
      vi.spyOn(client, "uploadData").mockImplementationOnce(async (data, options) => {
        uploadedNames.push(name);
        if (!delayed) {
          delayed = true;
          await collectStorageGarbage(maintenance);
        }
        return upload(data, options);
      });
      return client;
    });
    try {
      await storage.mutate(async (tx) => {
        const ref = await tx.writeBlob({ lateUpload: true });
        await tx.set("sample:gc:async", blobFields(ref));
      });
    } finally {
      clients.mockRestore();
    }
    expect(uploadedNames).toHaveLength(2);
    expect(uploadedNames[0]).not.toBe(uploadedNames[1]);
    const published = await storage.read((tx) => tx.get<{ blobName: string }>("sample:gc:async"));
    expect(published!.blobName).toBe(uploadedNames[1]);
    expect(await storage.blobs.getBlockBlobClient(uploadedNames[0]!).exists()).toBe(true);
    expect(await collectStorageGarbage(storage)).toEqual({ deletedBlobs: 1, deletedRows: 0 });
    expect(await storage.blobs.getBlockBlobClient(uploadedNames[1]!).exists()).toBe(true);
    await storage.mutate((tx) => tx.delete("sample:gc:async"));
    await collectStorageGarbage(storage);
  });

  it("retries a reader and restages a late writer after maintenance deletes its old staging", async () => {
    const { storage, options } = fixture;
    const maintenance = new AzureStorage(options);
    const orphan = await storage.mutate((tx) => tx.writeBlob({ stale: true }));
    let reads = 0;
    expect(
      await storage.read(async (tx) => {
        reads++;
        if (reads === 1) {
          await collectStorageGarbage(maintenance);
          return tx.readBlob(orphan);
        }
        return "latest";
      }),
    ).toBe("latest");
    expect(reads).toBe(2);
    const staged: BlobReference[] = [];
    await storage.mutate(async (tx) => {
      const ref = await tx.writeBlob({ retry: staged.length });
      staged.push(ref);
      if (staged.length === 1) await collectStorageGarbage(maintenance);
      await tx.set("sample:gc:late", blobFields(ref));
    });
    expect(staged).toHaveLength(2);
    expect(staged[0]!.name).not.toBe(staged[1]!.name);
    expect(await storage.blobs.getBlockBlobClient(staged[0]!.name).exists()).toBe(false);
    expect(await storage.read(async (tx) => tx.readBlob(staged[1]!))).toEqual({ retry: 1 });
    await storage.mutate((tx) => tx.delete("sample:gc:late"));
    await collectStorageGarbage(storage);
  });

  it("resumes a purge interrupted after physical deletion but before its Table chunk committed", async () => {
    const { storage } = fixture;
    const clubs = new AzureClubStore(storage);
    const actor = {
      id: randomUUID(),
      email: `${randomUUID()}@example.test`,
      name: "Manager",
      picture: null,
    };
    await storage.mutate((tx) =>
      tx.set(`user:${actor.id}`, { ...actor, createdAt: new Date(), updatedAt: new Date() }),
    );
    const club = await clubs.create(actor, {
      name: "Interrupted purge",
      city: "London",
      language: "en",
      headerLogo: "deleted before commit",
      cardLogo: null,
      ownerConsent: true,
    });
    const row = await storage.read((tx) =>
      tx.get<{ headerBlobName: string }>(`club:${club.id}:meta`),
    );
    const submit = storage.table.submitTransaction.bind(storage.table);
    let interrupted = false;
    const publication = vi
      .spyOn(storage.table, "submitTransaction")
      .mockImplementation(async (actions, options) => {
        if (
          !interrupted &&
          actions.some(
            ([operation, entity]) =>
              operation === "delete" && entity.rowKey.startsWith(`club:${club.id}:`),
          )
        ) {
          interrupted = true;
          throw new Error("purge chunk publication failed");
        }
        return submit(actions, options);
      });
    try {
      await expect(clubs.delete(actor.id, club.id)).rejects.toThrow(/publication/i);
    } finally {
      publication.mockRestore();
    }
    expect(interrupted).toBe(true);
    expect(await storage.blobs.getBlockBlobClient(row!.headerBlobName).exists()).toBe(false);
    expect(await storage.read((tx) => tx.get(`club:${club.id}:meta`))).toBeDefined();
    expect(await clubs.getRole(actor.id, club.id)).toBeNull();
    expect((await storage.getControl()).writeMode).toBe("normal");
    expect(await clubs.resumeDeletion(randomUUID(), club.id)).toBe(false);
    expect(await clubs.resumeDeletion(actor.id, club.id)).toBe(true);
    expect(await storage.read((tx) => tx.list(`club:${club.id}:`))).toEqual([]);
  });

  it("keeps interrupted closed-club purge hidden during capture and resumes only for its original manager", async () => {
    const { storage, options } = fixture;
    const clubs = new AzureClubStore(storage);
    const actor = {
      id: randomUUID(),
      email: `${randomUUID()}@example.test`,
      name: "Manager",
      picture: null,
    };
    await storage.mutate((tx) =>
      tx.set(`user:${actor.id}`, { ...actor, createdAt: new Date(), updatedAt: new Date() }),
    );
    const club = await clubs.create(actor, {
      name: "Purge",
      city: "London",
      language: "en",
      headerLogo: "kept",
      cardLogo: null,
      ownerConsent: true,
    });
    const control = new AzureStorage(options);
    const captureOwner = randomUUID();
    const acquire = vi.spyOn(storage, "withMaintenanceFreeze").mockImplementationOnce(async () => {
      await control.acquireFreeze(captureOwner);
      throw new Error("capture won before physical purge");
    });
    try {
      await expect(clubs.delete(actor.id, club.id)).rejects.toThrow(/capture won/i);
    } finally {
      acquire.mockRestore();
    }
    expect(await clubs.getRole(actor.id, club.id)).toBeNull();
    expect(await clubs.listForUser(actor.id)).toEqual([]);
    const row = await storage.read((tx) =>
      tx.get<{ headerBlobName: string }>(`club:${club.id}:meta`),
    );
    expect(await storage.blobs.getBlockBlobClient(row!.headerBlobName).exists()).toBe(true);
    await expect(clubs.resumeDeletion(actor.id, club.id)).rejects.toThrow(/frozen/i);
    expect(await clubs.resumeDeletion(randomUUID(), club.id)).toBe(false);
    await control.releaseFreeze(captureOwner);
    expect(await clubs.resumeDeletion(actor.id, club.id)).toBe(true);
    expect(await storage.blobs.getBlockBlobClient(row!.headerBlobName).exists()).toBe(false);
  });
});
