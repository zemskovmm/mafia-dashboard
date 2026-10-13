import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AzureStorage } from "./azure-storage.js";
import { initializeStorage } from "./initialize-storage.js";
import { createStorageFixture } from "./test-helpers/storage-fixture.js";

let fixture: Awaited<ReturnType<typeof createStorageFixture>>;
beforeAll(async () => {
  fixture = await createStorageFixture();
}, 30000);
afterAll(async () => fixture?.close());
const fresh = () => {
  const suffix = randomUUID().replaceAll("-", "");
  return new AzureStorage({
    ...fixture.options,
    tableName: `Init${suffix}`,
    containerName: `init-${suffix}`,
  });
};

describe("deployment storage initializer", () => {
  it("requires explicit initialization, creates only control, and preserves data on repeat", async () => {
    const storage = fresh();
    await expect(initializeStorage(storage, false, { attempts: 1 })).rejects.toThrow();
    expect(await storage.blobs.exists()).toBe(false);
    await initializeStorage(storage, true);
    const before = await storage.getControl();
    const rows = [];
    for await (const row of storage.table.listEntities()) rows.push(row.rowKey);
    expect(rows).toEqual(["control"]);
    await storage.mutate((tx) => tx.set("probe", { value: "preserved" }));
    const changed = await storage.getControl();
    await initializeStorage(storage, true);
    await initializeStorage(storage, false);
    expect(await storage.getControl()).toEqual(changed);
    expect(changed.datasetId).toBe(before.datasetId);
    expect(await storage.getEntity("probe")).toMatchObject({ value: "preserved" });
  }, 30000);

  it("refuses unknown data without creating control or resetting it", async () => {
    const storage = fresh();
    await storage.table.createTable();
    await storage.table.createEntity({
      partitionKey: storage.options.partitionKey,
      rowKey: "unknown",
      value: "keep",
    });
    await expect(initializeStorage(storage, true, { attempts: 1 })).rejects.toThrow(
      /refusing initialization/,
    );
    expect(await storage.getEntity("control")).toBeUndefined();
    expect(await storage.getEntity("unknown")).toMatchObject({ value: "keep" });
  }, 30000);

  it("bounds transient RBAC retries and does not retry invalid authoritative state", async () => {
    const pause = vi.fn(async () => {});
    const ready = vi.spyOn(fixture.storage, "ready");
    ready.mockRejectedValueOnce({ statusCode: 403 }).mockRejectedValueOnce({ statusCode: 503 });
    await initializeStorage(fixture.storage, false, { attempts: 3, pause });
    expect(pause).toHaveBeenCalledTimes(2);
    ready.mockRejectedValue({ statusCode: 403 });
    await expect(
      initializeStorage(fixture.storage, false, { attempts: 3, pause }),
    ).rejects.toMatchObject({ statusCode: 403 });
    ready.mockRejectedValue(new Error("Unsupported storage"));
    pause.mockClear();
    await expect(initializeStorage(fixture.storage, false, { attempts: 3, pause })).rejects.toThrow(
      "Unsupported storage",
    );
    expect(pause).not.toHaveBeenCalled();
    ready.mockRestore();
  });
});
