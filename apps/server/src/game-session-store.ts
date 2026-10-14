import { randomUUID } from "node:crypto";

import { CASPER_PLAYER_ID, CASPER_SEAT } from "@mafia/game-domain";
import type { Pool, PoolClient } from "pg";
import { DEFAULT_CLUB_ID } from "./club-store.js";
import { DeletedGameError, lockAggregateProjectionTables, lockClubGame } from "./game-lifecycle.js";
import { initializeSchema } from "./initialize-schema.js";
import { assertSupportedGame, validateGameIdentities } from "./game-session-identity.js";
import { adjudicationMetadataSchema } from "./game-session-validation.js";

export type GameSessionState = Readonly<Record<string, unknown>>;
export type FinalGameResults = Readonly<Record<string, unknown>>;

export interface CreateGameSessionInput {
  readonly clubId?: string;
  readonly creationId: string;
  readonly name: string;
  readonly state: GameSessionState;
  readonly results: FinalGameResults | null;
}

export interface SaveGameSessionInput {
  readonly clubId?: string;
  readonly gameId: string;
  readonly name: string;
  readonly mutationId: string;
  readonly state: GameSessionState;
  readonly results: FinalGameResults | null;
}

export interface StoredGameSession {
  readonly gameId: string;
  readonly name: string;
  readonly revision: number;
  readonly duplicate: boolean;
  readonly status: "active" | "completed";
  readonly rulesetId: string;
  readonly rulesetVersion: number;
  readonly updatedAt: Date;
  readonly state: GameSessionState;
  readonly results: FinalGameResults | null;
}

export interface GameSessionSummary {
  readonly gameId: string;
  readonly name: string;
  readonly revision: number;
  readonly hostPlayerId: string | null;
  readonly phase: string;
  readonly day: number;
  readonly updatedAt: Date;
}

export interface CompletedGameSessionFilters {
  readonly from?: string;
  readonly to?: string;
  readonly playerId?: string;
  readonly outcome?: "red" | "black" | "draw" | "cancelled";
}

export interface CompletedGameSessionSummary {
  readonly gameId: string;
  readonly name: string;
  readonly revision: number;
  readonly hostPlayerId: string | null;
  readonly outcome: "red" | "black" | "draw" | "cancelled";
  readonly winner: "red" | "black" | null;
  readonly reason: string | null;
  readonly rulesetId: string;
  readonly rulesetVersion: number;
  readonly playedAt: string;
  readonly day: number;
  readonly eventCount: number;
  readonly updatedAt: Date;
}

export class GameSessionOperationError extends Error {
  public override readonly name: string = "GameSessionOperationError";

  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class GameSessionNotFoundError extends GameSessionOperationError {
  public override readonly name = "GameSessionNotFoundError";

  public constructor() {
    super("game_session_not_found", "The game session does not exist in the selected club");
  }
}

/** Bound new result metadata without interpreting rules or altering saved JSON. */
export const assertValidResultAdjudication = (results: FinalGameResults | null): void => {
  if (
    results !== null &&
    results.adjudication !== undefined &&
    !adjudicationMetadataSchema.safeParse(results.adjudication).success
  ) {
    throw new GameSessionOperationError(
      "invalid_game_adjudication",
      "Invalid adjudication metadata",
    );
  }
};

interface SessionRow {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly state: GameSessionState;
  readonly results: FinalGameResults | null;
  readonly status: "active" | "completed";
  readonly ruleset_id: string;
  readonly ruleset_version: number;
  readonly updated_at: Date;
}

interface CompletedSessionRow extends SessionRow {
  readonly event_count: number;
}

const sessionColumns = `id, name, revision, state, results, status,
                        ruleset_id, ruleset_version, updated_at`;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string =>
  typeof value === "string" && uuidPattern.test(value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);
const asInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null;

const mapSession = (row: SessionRow, duplicate: boolean): StoredGameSession => ({
  gameId: row.id,
  name: row.name,
  revision: row.revision,
  duplicate,
  status: row.status,
  rulesetId: row.ruleset_id,
  rulesetVersion: row.ruleset_version,
  updatedAt: row.updated_at,
  state: row.state,
  results: row.results,
});

const sessionSummary = (row: SessionRow): GameSessionSummary => {
  assertSupportedGame(row.state, row.results);
  const state = isRecord(row.state) ? row.state : {};
  const game = isRecord(state.game) ? state.game : null;
  const setup = isRecord(state.setup) ? state.setup : null;
  return {
    gameId: row.id,
    name: row.name,
    revision: row.revision,
    hostPlayerId:
      asString(state.hostPlayerId) ||
      asString(setup?.hostPlayerId) ||
      (isRecord(row.results) ? asString(row.results.hostPlayerId) : null) ||
      null,
    phase: asString(game?.phase) ?? asString(setup?.step) ?? "setup",
    day: asInteger(game?.day) ?? 0,
    updatedAt: row.updated_at,
  };
};

const assertSupportedEvents = async (
  client: Pool | PoolClient,
  clubId: string,
  gameIds: readonly string[],
): Promise<void> => {
  if (gameIds.length === 0) return;
  const events = await client.query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM game_events WHERE club_id = $1 AND game_id = ANY($2::uuid[])",
    [clubId, gameIds],
  );
  assertSupportedGame({ events: events.rows.map(({ payload }) => ({ payload })) }, null);
};

