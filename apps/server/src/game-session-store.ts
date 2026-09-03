import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  applyCurrentGameLogEntry,
  assertGameLogEntry,
  createGameLogEntry,
  isMeaningfulGameEventDraft,
  replayGameLog,
  type CanonicalGameEventType,
  type GameLogEntry,
  type GamePhase,
  type GameState,
  type InitialGameBaseline,
  type Role,
} from "@mafia/game-domain";
import type { Pool, PoolClient } from "pg";
import {
  assertClubGameNotDeleted,
  lockAggregateProjectionTables,
  lockClubActiveGame,
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
  readonly createdAt: string;
}

interface StoredUndoSnapshot {
  readonly game: unknown;
  readonly logLength: number;
  readonly sequence: number;
}

interface StoredSetupState {
  readonly hostPlayerId?: string;
  readonly selectedPlayerIds?: readonly string[];
  readonly setup?: {
    readonly players?: readonly { readonly id?: string; readonly seat?: number }[];
    readonly assignments?: Readonly<Partial<Record<number, Role>>>;
    readonly [key: string]: unknown;
  } | null;
  readonly [key: string]: unknown;
}

interface PersistedGameSessionState {
  readonly setup?: StoredSetupState | null;
  readonly game?: GameState | null;
  readonly hostPlayerId?: string | null;
  readonly hostName?: string | null;
  readonly playlistId?: string;
  readonly log?: readonly StoredGameLogEntry[];
  readonly undoHistory?: readonly StoredUndoSnapshot[];
  readonly undoBudget?: number;
  readonly initialGame?: InitialGameBaseline | null;
  readonly events?: readonly GameLogEntry[];
  readonly headEventId?: string | null;
  readonly resetReturnEventId?: string | null;
  readonly legacyLog?: readonly StoredGameLogEntry[];
}

interface StoredGameSessionState extends PersistedGameSessionState {
  readonly setup: StoredSetupState | null;
  readonly game: GameState | null;
  readonly hostPlayerId: string | null;
  readonly hostName: string | null;
  readonly playlistId: string;
  readonly log: readonly StoredGameLogEntry[];
  readonly undoHistory: readonly StoredUndoSnapshot[];
}

