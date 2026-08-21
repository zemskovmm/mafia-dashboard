import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import { assertGameNotDeleted, lockAggregateProjectionTables } from "./game-lifecycle.js";
import { initializeSchema } from "./initialize-schema.js";
import { DEFAULT_CLUB_ID } from "./club-store.js";

interface StoredGameLogEntry {
  readonly id: string;
  readonly sequence: number;
  readonly type: string;
  readonly phase: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly secret: boolean;
  readonly createdAt: string;
}

interface StoredUndoSnapshot {
  readonly game: unknown;
  readonly logLength: number;
  readonly sequence: number;
}

interface StoredGameSessionState {
  readonly setup: unknown | null;
  readonly game: unknown | null;
  readonly hostPlayerId: string | null;
  readonly hostName: string | null;
  readonly playlistId: string;
  readonly log: readonly StoredGameLogEntry[];
  readonly undoHistory: readonly StoredUndoSnapshot[];
}

interface StoredGameResults {
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
    readonly bestMoveHits?: number | null;
  }[];
}

export interface SaveGameSessionInput {
  readonly clubId?: string;
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

const assertPlayersBelongToClub = async (
  client: PoolClient,
  clubId: string,
  playerIds: readonly string[],
): Promise<void> => {
  const uniqueIds = [...new Set(playerIds.filter((id) => id !== ""))];
  if (uniqueIds.length === 0) return;
  const result = await client.query<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM players WHERE club_id = $1 AND id = ANY($2::uuid[])",
    [clubId, uniqueIds],
  );
  if (result.rows[0]?.count !== uniqueIds.length) {
    throw new Error("All game participants must belong to the selected club");
  }
};