const updateLastPlayed = async (
  client: PoolClient,
  clubId: string,
  playerIds: readonly string[],
): Promise<void> => {
  const uniqueIds = [...new Set(playerIds)];
  if (uniqueIds.length === 0) return;
  await client.query(
    `UPDATE players AS player
        SET last_played_at = (
              SELECT MAX(history.played_at)
                FROM (
                  SELECT result.played_at
                    FROM game_player_results AS player_result
                    JOIN game_results AS result
                      ON result.club_id = player_result.club_id
                     AND result.game_id = player_result.game_id
                   WHERE player_result.club_id = player.club_id
                     AND player_result.player_id = player.id
                  UNION ALL
                  SELECT result.played_at
                    FROM game_results AS result
                   WHERE result.club_id = player.club_id
                     AND result.host_player_id = player.id
                     AND result.outcome <> 'cancelled'
                ) AS history
            ),
            updated_at = NOW()
      WHERE player.club_id = $2 AND player.id = ANY($1::uuid[])`,
    [uniqueIds, clubId],
  );
};

export interface ProjectableResults {
  readonly hostPlayerId: string;
  readonly outcome: "red" | "black" | "draw" | "cancelled";
  readonly winner: "red" | "black" | null;
  readonly reason: string | null;
  readonly playedAt: string;
  readonly players: readonly {
    readonly playerId: string;
    readonly seat: number;
    readonly role: "sheriff" | "citizen" | "mafia" | "don";
    readonly team: "red" | "black";
    readonly status: "active" | "eliminated" | "red-carded";
    readonly fouls: number;
    readonly bestMoveHits: number | null;
  }[];
}