export interface StoredGameResults {
  readonly hostPlayerId: string;
  readonly outcome?: "red" | "black" | "draw" | "cancelled";
  readonly winner: "red" | "black" | null;
  readonly reason?: string | null;
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

export interface NormalizeGameSessionInput {
  readonly clubId?: string;
  readonly gameId: string;
  readonly mutationId: string;
  readonly baseRevision: number;
  readonly claim: GameSessionClaimCredential;
}

export interface GameSessionClaimCredential {
  readonly claimId: string;
  readonly claimGeneration: number;
}

export interface GameSessionClaimInput {
  readonly clubId?: string;
  readonly gameId: string;
  readonly claim: GameSessionClaimCredential;
  readonly claimedByUserId: string;
}

export interface GameSessionClaimResult {
  readonly generation: number;
  readonly expiresAt: Date;
}

export interface ClearGameSessionInput {
  readonly clubId?: string;
  readonly gameId: string;
  readonly expectedRevision?: number;
  readonly claim: GameSessionClaimCredential;
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
  readonly baseRevision?: number;
  readonly state: StoredGameSessionState;
  readonly results: StoredGameResults | null;
  readonly claim: GameSessionClaimCredential;
  readonly claimedByUserId: string;
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
  readonly state: StoredGameSessionState;
  readonly results: StoredGameResults | null;
  readonly replayBaseEventId?: string | null;
  readonly previewableFromEventId?: string | null;
  readonly claim?: {
    readonly generation: number;
    readonly expiresAt: Date;
  };
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

export interface ClubActiveGameSummary {
  readonly gameId: string;
  readonly name: string;
  readonly phase: string;
  readonly day: number;
  readonly updatedAt: Date;
}

export interface CompletedGameSessionSummary {
  readonly gameId: string;
  readonly name: string;
  readonly revision: number;
  readonly hostName: string | null;
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

export interface CompletedGameSessionFilters {
  readonly from?: string;
  readonly to?: string;
  readonly playerId?: string;
  readonly outcome?: "red" | "black" | "draw" | "cancelled";
}

interface SessionRow {
  id: string;
  ruleset_id: string;
  ruleset_version: number;
  name: string;
  revision: number;
  status: "active" | "completed";
  updated_at: Date;
  state: PersistedGameSessionState;
  results: StoredGameResults | null;
  initial_game: InitialGameBaseline | null;
  replay_base_event_id: string | null;
  head_event_id: string | null;
  reset_return_event_id: string | null;
  reset_return_was_completed: boolean;
  replay_version: number;
  claim_id: string | null;
  claim_generation: string | number;
  claimed_by_user_id: string | null;
  claimed_at: Date | null;
  claim_last_seen_at: Date | null;
  claim_expires_at: Date | null;
}

interface CompletedSessionRow extends SessionRow {
  event_count: number;
  completion_outcome: "red" | "black" | "draw" | "cancelled";
  completion_winner: "red" | "black" | null;
  completion_reason: string | null;
  completion_played_at: Date;
}

interface DuplicateSessionRow extends SessionRow {
  mutation_request: unknown | null;
}

const sessionColumns =
  "id, ruleset_id, ruleset_version, name, revision, status, updated_at, state, results, initial_game, " +
  "replay_base_event_id, head_event_id, reset_return_event_id, reset_return_was_completed, replay_version, " +
  "claim_id, claim_generation, claimed_by_user_id, claimed_at, claim_last_seen_at, claim_expires_at";

interface CanonicalEventRow {
  id: string;
  game_id: string;
  replay_sequence: number;
  parent_event_id: string | null;
  event_type: CanonicalGameEventType;
  payload: Readonly<Record<string, unknown>>;
  phase: GamePhase;
  phase_after: GamePhase;
  day_before: number;
  day_after: number;
  replay_version: 1;
  state_hash_after: string;
  created_at: Date;
}

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

const mapCanonicalEvent = (row: CanonicalEventRow): GameLogEntry => {
  try {
    const event = {
      replayVersion: row.replay_version,
      id: row.id,
      gameId: row.game_id,
      sequence: row.replay_sequence,
      parentEventId: row.parent_event_id,
      type: row.event_type,
      payload: row.payload,
      phaseBefore: row.phase,
      phaseAfter: row.phase_after,
      dayBefore: row.day_before,
      dayAfter: row.day_after,
      stateHashAfter: row.state_hash_after,
      createdAt: row.created_at.toISOString(),
    };
    assertGameLogEntry(event);
    return event;
  } catch {
    throw new GameSessionOperationError(
      "game_session_replay_invalid",
      "Stored canonical event is invalid",
    );
  }
};

const readCanonicalEventsByGame = async (
  queryable: Queryable,
  clubId: string,
  gameIds: readonly string[],
): Promise<ReadonlyMap<string, readonly GameLogEntry[]>> => {
  const uniqueGameIds = [...new Set(gameIds)];
  const eventsByGame = new Map<string, GameLogEntry[]>(uniqueGameIds.map((gameId) => [gameId, []]));
  if (uniqueGameIds.length === 0) return eventsByGame;
  const result = await queryable.query<CanonicalEventRow>(
    `SELECT id, game_id, replay_sequence, parent_event_id, event_type, payload,
            phase, phase_after, day_before, day_after, replay_version, state_hash_after,
            created_at
       FROM game_events
      WHERE club_id = $1 AND game_id = ANY($2::uuid[]) AND replay_sequence IS NOT NULL
      ORDER BY game_id, replay_sequence`,
    [clubId, uniqueGameIds],
  );
  for (const row of result.rows) eventsByGame.get(row.game_id)?.push(mapCanonicalEvent(row));
  return eventsByGame;
};

const readCanonicalEvents = async (
  queryable: Queryable,
  clubId: string,
  gameId: string,
): Promise<readonly GameLogEntry[]> => {
  const eventsByGame = await readCanonicalEventsByGame(queryable, clubId, [gameId]);
  return eventsByGame.get(gameId) ?? [];
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

const activeEventsForState = (state: PersistedGameSessionState): readonly GameLogEntry[] =>
  activeEventsFor(state.events ?? [], state.headEventId ?? null);

const deriveCurrentGame = (state: PersistedGameSessionState): GameState | null => {
  if (state.initialGame == null) return state.game ?? null;
  return replayGameLog(state.initialGame, activeEventsForState(state)).game;
};

const assertPersistedPlayerSelection = (state: PersistedGameSessionState): void => {
  const selectedPlayerIds = state.setup?.selectedPlayerIds as unknown;
  const setupPlayers = state.setup?.setup?.players as unknown;
  const hasInvalidSetupPlayer =
    Array.isArray(setupPlayers) &&
    setupPlayers.some(
      (player) =>
        player === null ||
        typeof player !== "object" ||
        Array.isArray(player) ||
        ("id" in player && player.id !== undefined && typeof player.id !== "string") ||
        ("seat" in player &&
          player.seat !== undefined &&
          (!Number.isInteger(player.seat) || Number(player.seat) < 1 || Number(player.seat) > 10)),
    );
  if (
    (selectedPlayerIds !== undefined &&
      (!Array.isArray(selectedPlayerIds) ||
        selectedPlayerIds.some((playerId) => typeof playerId !== "string"))) ||
    (setupPlayers !== undefined && (!Array.isArray(setupPlayers) || hasInvalidSetupPlayer))
  ) {
    throw new GameSessionOperationError(
      "game_session_replay_invalid",
      "Stored player selection is invalid",
    );
  }
};

const materializeSessionState = (
  state: PersistedGameSessionState,
  game?: GameState | null,
): StoredGameSessionState => {
  assertPersistedPlayerSelection(state);
  return {
    ...state,
    setup: state.setup ?? null,
    game: game === undefined ? deriveCurrentGame(state) : game,
    hostPlayerId: state.hostPlayerId ?? null,
    hostName: state.hostName ?? null,
    playlistId: state.playlistId ?? "",
    log: state.log ?? [],
    undoHistory: state.undoHistory ?? [],
  };
};

const setupPhase = (setup: unknown): string => {
  if (setup === null || typeof setup !== "object" || !("step" in setup)) return "setup-players";
  return typeof setup.step === "string" ? `setup-${setup.step}` : "setup-players";
};

const completionOutcome = (results: StoredGameResults): "red" | "black" | "draw" | "cancelled" => {
  const outcome = results.outcome ?? results.winner;
  if (outcome === null) throw new Error("Stored completion is missing its outcome");
  return outcome;
};

const normalizeStoredResults = (results: StoredGameResults | null): StoredGameResults | null =>
  results === null
    ? null
    : {
        ...results,
        outcome: completionOutcome(results),
        reason: results.reason ?? null,
      };

const sessionClaim = (row: SessionRow): Pick<StoredGameSession, "claim"> =>
  row.status !== "active" || row.claim_id === null || row.claim_expires_at === null
    ? {}
    : {
        claim: {
          generation: Number(row.claim_generation),
          expiresAt: row.claim_expires_at,
        },
      };

const mapSession = (row: SessionRow, duplicate: boolean): StoredGameSession => ({
  gameId: row.id,
  name: row.name,
  revision: row.revision,
  duplicate,
  status: row.status,
  rulesetId: row.ruleset_id,
  rulesetVersion: row.ruleset_version,
  updatedAt: row.updated_at,
  state: materializeSessionState(row.state),
  results: normalizeStoredResults(row.results),
  ...sessionClaim(row),
});

const hydrateSessionFromEvents = (
  row: SessionRow,
  events: readonly GameLogEntry[],
  duplicate: boolean,
  revision = row.revision,
): StoredGameSession => {
  assertPersistedPlayerSelection(row.state);
  const suppliedEvents = decodePersistedReplayEvents(row.state.events);
  const replayEvents = events.length === 0 ? suppliedEvents : events;
  const initialGame = row.initial_game ?? row.state.initialGame ?? null;
  const headEventId = row.head_event_id ?? row.state.headEventId ?? null;
  const activeEvents = activeEventsFor(replayEvents, headEventId);
  const game =
    row.state.game ??
    (initialGame === null ? null : replayGameLog(initialGame, activeEvents, row.id).game);
  const log =
    row.state.log ??
    activeEvents.map((event): StoredGameLogEntry => ({
      id: event.id,
      sequence: event.sequence,
      type: event.type,
      phase: event.phaseAfter,
      payload: event.payload as Readonly<Record<string, unknown>>,
      createdAt: event.createdAt,
    }));
  return {
    gameId: row.id,
    name: row.name,
    revision,
    duplicate,
    status: row.status,
    rulesetId: row.ruleset_id,
    rulesetVersion: row.ruleset_version,
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
      events: replayEvents,
      headEventId,
      resetReturnEventId: row.reset_return_event_id,
    },
    results: normalizeStoredResults(row.results),
    replayBaseEventId: row.replay_base_event_id,
    previewableFromEventId: row.replay_base_event_id,
    ...sessionClaim(row),
  };
};

const hydrateSession = async (
  queryable: Queryable,
  row: SessionRow,
  clubId: string,
  duplicate: boolean,
  revision = row.revision,
): Promise<StoredGameSession> =>
  hydrateSessionFromEvents(
    row,
    await readCanonicalEvents(queryable, clubId, row.id),
    duplicate,
    revision,
  );

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

type PlayerProjection =
  | {
      readonly mode: "canonical-game";
      readonly players: readonly { id: string; seat: number; role: Role }[];
    }
  | {
      readonly mode: "setup-roster";
      readonly players: readonly { id: string; seat: number; role: Role | null }[];
    }
  | {
      readonly mode: "selected-ids";
      readonly players: readonly { id: string; seat: number; role: null }[];
    };

const playerProjectionFor = (state: StoredGameSessionState): PlayerProjection => {
  assertPersistedPlayerSelection(state);
  if (state.game !== null) {
    return {
      mode: "canonical-game",
      players: state.game.players.map(({ id, seat, role }) => ({ id, seat, role })),
    };
  }
  if (state.setup?.setup?.players !== undefined) {
    return {
      mode: "setup-roster",
      players: state.setup.setup.players.flatMap(({ id, seat }) =>
        typeof id === "string" && typeof seat === "number"
          ? [{ id, seat, role: state.setup?.setup?.assignments?.[seat] ?? null }]
          : [],
      ),
    };
  }
  return {
    mode: "selected-ids",
    players:
      state.setup?.selectedPlayerIds?.flatMap((id, index) =>
        id === "" ? [] : [{ id, seat: index + 1, role: null }],
      ) ?? [],
  };
};

const replaceActivePlayers = async (
  client: PoolClient,
  clubId: string,
  gameId: string,
  state: StoredGameSessionState,
): Promise<void> => {
  await client.query("DELETE FROM game_session_players WHERE club_id = $1 AND game_id = $2", [
    clubId,
    gameId,
  ]);
  const hostPlayerId = state.hostPlayerId ?? state.setup?.hostPlayerId;
  const { players: seatedPlayers } = playerProjectionFor(state);
  await assertPlayersBelongToClub(client, clubId, [
    ...(hostPlayerId === undefined || hostPlayerId === null ? [] : [hostPlayerId]),
    ...seatedPlayers.map(({ id }) => id),
  ]);
  const activePlayers = [
    ...(hostPlayerId === undefined || hostPlayerId === null || hostPlayerId === ""
      ? []
      : [{ id: hostPlayerId, seat: null, isHost: true, role: null }]),
    ...seatedPlayers.map(({ id, seat, role }) => ({ id, seat, isHost: false, role })),
  ];
  if (activePlayers.length === 0) return;
  await client.query(
    `INSERT INTO game_session_players (club_id, game_id, player_id, seat, is_host, role)
     SELECT $1, $2, player.id, player.seat, player.is_host, player.role
       FROM UNNEST($3::uuid[], $4::integer[], $5::boolean[], $6::text[])
         AS player(id, seat, is_host, role)`,
    [
      clubId,
      gameId,
      activePlayers.map(({ id }) => id),
      activePlayers.map(({ seat }) => seat),
      activePlayers.map(({ isHost }) => isHost),
      activePlayers.map(({ role }) => role),
    ],
  );
};

const synchronizeEventLog = async (
  client: PoolClient,
  clubId: string,
  gameId: string,
  state: StoredGameSessionState,
): Promise<void> => {
  const retainedIds = state.events?.map(({ id }) => id) ?? [];
  await client.query(
    `DELETE FROM game_events
      WHERE club_id = $1 AND game_id = $2 AND replay_sequence IS NOT NULL
        AND NOT (id = ANY($3::uuid[]))`,
    [clubId, gameId, retainedIds],
  );
  if (state.events !== undefined) {
    for (const entry of state.events) {
      await writeCanonicalEvent(client, clubId, entry);
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
      created_at: Date;
    }>(
      `SELECT id, game_id, event_type, phase, seat, payload, created_at
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
         (id, club_id, game_id, sequence, idempotency_key, event_type, phase, seat, payload,
          created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
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
                     AND hosted.outcome <> 'cancelled'
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
  const outcome = completionOutcome(results);
  if (outcome !== "cancelled") affected.add(results.hostPlayerId);
  if (outcome !== "cancelled") {
    for (const player of results.players) affected.add(player.playerId);
  }
  await client.query(
    `INSERT INTO game_results (game_id, club_id, outcome, winner, reason, played_at, host_player_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (club_id, game_id) DO UPDATE
       SET outcome = EXCLUDED.outcome,
           winner = EXCLUDED.winner,
           reason = EXCLUDED.reason,
           played_at = EXCLUDED.played_at,
           host_player_id = EXCLUDED.host_player_id`,
    [
      gameId,
      clubId,
      outcome,
      results.winner,
      results.reason ?? null,
      results.playedAt,
      results.hostPlayerId,
    ],
  );
  await client.query("DELETE FROM game_player_results WHERE club_id = $1 AND game_id = $2", [
    clubId,
    gameId,
  ]);
  if (outcome !== "cancelled")
    await client.query(
      `INSERT INTO game_player_results
       (club_id, game_id, player_id, seat, role, team, final_status, fouls, won,
        best_move_hits)
     SELECT $1, $2, player.player_id, player.seat, player.role, player.team,
            player.final_status, player.fouls,
            CASE WHEN $3 = 'draw' THEN NULL ELSE player.team = $4 END,
            player.best_move_hits
       FROM UNNEST(
         $5::uuid[], $6::int[], $7::text[], $8::text[], $9::text[], $10::int[], $11::int[]
       ) AS player(player_id, seat, role, team, final_status, fouls, best_move_hits)`,
      [
        clubId,
        gameId,
        outcome,
        results.winner,
        results.players.map(({ playerId }) => playerId),
        results.players.map(({ seat }) => seat),
        results.players.map(({ role }) => role),
        results.players.map(({ team }) => team),
        results.players.map(({ status }) => status),
        results.players.map(({ fouls }) => fouls),
        results.players.map(({ bestMoveHits }) => bestMoveHits ?? null),
      ],
    );
  await updateLastPlayed(client, clubId, [...affected]);
};

const assertResultsMatchGame = (
  state: PersistedGameSessionState,
  game: GameState,
  results: StoredGameResults,
): void => {
  const expectedOutcome = game.phase === "finished" ? game.winner : game.phase;
  if (
    (game.phase !== "finished" && game.phase !== "draw" && game.phase !== "cancelled") ||
    completionOutcome(results) !== expectedOutcome ||
    results.winner !== game.winner ||
    results.hostPlayerId !== state.hostPlayerId ||
    results.players.length !== game.players.length
  ) {
    throw new GameSessionOperationError(
      "game_session_results_mismatch",
      "Completion results must match the replayed terminal head",
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
  await replaceActivePlayers(client, clubId, gameId, {
    ...state,
    game: deriveCurrentGame(state),
  });
};

const metadataOnlyState = (
  state: PersistedGameSessionState,
  legacyLog = state.legacyLog,
  includeGameNull = false,
): PersistedGameSessionState => ({
  setup: state.setup ?? null,
  ...(includeGameNull ? { game: null } : {}),
  hostPlayerId: state.hostPlayerId ?? null,
  hostName: state.hostName ?? null,
  playlistId: state.playlistId ?? "",
  ...(legacyLog === undefined || legacyLog.length === 0 ? {} : { legacyLog }),
});

type NormalizationPlan =
  | {
      readonly mode: "setup-only";
      readonly initialGame: null;
      readonly events: readonly GameLogEntry[];
      readonly legacyLog?: readonly StoredGameLogEntry[];
    }
  | {
      readonly mode: "legacy-snapshot";
      readonly initialGame: InitialGameBaseline;
      readonly events: readonly GameLogEntry[];
      readonly legacyLog: readonly StoredGameLogEntry[];
    }
  | {
      readonly mode: "legacy-json-replay" | "canonical-replay";
      readonly initialGame: InitialGameBaseline | null;
      readonly events: readonly GameLogEntry[];
      readonly legacyLog?: readonly StoredGameLogEntry[];
    };

const replayInvalid = (message: string): GameSessionOperationError =>
  new GameSessionOperationError("game_session_replay_invalid", message);

const decodePersistedReplayEvents = (value: unknown): readonly GameLogEntry[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw replayInvalid("Stored JSON replay events are invalid");
  try {
    for (const event of value) assertGameLogEntry(event);
  } catch {
    throw replayInvalid("Stored JSON replay events are invalid");
  }
  return value;
};

const needsCanonicalReplayRead = (
  row: SessionRow,
  suppliedEvents: readonly GameLogEntry[],
): boolean =>
  suppliedEvents.length === 0 ||
  row.initial_game !== null ||
  row.replay_base_event_id !== null ||
  row.head_event_id !== null;

const normalizationPlanFor = (
  row: SessionRow,
  suppliedEvents: readonly GameLogEntry[],
  canonicalEvents: readonly GameLogEntry[],
): NormalizationPlan => {
  if (
    row.initial_game !== null &&
    row.state.initialGame != null &&
    !isDeepStrictEqual(row.initial_game, row.state.initialGame)
  ) {
    throw replayInvalid("JSON and canonical replay baselines contradict each other");
  }
  if (
    row.head_event_id !== null &&
    row.state.headEventId != null &&
    row.head_event_id !== row.state.headEventId
  ) {
    throw replayInvalid("JSON and canonical replay heads contradict each other");
  }
  if (
    suppliedEvents.length > 0 &&
    canonicalEvents.length > 0 &&
    !isDeepStrictEqual(suppliedEvents, canonicalEvents)
  ) {
    throw replayInvalid("JSON and canonical replay sources contradict each other");
  }

  const initialGame = row.initial_game ?? row.state.initialGame ?? null;
  if (canonicalEvents.length > 0) {
    return {
      mode: "canonical-replay",
      initialGame,
      events: canonicalEvents,
      legacyLog: row.state.legacyLog,
    };
  }
  if (suppliedEvents.length > 0) {
    return {
      mode: "legacy-json-replay",
      initialGame,
      events: suppliedEvents,
      legacyLog: row.state.legacyLog,
    };
  }
  if (initialGame !== null) {
    return {
      mode: row.initial_game === null ? "legacy-json-replay" : "canonical-replay",
      initialGame,
      events: [],
      legacyLog: row.state.legacyLog,
    };
  }
  if (row.state.game != null) {
    return {
      mode: "legacy-snapshot",
      initialGame: { replayVersion: 1, game: row.state.game },
      events: [],
      legacyLog: [...(row.state.legacyLog ?? []), ...(row.state.log ?? [])],
    };
  }
  return {
    mode: "setup-only",
    initialGame: null,
    events: [],
    legacyLog: row.state.legacyLog,
  };
};

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
            day_before, day_after, seat, payload, parent_event_id, replay_version,
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
        day_before, day_after, seat, payload, parent_event_id, replay_version,
        replay_sequence, state_hash_after, created_at)
     VALUES
       ($1, $2, $3, $4, $17, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14,
        $15, $16)
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
  state: input.state,
  results: input.results,
});

const normalizedMutationRequest = (request: unknown): unknown => {
  if (request === null || typeof request !== "object" || Array.isArray(request)) return request;
  const record = request as Record<string, unknown>;
  const results = record.results;
  if (results === null || typeof results !== "object" || Array.isArray(results)) return request;
  const resultRecord = results as Record<string, unknown>;
  if (
    (resultRecord.winner !== "red" && resultRecord.winner !== "black") ||
    "outcome" in resultRecord ||
    "reason" in resultRecord
  ) {
    return request;
  }
  return {
    ...record,
    results: { ...resultRecord, outcome: resultRecord.winner, reason: null },
  };
};

const isSameMutationRequest = (stored: unknown, received: unknown): boolean =>
  isDeepStrictEqual(normalizedMutationRequest(stored), normalizedMutationRequest(received));

const isMutationRetry = async (
  client: PoolClient,
  clubId: string,
  gameId: string,
  mutationId: string,
  request: unknown,
): Promise<boolean> => {
  const duplicate = await client.query<{ request: unknown | null }>(
    `SELECT request
       FROM game_session_mutations
      WHERE club_id = $3 AND game_id = $1 AND mutation_id = $2`,
    [gameId, mutationId, clubId],
  );
  const duplicateRow = duplicate.rows[0];
  if (duplicateRow === undefined) return false;
  if (duplicateRow.request !== null && !isSameMutationRequest(duplicateRow.request, request)) {
    throw new GameSessionMutationMismatchError();
  }
  return true;
};

const recordMutation = async (
  client: PoolClient,
  clubId: string,
  gameId: string,
  mutationId: string,
  revision: number,
  request: unknown,
): Promise<void> => {
  await client.query(
    `INSERT INTO game_session_mutations (club_id, game_id, mutation_id, revision, request)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [clubId, gameId, mutationId, revision, JSON.stringify(request)],
  );
};

const assertSnapshotGameIdentity = (input: SaveGameSessionInput): void => {
  if (input.state.events?.some(({ gameId }) => gameId !== input.gameId)) {
    throw new GameSessionOperationError(
      "game_session_event_conflict",
      "Every semantic event must belong to the snapshot game",
    );
  }
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

export class ClubActiveGameExistsError extends GameSessionOperationError {
  public override readonly name = "ClubActiveGameExistsError";

  public constructor(public readonly activeGame: ClubActiveGameSummary) {
    super("club_active_game_exists", "The selected club already has an active game session");
  }
}

const activeGameSummary = async (
  queryable: Queryable,
  clubId: string,
): Promise<ClubActiveGameSummary | null> => {
  const result = await queryable.query<SessionRow>(
    `SELECT ${sessionColumns}
       FROM game_sessions
      WHERE club_id = $1 AND status = 'active'
      ORDER BY updated_at DESC, id
      LIMIT 1`,
    [clubId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const game =
    row.initial_game === null
      ? deriveCurrentGame(row.state)
      : (await hydrateSession(queryable, row, clubId, false)).state.game;
  return {
    gameId: row.id,
    name: row.name,
    phase: game?.phase ?? setupPhase(row.state.setup),
    day: game?.day ?? 0,
    updatedAt: row.updated_at,
  };
};

const isActiveGameUniqueViolation = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const pgError = error as { readonly code?: unknown; readonly constraint?: unknown };
  return pgError.code === "23505" && pgError.constraint === "game_sessions_one_active_per_club_idx";
};

const activeGameAfterUniqueViolation = async (
  pool: Pool,
  clubId: string,
): Promise<ClubActiveGameSummary | null> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockClubActiveGame(client, clubId);
    const activeGame = await activeGameSummary(client, clubId);
    await client.query("COMMIT");
    return activeGame;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export class GameSessionNotFoundError extends GameSessionOperationError {
  public override readonly name = "GameSessionNotFoundError";

  public constructor() {
    super("game_session_not_found", "The game session does not exist in the selected club");
  }
}

const assertActiveSession = (row: Pick<SessionRow, "status">): void => {
  if (row.status === "completed") {
    throw new GameSessionOperationError(
      "game_session_completed",
      "Completed sessions cannot be changed",
    );
  }
};

const claimGenerationOf = (row: Pick<SessionRow, "claim_generation">): number =>
  Number(row.claim_generation);

const canonicalClaimId = (claimId: string): string => claimId.toLowerCase();

export interface GameSessionClaimConflict {
  readonly holderName: string | null;
  readonly claimedAt: Date | null;
  readonly lastSeenAt: Date | null;
  readonly expiresAt: Date | null;
  readonly generation: number;
}

export class GameSessionClaimConflictError extends Error {
  public override readonly name = "GameSessionClaimConflictError";
  public readonly code = "game_session_claim_conflict";

  public constructor(public readonly claim: GameSessionClaimConflict) {
    super("The active game session claim is held by a different or expired writer");
  }
}

const databaseNow = async (client: PoolClient): Promise<Date> => {
  // Unlike CURRENT_TIMESTAMP, clock_timestamp() advances while this transaction waits on locks.
  const result = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
  const now = result.rows[0]?.now;
  if (now === undefined) throw new Error("The database did not return its current timestamp");
  return now;
};

const claimConflictFor = async (
  client: PoolClient,
  row: Pick<
    SessionRow,
    | "claim_generation"
    | "claimed_by_user_id"
    | "claimed_at"
    | "claim_last_seen_at"
    | "claim_expires_at"
  >,
): Promise<GameSessionClaimConflictError> => {
  const holder =
    row.claimed_by_user_id === null
      ? null
      : await client.query<{ display_name: string }>(
          "SELECT display_name FROM users WHERE id = $1",
          [row.claimed_by_user_id],
        );
  return new GameSessionClaimConflictError({
    holderName: holder === null ? null : (holder.rows[0]?.display_name ?? null),
    claimedAt: row.claimed_at,
    lastSeenAt: row.claim_last_seen_at,
    expiresAt: row.claim_expires_at,
    generation: claimGenerationOf(row),
  });
};

const assertLiveClaim = async (
  client: PoolClient,
  row: SessionRow,
  claim: GameSessionClaimCredential,
  now: Date,
): Promise<void> => {
  if (
    row.claim_id === canonicalClaimId(claim.claimId) &&
    claimGenerationOf(row) === claim.claimGeneration &&
    row.claim_expires_at !== null &&
    row.claim_expires_at.getTime() > now.getTime()
  ) {
    return;
  }
  throw await claimConflictFor(client, row);
};

const assertMutationClaim = async (
  client: PoolClient,
  row: SessionRow,
  claim: GameSessionClaimCredential,
  now: Date,
): Promise<void> => {
  await assertLiveClaim(client, row, claim, now);
};

const assertInitialClaim = (input: SaveGameSessionInput): void => {
  if (input.claim.claimGeneration !== 0) {
    throw new GameSessionOperationError(
      "game_session_claim_invalid",
      "A newly created session must begin with claim generation zero",
    );
  }
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

  public async claim(input: GameSessionClaimInput): Promise<GameSessionClaimResult> {
    const clubId = input.clubId ?? DEFAULT_CLUB_ID;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
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
      assertActiveSession(row);
      const now = await databaseNow(client);
      const isLive =
        row.claim_expires_at !== null && row.claim_expires_at.getTime() > now.getTime();
      const isSameClaim =
        isLive &&
        row.claim_id === canonicalClaimId(input.claim.claimId) &&
        claimGenerationOf(row) === input.claim.claimGeneration;
      if (isSameClaim) {
        const renewed = await client.query<{
          claim_generation: string | number;
          claim_expires_at: Date;
        }>(
          `UPDATE game_sessions
              SET claim_last_seen_at = clock_timestamp(),
                  claim_expires_at = clock_timestamp() + INTERVAL '45 seconds'
            WHERE id = $1 AND club_id = $2
          RETURNING claim_generation, claim_expires_at`,
          [input.gameId, clubId],
        );
        const renewedRow = renewed.rows[0];
        if (renewedRow === undefined) throw new Error("The renewed claim was not returned");
        await client.query("COMMIT");
        return {
          generation: Number(renewedRow.claim_generation),
          expiresAt: renewedRow.claim_expires_at,
        };
      }
      if (isLive) throw await claimConflictFor(client, row);
      const generation = claimGenerationOf(row) + 1;
      const acquired = await client.query<{
        claim_generation: string | number;
        claim_expires_at: Date;
      }>(
        `UPDATE game_sessions
            SET claim_id = $3, claim_generation = $4, claimed_by_user_id = $5,
                claimed_at = clock_timestamp(), claim_last_seen_at = clock_timestamp(),
                claim_expires_at = clock_timestamp() + INTERVAL '45 seconds'
          WHERE id = $1 AND club_id = $2
          RETURNING claim_generation, claim_expires_at`,
        [
          input.gameId,
          clubId,
          canonicalClaimId(input.claim.claimId),
          generation,
          input.claimedByUserId,
        ],
      );
      const acquiredRow = acquired.rows[0];
      if (acquiredRow === undefined) throw new Error("The acquired claim was not returned");
      await client.query("COMMIT");
      return {
        generation: Number(acquiredRow.claim_generation),
        expiresAt: acquiredRow.claim_expires_at,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async takeover(input: GameSessionClaimInput): Promise<GameSessionClaimResult> {
    const clubId = input.clubId ?? DEFAULT_CLUB_ID;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
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
      assertActiveSession(row);
      const now = await databaseNow(client);
      if (
        row.claim_id === canonicalClaimId(input.claim.claimId) &&
        row.claim_expires_at !== null &&
        row.claim_expires_at.getTime() > now.getTime()
      ) {
        const renewed = await client.query<{
          claim_generation: string | number;
          claim_expires_at: Date;
        }>(
          `UPDATE game_sessions
              SET claim_last_seen_at = clock_timestamp(),
                  claim_expires_at = clock_timestamp() + INTERVAL '45 seconds'
            WHERE id = $1 AND club_id = $2
          RETURNING claim_generation, claim_expires_at`,
          [input.gameId, clubId],
        );
        const renewedRow = renewed.rows[0];
        if (renewedRow === undefined) throw new Error("The takeover retry was not returned");
        await client.query("COMMIT");
        return {
          generation: Number(renewedRow.claim_generation),
          expiresAt: renewedRow.claim_expires_at,
        };
      }
      const generation = claimGenerationOf(row) + 1;
      const claimed = await client.query<{
        claim_generation: string | number;
        claim_expires_at: Date;
      }>(
        `UPDATE game_sessions
            SET claim_id = $3, claim_generation = $4, claimed_by_user_id = $5,
                claimed_at = clock_timestamp(), claim_last_seen_at = clock_timestamp(),
                claim_expires_at = clock_timestamp() + INTERVAL '45 seconds'
          WHERE id = $1 AND club_id = $2
          RETURNING claim_generation, claim_expires_at`,
        [
          input.gameId,
          clubId,
          canonicalClaimId(input.claim.claimId),
          generation,
          input.claimedByUserId,
        ],
      );
      const claimedRow = claimed.rows[0];
      if (claimedRow === undefined) throw new Error("The takeover claim was not returned");
      await client.query("COMMIT");
      return {
        generation: Number(claimedRow.claim_generation),
        expiresAt: claimedRow.claim_expires_at,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async release(input: Omit<GameSessionClaimInput, "claimedByUserId">): Promise<void> {
    const clubId = input.clubId ?? DEFAULT_CLUB_ID;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
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
      assertActiveSession(row);
      if (
        row.claim_id !== canonicalClaimId(input.claim.claimId) ||
        claimGenerationOf(row) !== input.claim.claimGeneration
      ) {
        throw await claimConflictFor(client, row);
      }
      await client.query(
        `UPDATE game_sessions
            SET claim_id = NULL, claimed_by_user_id = NULL, claimed_at = NULL,
                claim_last_seen_at = NULL, claim_expires_at = NULL
          WHERE id = $1 AND club_id = $2`,
        [input.gameId, clubId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async clear(input: ClearGameSessionInput): Promise<void> {
    const gameId = input.gameId;
    const expectedRevision = input.expectedRevision;
    const clubId = input.clubId ?? DEFAULT_CLUB_ID;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockAggregateProjectionTables(client);
      await lockClubGame(client, clubId, gameId);
      const current = await client.query<SessionRow>(
        `SELECT ${sessionColumns}
           FROM game_sessions
          WHERE id = $1 AND club_id = $2
          FOR UPDATE`,
        [gameId, clubId],
      );
      const currentRow = current.rows[0];
      if (currentRow !== undefined) {
        assertActiveSession(currentRow);
        await assertMutationClaim(client, currentRow, input.claim, await databaseNow(client));
      }
      const currentRevision = currentRow?.revision ?? 0;
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
    const replayGameIds = result.rows.flatMap((row) => (row.initial_game === null ? [] : [row.id]));
    const eventsByGame = await readCanonicalEventsByGame(this.pool, clubId, replayGameIds);
    return result.rows.map((row) => {
      const game =
        row.initial_game === null
          ? deriveCurrentGame(row.state)
          : hydrateSessionFromEvents(row, eventsByGame.get(row.id) ?? [], false).state.game;
      return {
        gameId: row.id,
        name: row.name,
        revision: row.revision,
        hostName: row.state.hostName ?? null,
        phase: game?.phase ?? setupPhase(row.state.setup),
        day: game?.day ?? 0,
        updatedAt: row.updated_at,
      };
    });
  }

  public async listCompleted(
    clubId = DEFAULT_CLUB_ID,
    filters: CompletedGameSessionFilters = {},
  ): Promise<readonly CompletedGameSessionSummary[]> {
    const result = await this.pool.query<CompletedSessionRow>(
      `SELECT ${sessionColumns},
              COALESCE(event_counts.event_count, 0)::int AS event_count,
              completion.outcome AS completion_outcome,
              completion.winner AS completion_winner,
              completion.reason AS completion_reason,
              completion.played_at AS completion_played_at
         FROM game_sessions
         JOIN game_results AS completion
           ON completion.club_id = game_sessions.club_id
          AND completion.game_id = game_sessions.id
         LEFT JOIN (
           SELECT game_id, COUNT(*)::int AS event_count
             FROM game_events
            WHERE club_id = $1
            GROUP BY game_id
         ) AS event_counts ON event_counts.game_id = game_sessions.id
        WHERE status = 'completed' AND game_sessions.club_id = $1
          AND ($2::date IS NULL OR completion.played_at >= ($2::date::timestamp AT TIME ZONE 'UTC'))
          AND ($3::date IS NULL OR completion.played_at < (($3::date + 1)::timestamp AT TIME ZONE 'UTC'))
          AND ($4::uuid IS NULL OR EXISTS (
            SELECT 1
              FROM game_session_players AS participant
             WHERE participant.club_id = game_sessions.club_id
               AND participant.game_id = game_sessions.id
               AND participant.player_id = $4
               AND NOT participant.is_host
          ))
          AND ($5::text IS NULL OR completion.outcome = $5)
        ORDER BY updated_at DESC, id`,
      [
        clubId,
        filters.from ?? null,
        filters.to ?? null,
        filters.playerId ?? null,
        filters.outcome ?? null,
      ],
    );
    const replayGameIds = result.rows.flatMap((row) => (row.initial_game === null ? [] : [row.id]));
    const eventsByGame = await readCanonicalEventsByGame(this.pool, clubId, replayGameIds);
    const summaries = result.rows.map((row): CompletedGameSessionSummary | null => {
      if (row.results === null) return null;
      const game =
        row.initial_game === null
          ? deriveCurrentGame(row.state)
          : hydrateSessionFromEvents(row, eventsByGame.get(row.id) ?? [], false).state.game;
      return {
        gameId: row.id,
        name: row.name,
        revision: row.revision,
        hostName: row.state.hostName ?? null,
        outcome: row.completion_outcome,
        winner: row.completion_winner,
        reason: row.completion_reason,
        rulesetId: row.ruleset_id,
        rulesetVersion: row.ruleset_version,
        playedAt: row.completion_played_at.toISOString(),
        day: game?.day ?? 0,
        eventCount: row.event_count,
        updatedAt: row.updated_at,
      };
    });
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
      if (await isMutationRetry(client, clubId, input.gameId, input.mutationId, request)) {
        const response = await hydrateSession(client, row, clubId, true);
        await client.query("COMMIT");
        return response;
      }
      assertActiveSession(row);
      await assertMutationClaim(client, row, input.claim, await databaseNow(client));
      if (input.baseRevision !== row.revision) throw new GameSessionConflictError(row.revision);

      const suppliedEvents = decodePersistedReplayEvents(row.state.events);
      const readCanonicalBeforeWrite = needsCanonicalReplayRead(row, suppliedEvents);
      const canonicalEvents = readCanonicalBeforeWrite
        ? await readCanonicalEvents(client, clubId, input.gameId)
        : [];
      const plan = normalizationPlanFor(row, suppliedEvents, canonicalEvents);
      const initialGame = plan.initialGame;
      let events = plan.events;
      const legacyLog = plan.legacyLog;
      if (initialGame !== null && events.length === 0) {
        const checkpoint = createGameLogEntry({
          gameId: input.gameId,
          id: randomUUID(),
          sequence: 1,
          parentEventId: null,
          createdAt: new Date().toISOString(),
          before: initialGame.game,
          draft: { type: "game.checkpointed", payload: {} },
        });
        events = [checkpoint.entry];
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
          JSON.stringify(metadataOnlyState(row.state, legacyLog, initialGame === null)),
          initialGame === null ? null : JSON.stringify(initialGame),
          roots[0]?.id ?? row.replay_base_event_id,
          headEventId,
          row.reset_return_event_id ?? row.state.resetReturnEventId ?? null,
          clubId,
        ],
      );
      await recordMutation(client, clubId, input.gameId, input.mutationId, nextRevision, request);
      const updatedRow = updated.rows[0];
      if (updatedRow === undefined) throw new Error("The normalized game session was not returned");
      const response = readCanonicalBeforeWrite
        ? hydrateSessionFromEvents(updatedRow, events, false)
        : await hydrateSession(client, updatedRow, clubId, false);
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
      if (await isMutationRetry(client, clubId, input.gameId, input.mutationId, request)) {
        const response = await hydrateSession(client, row, clubId, true);
        await client.query("COMMIT");
        return response;
      }
      assertActiveSession(row);
      await assertMutationClaim(client, row, input.claim, await databaseNow(client));
      if (input.baseRevision !== row.revision) throw new GameSessionConflictError(row.revision);
      if (row.initial_game !== null || row.replay_base_event_id !== null) {
        throw new GameSessionOperationError(
          "game_session_already_started",
          "The game session already has an immutable replay baseline",
        );
      }
      if (row.state.game != null) {
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
      await replaceActivePlayers(
        client,
        clubId,
        input.gameId,
        materializeSessionState(metadata, input.initialGame.game),
      );
      await recordMutation(client, clubId, input.gameId, input.mutationId, nextRevision, request);
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
      if (await isMutationRetry(client, clubId, input.gameId, input.mutationId, request)) {
        const response = await hydrateSession(client, row, clubId, true);
        await client.query("COMMIT");
        return response;
      }
      assertActiveSession(row);
      await assertMutationClaim(client, row, input.claim, await databaseNow(client));
      if (!isMeaningfulGameEventDraft(input.event)) {
        throw new GameSessionOperationError(
          "game_session_event_intermediate",
          "Only a meaningful semantic checkpoint may be stored in game history",
        );
      }
      if (input.baseRevision !== row.revision) throw new GameSessionConflictError(row.revision);
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
      const activeEvents = activeEventsFor(events, row.head_event_id);
      const currentGame = replayGameLog(row.initial_game, activeEvents, input.gameId).game;
      let nextGame: GameState;
      try {
        nextGame = applyCurrentGameLogEntry(currentGame, input.event);
      } catch {
        throw replayInvalid("New canonical event does not match current rule semantics");
      }
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
      await replaceActivePlayers(
        client,
        clubId,
        input.gameId,
        materializeSessionState(row.state, nextGame),
      );
      await recordMutation(client, clubId, input.gameId, input.mutationId, nextRevision, request);
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
      if (await isMutationRetry(client, clubId, input.gameId, input.mutationId, request)) {
        const response = await hydrateSession(client, row, clubId, true);
        await client.query("COMMIT");
        return response;
      }
      assertActiveSession(row);
      await assertMutationClaim(client, row, input.claim, await databaseNow(client));
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

      const nextRevision = row.revision + 1;
      const updated = await client.query<SessionRow>(
        `UPDATE game_sessions
            SET revision = $2, last_mutation_id = $3, head_event_id = $4,
                reset_return_event_id = $5, reset_return_was_completed = FALSE,
                updated_at = NOW()
          WHERE id = $1 AND club_id = $6
        RETURNING ${sessionColumns}`,
        [input.gameId, nextRevision, input.mutationId, target.id, nextResetReturnEventId, clubId],
      );
      await replaceActivePlayers(
        client,
        clubId,
        input.gameId,
        materializeSessionState(row.state, replay.game),
      );
      await recordMutation(client, clubId, input.gameId, input.mutationId, nextRevision, request);
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
      if (await isMutationRetry(client, clubId, input.gameId, input.mutationId, request)) {
        const response = await hydrateSession(client, row, clubId, true);
        await client.query("COMMIT");
        return response;
      }
      assertActiveSession(row);
      await assertMutationClaim(client, row, input.claim, await databaseNow(client));
      if (input.baseRevision !== row.revision) throw new GameSessionConflictError(row.revision);
      if (row.initial_game === null || row.head_event_id === null) {
        throw new GameSessionOperationError(
          "game_session_not_started",
          "Completion requires a replayable active head",
        );
      }
      const events = await readCanonicalEvents(client, clubId, input.gameId);
      const completionEvent = events.find(({ id }) => id === row.head_event_id);
      const outcome = completionOutcome(input.results);
      const terminalEventType =
        outcome === "red" || outcome === "black"
          ? "game.completed"
          : outcome === "draw"
            ? "game.drawn"
            : "game.cancelled";
      const eventReason =
        completionEvent?.type === "game.drawn" || completionEvent?.type === "game.cancelled"
          ? completionEvent.payload.reason
          : null;
      if (
        row.status !== "active" ||
        completionEvent?.type !== terminalEventType ||
        input.results.playedAt !== completionEvent.createdAt ||
        (input.results.reason ?? null) !== eventReason
      ) {
        throw new GameSessionOperationError(
          "game_session_completion_invalid",
          "Completion requires the matching active terminal head, timestamp, and reason",
        );
      }
      const replay = replayGameLog(
        row.initial_game,
        activeEventsFor(events, row.head_event_id),
        input.gameId,
      );
      assertResultsMatchGame(row.state, replay.game, input.results);
      await replaceResults(client, clubId, input.gameId, input.results);
      await replaceActivePlayers(
        client,
        clubId,
        input.gameId,
        materializeSessionState(row.state, replay.game),
      );

      const nextRevision = row.revision + 1;
      const results = normalizeStoredResults(input.results);
      const updated = await client.query<SessionRow>(
        `UPDATE game_sessions
            SET revision = $2, last_mutation_id = $3, status = 'completed',
                results = $4::jsonb, updated_at = NOW(),
                claim_id = NULL, claimed_by_user_id = NULL, claimed_at = NULL,
                claim_last_seen_at = NULL, claim_expires_at = NULL
          WHERE id = $1 AND club_id = $5
        RETURNING ${sessionColumns}`,
        [input.gameId, nextRevision, input.mutationId, JSON.stringify(results), clubId],
      );
      await recordMutation(client, clubId, input.gameId, input.mutationId, nextRevision, request);
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
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.saveOnce(input);
      } catch (error) {
        if (!isActiveGameUniqueViolation(error)) throw error;
        const activeGame = await activeGameAfterUniqueViolation(this.pool, clubId);
        if (activeGame !== null) throw new ClubActiveGameExistsError(activeGame);
      }
    }
    throw new GameSessionOperationError(
      "club_active_game_exists",
      "A competing active game prevented this session from being created",
    );
  }

  private async saveOnce(input: SaveGameSessionInput): Promise<StoredGameSession> {
    assertSnapshotGameIdentity(input);
    const snapshotGame = deriveCurrentGame(input.state);
    if (
      input.results === null &&
      (snapshotGame?.phase === "draw" || snapshotGame?.phase === "cancelled")
    ) {
      throw new GameSessionOperationError(
        "game_session_completion_required",
        "A draw or cancellation snapshot requires final results",
      );
    }
    const clubId = input.clubId ?? DEFAULT_CLUB_ID;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockAggregateProjectionTables(client);
      await lockClubActiveGame(client, clubId);
      await lockClubGame(client, clubId, input.gameId);
      await assertClubGameNotDeleted(client, clubId, input.gameId);

      const duplicate = await client.query<DuplicateSessionRow>(
        `SELECT session.id, session.ruleset_id, session.ruleset_version,
                session.name, session.revision, session.status,
                session.updated_at, session.state, session.results, session.initial_game,
                session.replay_base_event_id, session.head_event_id,
                session.reset_return_event_id, session.reset_return_was_completed,
                session.replay_version, session.claim_id, session.claim_generation,
                session.claimed_by_user_id, session.claimed_at, session.claim_last_seen_at,
                session.claim_expires_at,
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
          !isSameMutationRequest(duplicateRow.mutation_request, mutationRequest(input))
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

      const current = await client.query<SessionRow>(
        `SELECT ${sessionColumns} FROM game_sessions WHERE id = $1 AND club_id = $2 FOR UPDATE`,
        [input.gameId, clubId],
      );
      const currentRow = current.rows[0];
      if (currentRow !== undefined) {
        assertActiveSession(currentRow);
        await assertMutationClaim(client, currentRow, input.claim, await databaseNow(client));
        const nextRevision = currentRow.revision + 1;
        const status = input.results === null ? "active" : "completed";
        const replayBaseEventId =
          input.state.events?.find(({ parentEventId }) => parentEventId === null)?.id ?? null;
        const updated = await client.query<SessionRow>(
          `UPDATE game_sessions
              SET revision = $2, last_mutation_id = $3,
                  state = $4::jsonb, status = $5, results = $6::jsonb,
                  initial_game = $7::jsonb, head_event_id = $8,
                  reset_return_event_id = $9, replay_base_event_id = $10,
                  replay_version = 1, updated_at = NOW(),
                  claim_id = CASE WHEN $5 = 'completed' THEN NULL ELSE claim_id END,
                  claimed_by_user_id = CASE WHEN $5 = 'completed' THEN NULL ELSE claimed_by_user_id END,
                  claimed_at = CASE WHEN $5 = 'completed' THEN NULL ELSE claimed_at END,
                  claim_last_seen_at = CASE WHEN $5 = 'completed' THEN NULL ELSE claim_last_seen_at END,
                  claim_expires_at = CASE WHEN $5 = 'completed' THEN NULL ELSE claim_expires_at END
            WHERE id = $1 AND club_id = $11
          RETURNING ${sessionColumns}`,
          [
            input.gameId,
            nextRevision,
            input.mutationId,
            JSON.stringify(input.state),
            status,
            input.results === null ? null : JSON.stringify(input.results),
            input.state.initialGame == null ? null : JSON.stringify(input.state.initialGame),
            input.state.headEventId ?? null,
            input.state.resetReturnEventId ?? null,
            replayBaseEventId,
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

      const status = input.results === null ? "active" : "completed";
      if (status === "active") {
        assertInitialClaim(input);
        const existingActiveGame = await activeGameSummary(client, clubId);
        if (existingActiveGame !== null) {
          throw new ClubActiveGameExistsError(existingActiveGame);
        }
      }
      const canonicalName = await allocateCanonicalName(client, clubId, input.name);
      const replayBaseEventId =
        input.state.events?.find(({ parentEventId }) => parentEventId === null)?.id ?? null;

      const inserted = await client.query<SessionRow>(
        `INSERT INTO game_sessions
           (id, club_id, name, revision, last_mutation_id, state, status, results,
            initial_game, replay_base_event_id, head_event_id, reset_return_event_id,
            replay_version, claim_id, claim_generation, claimed_by_user_id, claimed_at,
            claim_last_seen_at, claim_expires_at)
         VALUES
           ($1, $2, $3, 1, $4, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9, $10, $11, 1,
            $12, $13, $14,
            CASE WHEN $12::uuid IS NULL THEN NULL ELSE clock_timestamp() END,
            CASE WHEN $12::uuid IS NULL THEN NULL ELSE clock_timestamp() END,
            CASE WHEN $12::uuid IS NULL THEN NULL ELSE clock_timestamp() + INTERVAL '45 seconds' END)
         RETURNING ${sessionColumns}`,
        [
          input.gameId,
          clubId,
          canonicalName,
          input.mutationId,
          JSON.stringify(input.state),
          status,
          input.results === null ? null : JSON.stringify(input.results),
          input.state.initialGame == null ? null : JSON.stringify(input.state.initialGame),
          replayBaseEventId,
          input.state.headEventId ?? null,
          input.state.resetReturnEventId ?? null,
          status === "active" ? canonicalClaimId(input.claim.claimId) : null,
          status === "active" ? 1 : 0,
          status === "active" ? input.claimedByUserId : null,
        ],
      );
      await client.query(
        `INSERT INTO game_events
           (id, club_id, game_id, sequence, idempotency_key, event_type, phase, payload)
         VALUES ($1, $2, $3, 1, 'game-created', 'game.created', 'setup-players', $4::jsonb)`,
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
