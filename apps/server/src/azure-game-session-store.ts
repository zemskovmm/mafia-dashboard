import { randomUUID } from "node:crypto";
import { odata } from "@azure/data-tables";
import { CASPER_PLAYER_ID, CASPER_SEAT, isSecretGameEventType } from "@mafia/game-domain";
import { DEFAULT_CLUB_ID } from "./club-store.js";
import type { GameEvent } from "./event-store.js";
import {
  completionMetadata,
  GameSessionNotFoundError,
  projectableResults,
  type CompletedGameSessionFilters,
  type CompletedGameSessionSummary,
  type CreateGameSessionInput,
  type FinalGameResults,
  type GameSessionState,
  type GameSessionSummary,
  type SaveGameSessionInput,
  type StoredGameSession,
} from "./game-session-store.js";
import {
  assertSupportedGame,
  inspectGameIdentities,
  InvalidGameIdentityError,
} from "./game-session-identity.js";
import { DeletedGameError } from "./game-lifecycle.js";
import {
  blobFields,
  blobReference,
  uuidKey,
  StorageUnavailableError,
  type AzureStorage,
  type AzureTransaction,
} from "./azure-storage.js";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const integer = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null;
const clubPrefix = (clubId: string) => `club:${uuidKey(clubId)}:`;
const clubDeletedKey = (clubId: string) => `deleted-club:${uuidKey(clubId)}`;
const gameKey = (clubId: string, gameId: string) => `${clubPrefix(clubId)}game:${uuidKey(gameId)}`;
const creationKey = (clubId: string, creationId: string) =>
  `${clubPrefix(clubId)}creation:${uuidKey(creationId)}`;
const deletedKey = (clubId: string, gameId: string) =>
  `${clubPrefix(clubId)}deleted-game:${uuidKey(gameId)}`;
const participantPrefix = (clubId: string, gameId: string) =>
  `${clubPrefix(clubId)}participant:${uuidKey(gameId)}:`;
const resultPrefix = (clubId: string, gameId: string) =>
  `${clubPrefix(clubId)}result:${uuidKey(gameId)}:`;
const mutationPrefix = (clubId: string, gameId: string) =>
  `${clubPrefix(clubId)}mutation:${uuidKey(gameId)}:`;
// Each imported request costs one row deletion and at most one retirement row,
// plus the engine's control and receipt. Do not mix history with core deletion.
const MUTATION_CLEANUP_BATCH = 40;

interface GameRow {
  readonly gameId: string;
  readonly name: string;
  readonly revision: number;
  readonly status: "active" | "completed";
  readonly rulesetId: string;
  readonly rulesetVersion: number;
  readonly createdAt?: Date;
  readonly lastMutationId?: string;
  readonly updatedAt: Date;
  readonly blobName: string;
  readonly blobSha256: string;
  readonly blobLength: number;
}
interface Snapshot {
  readonly formatVersion: 1;
  readonly session: {
    readonly gameId: string;
    readonly name: string;
    readonly revision: number;
    readonly status: "active" | "completed";
    readonly rulesetId: string;
    readonly rulesetVersion: number;
    readonly updatedAt: string;
    readonly state: GameSessionState;
    readonly results: FinalGameResults | null;
  };
  readonly events: readonly (Omit<GameEvent, "createdAt"> & { readonly createdAt: string })[];
  // Retained source-only fields are provenance, not public/canonical game state.
  readonly postgres?: Readonly<Record<string, unknown>>;
}
interface PlayerRow {
  readonly id: string;
  readonly retiredAt?: Date | null;
}

