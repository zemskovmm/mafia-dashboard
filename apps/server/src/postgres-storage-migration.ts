import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import type { Pool } from "pg";
import { z } from "zod";
import { TableClient } from "@azure/data-tables";
import { ManagedIdentityCredential } from "@azure/identity";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { AzureStorage, digest, type AzureStorageOptions } from "./azure-storage.js";
import {
  decodeBackupRow,
  encodeBackupRow,
  tableKey,
  validateBackupRow,
  type BackupRow,
  type BackupProperty,
} from "./storage-backup-codec.js";
import { assertSupportedGame, inspectGameIdentities } from "./game-session-identity.js";

// This is an importer, never an initializer. Exact current source columns are
// admitted; unrecognized relations/columns are not silently dropped.
const columns = {
  club_memberships:
    "club_id:uuid:NO user_id:uuid:NO role:text:NO access_player_id:uuid:YES created_at:timestamptz:NO",
  clubs:
    "id:uuid:NO name:text:NO city:text:NO header_logo:text:YES card_logo:text:YES language_code:text:NO best_move_enabled:bool:NO created_by:uuid:NO created_at:timestamptz:NO updated_at:timestamptz:NO",
  deleted_clubs: "club_id:uuid:NO deleted_at:timestamptz:NO",
  deleted_games: "game_id:uuid:NO club_id:uuid:NO deleted_at:timestamptz:NO",
  game_daily_counters: "club_id:uuid:NO game_date:date:NO last_number:int4:NO",
  game_events:
    "id:uuid:NO club_id:uuid:NO game_id:uuid:NO sequence:int4:NO idempotency_key:text:NO event_type:text:NO phase:text:NO seat:int4:YES payload:jsonb:NO parent_event_id:uuid:YES replay_version:int4:NO replay_sequence:int4:YES phase_after:text:YES day_before:int4:YES day_after:int4:YES state_hash_after:text:YES created_at:timestamptz:NO",
  game_player_results:
    "club_id:uuid:NO game_id:uuid:NO player_id:uuid:NO seat:int4:NO role:text:NO team:text:NO final_status:text:NO fouls:int4:NO won:bool:YES best_move_hits:int4:YES",
  game_results:
    "game_id:uuid:NO club_id:uuid:NO outcome:text:NO winner:text:YES reason:text:YES played_at:timestamptz:NO host_player_id:uuid:YES",
  game_rulesets:
    "id:text:NO version:int4:NO player_count:int4:NO sheriff_count:int4:NO citizen_count:int4:NO mafia_count:int4:NO don_count:int4:NO",
  game_session_creations:
    "club_id:uuid:NO creation_id:uuid:NO game_id:uuid:NO created_at:timestamptz:NO",
  game_session_mutations:
    "club_id:uuid:NO game_id:uuid:NO mutation_id:uuid:NO revision:int4:NO request:jsonb:YES",
  game_session_players:
    "club_id:uuid:NO game_id:uuid:NO player_id:uuid:NO seat:int4:YES is_host:bool:NO role:text:YES",
  game_sessions:
    "id:uuid:NO club_id:uuid:NO ruleset_id:text:NO ruleset_version:int4:NO name:text:NO revision:int4:NO last_mutation_id:uuid:NO state:jsonb:NO results:jsonb:YES status:text:NO initial_game:jsonb:YES replay_base_event_id:uuid:YES head_event_id:uuid:YES reset_return_event_id:uuid:YES reset_return_was_completed:bool:NO replay_version:int4:NO created_at:timestamptz:NO updated_at:timestamptz:NO",
  players:
    "id:uuid:NO club_id:uuid:NO nickname:text:YES first_name:text:YES last_name:text:YES email:text:YES data_processing_consent:bool:NO consent_at:timestamptz:YES club_access:text:NO user_id:uuid:YES created_at:timestamptz:NO updated_at:timestamptz:NO last_played_at:timestamptz:YES retired_at:timestamptz:YES",
  user_sessions:
    "id:uuid:NO token_hash:bytea:NO user_id:uuid:NO expires_at:timestamptz:NO created_at:timestamptz:NO",
  users:
    "id:uuid:NO google_subject:text:YES email:text:NO display_name:text:NO picture:text:YES created_at:timestamptz:NO updated_at:timestamptz:NO",
  youtube_oauth_credentials:
    "user_id:uuid:NO singleton:bool:NO access_token_encrypted:bytea:NO refresh_token_encrypted:bytea:NO expires_at:timestamptz:NO account_label:text:NO scope:text:NO updated_at:timestamptz:NO",
} as const;
const expectedConstraintNames = `
  club_memberships_access_player_fk club_memberships_club_id_fkey club_memberships_pkey club_memberships_role_ck club_memberships_user_id_fkey
  clubs_city_check clubs_created_by_fkey clubs_language_code_ck clubs_name_check clubs_pkey
  deleted_clubs_pkey deleted_games_club_fk deleted_games_pkey
  game_daily_counters_club_fk game_daily_counters_last_number_check game_daily_counters_pkey
  game_events_club_fk game_events_club_game_event_unique game_events_club_game_idempotency_unique game_events_club_game_sequence_unique
  game_events_day_after_nonnegative_ck game_events_day_before_nonnegative_ck game_events_pkey game_events_replay_metadata_ck
  game_events_replay_sequence_positive_ck game_events_seat_check game_events_sequence_check
  game_player_results_best_move_hits_check game_player_results_final_status_check game_player_results_fouls_check
  game_player_results_game_fk game_player_results_game_seat_unique game_player_results_pkey game_player_results_player_fk
  game_player_results_role_check game_player_results_seat_check game_player_results_team_check
  game_results_club_fk game_results_host_player_fk game_results_outcome_ck game_results_pkey game_results_shape_ck
  game_rulesets_citizen_count_check game_rulesets_don_count_check game_rulesets_id_check game_rulesets_mafia_count_check
  game_rulesets_player_count_check game_rulesets_pkey game_rulesets_role_count_ck game_rulesets_sheriff_count_check game_rulesets_version_check
  game_session_creations_pkey game_session_creations_club_fk
  game_session_mutations_game_fk game_session_mutations_game_revision_unique game_session_mutations_pkey game_session_mutations_revision_check
  game_session_players_game_fk game_session_players_game_seat_unique game_session_players_pkey game_session_players_player_fk
  game_session_players_role_ck game_session_players_seat_check game_session_players_shape_ck
  game_sessions_club_fk game_sessions_name_check game_sessions_pkey game_sessions_revision_check game_sessions_ruleset_fk game_sessions_status_check
  players_access_provenance_unique players_access_requires_consent_ck players_check players_club_access_ck players_club_fk
  players_club_id_id_unique players_nickname_check players_pkey players_user_fk
  user_sessions_pkey user_sessions_token_hash_key user_sessions_user_id_fkey
  users_display_name_check users_email_check users_email_key users_pkey
  youtube_oauth_credentials_account_label_check youtube_oauth_credentials_pkey youtube_oauth_credentials_singleton_check youtube_oauth_credentials_user_id_fkey
`
  .trim()
  .split(/\s+/);
