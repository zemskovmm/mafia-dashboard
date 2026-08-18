CREATE TABLE IF NOT EXISTS game_events (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  idempotency_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  phase TEXT NOT NULL,
  seat INTEGER NULL CHECK (seat BETWEEN 1 AND 10),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  secret BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (game_id, sequence),
  UNIQUE (game_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS game_events_game_sequence_idx
  ON game_events (game_id, sequence);

CREATE TABLE IF NOT EXISTS deleted_games (
  game_id UUID PRIMARY KEY,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS game_sessions (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL CHECK (BTRIM(name) <> ''),
  revision INTEGER NOT NULL CHECK (revision > 0),
  last_mutation_id UUID NOT NULL,
  state JSONB NOT NULL,
  results JSONB NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE game_sessions
  ADD COLUMN IF NOT EXISTS results JSONB NULL;

CREATE INDEX IF NOT EXISTS game_sessions_active_updated_idx
  ON game_sessions (updated_at DESC, id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS game_session_mutations (
  game_id UUID NOT NULL REFERENCES game_sessions (id) ON DELETE CASCADE,
  mutation_id UUID NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  request JSONB NULL,
  PRIMARY KEY (game_id, mutation_id),
  UNIQUE (game_id, revision)
);

ALTER TABLE game_session_mutations
  ADD COLUMN IF NOT EXISTS request JSONB NULL;

CREATE TABLE IF NOT EXISTS players (
  id UUID PRIMARY KEY,
  nickname TEXT NOT NULL CHECK (BTRIM(nickname) <> ''),
  first_name TEXT NULL,
  last_name TEXT NULL,
  email TEXT NULL,
  data_processing_consent BOOLEAN NOT NULL DEFAULT FALSE,
  consent_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_played_at TIMESTAMPTZ NULL,
  CHECK (
    (
      data_processing_consent = FALSE
      AND first_name IS NULL
      AND last_name IS NULL
      AND email IS NULL
      AND consent_at IS NULL
    )
    OR
    (
      data_processing_consent = TRUE
      AND first_name IS NOT NULL
      AND last_name IS NOT NULL
      AND email IS NOT NULL
      AND BTRIM(first_name) <> ''
      AND BTRIM(last_name) <> ''
      AND BTRIM(email) <> ''
      AND consent_at IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS players_nickname_unique_idx
  ON players (LOWER(BTRIM(nickname)));

CREATE INDEX IF NOT EXISTS players_last_played_nickname_idx
  ON players (last_played_at DESC, nickname);

CREATE TABLE IF NOT EXISTS game_session_players (
  game_id UUID NOT NULL REFERENCES game_sessions (id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players (id) ON DELETE RESTRICT,
  seat INTEGER NULL CHECK (seat BETWEEN 1 AND 10),
  is_host BOOLEAN NOT NULL,
  PRIMARY KEY (game_id, player_id),
  UNIQUE (game_id, seat),
  CHECK ((is_host AND seat IS NULL) OR (NOT is_host AND seat IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS game_session_players_player_idx
  ON game_session_players (player_id, game_id);

CREATE TABLE IF NOT EXISTS game_results (
  game_id UUID PRIMARY KEY,
  winner TEXT NOT NULL CHECK (winner IN ('red', 'black')),
  played_at TIMESTAMPTZ NOT NULL,
  host_player_id UUID NULL REFERENCES players (id) ON DELETE RESTRICT
);

ALTER TABLE game_results
  ADD COLUMN IF NOT EXISTS host_player_id UUID NULL REFERENCES players (id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS game_results_host_idx
  ON game_results (host_player_id, played_at DESC);

CREATE TABLE IF NOT EXISTS game_player_results (
  game_id UUID NOT NULL REFERENCES game_results (game_id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players (id) ON DELETE RESTRICT,
  seat INTEGER NOT NULL CHECK (seat BETWEEN 1 AND 10),
  role TEXT NOT NULL CHECK (role IN ('sheriff', 'citizen', 'mafia', 'don')),
  team TEXT NOT NULL CHECK (team IN ('red', 'black')),
  final_status TEXT NOT NULL CHECK (final_status IN ('active', 'eliminated', 'red-carded')),
  fouls INTEGER NOT NULL CHECK (fouls >= 0),
  won BOOLEAN NOT NULL,
  PRIMARY KEY (game_id, player_id),
  UNIQUE (game_id, seat)
);

CREATE INDEX IF NOT EXISTS game_player_results_player_idx
  ON game_player_results (player_id, game_id);

CREATE TABLE IF NOT EXISTS youtube_oauth_credentials (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  access_token_encrypted BYTEA NOT NULL,
  refresh_token_encrypted BYTEA NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  account_label TEXT NOT NULL CHECK (BTRIM(account_label) <> ''),
  scope TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS music_tracks (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL CHECK (BTRIM(title) <> ''),
  original_filename TEXT NOT NULL CHECK (BTRIM(original_filename) <> ''),
  storage_filename TEXT NOT NULL UNIQUE CHECK (BTRIM(storage_filename) <> ''),
  mime_type TEXT NOT NULL CHECK (mime_type LIKE 'audio/%'),
  duration_seconds DOUBLE PRECISION NOT NULL CHECK (duration_seconds > 0),
  waveform JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS music_tracks_created_idx
  ON music_tracks (created_at, title);