export const projectableResults = (value: FinalGameResults | null): ProjectableResults | null => {
  if (!isRecord(value)) return null;
  const hostPlayerId = value.hostPlayerId;
  const outcome = value.outcome;
  const winner = value.winner;
  const reason = value.reason;
  const playedAt = value.playedAt;
  if (
    !isUuid(hostPlayerId) ||
    !["red", "black", "draw", "cancelled"].includes(String(outcome)) ||
    !["red", "black", null].includes(winner as string | null) ||
    (reason !== null && typeof reason !== "string") ||
    typeof playedAt !== "string" ||
    Number.isNaN(Date.parse(playedAt)) ||
    !Array.isArray(value.players)
  ) {
    return null;
  }
  if (
    ((outcome === "red" || outcome === "black") && (winner !== outcome || reason !== null)) ||
    ((outcome === "draw" || outcome === "cancelled") &&
      (winner !== null ||
        typeof reason !== "string" ||
        reason.trim() === "" ||
        reason.length > 500))
  ) {
    return null;
  }
  const players = value.players.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const playerId = candidate.playerId;
    const seat = asInteger(candidate.seat);
    const role = candidate.role;
    const team = candidate.team;
    const status = candidate.status;
    const fouls = asInteger(candidate.fouls);
    const bestMoveHits =
      candidate.bestMoveHits === null || candidate.bestMoveHits === undefined
        ? null
        : asInteger(candidate.bestMoveHits);
    if (
      (!isUuid(playerId) && playerId !== CASPER_PLAYER_ID) ||
      seat === null ||
      seat < 1 ||
      seat > 10 ||
      !["sheriff", "citizen", "mafia", "don"].includes(String(role)) ||
      !["red", "black"].includes(String(team)) ||
      !["active", "eliminated", "red-carded"].includes(String(status)) ||
      fouls === null ||
      fouls < 0 ||
      (bestMoveHits !== null && (bestMoveHits < 0 || bestMoveHits > 3)) ||
      (playerId === CASPER_PLAYER_ID &&
        (seat !== CASPER_SEAT || role !== "citizen" || team !== "red"))
    ) {
      return [];
    }
    return [
      {
        playerId,
        seat,
        role: role as ProjectableResults["players"][number]["role"],
        team: team as ProjectableResults["players"][number]["team"],
        status: status as ProjectableResults["players"][number]["status"],
        fouls,
        bestMoveHits: bestMoveHits as number | null,
      },
    ];
  });
  if (
    players.length !== value.players.length ||
    (players.some(({ playerId }) => playerId === CASPER_PLAYER_ID) && players.length !== 10) ||
    new Set(players.map(({ playerId }) => playerId)).size !== players.length ||
    new Set(players.map(({ seat }) => seat)).size !== players.length
  ) {
    return null;
  }
  return {
    hostPlayerId,
    outcome: outcome as ProjectableResults["outcome"],
    winner: winner as ProjectableResults["winner"],
    reason: reason as string | null,
    playedAt,
    players,
  };
};

// The aggregate is authoritative; game_results is only a derived statistics
// projection and can be absent from an otherwise completed historical session.
export const completionMetadata = (value: FinalGameResults | null) => {
  if (!isRecord(value)) return null;
  const { outcome, winner, reason, playedAt } = value;
  if (
    (outcome !== "red" && outcome !== "black" && outcome !== "draw" && outcome !== "cancelled") ||
    (winner !== "red" && winner !== "black" && winner !== null) ||
    typeof playedAt !== "string" ||
    Number.isNaN(Date.parse(playedAt)) ||
    ((outcome === "red" || outcome === "black") && (winner !== outcome || reason !== null)) ||
    ((outcome === "draw" || outcome === "cancelled") &&
      (winner !== null ||
        typeof reason !== "string" ||
        reason.trim() === "" ||
        reason.length > 500))
  ) {
    return null;
  }
  return {
    outcome: outcome as CompletedGameSessionSummary["outcome"],
    winner: winner as CompletedGameSessionSummary["winner"],
    reason: reason as string | null,
    playedAt: new Date(playedAt).toISOString(),
  };
};

const playersBelongToClub = async (
  client: PoolClient,
  clubId: string,
  playerIds: readonly string[],
): Promise<boolean> => {
  const unique = [...new Set(playerIds)];
  if (unique.length === 0) return true;
  const result = await client.query<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM players WHERE club_id = $1 AND id = ANY($2::uuid[])",
    [clubId, unique],
  );
  return result.rows[0]?.count === unique.length;
};

