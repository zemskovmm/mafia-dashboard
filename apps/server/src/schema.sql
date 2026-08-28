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
  language_code TEXT NOT NULL DEFAULT 'en' CONSTRAINT clubs_language_code_ck CHECK (language_code IN ('en', 'ru')),
  created_by UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE clubs ADD COLUMN IF NOT EXISTS language_code TEXT NOT NULL DEFAULT 'en';
UPDATE clubs SET language_code = 'en' WHERE language_code IS NULL;
ALTER TABLE clubs ALTER COLUMN language_code SET DEFAULT 'en';
ALTER TABLE clubs ALTER COLUMN language_code SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'clubs'::REGCLASS
       AND conname = 'clubs_language_code_ck'
  ) THEN
    ALTER TABLE clubs
      ADD CONSTRAINT clubs_language_code_ck CHECK (language_code IN ('en', 'ru'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS club_memberships (
  club_id UUID NOT NULL REFERENCES clubs (id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor')),
  manager_player_id UUID NULL,
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
  id UUID NOT NULL,
  club_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000101' CONSTRAINT game_events_club_fk REFERENCES clubs (id) ON DELETE RESTRICT,
  game_id UUID NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  idempotency_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  phase TEXT NOT NULL,
  seat INTEGER NULL CHECK (seat BETWEEN 1 AND 10),
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
  CONSTRAINT game_events_club_game_sequence_unique UNIQUE (club_id, game_id, sequence),
  CONSTRAINT game_events_club_game_idempotency_unique UNIQUE (club_id, game_id, idempotency_key)
);

ALTER TABLE game_events ADD COLUMN IF NOT EXISTS club_id UUID;
ALTER TABLE game_events ADD COLUMN IF NOT EXISTS parent_event_id UUID NULL;
ALTER TABLE game_events ADD COLUMN IF NOT EXISTS replay_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE game_events ADD COLUMN IF NOT EXISTS replay_sequence INTEGER NULL;
ALTER TABLE game_events ADD COLUMN IF NOT EXISTS phase_after TEXT NULL;
ALTER TABLE game_events ADD COLUMN IF NOT EXISTS day_before INTEGER NULL;
ALTER TABLE game_events ADD COLUMN IF NOT EXISTS day_after INTEGER NULL;
ALTER TABLE game_events ADD COLUMN IF NOT EXISTS state_hash_after TEXT NULL;
ALTER TABLE game_events DROP CONSTRAINT IF EXISTS game_events_replay_sequence_check;
ALTER TABLE game_events DROP CONSTRAINT IF EXISTS game_events_day_before_check;
ALTER TABLE game_events DROP CONSTRAINT IF EXISTS game_events_day_after_check;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'game_events'::REGCLASS
       AND conname = 'game_events_replay_sequence_positive_ck'
  ) THEN
    ALTER TABLE game_events
      ADD CONSTRAINT game_events_replay_sequence_positive_ck
      CHECK (replay_sequence > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'game_events'::REGCLASS
       AND conname = 'game_events_day_before_nonnegative_ck'
  ) THEN
    ALTER TABLE game_events
      ADD CONSTRAINT game_events_day_before_nonnegative_ck
      CHECK (day_before >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'game_events'::REGCLASS
       AND conname = 'game_events_day_after_nonnegative_ck'
  ) THEN
    ALTER TABLE game_events
      ADD CONSTRAINT game_events_day_after_nonnegative_ck
      CHECK (day_after >= 0);
  END IF;
END $$;
ALTER TABLE game_events DROP COLUMN IF EXISTS secret;
UPDATE game_events
   SET club_id = '00000000-0000-4000-8000-000000000101'
 WHERE club_id IS NULL;
ALTER TABLE game_events ALTER COLUMN club_id SET NOT NULL;
ALTER TABLE game_events ALTER COLUMN club_id SET DEFAULT '00000000-0000-4000-8000-000000000101';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'game_events'::REGCLASS
       AND conname = 'game_events_pkey'
       AND pg_get_constraintdef(oid) = 'PRIMARY KEY (id)'
  ) THEN
    ALTER TABLE game_events DROP CONSTRAINT game_events_pkey;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'game_events'::REGCLASS
       AND conname = 'game_events_pkey'
  ) THEN
    ALTER TABLE game_events ADD CONSTRAINT game_events_pkey PRIMARY KEY (club_id, id);
  END IF;
