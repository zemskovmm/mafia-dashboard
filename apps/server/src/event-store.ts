import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";

export interface GameEventInput {
  readonly gameId: string;
  readonly idempotencyKey: string;
  readonly type: string;
  readonly phase: string;
  readonly seat?: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly secret: boolean;
}

export interface GameEvent extends GameEventInput {
  readonly id: string;
  readonly sequence: number;
  readonly createdAt: Date;
  readonly duplicate: boolean;
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
  secret: boolean;
  created_at: Date;
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
  secret: row.secret,
  createdAt: row.created_at,
  duplicate: false,
});

const findByIdempotencyKey = async (
  client: PoolClient,
  gameId: string,
  idempotencyKey: string,
): Promise<GameEvent | null> => {
  const result = await client.query<EventRow>(
    `SELECT id, game_id, sequence, idempotency_key, event_type, phase, seat, payload, secret,
            created_at
       FROM game_events
      WHERE game_id = $1 AND idempotency_key = $2`,
    [gameId, idempotencyKey],
  );
  return result.rows[0] === undefined ? null : mapRow(result.rows[0]);
};

export class EventStore {
  public constructor(private readonly pool: Pool) {}

  public async initialize(): Promise<void> {
    const schema = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
    await this.pool.query(schema);
  }

  public async append(input: GameEventInput): Promise<GameEvent> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.gameId]);

      const duplicate = await findByIdempotencyKey(client, input.gameId, input.idempotencyKey);
      if (duplicate !== null) {
        await client.query("COMMIT");
        return { ...duplicate, duplicate: true };
      }

      const sequenceResult = await client.query<{ sequence: number }>(
        `SELECT COALESCE(MAX(sequence), 0)::int + 1 AS sequence
           FROM game_events
          WHERE game_id = $1`,
        [input.gameId],
      );
      const sequence = sequenceResult.rows[0]?.sequence;
      if (sequence === undefined) {
        throw new Error("Unable to allocate a game event sequence");
      }

      const result = await client.query<EventRow>(
        `INSERT INTO game_events
           (id, game_id, sequence, idempotency_key, event_type, phase, seat, payload, secret)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
         RETURNING id, game_id, sequence, idempotency_key, event_type, phase, seat, payload,
                   secret, created_at`,
        [
          randomUUID(),
          input.gameId,
          sequence,
          input.idempotencyKey,
          input.type,
          input.phase,
          input.seat ?? null,
          JSON.stringify(input.payload),
          input.secret,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("The appended event was not returned");
      }
      await client.query("COMMIT");
      return mapRow(row);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async read(
    gameId: string,
    options: { readonly includeSecrets: boolean } = { includeSecrets: true },
  ): Promise<readonly GameEvent[]> {
    const result = await this.pool.query<EventRow>(
      `SELECT id, game_id, sequence, idempotency_key, event_type, phase, seat, payload, secret,
              created_at
         FROM game_events
        WHERE game_id = $1
        ORDER BY sequence ASC`,
      [gameId],
    );
    return result.rows.map((row) => {
      const event = mapRow(row);
      return !options.includeSecrets && event.secret
        ? { ...event, payload: { redacted: true } }
        : event;
    });
  }
}
