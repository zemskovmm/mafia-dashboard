import type { Pool } from "pg";
import { initializeSchema } from "./initialize-schema.js";
import { DEFAULT_CLUB_ID } from "./club-store.js";
import { isSecretGameEventType } from "@mafia/game-domain";
import { assertSupportedGame } from "./game-session-identity.js";

export interface GameEvent {
  readonly gameId: string;
  readonly idempotencyKey: string;
  readonly type: string;
  readonly phase: string;
  readonly seat?: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly sequence: number;
  readonly createdAt: Date;
  readonly duplicate: boolean;
  readonly parentEventId: string | null;
  readonly replayVersion: number;
  readonly stateHashAfter: string | null;
}

interface EventRow {
  id: string;
  game_id: string;
  sequence: number;
  idempotency_key: string;
  event_type: string;
  phase: string;
  seat: number | null;
  payload: Record<string, unknown>;
  created_at: Date;
  parent_event_id: string | null;
  replay_version: number;
  state_hash_after: string | null;
}

const mapRow = (row: EventRow): GameEvent => ({
  id: row.id,
  gameId: row.game_id,
  sequence: row.sequence,
  idempotencyKey: row.idempotency_key,
  type: row.event_type,
  phase: row.phase,
  ...(row.seat === null ? {} : { seat: row.seat }),
  payload: row.payload,
  createdAt: row.created_at,
  duplicate: false,
  parentEventId: row.parent_event_id,
  replayVersion: row.replay_version,
  stateHashAfter: row.state_hash_after,
});

export class EventStore {
  public constructor(private readonly pool: Pool) {}

  public async initialize(): Promise<void> {
    await initializeSchema(this.pool);
  }

  public async read(
    gameId: string,
    options: { readonly includeSecrets: boolean } = { includeSecrets: true },
    clubId = DEFAULT_CLUB_ID,
  ): Promise<readonly GameEvent[]> {
    const result = await this.pool.query<EventRow>(
      `SELECT id, game_id, sequence, idempotency_key, event_type, phase, seat, payload,
              created_at, parent_event_id, replay_version, state_hash_after
         FROM game_events
        WHERE club_id = $1 AND game_id = $2
        ORDER BY sequence ASC`,
      [clubId, gameId],
    );
    assertSupportedGame({ events: result.rows.map(({ payload }) => ({ payload })) }, null);
    return result.rows.map((row) => {
      const event = mapRow(row);
      if (options.includeSecrets) return event;
      return {
        ...event,
        stateHashAfter: null,
        ...(isSecretGameEventType(event.type) ? { payload: { redacted: true } } : {}),
      };
    });
  }
}