END $$;

ALTER TABLE game_events DROP CONSTRAINT IF EXISTS game_events_game_id_sequence_key;
ALTER TABLE game_events DROP CONSTRAINT IF EXISTS game_events_game_id_idempotency_key_key;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'game_events'::REGCLASS
       AND conname = 'game_events_club_game_sequence_unique'
  ) THEN
    ALTER TABLE game_events
      ADD CONSTRAINT game_events_club_game_sequence_unique
      UNIQUE (club_id, game_id, sequence);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'game_events'::REGCLASS
       AND conname = 'game_events_club_game_idempotency_unique'
  ) THEN
    ALTER TABLE game_events
      ADD CONSTRAINT game_events_club_game_idempotency_unique
      UNIQUE (club_id, game_id, idempotency_key);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS game_events_club_game_sequence_idx
  ON game_events (club_id, game_id, sequence);
CREATE INDEX IF NOT EXISTS game_events_game_parent_idx
  ON game_events (game_id, parent_event_id);
CREATE INDEX IF NOT EXISTS game_events_club_game_parent_idx
  ON game_events (club_id, game_id, parent_event_id);

CREATE TABLE IF NOT EXISTS deleted_games (
  game_id UUID NOT NULL,
  club_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000101' CONSTRAINT deleted_games_club_fk REFERENCES clubs (id) ON DELETE RESTRICT,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT deleted_games_pkey PRIMARY KEY (club_id, game_id)
);

ALTER TABLE deleted_games ADD COLUMN IF NOT EXISTS club_id UUID;
UPDATE deleted_games
   SET club_id = '00000000-0000-4000-8000-000000000101'
 WHERE club_id IS NULL;
ALTER TABLE deleted_games ALTER COLUMN club_id SET NOT NULL;
ALTER TABLE deleted_games ALTER COLUMN club_id SET DEFAULT '00000000-0000-4000-8000-000000000101';
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'deleted_games'::regclass
       AND contype = 'p'
       AND array_length(conkey, 1) = 1
  ) THEN
    ALTER TABLE deleted_games DROP CONSTRAINT deleted_games_pkey;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'deleted_games'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE deleted_games
      ADD CONSTRAINT deleted_games_pkey PRIMARY KEY (club_id, game_id);
  END IF;
END $$;

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
  id UUID NOT NULL,
  club_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000101' CONSTRAINT game_sessions_club_fk REFERENCES clubs (id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (BTRIM(name) <> ''),
  revision INTEGER NOT NULL CHECK (revision > 0),
  last_mutation_id UUID NOT NULL,
  state JSONB NOT NULL,
  results JSONB NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed')),
  initial_game JSONB NULL,
  replay_base_event_id UUID NULL,
  head_event_id UUID NULL,
  reset_return_event_id UUID NULL,
  reset_return_was_completed BOOLEAN NOT NULL DEFAULT FALSE,
  replay_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT game_sessions_pkey PRIMARY KEY (club_id, id)
);

ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS results JSONB NULL;
ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS initial_game JSONB NULL;
ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS replay_base_event_id UUID NULL;
ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS head_event_id UUID NULL;
ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS reset_return_event_id UUID NULL;
ALTER TABLE game_sessions
  ADD COLUMN IF NOT EXISTS reset_return_was_completed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS replay_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS club_id UUID;
UPDATE game_sessions
   SET club_id = '00000000-0000-4000-8000-000000000101'
 WHERE club_id IS NULL;
ALTER TABLE game_sessions ALTER COLUMN club_id SET NOT NULL;
ALTER TABLE game_sessions ALTER COLUMN club_id SET DEFAULT '00000000-0000-4000-8000-000000000101';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'game_events'::REGCLASS
       AND conname = 'game_events_replay_metadata_ck'
       AND pg_get_constraintdef(oid) NOT LIKE '%[0-9a-f]{8}%'
  ) THEN
    ALTER TABLE game_events DROP CONSTRAINT game_events_replay_metadata_ck;
  END IF;
END $$;

