import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  TableClient,
  odata,
  type TableEntity,
  type TableEntityResult,
  type TransactionAction,
} from "@azure/data-tables";
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";

export interface AzureStorageOptions {
  readonly connectionString?: string;
  readonly accountName?: string;
  readonly tableName: string;
  readonly containerName: string;
  readonly partitionKey: string;
}
export interface BlobReference {
  readonly name: string;
  readonly sha256: string;
  readonly length: number;
}
export interface StorageControl {
  readonly schemaVersion: number;
  readonly revision: number;
  readonly datasetId: string;
  readonly blobContainer: string;
  readonly writeMode: "normal" | "backup-frozen";
  readonly freezeOwner?: string;
  readonly dataEpoch?: string;
}
type Entity = Record<string, unknown>;
type StoredEntity = TableEntityResult<Entity>;
interface Authorization {
  readonly userId: string;
  readonly clubId: string;
  readonly manager: boolean;
}
const CONTROL_KEY = "control";
const RETRIES = 8;
const metadataKeys = new Set(["partitionKey", "rowKey", "etag", "timestamp", "odata.metadata"]);
const absent = (error: unknown): boolean => status(error) === 404;
const status = (error: unknown): number | undefined =>
  error !== null &&
  typeof error === "object" &&
  "statusCode" in error &&
  typeof error.statusCode === "number"
    ? error.statusCode
    : undefined;
export const digest = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
export const uuidKey = (value: string): string => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw new Error("Invalid UUID storage key");
  return value.toLowerCase();
};
const key = (value: string): string => {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf16le") > 1_024 ||
    [...value].some(
      (character) =>
        "/\\#?".includes(character) ||
        character.charCodeAt(0) < 32 ||
        (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159),
    )
  )
    throw new Error("Invalid Table storage key");
  return value;
};
const fields = (value: object): Entity =>
  Object.fromEntries(
    Object.entries(value)
      .filter(([name, value]) => !metadataKeys.has(name) && value !== null && value !== undefined)
      .map(([name, value]) => [name, value instanceof Uint8Array ? Buffer.from(value) : value]),
  );

export class StorageUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = "storage_unavailable";
  constructor(message = "Authoritative storage is unavailable", options?: ErrorOptions) {
    super(message, options);
  }
}
export class StorageAccessError extends Error {
  readonly statusCode = 403;
  readonly code: string;
  constructor(manager = false) {
    super(manager ? "Club manager access required" : "Club access required");
    this.code = manager ? "club_manager_required" : "club_access_denied";
  }
}

const explicitDateTime = (value: unknown): value is { type: "DateTime"; value: string } => {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join(",") !== "type,value" ||
    row.type !== "DateTime" ||
    typeof row.value !== "string"
  )
    return false;
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?Z$/.exec(row.value);
  const date = new Date(row.value);
  return (
    parts !== null &&
    Number.isFinite(date.getTime()) &&
    date.getUTCFullYear() >= 1601 &&
    date.toISOString() === `${parts[1]}.${(parts[2] ?? "").padEnd(3, "0").slice(0, 3)}Z`
  );
};

