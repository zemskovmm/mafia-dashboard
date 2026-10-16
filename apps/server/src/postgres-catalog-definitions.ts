// Exact supported catalog definitions captured from owned PostgreSQL fixtures.
// The preceding boundary has no tournament or game_tournament relations.
export const catalogDefinitions = {
  constraints: [
    {
      conname: "club_memberships_access_player_fk",
      definition:
        "FOREIGN KEY (access_player_id, club_id, user_id) REFERENCES players(id, club_id, user_id) ON DELETE CASCADE",
    },
    {
      conname: "club_memberships_club_id_fkey",
      definition: "FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE",
    },
    {
      conname: "club_memberships_pkey",
      definition: "PRIMARY KEY (club_id, user_id)",
    },
    {
      conname: "club_memberships_role_ck",
      definition: "CHECK ((role = ANY (ARRAY['manager'::text, 'user'::text])))",
    },
    {
      conname: "club_memberships_user_id_fkey",
      definition: "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE",
    },
    {
      conname: "clubs_city_check",
      definition: "CHECK ((btrim(city) <> ''::text))",
    },
    {
      conname: "clubs_created_by_fkey",
      definition: "FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT",
    },
    {
      conname: "clubs_language_code_ck",
      definition: "CHECK ((language_code = ANY (ARRAY['en'::text, 'ru'::text])))",
    },
    {
      conname: "clubs_name_check",
      definition: "CHECK ((btrim(name) <> ''::text))",
    },
    {
      conname: "clubs_pkey",
      definition: "PRIMARY KEY (id)",
    },
    {
      conname: "deleted_clubs_pkey",
      definition: "PRIMARY KEY (club_id)",
    },
    {
      conname: "deleted_games_club_fk",
      definition: "FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE RESTRICT",
    },
    {
      conname: "deleted_games_pkey",
      definition: "PRIMARY KEY (club_id, game_id)",
    },
    {
      conname: "game_daily_counters_club_fk",
      definition: "FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE",
    },
    {
      conname: "game_daily_counters_last_number_check",
      definition: "CHECK ((last_number > 0))",
    },
    {
      conname: "game_daily_counters_pkey",
      definition: "PRIMARY KEY (club_id, game_date)",
    },
    {
      conname: "game_events_club_fk",
      definition: "FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE RESTRICT",
    },
    {
      conname: "game_events_club_game_event_unique",
      definition: "UNIQUE (club_id, game_id, id)",
    },
    {
      conname: "game_events_club_game_idempotency_unique",
      definition: "UNIQUE (club_id, game_id, idempotency_key)",
    },
    {
      conname: "game_events_club_game_sequence_unique",
      definition: "UNIQUE (club_id, game_id, sequence)",
    },
    {
      conname: "game_events_day_after_nonnegative_ck",
      definition: "CHECK ((day_after >= 0))",
    },
    {
      conname: "game_events_day_before_nonnegative_ck",
      definition: "CHECK ((day_before >= 0))",
    },
    {
      conname: "game_events_pkey",
      definition: "PRIMARY KEY (club_id, id)",
    },
    {
      conname: "game_events_replay_metadata_ck",
      definition:
        "CHECK (((replay_sequence IS NULL) OR ((replay_version = 1) AND (phase_after IS NOT NULL) AND (day_before IS NOT NULL) AND (day_after IS NOT NULL) AND (state_hash_after ~ '^sha256:[0-9a-f]{64}$'::text))))",
    },
    {
      conname: "game_events_replay_sequence_positive_ck",
      definition: "CHECK ((replay_sequence > 0))",
    },
    {
      conname: "game_events_seat_check",
      definition: "CHECK (((seat >= 1) AND (seat <= 10)))",
    },
    {
      conname: "game_events_sequence_check",
      definition: "CHECK ((sequence > 0))",
    },
    {
      conname: "game_player_results_best_move_hits_check",
      definition: "CHECK (((best_move_hits >= 0) AND (best_move_hits <= 3)))",
    },
    {
      conname: "game_player_results_final_status_check",
      definition:
        "CHECK ((final_status = ANY (ARRAY['active'::text, 'eliminated'::text, 'red-carded'::text])))",
    },
    {
      conname: "game_player_results_fouls_check",
      definition: "CHECK ((fouls >= 0))",
    },
    {
      conname: "game_player_results_game_fk",
      definition:
        "FOREIGN KEY (club_id, game_id) REFERENCES game_results(club_id, game_id) ON DELETE CASCADE",
    },
    {
      conname: "game_player_results_game_seat_unique",
      definition: "UNIQUE (club_id, game_id, seat)",
    },
    {
      conname: "game_player_results_pkey",
      definition: "PRIMARY KEY (club_id, game_id, player_id)",
    },
    {
      conname: "game_player_results_player_fk",
      definition:
        "FOREIGN KEY (club_id, player_id) REFERENCES players(club_id, id) ON DELETE RESTRICT",
    },
    {
      conname: "game_player_results_role_check",
      definition:
        "CHECK ((role = ANY (ARRAY['sheriff'::text, 'citizen'::text, 'mafia'::text, 'don'::text])))",
    },
    {
      conname: "game_player_results_seat_check",
      definition: "CHECK (((seat >= 1) AND (seat <= 10)))",
    },
    {
      conname: "game_player_results_team_check",
      definition: "CHECK ((team = ANY (ARRAY['red'::text, 'black'::text])))",
    },
    {
      conname: "game_results_club_fk",
      definition: "FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE RESTRICT",
    },
    {
      conname: "game_results_host_player_fk",
      definition:
        "FOREIGN KEY (club_id, host_player_id) REFERENCES players(club_id, id) ON DELETE RESTRICT",
    },
    {
      conname: "game_results_outcome_ck",
      definition:
        "CHECK ((outcome = ANY (ARRAY['red'::text, 'black'::text, 'draw'::text, 'cancelled'::text])))",
    },
    {
      conname: "game_results_pkey",
      definition: "PRIMARY KEY (club_id, game_id)",
    },
    {
      conname: "game_results_shape_ck",
      definition:
        "CHECK ((((outcome = ANY (ARRAY['red'::text, 'black'::text])) AND (winner IS NOT NULL) AND (winner = outcome) AND (reason IS NULL)) OR ((outcome = ANY (ARRAY['draw'::text, 'cancelled'::text])) AND (winner IS NULL) AND (reason IS NOT NULL) AND (reason = btrim(reason)) AND (btrim(reason) <> ''::text) AND (length(reason) <= 500))))",
    },
    {
      conname: "game_rulesets_citizen_count_check",
      definition: "CHECK ((citizen_count >= 0))",
    },
    {
      conname: "game_rulesets_don_count_check",
      definition: "CHECK ((don_count >= 0))",
    },
    {
      conname: "game_rulesets_id_check",
      definition: "CHECK ((btrim(id) <> ''::text))",
    },
    {
      conname: "game_rulesets_mafia_count_check",
      definition: "CHECK ((mafia_count >= 0))",
    },
    {
      conname: "game_rulesets_pkey",
      definition: "PRIMARY KEY (id, version)",
    },
    {
      conname: "game_rulesets_player_count_check",
      definition: "CHECK ((player_count > 0))",
    },
    {
      conname: "game_rulesets_role_count_ck",
      definition:
        "CHECK (((((sheriff_count + citizen_count) + mafia_count) + don_count) = player_count))",
    },
    {
      conname: "game_rulesets_sheriff_count_check",
      definition: "CHECK ((sheriff_count >= 0))",
    },
    {
      conname: "game_rulesets_version_check",
      definition: "CHECK ((version > 0))",
    },
    {
      conname: "game_session_creations_club_fk",
      definition: "FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE",
    },
    {
      conname: "game_session_creations_pkey",
      definition: "PRIMARY KEY (club_id, creation_id)",
    },
    {
      conname: "game_session_mutations_game_fk",
      definition:
        "FOREIGN KEY (club_id, game_id) REFERENCES game_sessions(club_id, id) ON DELETE CASCADE",
    },
    {
      conname: "game_session_mutations_game_revision_unique",
      definition: "UNIQUE (club_id, game_id, revision)",
    },
    {
      conname: "game_session_mutations_pkey",
      definition: "PRIMARY KEY (club_id, game_id, mutation_id)",
    },
    {
      conname: "game_session_mutations_revision_check",
      definition: "CHECK ((revision > 0))",
    },
    {
      conname: "game_session_players_game_fk",
      definition:
        "FOREIGN KEY (club_id, game_id) REFERENCES game_sessions(club_id, id) ON DELETE CASCADE",
    },
    {
      conname: "game_session_players_game_seat_unique",
      definition: "UNIQUE (club_id, game_id, seat)",
    },
    {
      conname: "game_session_players_pkey",
      definition: "PRIMARY KEY (club_id, game_id, player_id)",
    },
    {
      conname: "game_session_players_player_fk",
      definition:
        "FOREIGN KEY (club_id, player_id) REFERENCES players(club_id, id) ON DELETE RESTRICT",
    },
    {
      conname: "game_session_players_role_ck",
      definition:
        "CHECK (((role IS NULL) OR (role = ANY (ARRAY['sheriff'::text, 'citizen'::text, 'mafia'::text, 'don'::text]))))",
    },
    {
      conname: "game_session_players_seat_check",
      definition: "CHECK (((seat >= 1) AND (seat <= 10)))",
    },
    {
      conname: "game_session_players_shape_ck",
      definition:
        "CHECK (((is_host AND (seat IS NULL) AND (role IS NULL)) OR ((NOT is_host) AND (seat IS NOT NULL))))",
    },
    {
      conname: "game_sessions_club_fk",
      definition: "FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE RESTRICT",
    },
    {
      conname: "game_sessions_name_check",
      definition: "CHECK ((btrim(name) <> ''::text))",
    },
    {
      conname: "game_sessions_pkey",
      definition: "PRIMARY KEY (club_id, id)",
    },
    {
      conname: "game_sessions_revision_check",
      definition: "CHECK ((revision > 0))",
    },
    {
      conname: "game_sessions_ruleset_fk",
      definition:
        "FOREIGN KEY (ruleset_id, ruleset_version) REFERENCES game_rulesets(id, version) ON UPDATE RESTRICT ON DELETE RESTRICT",
    },
    {
      conname: "game_sessions_status_check",
      definition: "CHECK ((status = ANY (ARRAY['active'::text, 'completed'::text])))",
    },
    {
      conname: "game_tournaments_game_fk",
      definition:
        "FOREIGN KEY (club_id, game_id) REFERENCES game_sessions(club_id, id) ON DELETE CASCADE",
    },
    {
      conname: "game_tournaments_pkey",
      definition: "PRIMARY KEY (club_id, game_id)",
    },
    {
      conname: "game_tournaments_tournament_fk",
      definition:
        "FOREIGN KEY (club_id, tournament_id) REFERENCES tournaments(club_id, id) ON DELETE RESTRICT",
    },
    {
      conname: "players_access_provenance_unique",
      definition: "UNIQUE (id, club_id, user_id)",
    },
    {
      conname: "players_access_requires_consent_ck",
      definition:
        "CHECK (((club_access = 'none'::text) OR data_processing_consent OR (user_id IS NOT NULL)))",
    },
    {
      conname: "players_check",
      definition:
        "CHECK ((((data_processing_consent = false) AND (first_name IS NULL) AND (last_name IS NULL) AND (email IS NULL) AND (consent_at IS NULL)) OR ((data_processing_consent = true) AND (first_name IS NOT NULL) AND (last_name IS NOT NULL) AND (email IS NOT NULL) AND (btrim(first_name) <> ''::text) AND (btrim(last_name) <> ''::text) AND (btrim(email) <> ''::text) AND (consent_at IS NOT NULL))))",
    },
    {
      conname: "players_club_access_ck",
      definition:
        "CHECK ((club_access = ANY (ARRAY['none'::text, 'user'::text, 'manager'::text])))",
    },
    {
      conname: "players_club_fk",
      definition: "FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE RESTRICT",
    },
    {
      conname: "players_club_id_id_unique",
      definition: "UNIQUE (club_id, id)",
    },
    {
      conname: "players_nickname_check",
      definition:
        "CHECK ((((retired_at IS NULL) AND (nickname IS NOT NULL) AND (btrim(nickname) <> ''::text)) OR ((retired_at IS NOT NULL) AND (nickname IS NULL) AND (first_name IS NULL) AND (last_name IS NULL) AND (email IS NULL) AND (user_id IS NULL) AND (club_access = 'none'::text) AND (NOT data_processing_consent) AND (consent_at IS NULL))))",
    },
    {
      conname: "players_pkey",
      definition: "PRIMARY KEY (id)",
    },
    {
      conname: "players_user_fk",
      definition: "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL",
    },
    {
      conname: "tournaments_club_fk",
      definition: "FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE",
    },
    {
      conname: "tournaments_name_check",
      definition: "CHECK (((btrim(name) <> ''::text) AND (length(name) <= 100)))",
    },
    {
      conname: "tournaments_name_key_check",
      definition: "CHECK ((btrim(name_key) <> ''::text))",
    },
    {
      conname: "tournaments_name_key_unique",
      definition: "UNIQUE (club_id, name_key)",
    },
    {
      conname: "tournaments_pkey",
      definition: "PRIMARY KEY (club_id, id)",
    },
    {
      conname: "user_sessions_pkey",
      definition: "PRIMARY KEY (id)",
    },
    {
      conname: "user_sessions_token_hash_key",
      definition: "UNIQUE (token_hash)",
    },
    {
      conname: "user_sessions_user_id_fkey",
      definition: "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE",
    },
    {
      conname: "users_display_name_check",
      definition: "CHECK ((btrim(display_name) <> ''::text))",
    },
    {
      conname: "users_email_check",
      definition: "CHECK ((btrim(email) <> ''::text))",
    },
    {
      conname: "users_email_key",
      definition: "UNIQUE (email)",
    },
    {
      conname: "users_pkey",
      definition: "PRIMARY KEY (id)",
    },
    {
      conname: "youtube_oauth_credentials_account_label_check",
      definition: "CHECK ((btrim(account_label) <> ''::text))",
    },
    {
      conname: "youtube_oauth_credentials_pkey",
      definition: "PRIMARY KEY (user_id)",
    },
    {
      conname: "youtube_oauth_credentials_singleton_check",
      definition: "CHECK (singleton)",
    },
    {
      conname: "youtube_oauth_credentials_user_id_fkey",
      definition: "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE",
    },
  ],
  indexes: [
    {
      name: "club_memberships_access_player_unique_idx",
      table_name: "club_memberships",
      is_unique: true,
      predicate: "(access_player_id IS NOT NULL)",
      columns: ["access_player_id"],
    },
    {
      name: "club_memberships_pkey",
      table_name: "club_memberships",
      is_unique: true,
      predicate: null,
      columns: ["club_id", "user_id"],
    },
    {
      name: "clubs_pkey",
      table_name: "clubs",
      is_unique: true,
      predicate: null,
      columns: ["id"],
    },
    {
      name: "deleted_clubs_pkey",
      table_name: "deleted_clubs",
      is_unique: true,
      predicate: null,
      columns: ["club_id"],
    },
    {
      name: "deleted_games_pkey",
      table_name: "deleted_games",
      is_unique: true,
      predicate: null,
      columns: ["club_id", "game_id"],
    },
    {
      name: "game_daily_counters_pkey",
      table_name: "game_daily_counters",
      is_unique: true,
      predicate: null,
      columns: ["club_id", "game_date"],
    },
    {
      name: "game_events_club_game_event_unique",
      table_name: "game_events",
      is_unique: true,
      predicate: null,
      columns: ["club_id", "game_id", "id"],
    },
    {
      name: "game_events_club_game_idempotency_unique",
      table_name: "game_events",
      is_unique: true,
      predicate: null,
      columns: ["club_id", "game_id", "idempotency_key"],
    },
    {
      name: "game_events_club_game_parent_idx",
      table_name: "game_events",
      is_unique: false,
      predicate: null,
      columns: ["club_id", "game_id", "parent_event_id"],
    },
    {
      name: "game_events_club_game_replay_sequence_idx",
      table_name: "game_events",
      is_unique: true,
      predicate: "(replay_sequence IS NOT NULL)",
      columns: ["club_id", "game_id", "replay_sequence"],
    },
    {
      name: "game_events_club_game_sequence_unique",
      table_name: "game_events",
      is_unique: true,
      predicate: null,
      columns: ["club_id", "game_id", "sequence"],
    },
    {
      name: "game_events_game_parent_idx",
      table_name: "game_events",
      is_unique: false,
      predicate: null,
      columns: ["game_id", "parent_event_id"],
    },
    {
      name: "game_events_pkey",
      table_name: "game_events",
      is_unique: true,
      predicate: null,
      columns: ["club_id", "id"],
    },
    {
      name: "game_player_results_game_seat_unique",
      table_name: "game_player_results",
      is_unique: true,
      predicate: null,
      columns: ["club_id", "game_id", "seat"],
    },
    {
      name: "game_player_results_pkey",
      table_name: "game_player_results",
      is_unique: true,
      predicate: null,
      columns: ["club_id", "game_id", "player_id"],
    },
    {
      name: "game_player_results_player_idx",
      table_name: "game_player_results",
      is_unique: false,
      predicate: null,
      columns: ["player_id", "game_id"],
    },
    {
      name: "game_results_club_outcome_played_idx",
      table_name: "game_results",
      is_unique: false,
      predicate: null,
      columns: ["club_id", "outcome", "played_at"],
    },
    {
      name: "game_results_club_played_idx",
      table_name: "game_results",
      is_unique: false,
      predicate: null,
      columns: ["club_id", "played_at"],
    },
    {
      name: "game_results_host_idx",
      table_name: "game_results",
      is_unique: false,
      predicate: null,
      columns: ["host_player_id", "played_at"],
    },
    {
      name: "game_results_pkey",
      table_name: "game_results",
      is_unique: true,
      predicate: null,
      columns: ["club_id", "game_id"],
    },
    {
      name: "game_rulesets_pkey",
      table_name: "game_rulesets",
      is_unique: true,
      predicate: null,
      columns: ["id", "version"],
    },
    {
      name: "game_session_creations_pkey",
      table_name: "game_session_creations",
      is_unique: true,
      predicate: null,
      columns: ["club_id", "creation_id"],
    },
    {
      name: "game_session_mutations_game_revision_unique",
      table_name: "game_session_mutations",
      is_unique: true,
      predicate: null,
      columns: ["club_id", "game_id", "revision"],
    },
    {
      name: "game_session_mutations_pkey",
      table_name: "game_session_mutations",
      is_unique: true,
      predicate: null,
      columns: ["club_id", "game_id", "mutation_id"],
    },
    {
      name: "game_session_players_club_history_player_idx",
      table_name: "game_session_players",
      is_unique: false,
      predicate: "(NOT is_host)",
      columns: ["club_id", "player_id", "game_id"],
    },
    {
      name: "game_session_players_game_seat_unique",
      table_name: "game_session_players",
      is_unique: true,
      predicate: null,
      columns: ["club_id", "game_id", "seat"],
    },
    {
      name: "game_session_players_pkey",
      table_name: "game_session_players",
      is_unique: true,
      predicate: null,
      columns: ["club_id", "game_id", "player_id"],
    },
    {
      name: "game_session_players_player_idx",
      table_name: "game_session_players",
      is_unique: false,
      predicate: null,
      columns: ["player_id", "game_id"],
    },
    {
      name: "game_sessions_club_active_updated_idx",
      table_name: "game_sessions",
      is_unique: false,
      predicate: "(status = 'active'::text)",
      columns: ["club_id", "updated_at", "id"],
    },
    {
      name: "game_sessions_club_head_idx",
      table_name: "game_sessions",
      is_unique: false,
      predicate: "(head_event_id IS NOT NULL)",
      columns: ["club_id", "head_event_id"],
    },
    {
      name: "game_sessions_pkey",
      table_name: "game_sessions",
      is_unique: true,
      predicate: null,
      columns: ["club_id", "id"],
    },
    {
      name: "game_tournaments_pkey",
      table_name: "game_tournaments",
      is_unique: true,
      predicate: null,
      columns: ["club_id", "game_id"],
    },
    {
      name: "players_access_provenance_unique",
      table_name: "players",
      is_unique: true,
      predicate: null,
      columns: ["id", "club_id", "user_id"],
    },
    {
      name: "players_club_access_email_unique_idx",
      table_name: "players",
      is_unique: true,
      predicate: "(club_access <> 'none'::text)",
      columns: ["club_id", "lower(btrim(email))"],
    },
    {
      name: "players_club_id_id_unique",
      table_name: "players",
      is_unique: true,
      predicate: null,
      columns: ["club_id", "id"],
    },
    {
      name: "players_club_last_played_nickname_idx",
      table_name: "players",
      is_unique: false,
      predicate: null,
      columns: ["club_id", "last_played_at", "nickname"],
    },
    {
      name: "players_club_linked_user_unique_idx",
      table_name: "players",
      is_unique: true,
      predicate: "(user_id IS NOT NULL)",
      columns: ["club_id", "user_id"],
    },
    {
      name: "players_club_nickname_unique_idx",
      table_name: "players",
      is_unique: true,
      predicate: "(retired_at IS NULL)",
      columns: ["club_id", "lower(btrim(nickname))"],
    },
    {
      name: "players_pkey",
      table_name: "players",
      is_unique: true,
      predicate: null,
      columns: ["id"],
    },
    {
      name: "tournaments_name_key_unique",
      table_name: "tournaments",
      is_unique: true,
      predicate: null,
      columns: ["club_id", "name_key"],
    },
    {
      name: "tournaments_pkey",
      table_name: "tournaments",
      is_unique: true,
      predicate: null,
      columns: ["club_id", "id"],
    },
    {
      name: "user_sessions_expiry_idx",
      table_name: "user_sessions",
      is_unique: false,
      predicate: null,
      columns: ["expires_at"],
    },
    {
      name: "user_sessions_pkey",
      table_name: "user_sessions",
      is_unique: true,
      predicate: null,
      columns: ["id"],
    },
    {
      name: "user_sessions_token_hash_key",
      table_name: "user_sessions",
      is_unique: true,
      predicate: null,
      columns: ["token_hash"],
    },
    {
      name: "users_email_key",
      table_name: "users",
      is_unique: true,
      predicate: null,
      columns: ["email"],
    },
    {
      name: "users_google_subject_unique_idx",
      table_name: "users",
      is_unique: true,
      predicate: null,
      columns: ["google_subject"],
    },
    {
      name: "users_pkey",
      table_name: "users",
      is_unique: true,
      predicate: null,
      columns: ["id"],
    },
    {
      name: "youtube_oauth_credentials_pkey",
      table_name: "youtube_oauth_credentials",
      is_unique: true,
      predicate: null,
      columns: ["user_id"],
    },
  ],
} as const;