UPDATE game_sessions
   SET initial_game = CASE
         WHEN initial_game IS NULL AND jsonb_typeof(state -> 'initialGame') = 'object'
           THEN state -> 'initialGame'
         ELSE initial_game
       END,
       head_event_id = CASE
         WHEN head_event_id IS NULL
          AND state ->> 'headEventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           THEN (state ->> 'headEventId')::UUID
         ELSE head_event_id
       END,
       reset_return_event_id = CASE
         WHEN reset_return_event_id IS NULL
          AND state ->> 'resetReturnEventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           THEN (state ->> 'resetReturnEventId')::UUID
         ELSE reset_return_event_id
       END
 WHERE (initial_game IS NULL AND jsonb_typeof(state -> 'initialGame') = 'object')
    OR (head_event_id IS NULL AND state ->> 'headEventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    OR (reset_return_event_id IS NULL AND state ->> 'resetReturnEventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

WITH stored_events AS MATERIALIZED (
  SELECT session.club_id, session.id AS game_id, stored.event_data
    FROM game_sessions AS session
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(session.state -> 'events') = 'array' THEN session.state -> 'events'
        ELSE '[]'::JSONB
      END
    ) AS stored(event_data)
   WHERE stored.event_data ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND stored.event_data ->> 'gameId' = session.id::TEXT
)
UPDATE game_events AS event
   SET replay_sequence = COALESCE(
         event.replay_sequence,
         CASE
           WHEN stored.event_data ->> 'sequence' ~ '^[1-9][0-9]*$'
             THEN (stored.event_data ->> 'sequence')::INTEGER
         END
       ),
       parent_event_id = COALESCE(
         event.parent_event_id,
         CASE
           WHEN stored.event_data ->> 'parentEventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             THEN (stored.event_data ->> 'parentEventId')::UUID
         END
       ),
       replay_version = CASE
         WHEN stored.event_data ->> 'replayVersion' = '1' THEN 1
         ELSE event.replay_version
       END,
       phase = CASE
         WHEN stored.event_data ->> 'phaseBefore' IN (
           'mafia-planning', 'sheriff-wake', 'day', 'voting', 'voting-cancelled',
           'car-crash', 'car-crash-decision', 'car-crash-skipped', 'goodbye-speech',
           'best-move', 'night-mafia', 'night-mafia-result', 'night-don',
           'night-don-result', 'night-sheriff', 'night-sheriff-result',
           'night-resolution', 'finished'
         ) THEN stored.event_data ->> 'phaseBefore'
         ELSE event.phase
       END,
       phase_after = COALESCE(
         event.phase_after,
         CASE
           WHEN stored.event_data ->> 'phaseAfter' IN (
             'mafia-planning', 'sheriff-wake', 'day', 'voting', 'voting-cancelled',
             'car-crash', 'car-crash-decision', 'car-crash-skipped', 'goodbye-speech',
             'best-move', 'night-mafia', 'night-mafia-result', 'night-don',
             'night-don-result', 'night-sheriff', 'night-sheriff-result',
             'night-resolution', 'finished'
           ) THEN stored.event_data ->> 'phaseAfter'
         END
       ),
       day_before = COALESCE(
         event.day_before,
         CASE
           WHEN stored.event_data ->> 'dayBefore' ~ '^[0-9]+$'
             THEN (stored.event_data ->> 'dayBefore')::INTEGER
         END
       ),
       day_after = COALESCE(
         event.day_after,
         CASE
           WHEN stored.event_data ->> 'dayAfter' ~ '^[0-9]+$'
             THEN (stored.event_data ->> 'dayAfter')::INTEGER
         END
       ),
       state_hash_after = COALESCE(
         event.state_hash_after,
         CASE
           WHEN stored.event_data ->> 'stateHashAfter' ~ '^([0-9a-f]{8}|sha256:[0-9a-f]{64})$'
             THEN stored.event_data ->> 'stateHashAfter'
         END
       )
  FROM stored_events AS stored
 WHERE event.club_id = stored.club_id
   AND event.game_id = stored.game_id
   AND event.id::TEXT = stored.event_data ->> 'id';

UPDATE game_events
   SET replay_sequence = NULL,
       parent_event_id = NULL
 WHERE replay_sequence IS NOT NULL
   AND (
     phase_after IS NULL
     OR day_before IS NULL
     OR day_after IS NULL
     OR state_hash_after IS NULL
     OR state_hash_after !~ '^([0-9a-f]{8}|sha256:[0-9a-f]{64})$'
   );