const expectedIndexNames = `
  club_memberships_access_player_unique_idx club_memberships_pkey clubs_pkey deleted_clubs_pkey deleted_games_pkey game_daily_counters_pkey
  game_events_club_game_event_unique game_events_club_game_idempotency_unique game_events_club_game_parent_idx
  game_events_club_game_replay_sequence_idx game_events_club_game_sequence_unique game_events_game_parent_idx game_events_pkey
  game_player_results_game_seat_unique game_player_results_pkey game_player_results_player_idx
  game_results_club_outcome_played_idx game_results_club_played_idx game_results_host_idx game_results_pkey game_rulesets_pkey
  game_session_creations_pkey game_session_mutations_game_revision_unique game_session_mutations_pkey
  game_session_players_club_history_player_idx game_session_players_game_seat_unique game_session_players_player_idx game_session_players_pkey
  game_sessions_club_active_updated_idx game_sessions_club_head_idx game_sessions_pkey
  players_access_provenance_unique players_club_access_email_unique_idx players_club_id_id_unique
  players_club_last_played_nickname_idx players_club_linked_user_unique_idx players_club_nickname_unique_idx players_pkey
  user_sessions_expiry_idx user_sessions_pkey user_sessions_token_hash_key users_email_key users_google_subject_unique_idx users_pkey youtube_oauth_credentials_pkey
`
  .trim()
  .split(/\s+/);
type Relation = keyof typeof columns;
const excluded = new Set<Relation>(["user_sessions", "youtube_oauth_credentials"]);
const relations = (Object.keys(columns) as Relation[]).filter((name) => !excluded.has(name));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const migrationSourceSchema = z
  .object({
    database: z.string().min(1).max(63),
    schema: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/),
    serverAddress: z.string().min(1).max(253),
    serverPort: z.number().int().min(1).max(65535),
  })
  .strict();
export type MigrationSource = z.infer<typeof migrationSourceSchema>;
const targetSchema = z
  .object({
    mode: z.enum(["local", "managed-identity"]),
    accountName: z.string().regex(/^[a-z0-9]{3,24}$/),
    tableName: z.string().regex(/^[A-Za-z][A-Za-z0-9]{2,62}$/),
    containerName: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .min(3)
      .max(63),
    partitionKey: z.string().min(1),
    tableUrl: z.string(),
    containerUrl: z.string(),
  })
  .strict();
export type MigrationTarget = z.infer<typeof targetSchema>;
const managedMigrationClients = new WeakSet<object>();
export interface MigrationStorage {
  readonly options: AzureStorageOptions;
  readonly table: TableClient;
  readonly blobs: ContainerClient;
}
export class PostgresMigrationError extends Error {}
const fail = (message: string): never => {
  throw new PostgresMigrationError(message);
};
const safe = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof PostgresMigrationError) throw error;
    return fail(
      "Migration failed or interrupted; source and any partial target/package retained; inspect privately and choose a new empty target",
    );
  }
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const json = (bytes: Buffer): unknown => {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return fail("Malformed migration JSON");
  }
};
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
const missing = (error: unknown) => object(error) && error.statusCode === 404;
const endpoint = (value: string, mode: MigrationTarget["mode"]): URL => {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (mode === "local"
      ? url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
      : url.protocol !== "https:" || !!url.port)
  )
    return fail("Migration requires explicit credential-free target endpoints");
  return url;
};
const checkedTarget = (input: unknown): MigrationTarget => {
  const parsed = targetSchema.safeParse(input);
  if (!parsed.success) return fail("Unknown migration target identity");
  const target = parsed.data;
  tableKey(target.partitionKey);
  const table = endpoint(target.tableUrl, target.mode);
  const blob = endpoint(target.containerUrl, target.mode);
  if (target.mode === "managed-identity") {
    if (
      table.href !== `https://${target.accountName}.table.core.windows.net/${target.tableName}` ||
      blob.href !== `https://${target.accountName}.blob.core.windows.net/${target.containerName}`
    )
      return fail("Managed-identity target resource identity mismatch");
  } else if (
    table.pathname !== `/${target.accountName}/${target.tableName}` ||
    blob.pathname !== `/${target.accountName}/${target.containerName}`
  )
    return fail("Local target resource identity mismatch");
  return target;
};
/** No target reads or writes. Bind the package to these exact resources. */
export const migrationTarget = (storage: MigrationStorage): MigrationTarget => {
  const local = storage.options.connectionString !== undefined;
  if (!local && !managedMigrationClients.has(storage))
    return fail(
      "Remote migration requires the explicit managed-identity factory, not a default credential chain",
    );
  const accountName = local
    ? new URL(storage.blobs.url).pathname.split("/")[1]
    : storage.options.accountName;
  return checkedTarget({
    mode: local ? "local" : "managed-identity",
    accountName,
    tableName: storage.options.tableName,
    containerName: storage.options.containerName,
    partitionKey: storage.options.partitionKey,
    tableUrl: `${storage.table.url.replace(/\/$/, "")}/${storage.table.tableName}`,
    containerUrl: storage.blobs.url,
  });
};
/** Managed identity ONLY; no DefaultAzureCredential/environment/CLI fallback. */
export const managedIdentityMigrationStorage = (
  options: Omit<AzureStorageOptions, "connectionString">,
  clientId?: string,
): MigrationStorage => {
  if (!options.accountName || !/^[a-z0-9]{3,24}$/.test(options.accountName))
    return fail("Explicit managed-identity account is required");
  if (clientId !== undefined && !z.string().uuid().safeParse(clientId).success)
    return fail("Invalid managed-identity client ID");
  const credential =
    clientId === undefined
      ? new ManagedIdentityCredential()
      : new ManagedIdentityCredential({ clientId });
  const storage = {
    options,
    table: new TableClient(
      `https://${options.accountName}.table.core.windows.net`,
      options.tableName,
      credential,
      { retryOptions: { maxRetries: 0 } },
    ),
    blobs: new BlobServiceClient(
      `https://${options.accountName}.blob.core.windows.net`,
      credential,
      { retryOptions: { maxTries: 1 } },
    ).getContainerClient(options.containerName),
  };
  managedMigrationClients.add(storage);
  migrationTarget(storage);
  return storage;
};
export const localMigrationStorage = (options: AzureStorageOptions): MigrationStorage => {
  if (!options.connectionString || options.accountName !== undefined)
    return fail("Explicit loopback fixture credentials are required");
  const storage = new AzureStorage(options);
  migrationTarget(storage);
  return storage;
};

