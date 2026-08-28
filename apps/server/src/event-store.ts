import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  assertGameNotDeleted,
  assertLegacyGameMutationAllowed,
  lockClubGame,
} from "./game-lifecycle.js";
import { initializeSchema } from "./initialize-schema.js";
import { DEFAULT_CLUB_ID } from "./club-store.js";
import { isSecretGameEventType } from "@mafia/game-domain";

export interface GameEventInput {
  readonly clubId?: string;
  readonly gameId: string;
  readonly idempotencyKey: string;
  readonly type: string;
  readonly phase: string;
  readonly seat?: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface GameEvent extends GameEventInput {
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

const findByIdempotencyKey = async (
  client: PoolClient,
  clubId: string,
  gameId: string,
  idempotencyKey: string,
): Promise<GameEvent | null> => {
  const result = await client.query<EventRow>(
    `SELECT id, game_id, sequence, idempotency_key, event_type, phase, seat, payload,
            created_at, parent_event_id, replay_version, state_hash_after
       FROM game_events
      WHERE club_id = $1 AND game_id = $2 AND idempotency_key = $3`,
    [clubId, gameId, idempotencyKey],
  );
  return result.rows[0] === undefined ? null : mapRow(result.rows[0]);
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
      await lockClubGame(client, clubId, input.gameId);
      await assertGameNotDeleted(client, clubId, input.gameId);
      await assertLegacyGameMutationAllowed(client, clubId, input.gameId);

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
           (id, club_id, game_id, sequence, idempotency_key, event_type, phase, seat, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         RETURNING id, game_id, sequence, idempotency_key, event_type, phase, seat, payload,
                   created_at, parent_event_id, replay_version, state_hash_after`,
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
      await lockClubGame(client, clubId, gameId);
      await assertGameNotDeleted(client, clubId, gameId);
      await assertLegacyGameMutationAllowed(client, clubId, gameId);
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
      await lockClubGame(client, clubId, gameId);
      await assertLegacyGameMutationAllowed(client, clubId, gameId);
      await client.query(
        `INSERT INTO deleted_games (game_id, club_id)
         VALUES ($1, $2)
         ON CONFLICT (club_id, game_id) DO NOTHING`,
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
      `SELECT id, game_id, sequence, idempotency_key, event_type, phase, seat, payload,
              created_at, parent_event_id, replay_version, state_hash_after
         FROM game_events
        WHERE club_id = $1 AND game_id = $2
        ORDER BY sequence ASC`,
      [clubId, gameId],
    );
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
