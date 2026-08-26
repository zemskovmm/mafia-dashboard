import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  createGameLogEntry,
  isMeaningfulGameEventDraft,
  replayGameLog,
  type CanonicalGameEventType,
  type GameLogEntry,
  type GamePhase,
  type GameState,
  type InitialGameBaseline,
} from "@mafia/game-domain";
import type { Pool, PoolClient } from "pg";
import {
  assertClubGameNotDeleted,
  lockAggregateProjectionTables,
  lockClubGame,
} from "./game-lifecycle.js";
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

interface StoredCanonicalGameEvent {
  readonly replayVersion: 1;
  readonly id: string;
  readonly gameId: string;
  readonly sequence: number;
  readonly parentEventId: string | null;
  readonly type: CanonicalGameEventType;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly secret: boolean;
  readonly phaseBefore: GamePhase;
  readonly phaseAfter: GamePhase;
  readonly dayBefore: number;
  readonly dayAfter: number;
  readonly stateHashAfter: string;
  readonly createdAt: string;
}

interface StoredGameSessionState {
  readonly setup: unknown | null;
  readonly game: GameState | null;
  readonly hostPlayerId: string | null;
  readonly hostName: string | null;
  readonly playlistId: string;
  readonly log: readonly StoredGameLogEntry[];
  readonly undoHistory: readonly StoredUndoSnapshot[];
  readonly initialGame?: InitialGameBaseline | null;
  readonly events?: readonly StoredCanonicalGameEvent[];
  readonly headEventId?: string | null;
  readonly resetReturnEventId?: string | null;
  readonly legacyLog?: readonly StoredGameLogEntry[];
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
    readonly bestMoveHits?: number | null;
  }[];
}

const resultsFromCompletedGame = (
  game: GameState,
  event: GameLogEntry,
  hostPlayerId: string | null,
): StoredGameResults | null => {
  if (game.phase !== "finished" || game.winner === null || hostPlayerId === null) return null;
  return {
    hostPlayerId,
    winner: game.winner,
    playedAt: event.createdAt,
    players: game.players.map((player) => ({
      playerId: player.id,
      seat: player.seat,
      role: player.role,
      team: player.role === "mafia" || player.role === "don" ? "black" : "red",
      status: player.status,
      fouls: player.fouls,
      bestMoveHits:
        game.bestMove?.playerSeat === player.seat && game.bestMove.mafiaHits !== undefined
          ? game.bestMove.mafiaHits
          : null,
    })),
  };
};

export interface NormalizeGameSessionInput {
  readonly clubId?: string;
  readonly gameId: string;
  readonly mutationId: string;
  readonly baseRevision: number;
}

export interface StartGameSessionInput extends NormalizeGameSessionInput {
  readonly initialGame: InitialGameBaseline;
  readonly event: GameLogEntry;
}

export interface AppendGameSessionEventInput extends NormalizeGameSessionInput {
  readonly event: GameLogEntry;
}

export interface MoveGameSessionHeadInput extends NormalizeGameSessionInput {
  readonly targetEventId: string;
  readonly reason: "undo" | "reset" | "restore-reset";
}