// Do not follow links (including ancestors), overwrite old inputs, or accept a
// package outside this repository's ignored .AI tree. Nothing is auto-deleted.
const realDirectory = async (directory: string): Promise<void> => {
  if (!isAbsolute(directory) || resolve(directory) !== directory)
    return fail("A normalized absolute path is required");
  let current = parse(directory).root;
  for (const part of directory.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      return fail("Migration path contains a symlink or non-directory");
  }
};
const packagePath = async (
  directory: string,
  projectRoot: string,
  existing: boolean,
): Promise<void> => {
  await realDirectory(projectRoot);
  if (!directory.startsWith(join(projectRoot, ".AI") + "/") || resolve(directory) !== directory)
    return fail("Migration package must be under project-local .AI");
  await realDirectory(existing ? directory : dirname(directory));
  if (existing) {
    const stat = await lstat(directory);
    if (stat.mode & 0o077 || stat.uid !== process.getuid?.())
      return fail("Migration package must be owner-only");
  }
};
export const readProtectedMigrationFile = async (path: string, max = 67108864): Promise<Buffer> => {
  await realDirectory(dirname(path));
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077 ||
      stat.size > max
    )
      return fail("Migration file must be private, regular, unlinked and within bounds");
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size) return fail("Migration file changed during read");
    return bytes;
  } finally {
    await handle.close();
  }
};
const writePrivate = async (path: string, bytes: Buffer) => {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
};
const manifestSchema = z
  .object({
    version: z.literal(1),
    complete: z.literal(true),
    kind: z.literal("postgres-business-to-azure"),
    packageId: z.string().uuid(),
    datasetId: z.string().uuid(),
    createdAt: z.iso.datetime(),
    source: migrationSourceSchema,
    target: targetSchema,
    sourceFile: z.literal("source.json"),
    sourceSha256: hash,
    sourceLength: z.number().int().min(1).max(67108864),
    schemaSha256: hash,
    entityCount: z.number().int().min(1),
    blobCount: z.number().int().min(0),
    convertedSha256: hash,
    excluded: z.tuple([z.literal("user_sessions"), z.literal("youtube_oauth_credentials")]),
  })
  .strict();
export type PostgresMigrationManifest = z.infer<typeof manifestSchema>;
type SourceRow = Record<string, unknown>;
type SourceData = Record<Relation, SourceRow[]>;
interface Converted {
  rows: BackupRow[];
  blobs: Map<string, Buffer>;
}
const timestamp = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:\+00:00|Z)$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).getUTCFullYear() < 1601
  )
    return fail("Unsupported source timestamp");
  return value.replace("+00:00", "Z");
};
const id = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  )
    return fail("Unsupported source UUID");
  return value;
};
const text = (value: unknown): string =>
  typeof value === "string" ? value : fail("Unsupported source string");
const record = (value: unknown): SourceRow =>
  object(value) ? value : fail("Unsupported source JSON object");
