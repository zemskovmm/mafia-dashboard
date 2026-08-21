DO $$
BEGIN
  IF to_regclass('public.mock_users') IS NOT NULL AND to_regclass('public.users') IS NULL THEN
    ALTER TABLE mock_users RENAME TO users;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  google_subject TEXT NULL,
  email TEXT NOT NULL UNIQUE CHECK (BTRIM(email) <> ''),
  display_name TEXT NOT NULL CHECK (BTRIM(display_name) <> ''),
  picture TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS google_subject TEXT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
DROP INDEX IF EXISTS users_google_subject_unique_idx;
CREATE UNIQUE INDEX users_google_subject_unique_idx ON users (google_subject);

CREATE TABLE IF NOT EXISTS user_sessions (
  id UUID PRIMARY KEY,
  token_hash BYTEA NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS user_sessions_expiry_idx ON user_sessions (expires_at);

CREATE TABLE IF NOT EXISTS clubs (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL CHECK (BTRIM(name) <> ''),
  city TEXT NOT NULL CHECK (BTRIM(city) <> ''),
  header_logo TEXT NULL,
  card_logo TEXT NULL,
  created_by UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS club_memberships (
  club_id UUID NOT NULL REFERENCES clubs (id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (club_id, user_id)
);

CREATE TABLE IF NOT EXISTS deleted_clubs (
  club_id UUID PRIMARY KEY,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
  SELECT 1 FROM deleted_clubs
   WHERE club_id = '00000000-0000-4000-8000-000000000101'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO club_memberships (club_id, user_id, role)
SELECT
  '00000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000001',
  'owner'
WHERE EXISTS (
  SELECT 1 FROM clubs
   WHERE id = '00000000-0000-4000-8000-000000000101'
)
ON CONFLICT (club_id, user_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS game_events (
  id UUID PRIMARY KEY,
  club_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000101' CONSTRAINT game_events_club_fk REFERENCES clubs (id) ON DELETE RESTRICT,
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

ALTER TABLE game_events ADD COLUMN IF NOT EXISTS club_id UUID;
UPDATE game_events
   SET club_id = '00000000-0000-4000-8000-000000000101'
 WHERE club_id IS NULL;
ALTER TABLE game_events ALTER COLUMN club_id SET NOT NULL;
ALTER TABLE game_events ALTER COLUMN club_id SET DEFAULT '00000000-0000-4000-8000-000000000101';

CREATE INDEX IF NOT EXISTS game_events_club_game_sequence_idx
  ON game_events (club_id, game_id, sequence);

CREATE TABLE IF NOT EXISTS deleted_games (
  game_id UUID PRIMARY KEY,
  club_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000101' CONSTRAINT deleted_games_club_fk REFERENCES clubs (id) ON DELETE RESTRICT,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE deleted_games ADD COLUMN IF NOT EXISTS club_id UUID;
UPDATE deleted_games
   SET club_id = '00000000-0000-4000-8000-000000000101'
 WHERE club_id IS NULL;
ALTER TABLE deleted_games ALTER COLUMN club_id SET NOT NULL;
ALTER TABLE deleted_games ALTER COLUMN club_id SET DEFAULT '00000000-0000-4000-8000-000000000101';

CREATE TABLE IF NOT EXISTS game_daily_counters (
  club_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000101' CONSTRAINT game_daily_counters_club_fk REFERENCES clubs (id) ON DELETE CASCADE,
  game_date DATE NOT NULL,
  last_number INTEGER NOT NULL CHECK (last_number > 0),
  PRIMARY KEY (club_id, game_date)
);

ALTER TABLE game_daily_counters ADD COLUMN IF NOT EXISTS club_id UUID;
UPDATE game_daily_counters
   SET club_id = '00000000-0000-4000-8000-000000000101'
 WHERE club_id IS NULL;
ALTER TABLE game_daily_counters ALTER COLUMN club_id SET NOT NULL;
ALTER TABLE game_daily_counters ALTER COLUMN club_id SET DEFAULT '00000000-0000-4000-8000-000000000101';
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'game_daily_counters'::regclass
       AND contype = 'p'
       AND array_length(conkey, 1) = 1
  ) THEN
    ALTER TABLE game_daily_counters DROP CONSTRAINT game_daily_counters_pkey;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'game_daily_counters'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE game_daily_counters ADD PRIMARY KEY (club_id, game_date);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS game_sessions (
  id UUID PRIMARY KEY,
  club_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000101' CONSTRAINT game_sessions_club_fk REFERENCES clubs (id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (BTRIM(name) <> ''),
  revision INTEGER NOT NULL CHECK (revision > 0),
  last_mutation_id UUID NOT NULL,
  state JSONB NOT NULL,
  results JSONB NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS results JSONB NULL;
ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS club_id UUID;
UPDATE game_sessions
   SET club_id = '00000000-0000-4000-8000-000000000101'
 WHERE club_id IS NULL;
ALTER TABLE game_sessions ALTER COLUMN club_id SET NOT NULL;
ALTER TABLE game_sessions ALTER COLUMN club_id SET DEFAULT '00000000-0000-4000-8000-000000000101';

CREATE INDEX IF NOT EXISTS game_sessions_club_active_updated_idx
  ON game_sessions (club_id, updated_at DESC, id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS game_session_mutations (
  game_id UUID NOT NULL REFERENCES game_sessions (id) ON DELETE CASCADE,
  mutation_id UUID NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  request JSONB NULL,
  PRIMARY KEY (game_id, mutation_id),
  UNIQUE (game_id, revision)
);

ALTER TABLE game_session_mutations ADD COLUMN IF NOT EXISTS request JSONB NULL;

CREATE TABLE IF NOT EXISTS players (
  id UUID PRIMARY KEY,
  club_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000101' CONSTRAINT players_club_fk REFERENCES clubs (id) ON DELETE RESTRICT,
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

ALTER TABLE players ADD COLUMN IF NOT EXISTS club_id UUID;
UPDATE players
   SET club_id = '00000000-0000-4000-8000-000000000101'
 WHERE club_id IS NULL;
ALTER TABLE players ALTER COLUMN club_id SET NOT NULL;
ALTER TABLE players ALTER COLUMN club_id SET DEFAULT '00000000-0000-4000-8000-000000000101';
DROP INDEX IF EXISTS players_nickname_unique_idx;
CREATE UNIQUE INDEX IF NOT EXISTS players_club_nickname_unique_idx
  ON players (club_id, LOWER(BTRIM(nickname)));
CREATE INDEX IF NOT EXISTS players_club_last_played_nickname_idx
  ON players (club_id, last_played_at DESC, nickname);

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
  club_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000101' CONSTRAINT game_results_club_fk REFERENCES clubs (id) ON DELETE RESTRICT,
  winner TEXT NOT NULL CHECK (winner IN ('red', 'black')),
  played_at TIMESTAMPTZ NOT NULL,
  host_player_id UUID NULL REFERENCES players (id) ON DELETE RESTRICT
);

ALTER TABLE game_results ADD COLUMN IF NOT EXISTS host_player_id UUID NULL REFERENCES players (id) ON DELETE RESTRICT;
ALTER TABLE game_results ADD COLUMN IF NOT EXISTS club_id UUID;
UPDATE game_results
   SET club_id = '00000000-0000-4000-8000-000000000101'
 WHERE club_id IS NULL;
ALTER TABLE game_results ALTER COLUMN club_id SET NOT NULL;
ALTER TABLE game_results ALTER COLUMN club_id SET DEFAULT '00000000-0000-4000-8000-000000000101';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'game_events_club_fk') THEN
    ALTER TABLE game_events
      ADD CONSTRAINT game_events_club_fk FOREIGN KEY (club_id) REFERENCES clubs (id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deleted_games_club_fk') THEN
    ALTER TABLE deleted_games
      ADD CONSTRAINT deleted_games_club_fk FOREIGN KEY (club_id) REFERENCES clubs (id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'game_daily_counters_club_fk') THEN
    ALTER TABLE game_daily_counters
      ADD CONSTRAINT game_daily_counters_club_fk FOREIGN KEY (club_id) REFERENCES clubs (id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'game_sessions_club_fk') THEN
    ALTER TABLE game_sessions
      ADD CONSTRAINT game_sessions_club_fk FOREIGN KEY (club_id) REFERENCES clubs (id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'players_club_fk') THEN
    ALTER TABLE players
      ADD CONSTRAINT players_club_fk FOREIGN KEY (club_id) REFERENCES clubs (id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'game_results_club_fk') THEN
    ALTER TABLE game_results
      ADD CONSTRAINT game_results_club_fk FOREIGN KEY (club_id) REFERENCES clubs (id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS game_results_club_played_idx
  ON game_results (club_id, played_at DESC);
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

ALTER TABLE game_player_results
  ADD COLUMN IF NOT EXISTS best_move_hits INTEGER NULL CHECK (best_move_hits BETWEEN 0 AND 3);

CREATE INDEX IF NOT EXISTS game_player_results_player_idx
  ON game_player_results (player_id, game_id);

CREATE TABLE IF NOT EXISTS youtube_oauth_credentials (
  user_id UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  singleton BOOLEAN NOT NULL DEFAULT TRUE CHECK (singleton),
  access_token_encrypted BYTEA NOT NULL,
  refresh_token_encrypted BYTEA NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  account_label TEXT NOT NULL CHECK (BTRIM(account_label) <> ''),
  scope TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE youtube_oauth_credentials
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users (id) ON DELETE CASCADE;
UPDATE youtube_oauth_credentials
   SET user_id = '00000000-0000-4000-8000-000000000001'
 WHERE user_id IS NULL;
ALTER TABLE youtube_oauth_credentials ALTER COLUMN user_id SET NOT NULL;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'youtube_oauth_credentials'::regclass
       AND contype = 'p'
       AND pg_get_constraintdef(oid) NOT LIKE '%(user_id)%'
  ) THEN
    ALTER TABLE youtube_oauth_credentials DROP CONSTRAINT youtube_oauth_credentials_pkey;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'youtube_oauth_credentials'::regclass
       AND contype = 'p'
  ) THEN
    ALTER TABLE youtube_oauth_credentials ADD PRIMARY KEY (user_id);
  END IF;
END $$;
