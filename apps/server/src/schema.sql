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
