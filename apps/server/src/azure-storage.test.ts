import { randomUUID } from "node:crypto";
import { DefaultAzureCredential } from "@azure/identity";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AzureStorage, blobReference, validateTableEntity, uuidKey } from "./azure-storage.js";
import { createStorageFixture } from "./test-helpers/storage-fixture.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(closers.splice(0).map((close) => close()));
});
const fixture = async () => {
  const value = await createStorageFixture();
  closers.push(value.close);
  return value;
};

describe("Azure authoritative persistence", () => {
  it("uses the explicit credential for both services without falling back", async () => {
    const fallback = vi
      .spyOn(DefaultAzureCredential.prototype, "getToken")
      .mockRejectedValue(new Error("Default credential must not be used"));
    const denied = new Error("Explicit credential denied access");
    const credential = { getToken: vi.fn().mockRejectedValue(denied) };
    const storage = new AzureStorage(
      {
        accountName: "credentialtestonly",
        tableName: "CredentialProof",
        containerName: "credential-proof",
        partitionKey: "credential-proof",
      },
      credential,
    );
    // Denial occurs in the real SDK authentication pipeline, before network I/O.
    await expect(storage.getControl()).rejects.toBe(denied);
    await expect(storage.blobs.getProperties()).rejects.toBe(denied);
    expect(credential.getToken).toHaveBeenCalledTimes(2);
    expect(fallback).not.toHaveBeenCalled();
    expect(AzureStorage.explicitCredentialSupported).toBe(true);
  });

  it("rejects an explicit credential combined with a connection string", async () => {
    const { options } = await fixture();
    expect(() => new AzureStorage(options, { getToken: vi.fn() })).toThrow(
      "Explicit credentials cannot be combined with a connection string",
    );
  });

  it("preserves explicit EDM DateTime precision and rejects malformed wrappers", async () => {
    const { storage } = await fixture();
    const exact = "2026-09-30T12:34:56.1234567Z";
    await storage.mutate((tx) =>
      tx.set("precise", { createdAt: { type: "DateTime", value: exact } }),
    );
    const row = await storage.table.getEntity(storage.options.partitionKey, "precise", {
      disableTypeConversion: true,
    });
    expect(row.createdAt).toEqual({ type: "DateTime", value: exact });
    for (const value of [
      "2026-02-30T00:00:00Z",
      "1600-01-01T00:00:00Z",
      "2026-01-01T00:00:00.12345678Z",
      "not-a-date",
    ]) {
      expect(() => validateTableEntity({ value: { type: "DateTime", value } })).toThrow();
    }
    expect(() =>
      validateTableEntity({ value: { type: "DateTime", value: exact, extra: true } }),
    ).toThrow();
  });

  it("rejects a UTF-8-oversized batch without publishing a prefix", async () => {
    const { storage } = await fixture();
    const submit = vi.spyOn(storage.table, "submitTransaction");
    await expect(
      storage.mutate(async (tx) => {
        for (let i = 0; i < 50; i++) await tx.set(`large:${i}`, { value: "\u0800".repeat(32_000) });
      }),
    ).rejects.toThrow(/transaction/i);
    expect(submit).not.toHaveBeenCalled();
    expect(await storage.read((tx) => tx.list("large:"))).toEqual([]);
  });

  it("preserves unknown schemas without startup reset", async () => {
    const { storage } = await fixture();
    const control = await storage.table.getEntity(storage.options.partitionKey, "control");
    await storage.table.updateEntity(
      {
        ...control,
        partitionKey: storage.options.partitionKey,
        rowKey: "control",
        schemaVersion: 99,
      },
      "Replace",
      { etag: control.etag },
    );
    const before = await storage.table.getEntity(storage.options.partitionKey, "control");
    await expect(storage.initialize(true)).rejects.toThrow(/unsupported/i);
    const after = await storage.table.getEntity(storage.options.partitionKey, "control");
    expect(after.etag).toBe(before.etag);
    expect(after.schemaVersion).toBe(99);
  });

  it("fails closed for selected missing or corrupted blobs", async () => {
    const { storage } = await fixture();
    const ref = await storage.mutate((tx) => tx.writeBlob({ exact: "bytes" }));
    await storage.blobs
      .getBlockBlobClient(ref.name)
      .uploadData(Buffer.from(JSON.stringify({ exact: "wrong" })));
    await expect(storage.read((tx) => tx.readBlob(ref))).rejects.toMatchObject({ statusCode: 503 });
    await storage.blobs.deleteBlob(ref.name);
    await expect(storage.read((tx) => tx.readBlob(ref))).rejects.toMatchObject({ statusCode: 503 });
  });

  it("serves reads but blocks mutations for a frozen dataset", async () => {
    const { storage } = await fixture();
    await storage.mutate((tx) => tx.set("sample:value", { value: "saved" }));
    const control = await storage.table.getEntity(storage.options.partitionKey, "control");
    await storage.table.updateEntity(
      {
        ...control,
        partitionKey: storage.options.partitionKey,
        rowKey: "control",
        writeMode: "backup-frozen",
      },
      "Replace",
      { etag: control.etag },
    );
    expect(await storage.read((tx) => tx.get("sample:value"))).toMatchObject({ value: "saved" });
    await expect(
      storage.mutate((tx) => tx.set("sample:value", { value: "not saved" })),
    ).rejects.toThrow(/frozen/i);
  });

  it("checks production Table limits before sending variable data", () => {
    expect(() => validateTableEntity({ value: "a".repeat(32_769) })).toThrow(/property/i);
    expect(() => validateTableEntity({ value: Buffer.alloc(65_537) })).toThrow(/property/i);
    expect(() => validateTableEntity({ value: { nested: true } })).toThrow(/scalar/i);
    expect(() => validateTableEntity({ value: Number.NaN })).toThrow(/finite/i);
    expect(() => validateTableEntity({ "invalid.property": true })).toThrow(/property name/i);
    expect(() =>
      validateTableEntity(
        Object.fromEntries(Array.from({ length: 253 }, (_, i) => [`v${i}`, true])),
      ),
    ).toThrow(/properties/i);
    expect(() =>
      validateTableEntity({ nickname: "ёж", absent: null, timestamp: new Date() }),
    ).not.toThrow();
    expect(uuidKey("ABCDEFAB-1234-1234-1234-ABCDEFABCDEF")).toBe(
      "abcdefab-1234-1234-1234-abcdefabcdef",
    );
  });

  it("commits typed rows atomically and reopens without PostgreSQL", async () => {
    const { storage, options } = await fixture();
    const createdAt = new Date("2026-09-30T12:00:00.000Z");
    await storage.mutate(async (tx) => {
      await tx.set("sample:a", {
        createdAt,
        active: true,
        count: 2,
        binary: Buffer.from([1, 2]),
        optional: null,
      });
      await tx.set("sample:b", { name: "Привет" });
    });
    const reopened = new AzureStorage(options);
    await reopened.initialize(false);
    const rows = await reopened.read((tx) => tx.list<Record<string, unknown>>("sample:"));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      createdAt,
      active: true,
      count: 2,
      binary: Buffer.from([1, 2]),
    });
    expect(rows[0]).not.toHaveProperty("optional");
    expect(rows[0]).not.toHaveProperty("etag");
    await reopened.mutate(async (tx) => {
      await tx.set("sample:a", { ...(await tx.get("sample:a")), count: 3 });
      const listed = await tx.list("sample:b");
      await tx.set("sample:b", { ...listed[0], name: "Updated" });
    });
    expect(await reopened.read((tx) => tx.get("sample:a"))).toEqual({
      createdAt,
      active: true,
      count: 3,
      binary: Buffer.from([1, 2]),
    });
    expect(await reopened.read((tx) => tx.list("sample:b"))).toEqual([
      { rowKey: "sample:b", name: "Updated" },
    ]);
    await reopened.end();
  });

  it("keeps oversized transactions entirely unpublished", async () => {
    const { storage } = await fixture();
    const submit = vi.spyOn(storage.table, "submitTransaction");
    await expect(
      storage.mutate(async (tx) => {
        for (let i = 0; i < 100; i++) await tx.set(`sample:${i}`, { value: i });
      }),
    ).rejects.toThrow(/transaction/i);
    expect(submit).not.toHaveBeenCalled();
    expect(await storage.read((tx) => tx.list("sample:"))).toEqual([]);
  });

  it("publishes exact private blobs only through committed pointers", async () => {
    const { storage } = await fixture();
    const snapshot = { arbitrary: "x".repeat(100_000), replay: { hash: "unchanged", players: [] } };
    await storage.mutate(async (tx) => {
      const ref = await tx.writeBlob(snapshot);
      await tx.set("sample:snapshot", {
        blobName: ref.name,
        blobSha256: ref.sha256,
        blobLength: ref.length,
      });
    });
    expect(
      await storage.read(async (tx) =>
        tx.readBlob(blobReference((await tx.get("sample:snapshot"))!)),
      ),
    ).toEqual(snapshot);
    const properties = await storage.blobs.getProperties();
    expect(properties.blobPublicAccess).toBeUndefined();
  });

  it("retries a CAS conflict against the new authoritative rows", async () => {
    const { storage, options } = await fixture();
    const second = new AzureStorage(options);
    const submit = storage.table.submitTransaction.bind(storage.table);
    vi.spyOn(storage.table, "submitTransaction").mockImplementationOnce(
      async (actions, options) => {
        await second.mutate((tx) => tx.set("sample:counter", { value: 10 }));
        return submit(actions, options);
      },
    );
    await storage.mutate(async (tx) => {
      const existing = await tx.get<{ value: number }>("sample:counter");
      await tx.set("sample:counter", { value: (existing?.value ?? 0) + 1 });
    });
    expect(await storage.read((tx) => tx.get("sample:counter"))).toMatchObject({ value: 11 });
  });

  it("proves an ambiguously successful commit without overwriting a later one", async () => {
    const { storage, options } = await fixture();
    const second = new AzureStorage(options);
    const submit = storage.table.submitTransaction.bind(storage.table);
    vi.spyOn(storage.table, "submitTransaction").mockImplementationOnce(
      async (actions, options) => {
        await submit(actions, options);
        await second.mutate((tx) => tx.set("sample:value", { value: "later" }));
        throw new Error("response lost after remote commit");
      },
    );
    await storage.mutate((tx) => tx.set("sample:value", { value: "earlier" }));
    expect(await storage.read((tx) => tx.get("sample:value"))).toMatchObject({ value: "later" });
  });

  it("does not acknowledge a failed publication", async () => {
    const { storage } = await fixture();
    await storage.mutate((tx) => tx.set("sample:value", { value: "previous" }));
    vi.spyOn(storage.table, "submitTransaction").mockRejectedValueOnce(
      new Error("publication failed"),
    );
    await expect(
      storage.mutate((tx) => tx.set("sample:value", { value: "unpublished" })),
    ).rejects.toThrow(/publication|storage/i);
    expect(await storage.read((tx) => tx.get("sample:value"))).toMatchObject({ value: "previous" });
  });

  it("rechecks authorization after a competing revocation", async () => {
    const { storage, options } = await fixture();
    const userId = randomUUID();
    const clubId = randomUUID();
    await storage.mutate(async (tx) => {
      await tx.set(`club:${clubId}:meta`, { id: clubId });
      await tx.set(`club:${clubId}:member:${userId}`, { userId, role: "manager" });
    });
    const second = new AzureStorage(options);
    const submit = storage.table.submitTransaction.bind(storage.table);
    vi.spyOn(storage.table, "submitTransaction").mockImplementationOnce(
      async (actions, options) => {
        await second.mutate((tx) => tx.delete(`club:${clubId}:member:${userId}`));
        return submit(actions, options);
      },
    );
    await expect(
      storage.runAuthorized(userId, clubId, true, () =>
        storage.mutate((tx) => tx.set("sample:protected", { value: true })),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(await storage.read((tx) => tx.get("sample:protected"))).toBeUndefined();
  });
});

