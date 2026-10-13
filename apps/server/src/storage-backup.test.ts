import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AzureStorage, blobFields, digest } from "./azure-storage.js";
import { createStorageFixture } from "./test-helpers/storage-fixture.js";
import {
  captureStorageBackup,
  restoreStorageBackup,
  validateStorageBackup,
} from "./storage-backup.js";

const privateRoot = fileURLToPath(new URL("../../../.AI/storage-backup-tests/", import.meta.url));
const application = { applicationVersion: "test-1", applicationCommit: "synthetic-test-commit" };
let fixture: Awaited<ReturnType<typeof createStorageFixture>>;
let run: string;
const archive = (label: string) => join(run, `${label}-${randomUUID()}`);
const target = () => {
  const suffix = randomUUID().replaceAll("-", "");
  return new AzureStorage({
    ...fixture.options,
    tableName: `Restore${suffix}`,
    containerName: `restore-${suffix}`,
  });
};
const rows = async (storage: AzureStorage) => {
  const result = [];
  for await (const row of storage.table.listEntities({ disableTypeConversion: true }))
    result.push(row);
  return result;
};

beforeAll(async () => {
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  await chmod(privateRoot, 0o700);
  run = await mkdtemp(join(privateRoot, "run-"));
  fixture = await createStorageFixture();
}, 60_000);
afterAll(async () => {
  await fixture?.close();
});
afterEach(() => {
  vi.restoreAllMocks();
});
const seed = async () => {
  const source = target();
  await source.initialize(true);
  const ref = await source.mutate(async (tx) => {
    const ref = await tx.writeBlob({ canonical: "private exact bytes 🎲" });
    await tx.set("probe", blobFields(ref));
    return ref;
  });
  const directory = archive("input");
  const manifest = await captureStorageBackup(source, directory, application);
  return { source, ref, directory, manifest };
};
const editManifest = async (
  directory: string,
  edit: (manifest: Awaited<ReturnType<typeof validateStorageBackup>>) => void,
) => {
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as Awaited<
    ReturnType<typeof validateStorageBackup>
  >;
  edit(manifest);
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
};
const copyArchive = async (directory: string, label: string) => {
  const copy = archive(label);
  await cp(directory, copy, { recursive: true });
  return copy;
};
const expectUntouched = async (storage: AzureStorage) => {
  expect(await storage.getEntity("control")).toBeUndefined();
  expect(await storage.blobs.exists()).toBe(false);
};

