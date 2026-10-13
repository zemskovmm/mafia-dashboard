import { odata } from "@azure/data-tables";
import {
  type AzureStorage,
  StorageUnavailableError,
  blobFields,
  blobReference,
  digest,
  type BlobReference,
} from "./azure-storage.js";

/** A partially present pointer is invalid, never permission to collect its bytes. */
export const blobReferences = (row: Record<string, unknown>): BlobReference[] => {
  const refs: BlobReference[] = [];
  for (const prefix of ["blob", "headerBlob", "cardBlob", "tokenBlob"]) {
    const names = [`${prefix}Name`, `${prefix}Sha256`, `${prefix}Length`];
    if (!names.some((name) => row[name] !== undefined)) continue;
    refs.push(
      blobReference({
        blobName: row[names[0]!],
        blobSha256: row[names[1]!],
        blobLength: row[names[2]!],
      }),
    );
  }
  return refs;
};

/**
 * Manual maintenance only. One durable freeze fences publication and deletion.
 * The live graph and caller's protected capture roots are validated before any
 * physical change. Cleanup pointers are not live authority: a prior interrupted
 * purge may already have removed their objects. Commit receipts remain forever
 * until a separate protocol can prove no ambiguous in-flight reader needs them.
 */
export const collectStorageGarbage = async (
  storage: AzureStorage,
  protectedReferences: readonly BlobReference[] = [],
): Promise<{ deletedBlobs: number; deletedRows: number }> =>
  storage.withMaintenanceFreeze(async () => {
    const control = await storage.getControl();
    const roots = new Map<string, BlobReference>();
    const protect = (reference: BlobReference): void => {
      const ref = blobReference(blobFields(reference));
      storage.assertBlobOwner(ref, control);
      const prior = roots.get(ref.name);
      if (prior !== undefined && (prior.sha256 !== ref.sha256 || prior.length !== ref.length))
        throw new StorageUnavailableError("Conflicting authoritative blob references");
      roots.set(ref.name, ref);
    };
    for (const ref of protectedReferences) protect(ref);
    const retired: Array<{ rowKey: string; ref: BlobReference }> = [];
    for await (const row of storage.table.listEntities<Record<string, unknown>>({
      queryOptions: { filter: odata`PartitionKey eq ${storage.options.partitionKey}` },
    })) {
      if (typeof row.rowKey !== "string")
        throw new StorageUnavailableError("Invalid maintenance row key");
      if (row.rowKey === "control" || row.rowKey.startsWith("commit:")) continue;
      if (row.rowKey.startsWith("cleanup:")) {
        if (row.kind !== "retired-blob")
          throw new StorageUnavailableError("Unsupported cleanup record");
        const ref = blobReference(row);
        storage.assertBlobOwner(ref, control);
        retired.push({ rowKey: row.rowKey, ref });
      } else for (const ref of blobReferences(row)) protect(ref);
    }
    // Verify all live/protected bytes before the first deletion. Retired pointers
    // are deliberately excluded: an interrupted purge may have removed them.
    for (const ref of roots.values()) {
      try {
        const client = storage.blobs.getBlockBlobClient(ref.name);
        const properties = await client.getProperties();
        if (properties.contentLength !== ref.length)
          throw new StorageUnavailableError("Authoritative blob length check failed");
        const bytes = await client.downloadToBuffer(0, ref.length, {
          conditions: { ifMatch: properties.etag },
        });
        if (bytes.length !== ref.length || digest(bytes) !== ref.sha256)
          throw new StorageUnavailableError("Authoritative blob integrity check failed");
      } catch (error) {
        if (error instanceof StorageUnavailableError) throw error;
        throw new StorageUnavailableError("Authoritative blob is missing or unreadable", {
          cause: error,
        });
      }
    }
    let deletedBlobs = 0;
    let deletedRows = 0;
    const prefix = storage.blobPrefix(control) + "/";
    for await (const blob of storage.blobs.listBlobsFlat({ prefix })) {
      if (!roots.has(blob.name) && (await storage.deleteOwnedBlob(blob.name))) deletedBlobs++;
    }
    const collectible = retired.filter(({ ref }) => !roots.has(ref.name));
    for (let offset = 0; offset < collectible.length; offset += 80) {
      const chunk = collectible.slice(offset, offset + 80);
      // Also handle a retired object missed by an earlier listing / already absent.
      for (const { ref } of chunk) if (await storage.deleteOwnedBlob(ref.name)) deletedBlobs++;
      await storage.mutate(async (tx) => {
        for (const { rowKey } of chunk) await tx.delete(rowKey);
      });
      for (const { rowKey } of chunk)
        if ((await storage.getEntity(rowKey)) !== undefined)
          throw new StorageUnavailableError("Unable to prove cleanup row deletion");
      deletedRows += chunk.length;
    }
    return { deletedBlobs, deletedRows };
  });