const safeNumbers = (value: unknown): void => {
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
  )
    return fail("Source JSON number cannot be represented exactly");
  if (Array.isArray(value)) value.forEach(safeNumbers);
  else if (object(value)) Object.values(value).forEach(safeNumbers);
};
const numericSpelling = (token: string): string => {
  const parts = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!parts) return fail("Unsupported source JSON number");
  let digits = (parts[2]! + (parts[3] ?? "")).replace(/^0+/, "");
  if (!digits) return "0";
  let exponent = Number(parts[4] ?? "0") - (parts[3]?.length ?? 0);
  const trailing = /0+$/.exec(digits)?.[0].length ?? 0;
  exponent += trailing;
  digits = trailing ? digits.slice(0, -trailing) : digits;
  if (!Number.isSafeInteger(exponent)) return fail("Unsupported source JSON exponent");
  return `${parts[1]}${digits}e${exponent}`;
};
const exactJsonNumbers = (encoded: string): void => {
  // Match quoted strings first so IDs/logo text are not numeric tokens. JSONB
  // supports decimals wider than JS; detect lossy conversion rather than copy
  // a plausible rounded snapshot. Equivalent spellings such as 1.00 are fine.
  const tokens = /"(?:[^"\\]|\\.)*"|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  for (const match of encoded.matchAll(tokens)) {
    const token = match[1];
    if (
      token !== undefined &&
      (!Number.isFinite(Number(token)) ||
        numericSpelling(token) !== numericSpelling(String(Number(token))))
    )
      return fail("Source JSON number cannot be represented without rounding");
  }
};
const sourceData = (input: unknown, source: MigrationSource): SourceData => {
  const payload = record(input);
  if (
    Object.keys(payload).sort().join(",") !== "relations,source,version" ||
    payload.version !== 1 ||
    !same(payload.source, source)
  )
    return fail("Source package identity mismatch");
  const encoded = record(payload.relations);
  if (Object.keys(encoded).sort().join(",") !== [...relations].sort().join(","))
    return fail("Unknown or excluded source relations in package");
  const result = {} as SourceData;
  for (const relation of relations) {
    const strings = encoded[relation];
    if (!Array.isArray(strings)) return fail("Source relation is malformed");
    result[relation] = strings.map((encodedRow: unknown) => {
      const encodedText = text(encodedRow);
      exactJsonNumbers(encodedText);
      const row = record(json(Buffer.from(encodedText)));
      const fields = columns[relation].split(" ");
      if (
        Object.keys(row).sort().join(",") !==
        fields
          .map((field) => field.split(":")[0])
          .sort()
          .join(",")
      )
        return fail("Unsupported source row fields");
      for (const field of fields) {
        const [name, type, nullable] = field.split(":");
        const value = row[name!];
        if (value === null) {
          if (nullable !== "YES") return fail("Null source value violates current schema");
          continue;
        }
        if (type === "uuid") id(value);
        else if (type === "timestamptz") timestamp(value);
        else if (type === "text") text(value);
        else if (type === "bool" && typeof value !== "boolean")
          return fail("Invalid source boolean");
        else if (
          type === "int4" &&
          (typeof value !== "number" ||
            !Number.isInteger(value) ||
            value < -2147483648 ||
            value > 2147483647)
        )
          return fail("Invalid source integer");
        else if (
          type === "date" &&
          (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
        )
          return fail("Invalid source date");
        safeNumbers(value);
      }
      return row;
    });
  }
  return result;
};
const admitGame = (state: unknown, results: unknown): void => {
  try {
    assertSupportedGame(state, results);
  } catch {
    return fail("Unsupported name-bearing source game format");
  }
  const checkVersion = (value: unknown) => {
    if (object(value) && Object.hasOwn(value, "replayVersion") && value.replayVersion !== 1)
      return fail("Unsupported source canonical replay version");
  };
  checkVersion(state);
  if (object(state)) {
    checkVersion(state.initialGame);
    if (Array.isArray(state.events)) state.events.forEach(checkVersion);
  }
};
const convert = (
  raw: Buffer,
  manifest: Pick<PostgresMigrationManifest, "source" | "target" | "datasetId">,
): Converted => {
  const data = sourceData(json(raw), manifest.source);
  const rows: BackupRow[] = [];
  const keys = new Set<string>();
  const blobs = new Map<string, Buffer>();
  const prefix = `datasets/${digest(manifest.target.partitionKey)}/${manifest.datasetId}`;
  const put = (rowKey: string, values: SourceRow, dates: string[] = []) => {
    if (keys.has(rowKey)) return fail("Conflicting source identities or reservations");
    keys.add(rowKey);
    const properties: Record<string, BackupProperty> = {};
    for (const [name, value] of Object.entries(values)) {
      if (value === null || value === undefined) continue;
      properties[name] = dates.includes(name)
        ? { type: "DateTime", value: timestamp(value) }
        : typeof value === "string"
          ? { type: "String", value }
          : typeof value === "boolean"
            ? { type: "Boolean", value: String(value) }
            : typeof value === "number"
              ? {
                  type:
                    Number.isInteger(value) && value >= -2147483648 && value <= 2147483647
                      ? "Int32"
                      : "Double",
                  value: String(value),
                }
              : fail("Source field requires explicit Blob representation");
    }
    rows.push(
      validateBackupRow({
        partitionKey: manifest.target.partitionKey,
        rowKey,
        properties,
        service: { etag: "", timestamp: "2000-01-01T00:00:00.000Z" },
      }),
    );
  };
  const blob = (purpose: string, bytes: Buffer) => {
    if (bytes.length > 67108864) return fail("Migration Blob exceeds 64 MiB");
    const name = `${prefix}/${purpose}/${digest(bytes)}.json`;
    blobs.set(name, bytes);
    return { blobName: name, blobSha256: digest(bytes), blobLength: bytes.length };
  };
  const cp = (club: unknown) => `club:${id(club)}:`;
  const group = (relation: Relation, key: (row: SourceRow) => string) => {
    const map = new Map<string, SourceRow>();
    for (const row of data[relation]) {
      const k = key(row);
      if (map.has(k)) return fail("Duplicate source identity");
      map.set(k, row);
    }
    return map;
  };
  const users = group("users", (row) => id(row.id));
  const clubs = group("clubs", (row) => id(row.id));
  const players = group("players", (row) => cp(row.club_id) + id(row.id));
  const games = group("game_sessions", (row) => cp(row.club_id) + id(row.id));
  const deletedClubs = group("deleted_clubs", (row) => id(row.club_id));
  const deletedGames = group("deleted_games", (row) => cp(row.club_id) + id(row.game_id));
  const requireClub = (row: SourceRow) => {
    if (!clubs.has(id(row.club_id)) || deletedClubs.has(id(row.club_id)))
      return fail("Source refers to a missing/deleted club");
  };
  const requirePlayer = (club: unknown, player: unknown) => {
    if (!players.has(cp(club) + id(player)))
      return fail("Source player relationship crosses clubs or is missing");
  };
  const requireGame = (row: SourceRow) => {
    requireClub(row);
    if (!games.has(cp(row.club_id) + id(row.game_id)))
      return fail("Orphan game projection has no supported Azure reader representation");
  };
  for (const row of data.game_rulesets) {
    if (
      !same(row, {
        id: "club-mafia",
        version: 1,
        player_count: 10,
        sheriff_count: 1,
        citizen_count: 6,
        mafia_count: 2,
        don_count: 1,
      })
    )
      return fail("Unsupported source ruleset");
    put("migration:ruleset:club-mafia:1", {
      ...blob("migration/rulesets", Buffer.from(JSON.stringify(row))),
    });
  }
  for (const row of users.values()) {
    if (!text(row.email).trim() || !text(row.display_name).trim())
      return fail("Invalid source account");
    put(
      `user:${id(row.id)}`,
      {
        id: row.id,
        email: row.email,
        googleSubject: row.google_subject,
        name: row.display_name,
        picture: row.picture,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
      ["createdAt", "updatedAt"],
    );
    put(`email:${digest(text(row.email))}`, { userId: row.id });
    if (row.google_subject !== null) {
      if (!text(row.google_subject)) return fail("Empty Google subject");
      put(`subject:${digest(text(row.google_subject))}`, { userId: row.id });
    }
  }
  for (const row of clubs.values()) {
    if (
      deletedClubs.has(id(row.id)) ||
      !users.has(id(row.created_by)) ||
      !["en", "ru"].includes(text(row.language_code)) ||
      !text(row.name).trim() ||
      !text(row.city).trim()
    )
      return fail("Invalid source club relationship/settings");
    const logos: SourceRow = {};
    for (const field of ["header", "card"] as const)
      if (row[`${field}_logo`] !== null) {
        const ref = blob(
          `club/${id(row.id)}/${field}`,
          Buffer.from(JSON.stringify(text(row[`${field}_logo`]))),
        );
        Object.assign(logos, {
          [`${field}BlobName`]: ref.blobName,
          [`${field}BlobSha256`]: ref.blobSha256,
          [`${field}BlobLength`]: ref.blobLength,
        });
      }
    put(
      `${cp(row.id)}meta`,
      {
        id: row.id,
        name: row.name,
        city: row.city,
        language: row.language_code,
        bestMoveEnabled: row.best_move_enabled,
        createdBy: row.created_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...logos,
      },
      ["createdAt", "updatedAt"],
    );
  }
  const linked = new Set<string>();
  const accessEmails = new Set<string>();
  for (const row of players.values()) {
    requireClub(row);
    if (!["none", "user", "manager"].includes(text(row.club_access)))
      return fail("Invalid player access");
    if (row.user_id !== null) {
      const link = cp(row.club_id) + id(row.user_id);
      if (!users.has(id(row.user_id)) || linked.has(link))
        return fail("Conflicting player user binding");
      linked.add(link);
    }
    if (row.retired_at !== null) {
      if (
        row.nickname !== null ||
        row.first_name !== null ||
        row.last_name !== null ||
        row.email !== null ||
        row.user_id !== null ||
        row.club_access !== "none" ||
        row.data_processing_consent !== false ||
        row.consent_at !== null
      )
        return fail("Retired source identity retains private profile fields");
    } else {
      if (!text(row.nickname).trim()) return fail("Invalid source nickname");
      put(`${cp(row.club_id)}nickname:${digest(text(row.nickname).trim().toLowerCase())}`, {
        playerId: row.id,
      });
    }
    if (
      row.data_processing_consent === false &&
      [row.first_name, row.last_name, row.email, row.consent_at].some((v) => v !== null)
    )
      return fail("Source consent violation");
    if (
      row.data_processing_consent === true &&
      (row.consent_at === null ||
        [row.first_name, row.last_name, row.email].some((v) => typeof v !== "string" || !v.trim()))
    )
      return fail("Incomplete source consent");
    if (row.club_access !== "none") {
      if (row.data_processing_consent !== true && row.user_id === null)
        return fail("Source access lacks consent/binding");
      if (row.email !== null) {
        const k = cp(row.club_id) + text(row.email).trim().toLowerCase();
        if (accessEmails.has(k)) return fail("Conflicting source access emails");
        accessEmails.add(k);
      }
    }
    put(
      `${cp(row.club_id)}player:${id(row.id)}`,
      {
        id: row.id,
        nickname: row.nickname,
        firstName: row.first_name,
        lastName: row.last_name,
        email: row.email,
        userId: row.user_id,
        clubAccess: row.club_access,
        consent: row.data_processing_consent,
        consentAt: row.consent_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastPlayedAt: row.last_played_at,
        retiredAt: row.retired_at,
      },
      ["consentAt", "createdAt", "updatedAt", "lastPlayedAt", "retiredAt"],
    );
  }
  const accessPlayers = new Set<string>();
  for (const row of data.club_memberships) {
    requireClub(row);
    if (!users.has(id(row.user_id)) || !["user", "manager"].includes(text(row.role)))
      return fail("Invalid source membership");
    if (row.access_player_id !== null) {
      const k = cp(row.club_id) + id(row.access_player_id);
      const player = players.get(k);
      if (
        !player ||
        player.user_id !== row.user_id ||
        player.club_access !== row.role ||
        player.retired_at !== null ||
        accessPlayers.has(k)
      )
        return fail("Invalid membership access provenance");
      accessPlayers.add(k);
    }
    put(
      `${cp(row.club_id)}member:${id(row.user_id)}`,
      {
        userId: row.user_id,
        role: row.role,
        accessPlayerId: row.access_player_id,
        createdAt: row.created_at,
      },
      ["createdAt"],
    );
  }
  for (const row of data.deleted_clubs)
    put(`deleted-club:${id(row.club_id)}`, { deletedAt: row.deleted_at }, ["deletedAt"]);
  for (const row of data.deleted_games) {
    requireClub(row);
    if (games.has(cp(row.club_id) + id(row.game_id)))
      return fail("Live game conflicts with source tombstone");
    put(
      `${cp(row.club_id)}deleted-game:${id(row.game_id)}`,
      { gameId: row.game_id, deletedAt: row.deleted_at },
      ["deletedAt"],
    );
  }
  const apiEvents = new Map<string, SourceRow[]>();
  const eventIds = new Set<string>();
  const eventSequences = new Set<string>();
  const eventRetries = new Set<string>();
  for (const row of data.game_events) {
    requireGame(row);
    if (
      row.replay_version !== 1 ||
      Number(row.sequence) < 1 ||
      !text(row.event_type).trim() ||
      !text(row.phase).trim() ||
      !text(row.idempotency_key)
    )
      return fail("Unsupported source event format");
    admitGame({ events: [{ payload: record(row.payload) }] }, null);
    for (const [set, k] of [
      [eventIds, cp(row.club_id) + id(row.id)],
      [eventSequences, cp(row.club_id) + id(row.game_id) + ":" + String(row.sequence)],
      [eventRetries, cp(row.club_id) + id(row.game_id) + ":" + text(row.idempotency_key)],
    ] as const) {
      if (set.has(k)) return fail("Conflicting source event reservations");
      set.add(k);
    }
    if (
      row.replay_sequence !== null &&
      (!Number.isInteger(row.replay_sequence) ||
        Number(row.replay_sequence) < 1 ||
        row.phase_after === null ||
        row.day_before === null ||
        row.day_after === null ||
        typeof row.state_hash_after !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(row.state_hash_after))
    )
      return fail("Unsupported source replay metadata");
    const k = cp(row.club_id) + id(row.game_id);
    const events = apiEvents.get(k) ?? [];
    events.push({
      id: row.id,
      gameId: row.game_id,
      sequence: row.sequence,
      idempotencyKey: row.idempotency_key,
      type: row.event_type,
      phase: row.phase,
      ...(row.seat === null ? {} : { seat: row.seat }),
      payload: row.payload,
      createdAt: new Date(timestamp(row.created_at)).toISOString(),
      duplicate: false,
      parentEventId: row.parent_event_id,
      replayVersion: row.replay_version,
      stateHashAfter: row.state_hash_after,
    });
    apiEvents.set(k, events);
  }
  for (const row of games.values()) {
    requireClub(row);
    if (
      row.ruleset_id !== "club-mafia" ||
      row.ruleset_version !== 1 ||
      row.replay_version !== 1 ||
      Number(row.revision) < 1 ||
      !["active", "completed"].includes(text(row.status)) ||
      !text(row.name).trim() ||
      (row.status === "active") !== (row.results === null)
    )
      return fail("Unsupported source game format/status");
    if (!data.game_rulesets.length) return fail("Missing source ruleset");
    const state = record(row.state);
    const results = row.results === null ? null : record(row.results);
    for (const [s, r] of [
      [state, results],
      [row.initial_game, null],
    ] as const) {
      admitGame(s, r);
      const refs = inspectGameIdentities(s, r);
      if (refs.invalid) return fail("Invalid source canonical identity format");
      for (const playerId of refs.all) {
        // Canonical strings (including case) remain untouched. SQL identity lookup
        // is case-insensitive UUID comparison; normalization is only for keys.
        const player = players.get(cp(row.club_id) + playerId.toLowerCase());
        if (
          !player ||
          (row.status === "active" && player.retired_at !== null && refs.selected.has(playerId))
        )
          return fail("Source snapshot has foreign/retired active identities");
      }
    }
    const k = cp(row.club_id) + id(row.id);
    const envelope = {
      formatVersion: 1,
      session: {
        gameId: row.id,
        name: row.name,
        revision: row.revision,
        status: row.status,
        rulesetId: row.ruleset_id,
        rulesetVersion: row.ruleset_version,
        updatedAt: new Date(timestamp(row.updated_at)).toISOString(),
        state,
        results,
      },
      events: (apiEvents.get(k) ?? []).sort((a, b) => Number(a.sequence) - Number(b.sequence)),
      // Source-only aggregate fields are explicit retained metadata, not newly
      // invented API state or gameplay history.
      postgres: {
        lastMutationId: row.last_mutation_id,
        initialGame: row.initial_game,
        replayBaseEventId: row.replay_base_event_id,
        headEventId: row.head_event_id,
        resetReturnEventId: row.reset_return_event_id,
        resetReturnWasCompleted: row.reset_return_was_completed,
        replayVersion: row.replay_version,
        resultProjection:
          data.game_results.find(
            (result) => result.club_id === row.club_id && result.game_id === row.id,
          ) ?? null,
        apiProjectionRows: data.game_events.filter(
          (event) => event.club_id === row.club_id && event.game_id === row.id,
        ),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    };
    put(
      `${cp(row.club_id)}game:${id(row.id)}`,
      {
        gameId: row.id,
        name: row.name,
        revision: row.revision,
        status: row.status,
        rulesetId: row.ruleset_id,
        rulesetVersion: row.ruleset_version,
        updatedAt: row.updated_at,
        createdAt: row.created_at,
        lastMutationId: row.last_mutation_id,
        ...blob(
          `club/${id(row.club_id)}/game/${id(row.id)}`,
          Buffer.from(JSON.stringify(envelope)),
        ),
      },
      ["createdAt", "updatedAt"],
    );
  }
  for (const row of data.game_session_creations) {
    requireClub(row);
    if (
      !games.has(cp(row.club_id) + id(row.game_id)) &&
      !deletedGames.has(cp(row.club_id) + id(row.game_id))
    )
      return fail("Creation mapping has no live game or tombstone");
    put(
      `${cp(row.club_id)}creation:${id(row.creation_id)}`,
      { gameId: row.game_id, createdAt: row.created_at },
      ["createdAt"],
    );
  }
  const mutationRevisions = new Set<string>();
  for (const row of data.game_session_mutations) {
    requireGame(row);
    const k = cp(row.club_id) + id(row.game_id) + ":" + String(row.revision);
    if (
      Number(row.revision) < 1 ||
      Number(row.revision) > Number(games.get(cp(row.club_id) + id(row.game_id))!.revision) ||
      mutationRevisions.has(k)
    )
      return fail("Invalid mutation retry revision");
    mutationRevisions.add(k);
    if (row.request !== null) {
      const request = record(row.request);
      admitGame(request.state, request.results);
    }
    put(`${cp(row.club_id)}mutation:${id(row.game_id)}:${id(row.mutation_id)}`, {
      gameId: row.game_id,
      mutationId: row.mutation_id,
      revision: row.revision,
      ...(row.request === null
        ? {}
        : blob(`club/${id(row.club_id)}/mutations`, Buffer.from(JSON.stringify(row.request)))),
    });
  }
  const seats = new Set<string>();
  for (const row of data.game_session_players) {
    requireGame(row);
    requirePlayer(row.club_id, row.player_id);
    if (
      (row.is_host === true && (row.seat !== null || row.role !== null)) ||
      (row.is_host === false &&
        (Number(row.seat) < 1 || Number(row.seat) > 10 || row.seat === null))
    )
      return fail("Unsupported participant shape");
    if (row.seat !== null) {
      const k = cp(row.club_id) + id(row.game_id) + ":" + String(row.seat);
      if (seats.has(k)) return fail("Conflicting participant seat");
      seats.add(k);
    }
    put(`${cp(row.club_id)}participant:${id(row.game_id)}:${id(row.player_id)}`, {
      gameId: row.game_id,
      playerId: row.player_id,
      isHost: row.is_host,
      seat: row.seat,
      role: row.role,
    });
  }
  const results = group("game_results", (row) => cp(row.club_id) + id(row.game_id));
  const lastPlayed = new Map<string, number>();
  const notePlayed = (club: unknown, player: unknown, played: unknown) => {
    const k = cp(club) + id(player);
    lastPlayed.set(k, Math.max(lastPlayed.get(k) ?? -Infinity, Date.parse(timestamp(played))));
  };
  for (const row of results.values()) {
    requireGame(row);
    if (
      !["red", "black", "draw", "cancelled"].includes(text(row.outcome)) ||
      (["red", "black"].includes(text(row.outcome))
        ? row.winner !== row.outcome || row.reason !== null
        : row.winner !== null ||
          typeof row.reason !== "string" ||
          !row.reason.trim() ||
          row.reason !== row.reason.trim() ||
          row.reason.length > 500)
    )
      return fail("Unsupported source result");
    if (row.host_player_id !== null) {
      requirePlayer(row.club_id, row.host_player_id);
      if (row.outcome !== "cancelled") {
        put(
          `${cp(row.club_id)}result:${id(row.game_id)}:${id(row.host_player_id)}`,
          {
            gameId: row.game_id,
            playerId: row.host_player_id,
            isHost: true,
            playedAt: row.played_at,
            outcome: row.outcome,
            winner: row.winner,
            reason: row.reason,
          },
          ["playedAt"],
        );
        notePlayed(row.club_id, row.host_player_id, row.played_at);
      }
    }
  }
  const resultSeats = new Set<string>();
  for (const row of data.game_player_results) {
    requirePlayer(row.club_id, row.player_id);
    const parent = results.get(cp(row.club_id) + id(row.game_id));
    if (
      !parent ||
      Number(row.seat) < 1 ||
      Number(row.seat) > 10 ||
      !["sheriff", "citizen", "mafia", "don"].includes(text(row.role)) ||
      !["red", "black"].includes(text(row.team)) ||
      !["active", "eliminated", "red-carded"].includes(text(row.final_status)) ||
      Number(row.fouls) < 0 ||
      (row.best_move_hits !== null &&
        (Number(row.best_move_hits) < 0 || Number(row.best_move_hits) > 3))
    )
      return fail("Unsupported player result relationship/format");
    const seat = cp(row.club_id) + id(row.game_id) + ":" + String(row.seat);
    if (resultSeats.has(seat)) return fail("Conflicting result seat");
    resultSeats.add(seat);
    put(
      `${cp(row.club_id)}result:${id(row.game_id)}:${id(row.player_id)}`,
      {
        gameId: row.game_id,
        playerId: row.player_id,
        isHost: false,
        playedAt: parent.played_at,
        outcome: parent.outcome,
        winner: parent.winner,
        reason: parent.reason,
        seat: row.seat,
        role: row.role,
        team: row.team,
        status: row.final_status,
        fouls: row.fouls,
        won: row.won,
        bestMoveHits: row.best_move_hits,
      },
      ["playedAt"],
    );
    notePlayed(row.club_id, row.player_id, parent.played_at);
  }
  for (const [k, row] of players)
    if (
      (row.last_played_at === null ? undefined : Date.parse(timestamp(row.last_played_at))) !==
      lastPlayed.get(k)
    )
      return fail(
        "Source last-played timestamp disagrees with Azure result reader; no silent repair",
      );
  for (const row of data.game_daily_counters) {
    requireClub(row);
    if (Number(row.last_number) < 1) return fail("Invalid daily counter");
    put(`${cp(row.club_id)}daily-counter:${text(row.game_date)}`, {
      gameDate: row.game_date,
      lastNumber: row.last_number,
    });
  }
  // Exact source bytes stay in the protected operator package, NOT a live
  // immutable copy of player/account PII that would outlive profile erasure.
  // All business columns have explicit rows/envelope mappings above.
  put("migration:source", {
    kind: "postgres-business-source",
    sourceSha256: digest(raw),
    sourceLength: raw.length,
    sourceDatabase: manifest.source.database,
    sourceSchema: manifest.source.schema,
    sourceAddress: manifest.source.serverAddress,
    sourcePort: manifest.source.serverPort,
  });
  return { rows: rows.sort((a, b) => a.rowKey.localeCompare(b.rowKey)), blobs };
};
const logical = (row: BackupRow) =>
  stable({ partitionKey: row.partitionKey, rowKey: row.rowKey, properties: row.properties });
const convertedHash = (converted: Converted) =>
  digest(
    stable({
      rows: converted.rows.map(logical).sort(),
      blobs: [...converted.blobs]
        .map(([name, bytes]) => ({ name, sha256: digest(bytes), length: bytes.length }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }),
  );
const manifestProof = (manifest: PostgresMigrationManifest) =>
  digest(Buffer.from(JSON.stringify(manifest)));

export const preparePostgresMigration = async (
  pool: Pool,
  directory: string,
  options: { projectRoot: string; source: MigrationSource; target: MigrationTarget },
): Promise<{ manifest: PostgresMigrationManifest; sha256: string }> =>
  safe(async () => {
    const parsed = migrationSourceSchema.safeParse(options.source);
    if (!parsed.success) return fail("Explicit source identity is required");
    const source = parsed.data;
    const target = checkedTarget(options.target);
    await packagePath(directory, options.projectRoot, false);
    const client = await pool.connect();
    let raw: Buffer;
    try {
      // No initializeSchema, DDL, seed, or source mutation on this code path.
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL TIME ZONE 'UTC'");
      await client.query("SET LOCAL statement_timeout = '60s'");
      const identity = (
        await client.query<{
          database: string;
          schema: string;
          serverAddress: string;
          serverPort: number;
        }>(
          `SELECT current_database() AS database, current_schema() AS schema, host(inet_server_addr()) AS "serverAddress", inet_server_port() AS "serverPort"`,
        )
      ).rows[0];
      if (!same(identity, source))
        return fail("Explicit source identity does not match connected database");
      const tables = (
        await client.query<{ table_name: string }>(
          "SELECT c.relname AS table_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname",
          [source.schema],
        )
      ).rows.map((row) => row.table_name);
      if (!same(tables, Object.keys(columns).sort()))
        return fail("Unsupported source schema relations");
      const catalog = (
        await client.query<{
          table_name: string;
          column_name: string;
          udt_name: string;
          is_nullable: string;
        }>(
          "SELECT c.relname AS table_name,a.attname AS column_name,t.typname AS udt_name,CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid JOIN pg_type t ON t.oid=a.atttypid WHERE n.nspname=$1 AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped AND a.attgenerated='' AND a.attidentity='' ORDER BY c.relname,a.attnum",
          [source.schema],
        )
      ).rows;
      for (const relation of Object.keys(columns) as Relation[])
        if (
          catalog
            .filter((row) => row.table_name === relation)
            .map((row) => `${row.column_name}:${row.udt_name}:${row.is_nullable}`)
            .join(" ") !== columns[relation]
        )
          return fail("Unsupported source schema columns");
      const constraints = (
        await client.query<{ name: string }>(
          "SELECT c.conname AS name FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 ORDER BY c.conname",
          [source.schema],
        )
      ).rows.map((row) => row.name);
      const indexes = (
        await client.query<{ name: string }>(
          "SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='i' ORDER BY c.relname",
          [source.schema],
        )
      ).rows.map((row) => row.name);
      if (
        !same(constraints, [...expectedConstraintNames].sort()) ||
        !same(indexes, [...expectedIndexNames].sort())
      )
        return fail("Unsupported source schema constraints/indexes");
      // Exact shape admission plus explicit value and relationship checks do
      // not rely on a damaged source's constraints to validate exported data.
      if (
        (
          await client.query<{ invalid: number }>(
            "SELECT COUNT(*)::int AS invalid FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 AND NOT c.convalidated",
            [source.schema],
          )
        ).rows[0]?.invalid !== 0
      )
        return fail("Unsupported unvalidated source schema constraints");
      const unsafe = (
        await client.query<{ count: number }>(
          `SELECT (
        (SELECT COUNT(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND (c.relrowsecurity OR c.relforcerowsecurity OR c.relispartition)) +
        (SELECT COUNT(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal) +
        (SELECT COUNT(*) FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1)
      )::int AS count`,
          [source.schema],
        )
      ).rows[0]?.count;
      if (unsafe !== 0)
        return fail("Unsupported source schema policies, triggers, rules or partitions");
      const encoded: Record<string, string[]> = {};
      for (const relation of relations) {
        // Identifiers are fixed relation names and an admitted identifier regex,
        // never operator SQL. Excluded relations are never SELECTed.
        encoded[relation] = (
          await client.query<{ row: string }>(
            `SELECT row_to_json(t)::text AS row FROM "${source.schema}"."${relation}" t ORDER BY row_to_json(t)::text`,
          )
        ).rows.map((row) => row.row);
      }
      raw = Buffer.from(JSON.stringify({ version: 1, source, relations: encoded }));
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    if (raw.length > 67108864)
      return fail("Source exceeds the bounded 64 MiB migration package; no partial export");
    const datasetId = randomUUID();
    const converted = convert(raw, { source, target, datasetId });
    const manifest: PostgresMigrationManifest = {
      version: 1,
      complete: true,
      kind: "postgres-business-to-azure",
      packageId: randomUUID(),
      datasetId,
      createdAt: new Date().toISOString(),
      source,
      target,
      sourceFile: "source.json",
      sourceSha256: digest(raw),
      sourceLength: raw.length,
      schemaSha256: digest(
        stable({ columns, constraints: expectedConstraintNames, indexes: expectedIndexNames }),
      ),
      entityCount: converted.rows.length,
      blobCount: converted.blobs.size,
      convertedSha256: convertedHash(converted),
      excluded: ["user_sessions", "youtube_oauth_credentials"],
    };
    await mkdir(directory, { mode: 0o700 });
    await writePrivate(join(directory, "source.json"), raw);
    if (
      digest(await readProtectedMigrationFile(join(directory, "source.json"))) !==
      manifest.sourceSha256
    )
      return fail("Written source package changed before completion");
    await writePrivate(join(directory, "manifest.json"), Buffer.from(JSON.stringify(manifest))); // completion last
    return { manifest, sha256: manifestProof(manifest) };
  });
const loadPackage = async (
  directory: string,
  options: { projectRoot: string; sha256?: string },
) => {
  await packagePath(directory, options.projectRoot, true);
  if ((await readdir(directory)).sort().join(",") !== "manifest.json,source.json")
    return fail("Incomplete migration package or unexpected files");
  const bytes = await readProtectedMigrationFile(join(directory, "manifest.json"), 1048576);
  const parsed = manifestSchema.safeParse(json(bytes));
  if (!parsed.success) return fail("Unsupported or incomplete migration manifest");
  const manifest = parsed.data;
  checkedTarget(manifest.target);
  const sha256 = digest(bytes);
  if (
    options.sha256 !== undefined &&
    (!hash.safeParse(options.sha256).success || options.sha256 !== sha256)
  )
    return fail("Migration manifest checksum mismatch");
  if (
    manifest.schemaSha256 !==
    digest(stable({ columns, constraints: expectedConstraintNames, indexes: expectedIndexNames }))
  )
    return fail("Unsupported migration source schema");
  const raw = await readProtectedMigrationFile(join(directory, "source.json"));
  if (raw.length !== manifest.sourceLength || digest(raw) !== manifest.sourceSha256)
    return fail("Migration source hash/length mismatch");
  const converted = convert(raw, manifest);
  if (
    converted.rows.length !== manifest.entityCount ||
    converted.blobs.size !== manifest.blobCount ||
    convertedHash(converted) !== manifest.convertedSha256
  )
    return fail("Migration conversion proof mismatch");
  return { manifest, sha256, converted };
};
export const validatePostgresMigration = async (
  directory: string,
  options: { projectRoot: string },
): Promise<{ manifest: PostgresMigrationManifest; sha256: string }> =>
  safe(async () => {
    const { manifest, sha256 } = await loadPackage(directory, options);
    return { manifest, sha256 };
  });
const listRows = async (storage: MigrationStorage, allowAbsent = false): Promise<BackupRow[]> => {
  const result: BackupRow[] = [];
  try {
    for await (const row of storage.table.listEntities<Record<string, unknown>>({
      disableTypeConversion: true,
    }))
      result.push(encodeBackupRow(row));
  } catch (error) {
    if (!allowAbsent || !missing(error)) throw error;
  }
  return result;
};
const verify = async (
  storage: MigrationStorage,
  converted: Converted,
  control: BackupRow,
  owner: string,
): Promise<void> => {
  const actual = await listRows(storage);
  const expected = [...converted.rows, control];
  if (!same(actual.map(logical).sort(), expected.map(logical).sort()))
    return fail("Target readback changed or differs from migration package");
  const properties = await storage.blobs.getProperties();
  if (
    properties.blobPublicAccess !== undefined ||
    !same(properties.metadata, { postgresmigrationowner: owner })
  )
    return fail("Target container reservation changed");
  const names: string[] = [];
  for await (const blob of storage.blobs.listBlobsFlat()) names.push(blob.name);
  if (!same(names.sort(), [...converted.blobs.keys()].sort()))
    return fail("Target Blob inventory differs from package");
  for (const [name, bytes] of converted.blobs) {
    const client = storage.blobs.getBlockBlobClient(name);
    const props = await client.getProperties();
    if (
      props.contentLength !== bytes.length ||
      props.contentType !== "application/json" ||
      props.metadata?.sha256 !== digest(bytes)
    )
      return fail("Target Blob metadata mismatch");
    const read = await client.downloadToBuffer(0, bytes.length, {
      conditions: { ifMatch: props.etag },
    });
    if (!read.equals(bytes)) return fail("Target Blob byte readback mismatch");
  }
};
const controlRow = (partitionKey: string, properties: SourceRow): BackupRow => {
  const typed: Record<string, BackupProperty> = {};
  for (const [name, value] of Object.entries(properties))
    typed[name] = { type: typeof value === "number" ? "Int32" : "String", value: String(value) };
  return validateBackupRow({
    partitionKey,
    rowKey: "control",
    properties: typed,
    service: { etag: "", timestamp: "2000-01-01T00:00:00Z" },
  });
};
export const applyPostgresMigration = async (
  storage: MigrationStorage,
  directory: string,
  options: { projectRoot: string; sha256: string },
): Promise<{
  status: "imported" | "already-imported";
  manifest: PostgresMigrationManifest;
  sha256: string;
}> =>
  safe(async () => {
    if (!hash.safeParse(options.sha256).success)
      return fail("Explicit package SHA-256 approval is required");
    const pkg = await loadPackage(directory, options); // all checks before target writes
    const { manifest, sha256, converted } = pkg;
    const target = migrationTarget(storage);
    if (!same(target, manifest.target))
      return fail("Migration package is bound to a different target");
    const final = controlRow(target.partitionKey, {
      schemaVersion: 1,
      datasetId: manifest.datasetId,
      revision: 1,
      blobContainer: target.containerUrl,
      writeMode: "normal",
      migrationPackageSha256: sha256,
      migrationOwner: manifest.packageId,
    });
    const existing = await listRows(storage, true);
    let emptyControl: BackupRow | undefined;
    if (existing.length) {
      const control = existing.find(
        (row) => row.partitionKey === target.partitionKey && row.rowKey === "control",
      );
      if (control && logical(control) === logical(final)) {
        await verify(storage, converted, final, manifest.packageId);
        return { status: "already-imported", manifest, sha256 };
      }
      const dataset = control?.properties.datasetId;
      if (
        existing.length === 1 &&
        control &&
        control.service.etag !== "" &&
        control.service.etag !== "*" &&
        dataset?.type === "String" &&
        z.string().uuid().safeParse(dataset.value).success &&
        logical(control) ===
          logical(
            controlRow(target.partitionKey, {
              schemaVersion: 1,
              datasetId: dataset.value,
              revision: 0,
              blobContainer: target.containerUrl,
              writeMode: "normal",
            }),
          )
      )
        emptyControl = control;
      else
        return fail(
          "Migration target is nonempty, foreign, incomplete or has subsequent business writes",
        );
    }
    try {
      const props = await storage.blobs.getProperties();
      if (props.blobPublicAccess !== undefined || Object.keys(props.metadata ?? {}).length)
        return fail("Migration target container is public, foreign or reserved");
      for await (const _blob of storage.blobs.listBlobsFlat()) {
        void _blob;
        return fail("Migration target container is nonempty");
      }
    } catch (error) {
      if (!missing(error)) throw error;
    }
    await storage.table.createTable();
    const marker = controlRow(target.partitionKey, {
      schemaVersion: -1,
      datasetId: manifest.datasetId,
      revision: 0,
      blobContainer: target.containerUrl,
      writeMode: "postgres-migration-in-progress",
      migrationPackageSha256: sha256,
      migrationOwner: manifest.packageId,
    });
    // The only recognized preexisting state is initialize(true)'s exact empty
    // normal revision-0 control. Its ETag fences the first application write;
    // never retry reservation after a competing write or merge/reset that data.
    if (emptyControl)
      await storage.table.updateEntity(decodeBackupRow(marker), "Replace", {
        etag: emptyControl.service.etag,
      });
    else await storage.table.createEntity(decodeBackupRow(marker));
    // The reserved marker is unsupported to all application readers/writers.
    await storage.blobs.createIfNotExists();
    const lease = storage.blobs.getBlobLeaseClient(manifest.packageId);
    await lease.acquireLease(-1);
    try {
      const props = await storage.blobs.getProperties();
      if (props.blobPublicAccess !== undefined || Object.keys(props.metadata ?? {}).length)
        return fail("Migration target container reservation lost");
      await storage.blobs.setMetadata(
        { postgresmigrationowner: manifest.packageId },
        { conditions: { leaseId: manifest.packageId } },
      );
    } finally {
      await lease.releaseLease();
    }
    // Check the whole Table, including foreign partitions, after reservation.
    if (!same((await listRows(storage)).map(logical), [logical(marker)]))
      return fail("Migration target changed during reservation");
    for await (const _blob of storage.blobs.listBlobsFlat()) {
      void _blob;
      return fail("Migration target container changed during reservation");
    }
    for (const [name, bytes] of converted.blobs)
      await storage.blobs.getBlockBlobClient(name).uploadData(bytes, {
        conditions: { ifNoneMatch: "*" },
        blobHTTPHeaders: { blobContentType: "application/json" },
        metadata: {
          sha256: digest(bytes),
          dataset: manifest.datasetId,
          length: String(bytes.length),
        },
        maxSingleShotSize: 67108864,
        concurrency: 1,
      });
    // Create-only single-entity requests intentionally avoid both 100-operation
    // and 4 MiB Table group limits. No hidden retry/resume/merge/reset path.
    for (const row of converted.rows) await storage.table.createEntity(decodeBackupRow(row));
    await verify(storage, converted, marker, manifest.packageId);
    const reserved = await storage.table.getEntity<Record<string, unknown>>(
      target.partitionKey,
      "control",
      { disableTypeConversion: true },
    );
    if (logical(encodeBackupRow(reserved)) !== logical(marker))
      return fail("Migration activation reservation changed");
    try {
      await storage.table.updateEntity(decodeBackupRow(final), "Replace", { etag: reserved.etag });
    } catch {
      /* prove a lost activation response through exact readback below */
    }
    await verify(storage, converted, final, manifest.packageId);
    return { status: "imported", manifest, sha256 };
  });
