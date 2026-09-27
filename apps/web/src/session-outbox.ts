import type {
  CurrentGameSessionState,
  FinalGameResults,
  GameSessionCreation,
  GameSessionState,
  RemoteGameSession,
} from "./api/client.js";
import { ApiError } from "./api/client.js";
import {
  assertBrowserGameStorageGuard,
  type BrowserGameStorageGuard,
} from "./browser-game-storage-lock.js";

export interface GameSessionOperation {
  readonly kind: "snapshot";
  readonly name: string;
  readonly mutationId: string;
  readonly state: CurrentGameSessionState;
  readonly results: FinalGameResults | null;
}

interface CurrentSession {
  readonly name: string;
  readonly state: CurrentGameSessionState;
  readonly results: FinalGameResults | null;
}

export interface CurrentGameSessionEnvelope {
  readonly version: 5;
  readonly clubId: string;
  readonly gameId: string | null;
  readonly creationId: string | null;
  readonly revision: number;
  readonly current: CurrentSession | null;
  readonly outbox: readonly GameSessionOperation[];
  readonly failed: boolean;
  readonly clearFailed: boolean;
  readonly clearingGameId: string | null;
  readonly removed: boolean;
  /** A v5 client-generated ID must be checked before it can be adopted. */
  readonly legacyGameId: string | null;
}

interface OutboxOptions {
  readonly storage: Storage;
  readonly storageGuard?: BrowserGameStorageGuard;
  readonly clubId?: string;
  readonly storageKey?: string;
  readonly createId: () => string;
  readonly create?: (input: GameSessionCreation) => Promise<RemoteGameSession>;
  readonly save: (
    gameId: string,
    operation: GameSessionOperation,
  ) => Promise<Pick<RemoteGameSession, "revision">>;
}

export const gameSessionStorageKey = "mafia-dashboard.game-session.v5";
const defaultClubId = "00000000-0000-4000-8000-000000000101";
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isUuid = (value: unknown): value is string =>
  typeof value === "string" && uuidPattern.test(value);
const isNullableUuid = (value: unknown): value is string | null => value === null || isUuid(value);
const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Game-rule integrity is enforced by the client game domain. Storage only rejects
 * malformed envelopes, so a historical session is never dropped due to a later
 * domain schema change.
 */
export const isCurrentGameSessionState = (value: unknown): value is CurrentGameSessionState =>
  isRecord(value) &&
  [
    "setup",
    "game",
    "hostPlayerId",
    "hostName",
    "playlistId",
    "log",
    "undoHistory",
    "undoBudget",
    "initialGame",
    "events",
    "headEventId",
    "resetReturnEventId",
    "legacyLog",
  ].every((field) => Object.hasOwn(value, field)) &&
  Array.isArray(value.events);

const isResults = (value: unknown): value is FinalGameResults | null =>
  value === null || isRecord(value);

const isCurrent = (value: unknown): value is CurrentSession =>
  isRecord(value) &&
  typeof value.name === "string" &&
  isCurrentGameSessionState(value.state) &&
  isResults(value.results);

const isOperation = (value: unknown): value is GameSessionOperation =>
  isRecord(value) &&
  value.kind === "snapshot" &&
  typeof value.name === "string" &&
  isUuid(value.mutationId) &&
  isCurrentGameSessionState(value.state) &&
  isResults(value.results);

const emptyEnvelope = (clubId: string): CurrentGameSessionEnvelope => ({
  version: 5,
  clubId,
  gameId: null,
  creationId: null,
  revision: 0,
  current: null,
  outbox: [],
  failed: false,
  clearFailed: false,
  clearingGameId: null,
  removed: false,
  legacyGameId: null,
});

