import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import { catalogDefinitions } from "./postgres-catalog-definitions.js";
import { columnDefaults } from "./postgres-column-defaults.js";

const schemaUrl = new URL("./schema.sql", import.meta.url);

const targetTables = [
  "club_memberships",
  "clubs",
  "deleted_clubs",
  "deleted_games",
  "game_daily_counters",
  "game_events",
  "game_player_results",
  "game_results",
  "game_rulesets",
  "game_session_creations",
  "game_session_mutations",
  "game_session_players",
  "game_sessions",
  "game_tournaments",
  "players",
  "tournaments",
  "user_sessions",
  "users",
  "youtube_oauth_credentials",
] as const;

// CREATE IF NOT EXISTS cannot repair a relation whose name survived but whose
// definition drifted. Require the exact current catalog on both sides.
const expectedColumns: Readonly<Record<string, string>> = {
  club_memberships: `club_id:uuid:NO user_id:uuid:NO role:text:NO access_player_id:uuid:YES created_at:timestamptz:NO`,
  clubs: `id:uuid:NO name:text:NO city:text:NO header_logo:text:YES card_logo:text:YES language_code:text:NO best_move_enabled:bool:NO created_by:uuid:NO created_at:timestamptz:NO updated_at:timestamptz:NO`,
  deleted_clubs: `club_id:uuid:NO deleted_at:timestamptz:NO`,
  deleted_games: `game_id:uuid:NO club_id:uuid:NO deleted_at:timestamptz:NO`,
  game_daily_counters: `club_id:uuid:NO game_date:date:NO last_number:int4:NO`,
  game_events: `id:uuid:NO club_id:uuid:NO game_id:uuid:NO sequence:int4:NO idempotency_key:text:NO event_type:text:NO phase:text:NO seat:int4:YES payload:jsonb:NO parent_event_id:uuid:YES replay_version:int4:NO replay_sequence:int4:YES phase_after:text:YES day_before:int4:YES day_after:int4:YES state_hash_after:text:YES created_at:timestamptz:NO`,
  game_player_results: `club_id:uuid:NO game_id:uuid:NO player_id:uuid:NO seat:int4:NO role:text:NO team:text:NO final_status:text:NO fouls:int4:NO won:bool:YES best_move_hits:int4:YES`,
  game_results: `game_id:uuid:NO club_id:uuid:NO outcome:text:NO winner:text:YES reason:text:YES played_at:timestamptz:NO host_player_id:uuid:YES`,
  game_rulesets: `id:text:NO version:int4:NO player_count:int4:NO sheriff_count:int4:NO citizen_count:int4:NO mafia_count:int4:NO don_count:int4:NO`,
  game_session_creations: `club_id:uuid:NO creation_id:uuid:NO game_id:uuid:NO created_at:timestamptz:NO`,
  game_session_mutations: `club_id:uuid:NO game_id:uuid:NO mutation_id:uuid:NO revision:int4:NO request:jsonb:YES`,
  game_session_players: `club_id:uuid:NO game_id:uuid:NO player_id:uuid:NO seat:int4:YES is_host:bool:NO role:text:YES`,
  game_sessions: `id:uuid:NO club_id:uuid:NO ruleset_id:text:NO ruleset_version:int4:NO name:text:NO revision:int4:NO last_mutation_id:uuid:NO state:jsonb:NO results:jsonb:YES status:text:NO initial_game:jsonb:YES replay_base_event_id:uuid:YES head_event_id:uuid:YES reset_return_event_id:uuid:YES reset_return_was_completed:bool:NO replay_version:int4:NO created_at:timestamptz:NO updated_at:timestamptz:NO`,
  game_tournaments: `club_id:uuid:NO game_id:uuid:NO tournament_id:uuid:NO`,
  tournaments: `club_id:uuid:NO id:uuid:NO name:text:NO name_key:text:NO`,
  players: `id:uuid:NO club_id:uuid:NO nickname:text:YES first_name:text:YES last_name:text:YES email:text:YES data_processing_consent:bool:NO consent_at:timestamptz:YES club_access:text:NO user_id:uuid:YES created_at:timestamptz:NO updated_at:timestamptz:NO last_played_at:timestamptz:YES retired_at:timestamptz:YES`,
  user_sessions: `id:uuid:NO token_hash:bytea:NO user_id:uuid:NO expires_at:timestamptz:NO created_at:timestamptz:NO`,
  users: `id:uuid:NO google_subject:text:YES email:text:NO display_name:text:NO picture:text:YES created_at:timestamptz:NO updated_at:timestamptz:NO`,
  youtube_oauth_credentials: `user_id:uuid:NO singleton:bool:NO access_token_encrypted:bytea:NO refresh_token_encrypted:bytea:NO expires_at:timestamptz:NO account_label:text:NO scope:text:NO updated_at:timestamptz:NO`,
};

const equal = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.length === expected.length && actual.every((item, index) => item === expected[index]);

const unsupportedSchema = (reason: string): Error =>
  new Error(
    `Unsupported existing database schema: ${reason}. Bootstrap supports only an empty schema or the current server-backed records catalog.`,
  );