WITH ordered_canonical_events AS MATERIALIZED (
  SELECT
    club_id,
    game_id,
    id,
    ROW_NUMBER() OVER (PARTITION BY club_id, game_id ORDER BY sequence)::INTEGER AS replay_sequence,
    LAG(id) OVER (PARTITION BY club_id, game_id ORDER BY sequence) AS inferred_parent_event_id
  FROM game_events
  WHERE phase_after IS NOT NULL
    AND day_before IS NOT NULL
    AND day_after IS NOT NULL
    AND state_hash_after ~ '^([0-9a-f]{8}|sha256:[0-9a-f]{64})$'
)
UPDATE game_events AS event
   SET replay_sequence = COALESCE(event.replay_sequence, ordered.replay_sequence),
       parent_event_id = CASE
         WHEN event.parent_event_id IS NOT NULL
           OR event.event_type IN ('game.started', 'game.checkpointed')
           THEN event.parent_event_id
         ELSE ordered.inferred_parent_event_id
       END
  FROM ordered_canonical_events AS ordered
 WHERE event.club_id = ordered.club_id
   AND event.game_id = ordered.game_id
   AND event.id = ordered.id
   AND (
     event.replay_sequence IS NULL
     OR (
       event.parent_event_id IS NULL
       AND event.event_type NOT IN ('game.started', 'game.checkpointed')
       AND ordered.inferred_parent_event_id IS NOT NULL
     )
   );

WITH replay_roots AS MATERIALIZED (
  SELECT DISTINCT ON (club_id, game_id) club_id, game_id, id
    FROM game_events
   WHERE replay_sequence IS NOT NULL
     AND event_type IN ('game.started', 'game.checkpointed')
     AND parent_event_id IS NULL
   ORDER BY club_id, game_id, replay_sequence
)
UPDATE game_sessions AS session
   SET replay_base_event_id = COALESCE(session.replay_base_event_id, root.id),
       head_event_id = COALESCE(session.head_event_id, root.id)
  FROM replay_roots AS root
 WHERE session.club_id = root.club_id
   AND session.id = root.game_id
   AND (session.replay_base_event_id IS NULL OR session.head_event_id IS NULL);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'game_events'::REGCLASS
       AND conname = 'game_events_replay_metadata_ck'
  ) THEN
    ALTER TABLE game_events
      ADD CONSTRAINT game_events_replay_metadata_ck CHECK (
        replay_sequence IS NULL
        OR (
          replay_version = 1
          AND phase_after IS NOT NULL
          AND day_before IS NOT NULL
          AND day_after IS NOT NULL
          AND state_hash_after ~ '^([0-9a-f]{8}|sha256:[0-9a-f]{64})$'
        )
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS game_events_club_game_replay_sequence_idx
  ON game_events (club_id, game_id, replay_sequence)
  WHERE replay_sequence IS NOT NULL;

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
  revision INTEGER NOT NULL CHECK (revision > 0),
  request JSONB NULL,
  CONSTRAINT game_session_mutations_pkey PRIMARY KEY (club_id, game_id, mutation_id),
  CONSTRAINT game_session_mutations_game_revision_unique UNIQUE (club_id, game_id, revision),
  CONSTRAINT game_session_mutations_game_fk
    FOREIGN KEY (club_id, game_id) REFERENCES game_sessions (club_id, id) ON DELETE CASCADE
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
  is_club_manager BOOLEAN NOT NULL DEFAULT FALSE,
  user_id UUID NULL,
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
  ),
  CONSTRAINT players_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT players_manager_requires_consent_ck CHECK (
    NOT is_club_manager
    OR data_processing_consent
    OR user_id IS NOT NULL
  )
);

ALTER TABLE players ADD COLUMN IF NOT EXISTS club_id UUID;
ALTER TABLE players ADD COLUMN IF NOT EXISTS is_club_manager BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE players ADD COLUMN IF NOT EXISTS user_id UUID NULL;
UPDATE players
   SET club_id = '00000000-0000-4000-8000-000000000101'
 WHERE club_id IS NULL;
ALTER TABLE players ALTER COLUMN club_id SET NOT NULL;
ALTER TABLE players ALTER COLUMN club_id SET DEFAULT '00000000-0000-4000-8000-000000000101';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'players'::regclass
       AND conname = 'players_user_fk'
  ) THEN
    ALTER TABLE players
      ADD CONSTRAINT players_user_fk
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE players DROP CONSTRAINT IF EXISTS players_manager_requires_consent_ck;
ALTER TABLE players
  ADD CONSTRAINT players_manager_requires_consent_ck CHECK (
    NOT is_club_manager
    OR data_processing_consent
    OR user_id IS NOT NULL
  );

