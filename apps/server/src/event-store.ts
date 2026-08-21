import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { assertGameNotDeleted, assertLegacyGameMutationAllowed } from "./game-lifecycle.js";
import { initializeSchema } from "./initialize-schema.js";
import { DEFAULT_CLUB_ID } from "./club-store.js";

export interface GameEventInput {
  readonly clubId?: string;
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
  clubId: string,
  gameId: string,
  idempotencyKey: string,
): Promise<GameEvent | null> => {
  const result = await client.query<EventRow>(
    `SELECT id, game_id, sequence, idempotency_key, event_type, phase, seat, payload, secret,
            created_at
       FROM game_events
      WHERE club_id = $1 AND game_id = $2 AND idempotency_key = $3`,
    [clubId, gameId, idempotencyKey],
  );
  return result.rows[0] === undefined ? null : mapRow(result.rows[0]);
};

const assertLegacyClubOwnership = async (
  client: PoolClient,
  clubId: string,
  gameId: string,
): Promise<void> => {
  const existing = await client.query<{ club_id: string }>(
    "SELECT club_id FROM game_events WHERE game_id = $1 LIMIT 1",
    [gameId],
  );
  if (existing.rows[0] !== undefined && existing.rows[0].club_id !== clubId) {
    throw new Error("The game belongs to another club");
  }
};

export class EventStore {
  public constructor(private readonly pool: Pool) {}

  public async initialize(): Promise<void> {
    await initializeSchema(this.pool);
  }

  public async append(input: GameEventInput): Promise<GameEvent> {
    const clubId = input.clubId ?? DEFAULT_CLUB_ID;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE game_events IN ROW EXCLUSIVE MODE");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.gameId]);
      await assertGameNotDeleted(client, input.gameId);
      await assertLegacyGameMutationAllowed(client, input.gameId);
      await assertLegacyClubOwnership(client, clubId, input.gameId);

      const duplicate = await findByIdempotencyKey(
        client,
        clubId,
        input.gameId,
        input.idempotencyKey,
      );
      if (duplicate !== null) {
        await client.query("COMMIT");
        return { ...duplicate, duplicate: true };
      }

      const sequenceResult = await client.query<{ sequence: number }>(
        `SELECT COALESCE(MAX(sequence), 0)::int + 1 AS sequence
           FROM game_events
          WHERE club_id = $1 AND game_id = $2`,
        [clubId, input.gameId],
      );
      const sequence = sequenceResult.rows[0]?.sequence;
      if (sequence === undefined) {
        throw new Error("Unable to allocate a game event sequence");
      }

      const result = await client.query<EventRow>(
        `INSERT INTO game_events
           (id, club_id, game_id, sequence, idempotency_key, event_type, phase, seat, payload, secret)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
         RETURNING id, game_id, sequence, idempotency_key, event_type, phase, seat, payload,
                   secret, created_at`,
        [
          randomUUID(),
          clubId,
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

  public async truncateFrom(
    gameId: string,
    idempotencyKey: string,
    clubId = DEFAULT_CLUB_ID,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE game_events IN ROW EXCLUSIVE MODE");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [gameId]);
      await assertGameNotDeleted(client, gameId);
      await assertLegacyGameMutationAllowed(client, gameId);
      await assertLegacyClubOwnership(client, clubId, gameId);
      await client.query(
        `WITH cutoff AS (
           SELECT sequence
             FROM game_events
            WHERE club_id = $1 AND game_id = $2 AND idempotency_key = $3
         )
         DELETE FROM game_events AS event
          USING cutoff
          WHERE event.club_id = $1 AND event.game_id = $2
            AND event.sequence >= GREATEST(cutoff.sequence, 2)`,
        [clubId, gameId, idempotencyKey],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async deleteGame(gameId: string, clubId = DEFAULT_CLUB_ID): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "LOCK TABLE game_results, game_player_results, game_events IN SHARE ROW EXCLUSIVE MODE",
      );
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [gameId]);
      await assertLegacyGameMutationAllowed(client, gameId);
      await assertLegacyClubOwnership(client, clubId, gameId);
      await client.query(
        `INSERT INTO deleted_games (game_id, club_id)
         VALUES ($1, $2)
         ON CONFLICT (game_id) DO NOTHING`,
        [gameId, clubId],
      );
      await client.query("DELETE FROM game_events WHERE game_id = $1 AND club_id = $2", [
        gameId,
        clubId,
      ]);
      await client.query("COMMIT");
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
    clubId = DEFAULT_CLUB_ID,
  ): Promise<readonly GameEvent[]> {
    const result = await this.pool.query<EventRow>(
      `SELECT id, game_id, sequence, idempotency_key, event_type, phase, seat, payload, secret,
              created_at
         FROM game_events
        WHERE club_id = $1 AND game_id = $2
        ORDER BY sequence ASC`,
      [clubId, gameId],
    );
    return result.rows.map((row) => {
      const event = mapRow(row);
      return !options.includeSecrets && event.secret
        ? { ...event, payload: { redacted: true } }
        : event;
    });
  }
}
