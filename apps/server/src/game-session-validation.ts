import { MAX_NOTEBOOK_DAYS } from "@mafia/game-domain";
import { z } from "zod";
import { hasEngineSelector, inspectGameIdentities } from "./game-session-identity.js";

const notebookSeat = z.number().int().min(1).max(10);
const notebookCell = z
  .object({
    seat: notebookSeat,
    day: z.number().int().min(1).max(MAX_NOTEBOOK_DAYS),
    phase: z.enum(["day", "night"]),
    nomination: notebookSeat.optional(),
    eliminated: z.literal(true).optional(),
  })
  .strict()
  .superRefine((cell, context) => {
    if (cell.nomination === undefined && cell.eliminated === undefined)
      context.addIssue({ code: "custom", message: "A notebook cell requires an observation" });
    if (cell.phase === "night" && cell.nomination !== undefined)
      context.addIssue({
        code: "custom",
        path: ["nomination"],
        message: "Night cells record elimination only",
      });
  });
const notebook = z
  .object({
    dayCount: z.number().int().min(1).max(MAX_NOTEBOOK_DAYS),
    cells: z.array(notebookCell).max(400),
    seatRoles: z
      .array(
        z
          .object({ seat: notebookSeat, role: z.enum(["citizen", "mafia", "don", "sheriff"]) })
          .strict(),
      )
      .max(10)
      .refine(
        (roles) => new Set(roles.map(({ seat }) => seat)).size === roles.length,
        "Role seats must be distinct",
      )
      .optional(),
    bestMove: z
      .object({
        ownerSeat: notebookSeat.optional(),
        targetSeats: z
          .array(notebookSeat)
          .max(3)
          .refine((seats) => new Set(seats).size === seats.length, "Targets must be distinct"),
      })
      .strict()
      .refine(
        (bestMove) => bestMove.ownerSeat !== undefined || bestMove.targetSeats.length > 0,
        "A Best Move requires a recorded owner or target",
      )
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const coordinates = new Set<string>();
    value.cells.forEach((cell, index) => {
      if (cell.day > value.dayCount)
        context.addIssue({
          code: "custom",
          path: ["cells", index, "day"],
          message: "Cell day exceeds notebook day count",
        });
      const coordinate = `${cell.seat}:${cell.day}:${cell.phase}`;
      if (coordinates.has(coordinate))
        context.addIssue({
          code: "custom",
          path: ["cells", index],
          message: "Notebook cell coordinates must be distinct",
        });
      coordinates.add(coordinate);
    });
  });

/**
 * Game snapshots are browser-authoritative records.  The server validates only
 * the transport envelope and optional notebook shape, never game rules or replay.
 * Unrelated snapshot fields remain opaque and are preserved unchanged.
 */
const snapshotObject = z.object({ notebook: notebook.optional() }).passthrough();

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