export interface CompleteGameSessionInput extends NormalizeGameSessionInput {
  readonly results: StoredGameResults;
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
  readonly replayBaseEventId?: string | null;
  readonly previewableFromEventId?: string | null;
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

export interface CompletedGameSessionSummary {
  readonly gameId: string;
  readonly name: string;
  readonly revision: number;
  readonly hostName: string | null;
  readonly winner: "red" | "black";
  readonly playedAt: string;
  readonly day: number;
  readonly eventCount: number;
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
  initial_game: InitialGameBaseline | null;
  replay_base_event_id: string | null;
  head_event_id: string | null;
  reset_return_event_id: string | null;
  reset_return_was_completed: boolean;
  replay_version: number;
}

interface CompletedSessionRow extends SessionRow {
  event_count: number;
}

interface DuplicateSessionRow extends SessionRow {
  mutation_request: unknown | null;
}

const sessionColumns =
  "id, name, revision, status, updated_at, state, results, initial_game, " +
  "replay_base_event_id, head_event_id, reset_return_event_id, reset_return_was_completed, replay_version";

interface CanonicalEventRow {
  id: string;
  game_id: string;
  replay_sequence: number;
  parent_event_id: string | null;
  event_type: CanonicalGameEventType;
  payload: Readonly<Record<string, unknown>>;
  secret: boolean;
  phase: GamePhase;
  phase_after: GamePhase;
  day_before: number;
  day_after: number;
  replay_version: 1;
  state_hash_after: string;
  created_at: Date;
}

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

const readCanonicalEvents = async (
  queryable: Queryable,
  clubId: string,
  gameId: string,
): Promise<readonly GameLogEntry[]> => {
  const result = await queryable.query<CanonicalEventRow>(
    `SELECT id, game_id, replay_sequence, parent_event_id, event_type, payload, secret,
            phase, phase_after, day_before, day_after, replay_version, state_hash_after,
            created_at
       FROM game_events
      WHERE club_id = $1 AND game_id = $2 AND replay_sequence IS NOT NULL
      ORDER BY replay_sequence`,
    [clubId, gameId],
  );
  return result.rows.map(
    (row): GameLogEntry =>
      ({
        replayVersion: row.replay_version,
        id: row.id,
        gameId: row.game_id,
        sequence: row.replay_sequence,
        parentEventId: row.parent_event_id,
        type: row.event_type,
        payload: row.payload,
        secret: row.secret,
        phaseBefore: row.phase,
        phaseAfter: row.phase_after,
        dayBefore: row.day_before,
        dayAfter: row.day_after,
        stateHashAfter: row.state_hash_after,
        createdAt: row.created_at.toISOString(),
      }) as GameLogEntry,
  );
};

const activeEventsFor = (
  events: readonly GameLogEntry[],
  headEventId: string | null,
): readonly GameLogEntry[] => {
  if (headEventId === null) return [];
  const byId = new Map(events.map((event) => [event.id, event]));
  const reversed: GameLogEntry[] = [];
  const visited = new Set<string>();
  let currentId: string | null = headEventId;
  while (currentId !== null) {
    if (visited.has(currentId)) throw new Error(`Game history contains a cycle at ${currentId}`);
    visited.add(currentId);
    const event = byId.get(currentId);
    if (event === undefined) throw new Error(`Game history is missing ${currentId}`);
    reversed.push(event);
    currentId = event.parentEventId;
  }
  return reversed.reverse();
};

const activeEventsForState = (state: StoredGameSessionState): readonly GameLogEntry[] =>
  activeEventsFor(
    (state.events ?? []) as unknown as readonly GameLogEntry[],
    state.headEventId ?? null,
  );

const deriveCurrentGame = (state: StoredGameSessionState): GameState | null => {
  if (state.initialGame == null) return state.game;
  return replayGameLog(state.initialGame, activeEventsForState(state)).game;
};

const mapSession = (row: SessionRow, duplicate: boolean): StoredGameSession => ({
  gameId: row.id,
  name: row.name,
  revision: row.revision,
  duplicate,
  status: row.status,
  updatedAt: row.updated_at,
  state: { ...row.state, game: deriveCurrentGame(row.state) },
  results: row.results,
});

const hydrateSession = async (
  queryable: Queryable,
  row: SessionRow,
  clubId: string,
  duplicate: boolean,
  revision = row.revision,
): Promise<StoredGameSession> => {
  const events = await readCanonicalEvents(queryable, clubId, row.id);
  const initialGame = row.initial_game;
  const headEventId = row.head_event_id;
  const activeEvents = activeEventsFor(events, headEventId);
  const game =
    initialGame === null
      ? (row.state.game ?? null)
      : replayGameLog(initialGame, activeEvents, row.id).game;
  const log =
    initialGame === null
      ? (row.state.log ?? [])
      : activeEvents.map((event): StoredGameLogEntry => ({
          id: event.id,
          sequence: event.sequence,
          type: event.type,
          phase: event.phaseAfter,
          payload: event.payload as Readonly<Record<string, unknown>>,
          secret: event.secret,
          createdAt: event.createdAt,
        }));
  return {
    gameId: row.id,
    name: row.name,
    revision,
    duplicate,
    status: row.status,
    updatedAt: row.updated_at,
    state: {
      ...row.state,
      setup: row.state.setup ?? null,
      game,
      hostPlayerId: row.state.hostPlayerId ?? null,
      hostName: row.state.hostName ?? null,
      playlistId: row.state.playlistId ?? "",
      log,
      undoHistory: [],
      initialGame,
      events: events as unknown as readonly StoredCanonicalGameEvent[],
      headEventId,
      resetReturnEventId: row.reset_return_event_id,
    },
    results: row.results,
    replayBaseEventId: row.replay_base_event_id,
    previewableFromEventId: row.replay_base_event_id,
  };
};

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
  await client.query("DELETE FROM game_session_players WHERE club_id = $1 AND game_id = $2", [
    clubId,
    gameId,
  ]);
  const rosterState = state as RosterState;
  const hostPlayerId = rosterState.hostPlayerId ?? rosterState.setup?.hostPlayerId;
  if (hostPlayerId !== undefined && hostPlayerId !== null && hostPlayerId !== "") {
    await client.query(
      `INSERT INTO game_session_players (club_id, game_id, player_id, seat, is_host)
       VALUES ($1, $2, $3, NULL, TRUE)`,
      [clubId, gameId, hostPlayerId],
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
      `INSERT INTO game_session_players (club_id, game_id, player_id, seat, is_host)
       VALUES ($1, $2, $3, $4, FALSE)`,
      [clubId, gameId, player.id, player.seat],
    );
  }
};

const synchronizeEventLog = async (
  client: PoolClient,
  clubId: string,
  gameId: string,
  state: StoredGameSessionState,
): Promise<void> => {
  if (state.events !== undefined) {
    for (const entry of state.events) {
      await writeCanonicalEvent(client, clubId, entry as unknown as GameLogEntry);
    }
    return;
  }

  for (const entry of state.log) {
    const seat = typeof entry.payload.seat === "number" ? entry.payload.seat : null;
    const existing = await client.query<{
      id: string;
      game_id: string;
      event_type: string;
      phase: string;
      seat: number | null;
      payload: Readonly<Record<string, unknown>>;
      secret: boolean;
      created_at: Date;
    }>(
      `SELECT id, game_id, event_type, phase, seat, payload, secret, created_at
         FROM game_events
        WHERE club_id = $1
          AND (id = $3 OR (game_id = $2 AND idempotency_key = $3::text))
        ORDER BY (id = $3) DESC
        LIMIT 1`,
      [clubId, gameId, entry.id],
    );
    const existingRow = existing.rows[0];
    if (existingRow !== undefined) {
      if (
        existingRow.id === entry.id &&
        existingRow.game_id === gameId &&
        existingRow.event_type === entry.type &&
        existingRow.phase === entry.phase &&
        existingRow.seat === seat &&
        isDeepStrictEqual(existingRow.payload, entry.payload) &&
        existingRow.secret === entry.secret &&
        existingRow.created_at.toISOString() === entry.createdAt
      ) {
        continue;
      }
      throw new GameSessionOperationError(
        "game_session_event_conflict",
        "A legacy event ID is already bound to immutable event content",
      );
    }
    const allocated = await client.query<{ sequence: number }>(
      `SELECT COALESCE(MAX(sequence), 0)::int + 1 AS sequence
         FROM game_events
        WHERE club_id = $1 AND game_id = $2`,
      [clubId, gameId],
    );
    const sequence = allocated.rows[0]?.sequence;
    if (sequence === undefined) throw new Error("Unable to allocate a game event sequence");
    const inserted = await client.query(
      `INSERT INTO game_events
         (id, club_id, game_id, sequence, idempotency_key, event_type, phase, seat, payload, secret,
          created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)`,
      [
        entry.id,
        clubId,
        gameId,
        sequence,
        entry.id,
        entry.type,
        entry.phase,
        seat,
        JSON.stringify(entry.payload),
        entry.secret,
        entry.createdAt,
      ],
    );
    if (inserted.rowCount === 0) {
      throw new GameSessionOperationError(
        "game_session_event_conflict",
        "A legacy event ID is already bound to immutable event content",
      );
    }
  }
};