interface Catalog {
  readonly safe: boolean;
  readonly tables: readonly string[];
  readonly columns: ReadonlyMap<string, readonly string[]>;
  readonly constraints: ReadonlyMap<string, string>;
  readonly constraintTables: ReadonlyMap<string, string>;
  readonly indexes: ReadonlyMap<
    string,
    {
      readonly table_name: string;
      readonly is_valid: boolean;
      readonly access_method: string;
      readonly has_includes: boolean;
      readonly is_unique: boolean;
      readonly predicate: string | null;
      readonly columns: readonly string[];
    }
  >;
}

const catalog = async (client: PoolClient): Promise<Catalog> => {
  const tables = await client.query<{ table_name: string }>(`
      SELECT c.relname AS table_name FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = current_schema() AND c.relkind IN ('r','p','v','m','f','S')
       ORDER BY c.relname
    `);
  const columns = await client.query<{
    table_name: string;
    column_name: string;
    udt_name: string;
    is_nullable: "YES" | "NO";
    generated: string;
    identity: string;
    type_modifier: number;
    custom_collation: boolean;
    default_expression: string | null;
  }>(`
      SELECT c.relname AS table_name, a.attname AS column_name, t.typname AS udt_name,
             CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
             a.attgenerated AS generated, a.attidentity AS identity, a.atttypmod AS type_modifier,
             (a.attcollation <> t.typcollation) AS custom_collation, pg_get_expr(d.adbin,d.adrelid) AS default_expression
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_attribute a ON a.attrelid=c.oid JOIN pg_type t ON t.oid=a.atttypid
        LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
       WHERE n.nspname=current_schema() AND c.relkind='r'
         AND a.attnum>0 AND NOT a.attisdropped
       ORDER BY c.relname,a.attnum
    `);
  const constraints = await client.query<{
    conname: string;
    definition: string;
    table_name: string;
  }>(`
      SELECT constraint_row.conname, pg_get_constraintdef(constraint_row.oid) AS definition, relation.relname AS table_name
        FROM pg_constraint AS constraint_row
        JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = current_schema()
    `);
  const indexes = await client.query<{
    index_name: string;
    table_name: string;
    is_valid: boolean;
    access_method: string;
    has_includes: boolean;
    is_unique: boolean;
    predicate: string | null;
    columns: string[];
  }>(`
      SELECT index_relation.relname AS index_name,
             table_relation.relname AS table_name, index_row.indisvalid AS is_valid,
             method.amname AS access_method, (index_row.indnatts <> index_row.indnkeyatts) AS has_includes,
             index_row.indisunique AS is_unique,
             pg_get_expr(index_row.indpred, index_row.indrelid) AS predicate,
             ARRAY(
               SELECT pg_get_indexdef(index_row.indexrelid, key_position, true)
                 FROM generate_series(1, index_row.indnkeyatts) AS key_position
                ORDER BY key_position
             ) AS columns
        FROM pg_index AS index_row
        JOIN pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
        JOIN pg_class AS table_relation ON table_relation.oid = index_row.indrelid
        JOIN pg_am method ON method.oid = index_relation.relam
        JOIN pg_namespace AS namespace ON namespace.oid = table_relation.relnamespace
       WHERE namespace.nspname = current_schema()
    `);
  const unsafe = (
    await client.query<{ count: number }>(`
    SELECT (
      (SELECT COUNT(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=current_schema() AND (c.relrowsecurity OR c.relforcerowsecurity OR c.relispartition)) +
      (SELECT COUNT(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=current_schema() AND NOT t.tgisinternal) +
      (SELECT COUNT(*) FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=current_schema() AND r.rulename <> '_RETURN') +
      (SELECT COUNT(*) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=current_schema())
    )::int AS count
  `)
  ).rows[0]?.count;
  return {
    safe:
      unsafe === 0 &&
      constraints.rows.length === new Set(constraints.rows.map((c) => c.conname)).size &&
      columns.rows.every(
        (c) =>
          c.generated === "" &&
          c.identity === "" &&
          c.type_modifier === -1 &&
          !c.custom_collation &&
          c.default_expression === (columnDefaults[`${c.table_name}.${c.column_name}`] ?? null),
      ),
    tables: tables.rows.map(({ table_name }) => table_name),
    columns: new Map(
      tables.rows.map(({ table_name }) => [
        table_name,
        columns.rows
          .filter((column) => column.table_name === table_name)
          .map(
            ({ column_name, udt_name, is_nullable }) => `${column_name}:${udt_name}:${is_nullable}`,
          ),
      ]),
    ),
    constraints: new Map(constraints.rows.map(({ conname, definition }) => [conname, definition])),
    constraintTables: new Map(constraints.rows.map((row) => [row.conname, row.table_name])),
    indexes: new Map(indexes.rows.map((index) => [index.index_name, index])),
  };
};

