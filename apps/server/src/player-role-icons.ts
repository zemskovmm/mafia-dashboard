import { randomUUID } from "node:crypto";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { z } from "zod";
import type { AzureTransaction } from "./azure-storage.js";
import { blobFields, blobReference, StorageUnavailableError, uuidKey } from "./azure-storage.js";
import { BUILTIN_ROLE_ICON_IDS, PLAYER_ICON_ROLES } from "./player-role-icon-contracts.js";
import type {
  PlayerRoleIconBundle,
  PlayerRoleIcons,
  PlayerRoleIconsInput,
  PlayerRoleIconInput,
} from "./player-role-icon-contracts.js";

export const MAX_ROLE_ICON_INPUT_BYTES = 512 * 1024;
export const MAX_ROLE_ICON_OUTPUT_BYTES = 128 * 1024;
const maxDataUrl = 4 * Math.ceil(MAX_ROLE_ICON_INPUT_BYTES / 3) + 32;
const builtin = z
  .object({ kind: z.literal("builtin"), id: z.enum(BUILTIN_ROLE_ICON_IDS) })
  .strict();
const upload = z.object({ kind: z.literal("upload"), id: z.uuid() }).strict();
const choice = z.discriminatedUnion("kind", [builtin, upload]);
const inputChoice = z
  .discriminatedUnion("kind", [
    builtin,
    upload,
    z.object({ kind: z.literal("image"), dataUrl: z.string().max(maxDataUrl) }).strict(),
  ])
  .nullable();
export const playerRoleIconsInputSchema = z
  .object({
    citizen: inputChoice.optional(),
    mafia: inputChoice.optional(),
    don: inputChoice.optional(),
    sheriff: inputChoice.optional(),
  })
  .strict();
const selectorsSchema = z
  .object({
    citizen: choice.optional(),
    mafia: choice.optional(),
    don: choice.optional(),
    sheriff: choice.optional(),
  })
  .strict();

export class PlayerRoleIconValidationError extends Error {
  public readonly code = "validation_failed";
  public constructor() {
    super("Invalid player role icons");
  }
}
const invalid = (): never => {
  throw new PlayerRoleIconValidationError();
};

/** Buffer-only decoder input: never filenames, URLs, SVG or permissive base64. */
export const normalizePlayerRoleIcon = async (dataUrl: string): Promise<string> => {
  if (dataUrl.length > maxDataUrl) return invalid();
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[2]!.length % 4 !== 0) return invalid();
  const bytes = Buffer.from(match[2]!, "base64");
  if (
    bytes.length === 0 ||
    bytes.length > MAX_ROLE_ICON_INPUT_BYTES ||
    bytes.toString("base64") !== match[2]
  )
    return invalid();
  const format = match[1]!;
  if (format === "png") {
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      return invalid();
    // libvips can expose APNG as a static PNG. Reject its animation control at
    // the container boundary, including single-frame animation declarations.
    let offset = 8;
    let ended = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      if (
        length > bytes.length - offset - 12 ||
        type === "acTL" ||
        crc32(bytes.subarray(offset + 4, offset + 8 + length)) !==
          bytes.readUInt32BE(offset + 8 + length)
      )
        return invalid();
      offset += length + 12;
      if (type === "IEND") {
        ended = length === 0 && offset === bytes.length;
        break;
      }
    }
    if (!ended) return invalid();
  } else if (format === "jpeg") {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return invalid();
  } else if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP")
    return invalid();
  try {
    const decoder = sharp(bytes, { failOn: "warning", limitInputPixels: 4_000_000 });
    const metadata = await decoder.metadata();
    if (
      metadata.format !== format ||
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > 4_000_000 ||
      (metadata.pages ?? 1) !== 1 ||
      metadata.delay !== undefined
    )
      return invalid();
    // No keepMetadata/withMetadata: EXIF, XMP, ICC and source names are dropped.
    const normalized = await decoder
      .rotate()
      .resize({ width: 256, height: 256, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80, effort: 4 })
      .timeout({ seconds: 5 })
      .toBuffer();
    if (normalized.length > MAX_ROLE_ICON_OUTPUT_BYTES) return invalid();
    return `data:image/webp;base64,${normalized.toString("base64")}`;
  } catch {
    return invalid();
  }
};

/** Decode once per request, not once per storage-CAS retry. */
export const preparePlayerRoleIcons = async (
  input: PlayerRoleIconsInput | undefined,
  consent: boolean,
): Promise<PlayerRoleIconsInput | undefined> => {
  if (input === undefined) return undefined;
  const parsed = playerRoleIconsInputSchema.safeParse(input);
  if (!parsed.success) return invalid();
  const prepared: Partial<Record<(typeof PLAYER_ICON_ROLES)[number], PlayerRoleIconInput>> = {};
  for (const role of PLAYER_ICON_ROLES) {
    const value = parsed.data[role];
    if (value === undefined) continue;
    if (!consent && value && value.kind !== "builtin") return invalid();
    prepared[role] =
      value?.kind === "image"
        ? { kind: "image", dataUrl: await normalizePlayerRoleIcon(value.dataUrl) }
        : value;
  }
  return prepared;
};