describe("independent typed storage backup (real Azurite)", () => {
  it("restores a multi-megabyte immutable byte stream and more than one Table batch worth of rows", async () => {
    const source = target();
    await source.initialize(true);
    const control = await source.getControl();
    const name = `datasets/${digest(source.options.partitionKey)}/${control.datasetId}/snapshots/${randomUUID()}.json`;
    const bytes = Buffer.from(`{\n  "opaque": "${"x".repeat(5 * 1024 * 1024)}"\n}\n`, "utf8");
    await source.blobs
      .getBlockBlobClient(name)
      .uploadData(bytes, { conditions: { ifNoneMatch: "*" } });
    await source.mutate(async (tx) => {
      await tx.set("probe", {
        blobName: name,
        blobSha256: digest(bytes),
        blobLength: bytes.length,
      });
    });
    for (let index = 0; index < 110; index++)
      await source.table.createEntity({
        partitionKey: source.options.partitionKey,
        rowKey: `many:${String(index).padStart(4, "0")}`,
        index,
        erasedFieldAbsent: true,
      });
    const directory = archive("large-independent-input");
    const manifest = await captureStorageBackup(source, directory, application);
    // Restore depends only on the package, not on any source client call.
    vi.spyOn(source.table, "listEntities").mockImplementation(() => {
      throw new Error("source must not be accessed by restore");
    });
    const restored = target();
    await restoreStorageBackup(restored, directory);
    expect(await restored.blobs.getBlockBlobClient(name).downloadToBuffer()).toEqual(bytes);
    expect((await rows(restored)).filter((row) => row.rowKey?.startsWith("many:"))).toHaveLength(
      110,
    );
    expect(manifest.rows.length).toBeGreaterThan(0);
    expect(manifest.blobs[0]!.length).toBe(bytes.length);
  }, 60_000);

  it("does not complete an archive if written bytes change before publication", async () => {
    const source = target();
    await source.initialize(true);
    await source.mutate(async (tx) => {
      const ref = await tx.writeBlob({ test: true });
      await tx.set("probe", blobFields(ref));
    });
    const directory = archive("changed-during-capture");
    const original = source.blobs.getBlockBlobClient.bind(source.blobs);
    vi.spyOn(source.blobs, "getBlockBlobClient").mockImplementation((name) => {
      const client = original(name);
      const download = client.downloadToBuffer.bind(client);
      vi.spyOn(client, "downloadToBuffer").mockImplementation(async (...args) => {
        const bytes = await download(...args);
        await writeFile(join(directory, "rows.json"), "[]", { mode: 0o600 });
        return bytes;
      });
      return client;
    });
    await expect(captureStorageBackup(source, directory, application)).rejects.toThrow();
    await expect(lstat(join(directory, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await source.getControl()).writeMode).toBe("normal");
    await expect(validateStorageBackup(directory)).rejects.toThrow();
  }, 60_000);
  it("preserves sub-millisecond EDM DateTime strings without truncating their Table value", async () => {
    const source = target();
    await source.initialize(true);
    const precise = "2025-02-03T04:05:06.1234567Z";
    await source.table.createEntity({
      partitionKey: source.options.partitionKey,
      rowKey: "typed:ticks",
      precise: { type: "DateTime", value: precise },
    });
    const directory = archive("precise-datetime");
    await captureStorageBackup(source, directory, application);
    const exported = JSON.parse(await readFile(join(directory, "rows.json"), "utf8")) as Array<{
      rowKey: string;
      properties: Record<string, { type: string; value: string }>;
    }>;
    expect(exported.find((row) => row.rowKey === "typed:ticks")?.properties.precise).toEqual({
      type: "DateTime",
      value: precise,
    });
    const restored = target();
    await restoreStorageBackup(restored, directory);
    const exact = await restored.table.getEntity(restored.options.partitionKey, "typed:ticks", {
      disableTypeConversion: true,
    });
    expect(exact.precise).toEqual({ type: "DateTime", value: precise });
  }, 60_000);

  it("preserves finite numeric values across service-inferred Int32 and Double types", async () => {
    const source = target();
    await source.initialize(true);
    await source.table.createEntity({
      partitionKey: source.options.partitionKey,
      rowKey: "typed:numbers",
      integralDouble: { type: "Double", value: 3 },
      largeDouble: { type: "Double", value: 2147483648 },
      signed: { type: "Int32", value: -2147483648 },
    });
    const directory = archive("numbers");
    await captureStorageBackup(source, directory, application);
    const exported = JSON.parse(await readFile(join(directory, "rows.json"), "utf8")) as Array<{
      rowKey: string;
      properties: Record<string, { type: string; value: string }>;
    }>;
    // Azurite omits numeric EDM metadata when the JSON value itself conveys it.
    expect(
      exported.find((row) => row.rowKey === "typed:numbers")?.properties.integralDouble,
    ).toEqual({ type: "Int32", value: "3" });
    expect(exported.find((row) => row.rowKey === "typed:numbers")?.properties.largeDouble).toEqual({
      type: "Double",
      value: "2147483648",
    });
    const restored = target();
    await restoreStorageBackup(restored, directory);
    expect((await restored.getEntity("typed:numbers"))?.largeDouble).toBe(2147483648);
  }, 60_000);

  it("restores exact blob bytes, typed identities and timestamps; deliberately invalidates sessions", async () => {
    const { storage } = fixture;
    const id = randomUUID();
    const createdAt = new Date("2025-02-03T04:05:06.789Z");
    const ref = await storage.mutate(async (tx) => {
      const ref = await tx.writeBlob(
        { identity: id, unicode: "Ёж 🎲", nested: { canonical: "exact" } },
        "snapshots",
      );
      await tx.set(`club:${id}:game:${id}`, {
        id,
        createdAt,
        enabled: true,
        score: 3.25,
        bytes: Buffer.from([0, 255, 17]),
        ...blobFields(ref),
      });
      await tx.set(`session:${"a".repeat(64)}`, { userId: id, expiresAt: createdAt });
      await tx.set(`deleted-game:${id}`, { gameId: id, deletedAt: createdAt });
      return ref;
    });
    await storage.table.createEntity({
      partitionKey: fixture.options.partitionKey,
      rowKey: "typed:int64",
      large: { type: "Int64", value: "9223372036854775807" },
      small: { type: "Int64", value: "-9223372036854775808" },
      guid: { type: "Guid", value: id },
    });
    const directory = archive("roundtrip");
    const manifest = await captureStorageBackup(storage, directory, application);
    expect(manifest.complete).toBe(true);
    expect(manifest.blobCount).toBe(1);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(directory, "manifest.json"))).mode & 0o777).toBe(0o600);
    expect(await validateStorageBackup(directory)).toEqual(manifest);
    const sourceBeforeRestore = await rows(storage);
    const sourceBytes = await storage.blobs.getBlockBlobClient(ref.name).downloadToBuffer();
    const restored = target();
    const result = await restoreStorageBackup(restored, directory);
    expect(result.invalidatedSessions).toBe(1);
    expect(result.dataEpoch).toMatch(/^[a-f0-9-]{36}$/);
    await restored.ready();
    const control = await restored.getEntity("control");
    expect(control?.datasetId).toBe(manifest.datasetId);
    expect(control?.dataEpoch).toBe(result.dataEpoch);
    expect(control?.blobContainer).toBe(restored.blobs.url);
    expect(control?.writeMode).toBe("normal");
    expect(control?.freezeOwner).toBeUndefined();
    expect(await restored.getEntity(`session:${"a".repeat(64)}`)).toBeUndefined();
    const game = await restored.getEntity(`club:${id}:game:${id}`);
    expect(game?.createdAt).toEqual(createdAt);
    expect(game?.bytes).toEqual(Buffer.from([0, 255, 17]));
    expect(game?.enabled).toBe(true);
    expect(game?.score).toBe(3.25);
    expect(game?.id).toBe(id);
    expect((await restored.getEntity("typed:int64"))?.large).toBe(9223372036854775807n);
    expect((await restored.getEntity("typed:int64"))?.small).toBe(-9223372036854775808n);
    expect(await restored.blobs.getBlockBlobClient(ref.name).downloadToBuffer()).toEqual(
      sourceBytes,
    );
    expect(await rows(storage)).toEqual(sourceBeforeRestore);
    await restored.mutate(async (tx) => {
      await tx.set("after-restore", { works: true });
    });
    expect((await restored.getEntity("after-restore"))?.works).toBe(true);
    const json = await readFile(join(directory, "manifest.json"), "utf8");
    expect(json).not.toContain("AccountKey");
  }, 60_000);
});