const expectedDefinitions: Readonly<Record<string, readonly string[]>> = {
  club_memberships_access_player_fk: [
    "FOREIGN KEY (access_player_id, club_id, user_id) REFERENCES players(id, club_id, user_id) ON DELETE CASCADE",
  ],
  game_events_replay_metadata_ck: ["sha256:[0-9a-f]{64}", "replay_sequence is null"],
  game_player_results_game_fk: [
    "FOREIGN KEY (club_id, game_id) REFERENCES game_results(club_id, game_id) ON DELETE CASCADE",
  ],
  game_results_shape_ck: ["outcome", "draw", "cancelled", "length(reason) <= 500"],
  game_session_mutations_game_fk: [
    "FOREIGN KEY (club_id, game_id) REFERENCES game_sessions(club_id, id) ON DELETE CASCADE",
  ],
  game_session_players_player_fk: [
    "FOREIGN KEY (club_id, player_id) REFERENCES players(club_id, id) ON DELETE RESTRICT",
  ],
  game_sessions_pkey: ["PRIMARY KEY (club_id, id)"],
  players_access_provenance_unique: ["UNIQUE (id, club_id, user_id)"],
  players_access_requires_consent_ck: ["club_access", "data_processing_consent", "user_id"],
  players_nickname_check: ["retired_at", "nickname is null", "user_id is null"],
};

const tournamentRelation = (name: string): boolean =>
  name.startsWith("tournaments") || name.startsWith("game_tournaments");
const matchesCatalog = (value: Catalog, preceding = false): boolean => {
  if (!value.safe) return false;
  const tables = targetTables.filter((table) => !preceding || !tournamentRelation(table));
  if (!equal(value.tables, tables)) return false;
  for (const table of tables) {
    const signatures = expectedColumns[table]?.split(/\s+/);
    if (signatures === undefined) return false;
    if (!equal(value.columns.get(table) ?? [], signatures)) return false;
  }
  const constraints = catalogDefinitions.constraints.filter(
    (c) => !preceding || !tournamentRelation(c.conname),
  );
  const indexes = catalogDefinitions.indexes.filter(
    (i) => !preceding || !tournamentRelation(i.name),
  );
  if (!equal([...value.constraints.keys()].sort(), constraints.map((c) => c.conname).sort()))
    return false;
  for (const c of constraints) {
    if (
      value.constraints.get(c.conname) !== c.definition ||
      value.constraintTables.get(c.conname) !==
        tables.find((table) => c.conname.startsWith(`${table}_`))
    )
      return false;
  }
  for (const i of indexes) {
    const actual = value.indexes.get(i.name);
    if (
      !actual ||
      actual.table_name !== i.table_name ||
      !actual.is_valid ||
      actual.access_method !== "btree" ||
      actual.has_includes ||
      actual.is_unique !== i.is_unique ||
      actual.predicate !== i.predicate ||
      !equal(actual.columns, i.columns)
    )
      return false;
  }
  for (const [name, fragments] of Object.entries(expectedDefinitions)) {
    const definition = value.constraints.get(name)?.toLowerCase() ?? "";
    if (fragments.some((fragment) => !definition.includes(fragment.toLowerCase()))) return false;
  }
  if (value.constraints.get("game_events_replay_metadata_ck")?.includes("[0-9a-f]{8}"))
    return false;
  if (!equal([...value.indexes.keys()].sort(), indexes.map((i) => i.name).sort())) return false;
  const replayIndex = value.indexes.get("game_events_club_game_replay_sequence_idx");
  if (
    replayIndex?.is_unique !== true ||
    replayIndex.predicate !== "(replay_sequence IS NOT NULL)" ||
    !equal(replayIndex.columns, ["club_id", "game_id", "replay_sequence"])
  )
    return false;
  const nicknameIndex = value.indexes.get("players_club_nickname_unique_idx");
  if (nicknameIndex?.is_unique !== true || nicknameIndex.predicate !== "(retired_at IS NULL)")
    return false;
  return true;
};

/** Read-only admission for the importer; never execute initialization DDL. */
export const recognizeStorageSourceCatalog = async (
  client: PoolClient,
): Promise<"current" | "preceding"> => {
  const value = await catalog(client);
  if (matchesCatalog(value)) return "current";
  if (matchesCatalog(value, true)) return "preceding";
  throw unsupportedSchema("source catalog does not match an exact supported boundary");
};

const hasApplicationRelations = async (client: PoolClient): Promise<boolean> => {
  const result = await client.query(`
    SELECT 1 FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = current_schema()
       AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') LIMIT 1
  `);
  return (result.rowCount ?? 0) > 0;
};

export const initializeSchema = async (pool: Pool): Promise<void> => {
  const schema = await readFile(schemaUrl, "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('mafia_dashboard_schema', 0))",
    );
    const before = await catalog(client);
    const empty = !(await hasApplicationRelations(client));
    // Exactly one known predecessor: the full prior catalog with both new
    // metadata tables absent. Partial metadata DDL and historical shapes fail.
    if (!empty && !matchesCatalog(before) && !matchesCatalog(before, true)) {
      throw unsupportedSchema("catalog does not match a supported schema boundary");
    }
    await client.query(schema);
    const after = await catalog(client);
    if (!matchesCatalog(after))
      throw unsupportedSchema("migration did not produce the target catalog");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};