const updateLastPlayed = async (
  client: PoolClient,
  clubId: string,
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
                    JOIN game_results AS result
                      ON result.club_id = player_result.club_id
                     AND result.game_id = player_result.game_id
                   WHERE player_result.club_id = p.club_id
                     AND player_result.player_id = p.id
                  UNION ALL
                  SELECT hosted.played_at
                    FROM game_results AS hosted
                   WHERE hosted.club_id = p.club_id
                     AND hosted.host_player_id = p.id
                ) AS history
            ),
            updated_at = NOW()
      WHERE p.club_id = $2 AND p.id = ANY($1::uuid[])`,
    [affectedPlayerIds, clubId],
  );
};

const replaceResults = async (
  client: PoolClient,
  clubId: string,
  gameId: string,
  results: StoredGameResults | null,
): Promise<void> => {
  const previous = await client.query<{ player_id: string }>(
    `SELECT player_id FROM game_player_results WHERE club_id = $1 AND game_id = $2
     UNION
     SELECT host_player_id AS player_id FROM game_results
      WHERE club_id = $1 AND game_id = $2 AND host_player_id IS NOT NULL`,
    [clubId, gameId],
  );
  const affected = new Set(previous.rows.map(({ player_id }) => player_id));
  if (results === null) {
    await client.query("DELETE FROM game_results WHERE club_id = $1 AND game_id = $2", [
      clubId,
      gameId,
    ]);
    await updateLastPlayed(client, clubId, [...affected]);
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
     ON CONFLICT (club_id, game_id) DO UPDATE
       SET winner = EXCLUDED.winner,
           played_at = EXCLUDED.played_at,
           host_player_id = EXCLUDED.host_player_id`,
    [gameId, clubId, results.winner, results.playedAt, results.hostPlayerId],
  );
  await client.query("DELETE FROM game_player_results WHERE club_id = $1 AND game_id = $2", [
    clubId,
    gameId,
  ]);
  for (const player of results.players) {
    await client.query(
      `INSERT INTO game_player_results
         (club_id, game_id, player_id, seat, role, team, final_status, fouls, won,
          best_move_hits)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $6 = $9, $10)`,
      [
        clubId,
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
  await updateLastPlayed(client, clubId, [...affected]);
};

const assertResultsMatchGame = (
  state: StoredGameSessionState,
  game: GameState,
  results: StoredGameResults,
): void => {
  if (
    game.phase !== "finished" ||
    game.winner === null ||
    results.winner !== game.winner ||
    results.hostPlayerId !== state.hostPlayerId ||
    results.players.length !== game.players.length
  ) {
    throw new GameSessionOperationError(
      "game_session_results_mismatch",
      "Completion results must match the replayed finished head",
    );
  }
  const playersById = new Map(game.players.map((player) => [player.id, player]));
  for (const result of results.players) {
    const player = playersById.get(result.playerId);
    if (
      player === undefined ||
      player.seat !== result.seat ||
      player.role !== result.role ||
      player.team !== result.team ||
      player.status !== result.status ||
      player.fouls !== result.fouls ||
      (result.bestMoveHits ?? null) !==
        (game.bestMove?.playerSeat === player.seat ? (game.bestMove.mafiaHits ?? null) : null)
    ) {
      throw new GameSessionOperationError(
        "game_session_results_mismatch",
        "Completion results must match every replayed player",
      );
    }
  }
};

const synchronizeLegacyAggregate = async (
  client: PoolClient,
  clubId: string,
  gameId: string,
  state: StoredGameSessionState,
  results: StoredGameResults | null,
): Promise<void> => {
  await synchronizeEventLog(client, clubId, gameId, state);
  await replaceResults(client, clubId, gameId, results);
  if (results === null) {
    await replaceActiveRoster(client, clubId, gameId, {
      ...state,
      game: deriveCurrentGame(state),
    });
  } else {
    await client.query("DELETE FROM game_session_players WHERE club_id = $1 AND game_id = $2", [
      clubId,
      gameId,
    ]);
  }
};

const metadataOnlyState = (
  state: StoredGameSessionState,
  legacyLog = state.legacyLog,
): StoredGameSessionState =>
  ({
    setup: state.setup ?? null,
    hostPlayerId: state.hostPlayerId ?? null,
    hostName: state.hostName ?? null,
    playlistId: state.playlistId ?? "",
    ...(legacyLog === undefined || legacyLog.length === 0 ? {} : { legacyLog }),
  }) as unknown as StoredGameSessionState;

interface StoredCanonicalEventRow {
  readonly id: string;
  readonly club_id: string;
  readonly game_id: string;
  readonly idempotency_key: string;
  readonly event_type: CanonicalGameEventType;
  readonly phase: GamePhase;
  readonly phase_after: GamePhase;
  readonly day_before: number;
  readonly day_after: number;
  readonly seat: number | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly secret: boolean;
  readonly parent_event_id: string | null;
  readonly replay_version: number;
  readonly replay_sequence: number;
  readonly state_hash_after: string;
  readonly created_at: Date;
}

const eventConflict = (): GameSessionOperationError =>
  new GameSessionOperationError(
    "game_session_event_conflict",
    "A canonical event ID or idempotency key is already bound to immutable event content",
  );

const storedEventMatches = (
  row: StoredCanonicalEventRow,
  clubId: string,
  event: GameLogEntry,
  seat: number | null,
): boolean =>
  row.id === event.id &&
  row.club_id === clubId &&
  row.game_id === event.gameId &&
  row.idempotency_key === event.id &&
  row.event_type === event.type &&
  row.phase === event.phaseBefore &&
  row.phase_after === event.phaseAfter &&
  row.day_before === event.dayBefore &&
  row.day_after === event.dayAfter &&
  row.seat === seat &&
  isDeepStrictEqual(row.payload, event.payload) &&
  row.secret === event.secret &&
  row.parent_event_id === event.parentEventId &&
  row.replay_version === event.replayVersion &&
  row.replay_sequence === event.sequence &&
  row.state_hash_after === event.stateHashAfter &&
  row.created_at.toISOString() === event.createdAt;

const writeCanonicalEvent = async (
  client: PoolClient,
  clubId: string,
  event: GameLogEntry,
): Promise<void> => {
  const seat =
    typeof (event.payload as Readonly<Record<string, unknown>>).seat === "number"
      ? ((event.payload as Readonly<Record<string, unknown>>).seat as number)
      : null;
  const existing = await client.query<StoredCanonicalEventRow>(
    `SELECT id, club_id, game_id, idempotency_key, event_type, phase, phase_after,
            day_before, day_after, seat, payload, secret, parent_event_id, replay_version,
            replay_sequence, state_hash_after, created_at
       FROM game_events
      WHERE club_id = $2
        AND (id = $1::uuid OR (game_id = $3 AND idempotency_key = $1::text))
      ORDER BY (id = $1::uuid) DESC
      LIMIT 1`,
    [event.id, clubId, event.gameId],
  );
  const existingRow = existing.rows[0];
  if (existingRow !== undefined) {
    if (storedEventMatches(existingRow, clubId, event, seat)) return;
    throw eventConflict();
  }

  const allocated = await client.query<{ sequence: number }>(
    `SELECT COALESCE(MAX(sequence), 0)::int + 1 AS sequence
       FROM game_events
      WHERE club_id = $1 AND game_id = $2`,
    [clubId, event.gameId],
  );
  const sequence = allocated.rows[0]?.sequence;
  if (sequence === undefined) throw new Error("Unable to allocate a game event sequence");
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO game_events
       (id, club_id, game_id, sequence, idempotency_key, event_type, phase, phase_after,
        day_before, day_after, seat, payload, secret, parent_event_id, replay_version,
        replay_sequence, state_hash_after, created_at)
     VALUES
       ($1, $2, $3, $4, $18, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15,
        $16, $17)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      event.id,
      clubId,
      event.gameId,
      sequence,
      event.type,
      event.phaseBefore,
      event.phaseAfter,
      event.dayBefore,
      event.dayAfter,
      seat,
      JSON.stringify(event.payload),
      event.secret,
      event.parentEventId,
      event.replayVersion,
      event.sequence,
      event.stateHashAfter,
      event.createdAt,
      event.id,
    ],
  );
  if (inserted.rowCount === 0) throw eventConflict();
};