ALTER TABLE club_memberships ADD COLUMN IF NOT EXISTS manager_player_id UUID NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'players'::regclass
       AND conname = 'players_manager_provenance_unique'
  ) THEN
    ALTER TABLE players
      ADD CONSTRAINT players_manager_provenance_unique UNIQUE (id, club_id, user_id);
  END IF;
END $$;

ALTER TABLE club_memberships
  DROP CONSTRAINT IF EXISTS club_memberships_manager_player_fk;
UPDATE club_memberships AS membership
   SET manager_player_id = NULL
 WHERE membership.manager_player_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM players AS player
      WHERE player.id = membership.manager_player_id
        AND player.club_id = membership.club_id
        AND player.user_id = membership.user_id
   );
ALTER TABLE club_memberships
  ADD CONSTRAINT club_memberships_manager_player_fk
  FOREIGN KEY (manager_player_id, club_id, user_id)
  REFERENCES players (id, club_id, user_id)
  ON DELETE CASCADE;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'club_memberships'::regclass
       AND conname = 'club_memberships_manager_role_ck'
  ) THEN
    ALTER TABLE club_memberships
      ADD CONSTRAINT club_memberships_manager_role_ck CHECK (
        manager_player_id IS NULL OR role = 'editor'
      );
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS club_memberships_manager_player_unique_idx
  ON club_memberships (manager_player_id)
  WHERE manager_player_id IS NOT NULL;

WITH creator_matches AS MATERIALIZED (
  SELECT DISTINCT ON (club.id)
         player.id AS player_id,
         club.created_by AS user_id
    FROM clubs AS club
    JOIN users AS app_user ON app_user.id = club.created_by
    JOIN players AS player
      ON player.club_id = club.id
     AND player.data_processing_consent
     AND player.email IS NOT NULL
     AND LOWER(BTRIM(player.email)) = LOWER(BTRIM(app_user.email))
     AND (player.user_id IS NULL OR player.user_id = club.created_by)
   WHERE NOT EXISTS (
     SELECT 1
       FROM players AS existing_manager
      WHERE existing_manager.club_id = club.id
        AND existing_manager.is_club_manager
        AND existing_manager.user_id = club.created_by
   )
   ORDER BY club.id,
            (player.user_id = club.created_by) DESC NULLS LAST,
            player.created_at,
            player.id
)
UPDATE players AS player
   SET is_club_manager = TRUE,
       user_id = creator.user_id
  FROM creator_matches AS creator
 WHERE player.id = creator.player_id;

INSERT INTO players (
  id,
  club_id,
  nickname,
  first_name,
  last_name,
  email,
  data_processing_consent,
  consent_at,
  is_club_manager,
  user_id,
  created_at,
  updated_at
)
SELECT
  (
    SUBSTRING(owner_id.hex FROM 1 FOR 8) || '-' ||
    SUBSTRING(owner_id.hex FROM 9 FOR 4) || '-4' ||
    SUBSTRING(owner_id.hex FROM 14 FOR 3) || '-a' ||
    SUBSTRING(owner_id.hex FROM 18 FOR 3) || '-' ||
    SUBSTRING(owner_id.hex FROM 21 FOR 12)
  )::UUID,
  club.id,
  owner_nickname.nickname,
  NULL,
  NULL,
  NULL,
  FALSE,
  NULL,
  TRUE,
  club.created_by,
  club.created_at,
  club.created_at
