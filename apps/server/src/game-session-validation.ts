import { z } from "zod";
import { inspectGameIdentities } from "./game-session-identity.js";

/**
 * Game snapshots are browser-authoritative records.  The server validates only
 * the transport envelope; it never applies game rules or replays history.
 */
const snapshotObject = z.object({}).passthrough();

export const publicHistoryValidationIssue = (issue: z.core.$ZodIssue) => ({
  path: issue.path,
  message: issue.message,
});

const identityOnly = (
  value: { state: Record<string, unknown>; results: Record<string, unknown> | null },
  context: z.core.$RefinementCtx,
) => {
  const inspected = inspectGameIdentities(value.state, value.results);
  if (inspected.named || inspected.invalid)
    context.addIssue({
      code: "custom",
      path: ["state"],
      message: "Unsupported or invalid player identity reference",
    });
};

export const gameSessionCreationSchema = z
  .object({
    creationId: z.uuid(),
    name: z.string().trim().min(1).max(100),
    state: snapshotObject,
    results: snapshotObject.nullable(),
  })
  .strict()
  .superRefine(identityOnly);

export const gameSessionMutationSchema = z
  .object({
    kind: z.literal("snapshot").optional(),
    operation: z.literal("snapshot").optional(),
    name: z.string().trim().min(1).max(100),
    mutationId: z.uuid(),
    state: snapshotObject,
    results: snapshotObject.nullable(),
  })
  .strict()
  .superRefine(identityOnly);
