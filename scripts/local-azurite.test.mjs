import assert from "node:assert/strict";
import { test } from "node:test";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { URL, fileURLToPath } from "node:url";
import { TableServiceClient } from "@azure/data-tables";
import { BlobServiceClient } from "@azure/storage-blob";
import { startAzurite } from "./local-azurite.mjs";

const root = fileURLToPath(new URL("../.AI/local-azurite/", import.meta.url));

const assertServiceReady = async (environment) => {
  const { AZURE_STORAGE_CONNECTION_STRING: connection } = environment;
  await TableServiceClient.fromConnectionString(connection, { allowInsecureConnection: true })
    .listTables()
    .next();
  await BlobServiceClient.fromConnectionString(connection).listContainers().next();
};

test(
  "disposable fixtures reach real Table and Blob endpoints and clean only their owned data",
  { timeout: 60_000 },
  async () => {
    const first = await startAzurite();
    const second = await startAzurite({ mode: "test" });
    const firstEnv = first.environment;
    const secondEnv = second.environment;
    const firstBlobPort = new URL(
      firstEnv.AZURE_STORAGE_CONNECTION_STRING.match(/BlobEndpoint=([^;]+)/)[1],
    ).port;
    const secondBlobPort = new URL(
      secondEnv.AZURE_STORAGE_CONNECTION_STRING.match(/BlobEndpoint=([^;]+)/)[1],
    ).port;
    try {
      assert.notEqual(firstBlobPort, secondBlobPort);
      assert.notEqual(firstEnv.AZURE_STORAGE_PARTITION_KEY, secondEnv.AZURE_STORAGE_PARTITION_KEY);
      assert.notEqual(firstEnv.AZURE_STORAGE_TABLE_NAME, secondEnv.AZURE_STORAGE_TABLE_NAME);
      assert.notEqual(
        firstEnv.AZURE_STORAGE_CONTAINER_NAME,
        secondEnv.AZURE_STORAGE_CONTAINER_NAME,
      );
      assert.equal(firstEnv.STORAGE_PROVIDER, "azure");
      assert.equal(firstEnv.AZURE_STORAGE_INITIALIZE, "true");
      await Promise.all([assertServiceReady(firstEnv), assertServiceReady(secondEnv)]);
      const directory = join(root, "tests");
      const instances = await readdir(directory);
      assert.equal(instances.length >= 2, true);
      await first.stop();
      await first.stop();
      await assert.rejects(assertServiceReady(firstEnv));
      await assertServiceReady(secondEnv);
    } finally {
      await first.stop();
      await second.stop();
    }
  },
);

test(
  "persistent dev dataset keeps its identity and stored Table entity across restarts",
  { timeout: 60_000 },
  async () => {
    const first = await startAzurite({ mode: "dev" });
    const firstEnv = first.environment;
    try {
      await assertServiceReady(firstEnv);
      const table = TableServiceClient.fromConnectionString(
        firstEnv.AZURE_STORAGE_CONNECTION_STRING,
        { allowInsecureConnection: true },
      );
      await table.createTable(firstEnv.AZURE_STORAGE_TABLE_NAME).catch((error) => {
        if (error.statusCode !== 409) throw error;
      });
    } finally {
      await first.stop();
    }
    const second = await startAzurite({ mode: "dev" });
    try {
      assert.deepEqual(second.environment, firstEnv);
      const table = TableServiceClient.fromConnectionString(
        firstEnv.AZURE_STORAGE_CONNECTION_STRING,
        { allowInsecureConnection: true },
      );
      const names = [];
      for await (const entry of table.listTables()) names.push(entry.name);
      assert.ok(names.includes(firstEnv.AZURE_STORAGE_TABLE_NAME));
    } finally {
      await second.stop();
    }
  },
);

test(
  "an unowned dev directory and symlinked fixture root are refused without deletion",
  { timeout: 60_000 },
  async () => {
    const dev = join(root, "dev");
    const marker = join(dev, ".mafia-local-azurite-owner.json");
    let original;
    try {
      original = await readFile(marker);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const existed = await lstat(dev).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    await mkdir(dev, { recursive: true });
    await writeFile(marker, "foreign-fixture\n");
    try {
      await assert.rejects(startAzurite({ mode: "dev" }), /ownership marker|owned/i);
      assert.equal(await readFile(marker, "utf8"), "foreign-fixture\n");
    } finally {
      if (original) await writeFile(marker, original);
      else {
        await unlink(marker);
        if (!existed) await rmdir(dev);
      }
    }
    const outside = join(root, "outside-sentinel");
    const link = join(root, "tests", "symlink-sentinel");
    await mkdir(outside, { recursive: true });
    await symlink(outside, link);
    try {
      await assert.rejects(startAzurite({ rootDirectory: link }), /owned fixture root|path/i);
      assert.equal((await lstat(outside)).isDirectory(), true);
    } finally {
      // The sentinel link is ours and the target is deliberately not removed by the launcher.
      await unlink(link);
      await rmdir(outside);
    }
  },
);

test("fixture refuses unknown modes and arbitrary directories before touching them", async () => {
  await assert.rejects(startAzurite({ mode: "production" }), /mode/i);
  await assert.rejects(
    startAzurite({ rootDirectory: "/tmp/foreign-fixture" }),
    /owned fixture root/i,
  );
});