FROM clubs AS club
JOIN users AS app_user ON app_user.id = club.created_by
CROSS JOIN LATERAL (
  SELECT md5('club-owner-player:' || club.id::TEXT) AS hex
) AS owner_id
CROSS JOIN LATERAL (
  SELECT candidate.nickname
    FROM (
      SELECT 1 AS ordinal, 'Owner'::TEXT AS nickname
      UNION ALL
      SELECT suffix AS ordinal, 'Owner ' || suffix::TEXT AS nickname
        FROM generate_series(
          2,
          (SELECT COUNT(*)::INTEGER + 2 FROM players WHERE club_id = club.id)
        ) AS suffix
    ) AS candidate
   WHERE NOT EXISTS (
     SELECT 1
       FROM players AS existing_player
      WHERE existing_player.club_id = club.id
        AND LOWER(BTRIM(existing_player.nickname)) = LOWER(BTRIM(candidate.nickname))
   )
   ORDER BY candidate.ordinal
   LIMIT 1
) AS owner_nickname
WHERE NOT EXISTS (
  SELECT 1
    FROM players AS manager
   WHERE manager.club_id = club.id
     AND manager.is_club_manager
     AND manager.user_id = club.created_by
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO club_memberships (club_id, user_id, role, created_at)
SELECT club.id, club.created_by, 'owner', club.created_at
  FROM clubs AS club
ON CONFLICT (club_id, user_id) DO UPDATE
  SET role = 'owner', manager_player_id = NULL;

DROP INDEX IF EXISTS players_nickname_unique_idx;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'players'::regclass
       AND conname = 'players_club_id_id_unique'
  ) THEN
    ALTER TABLE players
      ADD CONSTRAINT players_club_id_id_unique UNIQUE (club_id, id);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS players_club_nickname_unique_idx
  ON players (club_id, LOWER(BTRIM(nickname)));
CREATE INDEX IF NOT EXISTS players_club_last_played_nickname_idx
  ON players (club_id, last_played_at DESC, nickname);
CREATE UNIQUE INDEX IF NOT EXISTS players_club_manager_email_unique_idx
  ON players (club_id, LOWER(BTRIM(email)))
  WHERE is_club_manager;
