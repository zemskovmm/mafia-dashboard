CREATE TABLE IF NOT EXISTS users (
  id UUID NOT NULL,
  google_subject TEXT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  picture TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT users_pkey PRIMARY KEY (id),
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_email_check CHECK (BTRIM(email) <> ''),
  CONSTRAINT users_display_name_check CHECK (BTRIM(display_name) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS users_google_subject_unique_idx ON users (google_subject);

CREATE TABLE IF NOT EXISTS clubs (
  id UUID NOT NULL,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  header_logo TEXT NULL,
  card_logo TEXT NULL,
  language_code TEXT NOT NULL DEFAULT 'en',
  best_move_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT clubs_pkey PRIMARY KEY (id),
  CONSTRAINT clubs_name_check CHECK (BTRIM(name) <> ''),
  CONSTRAINT clubs_city_check CHECK (BTRIM(city) <> ''),
  CONSTRAINT clubs_language_code_ck CHECK (language_code IN ('en', 'ru')),
  CONSTRAINT clubs_created_by_fkey FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS deleted_clubs (
  club_id UUID NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT deleted_clubs_pkey PRIMARY KEY (club_id)
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id UUID NOT NULL,
  token_hash BYTEA NOT NULL,
  user_id UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT user_sessions_token_hash_key UNIQUE (token_hash),
  CONSTRAINT user_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS user_sessions_expiry_idx ON user_sessions (expires_at);

CREATE TABLE IF NOT EXISTS youtube_oauth_credentials (
  user_id UUID NOT NULL,
  singleton BOOLEAN NOT NULL DEFAULT TRUE,
  access_token_encrypted BYTEA NOT NULL,
  refresh_token_encrypted BYTEA NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  account_label TEXT NOT NULL,
  scope TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT youtube_oauth_credentials_pkey PRIMARY KEY (user_id),
  CONSTRAINT youtube_oauth_credentials_singleton_check CHECK (singleton),
  CONSTRAINT youtube_oauth_credentials_account_label_check CHECK (BTRIM(account_label) <> ''),
  CONSTRAINT youtube_oauth_credentials_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS game_rulesets (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  player_count INTEGER NOT NULL,
  sheriff_count INTEGER NOT NULL,
  citizen_count INTEGER NOT NULL,
  mafia_count INTEGER NOT NULL,
  don_count INTEGER NOT NULL,
  CONSTRAINT game_rulesets_pkey PRIMARY KEY (id, version),
  CONSTRAINT game_rulesets_id_check CHECK (BTRIM(id) <> ''),
  CONSTRAINT game_rulesets_version_check CHECK (version > 0),
  CONSTRAINT game_rulesets_player_count_check CHECK (player_count > 0),
  CONSTRAINT game_rulesets_sheriff_count_check CHECK (sheriff_count >= 0),
  CONSTRAINT game_rulesets_citizen_count_check CHECK (citizen_count >= 0),
  CONSTRAINT game_rulesets_mafia_count_check CHECK (mafia_count >= 0),
  CONSTRAINT game_rulesets_don_count_check CHECK (don_count >= 0),
  CONSTRAINT game_rulesets_role_count_ck
    CHECK (sheriff_count + citizen_count + mafia_count + don_count = player_count)
);

CREATE TABLE IF NOT EXISTS players (
  id UUID NOT NULL,
  club_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000101',
  nickname TEXT NULL,
  first_name TEXT NULL,
  last_name TEXT NULL,
  email TEXT NULL,
  data_processing_consent BOOLEAN NOT NULL DEFAULT FALSE,
  consent_at TIMESTAMPTZ NULL,
  club_access TEXT NOT NULL DEFAULT 'none',
  user_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_played_at TIMESTAMPTZ NULL,
  retired_at TIMESTAMPTZ NULL,
  CONSTRAINT players_pkey PRIMARY KEY (id),
  CONSTRAINT players_club_fk FOREIGN KEY (club_id) REFERENCES clubs (id) ON DELETE RESTRICT,
  CONSTRAINT players_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT players_nickname_check CHECK (
    (retired_at IS NULL AND nickname IS NOT NULL AND BTRIM(nickname) <> '')
    OR (retired_at IS NOT NULL AND nickname IS NULL AND first_name IS NULL
      AND last_name IS NULL AND email IS NULL AND user_id IS NULL
      AND club_access = 'none' AND NOT data_processing_consent AND consent_at IS NULL)
  ),
  CONSTRAINT players_check CHECK (
    (data_processing_consent = FALSE
      AND first_name IS NULL
      AND last_name IS NULL
      AND email IS NULL
      AND consent_at IS NULL)
    OR
    (data_processing_consent = TRUE
      AND first_name IS NOT NULL
      AND last_name IS NOT NULL
      AND email IS NOT NULL
      AND BTRIM(first_name) <> ''
      AND BTRIM(last_name) <> ''
      AND BTRIM(email) <> ''
      AND consent_at IS NOT NULL)
  ),
  CONSTRAINT players_access_requires_consent_ck
    CHECK (club_access = 'none' OR data_processing_consent OR user_id IS NOT NULL),
  CONSTRAINT players_club_access_ck CHECK (club_access IN ('none', 'user', 'manager')),
  CONSTRAINT players_club_id_id_unique UNIQUE (club_id, id),
  CONSTRAINT players_access_provenance_unique UNIQUE (id, club_id, user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS players_club_nickname_unique_idx
  ON players (club_id, LOWER(BTRIM(nickname))) WHERE retired_at IS NULL;
CREATE INDEX IF NOT EXISTS players_club_last_played_nickname_idx
  ON players (club_id, last_played_at DESC, nickname);
CREATE UNIQUE INDEX IF NOT EXISTS players_club_access_email_unique_idx
  ON players (club_id, LOWER(BTRIM(email)))
  WHERE club_access <> 'none';
CREATE UNIQUE INDEX IF NOT EXISTS players_club_linked_user_unique_idx
  ON players (club_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS club_memberships (
  club_id UUID NOT NULL,
  user_id UUID NOT NULL,
  role TEXT NOT NULL,
  access_player_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT club_memberships_pkey PRIMARY KEY (club_id, user_id),
  CONSTRAINT club_memberships_club_id_fkey FOREIGN KEY (club_id) REFERENCES clubs (id) ON DELETE CASCADE,
  CONSTRAINT club_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT club_memberships_role_ck CHECK (role IN ('manager', 'user')),
  CONSTRAINT club_memberships_access_player_fk
    FOREIGN KEY (access_player_id, club_id, user_id)
    REFERENCES players (id, club_id, user_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS club_memberships_access_player_unique_idx
  ON club_memberships (access_player_id)
  WHERE access_player_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS game_daily_counters (
  club_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000101',
  game_date DATE NOT NULL,
  last_number INTEGER NOT NULL,
  CONSTRAINT game_daily_counters_pkey PRIMARY KEY (club_id, game_date),
  CONSTRAINT game_daily_counters_club_fk FOREIGN KEY (club_id) REFERENCES clubs (id) ON DELETE CASCADE,
  CONSTRAINT game_daily_counters_last_number_check CHECK (last_number > 0)
);

CREATE TABLE IF NOT EXISTS game_sessions (
  id UUID NOT NULL,
  club_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000101',
  ruleset_id TEXT NOT NULL DEFAULT 'club-mafia',
  ruleset_version INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  revision INTEGER NOT NULL,
  last_mutation_id UUID NOT NULL,
  state JSONB NOT NULL,
  results JSONB NULL,
  status TEXT NOT NULL,
  initial_game JSONB NULL,
  replay_base_event_id UUID NULL,
  head_event_id UUID NULL,
  reset_return_event_id UUID NULL,
  reset_return_was_completed BOOLEAN NOT NULL DEFAULT FALSE,
  replay_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT game_sessions_pkey PRIMARY KEY (club_id, id),
  CONSTRAINT game_sessions_club_fk FOREIGN KEY (club_id) REFERENCES clubs (id) ON DELETE RESTRICT,
  CONSTRAINT game_sessions_ruleset_fk
    FOREIGN KEY (ruleset_id, ruleset_version) REFERENCES game_rulesets (id, version)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT game_sessions_name_check CHECK (BTRIM(name) <> ''),
  CONSTRAINT game_sessions_revision_check CHECK (revision > 0),
  CONSTRAINT game_sessions_status_check CHECK (status IN ('active', 'completed'))
);

-- Creation mappings intentionally survive game deletion so retried POSTs cannot resurrect a record.
CREATE TABLE IF NOT EXISTS game_session_creations (
  club_id UUID NOT NULL,
  creation_id UUID NOT NULL,
  game_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT game_session_creations_pkey PRIMARY KEY (club_id, creation_id),
  CONSTRAINT game_session_creations_club_fk
    FOREIGN KEY (club_id) REFERENCES clubs (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS game_sessions_club_active_updated_idx
  ON game_sessions (club_id, updated_at DESC, id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS game_sessions_club_head_idx
  ON game_sessions (club_id, head_event_id)
  WHERE head_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS game_session_mutations (
  club_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000101',
  game_id UUID NOT NULL,
  mutation_id UUID NOT NULL,
  revision INTEGER NOT NULL,
  request JSONB NULL,
  CONSTRAINT game_session_mutations_pkey PRIMARY KEY (club_id, game_id, mutation_id),
  CONSTRAINT game_session_mutations_game_revision_unique UNIQUE (club_id, game_id, revision),
  CONSTRAINT game_session_mutations_revision_check CHECK (revision > 0),
  CONSTRAINT game_session_mutations_game_fk
    FOREIGN KEY (club_id, game_id) REFERENCES game_sessions (club_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS game_session_players (
  club_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000101',
  game_id UUID NOT NULL,
  player_id UUID NOT NULL,
  seat INTEGER NULL,
  is_host BOOLEAN NOT NULL,
  role TEXT NULL,
  CONSTRAINT game_session_players_pkey PRIMARY KEY (club_id, game_id, player_id),
  CONSTRAINT game_session_players_game_seat_unique UNIQUE (club_id, game_id, seat),
  CONSTRAINT game_session_players_game_fk
    FOREIGN KEY (club_id, game_id) REFERENCES game_sessions (club_id, id) ON DELETE CASCADE,
  CONSTRAINT game_session_players_player_fk
    FOREIGN KEY (club_id, player_id) REFERENCES players (club_id, id) ON DELETE RESTRICT,
  CONSTRAINT game_session_players_seat_check CHECK (seat BETWEEN 1 AND 10),
  CONSTRAINT game_session_players_role_ck CHECK (role IS NULL OR role IN ('sheriff', 'citizen', 'mafia', 'don')),
  CONSTRAINT game_session_players_shape_ck
    CHECK ((is_host AND seat IS NULL AND role IS NULL) OR (NOT is_host AND seat IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS game_session_players_player_idx ON game_session_players (player_id, game_id);
CREATE INDEX IF NOT EXISTS game_session_players_club_history_player_idx
  ON game_session_players (club_id, player_id, game_id)
  WHERE NOT is_host;

CREATE TABLE IF NOT EXISTS game_results (
  game_id UUID NOT NULL,
  club_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000101',
  outcome TEXT NOT NULL,
  winner TEXT NULL,
  reason TEXT NULL,
  played_at TIMESTAMPTZ NOT NULL,
  host_player_id UUID NULL,
  CONSTRAINT game_results_pkey PRIMARY KEY (club_id, game_id),
  CONSTRAINT game_results_club_fk FOREIGN KEY (club_id) REFERENCES clubs (id) ON DELETE RESTRICT,
  CONSTRAINT game_results_outcome_ck CHECK (outcome IN ('red', 'black', 'draw', 'cancelled')),
  CONSTRAINT game_results_shape_ck CHECK (
    (outcome IN ('red', 'black') AND winner IS NOT NULL AND winner = outcome AND reason IS NULL)
    OR
    (outcome IN ('draw', 'cancelled')
      AND winner IS NULL
      AND reason IS NOT NULL
      AND reason = BTRIM(reason)
      AND BTRIM(reason) <> ''
      AND LENGTH(reason) <= 500)
  ),
  CONSTRAINT game_results_host_player_fk
    FOREIGN KEY (club_id, host_player_id) REFERENCES players (club_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS game_results_club_played_idx ON game_results (club_id, played_at DESC);
CREATE INDEX IF NOT EXISTS game_results_club_outcome_played_idx ON game_results (club_id, outcome, played_at DESC);
CREATE INDEX IF NOT EXISTS game_results_host_idx ON game_results (host_player_id, played_at DESC);

CREATE TABLE IF NOT EXISTS game_player_results (
  club_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000101',
  game_id UUID NOT NULL,
  player_id UUID NOT NULL,
  seat INTEGER NOT NULL,
  role TEXT NOT NULL,
  team TEXT NOT NULL,
  final_status TEXT NOT NULL,
  fouls INTEGER NOT NULL,
  won BOOLEAN NULL,
  best_move_hits INTEGER NULL,
  CONSTRAINT game_player_results_pkey PRIMARY KEY (club_id, game_id, player_id),
  CONSTRAINT game_player_results_game_seat_unique UNIQUE (club_id, game_id, seat),
  CONSTRAINT game_player_results_game_fk
    FOREIGN KEY (club_id, game_id) REFERENCES game_results (club_id, game_id) ON DELETE CASCADE,
  CONSTRAINT game_player_results_player_fk
    FOREIGN KEY (club_id, player_id) REFERENCES players (club_id, id) ON DELETE RESTRICT,
  CONSTRAINT game_player_results_seat_check CHECK (seat BETWEEN 1 AND 10),
  CONSTRAINT game_player_results_role_check CHECK (role IN ('sheriff', 'citizen', 'mafia', 'don')),
  CONSTRAINT game_player_results_team_check CHECK (team IN ('red', 'black')),
  CONSTRAINT game_player_results_final_status_check CHECK (final_status IN ('active', 'eliminated', 'red-carded')),
  CONSTRAINT game_player_results_fouls_check CHECK (fouls >= 0),
  CONSTRAINT game_player_results_best_move_hits_check CHECK (best_move_hits BETWEEN 0 AND 3)
);

CREATE INDEX IF NOT EXISTS game_player_results_player_idx ON game_player_results (player_id, game_id);

CREATE TABLE IF NOT EXISTS deleted_games (
  game_id UUID NOT NULL,
  club_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000101',
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT deleted_games_pkey PRIMARY KEY (club_id, game_id),
  CONSTRAINT deleted_games_club_fk FOREIGN KEY (club_id) REFERENCES clubs (id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS game_events (
  id UUID NOT NULL,
  club_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000101',
  game_id UUID NOT NULL,
  sequence INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  phase TEXT NOT NULL,
  seat INTEGER NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  parent_event_id UUID NULL,
  replay_version INTEGER NOT NULL DEFAULT 1,
  replay_sequence INTEGER NULL,
  phase_after TEXT NULL,
  day_before INTEGER NULL,
  day_after INTEGER NULL,
  state_hash_after TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT game_events_pkey PRIMARY KEY (club_id, id),
  CONSTRAINT game_events_club_fk FOREIGN KEY (club_id) REFERENCES clubs (id) ON DELETE RESTRICT,
  CONSTRAINT game_events_club_game_sequence_unique UNIQUE (club_id, game_id, sequence),
  CONSTRAINT game_events_club_game_idempotency_unique UNIQUE (club_id, game_id, idempotency_key),
  CONSTRAINT game_events_club_game_event_unique UNIQUE (club_id, game_id, id),
  CONSTRAINT game_events_sequence_check CHECK (sequence > 0),
  CONSTRAINT game_events_seat_check CHECK (seat BETWEEN 1 AND 10),
  CONSTRAINT game_events_replay_sequence_positive_ck CHECK (replay_sequence > 0),
  CONSTRAINT game_events_day_before_nonnegative_ck CHECK (day_before >= 0),
  CONSTRAINT game_events_day_after_nonnegative_ck CHECK (day_after >= 0),
  CONSTRAINT game_events_replay_metadata_ck CHECK (
    replay_sequence IS NULL
    OR (
      replay_version = 1
      AND phase_after IS NOT NULL
      AND day_before IS NOT NULL
      AND day_after IS NOT NULL
      AND state_hash_after ~ '^sha256:[0-9a-f]{64}$'
    )
  )
);

CREATE INDEX IF NOT EXISTS game_events_game_parent_idx ON game_events (game_id, parent_event_id);
CREATE INDEX IF NOT EXISTS game_events_club_game_parent_idx ON game_events (club_id, game_id, parent_event_id);
CREATE UNIQUE INDEX IF NOT EXISTS game_events_club_game_replay_sequence_idx
  ON game_events (club_id, game_id, replay_sequence)
  WHERE replay_sequence IS NOT NULL;

INSERT INTO users (id, email, display_name)
VALUES ('00000000-0000-4000-8000-000000000001', 'owner@mafiamalaga.es', 'Mafia Malaga owner')
ON CONFLICT (id) DO NOTHING;

INSERT INTO clubs (id, name, city, created_by)
SELECT
  '00000000-0000-4000-8000-000000000101',
  'Mafia Malaga',
  'Málaga',
  '00000000-0000-4000-8000-000000000001'
WHERE NOT EXISTS (
  SELECT 1
    FROM deleted_clubs
   WHERE club_id = '00000000-0000-4000-8000-000000000101'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO club_memberships (club_id, user_id, role)
SELECT
  '00000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000001',
  'manager'
WHERE EXISTS (
  SELECT 1
    FROM clubs
   WHERE id = '00000000-0000-4000-8000-000000000101'
)
ON CONFLICT (club_id, user_id) DO NOTHING;

INSERT INTO players (id, club_id, nickname, club_access, user_id)
SELECT
  (
    SUBSTRING(owner_id.hex FROM 1 FOR 8) || '-' ||
    SUBSTRING(owner_id.hex FROM 9 FOR 4) || '-4' ||
    SUBSTRING(owner_id.hex FROM 14 FOR 3) || '-a' ||
    SUBSTRING(owner_id.hex FROM 18 FOR 3) || '-' ||
    SUBSTRING(owner_id.hex FROM 21 FOR 12)
  )::UUID,
  club.id,
  'Owner',
  'manager',
  club.created_by
FROM clubs AS club
CROSS JOIN LATERAL (SELECT md5('club-owner-player:' || club.id::TEXT) AS hex) AS owner_id
WHERE club.id = '00000000-0000-4000-8000-000000000101'
  AND NOT EXISTS (
    SELECT 1
      FROM players AS manager
     WHERE manager.club_id = club.id
       AND manager.club_access = 'manager'
       AND manager.user_id = club.created_by
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO game_rulesets
  (id, version, player_count, sheriff_count, citizen_count, mafia_count, don_count)
VALUES ('club-mafia', 1, 10, 1, 6, 2, 1)
ON CONFLICT (id, version) DO NOTHING;