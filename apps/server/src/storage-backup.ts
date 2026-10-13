import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import { createDecipheriv, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { z } from "zod";
import { type AzureStorage, digest } from "./azure-storage.js";
import {
  backupRowValues,
  binary,
  decodeBackupRow,
  encodeBackupRow,
  tableKey,
  validateBackupRow,
  type BackupRow,
} from "./storage-backup-codec.js";

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const length = z.number().int().min(0).max(67108864);
const uuid = z.string().uuid();
const manifestSchema = z
  .object({
    version: z.literal(1),
    complete: z.literal(true),
    captureId: uuid,
    datasetId: uuid,
    partitionKey: z.string().min(1),
    source: z.object({ tableUrl: z.string(), containerUrl: z.string() }).strict(),
    applicationVersion: z.string().min(1),
    applicationCommit: z.string().min(1),
    entityCount: z.number().int().min(1),
    blobCount: z.number().int().min(0),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
    frozenRevision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    rows: z
      .object({
        file: z.literal("rows.json"),
        sha256: hash,
        length: z.number().int().min(1).max(268435456),
      })
      .strict(),
    blobs: z.array(
      z
        .object({
          name: z.string().min(1),
          sha256: hash,
          length,
          file: z.string().regex(/^blobs\/[a-f0-9]{64}\.blob$/),
        })
        .strict(),
    ),
  })
  .strict();
export type BackupManifest = z.infer<typeof manifestSchema>;
interface Reference {
  name: string;
  sha256: string;
  length: number;
  live: boolean;
}
interface Package {
  manifest: BackupManifest;
  rows: BackupRow[];
  bytes: Map<string, Buffer>;
}
class BackupError extends Error {}
const fail = (message: string): never => {
  throw new BackupError(message);
};
const status = (error: unknown): number | undefined =>
  error !== null &&
  typeof error === "object" &&
  "statusCode" in error &&
  typeof error.statusCode === "number"
    ? error.statusCode
    : undefined;
const missing = (error: unknown): boolean => status(error) === 404;
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const endpoint = (value: string): string => {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return fail("Phase02 requires explicit credential-free loopback endpoints");
  return url.href.replace(/\/$/, "");
};
const local = (storage: AzureStorage) => {
  if (storage.options.connectionString === undefined || storage.options.accountName !== undefined)
    return fail("Phase02 remote and managed-identity backup operations are refused");
  return {
    tableUrl: endpoint(`${storage.table.url.replace(/\/$/, "")}/${storage.table.tableName}`),
    containerUrl: endpoint(storage.blobs.url),
  };
};
/** Check every ancestor; never follow a link to an unrelated archive tree. */
const realPath = async (path: string): Promise<void> => {
  if (!isAbsolute(path) || resolve(path) !== path)
    return fail("Backup package requires a normalized absolute path");
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split("/").filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      return fail("Backup path contains a symlink or non-directory");
  }
};
const privateDirectory = async (path: string): Promise<void> => {
  await realPath(path);
  const stat = await lstat(path);
  if ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
    return fail("Backup package directory must be owner-only");
};
const readPrivate = async (path: string, max: number): Promise<Buffer> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.() ||
      stat.size > max
    )
      return fail("Backup package file is unsafe or oversized");
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size) return fail("Backup file changed during validation");
    return bytes;
  } finally {
    await handle.close();
  }
};
const writePrivate = async (path: string, bytes: Buffer): Promise<void> => {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
};
const json = (bytes: Buffer): unknown => {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return fail("Backup JSON is malformed");
  }
};
const blobFile = (name: string): string => `blobs/${digest(name)}.blob`;
const prefix = (manifest: Pick<BackupManifest, "partitionKey" | "datasetId">): string =>
  `datasets/${digest(manifest.partitionKey)}/${manifest.datasetId}/`;