export interface PlayerRoleIconRow {
  roleIcons?: string;
  roleIconsVersion?: string;
  blobName?: string;
  blobSha256?: string;
  blobLength?: number;
}
export const playerRoleIconReference = (row: PlayerRoleIconRow) =>
  [row.blobName, row.blobSha256, row.blobLength].some((value) => value !== undefined)
    ? blobReference(row)
    : null;
export const playerRoleIconSelectors = (row: PlayerRoleIconRow): PlayerRoleIcons => {
  try {
    return selectorsSchema.parse(row.roleIcons === undefined ? {} : JSON.parse(row.roleIcons));
  } catch {
    throw new StorageUnavailableError("Invalid player icon selectors");
  }
};
const purpose = (clubId: string, playerId: string) =>
  `club/${uuidKey(clubId)}/player/${uuidKey(playerId)}/role-icons`;
const envelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    clubId: z.uuid(),
    playerId: z.uuid(),
    version: z.uuid(),
    images: z.record(
      z.uuid(),
      z
        .string()
        .max(4 * Math.ceil(MAX_ROLE_ICON_OUTPUT_BYTES / 3) + 32)
        .regex(/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/),
    ),
  })
  .strict();
export const readPlayerRoleIcons = async (
  tx: AzureTransaction,
  row: PlayerRoleIconRow,
  clubId: string,
  playerId: string,
): Promise<PlayerRoleIconBundle> => {
  const selectors = playerRoleIconSelectors(row);
  const ids = new Set(
    Object.values(selectors).flatMap((value) => (value.kind === "upload" ? [value.id] : [])),
  );
  const ref = playerRoleIconReference(row);
  if (!ref) {
    if (ids.size || row.roleIconsVersion !== undefined)
      throw new StorageUnavailableError("Missing player icon authority");
    return { version: null, images: {} };
  }
  if (!ref.name.includes(`/${purpose(clubId, playerId)}/`))
    throw new StorageUnavailableError("Foreign player icon authority");
  const parsed = envelopeSchema.safeParse(await tx.readBlob(ref));
  if (
    !parsed.success ||
    parsed.data.clubId !== uuidKey(clubId) ||
    parsed.data.playerId !== uuidKey(playerId) ||
    parsed.data.version !== row.roleIconsVersion ||
    ids.size === 0 ||
    Object.keys(parsed.data.images).length !== ids.size ||
    Object.keys(parsed.data.images).some((id) => !ids.has(id))
  )
    throw new StorageUnavailableError("Invalid player icon envelope");
  return { version: parsed.data.version, images: parsed.data.images };
};

/** New immutable bytes and retired references share the profile's control CAS. */
export const savePlayerRoleIcons = async (
  tx: AzureTransaction,
  previous: PlayerRoleIconRow,
  prepared: PlayerRoleIconsInput | undefined,
  consent: boolean,
  clubId: string,
  playerId: string,
): Promise<PlayerRoleIconRow> => {
  const prior = playerRoleIconSelectors(previous);
  const selectors = { ...prior };
  const oldRef = playerRoleIconReference(previous);
  let bundle: PlayerRoleIconBundle | undefined;
  const images: Record<string, string> = {};
  for (const role of PLAYER_ICON_ROLES) {
    const value = prepared?.[role];
    if (value === null) delete selectors[role];
    else if (value?.kind === "image") {
      const id = randomUUID();
      selectors[role] = { kind: "upload", id };
      images[id] = value.dataUrl;
    } else if (value?.kind === "upload") {
      // Only the exact current player's live envelope can resolve a reference.
      bundle ??= await readPlayerRoleIcons(tx, previous, clubId, playerId);
      if (!Object.hasOwn(bundle.images, value.id)) return invalid();
      selectors[role] = value;
    } else if (value) selectors[role] = value;
    if (!consent && selectors[role]?.kind === "upload") delete selectors[role];
  }
  for (const value of Object.values(selectors)) {
    if (value.kind !== "upload" || Object.hasOwn(images, value.id)) continue;
    bundle ??= await readPlayerRoleIcons(tx, previous, clubId, playerId);
    if (!Object.hasOwn(bundle.images, value.id))
      throw new StorageUnavailableError("Missing retained player icon");
    images[value.id] = bundle.images[value.id]!;
  }
  const fields: PlayerRoleIconRow = { roleIcons: JSON.stringify(selectors) };
  if (Object.keys(images).length > 0) {
    bundle ??= oldRef ? await readPlayerRoleIcons(tx, previous, clubId, playerId) : undefined;
    const unchanged =
      bundle &&
      Object.keys(images).length === Object.keys(bundle.images).length &&
      Object.entries(images).every(([id, value]) => bundle!.images[id] === value);
    if (unchanged && oldRef)
      return { ...fields, ...blobFields(oldRef), roleIconsVersion: previous.roleIconsVersion };
    const version = randomUUID();
    const ref = await tx.writeBlob(
      { schemaVersion: 1, clubId: uuidKey(clubId), playerId: uuidKey(playerId), version, images },
      purpose(clubId, playerId),
    );
    Object.assign(fields, blobFields(ref), { roleIconsVersion: version });
  }
  if (oldRef) await tx.retireBlob(oldRef);
  return fields;
};