const normalizeEnvelope = (value: unknown): CurrentGameSessionEnvelope | null => {
  if (!isRecord(value) || !isUuid(value.clubId)) return null;

  if (value.version === 5 && Object.hasOwn(value, "creationId")) {
    if (
      !isNullableUuid(value.gameId) ||
      !isNullableUuid(value.creationId) ||
      !isNonNegativeInteger(value.revision) ||
      !(value.current === null || isCurrent(value.current)) ||
      !Array.isArray(value.outbox) ||
      !value.outbox.every(isOperation) ||
      typeof value.failed !== "boolean" ||
      typeof value.clearFailed !== "boolean" ||
      !isNullableUuid(value.clearingGameId) ||
      typeof value.removed !== "boolean" ||
      !isNullableUuid(value.legacyGameId)
    ) {
      return null;
    }
    if (value.gameId === null && value.current !== null && value.creationId === null) return null;
    if (value.gameId !== null && value.current === null && value.clearingGameId === null)
      return null;
    return value as unknown as CurrentGameSessionEnvelope;
  }

  // V5 records came from a client-generated GUID scheme. Keep their snapshots
  // verbatim, but force the App to GET the GUID before treating it as server-owned.
  if (
    value.version !== 5 ||
    !isNullableUuid(value.gameId) ||
    !isNonNegativeInteger(value.revision) ||
    !(value.current === null || isCurrent(value.current)) ||
    !Array.isArray(value.outbox) ||
    !value.outbox.every(isOperation) ||
    typeof value.failed !== "boolean" ||
    typeof value.clearFailed !== "boolean" ||
    !isNullableUuid(value.clearingGameId)
  ) {
    return null;
  }
  return {
    version: 5,
    clubId: value.clubId,
    gameId: value.gameId,
    creationId: null,
    revision: value.revision,
    current: value.current,
    outbox: value.outbox,
    failed: value.failed,
    clearFailed: value.clearFailed,
    clearingGameId: value.clearingGameId,
    removed: false,
    legacyGameId: value.gameId,
  };
};

export const isCurrentGameSessionEnvelope = (value: unknown): value is CurrentGameSessionEnvelope =>
  normalizeEnvelope(value) !== null;

export const parseCurrentGameSessionEnvelope = (raw: string): CurrentGameSessionEnvelope | null => {
  try {
    return normalizeEnvelope(JSON.parse(raw));
  } catch {
    return null;
  }
};

const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, entry) => {
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      return Object.fromEntries(
        Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)),
      );
    }
    return entry;
  });

const sameCurrent = (left: CurrentSession | null, right: CurrentSession): boolean =>
  left !== null && stableJson(left) === stableJson(right);

const remapEventGameIds = (
  state: CurrentGameSessionState,
  gameId: string,
): CurrentGameSessionState => ({
  ...state,
  events: state.events.map((event) => ({ ...event, gameId })),
});

export class GameSessionOutbox {
  private readonly options: OutboxOptions & { readonly clubId: string };
  private readonly storageKey: string;
  private envelope: CurrentGameSessionEnvelope;
  private storageSnapshot: string | null;
  private flushPromise: Promise<void> | null = null;
  private generation = 0;
  private readonly listeners = new Set<() => void>();

  public constructor(options: OutboxOptions) {
    const clubId = options.clubId ?? defaultClubId;
    if (!isUuid(clubId)) throw new Error("Club identity must be a UUID");
    this.options = { ...options, clubId };
    this.storageKey = options.storageKey ?? gameSessionStorageKey;
    this.storageSnapshot = options.storage.getItem(this.storageKey);
    this.envelope = this.readEnvelope(this.storageSnapshot);
    if (this.envelope.clubId !== clubId && this.envelope.current !== null) {
      throw new Error("The durable game belongs to another club");
    }
  }

  public get status(): "saved" | "saving" | "offline" | "clearing" | "removed" {
    if (this.envelope.removed) return "removed";
    if (this.envelope.clearingGameId !== null) return "clearing";
    if (this.envelope.failed || this.envelope.clearFailed) return "offline";
    if (
      this.envelope.creationId !== null ||
      this.envelope.outbox.length > 0 ||
      this.flushPromise !== null
    ) {
      return "saving";
    }
    return "saved";
  }

  public get pendingCount(): number {
    return this.envelope.removed
      ? 0
      : this.envelope.outbox.length + (this.envelope.creationId === null ? 0 : 1);
  }

  public get gameId(): string | null {
    return this.envelope.gameId;
  }

  public get revision(): number {
    return this.envelope.revision;
  }

  public get current(): CurrentSession | null {
    return this.envelope.current;
  }

  public get isCreating(): boolean {
    return this.envelope.gameId === null && this.envelope.creationId !== null;
  }

  public get isRemoved(): boolean {
    return this.envelope.removed;
  }

