import { z } from "zod";
import { hasEngineSelector, inspectGameIdentities } from "./game-session-identity.js";

/**
 * Game snapshots are browser-authoritative records.  The server validates only
 * the transport envelope; it never applies game rules or replays history.
 */
const snapshotObject = z.object({}).passthrough();

// Admission checks shape and size only: rule applicability, committee agreement
// and the winner are browser-domain decisions. Do not trim accepted JSON.
export const adjudicationMetadataSchema = z
  .object({
    losingTeam: z.enum(["red", "black"]),
    offenderSeat: z.number().int().min(1).max(10).optional(),
    rule: z
      .string()
      .min(1)
      .max(100)
      .refine((value) => value === value.trim()),
    reason: z
      .string()
      .min(1)
      .max(500)
      .refine((value) => value === value.trim()),
    committeeApproved: z.boolean(),
  })
  .strict();
const resultsObject = z
  .object({ adjudication: adjudicationMetadataSchema.optional() })
  .passthrough();

export const publicHistoryValidationIssue = (issue: z.core.$ZodIssue) => ({
  path: issue.path,
  message: issue.message,
});

const identityOnly = (
  value: { state: Record<string, unknown>; results: Record<string, unknown> | null },
  context: z.core.$RefinementCtx,
) => {
  const inspected = inspectGameIdentities(value.state, value.results);
  if (
    inspected.named ||
    inspected.invalid ||
    hasEngineSelector(value.state) ||
    hasEngineSelector(value.results)
  )
    context.addIssue({
      code: "custom",
      path: ["state"],
      message: "Unsupported or invalid player identity reference",
    });
};

export const gameSessionCreationSchema = z
  .object({
    creationId: z.uuid(),
    tournamentId: z.uuid().nullable().optional(),
    name: z.string().trim().min(1).max(100),
    state: snapshotObject,
    results: resultsObject.nullable(),
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
    results: resultsObject.nullable(),
  })
  .strict()
  .superRefine(identityOnly);