describe("fail-closed backup inputs and target guards", () => {
  it("rejects unsupported manifests, wrong counts, corrupt/missing bytes before target effects", async () => {
    const { directory, manifest } = await seed();
    const cases: Array<[string, (copy: string) => Promise<void>]> = [
      [
        "version",
        (copy) =>
          editManifest(copy, (m) => {
            Object.assign(m, { version: 2 });
          }),
      ],
      [
        "incomplete",
        (copy) =>
          editManifest(copy, (m) => {
            Object.assign(m, { complete: false });
          }),
      ],
      [
        "entity-count",
        (copy) =>
          editManifest(copy, (m) => {
            m.entityCount++;
          }),
      ],
      [
        "blob-count",
        (copy) =>
          editManifest(copy, (m) => {
            m.blobCount++;
          }),
      ],
      [
        "row-length",
        (copy) =>
          editManifest(copy, (m) => {
            m.rows.length++;
          }),
      ],
      [
        "row-hash",
        (copy) =>
          editManifest(copy, (m) => {
            m.rows.sha256 = "0".repeat(64);
          }),
      ],
      [
        "blob-hash",
        (copy) =>
          editManifest(copy, (m) => {
            m.blobs[0]!.sha256 = "0".repeat(64);
          }),
      ],
      [
        "blob-length",
        (copy) =>
          editManifest(copy, (m) => {
            m.blobs[0]!.length++;
          }),
      ],
      [
        "corrupt-bytes",
        async (copy) => {
          await writeFile(join(copy, manifest.blobs[0]!.file), "corrupt", { mode: 0o600 });
        },
      ],
      [
        "missing-bytes",
        async (copy) => {
          const file = join(copy, manifest.blobs[0]!.file);
          await rename(file, `${file}.retained-missing`);
        },
      ],
      [
        "missing-live-root",
        (copy) =>
          editManifest(copy, (m) => {
            m.blobs = [];
            m.blobCount = 0;
          }),
      ],
      [
        "wrong-control",
        (copy) =>
          editManifest(copy, (m) => {
            m.frozenRevision++;
          }),
      ],
      [
        "credential-endpoint",
        (copy) =>
          editManifest(copy, (m) => {
            m.source.containerUrl += "?sig=synthetic";
          }),
      ],
      [
        "traversal",
        (copy) =>
          editManifest(copy, (m) => {
            m.blobs[0]!.file = "../outside";
          }),
      ],
    ];
    for (const [label, change] of cases) {
      const copy = await copyArchive(directory, label);
      await change(copy);
      await expect(validateStorageBackup(copy), label).rejects.toThrow();
      const restored = target();
      await expect(restoreStorageBackup(restored, copy), label).rejects.toThrow();
      await expectUntouched(restored);
    }
    expect(await validateStorageBackup(directory)).toEqual(manifest);
  }, 60_000);

  it("rejects unknown/unsafe EDM, duplicate identities, and malformed reference triples even with correct row checksums", async () => {
    const { directory } = await seed();
    type Row = {
      partitionKey: string;
      rowKey: string;
      properties: Record<string, { type: string; value: unknown }>;
    };
    const cases: Array<[string, (rows: Row[]) => void]> = [
      [
        "unknown-edm",
        (rows) => {
          rows.find((row) => row.rowKey === "probe")!.properties.extra = {
            type: "Decimal",
            value: "1.0",
          };
        },
      ],
      [
        "unsafe-int64",
        (rows) => {
          rows.find((row) => row.rowKey === "probe")!.properties.extra = {
            type: "Int64",
            value: Number("9223372036854775807"),
          };
        },
      ],
      [
        "overflow-int64",
        (rows) => {
          rows.find((row) => row.rowKey === "probe")!.properties.extra = {
            type: "Int64",
            value: "9223372036854775808",
          };
        },
      ],
      [
        "overflow-int32",
        (rows) => {
          rows.find((row) => row.rowKey === "probe")!.properties.extra = {
            type: "Int32",
            value: "2147483648",
          };
        },
      ],
      [
        "invalid-binary",
        (rows) => {
          rows.find((row) => row.rowKey === "probe")!.properties.extra = {
            type: "Binary",
            value: "not-base64",
          };
        },
      ],
      [
        "duplicate",
        (rows) => {
          rows.push(rows.find((row) => row.rowKey === "probe")!);
        },
      ],
      [
        "foreign-partition",
        (rows) => {
          rows.find((row) => row.rowKey === "probe")!.partitionKey = "foreign";
        },
      ],
      [
        "partial-header",
        (rows) => {
          rows.find((row) => row.rowKey === "probe")!.properties.headerBlobSha256 = {
            type: "String",
            value: "0".repeat(64),
          };
        },
      ],
      [
        "partial-card",
        (rows) => {
          rows.find((row) => row.rowKey === "probe")!.properties.cardBlobLength = {
            type: "Int32",
            value: "1",
          };
        },
      ],
      [
        "partial-token",
        (rows) => {
          rows.find((row) => row.rowKey === "probe")!.properties.tokenBlobName = {
            type: "String",
            value: "foreign",
          };
        },
      ],
      [
        "partial-live",
        (rows) => {
          delete rows.find((row) => row.rowKey === "probe")!.properties.blobSha256;
        },
      ],
    ];
    for (const [label, change] of cases) {
      const copy = await copyArchive(directory, label);
      const input = JSON.parse(await readFile(join(copy, "rows.json"), "utf8")) as Row[];
      change(input);
      const bytes = Buffer.from(JSON.stringify(input));
      await writeFile(join(copy, "rows.json"), bytes, { mode: 0o600 });
      await editManifest(copy, (m) => {
        m.rows.length = bytes.length;
        m.rows.sha256 = digest(bytes);
        m.entityCount = input.length;
      });
      const restored = target();
      await expect(restoreStorageBackup(restored, copy), label).rejects.toThrow();
      await expectUntouched(restored);
    }
  }, 60_000);

  it("refuses same-source resources, wrong partitions and nonempty/foreign targets without changing them", async () => {
    const { source, directory, manifest } = await seed();
    const sourceBefore = await rows(source);
    await expect(restoreStorageBackup(source, directory)).rejects.toThrow(/separate/);
    expect(await rows(source)).toEqual(sourceBefore);
    const sameTable = new AzureStorage({
      ...target().options,
      tableName: source.options.tableName,
    });
    await expect(restoreStorageBackup(sameTable, directory)).rejects.toThrow(/separate/);
    expect(await sameTable.blobs.exists()).toBe(false);
    const sameContainer = new AzureStorage({
      ...target().options,
      containerName: source.options.containerName,
    });
    await expect(restoreStorageBackup(sameContainer, directory)).rejects.toThrow(/separate/);
    expect(await sameContainer.getEntity("control")).toBeUndefined();
    const wrong = new AzureStorage({ ...target().options, partitionKey: "wrong" });
    await expect(restoreStorageBackup(wrong, directory)).rejects.toThrow(/partitionKey/);
    await expectUntouched(wrong);
    const initialized = target();
    await initialized.initialize(true);
    const before = await rows(initialized);
    await expect(restoreStorageBackup(initialized, directory)).rejects.toThrow(/nonempty/);
    expect(await rows(initialized)).toEqual(before);
    const foreign = target();
    await foreign.table.createTable();
    await foreign.table.createEntity({
      partitionKey: "foreign",
      rowKey: "owned-by-other",
      safe: true,
    });
    await expect(restoreStorageBackup(foreign, directory)).rejects.toThrow(/nonempty/);
    expect(await foreign.getEntity("control")).toBeUndefined();
    expect(await foreign.blobs.exists()).toBe(false);
    const populated = target();
    await populated.blobs.create();
    await populated.blobs.getBlockBlobClient("foreign").uploadData(Buffer.from("private"));
    await expect(restoreStorageBackup(populated, directory)).rejects.toThrow(/nonempty/);
    expect(await populated.getEntity("control")).toBeUndefined();
    expect(await populated.blobs.getBlockBlobClient("foreign").downloadToBuffer()).toEqual(
      Buffer.from("private"),
    );
    expect(await validateStorageBackup(directory)).toEqual(manifest);
  }, 60_000);

  it("never overwrites archives, traverses symlinks or reads world-readable package files", async () => {
    const { source, directory, manifest } = await seed();
    await expect(captureStorageBackup(source, directory, application)).rejects.toThrow();
    expect(await validateStorageBackup(directory)).toEqual(manifest);
    const link = archive("symlink");
    await symlink(directory, link);
    await expect(validateStorageBackup(link)).rejects.toThrow(/symlink/);
    await expect(captureStorageBackup(source, join(link, "child"), application)).rejects.toThrow(
      /symlink/,
    );
    const copy = await copyArchive(directory, "unsafe-mode");
    await chmod(join(copy, "rows.json"), 0o644);
    await expect(validateStorageBackup(copy)).rejects.toThrow(/unsafe/);
    const copy2 = await copyArchive(directory, "file-symlink");
    await rename(join(copy2, "rows.json"), join(copy2, "retained-rows.json"));
    await symlink(join(directory, "rows.json"), join(copy2, "rows.json"));
    await expect(validateStorageBackup(copy2)).rejects.toThrow();
  }, 60_000);

  it("refuses remote/managed-identity-style operations before side effects", async () => {
    const { source, directory } = await seed();
    const options = { ...source.options, connectionString: undefined, accountName: "synthetic" };
    // Existing loopback clients remain real; only the declared operational mode changes.
    const refused = Object.create(source) as AzureStorage;
    Object.defineProperty(refused, "options", { value: options });
    const output = archive("remote-refused");
    await expect(captureStorageBackup(refused, output, application)).rejects.toThrow(/remote/);
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(restoreStorageBackup(refused, directory)).rejects.toThrow(/remote/);
  }, 60_000);
});