CREATE UNIQUE INDEX IF NOT EXISTS players_club_linked_user_unique_idx
  ON players (club_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS game_session_players (
  club_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000101',
  game_id UUID NOT NULL,
  player_id UUID NOT NULL,
  seat INTEGER NULL CHECK (seat BETWEEN 1 AND 10),
  is_host BOOLEAN NOT NULL,
  CONSTRAINT game_session_players_pkey PRIMARY KEY (club_id, game_id, player_id),
  CONSTRAINT game_session_players_game_seat_unique UNIQUE (club_id, game_id, seat),
  CONSTRAINT game_session_players_game_fk
    FOREIGN KEY (club_id, game_id) REFERENCES game_sessions (club_id, id) ON DELETE CASCADE,
  CONSTRAINT game_session_players_player_fk
    FOREIGN KEY (club_id, player_id) REFERENCES players (club_id, id) ON DELETE RESTRICT,
  CHECK ((is_host AND seat IS NULL) OR (NOT is_host AND seat IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS game_session_players_player_idx
  ON game_session_players (player_id, game_id);

CREATE TABLE IF NOT EXISTS game_results (
  game_id UUID NOT NULL,
  club_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000101' CONSTRAINT game_results_club_fk REFERENCES clubs (id) ON DELETE RESTRICT,
  winner TEXT NOT NULL CHECK (winner IN ('red', 'black')),
  played_at TIMESTAMPTZ NOT NULL,
  host_player_id UUID NULL,
  CONSTRAINT game_results_pkey PRIMARY KEY (club_id, game_id),
  CONSTRAINT game_results_host_player_fk
    FOREIGN KEY (club_id, host_player_id) REFERENCES players (club_id, id) ON DELETE RESTRICT
);

ALTER TABLE game_results ADD COLUMN IF NOT EXISTS host_player_id UUID NULL;
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
  club_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000101',
  game_id UUID NOT NULL,
  player_id UUID NOT NULL,
  seat INTEGER NOT NULL CHECK (seat BETWEEN 1 AND 10),
  role TEXT NOT NULL CHECK (role IN ('sheriff', 'citizen', 'mafia', 'don')),
  team TEXT NOT NULL CHECK (team IN ('red', 'black')),
  final_status TEXT NOT NULL CHECK (final_status IN ('active', 'eliminated', 'red-carded')),
  fouls INTEGER NOT NULL CHECK (fouls >= 0),
  won BOOLEAN NOT NULL,
  CONSTRAINT game_player_results_pkey PRIMARY KEY (club_id, game_id, player_id),
  CONSTRAINT game_player_results_game_seat_unique UNIQUE (club_id, game_id, seat),
  CONSTRAINT game_player_results_game_fk
    FOREIGN KEY (club_id, game_id) REFERENCES game_results (club_id, game_id) ON DELETE CASCADE,
  CONSTRAINT game_player_results_player_fk
    FOREIGN KEY (club_id, player_id) REFERENCES players (club_id, id) ON DELETE RESTRICT
);

ALTER TABLE game_player_results
  ADD COLUMN IF NOT EXISTS best_move_hits INTEGER NULL CHECK (best_move_hits BETWEEN 0 AND 3);

ALTER TABLE game_session_mutations ADD COLUMN IF NOT EXISTS club_id UUID;
UPDATE game_session_mutations AS mutation
   SET club_id = session.club_id
  FROM game_sessions AS session
 WHERE mutation.club_id IS NULL
   AND mutation.game_id = session.id;
ALTER TABLE game_session_mutations ALTER COLUMN club_id SET NOT NULL;
ALTER TABLE game_session_mutations ALTER COLUMN club_id SET DEFAULT '00000000-0000-4000-8000-000000000101';

ALTER TABLE game_session_players ADD COLUMN IF NOT EXISTS club_id UUID;
UPDATE game_session_players AS player
   SET club_id = session.club_id
  FROM game_sessions AS session
 WHERE player.club_id IS NULL
   AND player.game_id = session.id;
ALTER TABLE game_session_players ALTER COLUMN club_id SET NOT NULL;
ALTER TABLE game_session_players ALTER COLUMN club_id SET DEFAULT '00000000-0000-4000-8000-000000000101';

ALTER TABLE game_player_results ADD COLUMN IF NOT EXISTS club_id UUID;
UPDATE game_player_results AS player_result
   SET club_id = result.club_id
  FROM game_results AS result
 WHERE player_result.club_id IS NULL
   AND player_result.game_id = result.game_id;
ALTER TABLE game_player_results ALTER COLUMN club_id SET NOT NULL;
ALTER TABLE game_player_results ALTER COLUMN club_id SET DEFAULT '00000000-0000-4000-8000-000000000101';

DO $$
DECLARE
  legacy_fk RECORD;
BEGIN
  FOR legacy_fk IN
    SELECT relation.relname AS table_name, constraint_row.conname AS constraint_name
      FROM pg_constraint AS constraint_row
      JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
     WHERE constraint_row.contype = 'f'
       AND array_length(constraint_row.conkey, 1) = 1
       AND (
         (relation.relname = 'game_session_mutations'
           AND constraint_row.confrelid = 'game_sessions'::regclass)
         OR (relation.relname = 'game_session_players'
           AND constraint_row.confrelid IN ('game_sessions'::regclass, 'players'::regclass))
         OR (relation.relname = 'game_results'
           AND constraint_row.confrelid = 'players'::regclass)
         OR (relation.relname = 'game_player_results'
           AND constraint_row.confrelid IN ('game_results'::regclass, 'players'::regclass))
       )
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', legacy_fk.table_name, legacy_fk.constraint_name);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'game_sessions'::regclass
       AND contype = 'p'
       AND array_length(conkey, 1) = 1
  ) THEN
    ALTER TABLE game_sessions DROP CONSTRAINT game_sessions_pkey;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'game_sessions'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE game_sessions
      ADD CONSTRAINT game_sessions_pkey PRIMARY KEY (club_id, id);
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'game_results'::regclass
       AND contype = 'p'
       AND array_length(conkey, 1) = 1
  ) THEN
    ALTER TABLE game_results DROP CONSTRAINT game_results_pkey;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'game_results'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE game_results
      ADD CONSTRAINT game_results_pkey PRIMARY KEY (club_id, game_id);
  END IF;
END $$;

ALTER TABLE game_session_mutations
  DROP CONSTRAINT IF EXISTS game_session_mutations_game_id_revision_key;
ALTER TABLE game_session_players
  DROP CONSTRAINT IF EXISTS game_session_players_game_id_seat_key;
ALTER TABLE game_player_results
  DROP CONSTRAINT IF EXISTS game_player_results_game_id_seat_key;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'game_session_mutations'::regclass
       AND contype = 'p'
       AND array_length(conkey, 1) = 2
  ) THEN
    ALTER TABLE game_session_mutations DROP CONSTRAINT game_session_mutations_pkey;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'game_session_mutations'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE game_session_mutations
      ADD CONSTRAINT game_session_mutations_pkey PRIMARY KEY (club_id, game_id, mutation_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'game_session_mutations'::regclass
       AND conname = 'game_session_mutations_game_revision_unique'
  ) THEN
    ALTER TABLE game_session_mutations
      ADD CONSTRAINT game_session_mutations_game_revision_unique UNIQUE (club_id, game_id, revision);
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'game_session_players'::regclass
       AND contype = 'p'
       AND array_length(conkey, 1) = 2
  ) THEN
    ALTER TABLE game_session_players DROP CONSTRAINT game_session_players_pkey;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'game_session_players'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE game_session_players
      ADD CONSTRAINT game_session_players_pkey PRIMARY KEY (club_id, game_id, player_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'game_session_players'::regclass
       AND conname = 'game_session_players_game_seat_unique'
  ) THEN
    ALTER TABLE game_session_players
      ADD CONSTRAINT game_session_players_game_seat_unique UNIQUE (club_id, game_id, seat);
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'game_player_results'::regclass
       AND contype = 'p'
       AND array_length(conkey, 1) = 2
  ) THEN
    ALTER TABLE game_player_results DROP CONSTRAINT game_player_results_pkey;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'game_player_results'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE game_player_results
      ADD CONSTRAINT game_player_results_pkey PRIMARY KEY (club_id, game_id, player_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'game_player_results'::regclass
       AND conname = 'game_player_results_game_seat_unique'
  ) THEN
    ALTER TABLE game_player_results
      ADD CONSTRAINT game_player_results_game_seat_unique UNIQUE (club_id, game_id, seat);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'game_session_mutations'::regclass
       AND conname = 'game_session_mutations_game_fk'
  ) THEN
    ALTER TABLE game_session_mutations
      ADD CONSTRAINT game_session_mutations_game_fk
      FOREIGN KEY (club_id, game_id) REFERENCES game_sessions (club_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'game_session_players'::regclass
       AND conname = 'game_session_players_game_fk'
  ) THEN
    ALTER TABLE game_session_players
      ADD CONSTRAINT game_session_players_game_fk
      FOREIGN KEY (club_id, game_id) REFERENCES game_sessions (club_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'game_session_players'::regclass
       AND conname = 'game_session_players_player_fk'
  ) THEN
    ALTER TABLE game_session_players
      ADD CONSTRAINT game_session_players_player_fk
      FOREIGN KEY (club_id, player_id) REFERENCES players (club_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'game_results'::regclass
       AND conname = 'game_results_host_player_fk'
  ) THEN
    ALTER TABLE game_results
      ADD CONSTRAINT game_results_host_player_fk
      FOREIGN KEY (club_id, host_player_id) REFERENCES players (club_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'game_player_results'::regclass
       AND conname = 'game_player_results_game_fk'
  ) THEN
    ALTER TABLE game_player_results
      ADD CONSTRAINT game_player_results_game_fk
      FOREIGN KEY (club_id, game_id) REFERENCES game_results (club_id, game_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'game_player_results'::regclass
       AND conname = 'game_player_results_player_fk'
  ) THEN
    ALTER TABLE game_player_results
      ADD CONSTRAINT game_player_results_player_fk
      FOREIGN KEY (club_id, player_id) REFERENCES players (club_id, id) ON DELETE RESTRICT;
  END IF;
END $$;

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

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'game_events'::regclass
       AND conname = 'game_events_club_game_event_unique'
       AND pg_get_constraintdef(oid) <> 'UNIQUE (club_id, game_id, id)'
  ) THEN
    RAISE EXCEPTION 'game_events_club_game_event_unique has an unexpected definition';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'game_events'::regclass
       AND conname = 'game_events_club_game_event_unique'
  ) THEN
    ALTER TABLE game_events
      ADD CONSTRAINT game_events_club_game_event_unique UNIQUE (club_id, game_id, id);
  END IF;
END $$;

-- EventStore also serves non-session game aggregates. Remove this constraint
-- if a failed pre-release schema application installed it.
ALTER TABLE game_events DROP CONSTRAINT IF EXISTS game_events_game_fk;
ALTER TABLE game_events DROP CONSTRAINT IF EXISTS game_events_parent_fk;
ALTER TABLE game_sessions DROP CONSTRAINT IF EXISTS game_sessions_replay_base_event_fk;
ALTER TABLE game_sessions DROP CONSTRAINT IF EXISTS game_sessions_head_event_fk;
ALTER TABLE game_sessions DROP CONSTRAINT IF EXISTS game_sessions_reset_return_event_fk;