// Each test owns a real Azurite namespace and uses independent SDK clients.
describe("durable owner-checked storage freeze", () => {
  it("persists across reopen, serves reads, rejects every other owner and duplicate acquisition", async () => {
    const { storage, options } = await fixture();
    await storage.mutate((tx) => tx.set("sample:freeze", { value: "retained" }));
    const owner = randomUUID();
    const frozen = await storage.acquireFreeze(owner);
    expect(frozen).toMatchObject({ writeMode: "backup-frozen", freezeOwner: owner });
    const reopened = new AzureStorage(options);
    await reopened.initialize(false);
    expect((await reopened.getControl()).etag).toBe(frozen.etag);
    expect(await reopened.read((tx) => tx.get("sample:freeze"))).toMatchObject({
      value: "retained",
    });
    await expect(
      reopened.mutate((tx) => tx.set("sample:freeze", { value: "blocked" })),
    ).rejects.toThrow(/frozen/i);
    await expect(reopened.acquireFreeze(owner)).rejects.toThrow(/frozen|owner/i);
    await expect(reopened.acquireFreeze(randomUUID())).rejects.toThrow(/frozen|owner/i);
    await expect(reopened.releaseFreeze(randomUUID())).rejects.toThrow(/owner/i);
    expect((await reopened.assertFreeze(owner)).etag).toBe(frozen.etag);
    await reopened.releaseFreeze(owner);
    expect(await storage.getControl()).toMatchObject({
      writeMode: "normal",
      datasetId: frozen.datasetId,
    });
    expect((await storage.getControl()).freezeOwner).toBeUndefined();
    await expect(storage.releaseFreeze(owner)).rejects.toThrow(/owner|frozen/i);
    await storage.mutate((tx) => tx.set("sample:freeze", { value: "resumed" }));
  });

  it("has exactly one winner even when simultaneous acquisitions reuse the same owner", async () => {
    const { storage, options } = await fixture();
    const second = new AzureStorage(options);
    const owner = randomUUID();
    const outcomes = await Promise.allSettled([
      storage.acquireFreeze(owner),
      second.acquireFreeze(owner),
    ]);
    expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((value) => value.status === "rejected")).toHaveLength(1);
    await storage.releaseFreeze(owner);
  });

  it("proves lost successful acquire/release responses without releasing a subsequent owner's freeze", async () => {
    const { storage, options } = await fixture();
    const second = new AzureStorage(options);
    const owner = randomUUID();
    const nextOwner = randomUUID();
    const submit = storage.table.submitTransaction.bind(storage.table);
    vi.spyOn(storage.table, "submitTransaction").mockImplementationOnce(
      async (actions, options) => {
        await submit(actions, options);
        throw new Error("acquire response lost");
      },
    );
    await storage.acquireFreeze(owner);
    vi.spyOn(storage.table, "submitTransaction").mockImplementationOnce(
      async (actions, options) => {
        await submit(actions, options);
        await second.acquireFreeze(nextOwner);
        throw new Error("release response lost after the next owner acquired");
      },
    );
    await storage.releaseFreeze(owner);
    expect(await second.assertFreeze(nextOwner)).toMatchObject({ freezeOwner: nextOwner });
    await second.releaseFreeze(nextOwner);
  });

  it("does not infer an uncommitted acquisition from a matching owner or a newer revision", async () => {
    const { storage, options } = await fixture();
    const owner = randomUUID();
    const second = new AzureStorage(options);
    vi.spyOn(storage.table, "submitTransaction").mockImplementationOnce(async () => {
      await second.acquireFreeze(owner);
      throw new Error("first request never committed");
    });
    await expect(storage.acquireFreeze(owner)).rejects.toThrow(/publication|prove|freeze/i);
    await second.releaseFreeze(owner);
  });

  it("preserves an unknown frozen owner without stealing or expiring it", async () => {
    const { storage } = await fixture();
    const control = await storage.getControl();
    await storage.table.updateEntity(
      {
        ...control,
        partitionKey: storage.options.partitionKey,
        rowKey: "control",
        writeMode: "backup-frozen",
      },
      "Replace",
      {
        etag: control.etag,
      },
    );
    const before = await storage.getControl();
    await expect(storage.acquireFreeze(randomUUID())).rejects.toThrow(/frozen/i);
    await expect(storage.releaseFreeze(randomUUID())).rejects.toThrow(/owner/i);
    expect((await storage.getControl()).etag).toBe(before.etag);
  });

  it("fences a writer whose final submit races freeze and abandons its unpublished staging", async () => {
    const { storage, options } = await fixture();
    const second = new AzureStorage(options);
    const owner = randomUUID();
    const submit = storage.table.submitTransaction.bind(storage.table);
    let stagedName = "";
    vi.spyOn(storage.table, "submitTransaction").mockImplementationOnce(
      async (actions, options) => {
        await second.acquireFreeze(owner);
        return submit(actions, options);
      },
    );
    await expect(
      storage.mutate(async (tx) => {
        const ref = await tx.writeBlob({ unpublished: true });
        stagedName = ref.name;
        await tx.set("sample:head", {
          blobName: ref.name,
          blobSha256: ref.sha256,
          blobLength: ref.length,
        });
      }),
    ).rejects.toThrow(/frozen/i);
    expect(await storage.read((tx) => tx.get("sample:head"))).toBeUndefined();
    expect(await storage.blobs.getBlockBlobClient(stagedName).exists()).toBe(true);
    await second.releaseFreeze(owner);
  });

  it("holds a deletion fence through the Blob request and permits owned Table chunks", async () => {
    const { storage, options } = await fixture();
    const second = new AzureStorage(options);
    const ref = await storage.mutate((tx) => tx.writeBlob({ disposable: true }));
    const remove = storage.blobs.deleteBlob.bind(storage.blobs);
    vi.spyOn(storage.blobs, "deleteBlob").mockImplementationOnce(async (name, options) => {
      await expect(second.acquireFreeze(randomUUID())).rejects.toThrow(/frozen/i);
      await expect(
        second.mutate((tx) => tx.set("sample:intruder", { value: true })),
      ).rejects.toThrow(/frozen/i);
      return remove(name, options);
    });
    await storage.withMaintenanceFreeze(async () => {
      await storage.deleteBlob(ref);
      await storage.mutate((tx) => tx.set("sample:maintenance", { value: true }));
    });
    expect(await storage.blobs.getBlockBlobClient(ref.name).exists()).toBe(false);
    expect(await storage.read((tx) => tx.get("sample:maintenance"))).toMatchObject({ value: true });
    expect((await storage.getControl()).writeMode).toBe("normal");
  });
});