const mutationRequest = (input: SaveGameSessionInput) => ({
  name: input.name.trim(),
  baseRevision: input.baseRevision,
  state: input.state,
  results: input.results,
});

const assertSaveReplayShape = (input: SaveGameSessionInput): void => {
  const events = (input.state.events ?? []) as unknown as readonly GameLogEntry[];
  if (events.some(({ gameId }) => gameId !== input.gameId)) {
    throw new GameSessionOperationError(
      "game_session_event_conflict",
      "Every event must belong to the session game",
    );
  }
  const hasReplay =
    input.state.initialGame != null ||
    events.length > 0 ||
    input.state.headEventId != null ||
    input.state.resetReturnEventId != null;
  if (!hasReplay) return;
  throw new GameSessionOperationError(
    "game_session_incremental_required",
    "Canonical replay history must use the dedicated incremental operation endpoints",
  );
};

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
      await lockClubGame(client, clubId, gameId);
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
         ON CONFLICT (club_id, game_id) DO NOTHING`,
        [gameId, clubId],
      );
      const affectedPlayers = await client.query<{ player_id: string }>(
        `SELECT player_id FROM game_player_results WHERE club_id = $2 AND game_id = $1
         UNION
         SELECT host_player_id AS player_id
           FROM game_results
          WHERE game_id = $1
            AND club_id = $2
            AND host_player_id IS NOT NULL`,
        [gameId, clubId],
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
      await updateLastPlayed(client, clubId, affectedPlayerIds);
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
    return Promise.all(
      result.rows.map(async (row) => {
        const state = row.state as StoredGameSessionState & {
          readonly setup?: { readonly step?: string } | null;
        };
        const game =
          row.initial_game === null
            ? deriveCurrentGame(state)
            : (await hydrateSession(this.pool, row, clubId, false)).state.game;
        return {
          gameId: row.id,
          name: row.name,
          revision: row.revision,
          hostName: row.state.hostName,
          phase:
            game?.phase ??
            (state.setup?.step === undefined ? "setup-players" : `setup-${state.setup.step}`),
          day: game?.day ?? 0,
          updatedAt: row.updated_at,
        };
      }),
    );
  }

  public async listCompleted(
    clubId = DEFAULT_CLUB_ID,
  ): Promise<readonly CompletedGameSessionSummary[]> {
    const result = await this.pool.query<CompletedSessionRow>(
      `SELECT ${sessionColumns},
              (SELECT COUNT(*)::int
                 FROM game_events AS event
                WHERE event.club_id = game_sessions.club_id
                  AND event.game_id = game_sessions.id) AS event_count
         FROM game_sessions
        WHERE status = 'completed' AND club_id = $1
        ORDER BY updated_at DESC, id`,
      [clubId],
    );
    const summaries = await Promise.all(
      result.rows.map(async (row): Promise<CompletedGameSessionSummary | null> => {
        if (row.results === null) return null;
        const game =
          row.initial_game === null
            ? deriveCurrentGame(row.state)
            : (await hydrateSession(this.pool, row, clubId, false)).state.game;
        return {
          gameId: row.id,
          name: row.name,
          revision: row.revision,
          hostName: row.state.hostName,
          winner: row.results.winner,
          playedAt: row.results.playedAt,
          day: game?.day ?? 0,
          eventCount: row.event_count,
          updatedAt: row.updated_at,
        };
      }),
    );
    return summaries.flatMap((summary) => (summary === null ? [] : [summary]));
  }

  public async get(gameId: string, clubId = DEFAULT_CLUB_ID): Promise<StoredGameSession | null> {
    const result = await this.pool.query<SessionRow>(
      `SELECT ${sessionColumns} FROM game_sessions WHERE id = $1 AND club_id = $2`,
      [gameId, clubId],
    );
    const row = result.rows[0];
    return row === undefined ? null : hydrateSession(this.pool, row, clubId, false);
  }

  public async normalize(input: NormalizeGameSessionInput): Promise<StoredGameSession> {
    const clubId = input.clubId ?? DEFAULT_CLUB_ID;
    const request = { operation: "normalize", baseRevision: input.baseRevision } as const;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE game_events IN ROW EXCLUSIVE MODE");
      await lockClubGame(client, clubId, input.gameId);
      const current = await client.query<SessionRow>(
        `SELECT ${sessionColumns}
           FROM game_sessions
          WHERE id = $1 AND club_id = $2
          FOR UPDATE`,
        [input.gameId, clubId],
      );
      const row = current.rows[0];
      if (row === undefined) throw new GameSessionNotFoundError();

      const duplicate = await client.query<{ revision: number; request: unknown | null }>(
        `SELECT revision, request
           FROM game_session_mutations
          WHERE club_id = $3 AND game_id = $1 AND mutation_id = $2`,
        [input.gameId, input.mutationId, clubId],
      );
      const duplicateRow = duplicate.rows[0];
      if (duplicateRow !== undefined) {
        if (duplicateRow.request !== null && !isDeepStrictEqual(duplicateRow.request, request)) {
          throw new GameSessionMutationMismatchError();
        }
        const response = await hydrateSession(client, row, clubId, true);
        await client.query("COMMIT");
        return response;
      }
      if (input.baseRevision !== row.revision) throw new GameSessionConflictError(row.revision);

      let initialGame = row.initial_game ?? row.state.initialGame ?? null;
      const suppliedEvents = (row.state.events ?? []) as unknown as readonly GameLogEntry[];
      const existingEvents = await readCanonicalEvents(client, clubId, input.gameId);
      let events = suppliedEvents.length === 0 ? existingEvents : suppliedEvents;
      let legacyLog = row.state.legacyLog;
      if (initialGame === null && row.state.game !== null) {
        initialGame = { replayVersion: 1, game: row.state.game };
        const checkpoint = createGameLogEntry({
          gameId: input.gameId,
          id: randomUUID(),
          sequence: 1,
          parentEventId: null,
          createdAt: new Date().toISOString(),
          before: row.state.game,
          draft: { type: "game.checkpointed", payload: {}, secret: true },
        });
        events = [checkpoint.entry];
        legacyLog = [...(row.state.legacyLog ?? []), ...(row.state.log ?? [])];
      }
      if (events.some((event) => event.gameId !== input.gameId)) {
        throw new GameSessionOperationError(
          "game_session_event_conflict",
          "Every normalized event must belong to the session game",
        );
      }
      const roots = events.filter(
        (event) =>
          event.parentEventId === null &&
          (event.type === "game.started" || event.type === "game.checkpointed"),
      );
      if (events.length > 0 && (initialGame === null || roots.length !== 1)) {
        throw new GameSessionOperationError(
          "game_session_replay_invalid",
          "Incremental history requires one baseline and one game.started root",
        );
      }
      const headEventId = row.head_event_id ?? row.state.headEventId ?? roots[0]?.id ?? null;
      if (initialGame !== null) {
        replayGameLog(initialGame, activeEventsFor(events, headEventId), input.gameId);
      }
      for (const event of events) await writeCanonicalEvent(client, clubId, event);

      const nextRevision = row.revision + 1;
      const updated = await client.query<SessionRow>(
        `UPDATE game_sessions
            SET revision = $2, last_mutation_id = $3, state = $4::jsonb,
                initial_game = $5::jsonb, replay_base_event_id = $6, head_event_id = $7,
                reset_return_event_id = $8, replay_version = 1, updated_at = NOW()
          WHERE id = $1 AND club_id = $9
        RETURNING ${sessionColumns}`,
        [
          input.gameId,
          nextRevision,
          input.mutationId,
          JSON.stringify(metadataOnlyState(row.state, legacyLog)),
          initialGame === null ? null : JSON.stringify(initialGame),
          roots[0]?.id ?? row.replay_base_event_id,
          headEventId,
          row.reset_return_event_id ?? row.state.resetReturnEventId ?? null,
          clubId,
        ],
      );
      await client.query(
        `INSERT INTO game_session_mutations (club_id, game_id, mutation_id, revision, request)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [clubId, input.gameId, input.mutationId, nextRevision, JSON.stringify(request)],
      );
      const updatedRow = updated.rows[0];
      if (updatedRow === undefined) throw new Error("The normalized game session was not returned");
      const response = await hydrateSession(client, updatedRow, clubId, false);
      await client.query("COMMIT");
      return response;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async start(input: StartGameSessionInput): Promise<StoredGameSession> {
    const clubId = input.clubId ?? DEFAULT_CLUB_ID;
    const request = {
      operation: "start",
      baseRevision: input.baseRevision,
      initialGame: input.initialGame,
      event: input.event,
    } as const;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockAggregateProjectionTables(client);
      await lockClubGame(client, clubId, input.gameId);
      await assertClubGameNotDeleted(client, clubId, input.gameId);
      const current = await client.query<SessionRow>(
        `SELECT ${sessionColumns}
           FROM game_sessions
          WHERE id = $1 AND club_id = $2
          FOR UPDATE`,
        [input.gameId, clubId],
      );
      const row = current.rows[0];
      if (row === undefined) throw new GameSessionNotFoundError();
      const duplicate = await client.query<{ revision: number; request: unknown | null }>(
        "SELECT revision, request FROM game_session_mutations WHERE club_id = $3 AND game_id = $1 AND mutation_id = $2",
        [input.gameId, input.mutationId, clubId],
      );
      const duplicateRow = duplicate.rows[0];
      if (duplicateRow !== undefined) {
        if (duplicateRow.request !== null && !isDeepStrictEqual(duplicateRow.request, request)) {
          throw new GameSessionMutationMismatchError();
        }
        const response = await hydrateSession(client, row, clubId, true);
        await client.query("COMMIT");
        return response;
      }
      if (input.baseRevision !== row.revision) throw new GameSessionConflictError(row.revision);
      if (row.initial_game !== null || row.replay_base_event_id !== null) {
        throw new GameSessionOperationError(
          "game_session_already_started",
          "The game session already has an immutable replay baseline",
        );
      }
      if (row.state.game !== null) {
        throw new GameSessionOperationError(
          "game_session_normalization_required",
          "Normalize the legacy current snapshot before appending incremental history",
        );
      }
      if (
        input.event.gameId !== input.gameId ||
        (input.event.type !== "game.started" && input.event.type !== "game.checkpointed") ||
        input.event.sequence !== 1 ||
        input.event.parentEventId !== null
      ) {
        throw new GameSessionOperationError(
          "game_session_start_invalid",
          "The start root must be a lifecycle replay sequence 1 for this game",
        );
      }
      replayGameLog(input.initialGame, [input.event], input.gameId);
      await writeCanonicalEvent(client, clubId, input.event);

      const nextRevision = row.revision + 1;
      const metadata = metadataOnlyState(row.state);
      const updated = await client.query<SessionRow>(
        `UPDATE game_sessions
            SET revision = $2, last_mutation_id = $3, state = $4::jsonb,
                status = 'active', results = NULL, initial_game = $5::jsonb,
                replay_base_event_id = $6, head_event_id = $6,
                reset_return_event_id = NULL, replay_version = 1, updated_at = NOW()
          WHERE id = $1 AND club_id = $7
        RETURNING ${sessionColumns}`,
        [
          input.gameId,
          nextRevision,
          input.mutationId,
          JSON.stringify(metadata),
          JSON.stringify(input.initialGame),
          input.event.id,
          clubId,
        ],
      );
      await replaceActiveRoster(client, clubId, input.gameId, {
        ...metadata,
        game: input.initialGame.game,
      });
      await client.query(
        `INSERT INTO game_session_mutations (club_id, game_id, mutation_id, revision, request)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [clubId, input.gameId, input.mutationId, nextRevision, JSON.stringify(request)],
      );
      const updatedRow = updated.rows[0];
      if (updatedRow === undefined) throw new Error("The started game session was not returned");
      const response = await hydrateSession(client, updatedRow, clubId, false);
      await client.query("COMMIT");
      return response;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async appendEvent(input: AppendGameSessionEventInput): Promise<StoredGameSession> {
    const clubId = input.clubId ?? DEFAULT_CLUB_ID;
    const request = {
      operation: "event",
      baseRevision: input.baseRevision,
      event: input.event,
    } as const;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockAggregateProjectionTables(client);
      await lockClubGame(client, clubId, input.gameId);
      await assertClubGameNotDeleted(client, clubId, input.gameId);
      const current = await client.query<SessionRow>(
        `SELECT ${sessionColumns}
           FROM game_sessions
          WHERE id = $1 AND club_id = $2
          FOR UPDATE`,
        [input.gameId, clubId],
      );
      const row = current.rows[0];
      if (row === undefined) throw new GameSessionNotFoundError();
      const duplicate = await client.query<{ revision: number; request: unknown | null }>(
        "SELECT revision, request FROM game_session_mutations WHERE club_id = $3 AND game_id = $1 AND mutation_id = $2",
        [input.gameId, input.mutationId, clubId],
      );
      const duplicateRow = duplicate.rows[0];
      if (duplicateRow !== undefined) {
        if (duplicateRow.request !== null && !isDeepStrictEqual(duplicateRow.request, request)) {
          throw new GameSessionMutationMismatchError();
        }
        const response = await hydrateSession(client, row, clubId, true);
        await client.query("COMMIT");
        return response;
      }
      if (!isMeaningfulGameEventDraft(input.event)) {
        throw new GameSessionOperationError(
          "game_session_event_intermediate",
          "Only a meaningful semantic checkpoint may be stored in game history",
        );
      }
      if (input.baseRevision !== row.revision) throw new GameSessionConflictError(row.revision);
      if (row.status !== "active") {
        throw new GameSessionOperationError(
          "game_session_completed",
          "Completed sessions cannot accept new replay events",
        );
      }
      if (row.initial_game === null || row.head_event_id === null) {
        throw new GameSessionOperationError(
          "game_session_not_started",
          "Start or normalize the session before appending replay events",
        );
      }
      const events = await readCanonicalEvents(client, clubId, input.gameId);
      const expectedSequence = Math.max(0, ...events.map(({ sequence }) => sequence)) + 1;
      if (
        input.event.gameId !== input.gameId ||
        input.event.type === "game.started" ||
        input.event.parentEventId !== row.head_event_id ||
        input.event.sequence !== expectedSequence
      ) {
        throw new GameSessionOperationError(
          "game_session_event_conflict",
          "The event must belong to this game, extend the active head, and use the next replay sequence",
        );
      }
      if (!events.some(({ id }) => id === row.head_event_id)) {
        throw new GameSessionOperationError(
          "game_session_head_invalid",
          "The active head does not belong to this game and club",
        );
      }
      const replay = replayGameLog(
        row.initial_game,
        [...activeEventsFor(events, row.head_event_id), input.event],
        input.gameId,
      );
      await writeCanonicalEvent(client, clubId, input.event);

      const nextRevision = row.revision + 1;
      const updated = await client.query<SessionRow>(
        `UPDATE game_sessions
            SET revision = $2, last_mutation_id = $3, head_event_id = $4,
                reset_return_event_id = NULL, reset_return_was_completed = FALSE,
                updated_at = NOW()
          WHERE id = $1 AND club_id = $5
        RETURNING ${sessionColumns}`,
        [input.gameId, nextRevision, input.mutationId, input.event.id, clubId],
      );
      await replaceActiveRoster(client, clubId, input.gameId, {
        ...row.state,
        game: replay.game,
      });
      await client.query(
        `INSERT INTO game_session_mutations (club_id, game_id, mutation_id, revision, request)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [clubId, input.gameId, input.mutationId, nextRevision, JSON.stringify(request)],
      );
      const updatedRow = updated.rows[0];
      if (updatedRow === undefined) throw new Error("The appended game session was not returned");
      const response = await hydrateSession(client, updatedRow, clubId, false);
      await client.query("COMMIT");
      return response;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async moveHead(input: MoveGameSessionHeadInput): Promise<StoredGameSession> {
    const clubId = input.clubId ?? DEFAULT_CLUB_ID;
    const request = {
      operation: "head",
      baseRevision: input.baseRevision,
      targetEventId: input.targetEventId,
      reason: input.reason,
    } as const;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockAggregateProjectionTables(client);
      await lockClubGame(client, clubId, input.gameId);
      await assertClubGameNotDeleted(client, clubId, input.gameId);
      const current = await client.query<SessionRow>(
        `SELECT ${sessionColumns}
           FROM game_sessions
          WHERE id = $1 AND club_id = $2
          FOR UPDATE`,
        [input.gameId, clubId],
      );
      const row = current.rows[0];
      if (row === undefined) throw new GameSessionNotFoundError();
      const duplicate = await client.query<{ revision: number; request: unknown | null }>(
        "SELECT revision, request FROM game_session_mutations WHERE club_id = $3 AND game_id = $1 AND mutation_id = $2",
        [input.gameId, input.mutationId, clubId],
      );
      const duplicateRow = duplicate.rows[0];
      if (duplicateRow !== undefined) {
        if (duplicateRow.request !== null && !isDeepStrictEqual(duplicateRow.request, request)) {
          throw new GameSessionMutationMismatchError();
        }
        const response = await hydrateSession(client, row, clubId, true);
        await client.query("COMMIT");
        return response;
      }
      if (input.baseRevision !== row.revision) throw new GameSessionConflictError(row.revision);
      if (
        row.initial_game === null ||
        row.replay_base_event_id === null ||
        row.head_event_id === null
      ) {
        throw new GameSessionOperationError(
          "game_session_not_started",
          "A replay head can move only after start or normalization",
        );
      }
      const events = await readCanonicalEvents(client, clubId, input.gameId);
      const byId = new Map(events.map((event) => [event.id, event]));
      const currentHead = byId.get(row.head_event_id);
      const target = byId.get(input.targetEventId);
      if (currentHead === undefined || target === undefined) {
        throw new GameSessionOperationError(
          "game_session_head_invalid",
          "The current and target heads must belong to this game and club",
        );
      }
      let targetChain: readonly GameLogEntry[];
      try {
        targetChain = activeEventsFor(events, target.id);
      } catch {
        throw new GameSessionOperationError(
          "game_session_head_invalid",
          "The target head is not reachable from this replay base",
        );
      }
      if (targetChain[0]?.id !== row.replay_base_event_id) {
        throw new GameSessionOperationError(
          "game_session_head_invalid",
          "The target head is not reachable from this replay base",
        );
      }
      const currentChain = activeEventsFor(events, currentHead.id);
      if (input.reason === "reset" && !currentChain.some(({ id }) => id === target.id)) {
        throw new GameSessionOperationError(
          "game_session_head_invalid",
          "Reset may target only the current active branch",
        );
      }
      if (input.reason === "restore-reset" && row.reset_return_event_id !== target.id) {
        throw new GameSessionOperationError(
          "game_session_reset_return_unavailable",
          "Restore-reset must target the saved pre-reset head",
        );
      }
      if (input.reason === "undo") {
        const maxSequence = Math.max(...events.map(({ sequence }) => sequence));
        if (
          currentHead.parentEventId !== target.id ||
          maxSequence - currentHead.sequence >= 3 ||
          currentHead.dayBefore !== currentHead.dayAfter
        ) {
          throw new GameSessionOperationError(
            "game_session_undo_unavailable",
            "Undo must move one parent within the latest three actions and may not cross a day checkpoint",
          );
        }
      }
      const replay = replayGameLog(row.initial_game, targetChain, input.gameId);
      const changed = target.id !== currentHead.id;
      const nextResetReturnEventId =
        input.reason === "reset"
          ? changed
            ? currentHead.id
            : row.reset_return_event_id
          : input.reason === "restore-reset"
            ? null
            : row.reset_return_event_id;
      const nextResetReturnWasCompleted =
        input.reason === "reset"
          ? changed
            ? row.status === "completed"
            : row.reset_return_was_completed
          : input.reason === "restore-reset"
            ? false
            : row.reset_return_was_completed;
      let status = row.status;
      let results = row.results;
      if (changed && row.status === "completed") {
        await replaceResults(client, clubId, input.gameId, null);
        status = "active";
        results = null;
      }
      if (input.reason === "restore-reset" && row.reset_return_was_completed) {
        const restored = resultsFromCompletedGame(replay.game, target, row.state.hostPlayerId);
        if (restored !== null) {
          await replaceResults(client, clubId, input.gameId, restored);
          await client.query(
            "DELETE FROM game_session_players WHERE club_id = $1 AND game_id = $2",
            [clubId, input.gameId],
          );
          status = "completed";
          results = restored;
        }
      }

      const nextRevision = row.revision + 1;
      const updated = await client.query<SessionRow>(
        `UPDATE game_sessions
            SET revision = $2, last_mutation_id = $3, head_event_id = $4,
                reset_return_event_id = $5, reset_return_was_completed = $6,
                status = $7, results = $8::jsonb,
                updated_at = NOW()
          WHERE id = $1 AND club_id = $9
        RETURNING ${sessionColumns}`,
        [
          input.gameId,
          nextRevision,
          input.mutationId,
          target.id,
          nextResetReturnEventId,
          nextResetReturnWasCompleted,
          status,
          results === null ? null : JSON.stringify(results),
          clubId,
        ],
      );
      if (status === "active") {
        await replaceActiveRoster(client, clubId, input.gameId, {
          ...row.state,
          game: replay.game,
        });
      }
      await client.query(
        `INSERT INTO game_session_mutations (club_id, game_id, mutation_id, revision, request)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [clubId, input.gameId, input.mutationId, nextRevision, JSON.stringify(request)],
      );
      const updatedRow = updated.rows[0];
      if (updatedRow === undefined) throw new Error("The moved game session was not returned");
      const response = await hydrateSession(client, updatedRow, clubId, false);
      await client.query("COMMIT");
      return response;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async complete(input: CompleteGameSessionInput): Promise<StoredGameSession> {
    const clubId = input.clubId ?? DEFAULT_CLUB_ID;
    const request = {
      operation: "complete",
      baseRevision: input.baseRevision,
      results: input.results,
    } as const;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockAggregateProjectionTables(client);
      await lockClubGame(client, clubId, input.gameId);
      await assertClubGameNotDeleted(client, clubId, input.gameId);
      const current = await client.query<SessionRow>(
        `SELECT ${sessionColumns}
           FROM game_sessions
          WHERE id = $1 AND club_id = $2
          FOR UPDATE`,
        [input.gameId, clubId],
      );
      const row = current.rows[0];
      if (row === undefined) throw new GameSessionNotFoundError();
      const duplicate = await client.query<{ revision: number; request: unknown | null }>(
        "SELECT revision, request FROM game_session_mutations WHERE club_id = $3 AND game_id = $1 AND mutation_id = $2",
        [input.gameId, input.mutationId, clubId],
      );
      const duplicateRow = duplicate.rows[0];
      if (duplicateRow !== undefined) {
        if (duplicateRow.request !== null && !isDeepStrictEqual(duplicateRow.request, request)) {
          throw new GameSessionMutationMismatchError();
        }
        const response = await hydrateSession(client, row, clubId, true);
        await client.query("COMMIT");
        return response;
      }
      if (input.baseRevision !== row.revision) throw new GameSessionConflictError(row.revision);
      if (row.initial_game === null || row.head_event_id === null) {
        throw new GameSessionOperationError(
          "game_session_not_started",
          "Completion requires a replayable active head",
        );
      }
      const events = await readCanonicalEvents(client, clubId, input.gameId);
      const completionEvent = events.find(({ id }) => id === row.head_event_id);
      if (
        row.status !== "active" ||
        completionEvent?.type !== "game.completed" ||
        input.results.playedAt !== completionEvent.createdAt
      ) {
        throw new GameSessionOperationError(
          "game_session_completion_invalid",
          "Completion requires an active game.completed head and its event timestamp",
        );
      }
      const replay = replayGameLog(
        row.initial_game,
        activeEventsFor(events, row.head_event_id),
        input.gameId,
      );
      assertResultsMatchGame(row.state, replay.game, input.results);
      await replaceResults(client, clubId, input.gameId, input.results);
      await client.query("DELETE FROM game_session_players WHERE club_id = $1 AND game_id = $2", [
        clubId,
        input.gameId,
      ]);

      const nextRevision = row.revision + 1;
      const updated = await client.query<SessionRow>(
        `UPDATE game_sessions
            SET revision = $2, last_mutation_id = $3, status = 'completed',
                results = $4::jsonb, updated_at = NOW()
          WHERE id = $1 AND club_id = $5
        RETURNING ${sessionColumns}`,
        [input.gameId, nextRevision, input.mutationId, JSON.stringify(input.results), clubId],
      );
      await client.query(
        `INSERT INTO game_session_mutations (club_id, game_id, mutation_id, revision, request)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [clubId, input.gameId, input.mutationId, nextRevision, JSON.stringify(request)],
      );
      const updatedRow = updated.rows[0];
      if (updatedRow === undefined) throw new Error("The completed game session was not returned");
      const response = await hydrateSession(client, updatedRow, clubId, false);
      await client.query("COMMIT");
      return response;
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
      await assertClubGameNotDeleted(client, clubId, input.gameId);

      const duplicate = await client.query<DuplicateSessionRow>(
        `SELECT session.id, session.name, session.revision, session.status,
                session.updated_at, session.state, session.results, session.initial_game,
                session.replay_base_event_id, session.head_event_id,
                session.reset_return_event_id, session.reset_return_was_completed,
                session.replay_version,
                mutation.request AS mutation_request
           FROM game_session_mutations AS mutation
           JOIN game_sessions AS session
             ON session.club_id = mutation.club_id AND session.id = mutation.game_id
          WHERE mutation.club_id = $3
            AND mutation.game_id = $1 AND mutation.mutation_id = $2`,
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
        const response =
          duplicateRow.initial_game === null
            ? mapSession(duplicateRow, true)
            : await hydrateSession(client, duplicateRow, clubId, true);
        await client.query("COMMIT");
        return response;
      }

      assertSaveReplayShape(input);

      const current = await client.query<SessionRow>(
        `SELECT ${sessionColumns} FROM game_sessions WHERE id = $1 AND club_id = $2 FOR UPDATE`,
        [input.gameId, clubId],
      );
      const currentRow = current.rows[0];
      if (currentRow !== undefined) {
        if (input.baseRevision !== currentRow.revision) {
          throw new GameSessionConflictError(currentRow.revision);
        }
        if (
          currentRow.initial_game !== null ||
          currentRow.replay_base_event_id !== null ||
          currentRow.head_event_id !== null ||
          currentRow.state.initialGame != null ||
          (currentRow.state.events?.length ?? 0) > 0
        ) {
          throw new GameSessionOperationError(
            "game_session_incremental_required",
            "A started replay session must use the dedicated incremental operation endpoints",
          );
        }
        const nextRevision = currentRow.revision + 1;
        const status = input.results === null ? "active" : "completed";
        const updated = await client.query<SessionRow>(
          `UPDATE game_sessions
              SET revision = $2, last_mutation_id = $3,
                  state = $4::jsonb, status = $5, results = $6::jsonb,
                  initial_game = $7::jsonb, head_event_id = $8,
                  reset_return_event_id = $9, replay_base_event_id = $10,
                  replay_version = 1, updated_at = NOW()
            WHERE id = $1 AND club_id = $11
          RETURNING ${sessionColumns}`,
          [
            input.gameId,
            nextRevision,
            input.mutationId,
            JSON.stringify(input.state),
            status,
            input.results === null ? null : JSON.stringify(input.results),
            currentRow.initial_game == null ? null : JSON.stringify(currentRow.initial_game),
            currentRow.head_event_id,
            currentRow.reset_return_event_id,
            currentRow.replay_base_event_id,
            clubId,
          ],
        );
        await synchronizeLegacyAggregate(client, clubId, input.gameId, input.state, input.results);
        await client.query(
          `INSERT INTO game_session_mutations (club_id, game_id, mutation_id, revision, request)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [
            clubId,
            input.gameId,
            input.mutationId,
            nextRevision,
            JSON.stringify(mutationRequest(input)),
          ],
        );
        const updatedRow = updated.rows[0];
        if (updatedRow === undefined) throw new Error("The updated game session was not returned");
        const response = mapSession(updatedRow, false);
        await client.query("COMMIT");
        return response;
      }

      if (input.baseRevision !== 0) {
        throw new GameSessionConflictError(0);
      }
      const canonicalName = await allocateCanonicalName(client, clubId, input.name);
      const status = input.results === null ? "active" : "completed";

      const inserted = await client.query<SessionRow>(
        `INSERT INTO game_sessions
           (id, club_id, name, revision, last_mutation_id, state, status, results,
            initial_game, replay_base_event_id, head_event_id, reset_return_event_id,
            replay_version)
         VALUES
           ($1, $2, $3, 1, $4, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9, $10, $11, 1)
         RETURNING ${sessionColumns}`,
        [
          input.gameId,
          clubId,
          canonicalName,
          input.mutationId,
          JSON.stringify(input.state),
          status,
          input.results === null ? null : JSON.stringify(input.results),
          null,
          null,
          null,
          null,
        ],
      );
      await client.query(
        `INSERT INTO game_events
           (id, club_id, game_id, sequence, idempotency_key, event_type, phase, payload, secret)
         VALUES ($1, $2, $3, 1, 'game-created', 'game.created', 'setup-players', $4::jsonb, FALSE)`,
        [randomUUID(), clubId, input.gameId, JSON.stringify({ name: canonicalName })],
      );
      await synchronizeLegacyAggregate(client, clubId, input.gameId, input.state, input.results);
      await client.query(
        `INSERT INTO game_session_mutations (club_id, game_id, mutation_id, revision, request)
         VALUES ($1, $2, $3, 1, $4::jsonb)`,
        [clubId, input.gameId, input.mutationId, JSON.stringify(mutationRequest(input))],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error("The created game session was not returned");
      const response = mapSession(row, false);
      await client.query("COMMIT");
      return response;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