/** Table EDM scalars only; bounds use UTF-16, not JSON's misleading UTF-8 size. */
export const validateTableEntity = (value: object): void => {
  const entries = Object.entries(fields(value));
  if (entries.length > 252) throw new Error("Too many Table entity properties");
  let bytes = 128;
  for (const [name, item] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(name))
      throw new Error("Invalid Table property name");
    bytes += Buffer.byteLength(name, "utf16le") + 32;
    let size: number;
    if (typeof item === "string") size = Buffer.byteLength(item, "utf16le");
    else if (item instanceof Uint8Array) size = item.byteLength;
    else if (item instanceof Date) {
      if (!Number.isFinite(item.getTime()) || item.getUTCFullYear() < 1601)
        throw new Error("Invalid Table date");
      size = 8;
    } else if (explicitDateTime(item)) size = 8;
    else if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error("Table numbers must be finite");
      size = 8;
    } else if (typeof item === "boolean") size = 1;
    else throw new Error("Table properties must be typed scalar values");
    if (size > 65_536) throw new Error("Table property exceeds 64 KiB");
    bytes += size;
  }
  if (bytes > 1_048_576) throw new Error("Table entity exceeds 1 MiB");
};
const wireSize = (value: object): number => {
  const wire: Entity = {};
  for (const [name, item] of Object.entries(value)) {
    wire[name] = item instanceof Uint8Array ? Buffer.from(item).toString("base64") : item;
    if (explicitDateTime(item)) {
      wire[name] = item.value;
      wire[`${name}@odata.type`] = "Edm.DateTime";
    }
    if (item instanceof Date) wire[`${name}@odata.type`] = "Edm.DateTime";
    if (item instanceof Uint8Array) wire[`${name}@odata.type`] = "Edm.Binary";
  }
  return Buffer.byteLength(JSON.stringify(wire));
};
export const blobFields = (ref: BlobReference): Entity => ({
  blobName: ref.name,
  blobSha256: ref.sha256,
  blobLength: ref.length,
});
export const blobReference = (value: object): BlobReference => {
  const row = value as Entity;
  if (
    typeof row.blobName !== "string" ||
    typeof row.blobSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.blobSha256) ||
    typeof row.blobLength !== "number" ||
    !Number.isSafeInteger(row.blobLength) ||
    row.blobLength < 0 ||
    row.blobLength > 67_108_864
  ) {
    throw new StorageUnavailableError("Invalid authoritative blob reference");
  }
  return { name: row.blobName, sha256: row.blobSha256, length: row.blobLength };
};

export class AzureTransaction {
  readonly originals = new Map<string, StoredEntity | undefined>();
  readonly changes = new Map<string, Entity | null>();
  constructor(
    private readonly storage: AzureStorage,
    readonly control: TableEntityResult<StorageControl>,
    private readonly writable: boolean,
  ) {}

  async get<T extends object>(rowKey: string): Promise<T | undefined> {
    key(rowKey);
    if (this.changes.has(rowKey)) {
      const row = this.changes.get(rowKey);
      return row === null ? undefined : ({ ...row } as T);
    }
    if (!this.originals.has(rowKey))
      this.originals.set(rowKey, await this.storage.getEntity(rowKey));
    const row = this.originals.get(rowKey);
    return row === undefined ? undefined : (fields(row) as T);
  }
  async list<T extends object>(prefix: string): Promise<Array<T & { rowKey: string }>> {
    key(prefix);
    const rows = new Map<string, T & { rowKey: string }>();
    // Internal keys are ASCII, so appending '~' is a valid strict upper bound.
    for await (const row of this.storage.table.listEntities<Entity>({
      queryOptions: {
        filter: odata`PartitionKey eq ${this.storage.options.partitionKey} and RowKey ge ${prefix} and RowKey lt ${prefix + "~"}`,
      },
    })) {
      if (row.rowKey === undefined)
        throw new StorageUnavailableError("Table query returned an invalid key");
      this.originals.set(row.rowKey, row);
      rows.set(row.rowKey, { ...fields(row), rowKey: row.rowKey } as T & { rowKey: string });
    }
    for (const [rowKey, row] of this.changes) {
      if (!rowKey.startsWith(prefix)) continue;
      if (row === null) rows.delete(rowKey);
      else rows.set(rowKey, { ...row, rowKey } as T & { rowKey: string });
    }
    return [...rows.values()].sort((a, b) => a.rowKey.localeCompare(b.rowKey));
  }
  async set(rowKey: string, value: object): Promise<void> {
    this.assertWritable(rowKey);
    validateTableEntity(value);
    await this.get(rowKey);
    this.changes.set(rowKey, fields(value));
  }
  async delete(rowKey: string): Promise<void> {
    this.assertWritable(rowKey);
    await this.get(rowKey);
    if (this.originals.get(rowKey) === undefined) this.changes.delete(rowKey);
    else this.changes.set(rowKey, null);
  }
  async writeBlob(value: unknown, prefix = "snapshots"): Promise<BlobReference> {
    if (!this.writable) throw new Error("Read transaction cannot create blobs");
    if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(prefix))
      throw new Error("Invalid blob purpose");
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Blob value must be serializable");
    const bytes = Buffer.from(encoded);
    if (bytes.length > 67_108_864) throw new Error("Snapshot blob exceeds supported size");
    const ref = {
      name: `${this.storage.blobPrefix(this.control)}/${prefix}/${randomUUID()}.json`,
      sha256: digest(bytes),
      length: bytes.length,
    };
    const client = this.storage.blobs.getBlockBlobClient(ref.name);
    try {
      await client.uploadData(bytes, {
        conditions: { ifNoneMatch: "*" },
        blobHTTPHeaders: { blobContentType: "application/json" },
        metadata: {
          sha256: ref.sha256,
          dataset: this.control.datasetId,
          length: String(ref.length),
        },
      });
    } catch (error) {
      // An upload response can be lost. Existing immutable bytes must prove success.
      try {
        await this.readBlob(ref);
      } catch {
        throw new StorageUnavailableError("Snapshot upload failed", { cause: error });
      }
    }
    await this.readBlob(ref);
    return ref;
  }
  async readBlob<T>(reference: BlobReference): Promise<T> {
    const ref = blobReference(blobFields(reference));
    this.storage.assertBlobOwner(ref, this.control);
    try {
      const client = this.storage.blobs.getBlockBlobClient(ref.name);
      const properties = await client.getProperties();
      if (properties.contentLength !== ref.length)
        throw new StorageUnavailableError("Authoritative blob length check failed");
      const bytes = await client.downloadToBuffer(0, ref.length, {
        conditions: { ifMatch: properties.etag },
      });
      if (bytes.length !== ref.length || digest(bytes) !== ref.sha256)
        throw new StorageUnavailableError("Authoritative blob integrity check failed");
      return JSON.parse(bytes.toString("utf8")) as T;
    } catch (error) {
      if (error instanceof StorageUnavailableError) throw error;
      throw new StorageUnavailableError("Authoritative blob is missing or unreadable", {
        cause: error,
      });
    }
  }
  async retireBlob(ref: BlobReference): Promise<void> {
    this.storage.assertBlobOwner(ref, this.control);
    await this.set(`cleanup:${digest(ref.name)}`, {
      ...blobFields(ref),
      kind: "retired-blob",
      retiredAt: new Date(),
    });
  }
  private assertWritable(rowKey: string): void {
    if (!this.writable || rowKey === CONTROL_KEY || rowKey.startsWith("commit:"))
      throw new Error("Reserved or read-only storage write");
    key(rowKey);
  }
}