const references = (
  rows: BackupRow[],
  manifest: Pick<BackupManifest, "datasetId" | "partitionKey">,
): Map<string, Reference> => {
  const result = new Map<string, Reference>();
  for (const row of rows) {
    const values = backupRowValues(row);
    const stems = new Set(
      Object.keys(values).flatMap((name) =>
        name === "blobName" || name === "blobSha256" || name === "blobLength"
          ? ["blob"]
          : /Blob(Name|Sha256|Length)$/.test(name)
            ? [name.replace(/(Name|Sha256|Length)$/, "")]
            : [],
      ),
    );
    for (const stem of stems) {
      const name = values[`${stem}Name`];
      const sha256 = values[`${stem}Sha256`];
      const size = values[`${stem}Length`];
      if (
        typeof name !== "string" ||
        !name.startsWith(prefix(manifest)) ||
        name.includes("..") ||
        typeof sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(sha256) ||
        typeof size !== "number" ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > 67108864
      )
        return fail("Backup has a malformed or foreign blob reference");
      const existing = result.get(name);
      if (existing && (existing.sha256 !== sha256 || existing.length !== size))
        return fail("Conflicting backup blob references");
      result.set(name, {
        name,
        sha256,
        length: size,
        live: existing?.live === true || !row.rowKey.startsWith("cleanup:"),
      });
    }
  }
  return result;
};
const assertControl = (rows: BackupRow[], manifest: BackupManifest): BackupRow => {
  const control = rows.find((row) => row.rowKey === "control");
  if (!control) return fail("Backup control is missing");
  const values = backupRowValues(control);
  if (
    values.schemaVersion !== 1 ||
    values.datasetId !== manifest.datasetId ||
    values.blobContainer !== manifest.source.containerUrl ||
    values.writeMode !== "backup-frozen" ||
    values.freezeOwner !== manifest.captureId ||
    values.revision !== manifest.frozenRevision
  )
    return fail("Backup control and manifest disagree");
  if (values.dataEpoch !== undefined && !uuid.safeParse(values.dataEpoch).success)
    return fail("Backup data epoch is malformed");
  return control;
};
const validatePackage = async (directory: string): Promise<Package> => {
  await privateDirectory(directory);
  await privateDirectory(join(directory, "blobs"));
  const parsed = manifestSchema.safeParse(
    json(await readPrivate(join(directory, "manifest.json"), 16777216)),
  );
  if (!parsed.success) return fail("Unsupported, incomplete or malformed backup manifest");
  const manifest = parsed.data;
  tableKey(manifest.partitionKey);
  if (
    endpoint(manifest.source.tableUrl) !== manifest.source.tableUrl ||
    endpoint(manifest.source.containerUrl) !== manifest.source.containerUrl ||
    Date.parse(manifest.completedAt) < Date.parse(manifest.startedAt)
  )
    return fail("Invalid backup source or capture interval");
  const rowsBytes = await readPrivate(join(directory, manifest.rows.file), 268435456);
  if (rowsBytes.length !== manifest.rows.length || digest(rowsBytes) !== manifest.rows.sha256)
    return fail("Backup row hash or length mismatch");
  const input = json(rowsBytes);
  if (!Array.isArray(input) || input.length !== manifest.entityCount)
    return fail("Backup entity count mismatch");
  const rows = input.map(validateBackupRow);
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.partitionKey !== manifest.partitionKey || keys.has(row.rowKey))
      return fail("Duplicate or foreign backup entity");
    keys.add(row.rowKey);
  }
  assertControl(rows, manifest);
  const refs = references(rows, manifest);
  if (manifest.blobs.length !== manifest.blobCount) return fail("Backup blob count mismatch");
  const bytes = new Map<string, Buffer>();
  const files = new Set<string>();
  for (const blob of manifest.blobs) {
    const ref = refs.get(blob.name);
    if (
      !ref ||
      ref.sha256 !== blob.sha256 ||
      ref.length !== blob.length ||
      blob.file !== blobFile(blob.name) ||
      bytes.has(blob.name) ||
      files.has(blob.file)
    )
      return fail("Backup blob/reference graph mismatch");
    const content = await readPrivate(join(directory, blob.file), 67108864);
    if (content.length !== blob.length || digest(content) !== blob.sha256)
      return fail("Backup blob hash or length mismatch");
    bytes.set(blob.name, content);
    files.add(blob.file);
  }
  for (const ref of refs.values())
    if (ref.live && !bytes.has(ref.name)) return fail("Live backup blob is missing");
  if (
    (await readdir(directory)).sort().join(",") !== "blobs,manifest.json,rows.json" ||
    (await readdir(join(directory, "blobs"))).sort().join(",") !==
      [...files]
        .map((file) => file.slice(6))
        .sort()
        .join(",")
  )
    return fail("Unexpected backup package files");
  return { manifest, rows, bytes };
};
const listRows = async (storage: AzureStorage, absentAllowed = false): Promise<BackupRow[]> => {
  const rows: BackupRow[] = [];
  try {
    for await (const row of storage.table.listEntities<Record<string, unknown>>({
      disableTypeConversion: true,
    }))
      rows.push(encodeBackupRow(row));
  } catch (error) {
    if (!absentAllowed || !missing(error)) throw error;
  }
  return rows.sort((a, b) => order(a.rowKey, b.rowKey));
};
const download = async (
  storage: AzureStorage,
  ref: Pick<Reference, "name" | "sha256" | "length">,
): Promise<Buffer> => {
  const client = storage.blobs.getBlockBlobClient(ref.name);
  const properties = await client.getProperties();
  if (properties.contentLength !== ref.length) return fail("Stored blob length mismatch");
  const bytes = await client.downloadToBuffer(0, ref.length, {
    conditions: { ifMatch: properties.etag },
  });
  if (bytes.length !== ref.length || digest(bytes) !== ref.sha256)
    return fail("Stored blob hash mismatch");
  return bytes;
};
export const captureStorageBackup = async (
  storage: AzureStorage,
  directory: string,
  application: { applicationVersion: string; applicationCommit: string },
): Promise<BackupManifest> => {
  const source = local(storage);
  if (!application.applicationVersion || !application.applicationCommit)
    return fail("Application version and commit are required");
  if (!isAbsolute(directory) || resolve(directory) !== directory)
    return fail("Backup package requires a normalized absolute path");
  await realPath(dirname(directory));
  await mkdir(directory, { mode: 0o700 }); // Exclusive: partial inputs are never overwritten or deleted.
  await chmod(directory, 0o700);
  await mkdir(join(directory, "blobs"), { mode: 0o700 });
  const captureId = randomUUID();
  const startedAt = new Date().toISOString();
  let acquired = false;
  const retainIncomplete = async (): Promise<void> => {
    try {
      // Retain even a fully written publication as diagnostic input, but remove
      // its active completion name when any capture/release boundary fails.
      await rename(
        join(directory, "manifest.json"),
        join(directory, `failed-${captureId}.manifest.json`),
      );
    } catch (error) {
      if (!(
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        return fail("Unable to invalidate failed archive completion; manual inspection required");
    }
  };
  try {
    await storage.ready();
    await storage.acquireFreeze(captureId);
    acquired = true;
    const frozen = await storage.assertFreeze(captureId);
    const rows = await listRows(storage);
    if (rows.some((row) => row.partitionKey !== storage.options.partitionKey))
      return fail("Capture refuses a Table containing foreign partitions");
    const rowsBytes = Buffer.from(JSON.stringify(rows));
    await writePrivate(join(directory, "rows.json"), rowsBytes);
    const manifest: BackupManifest = {
      version: 1,
      complete: true,
      captureId,
      datasetId: frozen.datasetId,
      partitionKey: storage.options.partitionKey,
      source,
      ...application,
      entityCount: rows.length,
      blobCount: 0,
      startedAt,
      completedAt: startedAt,
      frozenRevision: frozen.revision,
      rows: { file: "rows.json", length: rowsBytes.length, sha256: digest(rowsBytes) },
      blobs: [],
    };
    assertControl(rows, manifest);
    const blobs: BackupManifest["blobs"] = [];
    for (const ref of [...references(rows, manifest).values()].sort((a, b) =>
      order(a.name, b.name),
    )) {
      let bytes: Buffer;
      try {
        bytes = await download(storage, ref);
      } catch (error) {
        if (!ref.live && missing(error)) continue;
        throw error;
      }
      const file = blobFile(ref.name);
      await writePrivate(join(directory, file), bytes);
      blobs.push({ name: ref.name, sha256: ref.sha256, length: ref.length, file });
    }
    const final = {
      ...manifest,
      completedAt: new Date().toISOString(),
      blobCount: blobs.length,
      blobs,
    };
    if (!manifestSchema.safeParse(final).success)
      return fail("Capture exceeds the supported package bounds");
    await privateDirectory(directory);
    await privateDirectory(join(directory, "blobs"));
    const storedRows = await readPrivate(join(directory, "rows.json"), 268435456);
    if (storedRows.length !== final.rows.length || digest(storedRows) !== final.rows.sha256)
      return fail("Written backup rows changed before completion");
    for (const blob of blobs) {
      const stored = await readPrivate(join(directory, blob.file), 67108864);
      if (stored.length !== blob.length || digest(stored) !== blob.sha256)
        return fail("Written backup blob changed before completion");
    }
    if (
      (await readdir(directory)).sort().join(",") !== "blobs,rows.json" ||
      (await readdir(join(directory, "blobs"))).sort().join(",") !==
        blobs
          .map((blob) => blob.file.slice(6))
          .sort()
          .join(",")
    )
      return fail("Unexpected incomplete backup files");
    const unchanged = await storage.assertFreeze(captureId);
    if (
      unchanged.etag !== frozen.etag ||
      JSON.stringify(await listRows(storage)) !== JSON.stringify(rows)
    )
      return fail("Frozen source changed during capture");
    // Every payload was checked before this sole completion publication.
    await writePrivate(join(directory, "manifest.json"), Buffer.from(JSON.stringify(final)));
    return final;
  } catch (error) {
    // SDK exceptions can contain signed requests. Never propagate them or keys.
    await retainIncomplete();
    if (error instanceof BackupError) throw error;
    return fail("Backup capture failed; incomplete archive retained");
  } finally {
    if (acquired)
      await storage.releaseFreeze(captureId).catch(async () => {
        await retainIncomplete();
        return fail(
          "Backup freeze release failed; incomplete archive retained and manual storage recovery may be required",
        );
      });
  }
};
export const validateStorageBackup = async (directory: string): Promise<BackupManifest> =>
  (await validatePackage(directory)).manifest;

const verifyMusic = (packageData: Package, keyString: string | undefined): void => {
  const music = packageData.rows.filter((row) => row.rowKey.startsWith("music:"));
  if (!music.length) return;
  if (keyString === undefined || !/^[A-Za-z0-9_-]{43}$/.test(keyString))
    return fail("Encrypted music recovery requires its separately protected 32-byte base64url key");
  const key = Buffer.from(keyString, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== keyString)
    return fail("Invalid protected music recovery key");
  try {
    for (const row of music) {
      const values = backupRowValues(row);
      let tokens: unknown[];
      if (typeof values.tokenBlobName === "string") {
        const bytes = packageData.bytes.get(values.tokenBlobName);
        if (!bytes) return fail("Missing encrypted music bytes");
        const payload = json(bytes) as Record<string, unknown>;
        if (typeof payload.access !== "string" || typeof payload.refresh !== "string")
          return fail("Malformed encrypted music bytes");
        tokens = [binary(payload.access), binary(payload.refresh)];
      } else tokens = [values.accessTokenEncrypted, values.refreshTokenEncrypted];
      for (const token of tokens) {
        if (!(token instanceof Uint8Array) || token[0] !== 1 || token.length < 30)
          return fail("Malformed encrypted music bytes");
        const bytes = Buffer.from(token);
        const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(1, 13));
        decipher.setAuthTag(bytes.subarray(13, 29));
        const clear = Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]);
        const valid = clear.length > 0;
        clear.fill(0);
        if (!valid) return fail("Empty encrypted music token");
      }
    }
  } catch {
    return fail("Music recovery key does not authenticate the encrypted credentials");
  } finally {
    key.fill(0);
  }
};
const emptyContainer = async (storage: AzureStorage): Promise<void> => {
  try {
    const properties = await storage.blobs.getProperties();
    if (properties.blobPublicAccess !== undefined || Object.keys(properties.metadata ?? {}).length)
      return fail("Restore container is public, foreign or already reserved");
    for await (const _blob of storage.blobs.listBlobsFlat()) {
      void _blob;
      return fail("Restore target container is nonempty");
    }
  } catch (error) {
    if (!missing(error)) throw error;
  }
};
export const restoreStorageBackup = async (
  storage: AzureStorage,
  directory: string,
  options: { musicEncryptionKey?: string } = {},
): Promise<{ manifest: BackupManifest; dataEpoch: string; invalidatedSessions: number }> => {
  const target = local(storage);
  const packageData = await validatePackage(directory); // No target side effects until all package/reference/key checks pass.
  const { manifest, rows, bytes } = packageData;
  if (
    target.tableUrl === manifest.source.tableUrl ||
    target.containerUrl === manifest.source.containerUrl
  )
    return fail("Restore source and target must use separate Table and container resources");
  if (storage.options.partitionKey !== manifest.partitionKey)
    return fail("Restore target partitionKey differs from the backup");
  verifyMusic(packageData, options.musicEncryptionKey);
  try {
    if ((await listRows(storage, true)).length)
      return fail("Restore target Table is nonempty or foreign");
    await emptyContainer(storage);
    await storage.table.createTable();
    const owner = randomUUID();
    const dataEpoch = randomUUID();
    const marker = {
      partitionKey: manifest.partitionKey,
      rowKey: "control",
      schemaVersion: -1,
      datasetId: manifest.datasetId,
      revision: manifest.frozenRevision,
      blobContainer: target.containerUrl,
      writeMode: "restore-in-progress",
      restoreOwner: owner,
      dataEpoch,
    };
    // Create-only control wins against other restores and normal application initialization.
    await storage.table.createEntity(marker);
    await storage.blobs.createIfNotExists();
    const lease = storage.blobs.getBlobLeaseClient(owner);
    await lease.acquireLease(-1);
    try {
      const properties = await storage.blobs.getProperties();
      if (
        properties.blobPublicAccess !== undefined ||
        Object.keys(properties.metadata ?? {}).length
      )
        return fail("Restore container is public, foreign or already reserved");
      await storage.blobs.setMetadata(
        { backuprestoreowner: owner },
        { conditions: { leaseId: owner } },
      );
    } finally {
      await lease.releaseLease();
    }
    const reserved = await storage.blobs.getProperties();
    if (reserved.metadata?.backuprestoreowner !== owner)
      return fail("Restore container reservation failed");
    const current = await listRows(storage);
    if (
      current.length !== 1 ||
      backupRowValues(current[0]!).restoreOwner !== owner ||
      current[0]!.partitionKey !== manifest.partitionKey
    )
      return fail("Restore Table changed during reservation");
    for await (const _blob of storage.blobs.listBlobsFlat()) {
      void _blob;
      return fail("Restore container changed during reservation");
    }
    for (const blob of manifest.blobs) {
      await storage.blobs.getBlockBlobClient(blob.name).uploadData(bytes.get(blob.name)!, {
        conditions: { ifNoneMatch: "*" },
        blobHTTPHeaders: { blobContentType: "application/json" },
        metadata: {
          sha256: blob.sha256,
          dataset: manifest.datasetId,
          length: String(blob.length),
        },
        maxSingleShotSize: 67108864,
        concurrency: 1,
      });
    }
    const business = rows.filter(
      (row) => row.rowKey !== "control" && !row.rowKey.startsWith("session:"),
    );
    // Serial create-only operations keep each request under both byte and operation limits.
    for (const row of business) await storage.table.createEntity(decodeBackupRow(row));
    const restoredRows = await listRows(storage);
    const restored = restoredRows.filter((row) => row.rowKey !== "control");
    const logical = (row: BackupRow) =>
      JSON.stringify({
        partitionKey: row.partitionKey,
        rowKey: row.rowKey,
        properties: Object.fromEntries(
          Object.entries(row.properties).sort(([a], [b]) => order(a, b)),
        ),
      });
    if (
      restored.length !== business.length ||
      restored.map(logical).sort().join("\n") !== business.map(logical).sort().join("\n")
    )
      return fail("Restored Table readback differs from the package");
    const markerRow = restoredRows.find((row) => row.rowKey === "control");
    if (!markerRow || logical(markerRow) !== logical(current[0]!))
      return fail("Restore control reservation changed");
    const names: string[] = [];
    for await (const blob of storage.blobs.listBlobsFlat()) names.push(blob.name);
    if (
      names.sort().join("\n") !==
      manifest.blobs
        .map((blob) => blob.name)
        .sort()
        .join("\n")
    )
      return fail("Restored container has unexpected or missing blobs");
    for (const blob of manifest.blobs) await download(storage, blob);
    const finalProperties = await storage.blobs.getProperties();
    if (
      finalProperties.blobPublicAccess !== undefined ||
      finalProperties.metadata?.backuprestoreowner !== owner
    )
      return fail("Restore container reservation changed");
    const control = decodeBackupRow(assertControl(rows, manifest));
    delete control.freezeOwner;
    delete control.dataEpoch;
    Object.assign(control, {
      writeMode: "normal",
      blobContainer: target.containerUrl,
      dataEpoch,
      revision: manifest.frozenRevision + 1,
    });
    // Only after every row and byte is read back does this CAS make the target servable.
    // A lost response is reconciled by this exact post-publication read, never guessed.
    try {
      await storage.table.updateEntity(control, "Replace", { etag: markerRow.service.etag });
    } catch {
      /* read the authoritative outcome below */
    }
    const expectedControl: BackupRow = {
      ...assertControl(rows, manifest),
      properties: {
        ...assertControl(rows, manifest).properties,
        writeMode: { type: "String", value: "normal" },
        blobContainer: { type: "String", value: target.containerUrl },
        dataEpoch: { type: "String", value: dataEpoch },
        revision: {
          type: manifest.frozenRevision + 1 <= 2147483647 ? "Int32" : "Double",
          value: String(manifest.frozenRevision + 1),
        },
      },
    };
    delete expectedControl.properties.freezeOwner;
    const activated = encodeBackupRow(
      await storage.table.getEntity<Record<string, unknown>>(manifest.partitionKey, "control", {
        disableTypeConversion: true,
      }),
    );
    if (logical(activated) !== logical(expectedControl))
      return fail("Unable to verify exact restored control activation");
    const active = await storage.getControl();
    if (
      active.writeMode !== "normal" ||
      active.datasetId !== manifest.datasetId ||
      active.dataEpoch !== dataEpoch ||
      active.revision !== manifest.frozenRevision + 1
    )
      return fail("Unable to verify restored control activation");
    await storage.ready();
    return {
      manifest,
      dataEpoch,
      invalidatedSessions: rows.filter((row) => row.rowKey.startsWith("session:")).length,
    };
  } catch (error) {
    if (error instanceof BackupError) throw error;
    return fail(
      "Restore failed or target refused; source and partial target retained, no automatic cleanup",
    );
  }
};