describe("capture barriers, retained references and failure publication", () => {
  it("captures header/card/token/retired roots, permitting only missing cleanup lifecycle references", async () => {
    const source = target();
    await source.initialize(true);
    const { live, retired } = await source.mutate(async (tx) => {
      const live = await tx.writeBlob({ canonical: "live" });
      const retired = await tx.writeBlob({ canonical: "retired" });
      const control = await source.getControl();
      const missingName = `${live.name.slice(0, live.name.lastIndexOf("/") + 1)}${randomUUID()}.json`;
      await tx.set("logos", {
        headerBlobName: live.name,
        headerBlobSha256: live.sha256,
        headerBlobLength: live.length,
        cardBlobName: live.name,
        cardBlobSha256: live.sha256,
        cardBlobLength: live.length,
      });
      await tx.set("token-reference-root", {
        tokenBlobName: live.name,
        tokenBlobSha256: live.sha256,
        tokenBlobLength: live.length,
      });
      await tx.set("cleanup:present", blobFields(retired));
      await tx.set("cleanup:already-deleted", {
        blobName: missingName,
        blobSha256: "0".repeat(64),
        blobLength: 7,
        datasetId: control.datasetId,
      });
      return { live, retired };
    });
    const directory = archive("reference-roots");
    const manifest = await captureStorageBackup(source, directory, application);
    expect(manifest.blobs.map((blob) => blob.name).sort()).toEqual(
      [live.name, retired.name].sort(),
    );
    const restored = target();
    await restoreStorageBackup(restored, directory);
    expect(await restored.getEntity("cleanup:already-deleted")).toBeDefined();
    expect(await restored.blobs.getBlockBlobClient(retired.name).exists()).toBe(true);
    await source.mutate(async (tx) => {
      const row = await tx.get<{ blobName: string; blobSha256: string; blobLength: number }>(
        "cleanup:already-deleted",
      );
      await tx.set("live:missing", {
        blobName: row!.blobName,
        blobSha256: row!.blobSha256,
        blobLength: row!.blobLength,
      });
    });
    const failed = archive("missing-live-capture");
    await expect(captureStorageBackup(source, failed, application)).rejects.toThrow();
    await expect(lstat(join(failed, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await source.getControl()).writeMode).toBe("normal");
  }, 60_000);

  it("holds the real freeze over byte capture and prevents mutations until release", async () => {
    const { source } = await seed();
    let entered!: () => void;
    let resume!: () => void;
    const inside = new Promise<void>((done) => {
      entered = done;
    });
    const gate = new Promise<void>((done) => {
      resume = done;
    });
    const original = source.blobs.getBlockBlobClient.bind(source.blobs);
    vi.spyOn(source.blobs, "getBlockBlobClient").mockImplementation((name) => {
      const client = original(name);
      const download = client.downloadToBuffer.bind(client);
      vi.spyOn(client, "downloadToBuffer").mockImplementation(async (...args) => {
        entered();
        await gate;
        return download(...args);
      });
      return client;
    });
    const capture = captureStorageBackup(source, archive("held-freeze"), application);
    await inside;
    try {
      expect((await source.getControl()).writeMode).toBe("backup-frozen");
      await expect(
        source.mutate(async (tx) => {
          await tx.set("forbidden", { value: true });
        }),
      ).rejects.toThrow();
    } finally {
      resume();
    }
    await capture;
    expect(await source.getEntity("forbidden")).toBeUndefined();
    expect((await source.getControl()).writeMode).toBe("normal");
  }, 60_000);

  it("retains a failed capture as incomplete and releases its own freeze after an SDK byte failure", async () => {
    const { source } = await seed();
    const directory = archive("failed-capture");
    const original = source.blobs.getBlockBlobClient.bind(source.blobs);
    vi.spyOn(source.blobs, "getBlockBlobClient").mockImplementation((name) => {
      const client = original(name);
      vi.spyOn(client, "downloadToBuffer").mockRejectedValue(
        new Error("synthetic injected SDK download failure"),
      );
      return client;
    });
    await expect(captureStorageBackup(source, directory, application)).rejects.toThrow(
      /capture failed/,
    );
    expect((await lstat(join(directory, "rows.json"))).isFile()).toBe(true);
    await expect(lstat(join(directory, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(validateStorageBackup(directory)).rejects.toThrow();
    expect((await source.getControl()).writeMode).toBe("normal");
  }, 60_000);

  it("retains but invalidates the completion publication if freeze release fails", async () => {
    const { source } = await seed();
    const directory = archive("release-failure");
    const submit = source.table.submitTransaction.bind(source.table);
    vi.spyOn(source.table, "submitTransaction").mockImplementation(async (actions, options) => {
      if (
        actions.some(
          (action) =>
            action[0] === "create" && "kind" in action[1] && action[1].kind === "freeze-release",
        )
      )
        throw new Error("synthetic injected SDK freeze release failure");
      return submit(actions, options);
    });
    await expect(captureStorageBackup(source, directory, application)).rejects.toThrow(
      /freeze release failed/,
    );
    await expect(validateStorageBackup(directory)).rejects.toThrow();
    expect((await lstat(join(directory, "rows.json"))).isFile()).toBe(true);
    const frozen = await source.getControl();
    expect(frozen.writeMode).toBe("backup-frozen");
    vi.restoreAllMocks();
    await source.releaseFreeze(frozen.freezeOwner!);
  }, 60_000);

  it("keeps failed restores unavailable and rejects concurrent restores without activating partial state", async () => {
    const { source, directory } = await seed();
    const restored = target();
    const before = await rows(source);
    const create = restored.table.createEntity.bind(restored.table);
    vi.spyOn(restored.table, "createEntity").mockImplementation(async (row, options) => {
      if (row.rowKey === "probe") throw new Error("synthetic injected SDK row creation failure");
      return create(row, options);
    });
    await expect(restoreStorageBackup(restored, directory)).rejects.toThrow(/Restore failed/);
    expect((await restored.getEntity("control"))?.writeMode).toBe("restore-in-progress");
    await expect(restored.ready()).rejects.toThrow();
    expect(await restored.getEntity("probe")).toBeUndefined();
    expect((await restored.blobs.getProperties()).metadata?.backuprestoreowner).toBeDefined();
    await expect(restoreStorageBackup(restored, directory)).rejects.toThrow(/nonempty/);
    expect(await rows(source)).toEqual(before);
    vi.restoreAllMocks();
    const contested = target();
    const results = await Promise.allSettled([
      restoreStorageBackup(contested, directory),
      restoreStorageBackup(contested, directory),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await contested.ready();
  }, 60_000);

  it("reconciles a lost successful final activation response using exact restored control readback", async () => {
    const { directory } = await seed();
    const restored = target();
    const update = restored.table.updateEntity.bind(restored.table);
    vi.spyOn(restored.table, "updateEntity").mockImplementation(async (...args) => {
      await update(...args);
      throw new Error("synthetic lost successful SDK activation response");
    });
    const result = await restoreStorageBackup(restored, directory);
    expect((await restored.getControl()).dataEpoch).toBe(result.dataEpoch);
    await restored.ready();
  }, 60_000);

  it("refuses activation when real readback detects a corrupted uploaded byte stream", async () => {
    const { directory, manifest } = await seed();
    const restored = target();
    const original = restored.blobs.getBlockBlobClient.bind(restored.blobs);
    vi.spyOn(restored.blobs, "getBlockBlobClient").mockImplementation((name) => {
      const client = original(name);
      const upload = client.uploadData.bind(client);
      vi.spyOn(client, "uploadData").mockImplementation(async (bytes, options) => {
        const value = Buffer.from(bytes as Buffer);
        value[0] = value[0]! ^ 0xff;
        return upload(value, options);
      });
      return client;
    });
    await expect(restoreStorageBackup(restored, directory)).rejects.toThrow(/hash mismatch/);
    expect((await restored.getEntity("control"))?.writeMode).toBe("restore-in-progress");
    await expect(restored.ready()).rejects.toThrow();
    expect(await original(manifest.blobs[0]!.name).exists()).toBe(true);
  }, 60_000);
});

const encrypted = (key: Buffer, token: string): Buffer => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const payload = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), payload]);
};
describe("separately protected music recovery", () => {
  it("authenticates both inline and Blob-encrypted credentials with the actual AES-GCM key, never packaging it", async () => {
    const source = target();
    await source.initialize(true);
    const key = randomBytes(32);
    const access = encrypted(key, "synthetic-access");
    const refresh = encrypted(key, "synthetic-refresh");
    await source.mutate(async (tx) => {
      await tx.set(`music:${randomUUID()}`, {
        accessTokenEncrypted: access,
        refreshTokenEncrypted: refresh,
      });
      const ref = await tx.writeBlob(
        { access: access.toString("base64"), refresh: refresh.toString("base64") },
        "music",
      );
      await tx.set(`music:${randomUUID()}`, {
        tokenBlobName: ref.name,
        tokenBlobSha256: ref.sha256,
        tokenBlobLength: ref.length,
      });
    });
    const directory = archive("music");
    await captureStorageBackup(source, directory, application);
    const absent = target();
    await expect(restoreStorageBackup(absent, directory)).rejects.toThrow(/separately protected/);
    await expectUntouched(absent);
    const wrong = target();
    await expect(
      restoreStorageBackup(wrong, directory, {
        musicEncryptionKey: randomBytes(32).toString("base64url"),
      }),
    ).rejects.toThrow(/authenticate/);
    await expectUntouched(wrong);
    const restored = target();
    await restoreStorageBackup(restored, directory, {
      musicEncryptionKey: key.toString("base64url"),
    });
    const musicRows = (await rows(restored)).filter((row) => row.rowKey?.startsWith("music:"));
    expect(musicRows).toHaveLength(2);
    expect(await readFile(join(directory, "rows.json"), "utf8")).not.toContain(
      key.toString("base64url"),
    );
    expect(await readFile(join(directory, "manifest.json"), "utf8")).not.toContain(
      key.toString("base64url"),
    );
    key.fill(0);
  }, 60_000);
});
