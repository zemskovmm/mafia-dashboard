import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import { assertGameNotDeleted, lockAggregateProjectionTables } from "./game-lifecycle.js";
import { initializeSchema } from "./initialize-schema.js";

export interface StoredGameLogEntry {
  readonly id: string;
  readonly sequence: number;
  readonly type: string;
  readonly phase: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly secret: boolean;
  readonly createdAt: string;
}

export interface StoredUndoSnapshot {
  readonly game: unknown;
  readonly logLength: number;
  readonly sequence: number;
}

export interface StoredGameSessionState {
  readonly setup: unknown | null;
  readonly game: unknown | null;
  readonly hostPlayerId: string | null;
  readonly hostName: string | null;
  readonly playlistId: string;
  readonly log: readonly StoredGameLogEntry[];
  readonly undoHistory: readonly StoredUndoSnapshot[];
}

export interface StoredGameResults {
  readonly hostPlayerId: string;
  readonly winner: "red" | "black";
  readonly playedAt: string;
  readonly players: readonly {
    readonly playerId: string;
    readonly seat: number;
    readonly role: "sheriff" | "citizen" | "mafia" | "don";
    readonly team: "red" | "black";
    readonly status: "active" | "eliminated" | "red-carded";
    readonly fouls: number;
  }[];
}

export interface SaveGameSessionInput {
  readonly gameId: string;
  readonly name: string;
  readonly mutationId: string;
  readonly baseRevision: number;
  readonly state: StoredGameSessionState;
  readonly results: StoredGameResults | null;
}

export interface StoredGameSession {
  readonly gameId: string;
  readonly name: string;
  readonly revision: number;
  readonly duplicate: boolean;
  readonly status: "active" | "completed";
  readonly updatedAt: Date;
  readonly state: StoredGameSessionState;
  readonly results: StoredGameResults | null;
}

export interface GameSessionSummary {
  readonly gameId: string;
  readonly name: string;
  readonly revision: number;
  readonly hostName: string | null;
  readonly phase: string;
  readonly day: number;
  readonly updatedAt: Date;
}

interface SessionRow {
  id: string;
  name: string;
  revision: number;
  status: "active" | "completed";
  updated_at: Date;
  state: StoredGameSessionState;
  results: StoredGameResults | null;
}

interface DuplicateSessionRow extends SessionRow {
  mutation_revision: number;
  mutation_request: unknown | null;
}

const sessionColumns = "id, name, revision, status, updated_at, state, results";

const mapSession = (row: SessionRow, duplicate: boolean): StoredGameSession => ({
  gameId: row.id,
  name: row.name,
  revision: row.revision,
  duplicate,
  status: row.status,
  updatedAt: row.updated_at,
  state: row.state,
  results: row.results,
});

interface RosterState {
  readonly setup?: {
    readonly hostPlayerId?: string;
    readonly selectedPlayerIds?: readonly string[];
    readonly setup?: {
      readonly players?: readonly { readonly id?: string; readonly seat?: number }[];
    } | null;
  } | null;
  readonly game?: {
    readonly players?: readonly { readonly id?: string; readonly seat?: number }[];
  } | null;
  readonly hostPlayerId?: string | null;
}

const replaceActiveRoster = async (
  client: PoolClient,
  gameId: string,
  state: StoredGameSessionState,
): Promise<void> => {
  await client.query("DELETE FROM game_session_players WHERE game_id = $1", [gameId]);
  const rosterState = state as RosterState;
  const hostPlayerId = rosterState.hostPlayerId ?? rosterState.setup?.hostPlayerId;
  if (hostPlayerId !== undefined && hostPlayerId !== null && hostPlayerId !== "") {
    await client.query(
      `INSERT INTO game_session_players (game_id, player_id, seat, is_host)
       VALUES ($1, $2, NULL, TRUE)`,
      [gameId, hostPlayerId],
    );
  }
  const seatedPlayers =
    rosterState.game?.players?.flatMap(({ id, seat }) =>
      typeof id === "string" && typeof seat === "number" ? [{ id, seat }] : [],
    ) ??
    rosterState.setup?.setup?.players?.flatMap(({ id, seat }) =>
      typeof id === "string" && typeof seat === "number" ? [{ id, seat }] : [],
    ) ??
    rosterState.setup?.selectedPlayerIds?.flatMap((id, index) =>
      id === "" ? [] : [{ id, seat: index + 1 }],
    ) ??
    [];
  for (const player of seatedPlayers) {
    await client.query(
      `INSERT INTO game_session_players (game_id, player_id, seat, is_host)
       VALUES ($1, $2, $3, FALSE)`,
      [gameId, player.id, player.seat],
    );
  }
};

