import {
  replayGameLog,
  type GameLogEntry,
  type GameState,
  type InitialGameBaseline,
} from "@mafia/game-domain";
import type { FinalGameResults, GameSessionState } from "./api/client.js";
import { reportError } from "./features/console/error-console.js";

export interface SessionSaveResponse {
  readonly revision: number;
  readonly duplicate: boolean;
  readonly name?: string;
  readonly gameId?: string;
  readonly state?: GameSessionState;
  readonly results?: FinalGameResults | null;
}

interface OutboxOptions {
  readonly storage: Storage;
  readonly storageKey?: string;
  readonly legacyStorageKey?: string;
  readonly createId: () => string;
  readonly save: (gameId: string, operation: GameSessionOperation) => Promise<SessionSaveResponse>;
  readonly read?: (gameId: string) => Promise<SessionSaveResponse>;
  readonly clearRemote?: (gameId: string, expectedRevision: number) => Promise<void>;
  readonly saveLegacy?: (
    gameId: string,
    mutation: LegacyGameSessionMutation,
  ) => Promise<SessionSaveResponse>;
}

interface CurrentSession {
  readonly name: string;
  readonly state: GameSessionState;
  readonly results: FinalGameResults | null;
}

interface LegacyGameSessionMutation {
  readonly name: string;
  readonly mutationId: string;
  readonly baseRevision: number;
  readonly state: GameSessionState;
  readonly results: FinalGameResults | null;
}

interface LegacyPersistedEnvelope {
  readonly version: 3;
  readonly gameId: string | null;
  readonly revision: number;
  readonly current: CurrentSession | null;
  readonly outbox: readonly LegacyGameSessionMutation[];
  readonly normalizationOperation?: Extract<GameSessionOperation, { readonly kind: "normalize" }>;
  readonly failed: boolean;
  readonly clearFailed: boolean;
  readonly clearingGameId: string | null;
}

export interface SessionMetadata {
  readonly setup: unknown | null;
  readonly hostPlayerId: string | null;
  readonly hostName: string | null;
  readonly playlistId: string;
  readonly legacyLog: readonly unknown[];
}

interface OperationBase {
  readonly name: string;
  readonly mutationId: string;
  readonly baseRevision: number;
}

export type GameSessionOperation =
  | (OperationBase & {
      readonly kind: "metadata";
      readonly metadata: SessionMetadata;
    })
  | (OperationBase & {
      readonly kind: "normalize";
    })
  | (OperationBase & {
      readonly kind: "start";
      readonly baseline: InitialGameBaseline;
      readonly event: GameLogEntry;
    })
  | (OperationBase & {
      readonly kind: "append-event";
      readonly event: GameLogEntry;
    })
  | (OperationBase & {
      readonly kind: "move-head";
      readonly targetEventId: string;
      readonly reason: "undo" | "reset" | "restore-reset";
    })
  | (OperationBase & {
      readonly kind: "complete";
      readonly results: FinalGameResults;
    });

interface PersistedEnvelope {
  readonly version: 4;
  readonly gameId: string | null;
  readonly revision: number;
  readonly name: string | null;
  readonly metadata: SessionMetadata;
  readonly baseline: InitialGameBaseline | null;
  readonly entries: readonly GameLogEntry[];
  readonly headEventId: string | null;
  readonly resetReturnEventId: string | null;
  readonly results: FinalGameResults | null;
  readonly outbox: readonly GameSessionOperation[];
  readonly failed: boolean;
  readonly clearFailed: boolean;
  readonly clearingGameId: string | null;
}

const defaultStorageKey = "mafia-dashboard.game-session.v4";

const emptyMetadata = (): SessionMetadata => ({
  setup: null,
  hostPlayerId: null,
  hostName: null,
  playlistId: "",
  legacyLog: [],
});