const replaceActiveRoster = async (
  client: PoolClient,
  clubId: string,
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
  await assertPlayersBelongToClub(client, clubId, [
    ...(hostPlayerId === undefined || hostPlayerId === null ? [] : [hostPlayerId]),
    ...seatedPlayers.map(({ id }) => id),
  ]);
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
  clubId: string,
  gameId: string,
  log: readonly StoredGameLogEntry[],
): Promise<void> => {
  await client.query("DELETE FROM game_events WHERE game_id = $1 AND sequence > 1", [gameId]);
  for (const [index, entry] of log.entries()) {
    const seat = typeof entry.payload.seat === "number" ? entry.payload.seat : null;
    await client.query(
      `INSERT INTO game_events
         (id, club_id, game_id, sequence, idempotency_key, event_type, phase, seat, payload, secret,
          created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)`,
      [
        entry.id,
        clubId,
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
  await client.query("SELECT id FROM players WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE", [
    affectedPlayerIds,
  ]);
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
  clubId: string,
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
  await assertPlayersBelongToClub(client, clubId, [
    results.hostPlayerId,
    ...results.players.map(({ playerId }) => playerId),
  ]);
  affected.add(results.hostPlayerId);
  for (const player of results.players) affected.add(player.playerId);
  await client.query(
    `INSERT INTO game_results (game_id, club_id, winner, played_at, host_player_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (game_id) DO UPDATE
       SET winner = EXCLUDED.winner,
           played_at = EXCLUDED.played_at,
           host_player_id = EXCLUDED.host_player_id
     WHERE game_results.club_id = EXCLUDED.club_id`,
    [gameId, clubId, results.winner, results.playedAt, results.hostPlayerId],
  );
  await client.query("DELETE FROM game_player_results WHERE game_id = $1", [gameId]);
  for (const player of results.players) {
    await client.query(
      `INSERT INTO game_player_results
         (game_id, player_id, seat, role, team, final_status, fouls, won, best_move_hits)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $5 = $8, $9)`,
      [
        gameId,
        player.playerId,
        player.seat,
        player.role,
        player.team,
        player.status,
        player.fouls,
        results.winner,
        player.bestMoveHits ?? null,
      ],
    );
  }
  await updateLastPlayed(client, [...affected]);
};

const synchronizeAggregate = async (
  client: PoolClient,
  clubId: string,
  gameId: string,
  state: StoredGameSessionState,
  results: StoredGameResults | null,
): Promise<void> => {
  await replaceLogTail(client, clubId, gameId, state.log);
  await replaceResults(client, clubId, gameId, results);
  if (results === null) await replaceActiveRoster(client, clubId, gameId, state);
  else await client.query("DELETE FROM game_session_players WHERE game_id = $1", [gameId]);
};

const mutationRequest = (input: SaveGameSessionInput) => ({
  name: input.name.trim(),
  baseRevision: input.baseRevision,
  state: input.state,
  results: input.results,
});

const allocateCanonicalName = async (
  client: PoolClient,
  clubId: string,
  requestedName: string,
): Promise<string> => {
  const match = /^(\d{2}\.\d{2}\.\d{2})(?:\s+#\d+)?$/.exec(requestedName.trim());
  if (match === null) return requestedName.trim();
  const date = match[1]!;
  const allocated = await client.query<{ last_number: number }>(
    `INSERT INTO game_daily_counters (club_id, game_date, last_number)
     VALUES ($1, TO_DATE($2, 'DD.MM.YY'), 1)
     ON CONFLICT (club_id, game_date) DO UPDATE
       SET last_number = game_daily_counters.last_number + 1
     RETURNING last_number`,
    [clubId, date],
  );
  return `${date} #${allocated.rows[0]!.last_number}`;
};

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

  public async clear(
    gameId: string,
    expectedRevision?: number,
    clubId = DEFAULT_CLUB_ID,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockAggregateProjectionTables(client);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [gameId]);
      const current = await client.query<{ revision: number }>(
        "SELECT revision FROM game_sessions WHERE id = $1 AND club_id = $2 FOR UPDATE",
        [gameId, clubId],
      );
      const currentRevision = current.rows[0]?.revision ?? 0;
      if (expectedRevision !== undefined && currentRevision !== expectedRevision) {
        const deleted = await client.query(
          "SELECT 1 FROM deleted_games WHERE game_id = $1 AND club_id = $2",
          [gameId, clubId],
        );
        if (current.rowCount !== 0 || deleted.rowCount === 0) {
          throw new GameSessionConflictError(currentRevision);
        }
        await client.query("COMMIT");
        return;
      }
      await client.query(
        `INSERT INTO deleted_games (game_id, club_id) VALUES ($1, $2)
         ON CONFLICT (game_id) DO NOTHING`,
        [gameId, clubId],
      );
      const affectedPlayers = await client.query<{ player_id: string }>(
        `SELECT player_id FROM game_player_results WHERE game_id = $1
         UNION
         SELECT host_player_id AS player_id
           FROM game_results
          WHERE game_id = $1
            AND host_player_id IS NOT NULL`,
        [gameId],
      );
      await client.query("DELETE FROM game_sessions WHERE id = $1 AND club_id = $2", [
        gameId,
        clubId,
      ]);
      await client.query("DELETE FROM game_events WHERE game_id = $1 AND club_id = $2", [
        gameId,
        clubId,
      ]);
      await client.query("DELETE FROM game_results WHERE game_id = $1 AND club_id = $2", [
        gameId,
        clubId,
      ]);
      const affectedPlayerIds = affectedPlayers.rows.map(({ player_id }) => player_id);
      await updateLastPlayed(client, affectedPlayerIds);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async listActive(clubId = DEFAULT_CLUB_ID): Promise<readonly GameSessionSummary[]> {
    const result = await this.pool.query<SessionRow>(
      `SELECT ${sessionColumns}
         FROM game_sessions
        WHERE status = 'active' AND club_id = $1
        ORDER BY updated_at DESC, id`,
      [clubId],
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

  public async get(gameId: string, clubId = DEFAULT_CLUB_ID): Promise<StoredGameSession | null> {
    const result = await this.pool.query<SessionRow>(
      `SELECT ${sessionColumns} FROM game_sessions WHERE id = $1 AND club_id = $2`,
      [gameId, clubId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapSession(row, false);
  }

  public async save(input: SaveGameSessionInput): Promise<StoredGameSession> {
    const clubId = input.clubId ?? DEFAULT_CLUB_ID;
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
          WHERE mutation.game_id = $1 AND mutation.mutation_id = $2 AND session.club_id = $3`,
        [input.gameId, input.mutationId, clubId],
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
        `SELECT ${sessionColumns} FROM game_sessions WHERE id = $1 AND club_id = $2 FOR UPDATE`,
        [input.gameId, clubId],
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
              SET revision = $2, last_mutation_id = $3,
                  state = $4::jsonb, status = $5, results = $6::jsonb, updated_at = NOW()
            WHERE id = $1
          RETURNING ${sessionColumns}`,
          [
            input.gameId,
            nextRevision,
            input.mutationId,
            JSON.stringify(input.state),
            status,
            input.results === null ? null : JSON.stringify(input.results),
          ],
        );
        await synchronizeAggregate(client, clubId, input.gameId, input.state, input.results);
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
      const canonicalName = await allocateCanonicalName(client, clubId, input.name);
      const status = input.results === null ? "active" : "completed";
      const inserted = await client.query<SessionRow>(
        `INSERT INTO game_sessions
           (id, club_id, name, revision, last_mutation_id, state, status, results)
         VALUES ($1, $2, $3, 1, $4, $5::jsonb, $6, $7::jsonb)
         RETURNING ${sessionColumns}`,
        [
          input.gameId,
          clubId,
          canonicalName,
          input.mutationId,
          JSON.stringify(input.state),
          status,
          input.results === null ? null : JSON.stringify(input.results),
        ],
      );
      await client.query(
        `INSERT INTO game_events
           (id, club_id, game_id, sequence, idempotency_key, event_type, phase, payload, secret)
         VALUES ($1, $2, $3, 1, 'game-created', 'game.created', 'setup-players', $4::jsonb, FALSE)`,
        [randomUUID(), clubId, input.gameId, JSON.stringify({ name: canonicalName })],
      );
      await synchronizeAggregate(client, clubId, input.gameId, input.state, input.results);
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