export class AzureStorage {
  static readonly explicitCredentialSupported = true;
  readonly table: TableClient;
  readonly blobs: ContainerClient;
  private readonly authorization = new AsyncLocalStorage<Authorization>();
  private readonly maintenanceOwner = new AsyncLocalStorage<string>();
  private readonly activeTransaction = new AsyncLocalStorage<boolean>();
  constructor(
    readonly options: AzureStorageOptions,
    explicitCredential?: Pick<DefaultAzureCredential, "getToken">,
  ) {
    if (
      !/^[A-Za-z][A-Za-z0-9]{2,62}$/.test(options.tableName) ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.containerName) ||
      options.containerName.length < 3 ||
      options.containerName.length > 63
    )
      throw new Error("Invalid Azure storage resource names");
    key(options.partitionKey);
    if (options.connectionString !== undefined) {
      if (explicitCredential !== undefined)
        throw new Error("Explicit credentials cannot be combined with a connection string");
      const parts = new Map(
        options.connectionString
          .split(";")
          .filter(Boolean)
          .map((part) => {
            const index = part.indexOf("=");
            return [part.slice(0, index), part.slice(index + 1)] as const;
          }),
      );
      for (const name of ["BlobEndpoint", "TableEndpoint"]) {
        const endpoint = parts.get(name);
        if (endpoint === undefined)
          throw new Error("Local storage requires explicit loopback endpoints");
        const url = new URL(endpoint);
        if (
          url.protocol !== "http:" ||
          url.hostname !== "127.0.0.1" ||
          url.username !== "" ||
          url.password !== "" ||
          url.search !== ""
        )
          throw new Error(
            "Storage connection strings are allowed only for owned loopback emulators",
          );
      }
      if (
        parts.has("SharedAccessSignature") ||
        parts.get("DefaultEndpointsProtocol") !== "http" ||
        options.accountName !== undefined
      )
        throw new Error("Invalid local Azure storage configuration");
      this.table = TableClient.fromConnectionString(options.connectionString, options.tableName, {
        allowInsecureConnection: true,
        retryOptions: { maxRetries: 0 },
      });
      this.blobs = BlobServiceClient.fromConnectionString(options.connectionString, {
        retryOptions: { maxTries: 1 },
      }).getContainerClient(options.containerName);
    } else {
      if (options.accountName === undefined || !/^[a-z0-9]{3,24}$/.test(options.accountName))
        throw new Error("Azure storage requires a valid account and managed identity");
      const credential = explicitCredential ?? new DefaultAzureCredential();
      this.table = new TableClient(
        `https://${options.accountName}.table.core.windows.net`,
        options.tableName,
        credential,
        { retryOptions: { maxRetries: 0 } },
      );
      this.blobs = new BlobServiceClient(
        `https://${options.accountName}.blob.core.windows.net`,
        credential,
        { retryOptions: { maxTries: 1 } },
      ).getContainerClient(options.containerName);
    }
  }
  blobPrefix(control: StorageControl): string {
    return `datasets/${digest(this.options.partitionKey)}/${control.datasetId}`;
  }
  assertBlobOwner(ref: Pick<BlobReference, "name">, control: StorageControl): void {
    if (!ref.name.startsWith(this.blobPrefix(control) + "/") || ref.name.includes(".."))
      throw new StorageUnavailableError("Blob is outside the authoritative dataset");
  }
  async getEntity(rowKey: string): Promise<StoredEntity | undefined> {
    try {
      return await this.table.getEntity<Entity>(this.options.partitionKey, rowKey);
    } catch (error) {
      if (absent(error)) return undefined;
      throw error;
    }
  }
  async getControl(): Promise<TableEntityResult<StorageControl>> {
    const row = await this.getEntity(CONTROL_KEY);
    if (
      row === undefined ||
      row.schemaVersion !== 1 ||
      typeof row.datasetId !== "string" ||
      typeof row.revision !== "number" ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 0 ||
      row.blobContainer !== this.blobs.url ||
      typeof row.etag !== "string"
    )
      throw new StorageUnavailableError("Uninitialized or unsupported authoritative storage");
    if (row.writeMode !== "normal" && row.writeMode !== "backup-frozen")
      throw new StorageUnavailableError("Unsupported storage write mode");
    try {
      uuidKey(row.datasetId);
      if (row.dataEpoch !== undefined) uuidKey(row.dataEpoch as string);
      if (row.freezeOwner !== undefined) uuidKey(row.freezeOwner as string);
    } catch {
      throw new StorageUnavailableError("Invalid storage control identity");
    }
    if (row.writeMode === "normal" && row.freezeOwner !== undefined)
      throw new StorageUnavailableError("Unexpected owner in normal storage control");
    return row as unknown as TableEntityResult<StorageControl>;
  }
  async initialize(allowEmpty: boolean): Promise<void> {
    if (allowEmpty) {
      await this.table.createTable();
      await this.blobs.createIfNotExists();
      const existing = await this.getEntity(CONTROL_KEY);
      if (existing === undefined) {
        for await (const _row of this.table.listEntities({
          queryOptions: { filter: odata`PartitionKey eq ${this.options.partitionKey}` },
        })) {
          void _row;
          throw new StorageUnavailableError(
            "Existing entities have no recognized schema; refusing initialization",
          );
        }
        try {
          await this.table.createEntity({
            partitionKey: this.options.partitionKey,
            rowKey: CONTROL_KEY,
            schemaVersion: 1,
            revision: 0,
            datasetId: randomUUID(),
            blobContainer: this.blobs.url,
            writeMode: "normal",
          });
        } catch (error) {
          if (status(error) !== 409) throw error;
        }
      }
    }
    await this.ready();
  }
  async ready(): Promise<void> {
    await this.getControl();
    const properties = await this.blobs.getProperties();
    if (properties.blobPublicAccess !== undefined)
      throw new StorageUnavailableError("Authoritative blobs must be private");
  }
  async end(): Promise<void> {
    /* SDK clients own no application background work. */
  }
  private checkFreeze(control: StorageControl, owner: string): void {
    if (control.writeMode !== "backup-frozen" || control.freezeOwner !== owner)
      throw new StorageUnavailableError("Storage freeze owner does not match");
  }
  async assertFreeze(owner: string): Promise<TableEntityResult<StorageControl>> {
    uuidKey(owner);
    const control = await this.getControl();
    this.checkFreeze(control, owner);
    return control;
  }
  async acquireFreeze(owner: string): Promise<TableEntityResult<StorageControl>> {
    return this.changeFreeze(owner, true);
  }
  async releaseFreeze(owner: string): Promise<void> {
    await this.changeFreeze(owner, false);
  }
  private async changeFreeze(
    owner: string,
    acquire: boolean,
  ): Promise<TableEntityResult<StorageControl>> {
    uuidKey(owner);
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const control = await this.getControl();
      if (acquire) {
        // Even the same UUID is not permission for concurrent acquisitions.
        if (control.writeMode !== "normal")
          throw new StorageUnavailableError(
            "Storage is already frozen; explicit owner abort required",
          );
      } else this.checkFreeze(control, owner);
      if (!Number.isSafeInteger(control.revision + 1))
        throw new StorageUnavailableError("Storage revision exhausted");
      const next = fields(control);
      next.revision = control.revision + 1;
      next.writeMode = acquire ? "backup-frozen" : "normal";
      if (acquire) next.freezeOwner = owner;
      else delete next.freezeOwner;
      const receiptKey = `commit:${randomUUID()}`;
      const receipt = {
        partitionKey: this.options.partitionKey,
        rowKey: receiptKey,
        kind: acquire ? "freeze-acquire" : "freeze-release",
        freezeOwner: owner,
        datasetId: control.datasetId,
        revision: next.revision,
        createdAt: new Date(),
      };
      const actions: TransactionAction[] = [
        [
          "update",
          { partitionKey: this.options.partitionKey, rowKey: CONTROL_KEY, ...next },
          "Replace",
          { etag: control.etag },
        ],
        ["create", receipt],
      ];
      const prove = async (): Promise<boolean> => {
        const saved = await this.getEntity(receiptKey);
        return (
          saved !== undefined &&
          saved.kind === receipt.kind &&
          saved.freezeOwner === owner &&
          saved.datasetId === control.datasetId &&
          saved.revision === receipt.revision
        );
      };
      try {
        await this.table.submitTransaction(actions);
        if (!(await prove()))
          throw new StorageUnavailableError("Unable to prove freeze publication");
      } catch (error) {
        let committed: boolean;
        try {
          committed = await prove();
        } catch {
          throw new StorageUnavailableError("Unable to prove freeze publication", { cause: error });
        }
        if (!committed) {
          if (status(error) === 409 || status(error) === 412) {
            await delay(attempt * 5);
            continue;
          }
          throw new StorageUnavailableError("Freeze publication failed", { cause: error });
        }
      }
      // A receipt proves this exact transition, never ownership of a later freeze.
      const current = await this.getControl();
      if (acquire) this.checkFreeze(current, owner);
      return current;
    }
    throw new StorageUnavailableError("Storage is busy; retry the freeze operation");
  }
  /** Own one durable fence for bounded Table chunks and physical Blob removal. */
  async withMaintenanceFreeze<T>(work: () => Promise<T>): Promise<T> {
    if (this.activeTransaction.getStore() || this.maintenanceOwner.getStore() !== undefined)
      throw new Error("Acquire maintenance outside a storage transaction");
    const owner = randomUUID();
    await this.acquireFreeze(owner);
    try {
      return await this.maintenanceOwner.run(owner, work);
    } finally {
      // No timeout or automatic takeover. A process crash retains this owner.
      await this.releaseFreeze(owner);
    }
  }
  async deleteBlob(ref: BlobReference): Promise<void> {
    await this.deleteOwnedBlob(ref.name);
  }
  /** Delete by owned name: orphan objects need not have a valid payload/hash. */
  async deleteOwnedBlob(name: string): Promise<boolean> {
    const owner = this.maintenanceOwner.getStore();
    if (owner === undefined) return this.withMaintenanceFreeze(() => this.deleteOwnedBlob(name));
    const control = await this.assertFreeze(owner);
    this.assertBlobOwner({ name }, control);
    let deleted = true;
    try {
      await this.blobs.deleteBlob(name, { deleteSnapshots: "include" });
    } catch (error) {
      if (!absent(error)) throw error;
      deleted = false;
    }
    if (await this.blobs.getBlockBlobClient(name).exists())
      throw new StorageUnavailableError("Unable to prove physical blob deletion");
    await this.assertFreeze(owner);
    return deleted;
  }
  async runAuthorized<T>(
    userId: string,
    clubId: string,
    manager: boolean,
    work: () => Promise<T>,
  ): Promise<T> {
    return this.authorization.run(
      { userId: uuidKey(userId), clubId: uuidKey(clubId), manager },
      work,
    );
  }
  private async authorize(tx: AzureTransaction): Promise<void> {
    const actor = this.authorization.getStore();
    if (actor === undefined) return;
    const prefix = `club:${actor.clubId}:`;
    if (
      (await tx.get(`deleted-club:${actor.clubId}`)) !== undefined ||
      (await tx.get(`${prefix}meta`)) === undefined
    )
      throw new StorageAccessError();
    const member = await tx.get<{ role: string }>(`${prefix}member:${actor.userId}`);
    if (member === undefined) throw new StorageAccessError();
    if (actor.manager && member.role !== "manager") throw new StorageAccessError(true);
  }
  private async stable<T>(
    writable: boolean,
    work: (tx: AzureTransaction) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const control = await this.getControl();
      const maintenanceOwner = this.maintenanceOwner.getStore();
      if (writable && maintenanceOwner !== undefined) this.checkFreeze(control, maintenanceOwner);
      else if (writable && control.writeMode !== "normal")
        throw new StorageUnavailableError("Storage writes are frozen for backup");
      const tx = new AzureTransaction(this, control, writable);
      let result: T;
      try {
        await this.authorize(tx);
        result = await this.activeTransaction.run(writable, () => work(tx));
      } catch (error) {
        if ((await this.getControl()).etag !== control.etag) {
          await delay(attempt * 5);
          continue;
        }
        throw error;
      }
      if ((await this.getControl()).etag !== control.etag) {
        await delay(attempt * 5);
        continue;
      }
      if (!writable || tx.changes.size === 0) return result;
      const commitId = randomUUID();
      const actions: TransactionAction[] = [
        [
          "update",
          {
            partitionKey: this.options.partitionKey,
            rowKey: CONTROL_KEY,
            ...fields(control),
            revision: control.revision + 1,
          },
          "Replace",
          { etag: control.etag },
        ],
        [
          "create",
          {
            partitionKey: this.options.partitionKey,
            rowKey: `commit:${commitId}`,
            revision: control.revision + 1,
            createdAt: new Date(),
          },
        ],
      ];
      let size = 0;
      for (const [rowKey, value] of tx.changes) {
        const original = tx.originals.get(rowKey);
        const entity: TableEntity = { partitionKey: this.options.partitionKey, rowKey, ...value };
        // The public SDK exposes no per-delete ETag in a batch. The first
        // conditional control update fences every deletion in this atomic group.
        if (value === null) actions.push(["delete", entity]);
        else if (original === undefined) actions.push(["create", entity]);
        else actions.push(["update", entity, "Replace", { etag: original.etag }]);
      }
      for (const [, entity] of actions)
        size += wireSize(entity) + 4_096 + Buffer.byteLength(this.table.url) * 3;
      if (actions.length > 100 || size > 4_194_304)
        throw new Error("Authoritative Table transaction exceeds Azure limits");
      try {
        await this.table.submitTransaction(actions);
        if ((await this.getEntity(`commit:${commitId}`)) === undefined)
          throw new StorageUnavailableError("Unable to prove storage publication");
        return result;
      } catch (error) {
        // Receipt shares the atomic group. It proves this exact attempt even if
        // another writer has already replaced its pointers/control revision.
        try {
          if ((await this.getEntity(`commit:${commitId}`)) !== undefined) return result;
        } catch {
          throw new StorageUnavailableError("Unable to prove storage publication", {
            cause: error,
          });
        }
        if (status(error) === 409 || status(error) === 412) {
          await delay(attempt * 5);
          continue;
        }
        throw new StorageUnavailableError("Storage publication failed", { cause: error });
      }
    }
    throw new StorageUnavailableError("Storage is busy; retry the operation");
  }
  read<T>(work: (tx: AzureTransaction) => Promise<T>): Promise<T> {
    return this.stable(false, work);
  }
  mutate<T>(work: (tx: AzureTransaction) => Promise<T>): Promise<T> {
    return this.stable(true, work);
  }
}