const replaceResultsProjection = async (
  client: PoolClient,
  clubId: string,
  gameId: string,
  results: FinalGameResults | null,
): Promise<void> => {
  const previous = await client.query<{ player_id: string }>(
    `SELECT player_id FROM game_player_results WHERE club_id = $1 AND game_id = $2
     UNION
     SELECT host_player_id AS player_id FROM game_results
      WHERE club_id = $1 AND game_id = $2 AND host_player_id IS NOT NULL`,
    [clubId, gameId],
  );
  const projection = projectableResults(results);
  await client.query("DELETE FROM game_results WHERE club_id = $1 AND game_id = $2", [
    clubId,
    gameId,
  ]);
  if (projection === null) {
    await updateLastPlayed(
      client,
      clubId,
      previous.rows.map(({ player_id }) => player_id),
    );
    return;
  }
  // Validate the entire ten-seat roster above; only then omit Casper from UUID/FK projections.
  const realPlayers = projection.players.filter(({ playerId }) => playerId !== CASPER_PLAYER_ID);
  const participantIds = realPlayers.map(({ playerId }) => playerId);
  if (!(await playersBelongToClub(client, clubId, [projection.hostPlayerId, ...participantIds]))) {
    await updateLastPlayed(
      client,
      clubId,
      previous.rows.map(({ player_id }) => player_id),
    );
    return;
  }
  await client.query(
    `INSERT INTO game_results (club_id, game_id, outcome, winner, reason, played_at, host_player_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      clubId,
      gameId,
      projection.outcome,
      projection.winner,
      projection.reason,
      projection.playedAt,
      projection.hostPlayerId,
    ],
  );
  if (projection.outcome !== "cancelled" && realPlayers.length > 0) {
    await client.query(
      `INSERT INTO game_player_results
         (club_id, game_id, player_id, seat, role, team, final_status, fouls, won, best_move_hits)
       SELECT $1, $2, entry.player_id, entry.seat, entry.role, entry.team, entry.final_status,
              entry.fouls, CASE WHEN $3 = 'draw' THEN NULL ELSE entry.team = $4 END,
              entry.best_move_hits
         FROM UNNEST($5::uuid[], $6::int[], $7::text[], $8::text[], $9::text[], $10::int[], $11::int[])
           AS entry(player_id, seat, role, team, final_status, fouls, best_move_hits)`,
      [
        clubId,
        gameId,
        projection.outcome,
        projection.winner,
        realPlayers.map(({ playerId }) => playerId),
        realPlayers.map(({ seat }) => seat),
        realPlayers.map(({ role }) => role),
        realPlayers.map(({ team }) => team),
        realPlayers.map(({ status }) => status),
        realPlayers.map(({ fouls }) => fouls),
        realPlayers.map(({ bestMoveHits }) => bestMoveHits),
      ],
    );
  }
  const affected = new Set(previous.rows.map(({ player_id }) => player_id));
  if (projection.outcome !== "cancelled") {
    affected.add(projection.hostPlayerId);
    participantIds.forEach((id) => affected.add(id));
  }
  await updateLastPlayed(client, clubId, [...affected]);
};

const replacePlayerProjection = async (
  client: PoolClient,
  clubId: string,
  gameId: string,
  state: GameSessionState,
): Promise<void> => {
  await client.query("DELETE FROM game_session_players WHERE club_id = $1 AND game_id = $2", [
    clubId,
    gameId,
  ]);
  if (!isRecord(state)) return;
  if (state.hostPlayerId === CASPER_PLAYER_ID) return;
  const hostPlayerId = isUuid(state.hostPlayerId) ? state.hostPlayerId : null;
  const game = isRecord(state.game) ? state.game : null;
  const rawPlayers = Array.isArray(game?.players) ? game.players : [];
  const players = rawPlayers.flatMap((candidate) => {
    if (!isRecord(candidate) || (!isUuid(candidate.id) && candidate.id !== CASPER_PLAYER_ID))
      return [];
    const seat = asInteger(candidate.seat);
    if (seat === null) return [];
    const role = asString(candidate.role);
    if (
      seat < 1 ||
      seat > 10 ||
      !["sheriff", "citizen", "mafia", "don"].includes(role ?? "") ||
      (candidate.id === CASPER_PLAYER_ID &&
        (seat !== CASPER_SEAT || role !== "citizen" || candidate.team !== "red"))
    )
      return [];
    return [{ id: candidate.id, seat, role }];
  });
  if (
    players.length !== rawPlayers.length ||
    (players.some(({ id }) => id === CASPER_PLAYER_ID) && players.length !== 10) ||
    new Set(players.map(({ id }) => id)).size !== players.length ||
    new Set(players.map(({ seat }) => seat)).size !== players.length ||
    !(await playersBelongToClub(client, clubId, [
      ...(hostPlayerId === null ? [] : [hostPlayerId]),
      ...players.filter(({ id }) => id !== CASPER_PLAYER_ID).map(({ id }) => id),
    ]))
  ) {
    return;
  }
  const all = [
    ...(hostPlayerId === null ? [] : [{ id: hostPlayerId, seat: null, isHost: true, role: null }]),
    ...players
      .filter(({ id }) => id !== CASPER_PLAYER_ID)
      .map(({ id, seat, role }) => ({ id, seat, isHost: false, role })),
  ];
  if (all.length === 0) return;
  await client.query(
    `INSERT INTO game_session_players (club_id, game_id, player_id, seat, is_host, role)
     SELECT $1, $2, entry.id, entry.seat, entry.is_host, entry.role
       FROM UNNEST($3::uuid[], $4::int[], $5::bool[], $6::text[])
         AS entry(id, seat, is_host, role)`,
    [
      clubId,
      gameId,
      all.map(({ id }) => id),
      all.map(({ seat }) => seat),
      all.map(({ isHost }) => isHost),
      all.map(({ role }) => role),
    ],
  );
};

const replaceEventProjection = async (
  client: PoolClient,
  clubId: string,
  gameId: string,
  state: GameSessionState,
): Promise<void> => {
  await client.query("DELETE FROM game_events WHERE club_id = $1 AND game_id = $2", [
    clubId,
    gameId,
  ]);
  const events = isRecord(state) && Array.isArray(state.events) ? state.events : [];
  for (const candidate of events) {
    if (!isRecord(candidate)) continue;
    const id = candidate.id;
    const sequence = asInteger(candidate.sequence);
    const type = candidate.type;
    const phase = candidate.phaseBefore;
    const payload = candidate.payload;
    if (
      !isUuid(id) ||
      sequence === null ||
      sequence < 1 ||
      typeof type !== "string" ||
      type.trim() === "" ||
      typeof phase !== "string" ||
      phase.trim() === "" ||
      !isRecord(payload)
    ) {
      continue;
    }
    await client.query(
      `INSERT INTO game_events (id, club_id, game_id, sequence, idempotency_key, event_type, phase, payload)
       VALUES ($1, $2, $3, $4, $8, $5, $6, $7::jsonb)
       ON CONFLICT DO NOTHING`,
      [id, clubId, gameId, sequence, type, phase, JSON.stringify(payload), id],
    );
  }
};

const synchronizeProjections = async (
  client: PoolClient,
  clubId: string,
  gameId: string,
  state: GameSessionState,
  results: FinalGameResults | null,
): Promise<void> => {
  await replaceEventProjection(client, clubId, gameId, state);
  await replacePlayerProjection(client, clubId, gameId, state);
  await replaceResultsProjection(client, clubId, gameId, results);
};

export class GameSessionStore {
  public constructor(private readonly pool: Pool) {}

  public async initialize(): Promise<void> {
    await initializeSchema(this.pool);
  }

  public async create(input: CreateGameSessionInput): Promise<StoredGameSession> {
    const clubId = input.clubId ?? DEFAULT_CLUB_ID;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockAggregateProjectionTables(client);
      await lockClubGame(client, clubId, `creation:${input.creationId}`);
      const existing = await client.query<{ game_id: string }>(
        `SELECT game_id FROM game_session_creations
          WHERE club_id = $1 AND creation_id = $2
          FOR UPDATE`,
        [clubId, input.creationId],
      );
      const mappedGameId = existing.rows[0]?.game_id;
      if (mappedGameId !== undefined) {
        const current = await client.query<SessionRow>(
          `SELECT ${sessionColumns} FROM game_sessions WHERE club_id = $1 AND id = $2`,
          [clubId, mappedGameId],
        );
        const row = current.rows[0];
        if (row === undefined) throw new DeletedGameError(mappedGameId);
        assertSupportedGame(row.state, row.results);
        await assertSupportedEvents(client, clubId, [mappedGameId]);
        await client.query("COMMIT");
        return mapSession(row, true);
      }
      assertValidResultAdjudication(input.results);
      await validateGameIdentities(client, clubId, input.state, input.results, true);
      const gameId = randomUUID();
      const mutationId = randomUUID();
      const status = input.results === null ? "active" : "completed";
      await client.query(
        `INSERT INTO game_session_creations (club_id, creation_id, game_id)
         VALUES ($1, $2, $3)`,
        [clubId, input.creationId, gameId],
      );
      const created = await client.query<SessionRow>(
        `INSERT INTO game_sessions
           (id, club_id, name, revision, last_mutation_id, state, results, status)
         VALUES ($1, $2, $3, 1, $4, $5::jsonb, $6::jsonb, $7)
         RETURNING ${sessionColumns}`,
        [
          gameId,
          clubId,
          input.name.trim(),
          mutationId,
          JSON.stringify(input.state),
          JSON.stringify(input.results),
          status,
        ],
      );
      const row = created.rows[0];
      if (row === undefined) throw new Error("The created game session was not returned");
      await synchronizeProjections(client, clubId, gameId, input.state, input.results);
      await client.query("COMMIT");
      return mapSession(row, false);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async save(input: SaveGameSessionInput): Promise<StoredGameSession> {
    const clubId = input.clubId ?? DEFAULT_CLUB_ID;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockAggregateProjectionTables(client);
      await lockClubGame(client, clubId, input.gameId);
      const existing = await client.query<SessionRow>(
        `SELECT ${sessionColumns} FROM game_sessions
          WHERE club_id = $1 AND id = $2
          FOR UPDATE`,
        [clubId, input.gameId],
      );
      const current = existing.rows[0];
      if (current === undefined) throw new GameSessionNotFoundError();
      assertSupportedGame(current.state, current.results);
      await assertSupportedEvents(client, clubId, [input.gameId]);
      assertValidResultAdjudication(input.results);
      await validateGameIdentities(client, clubId, input.state, input.results, false);
      const status = input.results === null ? "active" : "completed";
      const updated = await client.query<SessionRow>(
        `UPDATE game_sessions
            SET name = $3,
                revision = revision + 1,
                last_mutation_id = $4,
                state = $5::jsonb,
                results = $6::jsonb,
                status = $7,
                updated_at = NOW()
          WHERE club_id = $1 AND id = $2
          RETURNING ${sessionColumns}`,
        [
          clubId,
          input.gameId,
          input.name.trim(),
          input.mutationId,
          JSON.stringify(input.state),
          JSON.stringify(input.results),
          status,
        ],
      );
      const row = updated.rows[0];
      if (row === undefined) throw new GameSessionNotFoundError();
      await synchronizeProjections(client, clubId, input.gameId, input.state, input.results);
      await client.query("COMMIT");
      return mapSession(row, false);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async clear({
    clubId = DEFAULT_CLUB_ID,
    gameId,
  }: {
    readonly clubId?: string;
    readonly gameId: string;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockAggregateProjectionTables(client);
      await lockClubGame(client, clubId, gameId);
      const current = await client.query<{ id: string }>(
        "SELECT id FROM game_sessions WHERE club_id = $1 AND id = $2 FOR UPDATE",
        [clubId, gameId],
      );
      if (current.rowCount !== 0) {
        const affected = await client.query<{ player_id: string }>(
          `SELECT player_id FROM game_player_results WHERE club_id = $1 AND game_id = $2
           UNION
           SELECT host_player_id AS player_id FROM game_results
            WHERE club_id = $1 AND game_id = $2 AND host_player_id IS NOT NULL`,
          [clubId, gameId],
        );
        await client.query("DELETE FROM game_sessions WHERE club_id = $1 AND id = $2", [
          clubId,
          gameId,
        ]);
        await client.query("DELETE FROM game_events WHERE club_id = $1 AND game_id = $2", [
          clubId,
          gameId,
        ]);
        await client.query("DELETE FROM game_results WHERE club_id = $1 AND game_id = $2", [
          clubId,
          gameId,
        ]);
        await updateLastPlayed(
          client,
          clubId,
          affected.rows.map(({ player_id }) => player_id),
        );
      }
      await client.query(
        `INSERT INTO deleted_games (club_id, game_id)
         VALUES ($1, $2)
         ON CONFLICT (club_id, game_id) DO NOTHING`,
        [clubId, gameId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async get(gameId: string, clubId = DEFAULT_CLUB_ID): Promise<StoredGameSession | null> {
    const result = await this.pool.query<SessionRow>(
      `SELECT ${sessionColumns} FROM game_sessions WHERE club_id = $1 AND id = $2`,
      [clubId, gameId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    assertSupportedGame(row.state, row.results);
    await assertSupportedEvents(this.pool, clubId, [gameId]);
    return mapSession(row, false);
  }

  public async listActive(clubId = DEFAULT_CLUB_ID): Promise<readonly GameSessionSummary[]> {
    const result = await this.pool.query<SessionRow>(
      `SELECT ${sessionColumns} FROM game_sessions
        WHERE club_id = $1 AND status = 'active'
        ORDER BY updated_at DESC, id`,
      [clubId],
    );
    result.rows.forEach((row) => assertSupportedGame(row.state, row.results));
    await assertSupportedEvents(
      this.pool,
      clubId,
      result.rows.map(({ id }) => id),
    );
    return result.rows.map(sessionSummary);
  }

  public async listCompleted(
    clubId = DEFAULT_CLUB_ID,
    filters: CompletedGameSessionFilters = {},
  ): Promise<readonly CompletedGameSessionSummary[]> {
    if (
      filters.playerId !== undefined &&
      (
        await this.pool.query<{ id: string }>(
          "SELECT id FROM players WHERE club_id = $1 AND id = $2",
          [clubId, filters.playerId],
        )
      ).rows.length === 0
    ) {
      return [];
    }
    const result = await this.pool.query<CompletedSessionRow>(
      `SELECT ${sessionColumns}, COALESCE(events.event_count, 0)::int AS event_count
         FROM game_sessions
         LEFT JOIN (
           SELECT game_id, COUNT(*)::int AS event_count
             FROM game_events
            WHERE club_id = $1
            GROUP BY game_id
         ) AS events ON events.game_id = game_sessions.id
        WHERE game_sessions.club_id = $1 AND game_sessions.status = 'completed'
        ORDER BY game_sessions.updated_at DESC, game_sessions.id`,
      [clubId],
    );
    result.rows.forEach((row) => assertSupportedGame(row.state, row.results));
    await assertSupportedEvents(
      this.pool,
      clubId,
      result.rows.map(({ id }) => id),
    );
    return result.rows.flatMap((row) => {
      const completion = completionMetadata(row.results);
      if (completion === null) return [];
      const day = completion.playedAt.slice(0, 10);
      if (
        (filters.from !== undefined && day < filters.from) ||
        (filters.to !== undefined && day > filters.to) ||
        (filters.outcome !== undefined && completion.outcome !== filters.outcome) ||
        (filters.playerId !== undefined &&
          (!isRecord(row.results) ||
            !Array.isArray(row.results.players) ||
            !row.results.players.some(
              (player: unknown) => isRecord(player) && player.playerId === filters.playerId,
            )))
      ) {
        return [];
      }
      const summary = sessionSummary(row);
      return [
        {
          ...summary,
          ...completion,
          rulesetId: row.ruleset_id,
          rulesetVersion: row.ruleset_version,
          eventCount: row.event_count,
        },
      ];
    });
  }
}
