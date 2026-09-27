import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";

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
  "players",
  "user_sessions",
  "users",
  "youtube_oauth_credentials",
] as const;

// CREATE IF NOT EXISTS cannot repair a relation whose name survived but whose
// definition drifted. Preserve the old exact catalog boundary on both sides.
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
  players: `id:uuid:NO club_id:uuid:NO nickname:text:NO first_name:text:YES last_name:text:YES email:text:YES data_processing_consent:bool:NO consent_at:timestamptz:YES club_access:text:NO user_id:uuid:YES created_at:timestamptz:NO updated_at:timestamptz:NO last_played_at:timestamptz:YES`,
  user_sessions: `id:uuid:NO token_hash:bytea:NO user_id:uuid:NO expires_at:timestamptz:NO created_at:timestamptz:NO`,
  users: `id:uuid:NO google_subject:text:YES email:text:NO display_name:text:NO picture:text:YES created_at:timestamptz:NO updated_at:timestamptz:NO`,
  youtube_oauth_credentials: `user_id:uuid:NO singleton:bool:NO access_token_encrypted:bytea:NO refresh_token_encrypted:bytea:NO expires_at:timestamptz:NO account_label:text:NO scope:text:NO updated_at:timestamptz:NO`,
};

const legacyClaimColumnSignatures = `claim_id:uuid:YES claim_generation:int8:NO claimed_by_user_id:uuid:YES claimed_at:timestamptz:YES claim_last_seen_at:timestamptz:YES claim_expires_at:timestamptz:YES`;

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

const equal = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.length === expected.length && actual.every((item, index) => item === expected[index]);

const unsupportedSchema = (reason: string): Error =>
  new Error(
    `Unsupported existing database schema: ${reason}. Bootstrap supports only an empty schema, the server-backed records catalog, or its immediately previous claim-controlled catalog.`,
  );

interface Catalog {
  readonly tables: readonly string[];
  readonly columns: ReadonlyMap<string, readonly string[]>;
  readonly constraints: ReadonlyMap<string, string>;
  readonly indexes: ReadonlyMap<
    string,
    {
      readonly is_unique: boolean;
      readonly predicate: string | null;
      readonly columns: readonly string[];
    }
  >;
}

const catalog = async (client: PoolClient): Promise<Catalog> => {
  const tables = await client.query<{ table_name: string }>(`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
       ORDER BY table_name
    `);
  const columns = await client.query<{
    table_name: string;
    column_name: string;
    udt_name: string;
    is_nullable: "YES" | "NO";
  }>(`
      SELECT table_name, column_name, udt_name, is_nullable
        FROM information_schema.columns
       WHERE table_schema = current_schema()
       ORDER BY table_name, ordinal_position
    `);
  const constraints = await client.query<{ conname: string; definition: string }>(`
      SELECT constraint_row.conname, pg_get_constraintdef(constraint_row.oid) AS definition
        FROM pg_constraint AS constraint_row
        JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = current_schema()
    `);
  const indexes = await client.query<{
    index_name: string;
    is_unique: boolean;
    predicate: string | null;
    columns: string[];
  }>(`
      SELECT index_relation.relname AS index_name,
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
        JOIN pg_namespace AS namespace ON namespace.oid = table_relation.relnamespace
       WHERE namespace.nspname = current_schema()
    `);
  return {
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
};

const matchesCatalog = (value: Catalog, legacy: boolean): boolean => {
  const tables = legacy
    ? targetTables.filter((table) => table !== "game_session_creations")
    : targetTables;
  if (!equal(value.tables, tables)) return false;
  for (const table of tables) {
    const signatures = expectedColumns[table]?.split(/\s+/);
    if (signatures === undefined) return false;
    const expected =
      table === "game_sessions" && legacy
        ? [...signatures, ...legacyClaimColumnSignatures.split(/\s+/)]
        : signatures;
    if (!equal(value.columns.get(table) ?? [], expected)) return false;
  }
  const constraints = legacy
    ? [
        ...expectedConstraintNames.filter((name) => !name.startsWith("game_session_creations_")),
        "game_sessions_claim_metadata_ck",
        "game_sessions_claimed_by_user_fk",
      ]
    : expectedConstraintNames;
  if (!equal([...value.constraints.keys()].sort(), [...constraints].sort())) return false;
  const definitions: Readonly<Record<string, readonly string[]>> = legacy
    ? {
        ...expectedDefinitions,
        game_sessions_claim_metadata_ck: [
          "claim_generation >= 0",
          "claim_last_seen_at >= claimed_at",
          "claim_expires_at > claim_last_seen_at",
        ],
      }
    : expectedDefinitions;
  for (const [name, fragments] of Object.entries(definitions)) {
    const definition = value.constraints.get(name)?.toLowerCase() ?? "";
    if (fragments.some((fragment) => !definition.includes(fragment.toLowerCase()))) return false;
  }
  if (value.constraints.get("game_events_replay_metadata_ck")?.includes("[0-9a-f]{8}"))
    return false;
  const indexes = legacy
    ? [
        ...expectedIndexNames.filter((name) => name !== "game_session_creations_pkey"),
        "game_sessions_one_active_per_club_idx",
      ]
    : expectedIndexNames;
  if (!equal([...value.indexes.keys()].sort(), [...indexes].sort())) return false;
  const replayIndex = value.indexes.get("game_events_club_game_replay_sequence_idx");
  if (
    replayIndex?.is_unique !== true ||
    replayIndex.predicate !== "(replay_sequence IS NOT NULL)" ||
    !equal(replayIndex.columns, ["club_id", "game_id", "replay_sequence"])
  )
    return false;
  const activeIndex = value.indexes.get("game_sessions_one_active_per_club_idx");
  return (
    !legacy ||
    (activeIndex?.is_unique === true &&
      activeIndex.predicate === "(status = 'active'::text)" &&
      equal(activeIndex.columns, ["club_id"]))
  );
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
    if (!empty && !matchesCatalog(before, false) && !matchesCatalog(before, true)) {
      throw unsupportedSchema("catalog does not match a supported schema boundary");
    }
    await client.query(schema);
    const after = await catalog(client);
    if (!matchesCatalog(after, false))
      throw unsupportedSchema("migration did not produce the target catalog");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};