const emptyEnvelope = (): PersistedEnvelope => ({
  version: 4,
  gameId: null,
  revision: 0,
  name: null,
  metadata: emptyMetadata(),
  baseline: null,
  entries: [],
  headEventId: null,
  resetReturnEventId: null,
  results: null,
  outbox: [],
  failed: false,
  clearFailed: false,
  clearingGameId: null,
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string =>
  typeof value === "string" && uuidPattern.test(value);
const isNullableUuid = (value: unknown): value is string | null => value === null || isUuid(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0;

const isGameLogEntry = (value: unknown): value is GameLogEntry =>
  isRecord(value) &&
  value.replayVersion === 1 &&
  isUuid(value.id) &&
  isUuid(value.gameId) &&
  isNonNegativeInteger(value.sequence) &&
  value.sequence > 0 &&
  isNullableUuid(value.parentEventId) &&
  typeof value.type === "string" &&
  isRecord(value.payload) &&
  typeof value.secret === "boolean" &&
  typeof value.phaseBefore === "string" &&
  typeof value.phaseAfter === "string" &&
  isNonNegativeInteger(value.dayBefore) &&
  isNonNegativeInteger(value.dayAfter) &&
  typeof value.stateHashAfter === "string" &&
  typeof value.createdAt === "string";

const isInitialGameBaseline = (value: unknown): value is InitialGameBaseline =>
  isRecord(value) && value.replayVersion === 1 && isRecord(value.game);

const isFinalGameResults = (value: unknown): value is FinalGameResults =>
  isRecord(value) &&
  typeof value.hostPlayerId === "string" &&
  (value.winner === "red" || value.winner === "black") &&
  typeof value.playedAt === "string" &&
  Array.isArray(value.players) &&
  value.players.every(
    (player) =>
      isRecord(player) &&
      typeof player.playerId === "string" &&
      isNonNegativeInteger(player.seat) &&
      (player.role === "sheriff" ||
        player.role === "citizen" ||
        player.role === "mafia" ||
        player.role === "don") &&
      (player.team === "red" || player.team === "black") &&
      (player.status === "active" ||
        player.status === "eliminated" ||
        player.status === "red-carded") &&
      isNonNegativeInteger(player.fouls) &&
      (player.bestMoveHits === null || isNonNegativeInteger(player.bestMoveHits)),
  );

const isSessionMetadata = (value: unknown): value is SessionMetadata =>
  isRecord(value) &&
  (value.setup === null || isRecord(value.setup)) &&
  isNullableString(value.hostPlayerId) &&
  isNullableString(value.hostName) &&
  typeof value.playlistId === "string" &&
  Array.isArray(value.legacyLog);

const isGameSessionState = (value: unknown): value is GameSessionState =>
  isRecord(value) &&
  (value.setup === null || isRecord(value.setup)) &&
  (value.game === null || isRecord(value.game)) &&
  isNullableString(value.hostPlayerId) &&
  isNullableString(value.hostName) &&
  typeof value.playlistId === "string" &&
  Array.isArray(value.log) &&
  Array.isArray(value.undoHistory) &&
  (value.initialGame === undefined ||
    value.initialGame === null ||
    isInitialGameBaseline(value.initialGame)) &&
  (value.events === undefined ||
    (Array.isArray(value.events) && value.events.every(isGameLogEntry))) &&
  (value.headEventId === undefined || isNullableString(value.headEventId)) &&
  (value.resetReturnEventId === undefined || isNullableString(value.resetReturnEventId)) &&
  (value.legacyLog === undefined || Array.isArray(value.legacyLog));

const isOperationBase = (value: Readonly<Record<string, unknown>>): boolean =>
  typeof value.name === "string" &&
  isUuid(value.mutationId) &&
  isNonNegativeInteger(value.baseRevision);

const isGameSessionOperation = (value: unknown): value is GameSessionOperation => {
  if (!isRecord(value) || !isOperationBase(value)) return false;
  switch (value.kind) {
    case "metadata":
      return isSessionMetadata(value.metadata);
    case "normalize":
      return true;
    case "start":
      return isInitialGameBaseline(value.baseline) && isGameLogEntry(value.event);
    case "append-event":
      return isGameLogEntry(value.event);
    case "move-head":
      return (
        isUuid(value.targetEventId) &&
        (value.reason === "undo" || value.reason === "reset" || value.reason === "restore-reset")
      );
    case "complete":
      return isFinalGameResults(value.results);
    default:
      return false;
  }
};

const assertSessionSaveResponse = (value: unknown): SessionSaveResponse => {
  if (
    !isRecord(value) ||
    !isNonNegativeInteger(value.revision) ||
    typeof value.duplicate !== "boolean" ||
    !(value.name === undefined || typeof value.name === "string") ||
    !(value.gameId === undefined || isUuid(value.gameId)) ||
    !(value.state === undefined || isGameSessionState(value.state)) ||
    !(value.results === undefined || value.results === null || isFinalGameResults(value.results))
  ) {
    throw new Error("Invalid game session save response");
  }
  return value as unknown as SessionSaveResponse;
};

const isPersistedEnvelope = (value: unknown): value is PersistedEnvelope => {
  if (
    !isRecord(value) ||
    value.version !== 4 ||
    !isNullableUuid(value.gameId) ||
    !isNonNegativeInteger(value.revision) ||
    !isNullableString(value.name) ||
    !isSessionMetadata(value.metadata) ||
    !(value.baseline === null || isInitialGameBaseline(value.baseline)) ||
    !Array.isArray(value.entries) ||
    !value.entries.every(isGameLogEntry) ||
    !isNullableUuid(value.headEventId) ||
    !isNullableUuid(value.resetReturnEventId) ||
    !(value.results === null || isFinalGameResults(value.results)) ||
    !Array.isArray(value.outbox) ||
    !value.outbox.every(isGameSessionOperation) ||
    typeof value.failed !== "boolean" ||
    typeof value.clearFailed !== "boolean" ||
    !isNullableUuid(value.clearingGameId)
  ) {
    return false;
  }
  if (value.gameId === null && value.outbox.length > 0) return false;
  if (
    (value.gameId === null && value.entries.length > 0) ||
    value.entries.some(({ gameId }) => gameId !== value.gameId) ||
    value.outbox.some(
      (operation) =>
        (operation.kind === "start" || operation.kind === "append-event") &&
        operation.event.gameId !== value.gameId,
    )
  ) {
    return false;
  }
  const revision = value.revision as number;
  if (!value.outbox.every((operation, index) => operation.baseRevision === revision + index)) {
    return false;
  }
  const entryIds = new Set(value.entries.map(({ id }) => id));
  return (
    (value.headEventId === null || entryIds.has(value.headEventId)) &&
    (value.resetReturnEventId === null || entryIds.has(value.resetReturnEventId))
  );
};

const loadEnvelope = (storage: Storage, storageKey: string): PersistedEnvelope => {
  try {
    const raw = storage.getItem(storageKey);
    if (raw === null) return emptyEnvelope();
    const parsed: unknown = JSON.parse(raw);
    return isPersistedEnvelope(parsed) ? parsed : emptyEnvelope();
  } catch (error) {
    reportError(error, { source: "persistence", context: "game-session-envelope.read" });
    return emptyEnvelope();
  }
};

const isCurrentSession = (value: unknown): value is CurrentSession =>
  isRecord(value) &&
  typeof value.name === "string" &&
  isGameSessionState(value.state) &&
  (value.results === null || isFinalGameResults(value.results));

const isLegacyGameSessionMutation = (value: unknown): value is LegacyGameSessionMutation =>
  isRecord(value) &&
  typeof value.name === "string" &&
  isUuid(value.mutationId) &&
  isNonNegativeInteger(value.baseRevision) &&
  isGameSessionState(value.state) &&
  (value.results === null || isFinalGameResults(value.results));

const isLegacyPersistedEnvelope = (value: unknown): value is LegacyPersistedEnvelope => {
  if (
    !isRecord(value) ||
    value.version !== 3 ||
    !isNullableUuid(value.gameId) ||
    !isNonNegativeInteger(value.revision) ||
    !(value.current === null || isCurrentSession(value.current)) ||
    !Array.isArray(value.outbox) ||
    !value.outbox.every(isLegacyGameSessionMutation) ||
    !(
      value.normalizationOperation === undefined ||
      (isGameSessionOperation(value.normalizationOperation) &&
        value.normalizationOperation.kind === "normalize")
    ) ||
    typeof value.failed !== "boolean" ||
    typeof value.clearFailed !== "boolean" ||
    !isNullableUuid(value.clearingGameId)
  ) {
    return false;
  }
  if (
    value.gameId === null &&
    (value.outbox.length > 0 || value.normalizationOperation !== undefined)
  ) {
    return false;
  }
  const revision = value.revision as number;
  if (!value.outbox.every((mutation, index) => mutation.baseRevision === revision + index)) {
    return false;
  }
  return (
    value.normalizationOperation === undefined ||
    value.normalizationOperation.baseRevision === revision + value.outbox.length
  );
};

const loadLegacyEnvelope = (
  storage: Storage,
  storageKey: string,
): LegacyPersistedEnvelope | null => {
  try {
    const raw = storage.getItem(storageKey);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isLegacyPersistedEnvelope(parsed) ? parsed : null;
  } catch (error) {
    reportError(error, { source: "persistence", context: "legacy-game-session-envelope.read" });
    return null;
  }
};

const canonicalJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
  );
};

const sameCurrent = (left: CurrentSession | null, right: CurrentSession): boolean =>
  left !== null &&
  JSON.stringify(canonicalJsonValue(left)) === JSON.stringify(canonicalJsonValue(right));

const sameEnvelope = (left: PersistedEnvelope, right: PersistedEnvelope): boolean =>
  JSON.stringify(canonicalJsonValue(left)) === JSON.stringify(canonicalJsonValue(right));

const metadataFromState = (state: GameSessionState): SessionMetadata => ({
  setup: state.setup,
  hostPlayerId: state.hostPlayerId,
  hostName: state.hostName,
  playlistId: state.playlistId,
  legacyLog: state.legacyLog ?? (state.initialGame == null ? state.log : []),
});

const currentFromEnvelope = (envelope: PersistedEnvelope): CurrentSession | null => {
  if (envelope.name === null) return null;
  return {
    name: envelope.name,
    state: {
      setup: envelope.metadata.setup,
      game: envelope.baseline === null ? null : null,
      hostPlayerId: envelope.metadata.hostPlayerId,
      hostName: envelope.metadata.hostName,
      playlistId: envelope.metadata.playlistId,
      log: envelope.metadata.legacyLog,
      undoHistory: [],
      initialGame: envelope.baseline,
      events: envelope.entries,
      headEventId: envelope.headEventId,
      resetReturnEventId: envelope.resetReturnEventId,
      legacyLog: envelope.metadata.legacyLog,
    },
    results: envelope.results,
  };
};

interface DesiredSession {
  readonly name: string;
  readonly metadata: SessionMetadata;
  readonly baseline: InitialGameBaseline | null;
  readonly entries: readonly GameLogEntry[];
  readonly headEventId: string | null;
  readonly resetReturnEventId: string | null;
  readonly results: FinalGameResults | null;
  readonly normalize: boolean;
}

const desiredSession = (
  name: string,
  state: GameSessionState,
  results: FinalGameResults | null,
): DesiredSession => ({
  name,
  metadata: metadataFromState(state),
  baseline:
    state.initialGame ??
    (state.game === null ? null : { replayVersion: 1, game: state.game as GameState }),
  entries: state.events ?? [],
  headEventId: state.headEventId ?? state.events?.at(-1)?.id ?? null,
  resetReturnEventId: state.resetReturnEventId ?? null,
  results,
  normalize: state.initialGame == null && state.game !== null,
});

const validateDesiredReplay = (
  gameId: string,
  desired: DesiredSession,
  requireCanonical = false,
): void => {
  if (desired.entries.some((entry) => entry.gameId !== gameId)) {
    throw new Error("Game session contains a cross-game event");
  }
  if (desired.entries.length === 0) {
    if (requireCanonical || desired.headEventId !== null || desired.resetReturnEventId !== null) {
      throw new Error("Game session canonical history is incomplete");
    }
    return;
  }
  if (desired.baseline === null || desired.headEventId === null) {
    throw new Error("Game session canonical history is incomplete");
  }
  const byId = new Map(desired.entries.map((entry) => [entry.id, entry]));
  const active: GameLogEntry[] = [];
  const seen = new Set<string>();
  let eventId: string | null = desired.headEventId;
  while (eventId !== null) {
    if (seen.has(eventId)) throw new Error("Game session canonical history contains a cycle");
    seen.add(eventId);
    const entry = byId.get(eventId);
    if (entry === undefined) throw new Error("Game session canonical history is disconnected");
    active.push(entry);
    eventId = entry.parentEventId;
  }
  active.reverse();
  if (active[0]?.type !== "game.started" && active[0]?.type !== "game.checkpointed") {
    throw new Error("Game session canonical history has no lifecycle root");
  }
  if (desired.resetReturnEventId !== null && !byId.has(desired.resetReturnEventId)) {
    throw new Error("Game session reset-return event is missing");
  }
  replayGameLog(desired.baseline, active);
};

const currentFromDesired = (desired: DesiredSession): CurrentSession => ({
  name: desired.name,
  state: {
    setup: desired.metadata.setup,
    game: null,
    hostPlayerId: desired.metadata.hostPlayerId,
    hostName: desired.metadata.hostName,
    playlistId: desired.metadata.playlistId,
    log: desired.metadata.legacyLog,
    undoHistory: [],
    initialGame: desired.baseline,
    events: desired.entries,
    headEventId: desired.headEventId,
    resetReturnEventId: desired.resetReturnEventId,
    legacyLog: desired.metadata.legacyLog,
  },
  results: desired.results,
});

export class GameSessionOutbox {
  private envelope: PersistedEnvelope;
  private flushPromise: Promise<void> | null = null;
  private clearCount = 0;
  private readonly pendingClears = new Map<string, number>();
  private generation = 0;
  private normalizationAvailable = false;
  private readonly listeners = new Set<() => void>();
  private readonly storageKey: string;
  private migratingLegacyKey: string | null = null;
  private legacyEnvelope: LegacyPersistedEnvelope | null = null;
  private storageSnapshot: string | null;
  private legacyStorageSnapshot: string | null;

  public constructor(private readonly options: OutboxOptions) {
    this.storageKey = options.storageKey ?? defaultStorageKey;
    this.storageSnapshot = options.storage.getItem(this.storageKey);
    this.legacyStorageSnapshot =
      options.legacyStorageKey === undefined
        ? null
        : options.storage.getItem(options.legacyStorageKey);
    this.envelope = loadEnvelope(options.storage, this.storageKey);
    if (this.envelope.name !== null) {
      if (options.legacyStorageKey !== undefined) {
        if (this.envelope.outbox.some(({ kind }) => kind === "normalize")) {
          this.migratingLegacyKey = options.legacyStorageKey;
        } else {
          options.storage.removeItem(options.legacyStorageKey);
          this.legacyStorageSnapshot = null;
        }
      }
      this.resumeDurableClear();
      return;
    }
    if (options.legacyStorageKey === undefined) return;
    const legacy = loadLegacyEnvelope(options.storage, options.legacyStorageKey);
    if (legacy?.current === null || legacy?.current === undefined) return;
    this.migratingLegacyKey = options.legacyStorageKey;
    if (legacy.outbox.length > 0) {
      this.legacyEnvelope = legacy;
      return;
    }
    const desired = desiredSession(
      legacy.current.name,
      legacy.current.state,
      legacy.current.results,
    );
    const normalizationOperation =
      legacy.gameId === null
        ? undefined
        : (legacy.normalizationOperation ?? {
            kind: "normalize" as const,
            name: desired.name,
            mutationId: options.createId(),
            baseRevision: legacy.revision,
          });
    if (normalizationOperation !== undefined && legacy.normalizationOperation === undefined) {
      const serialized = JSON.stringify({ ...legacy, normalizationOperation });
      options.storage.setItem(options.legacyStorageKey, serialized);
      this.legacyStorageSnapshot = serialized;
    }
    this.envelope = {
      version: 4,
      gameId: legacy.gameId,
      revision: legacy.revision,
      name: desired.name,
      metadata: desired.metadata,
      baseline: desired.baseline,
      entries: desired.entries,
      headEventId: desired.headEventId,
      resetReturnEventId: desired.resetReturnEventId,
      results: desired.results,
      outbox: legacy.gameId === null ? [] : [normalizationOperation!],
      failed: legacy.failed,
      clearFailed: legacy.clearFailed,
      clearingGameId: legacy.clearingGameId,
    };
    this.persist();
  }

  private resumeDurableClear(): void {
    if (this.envelope.clearingGameId === null || this.options.clearRemote === undefined) return;
    void Promise.resolve()
      .then(() => this.clear(this.options.clearRemote!))
      .catch((error: unknown) => {
        reportError(error, { source: "persistence", context: "game-session.clear-recovery" });
      });
  }

  public get status(): "saved" | "saving" | "offline" {
    if (this.legacyEnvelope?.failed === true || this.legacyEnvelope?.clearFailed === true) {
      return "offline";
    }
    if (this.envelope.failed || this.envelope.clearFailed) return "offline";
    if (
      (this.legacyEnvelope?.outbox.length ?? 0) > 0 ||
      this.envelope.outbox.length > 0 ||
      this.flushPromise !== null ||
      this.clearCount > 0 ||
      this.envelope.clearingGameId !== null
    ) {
      return "saving";
    }
    return "saved";
  }

  public get pendingCount(): number {
    return (this.legacyEnvelope?.outbox.length ?? 0) + this.envelope.outbox.length;
  }

  public get normalizing(): boolean {
    return this.envelope.outbox.some(({ kind }) => kind === "normalize");
  }

  public takeNormalizedCurrent(): CurrentSession | null {
    if (!this.normalizationAvailable) return null;
    this.normalizationAvailable = false;
    return this.current;
  }

  public get gameId(): string | null {
    return this.legacyEnvelope?.gameId ?? this.envelope.gameId;
  }

  public get revision(): number {
    return this.legacyEnvelope?.revision ?? this.envelope.revision;
  }

  public get current(): CurrentSession | null {
    return this.legacyEnvelope?.current ?? currentFromEnvelope(this.envelope);
  }

  public ensureGameId(gameId: string): void {
    if (!isUuid(gameId)) throw new Error("Game identity must be a UUID");
    this.synchronizeDurableState();
    if (this.legacyEnvelope !== null) {
      if (this.legacyEnvelope.gameId !== null && this.legacyEnvelope.gameId !== gameId) {
        throw new Error("The active game already has a different identity");
      }
      if (this.legacyEnvelope.gameId === gameId) return;
      this.legacyEnvelope = { ...this.legacyEnvelope, gameId };
      this.persistLegacy();
      return;
    }
    if (this.envelope.gameId !== null && this.envelope.gameId !== gameId) {
      throw new Error("The active game already has a different identity");
    }
    if (this.envelope.gameId === gameId) return;
    this.envelope = { ...this.envelope, gameId };
    this.persist();
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private synchronizeDurableState(): boolean {
    const storageSnapshot = this.options.storage.getItem(this.storageKey);
    const legacyKey = this.options.legacyStorageKey ?? null;
    const legacyStorageSnapshot =
      legacyKey === null ? null : this.options.storage.getItem(legacyKey);
    if (
      storageSnapshot === this.storageSnapshot &&
      legacyStorageSnapshot === this.legacyStorageSnapshot
    ) {
      return false;
    }

    const envelope = loadEnvelope(this.options.storage, this.storageKey);
    const legacy = legacyKey === null ? null : loadLegacyEnvelope(this.options.storage, legacyKey);
    this.envelope = envelope;
    if (envelope.name !== null) {
      this.legacyEnvelope = null;
      this.migratingLegacyKey = envelope.outbox.some(({ kind }) => kind === "normalize")
        ? legacyKey
        : null;
    } else if (legacy?.current != null) {
      this.legacyEnvelope = legacy;
      this.migratingLegacyKey = legacyKey;
    } else {
      this.legacyEnvelope = null;
      this.migratingLegacyKey = null;
    }
    this.storageSnapshot = storageSnapshot;
    this.legacyStorageSnapshot = legacyStorageSnapshot;
    this.notify();
    return true;
  }

  private persistLegacy(): void {
    if (this.migratingLegacyKey === null || this.legacyEnvelope === null) return;
    const serialized = JSON.stringify(this.legacyEnvelope);
    this.options.storage.setItem(this.migratingLegacyKey, serialized);
    this.legacyStorageSnapshot = serialized;
    this.notify();
  }

  private persist(): void {
    if (
      this.migratingLegacyKey !== null &&
      !this.envelope.outbox.some(({ kind }) => kind === "normalize")
    ) {
      this.options.storage.removeItem(this.migratingLegacyKey);
      this.legacyStorageSnapshot = null;
      this.migratingLegacyKey = null;
    }
    if (this.envelope.name === null && this.envelope.outbox.length === 0) {
      this.options.storage.removeItem(this.storageKey);
      this.storageSnapshot = null;
    } else {
      const serialized = JSON.stringify(this.envelope);
      this.options.storage.setItem(this.storageKey, serialized);
      this.storageSnapshot = serialized;
    }
    this.notify();
  }

  public enqueue(name: string, state: GameSessionState, results: FinalGameResults | null): void {
    const synchronized = this.synchronizeDurableState();
    if (this.legacyEnvelope !== null) {
      const current = { name, state, results };
      if (sameCurrent(this.legacyEnvelope.current, current)) return;
      if (synchronized) throw new Error("Legacy session changed in another browser context");
      const mutation: LegacyGameSessionMutation = {
        name,
        mutationId: this.options.createId(),
        baseRevision: this.legacyEnvelope.revision + this.legacyEnvelope.outbox.length,
        state,
        results,
      };
      this.legacyEnvelope = {
        ...this.legacyEnvelope,
        current,
        outbox: [...this.legacyEnvelope.outbox, mutation],
        failed: false,
      };
      this.persistLegacy();
      return;
    }
    const desired = desiredSession(name, state, results);
    const current = currentFromEnvelope(this.envelope);
    if (sameCurrent(current, currentFromDesired(desired))) return;
    const desiredGameId = desired.entries[0]?.gameId;
    if (
      desiredGameId !== undefined &&
      this.envelope.gameId !== null &&
      desiredGameId !== this.envelope.gameId
    ) {
      throw new Error("Local game changes target a different durable game");
    }
    if (synchronized) {
      const desiredById = new Map(desired.entries.map((entry) => [entry.id, entry]));
      const preservesDurableEntries = this.envelope.entries.every((entry) => {
        const desiredEntry = desiredById.get(entry.id);
        return (
          desiredEntry !== undefined &&
          JSON.stringify(canonicalJsonValue(desiredEntry)) ===
            JSON.stringify(canonicalJsonValue(entry))
        );
      });
      const preservesBaseline =
        this.envelope.baseline === null ||
        JSON.stringify(canonicalJsonValue(this.envelope.baseline)) ===
          JSON.stringify(canonicalJsonValue(desired.baseline));
      const preservesResults =
        this.envelope.results === null ||
        JSON.stringify(canonicalJsonValue(this.envelope.results)) ===
          JSON.stringify(canonicalJsonValue(desired.results));
      let extendsDurableHead = this.envelope.headEventId === null;
      for (
        let cursor = desired.headEventId;
        !extendsDurableHead && cursor !== null;
        cursor = desiredById.get(cursor)?.parentEventId ?? null
      ) {
        extendsDurableHead = cursor === this.envelope.headEventId;
      }
      if (
        desired.entries.length === 0 ||
        !preservesDurableEntries ||
        !preservesBaseline ||
        !preservesResults ||
        !extendsDurableHead
      ) {
        throw new Error(
          `Local session diverged from another browser context (${[
            `entries:${preservesDurableEntries}`,
            `baseline:${preservesBaseline}`,
            `results:${preservesResults}`,
            `head:${extendsDurableHead}`,
            `desired:${desired.entries.length}`,
          ].join(",")})`,
        );
      }
    }
    const currentGameId = this.envelope.gameId;
    let source = this.envelope;
    if (
      currentGameId !== null &&
      (this.pendingClears.has(currentGameId) || this.envelope.clearingGameId === currentGameId)
    ) {
      this.generation += 1;
      this.flushPromise = null;
      source = { ...emptyEnvelope(), gameId: this.options.createId() };
    }
    const gameId = source.gameId ?? this.options.createId();
    validateDesiredReplay(gameId, desired);
    const outbox = [...source.outbox];
    let nextBaseRevision = source.revision + outbox.length;
    const push = <Operation extends Omit<GameSessionOperation, keyof OperationBase>>(
      operation: Operation,
    ) => {
      outbox.push({
        ...operation,
        name,
        mutationId: this.options.createId(),
        baseRevision: nextBaseRevision,
      } as GameSessionOperation);
      nextBaseRevision += 1;
    };

    if (
      source.name !== name ||
      !sameCurrent(
        source.name === null
          ? null
          : {
              name: source.name,
              state: {
                setup: source.metadata.setup,
                game: null,
                hostPlayerId: source.metadata.hostPlayerId,
                hostName: source.metadata.hostName,
                playlistId: source.metadata.playlistId,
                log: source.metadata.legacyLog,
                undoHistory: [],
              },
              results: null,
            },
        {
          name,
          state: {
            setup: desired.metadata.setup,
            game: null,
            hostPlayerId: desired.metadata.hostPlayerId,
            hostName: desired.metadata.hostName,
            playlistId: desired.metadata.playlistId,
            log: desired.metadata.legacyLog,
            undoHistory: [],
          },
          results: null,
        },
      )
    ) {
      push({ kind: "metadata", metadata: desired.metadata });
    }

    let effectiveHead = source.headEventId;
    let restoresCompletion = false;
    if (source.baseline === null && desired.baseline !== null) {
      if (desired.normalize) {
        push({ kind: "normalize" });
      } else {
        const root = desired.entries.find(({ parentEventId }) => parentEventId === null);
        if (root === undefined) throw new Error("A replayable game requires a root event");
        push({ kind: "start", baseline: desired.baseline, event: root });
        effectiveHead = root.id;
        for (const entry of desired.entries.filter(({ id }) => id !== root.id)) {
          push({ kind: "append-event", event: entry });
          effectiveHead = entry.id;
        }
      }
    } else if (source.baseline !== null) {
      const knownIds = new Set(source.entries.map(({ id }) => id));
      for (const entry of desired.entries.filter(({ id }) => !knownIds.has(id))) {
        push({ kind: "append-event", event: entry });
        effectiveHead = entry.id;
      }
    }

    if (desired.headEventId !== null && desired.headEventId !== effectiveHead) {
      const reason =
        desired.resetReturnEventId !== null
          ? "reset"
          : source.resetReturnEventId !== null && desired.headEventId === source.resetReturnEventId
            ? "restore-reset"
            : "undo";
      restoresCompletion = reason === "restore-reset";
      push({ kind: "move-head", targetEventId: desired.headEventId, reason });
    }
    if (source.results === null && desired.results !== null && !restoresCompletion) {
      push({ kind: "complete", results: desired.results });
    }

    this.envelope = {
      ...source,
      gameId,
      name,
      metadata: desired.metadata,
      baseline: desired.baseline,
      entries: desired.entries,
      headEventId: desired.headEventId,
      resetReturnEventId: desired.resetReturnEventId,
      results: desired.results,
      outbox,
      failed: false,
      clearFailed: false,
      clearingGameId: null,
    };
    this.persist();
  }

  public restore(
    gameId: string,
    revision: number,
    name: string,
    state: GameSessionState,
    results: FinalGameResults | null,
  ): void {
    if (this.synchronizeDurableState()) {
      throw new Error("Local session changed in another browser context");
    }
    if (this.legacyEnvelope !== null) {
      throw new Error("Cannot restore while legacy game changes are unresolved");
    }
    const durable = loadEnvelope(this.options.storage, this.storageKey);
    if (!sameEnvelope(durable, this.envelope)) {
      this.envelope = durable;
      this.notify();
      throw new Error("Local session changed while the restore request was pending");
    }
    if (
      this.envelope.outbox.length > 0 ||
      this.flushPromise !== null ||
      this.envelope.failed ||
      this.envelope.clearFailed
    ) {
      throw new Error("Cannot restore while local game changes are unresolved");
    }
    this.generation += 1;
    this.normalizationAvailable = false;
    this.flushPromise = null;
    const desired = desiredSession(name, state, results);
    validateDesiredReplay(gameId, desired);
    this.envelope = {
      version: 4,
      gameId,
      revision,
      name,
      metadata: desired.metadata,
      baseline: desired.baseline,
      entries: desired.entries,
      headEventId: desired.headEventId,
      resetReturnEventId: desired.resetReturnEventId,
      results,
      outbox: desired.normalize
        ? [
            {
              kind: "normalize",
              name,
              mutationId: this.options.createId(),
              baseRevision: revision,
            },
          ]
        : [],
      failed: false,
      clearFailed: false,
      clearingGameId: null,
    };
    this.persist();
  }

  public async clear(
    clearRemote: (gameId: string, expectedRevision: number) => Promise<void>,
  ): Promise<void> {
    if (this.synchronizeDurableState()) {
      throw new Error("Local session changed in another browser context");
    }
    if (this.legacyEnvelope !== null) {
      const legacy = this.legacyEnvelope;
      const current = legacy.current;
      if (current === null) throw new Error("Legacy session metadata is missing");
      const desired = desiredSession(current.name, current.state, current.results);
      this.generation += 1;
      this.flushPromise = null;
      this.envelope = {
        version: 4,
        gameId: legacy.gameId,
        revision: legacy.revision,
        name: desired.name,
        metadata: desired.metadata,
        baseline: desired.baseline,
        entries: desired.entries,
        headEventId: desired.headEventId,
        resetReturnEventId: desired.resetReturnEventId,
        results: desired.results,
        outbox: [],
        failed: false,
        clearFailed: false,
        clearingGameId: legacy.gameId,
      };
      const serialized = JSON.stringify(this.envelope);
      this.options.storage.setItem(this.storageKey, serialized);
      this.storageSnapshot = serialized;
      this.legacyEnvelope = null;
      if (this.migratingLegacyKey !== null) {
        this.options.storage.removeItem(this.migratingLegacyKey);
        this.legacyStorageSnapshot = null;
        this.migratingLegacyKey = null;
      }
      this.notify();
    }
    const gameId = this.envelope.gameId;
    if (gameId === null) {
      this.envelope = emptyEnvelope();
      this.persist();
      return;
    }
    const durable = loadEnvelope(this.options.storage, this.storageKey);
    if (durable.gameId !== gameId) {
      this.envelope = durable;
      this.notify();
      return;
    }
    this.envelope = { ...durable, clearFailed: false, clearingGameId: gameId };
    this.persist();
    const generation = this.generation;
    this.pendingClears.set(gameId, (this.pendingClears.get(gameId) ?? 0) + 1);
    this.clearCount += 1;
    this.notify();
    try {
      await clearRemote(gameId, durable.revision);
      if (generation !== this.generation || this.envelope.gameId !== gameId) return;
      const durableAfterClear = loadEnvelope(this.options.storage, this.storageKey);
      if (durableAfterClear.gameId !== gameId) {
        this.envelope = durableAfterClear;
        this.notify();
        return;
      }
      this.generation += 1;
      this.flushPromise = null;
      this.envelope = emptyEnvelope();
      this.persist();
    } catch (error) {
      if (generation === this.generation && this.envelope.gameId === gameId) {
        const durableAfterClear = loadEnvelope(this.options.storage, this.storageKey);
        if (durableAfterClear.gameId !== gameId) {
          this.envelope = durableAfterClear;
          this.notify();
        } else {
          this.envelope = {
            ...durableAfterClear,
            clearFailed: true,
            clearingGameId: null,
          };
          this.persist();
        }
      }
      throw error;
    } finally {
      const pendingClearCount = this.pendingClears.get(gameId) ?? 1;
      if (pendingClearCount === 1) this.pendingClears.delete(gameId);
      else this.pendingClears.set(gameId, pendingClearCount - 1);
      this.clearCount -= 1;
      this.notify();
    }
  }

  public flush(): Promise<void> {
    if (this.flushPromise !== null) return this.flushPromise;
    this.synchronizeDurableState();
    if ((this.legacyEnvelope?.outbox.length ?? 0) === 0 && this.envelope.outbox.length === 0) {
      return Promise.resolve();
    }
    const generation = this.generation;
    let activeMutation: GameSessionOperation | null = null;
    let activeLegacyMutation: LegacyGameSessionMutation | null = null;
    const operation = (async () => {
      try {
        while ((this.legacyEnvelope?.outbox.length ?? 0) > 0 && generation === this.generation) {
          const legacy = this.legacyEnvelope;
          const gameId = legacy?.gameId;
          const mutation = legacy?.outbox[0];
          if (legacy === null || gameId == null || mutation === undefined) {
            throw new Error("Invalid legacy game session outbox");
          }
          if (this.options.saveLegacy === undefined) {
            throw new Error("Legacy game session persistence is unavailable");
          }
          activeLegacyMutation = mutation;
          const responseValue = await this.options.saveLegacy(gameId, mutation);
          if (generation !== this.generation) return;
          const response = assertSessionSaveResponse(responseValue);
          if (response.revision !== mutation.baseRevision + 1) {
            throw new Error("Unexpected legacy game session revision");
          }
          const durable =
            this.migratingLegacyKey === null
              ? legacy
              : loadLegacyEnvelope(this.options.storage, this.migratingLegacyKey);
          if (durable === null) {
            this.legacyEnvelope = null;
            this.envelope = loadEnvelope(this.options.storage, this.storageKey);
            activeLegacyMutation = null;
            this.notify();
            return;
          }
          if (durable.gameId !== gameId) {
            this.legacyEnvelope = durable;
            activeLegacyMutation = null;
            this.notify();
            return;
          }
          const durableIndex = durable.outbox.findIndex(
            ({ mutationId }) => mutationId === mutation.mutationId,
          );
          if (durableIndex === -1) {
            this.legacyEnvelope = durable;
            activeLegacyMutation = null;
            this.notify();
            continue;
          }
          const canonicalName = response.name?.trim();
          const remainingOutbox = durable.outbox.filter((_, index) => index !== durableIndex);
          this.legacyEnvelope = {
            ...durable,
            revision: Math.max(durable.revision, response.revision),
            current:
              durable.current === null || canonicalName === undefined || canonicalName === ""
                ? durable.current
                : { ...durable.current, name: canonicalName },
            outbox:
              canonicalName === undefined || canonicalName === ""
                ? remainingOutbox
                : remainingOutbox.map((queued) => ({ ...queued, name: canonicalName })),
            failed: false,
          };
          activeLegacyMutation = null;
          this.persistLegacy();
        }

        if (this.legacyEnvelope !== null && generation === this.generation) {
          const legacy = this.legacyEnvelope;
          const current = legacy.current;
          if (current === null) throw new Error("Legacy session metadata is missing");
          const desired = desiredSession(current.name, current.state, current.results);
          const normalizationOperation =
            legacy.gameId === null
              ? undefined
              : (legacy.normalizationOperation ?? {
                  kind: "normalize" as const,
                  name: desired.name,
                  mutationId: this.options.createId(),
                  baseRevision: legacy.revision,
                });
          if (
            normalizationOperation !== undefined &&
            legacy.normalizationOperation === undefined &&
            this.migratingLegacyKey !== null
          ) {
            this.options.storage.setItem(
              this.migratingLegacyKey,
              JSON.stringify({ ...legacy, normalizationOperation }),
            );
          }
          this.envelope = {
            version: 4,
            gameId: legacy.gameId,
            revision: legacy.revision,
            name: desired.name,
            metadata: desired.metadata,
            baseline: desired.baseline,
            entries: desired.entries,
            headEventId: desired.headEventId,
            resetReturnEventId: desired.resetReturnEventId,
            results: desired.results,
            outbox: legacy.gameId === null ? [] : [normalizationOperation!],
            failed: false,
            clearFailed: legacy.clearFailed,
            clearingGameId: legacy.clearingGameId,
          };
          this.legacyEnvelope = null;
          this.persist();
        }

        while (this.envelope.outbox.length > 0 && generation === this.generation) {
          const gameId = this.envelope.gameId;
          const mutation = this.envelope.outbox[0];
          if (gameId === null || mutation === undefined)
            throw new Error("Invalid game session outbox");
          activeMutation = mutation;
          const responseValue = await this.options.save(gameId, mutation);
          if (generation !== this.generation) return;
          const response = assertSessionSaveResponse(responseValue);
          if (response.gameId !== undefined && response.gameId !== gameId) {
            throw new Error("Game session response targets another game");
          }
          if (response.state !== undefined) {
            const responseDesired = desiredSession(
              response.name ?? mutation.name,
              response.state,
              response.results ?? null,
            );
            validateDesiredReplay(gameId, responseDesired, responseDesired.entries.length > 0);
          }
          if (response.revision !== mutation.baseRevision + 1) {
            throw new Error("Unexpected game session revision");
          }
          const durable = loadEnvelope(this.options.storage, this.storageKey);
          if (durable.gameId !== gameId) {
            this.envelope = durable;
            activeMutation = null;
            this.notify();
            return;
          }
          const durableIndex = durable.outbox.findIndex(
            ({ mutationId }) => mutationId === mutation.mutationId,
          );
          const canonicalName = response.name?.trim();
          const remainingOutbox =
            durableIndex === -1
              ? durable.outbox
              : durable.outbox.filter((_, index) => index !== durableIndex);
          const normalized = (() => {
            if (mutation.kind !== "normalize") return null;
            if (
              response.gameId !== gameId ||
              response.state === undefined ||
              response.results === undefined
            ) {
              throw new Error("Normalization response did not include the canonical session");
            }
            if (remainingOutbox.some(({ kind }) => kind !== "metadata")) {
              throw new Error("Game actions cannot be rebased across legacy normalization");
            }
            const desired = desiredSession(
              canonicalName === undefined || canonicalName === "" ? mutation.name : canonicalName,
              response.state,
              response.results,
            );
            validateDesiredReplay(gameId, desired, true);
            return desired;
          })();
          this.envelope =
            durableIndex === -1
              ? durable
              : {
                  ...durable,
                  revision: Math.max(durable.revision, response.revision),
                  name:
                    canonicalName === undefined || canonicalName === ""
                      ? durable.name
                      : canonicalName,
                  ...(normalized === null
                    ? {}
                    : {
                        baseline: normalized.baseline,
                        entries: normalized.entries,
                        headEventId: normalized.headEventId,
                        resetReturnEventId: normalized.resetReturnEventId,
                        results: normalized.results,
                      }),
                  outbox:
                    canonicalName === undefined || canonicalName === ""
                      ? remainingOutbox
                      : remainingOutbox.map((queued) => ({ ...queued, name: canonicalName })),
                  failed: false,
                };
          if (normalized !== null && durableIndex !== -1) this.normalizationAvailable = true;
          activeMutation = null;
          this.persist();
        }
      } catch (error) {
        if (activeLegacyMutation !== null && this.legacyEnvelope !== null) {
          const staleGameId = this.legacyEnvelope.gameId;
          const durableLegacy =
            this.migratingLegacyKey === null
              ? this.legacyEnvelope
              : loadLegacyEnvelope(this.options.storage, this.migratingLegacyKey);
          if (durableLegacy === null) {
            this.legacyEnvelope = null;
            this.envelope = loadEnvelope(this.options.storage, this.storageKey);
            this.notify();
          } else {
            const pending =
              durableLegacy.gameId === staleGameId &&
              durableLegacy.outbox.some(
                ({ mutationId }) => mutationId === activeLegacyMutation?.mutationId,
              );
            this.legacyEnvelope = pending ? { ...durableLegacy, failed: true } : durableLegacy;
            if (pending) this.persistLegacy();
            else this.notify();
          }
          throw error;
        }
        if (
          activeMutation?.kind === "move-head" &&
          this.options.read !== undefined &&
          this.envelope.gameId !== null
        ) {
          try {
            const gameId = this.envelope.gameId;
            const remote = assertSessionSaveResponse(await this.options.read(gameId));
            if (
              remote.gameId !== gameId ||
              remote.state === undefined ||
              remote.results === undefined
            ) {
              throw new Error("Authoritative session response is incomplete", { cause: error });
            }
            const desired = desiredSession(
              remote.name ?? activeMutation.name,
              remote.state,
              remote.results,
            );
            validateDesiredReplay(gameId, desired, true);
            this.envelope = {
              version: 4,
              gameId,
              revision: remote.revision,
              name: desired.name,
              metadata: desired.metadata,
              baseline: desired.baseline,
              entries: desired.entries,
              headEventId: desired.headEventId,
              resetReturnEventId: desired.resetReturnEventId,
              results: desired.results,
              outbox: [],
              failed: false,
              clearFailed: false,
              clearingGameId: null,
            };
            this.normalizationAvailable = true;
            this.persist();
            throw error;
          } catch (readError) {
            if (readError === error) throw error;
          }
        }
        if (generation === this.generation) {
          const durable = loadEnvelope(this.options.storage, this.storageKey);
          if (durable.gameId !== this.envelope.gameId) {
            this.envelope = durable;
            this.notify();
          } else {
            const mutationStillPending =
              activeMutation !== null &&
              durable.outbox.some(({ mutationId }) => mutationId === activeMutation?.mutationId);
            if (mutationStillPending) {
              this.envelope = { ...durable, failed: true };
              this.persist();
            } else {
              this.envelope = durable;
              this.notify();
            }
          }
        }
        throw error;
      }
    })();
    this.flushPromise = operation;
    this.notify();
    void operation.then(
      () => {
        if (this.flushPromise === operation) {
          this.flushPromise = null;
          this.notify();
        }
      },
      () => {
        if (this.flushPromise === operation) {
          this.flushPromise = null;
          this.notify();
        }
      },
    );
    return operation;
  }
}