const replaceLogTail = async (
  client: PoolClient,
  gameId: string,
  log: readonly StoredGameLogEntry[],
): Promise<void> => {
  await client.query("DELETE FROM game_events WHERE game_id = $1 AND sequence > 1", [gameId]);
  for (const [index, entry] of log.entries()) {
    const seat = typeof entry.payload.seat === "number" ? entry.payload.seat : null;
    await client.query(
      `INSERT INTO game_events
         (id, game_id, sequence, idempotency_key, event_type, phase, seat, payload, secret,
          created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
      [
        entry.id,
        gameId,
        index + 2,
        entry.id,
        entry.type,
        entry.phase,
        seat,
        JSON.stringify(entry.payload),
        entry.secret,
        entry.createdAt,
      ],
    );
  }
};

const updateLastPlayed = async (
  client: PoolClient,
  affectedPlayerIds: readonly string[],
): Promise<void> => {
  if (affectedPlayerIds.length === 0) return;
  await client.query(
    `UPDATE players AS p
        SET last_played_at = (
              SELECT MAX(history.played_at)
                FROM (
                  SELECT result.played_at
                    FROM game_player_results AS player_result
                    JOIN game_results AS result ON result.game_id = player_result.game_id
                   WHERE player_result.player_id = p.id
                  UNION ALL
                  SELECT hosted.played_at
                    FROM game_results AS hosted
                   WHERE hosted.host_player_id = p.id
                ) AS history
            ),
            updated_at = NOW()
      WHERE p.id = ANY($1::uuid[])`,
    [affectedPlayerIds],
  );
};

const replaceResults = async (
  client: PoolClient,
  gameId: string,
  results: StoredGameResults | null,
): Promise<void> => {
  const previous = await client.query<{ player_id: string }>(
    `SELECT player_id FROM game_player_results WHERE game_id = $1
     UNION
     SELECT host_player_id AS player_id FROM game_results
      WHERE game_id = $1 AND host_player_id IS NOT NULL`,
    [gameId],
  );
  const affected = new Set(previous.rows.map(({ player_id }) => player_id));
  if (results === null) {
    await client.query("DELETE FROM game_results WHERE game_id = $1", [gameId]);
    await updateLastPlayed(client, [...affected]);
    return;
  }
  affected.add(results.hostPlayerId);
  for (const player of results.players) affected.add(player.playerId);
  await client.query(
    `INSERT INTO game_results (game_id, winner, played_at, host_player_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (game_id) DO UPDATE
       SET winner = EXCLUDED.winner,
           played_at = EXCLUDED.played_at,
           host_player_id = EXCLUDED.host_player_id`,
    [gameId, results.winner, results.playedAt, results.hostPlayerId],
  );
  await client.query("DELETE FROM game_player_results WHERE game_id = $1", [gameId]);
  for (const player of results.players) {
    await client.query(
      `INSERT INTO game_player_results
         (game_id, player_id, seat, role, team, final_status, fouls, won)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $5 = $8)`,
      [
        gameId,
        player.playerId,
        player.seat,
        player.role,
        player.team,
        player.status,
        player.fouls,
        results.winner,
      ],
    );
  }
  await updateLastPlayed(client, [...affected]);
};

const synchronizeAggregate = async (
  client: PoolClient,
  gameId: string,
  state: StoredGameSessionState,
  results: StoredGameResults | null,
): Promise<void> => {
  await replaceLogTail(client, gameId, state.log);
  await replaceResults(client, gameId, results);
  if (results === null) await replaceActiveRoster(client, gameId, state);
  else await client.query("DELETE FROM game_session_players WHERE game_id = $1", [gameId]);
};

const mutationRequest = (input: SaveGameSessionInput) => ({
  name: input.name.trim(),
  baseRevision: input.baseRevision,
  state: input.state,
  results: input.results,
});

export class GameSessionMutationMismatchError extends Error {
  public override readonly name = "GameSessionMutationMismatchError";

  public constructor() {
    super("A mutation ID may only be retried with the exact original request");
  }
}

export class GameSessionConflictError extends Error {
  public override readonly name = "GameSessionConflictError";

  public constructor(public readonly currentRevision: number) {
    super(`Game session revision conflict; current revision is ${currentRevision}`);
  }
}

export class GameSessionStore {
  public constructor(private readonly pool: Pool) {}

  public async initialize(): Promise<void> {
    await initializeSchema(this.pool);
  }

  public async clear(gameId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockAggregateProjectionTables(client);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [gameId]);
      await client.query(
        `INSERT INTO deleted_games (game_id) VALUES ($1)
         ON CONFLICT (game_id) DO NOTHING`,
        [gameId],
      );
      await client.query("DELETE FROM game_sessions WHERE id = $1", [gameId]);
      await client.query("DELETE FROM game_events WHERE game_id = $1", [gameId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async listActive(): Promise<readonly GameSessionSummary[]> {
    const result = await this.pool.query<SessionRow>(
      `SELECT ${sessionColumns}
         FROM game_sessions
        WHERE status = 'active'
        ORDER BY updated_at DESC, id`,
    );
    return result.rows.map((row) => {
      const state = row.state as StoredGameSessionState & {
        readonly game?: { readonly phase?: string; readonly day?: number } | null;
        readonly setup?: { readonly step?: string } | null;
      };
      return {
        gameId: row.id,
        name: row.name,
        revision: row.revision,
        hostName: row.state.hostName,
        phase:
          state.game?.phase ??
          (state.setup?.step === undefined ? "setup-players" : `setup-${state.setup.step}`),
        day: state.game?.day ?? 0,
        updatedAt: row.updated_at,
      };
    });
  }

  public async get(gameId: string): Promise<StoredGameSession | null> {
    const result = await this.pool.query<SessionRow>(
      `SELECT ${sessionColumns} FROM game_sessions WHERE id = $1`,
      [gameId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapSession(row, false);
  }

  public async save(input: SaveGameSessionInput): Promise<StoredGameSession> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockAggregateProjectionTables(client);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.gameId]);
      await assertGameNotDeleted(client, input.gameId);

      const duplicate = await client.query<DuplicateSessionRow>(
        `SELECT session.id, session.name, session.revision, session.status,
                session.updated_at, session.state, session.results,
                mutation.revision AS mutation_revision,
                mutation.request AS mutation_request
           FROM game_session_mutations AS mutation
           JOIN game_sessions AS session ON session.id = mutation.game_id
          WHERE mutation.game_id = $1 AND mutation.mutation_id = $2`,
        [input.gameId, input.mutationId],
      );
      const duplicateRow = duplicate.rows[0];
      if (duplicateRow !== undefined) {
        if (
          duplicateRow.mutation_request !== null &&
          !isDeepStrictEqual(duplicateRow.mutation_request, mutationRequest(input))
        ) {
          throw new GameSessionMutationMismatchError();
        }
        await client.query("COMMIT");
        return mapSession(duplicateRow, true);
      }

      const current = await client.query<SessionRow>(
        `SELECT ${sessionColumns} FROM game_sessions WHERE id = $1 FOR UPDATE`,
        [input.gameId],
      );
      const currentRow = current.rows[0];
      if (currentRow !== undefined) {
        if (input.baseRevision !== currentRow.revision) {
          throw new GameSessionConflictError(currentRow.revision);
        }
        const nextRevision = currentRow.revision + 1;
        const status = input.results === null ? "active" : "completed";
        const updated = await client.query<SessionRow>(
          `UPDATE game_sessions
              SET name = $2, revision = $3, last_mutation_id = $4,
                  state = $5::jsonb, status = $6, results = $7::jsonb, updated_at = NOW()
            WHERE id = $1
          RETURNING ${sessionColumns}`,
          [
            input.gameId,
            input.name.trim(),
            nextRevision,
            input.mutationId,
            JSON.stringify(input.state),
            status,
            input.results === null ? null : JSON.stringify(input.results),
          ],
        );
        await synchronizeAggregate(client, input.gameId, input.state, input.results);
        await client.query(
          `INSERT INTO game_session_mutations (game_id, mutation_id, revision, request)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [input.gameId, input.mutationId, nextRevision, JSON.stringify(mutationRequest(input))],
        );
        const updatedRow = updated.rows[0];
        if (updatedRow === undefined) throw new Error("The updated game session was not returned");
        await client.query("COMMIT");
        return mapSession(updatedRow, false);
      }

      if (input.baseRevision !== 0) {
        throw new GameSessionConflictError(0);
      }
      const status = input.results === null ? "active" : "completed";
      const inserted = await client.query<SessionRow>(
        `INSERT INTO game_sessions
           (id, name, revision, last_mutation_id, state, status, results)
         VALUES ($1, $2, 1, $3, $4::jsonb, $5, $6::jsonb)
         RETURNING ${sessionColumns}`,
        [
          input.gameId,
          input.name.trim(),
          input.mutationId,
          JSON.stringify(input.state),
          status,
          input.results === null ? null : JSON.stringify(input.results),
        ],
      );
      await client.query(
        `INSERT INTO game_events
           (id, game_id, sequence, idempotency_key, event_type, phase, payload, secret)
         VALUES ($1, $2, 1, 'game-created', 'game.created', 'setup-players', $3::jsonb, FALSE)`,
        [randomUUID(), input.gameId, JSON.stringify({ name: input.name.trim() })],
      );
      await synchronizeAggregate(client, input.gameId, input.state, input.results);
      await client.query(
        `INSERT INTO game_session_mutations (game_id, mutation_id, revision, request)
         VALUES ($1, $2, 1, $3::jsonb)`,
        [input.gameId, input.mutationId, JSON.stringify(mutationRequest(input))],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error("The created game session was not returned");
      await client.query("COMMIT");
      return mapSession(row, false);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
