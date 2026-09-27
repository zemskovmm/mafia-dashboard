import { z } from "zod";

/**
 * Game snapshots are browser-authoritative records.  The server validates only
 * the transport envelope; it never applies game rules or replays history.
 */
const snapshotObject = z.object({}).passthrough();

export const publicHistoryValidationIssue = (issue: z.core.$ZodIssue) => ({
  path: issue.path,
  message: issue.message,
});

export const gameSessionCreationSchema = z
  .object({
    creationId: z.uuid(),
    name: z.string().trim().min(1).max(100),
    state: snapshotObject,
    results: snapshotObject.nullable(),
  })
  .strict();

export const gameSessionMutationSchema = z
  .object({
    kind: z.literal("snapshot").optional(),
    operation: z.literal("snapshot").optional(),
    name: z.string().trim().min(1).max(100),
    mutationId: z.uuid(),
    state: snapshotObject,
    results: snapshotObject.nullable(),
  })
  .strict();