// Keep aggregate, events and derived rows in the same fenced transaction. No
// event-per-row Table writes: history is part of the digest-checked snapshot.
const readSnapshot = async (tx: AzureTransaction, row: GameRow): Promise<Snapshot> => {
  const snapshot = await tx.readBlob<Snapshot>(blobReference(row));
  if (
    snapshot.formatVersion !== 1 ||
    snapshot.session.gameId !== row.gameId ||
    snapshot.session.revision !== row.revision ||
    snapshot.session.status !== row.status ||
    snapshot.session.name !== row.name ||
    snapshot.session.rulesetId !== row.rulesetId ||
    snapshot.session.rulesetVersion !== row.rulesetVersion ||
    snapshot.session.updatedAt !== new Date(row.updatedAt).toISOString() ||
    !Array.isArray(snapshot.events)
  ) {
    throw new Error("Incompatible game snapshot metadata");
  }
  assertSupportedGame(snapshot.session.state, snapshot.session.results);
  assertSupportedGame({ events: snapshot.events.map(({ payload }) => ({ payload })) }, null);
  return snapshot;
};
const stored = (snapshot: Snapshot, duplicate = false): StoredGameSession => ({
  ...snapshot.session,
  updatedAt: new Date(snapshot.session.updatedAt),
  duplicate,
});
const summary = (snapshot: Snapshot): GameSessionSummary => {
  const { session } = snapshot;
  const state = session.state;
  const game = record(state.game) ? state.game : null;
  const setup = record(state.setup) ? state.setup : null;
  return {
    gameId: session.gameId,
    name: session.name,
    revision: session.revision,
    hostPlayerId:
      text(state.hostPlayerId) ||
      text(setup?.hostPlayerId) ||
      (record(session.results) ? text(session.results.hostPlayerId) : null) ||
      null,
    phase: text(game?.phase) ?? text(setup?.step) ?? "setup",
    day: integer(game?.day) ?? 0,
    updatedAt: new Date(session.updatedAt),
  };
};
const projectedEvents = async (
  tx: AzureTransaction,
  clubId: string,
  gameId: string,
  state: GameSessionState,
): Promise<Snapshot["events"]> => {
  const ids = new Set<string>();
  const sequences = new Set<number>();
  // PostgreSQL's event ID reservation is club-wide, not just game-local.
  // Inspect existing immutable views without adding per-event Table writes.
  for (const row of await tx.list<GameRow>(`${clubPrefix(clubId)}game:`)) {
    if (uuidKey(row.gameId) === uuidKey(gameId)) continue;
    for (const event of (await readSnapshot(tx, row)).events) ids.add(uuidKey(event.id));
  }
  const createdAt = new Date().toISOString();
  const candidates = Array.isArray(state.events) ? state.events : [];
  return candidates.flatMap((candidate) => {
    if (
      !record(candidate) ||
      typeof candidate.id !== "string" ||
      !uuid.test(candidate.id) ||
      !Number.isInteger(candidate.sequence) ||
      (candidate.sequence as number) < 1 ||
      typeof candidate.type !== "string" ||
      !candidate.type.trim() ||
      typeof candidate.phaseBefore !== "string" ||
      !candidate.phaseBefore.trim() ||
      !record(candidate.payload)
    )
      return [];
    const id = uuidKey(candidate.id);
    const sequence = candidate.sequence as number;
    if (ids.has(id) || sequences.has(sequence)) return [];
    ids.add(id);
    sequences.add(sequence);
    return [
      {
        id,
        gameId,
        sequence: candidate.sequence as number,
        idempotencyKey: candidate.id,
        type: candidate.type,
        phase: candidate.phaseBefore,
        payload: candidate.payload,
        createdAt,
        duplicate: false,
        // Preserve the existing SQL-derived API view. Canonical metadata stays
        // untouched in session.state, rather than gaining a new public contract.
        parentEventId: null,
        replayVersion: 1,
        stateHashAfter: null,
      },
    ];
  });
};
const eligiblePlayers = async (
  tx: AzureTransaction,
  clubId: string,
  state: GameSessionState,
  results: FinalGameResults | null,
  newSelection: boolean,
): Promise<void> => {
  const refs = inspectGameIdentities(state, results);
  assertSupportedGame(state, results);
  if (refs.invalid || state.hostPlayerId === CASPER_PLAYER_ID) throw new InvalidGameIdentityError();
  for (const id of refs.all) {
    const player = await tx.get<PlayerRow>(`${clubPrefix(clubId)}player:${uuidKey(id)}`);
    if (!player || (player.retiredAt && (newSelection || refs.selected.has(id))))
      throw new InvalidGameIdentityError();
  }
};
const available = async (
  tx: AzureTransaction,
  clubId: string,
  ids: readonly string[],
): Promise<boolean> => {
  for (const id of ids) {
    if (!(await tx.get<PlayerRow>(`${clubPrefix(clubId)}player:${uuidKey(id)}`))) return false;
  }
  return true;
};
const removeProjection = async (
  tx: AzureTransaction,
  clubId: string,
  gameId: string,
): Promise<void> => {
  for (const prefix of [participantPrefix(clubId, gameId), resultPrefix(clubId, gameId)]) {
    for (const row of await tx.list(prefix))
      await tx.delete(`${prefix}${row.rowKey.slice(prefix.length)}`);
  }
};
const synchronize = async (
  tx: AzureTransaction,
  clubId: string,
  gameId: string,
  state: GameSessionState,
  results: FinalGameResults | null,
): Promise<void> => {
  await removeProjection(tx, clubId, gameId);
  if (state.hostPlayerId !== CASPER_PLAYER_ID) {
    const hostPlayerId =
      typeof state.hostPlayerId === "string" && uuid.test(state.hostPlayerId)
        ? state.hostPlayerId
        : null;
    const game = record(state.game) ? state.game : null;
    const rawPlayers = Array.isArray(game?.players) ? game.players : [];
    const players = rawPlayers.flatMap((candidate) => {
      if (
        !record(candidate) ||
        typeof candidate.id !== "string" ||
        (!uuid.test(candidate.id) && candidate.id !== CASPER_PLAYER_ID)
      )
        return [];
      const seat = integer(candidate.seat);
      const role = text(candidate.role);
      if (
        seat === null ||
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
      players.length === rawPlayers.length &&
      (!players.some(({ id }) => id === CASPER_PLAYER_ID) || players.length === 10) &&
      new Set(players.map(({ id }) => id)).size === players.length &&
      new Set(players.map(({ seat }) => seat)).size === players.length
    ) {
      const real = players.filter(({ id }) => id !== CASPER_PLAYER_ID);
      if (
        await available(tx, clubId, [
          ...(hostPlayerId ? [hostPlayerId] : []),
          ...real.map(({ id }) => id),
        ])
      ) {
        if (hostPlayerId)
          await tx.set(`${participantPrefix(clubId, gameId)}${uuidKey(hostPlayerId)}`, {
            gameId,
            playerId: hostPlayerId,
            isHost: true,
          });
        for (const player of real)
          await tx.set(`${participantPrefix(clubId, gameId)}${uuidKey(player.id)}`, {
            gameId,
            playerId: player.id,
            seat: player.seat,
            role: player.role,
            isHost: false,
          });
      }
    }
  }
  const projection = projectableResults(results);
  if (!projection) return;
  const real = projection.players.filter(({ playerId }) => playerId !== CASPER_PLAYER_ID);
  if (
    !(await available(tx, clubId, [
      projection.hostPlayerId,
      ...real.map(({ playerId }) => playerId),
    ]))
  )
    return;
  if (projection.outcome === "cancelled") return;
  const common = {
    gameId,
    playedAt: new Date(projection.playedAt),
    outcome: projection.outcome,
    ...(projection.winner ? { winner: projection.winner } : {}),
  };
  await tx.set(`${resultPrefix(clubId, gameId)}${uuidKey(projection.hostPlayerId)}`, {
    ...common,
    playerId: projection.hostPlayerId,
    isHost: true,
  });
  for (const player of real)
    await tx.set(`${resultPrefix(clubId, gameId)}${uuidKey(player.playerId)}`, {
      ...common,
      playerId: player.playerId,
      isHost: false,
      seat: player.seat,
      role: player.role,
      team: player.team,
      status: player.status,
      fouls: player.fouls,
      ...(player.bestMoveHits !== null ? { bestMoveHits: player.bestMoveHits } : {}),
      ...(projection.outcome !== "draw" ? { won: player.team === projection.winner } : {}),
    });
};

export class AzureGameSessionStore {
  public constructor(private readonly storage: AzureStorage) {}
  public async initialize(): Promise<void> {
    await this.storage.ready();
  }

  public async create(input: CreateGameSessionInput): Promise<StoredGameSession> {
    const clubId = input.clubId ?? DEFAULT_CLUB_ID;
    return this.storage.mutate(async (tx) => {
      if (await tx.get(clubDeletedKey(clubId))) throw new DeletedGameError(input.creationId);
      const mapped = await tx.get<{ gameId: string }>(creationKey(clubId, input.creationId));
      if (mapped) {
        const row = await tx.get<GameRow>(gameKey(clubId, mapped.gameId));
        if (!row) throw new DeletedGameError(mapped.gameId);
        return stored(await readSnapshot(tx, row), true);
      }
      if (!(await tx.get(`${clubPrefix(clubId)}meta`))) throw new Error("Club does not exist");
      await eligiblePlayers(tx, clubId, input.state, input.results, true);
      const gameId = randomUUID();
      const updatedAt = new Date();
      const snapshot: Snapshot = {
        formatVersion: 1,
        session: {
          gameId,
          name: input.name.trim(),
          revision: 1,
          status: input.results === null ? "active" : "completed",
          rulesetId: "club-mafia",
          rulesetVersion: 1,
          updatedAt: updatedAt.toISOString(),
          state: input.state,
          results: input.results,
        },
        events: await projectedEvents(tx, clubId, gameId, input.state),
      };
      const blob = await tx.writeBlob(snapshot, `club/${uuidKey(clubId)}/game/${uuidKey(gameId)}`);
      await tx.set(gameKey(clubId, gameId), {
        gameId,
        name: snapshot.session.name,
        revision: 1,
        status: snapshot.session.status,
        rulesetId: "club-mafia",
        rulesetVersion: 1,
        updatedAt,
        ...blobFields(blob),
      });
      await tx.set(creationKey(clubId, input.creationId), { gameId });
      await synchronize(tx, clubId, gameId, input.state, input.results);
      return stored(snapshot);
    });
  }

  public async save(input: SaveGameSessionInput): Promise<StoredGameSession> {
    const clubId = input.clubId ?? DEFAULT_CLUB_ID;
    return this.storage.mutate(async (tx) => {
      if (await tx.get(clubDeletedKey(clubId))) throw new GameSessionNotFoundError();
      const key = gameKey(clubId, input.gameId);
      const row = await tx.get<GameRow>(key);
      if (!row) throw new GameSessionNotFoundError();
      const previous = await readSnapshot(tx, row);
      // SDK Date conversion loses PostgreSQL's fractional microseconds. The
      // validated imported source spelling remains in envelope provenance, so
      // republish it as an EDM DateTime rather than round-trip through Date.
      const createdAt =
        row.createdAt === undefined
          ? undefined
          : typeof previous.postgres?.createdAt === "string"
            ? { type: "DateTime", value: previous.postgres.createdAt.replace(/\+00:00$/, "Z") }
            : row.createdAt;
      await eligiblePlayers(tx, clubId, input.state, input.results, false);
      const updatedAt = new Date();
      const snapshot: Snapshot = {
        formatVersion: 1,
        session: {
          gameId: row.gameId,
          name: input.name.trim(),
          revision: row.revision + 1,
          status: input.results === null ? "active" : "completed",
          rulesetId: row.rulesetId,
          rulesetVersion: row.rulesetVersion,
          updatedAt: updatedAt.toISOString(),
          state: input.state,
          results: input.results,
        },
        events: await projectedEvents(tx, clubId, row.gameId, input.state),
        ...(previous.postgres === undefined
          ? {}
          : {
              postgres: {
                ...previous.postgres,
                lastMutationId: input.mutationId,
                updatedAt: updatedAt.toISOString(),
              },
            }),
      };
      const blob = await tx.writeBlob(
        snapshot,
        `club/${uuidKey(clubId)}/game/${uuidKey(row.gameId)}`,
      );
      await tx.set(key, {
        gameId: row.gameId,
        name: snapshot.session.name,
        revision: snapshot.session.revision,
        status: snapshot.session.status,
        rulesetId: row.rulesetId,
        rulesetVersion: row.rulesetVersion,
        ...(createdAt === undefined ? {} : { createdAt }),
        lastMutationId: input.mutationId,
        updatedAt,
        ...blobFields(blob),
      });
      await synchronize(tx, clubId, row.gameId, input.state, input.results);
      await tx.retireBlob(blobReference(row));
      return stored(snapshot);
    });
  }

  public async clear({
    clubId = DEFAULT_CLUB_ID,
    gameId,
  }: {
    readonly clubId?: string;
    readonly gameId: string;
  }): Promise<void> {
    await this.storage.mutate(async (tx) => {
      if (await tx.get(clubDeletedKey(clubId))) return;
      const key = gameKey(clubId, gameId);
      const row = await tx.get<GameRow>(key);
      if (row) {
        await tx.delete(key);
        await removeProjection(tx, clubId, gameId);
        await tx.retireBlob(blobReference(row));
      }
      if (!(await tx.get(deletedKey(clubId, gameId))))
        await tx.set(deletedKey(clubId, gameId), { gameId, deletedAt: new Date() });
    });
    // The aggregate, projections, snapshot retirement and durable tombstone are
    // already atomically committed. Imported retry history can be arbitrarily
    // long: drain bounded groups, never truncate or delete Blobs in normal mode.
    // An interruption leaves the game deleted; another clear resumes the drain.
    while (await this.retireImportedMutations(clubId, gameId)) {
      // Query the remaining prefix again; no cursor can skip a failed chunk.
    }
  }

  private async retireImportedMutations(clubId: string, gameId: string): Promise<boolean> {
    const prefix = mutationPrefix(clubId, gameId);
    return this.storage.mutate(async (tx) => {
      if (
        (await tx.get(clubDeletedKey(clubId))) ||
        !(await tx.get(deletedKey(clubId, gameId))) ||
        (await tx.get(gameKey(clubId, gameId)))
      )
        return false;
      let count = 0;
      try {
        const pages = this.storage.table
          .listEntities<Record<string, unknown>>({
            queryOptions: {
              filter: odata`PartitionKey eq ${this.storage.options.partitionKey} and RowKey ge ${prefix} and RowKey lt ${prefix + "~"}`,
            },
          })
          .byPage({ maxPageSize: MUTATION_CLEANUP_BATCH });
        for await (const page of pages) {
          for (const entry of page) {
            if (typeof entry.rowKey !== "string")
              throw new StorageUnavailableError("Invalid imported mutation key");
            const row = await tx.get<Record<string, unknown>>(entry.rowKey);
            if (!row) continue;
            if ([row.blobName, row.blobSha256, row.blobLength].some((value) => value !== undefined))
              await tx.retireBlob(blobReference(row));
            await tx.delete(entry.rowKey);
            if (++count === MUTATION_CLEANUP_BATCH) break;
          }
          if (count === MUTATION_CLEANUP_BATCH) break;
        }
      } catch (error) {
        if (error instanceof StorageUnavailableError) throw error;
        throw new StorageUnavailableError("Imported game mutation cleanup failed", {
          cause: error,
        });
      }
      return count > 0;
    });
  }

  public async get(gameId: string, clubId = DEFAULT_CLUB_ID): Promise<StoredGameSession | null> {
    return this.storage.read(async (tx) => {
      if (await tx.get(clubDeletedKey(clubId))) return null;
      const row = await tx.get<GameRow>(gameKey(clubId, gameId));
      return row ? stored(await readSnapshot(tx, row)) : null;
    });
  }

  public async listActive(clubId = DEFAULT_CLUB_ID): Promise<readonly GameSessionSummary[]> {
    return this.storage.read(async (tx) => {
      if (await tx.get(clubDeletedKey(clubId))) return [];
      const rows = await tx.list<GameRow>(`${clubPrefix(clubId)}game:`);
      const summaries: GameSessionSummary[] = [];
      for (const row of rows) {
        if (row.status === "active") summaries.push(summary(await readSnapshot(tx, row)));
      }
      return summaries.sort(
        (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.gameId.localeCompare(b.gameId),
      );
    });
  }

  public async listCompleted(
    clubId = DEFAULT_CLUB_ID,
    filters: CompletedGameSessionFilters = {},
  ): Promise<readonly CompletedGameSessionSummary[]> {
    return this.storage.read(async (tx) => {
      if (await tx.get(clubDeletedKey(clubId))) return [];
      if (
        filters.playerId &&
        !(await tx.get<PlayerRow>(`${clubPrefix(clubId)}player:${uuidKey(filters.playerId)}`))
      )
        return [];
      const rows = await tx.list<GameRow>(`${clubPrefix(clubId)}game:`);
      const completed: CompletedGameSessionSummary[] = [];
      for (const row of rows) {
        if (row.status !== "completed") continue;
        const snapshot = await readSnapshot(tx, row);
        const metadata = completionMetadata(snapshot.session.results);
        if (!metadata) continue;
        const day = metadata.playedAt.slice(0, 10);
        if (
          (filters.from && day < filters.from) ||
          (filters.to && day > filters.to) ||
          (filters.outcome && metadata.outcome !== filters.outcome) ||
          (filters.playerId &&
            (!record(snapshot.session.results) ||
              !Array.isArray(snapshot.session.results.players) ||
              !snapshot.session.results.players.some(
                (player: unknown) => record(player) && player.playerId === filters.playerId,
              )))
        )
          continue;
        completed.push({
          ...summary(snapshot),
          ...metadata,
          rulesetId: row.rulesetId,
          rulesetVersion: row.rulesetVersion,
          eventCount: snapshot.events.length,
        });
      }
      return completed.sort(
        (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.gameId.localeCompare(b.gameId),
      );
    });
  }
}

export class AzureEventStore {
  public constructor(private readonly storage: AzureStorage) {}
  public async initialize(): Promise<void> {
    await this.storage.ready();
  }
  public async read(
    gameId: string,
    options: { readonly includeSecrets: boolean } = { includeSecrets: true },
    clubId = DEFAULT_CLUB_ID,
  ): Promise<readonly GameEvent[]> {
    return this.storage.read(async (tx) => {
      if (await tx.get(clubDeletedKey(clubId))) return [];
      const row = await tx.get<GameRow>(gameKey(clubId, gameId));
      if (!row) return [];
      const snapshot = await readSnapshot(tx, row);
      return snapshot.events
        .map((entry) => {
          const event: GameEvent = { ...entry, createdAt: new Date(entry.createdAt) };
          if (options.includeSecrets) return event;
          return {
            ...event,
            stateHashAfter: null,
            ...(isSecretGameEventType(event.type) ? { payload: { redacted: true } } : {}),
          };
        })
        .sort((a, b) => a.sequence - b.sequence);
    });
  }
}