  public get needsRemoteVerification(): boolean {
    return this.envelope.legacyGameId !== null;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Persist one retry-stable creation identity before making the POST. */
  public beginCreation(
    name: string,
    state: CurrentGameSessionState,
    results: FinalGameResults | null,
  ): void {
    this.synchronizeDurableState();
    if (!isCurrentGameSessionState(state)) throw new Error("Invalid current game session state");
    if (this.envelope.gameId !== null || this.envelope.creationId !== null) return;
    this.envelope = {
      ...this.envelope,
      current: { name, state, results },
      creationId: this.options.createId(),
      failed: false,
      clearFailed: false,
      removed: false,
      legacyGameId: null,
    };
    this.persist();
  }

  /** Convert only a never-acknowledged v5 snapshot into a new server creation request. */
  public adoptLegacyDraft(): void {
    this.synchronizeDurableState();
    if (this.envelope.legacyGameId === null || this.envelope.current === null) return;
    this.generation += 1;
    this.flushPromise = null;
    if (this.envelope.revision > 0) {
      // A missing acknowledged record was deleted, not an unsent draft.
      // Keep the local snapshot for inspection without resurrecting it.
      this.envelope = {
        ...this.envelope,
        outbox: [],
        failed: false,
        removed: true,
        legacyGameId: null,
      };
      this.persist();
      return;
    }
    this.envelope = {
      ...this.envelope,
      gameId: null,
      creationId: this.options.createId(),
      outbox: [],
      failed: false,
      clearFailed: false,
      clearingGameId: null,
      removed: false,
      legacyGameId: null,
    };
    this.persist();
  }

  public confirmRemoteGame(gameId: string): void {
    this.synchronizeDurableState();
    if (this.envelope.gameId !== gameId || this.envelope.legacyGameId === null) return;
    this.envelope = { ...this.envelope, legacyGameId: null };
    this.persist();
  }

  public enqueue(name: string, state: GameSessionState, results: FinalGameResults | null): void {
    this.synchronizeDurableState();
    if (this.envelope.removed || this.envelope.gameId === null) return;
    if (!isCurrentGameSessionState(state)) throw new Error("Invalid current game session state");
    const normalizedState = remapEventGameIds(state, this.envelope.gameId);
    const current = { name, state: normalizedState, results };
    if (sameCurrent(this.envelope.current, current)) return;
    const retained = this.flushPromise === null ? [] : this.envelope.outbox.slice(0, 1);
    this.envelope = {
      ...this.envelope,
      current,
      outbox: [
        ...retained,
        {
          kind: "snapshot",
          name,
          mutationId: this.options.createId(),
          state: normalizedState,
          results,
        },
      ],
      failed: false,
      clearFailed: false,
    };
    this.persist();
  }

  /** Preserve the current local record while another server game is opened. */
  public park(): void {
    this.synchronizeDurableState();
    this.assertStorageGuard();
    const identity = this.envelope.gameId ?? this.envelope.creationId;
    if (identity === null || this.envelope.current === null) return;
    const serialized = JSON.stringify(this.envelope);
    const key = this.parkedStorageKey(identity);
    this.options.storage.setItem(key, serialized);
    if (this.options.storage.getItem(key) !== serialized) {
      throw new Error("Browser game storage write could not be verified");
    }
    this.generation += 1;
    this.flushPromise = null;
    this.envelope = emptyEnvelope(this.options.clubId);
    this.persist();
  }

  /** Load a server snapshot, preferring a parked copy only with unsent work. */
  public activateRemote(session: RemoteGameSession): void {
    this.synchronizeDurableState();
    if (!isUuid(session.gameId) || !isCurrentGameSessionState(session.state)) {
      throw new Error("Invalid server game session");
    }
    if (this.envelope.gameId === session.gameId && this.envelope.outbox.length > 0) return;
    if (
      this.envelope.current !== null &&
      (this.envelope.gameId !== session.gameId || this.envelope.creationId !== null)
    ) {
      this.park();
    }
    const parkedKey = this.parkedStorageKey(session.gameId);
    const parkedRaw = this.options.storage.getItem(parkedKey);
    const parked = parkedRaw === null ? null : parseCurrentGameSessionEnvelope(parkedRaw);
    if (
      parked?.gameId === session.gameId &&
      parked.current !== null &&
      (parked.outbox.length > 0 || parked.creationId !== null)
    ) {
      this.options.storage.removeItem(parkedKey);
      this.envelope = parked;
      this.storageSnapshot = this.options.storage.getItem(this.storageKey);
      this.persist();
      return;
    }
    if (parkedRaw !== null) this.options.storage.removeItem(parkedKey);
    this.generation += 1;
    this.flushPromise = null;
    this.envelope = {
      version: 5,
      clubId: this.options.clubId,
      gameId: session.gameId,
      creationId: null,
      revision: session.revision,
      current: { name: session.name, state: session.state, results: session.results },
      outbox: [],
      failed: false,
      clearFailed: false,
      clearingGameId: null,
      removed: false,
      legacyGameId: null,
    };
    this.persist();
  }

  /** Remove only the local record after DELETE has been acknowledged. */
  public async clear(clearRemote: (gameId: string) => Promise<void>): Promise<void> {
    this.synchronizeDurableState();
    const gameId = this.envelope.gameId;
    if (gameId === null) {
      this.envelope = emptyEnvelope(this.options.clubId);
      this.persist();
      return;
    }
    this.envelope = { ...this.envelope, clearFailed: false, clearingGameId: gameId };
    this.persist();
    try {
      await clearRemote(gameId);
      if (this.envelope.gameId !== gameId) return;
      this.generation += 1;
      this.flushPromise = null;
      this.envelope = emptyEnvelope(this.options.clubId);
      this.persist();
    } catch (error) {
      if (this.envelope.gameId === gameId) {
        this.envelope = { ...this.envelope, clearFailed: true, clearingGameId: null };
        this.persist();
      }
      throw error;
    }
  }

  public flush(): Promise<void> {
    if (this.flushPromise !== null) return this.flushPromise;
    this.synchronizeDurableState();
    if (this.pendingCount === 0) return Promise.resolve();
    const generation = this.generation;
    const operation = this.flushAll(generation);
    this.flushPromise = operation;
    this.notify();
    operation.then(
      () => this.finishFlush(operation),
      () => this.finishFlush(operation),
    );
    return operation;
  }

  private finishFlush(operation: Promise<void>): void {
    if (this.flushPromise !== operation) return;
    this.flushPromise = null;
    this.notify();
  }

  private async flushAll(generation: number): Promise<void> {
    try {
      if (this.envelope.gameId === null && this.envelope.creationId !== null) {
        const current = this.envelope.current;
        if (current === null) throw new Error("Creation is missing its game snapshot");
        const creationId = this.envelope.creationId;
        if (this.options.create === undefined) {
          throw new Error("Game-session creation is not configured");
        }
        const remote = await this.options.create({
          creationId,
          name: current.name,
          state: current.state,
          results: current.results,
        });
        if (generation !== this.generation) return;
        if (!isUuid(remote.gameId) || !isCurrentGameSessionState(remote.state)) {
          throw new Error("Invalid game creation response");
        }
        this.envelope = {
          ...this.envelope,
          gameId: remote.gameId,
          creationId: null,
          revision: remote.revision,
          current: {
            name: remote.name,
            state: remapEventGameIds(current.state, remote.gameId),
            results: current.results,
          },
          failed: false,
          legacyGameId: null,
        };
        this.persist();
      }

      while (this.envelope.outbox.length > 0 && generation === this.generation) {
        const gameId = this.envelope.gameId;
        const mutation = this.envelope.outbox[0];
        if (gameId === null || mutation === undefined)
          throw new Error("Invalid game session outbox");
        const remote = await this.options.save(gameId, mutation);
        if (generation !== this.generation) return;
        this.envelope = {
          ...this.envelope,
          revision: remote.revision,
          outbox: this.envelope.outbox.slice(1),
          failed: false,
        };
        this.persist();
      }
    } catch (error) {
      if (generation === this.generation) {
        if (error instanceof ApiError && error.status === 404 && this.envelope.gameId !== null) {
          this.envelope = { ...this.envelope, outbox: [], failed: false, removed: true };
        } else {
          this.envelope = { ...this.envelope, failed: true };
        }
        this.persist();
      }
      throw error;
    }
  }

  private synchronizeDurableState(): void {
    const raw = this.options.storage.getItem(this.storageKey);
    if (raw === this.storageSnapshot) return;
    this.envelope = this.readEnvelope(raw);
    this.storageSnapshot = raw;
    this.notify();
  }

  private readEnvelope(raw: string | null): CurrentGameSessionEnvelope {
    if (raw === null) return emptyEnvelope(this.options.clubId);
    const parsed = parseCurrentGameSessionEnvelope(raw);
    if (parsed === null) throw new Error("Browser game storage is invalid");
    return parsed;
  }

  private persist(): void {
    this.assertStorageGuard();
    const serialized =
      this.envelope.current === null &&
      this.envelope.outbox.length === 0 &&
      this.envelope.creationId === null
        ? null
        : JSON.stringify(this.envelope);
    if (this.options.storage.getItem(this.storageKey) !== this.storageSnapshot) {
      throw new Error("Local session changed in another browser context");
    }
    if (serialized === null) this.options.storage.removeItem(this.storageKey);
    else this.options.storage.setItem(this.storageKey, serialized);
    if (this.options.storage.getItem(this.storageKey) !== serialized) {
      throw new Error("Browser game storage write could not be verified");
    }
    this.storageSnapshot = serialized;
    this.notify();
  }

  private parkedStorageKey(identity: string): string {
    return `${this.storageKey}.parked.${identity}`;
  }

  private assertStorageGuard(): void {
    if (this.options.storageGuard !== undefined) {
      assertBrowserGameStorageGuard(this.options.storageGuard);
      return;
    }
    if (
      import.meta.env.MODE !== "test" &&
      typeof window !== "undefined" &&
      this.options.storage === window.localStorage
    ) {
      throw new Error("Browser game storage lock is required");
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
