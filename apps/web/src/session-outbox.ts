import {
  assertGameLogEntry,
  type GameLogEntry,
  type InitialGameBaseline,
} from "@mafia/game-domain";
import type {
  CurrentGameSessionState,
  FinalGameResults,
  GameSessionClaim,
  GameSessionState,
} from "./api/client.js";
import {
  assertBrowserGameStorageGuard,
  type BrowserGameStorageGuard,
} from "./browser-game-storage-lock.js";

export interface SessionSaveResponse {
  readonly revision: number;
  readonly duplicate: boolean;
  readonly name?: string;
  readonly gameId?: string;
  readonly state?: GameSessionState;
  readonly results?: FinalGameResults | null;
  readonly claim?: GameSessionClaim;
}

interface OutboxOptions {
  readonly storage: Storage;
  readonly storageGuard?: BrowserGameStorageGuard;
  readonly clubId?: string;
  readonly storageKey?: string;
  readonly createId: () => string;
  readonly save: (
    gameId: string,
    operation: GameSessionOperation,
    claimGeneration: number,
  ) => Promise<SessionSaveResponse>;
  readonly clearRemote?: (
    gameId: string,
    expectedRevision: number,
    claimGeneration: number,
  ) => Promise<void>;
}

interface CurrentSession {
  readonly name: string;
  readonly state: CurrentGameSessionState;
  readonly results: FinalGameResults | null;
}

interface OperationBase {
  readonly kind: "snapshot";
  readonly name: string;
  readonly mutationId: string;
  readonly baseRevision: number;
}

export interface GameSessionOperation extends OperationBase {
  readonly state: CurrentGameSessionState;
  readonly results: FinalGameResults | null;
}

export interface CurrentGameSessionEnvelope {
  readonly version: 5;
  readonly clubId: string;
  readonly gameId: string | null;
  readonly revision: number;
  readonly claimGeneration: number;
  readonly current: CurrentSession | null;
  readonly outbox: readonly GameSessionOperation[];
  readonly failed: boolean;
  readonly clearFailed: boolean;
  readonly clearingGameId: string | null;
}

export const gameSessionStorageKey = "mafia-dashboard.game-session.v5";
const defaultClubId = "00000000-0000-4000-8000-000000000101";
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isUuid = (value: unknown): value is string =>
  typeof value === "string" && uuidPattern.test(value);

const isNullableUuid = (value: unknown): value is string | null => value === null || isUuid(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isPositiveInteger = (value: unknown): value is number =>
  isNonNegativeInteger(value) && value > 0;

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isIntegerArray = (value: unknown): value is readonly number[] =>
  Array.isArray(value) && value.every(isNonNegativeInteger);

const isRole = (value: unknown): value is "sheriff" | "citizen" | "mafia" | "don" =>
  value === "sheriff" || value === "citizen" || value === "mafia" || value === "don";

const isTeam = (value: unknown): value is "red" | "black" => value === "red" || value === "black";

const isSetupState = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return (
    (value.step === "music" || value.step === "role-draw" || value.step === "mafia-planning") &&
    Array.isArray(value.players) &&
    value.players.every(
      (player) =>
        isRecord(player) &&
        typeof player.id === "string" &&
        typeof player.name === "string" &&
        isPositiveInteger(player.seat),
    ) &&
    Array.isArray(value.roleDeck) &&
    value.roleDeck.every(isRole) &&
    Array.isArray(value.remainingRoles) &&
    value.remainingRoles.every(isRole) &&
    isRecord(value.assignments) &&
    Object.values(value.assignments).every(isRole)
  );
};

const isSetupSessionState = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return (
    (value.step === "players" || value.step === "roles" || value.step === "music") &&
    (value.hostPlayerId === undefined || typeof value.hostPlayerId === "string") &&
    isStringArray(value.selectedPlayerIds) &&
    (value.setup === null || isSetupState(value.setup))
  );
};

const gamePhases = new Set([
  "mafia-planning",
  "sheriff-wake",
  "day",
  "voting",
  "voting-cancelled",
  "car-crash",
  "car-crash-decision",
  "car-crash-result",
  "car-crash-skipped",
  "goodbye-speech",
  "best-move",
  "night-mafia",
  "night-mafia-result",
  "night-don",
  "night-don-result",
  "night-sheriff",
  "night-sheriff-result",
  "night-resolution",
  "finished",
  "draw",
  "cancelled",
]);

const isGameState = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return (
    typeof value.phase === "string" &&
    gamePhases.has(value.phase) &&
    isNonNegativeInteger(value.day) &&
    Array.isArray(value.players) &&
    value.players.every(
      (player) =>
        isRecord(player) &&
        typeof player.id === "string" &&
        typeof player.name === "string" &&
        isPositiveInteger(player.seat) &&
        isRole(player.role) &&
        isTeam(player.team) &&
        (player.status === "active" ||
          player.status === "eliminated" ||
          player.status === "red-carded") &&
        isNonNegativeInteger(player.fouls) &&
        typeof player.mutePending === "boolean",
    ) &&
    isIntegerArray(value.turnOrder) &&
    isNonNegativeInteger(value.currentTurnIndex) &&
    Array.isArray(value.nominations) &&
    value.nominations.every(
      (nomination) =>
        isRecord(nomination) &&
        isPositiveInteger(nomination.nominatorSeat) &&
        isPositiveInteger(nomination.candidateSeat) &&
        isPositiveInteger(nomination.order),
    ) &&
    isRecord(value.voteAssignments) &&
    Object.values(value.voteAssignments).every(isPositiveInteger) &&
    isRecord(value.shotAssignments) &&
    Object.values(value.shotAssignments).every(isPositiveInteger) &&
    (value.winner === null || isTeam(value.winner))
  );
};

const isGameLogEntry = (value: unknown): value is GameLogEntry => {
  try {
    assertGameLogEntry(value);
    return isUuid(value.id) && isUuid(value.gameId) && isNullableUuid(value.parentEventId);
  } catch {
    return false;
  }
};

const isInitialGameBaseline = (value: unknown): value is InitialGameBaseline =>
  isRecord(value) && value.replayVersion === 1 && isGameState(value.game);

const isFinalGameResults = (value: unknown): value is FinalGameResults =>
  isRecord(value) &&
  typeof value.hostPlayerId === "string" &&
  (value.outcome === "red" ||
    value.outcome === "black" ||
    value.outcome === "draw" ||
    value.outcome === "cancelled") &&
  (value.winner === "red" || value.winner === "black" || value.winner === null) &&
  (value.reason === null || typeof value.reason === "string") &&
  typeof value.playedAt === "string" &&
  Array.isArray(value.players);

export const isCurrentGameSessionState = (value: unknown): value is CurrentGameSessionState =>
  isRecord(value) &&
  Object.hasOwn(value, "setup") &&
  Object.hasOwn(value, "game") &&
  Object.hasOwn(value, "hostPlayerId") &&
  Object.hasOwn(value, "hostName") &&
  Object.hasOwn(value, "playlistId") &&
  Object.hasOwn(value, "log") &&
  Object.hasOwn(value, "undoHistory") &&
  Object.hasOwn(value, "undoBudget") &&
  Object.hasOwn(value, "initialGame") &&
  Object.hasOwn(value, "events") &&
  Object.hasOwn(value, "headEventId") &&
  Object.hasOwn(value, "resetReturnEventId") &&
  Object.hasOwn(value, "legacyLog") &&
  (value.setup === null || isSetupSessionState(value.setup)) &&
  (value.game === null || isGameState(value.game)) &&
  (value.hostPlayerId === null || typeof value.hostPlayerId === "string") &&
  (value.hostName === null || typeof value.hostName === "string") &&
  typeof value.playlistId === "string" &&
  Array.isArray(value.log) &&
  Array.isArray(value.undoHistory) &&
  isNonNegativeInteger(value.undoBudget) &&
  value.undoBudget <= 3 &&
  (value.initialGame === null || isInitialGameBaseline(value.initialGame)) &&
  Array.isArray(value.events) &&
  value.events.every(isGameLogEntry) &&
  isNullableUuid(value.headEventId) &&
  isNullableUuid(value.resetReturnEventId) &&
  Array.isArray(value.legacyLog);

const isCurrentSession = (value: unknown): value is CurrentSession =>
  isRecord(value) &&
  typeof value.name === "string" &&
  isCurrentGameSessionState(value.state) &&
  (value.results === null || isFinalGameResults(value.results));

const isOperation = (value: unknown): value is GameSessionOperation =>
  isRecord(value) &&
  value.kind === "snapshot" &&
  typeof value.name === "string" &&
  isUuid(value.mutationId) &&
  isNonNegativeInteger(value.baseRevision) &&
  isCurrentGameSessionState(value.state) &&
  (value.results === null || isFinalGameResults(value.results));

export const isCurrentGameSessionEnvelope = (
  value: unknown,
): value is CurrentGameSessionEnvelope => {
  if (
    !isRecord(value) ||
    value.version !== 5 ||
    !isUuid(value.clubId) ||
    !isNullableUuid(value.gameId) ||
    !isNonNegativeInteger(value.revision) ||
    !isNonNegativeInteger(value.claimGeneration) ||
    !(value.current === null || isCurrentSession(value.current)) ||
    !Array.isArray(value.outbox) ||
    !value.outbox.every(isOperation) ||
    typeof value.failed !== "boolean" ||
    typeof value.clearFailed !== "boolean" ||
    !isNullableUuid(value.clearingGameId)
  ) {
    return false;
  }
  if (value.gameId === null && (value.current !== null || value.outbox.length > 0)) return false;
  if (value.gameId !== null && value.current === null && value.clearingGameId === null)
    return false;
  const revision = value.revision as number;
  if (!value.outbox.every((operation, index) => operation.baseRevision === revision + index)) {
    return false;
  }
  const eventsBelongToOwner = (state: CurrentGameSessionState) =>
    value.gameId !== null && state.events.every(({ gameId }) => gameId === value.gameId);
  return (
    (value.current === null || eventsBelongToOwner(value.current.state)) &&
    value.outbox.every((operation) => eventsBelongToOwner(operation.state))
  );
};

export const parseCurrentGameSessionEnvelope = (raw: string): CurrentGameSessionEnvelope | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isCurrentGameSessionEnvelope(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const emptyEnvelope = (clubId: string): CurrentGameSessionEnvelope => ({
  version: 5,
  clubId,
  gameId: null,
  revision: 0,
  claimGeneration: 0,
  current: null,
  outbox: [],
  failed: false,
  clearFailed: false,
  clearingGameId: null,
});

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

const assertSessionSaveResponse = (value: unknown): SessionSaveResponse => {
  if (
    !isRecord(value) ||
    !isNonNegativeInteger(value.revision) ||
    typeof value.duplicate !== "boolean" ||
    !(value.name === undefined || typeof value.name === "string") ||
    !(value.gameId === undefined || isUuid(value.gameId)) ||
    !(value.state === undefined || isCurrentGameSessionState(value.state)) ||
    !(value.results === undefined || value.results === null || isFinalGameResults(value.results)) ||
    !(
      value.claim === undefined ||
      (isRecord(value.claim) &&
        isNonNegativeInteger(value.claim.generation) &&
        typeof value.claim.expiresAt === "string")
    )
  ) {
    throw new Error("Invalid game session save response");
  }
  return value as unknown as SessionSaveResponse;
};

export class GameSessionOutbox {
  private readonly options: OutboxOptions & { readonly clubId: string };
  private readonly storageKey: string;
  private envelope: CurrentGameSessionEnvelope;
  private storageSnapshot: string | null;
  private flushPromise: Promise<void> | null = null;
  private generation = 0;
  private clearCount = 0;
  private readonly pendingClears = new Set<string>();
  private readonly listeners = new Set<() => void>();

  public constructor(options: OutboxOptions) {
    const clubId = options.clubId ?? defaultClubId;
    if (!isUuid(clubId)) throw new Error("Club identity must be a UUID");
    this.options = { ...options, clubId };
    this.storageKey = options.storageKey ?? gameSessionStorageKey;
    this.storageSnapshot = options.storage.getItem(this.storageKey);
    this.envelope = this.readEnvelope(this.storageSnapshot);
    if (this.envelope.clubId !== clubId && this.envelope.gameId !== null) {
      throw new Error("The durable game belongs to another club");
    }
    if (this.envelope.clearingGameId !== null && options.clearRemote !== undefined) {
      void this.clear(options.clearRemote).catch(() => undefined);
    }
  }

  public get status(): "saved" | "saving" | "offline" | "clearing" {
    if (this.envelope.clearingGameId !== null || this.clearCount > 0) return "clearing";
    if (this.envelope.failed || this.envelope.clearFailed) return "offline";
    if (this.envelope.outbox.length > 0 || this.flushPromise !== null) {
      return "saving";
    }
    return "saved";
  }

  public get pendingCount(): number {
    return this.envelope.outbox.length;
  }

  public get clearFailed(): boolean {
    return this.envelope.clearFailed;
  }

  public get gameId(): string | null {
    return this.envelope.gameId;
  }

  public get revision(): number {
    return this.envelope.revision;
  }

  public get claimGeneration(): number {
    return this.envelope.claimGeneration;
  }

  public get current(): CurrentSession | null {
    return this.envelope.current;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public setClaimGeneration(claimGeneration: number): void {
    this.updateClaimGeneration(claimGeneration, false);
  }

  public rebindClaimGeneration(claimGeneration: number): void {
    this.updateClaimGeneration(claimGeneration, true);
  }

  public ensureGameId(gameId: string): void {
    if (!isUuid(gameId)) throw new Error("Game identity must be a UUID");
    this.synchronizeDurableState();
    if (this.envelope.gameId !== null && this.envelope.gameId !== gameId) {
      throw new Error("The active game already has a different identity");
    }
    if (this.envelope.gameId === gameId) return;
    this.envelope = { ...this.envelope, gameId };
    this.persist();
  }

  public enqueue(name: string, state: GameSessionState, results: FinalGameResults | null): void {
    if (!isCurrentGameSessionState(state)) throw new Error("Invalid current game session state");
    const synchronized = this.synchronizeDurableState();
    const current = { name, state, results };
    if (sameCurrent(this.envelope.current, current)) return;
    if (synchronized && this.envelope.outbox.length > 0) {
      throw new Error("Local session changed in another browser context");
    }
    let source = this.envelope;
    if (
      source.gameId !== null &&
      (source.clearingGameId === source.gameId || this.pendingClears.has(source.gameId))
    ) {
      this.generation += 1;
      this.flushPromise = null;
      source = { ...emptyEnvelope(this.options.clubId), gameId: this.options.createId() };
    }
    const gameId = source.gameId ?? this.options.createId();
    if (state.events.some((entry) => entry.gameId !== gameId)) {
      throw new Error("Local game changes target a different durable game");
    }
    const retained = this.flushPromise === null ? [] : source.outbox.slice(0, 1);
    const outbox: readonly GameSessionOperation[] = [
      ...retained,
      {
        kind: "snapshot",
        name,
        mutationId: this.options.createId(),
        baseRevision: source.revision + retained.length,
        state,
        results,
      },
    ];
    this.envelope = {
      ...source,
      gameId,
      current,
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
    claimGeneration = 0,
  ): void {
    this.synchronizeDurableState();
    if (
      this.envelope.gameId !== null &&
      this.envelope.gameId !== gameId &&
      this.envelope.clearingGameId !== this.envelope.gameId
    ) {
      throw new Error("A different game is already attached to this browser");
    }
    if (this.envelope.outbox.length > 0 || this.flushPromise !== null || this.envelope.failed) {
      throw new Error("Cannot restore while local game changes are unresolved");
    }
    this.replaceCurrentSession(gameId, revision, name, state, results, claimGeneration);
  }

  public replaceAfterTakeover(
    gameId: string,
    revision: number,
    name: string,
    state: GameSessionState,
    results: FinalGameResults | null,
    claimGeneration: number,
  ): void {
    this.synchronizeDurableState();
    this.replaceCurrentSession(gameId, revision, name, state, results, claimGeneration);
  }

  public async clear(
    clearRemote: (
      gameId: string,
      expectedRevision: number,
      claimGeneration: number,
    ) => Promise<void>,
  ): Promise<void> {
    this.synchronizeDurableState();
    const gameId = this.envelope.gameId;
    if (gameId === null) {
      this.envelope = emptyEnvelope(this.options.clubId);
      this.persist();
      return;
    }
    const generation = this.generation;
    this.envelope = { ...this.envelope, clearFailed: false, clearingGameId: gameId };
    this.persist();
    const clearSnapshot = this.storageSnapshot;
    this.pendingClears.add(gameId);
    this.clearCount += 1;
    this.notify();
    try {
      await clearRemote(gameId, this.envelope.revision, this.envelope.claimGeneration);
      if (
        generation !== this.generation ||
        this.envelope.gameId !== gameId ||
        this.options.storage.getItem(this.storageKey) !== clearSnapshot
      ) {
        this.reloadAfterExternalChange();
        return;
      }
      this.generation += 1;
      this.flushPromise = null;
      this.envelope = emptyEnvelope(this.options.clubId);
      this.persist();
    } catch (error) {
      if (
        generation === this.generation &&
        this.envelope.gameId === gameId &&
        this.options.storage.getItem(this.storageKey) === clearSnapshot
      ) {
        this.envelope = { ...this.envelope, clearFailed: true, clearingGameId: null };
        this.persist();
      } else {
        this.reloadAfterExternalChange();
      }
      throw error;
    } finally {
      this.pendingClears.delete(gameId);
      this.clearCount -= 1;
      this.notify();
    }
  }

  public flush(): Promise<void> {
    if (this.flushPromise !== null) return this.flushPromise;
    this.synchronizeDurableState();
    if (this.envelope.outbox.length === 0) return Promise.resolve();
    const generation = this.generation;
    const operation = (async () => {
      let active: GameSessionOperation | null = null;
      try {
        while (this.envelope.outbox.length > 0 && generation === this.generation) {
          const gameId = this.envelope.gameId;
          const mutation = this.envelope.outbox[0];
          if (gameId === null || mutation === undefined)
            throw new Error("Invalid game session outbox");
          active = mutation;
          const response = assertSessionSaveResponse(
            await this.options.save(gameId, mutation, this.envelope.claimGeneration),
          );
          if (generation !== this.generation) return;
          if (response.gameId !== undefined && response.gameId !== gameId) {
            throw new Error("Game session response targets another game");
          }
          const raw = this.options.storage.getItem(this.storageKey);
          if (raw !== this.storageSnapshot) {
            this.reloadAfterExternalChange();
            return;
          }
          const durable = this.readEnvelope(raw);
          const index = durable.outbox.findIndex(
            ({ mutationId }) => mutationId === mutation.mutationId,
          );
          if (durable.gameId !== gameId || index === -1) {
            this.envelope = durable;
            this.storageSnapshot = raw;
            this.notify();
            return;
          }
          const remaining = durable.outbox.filter((_, queuedIndex) => queuedIndex !== index);
          const responseState = response.state;
          const remoteCurrent =
            responseState === undefined ||
            response.results === undefined ||
            !isCurrentGameSessionState(responseState)
              ? null
              : {
                  name: response.name ?? mutation.name,
                  state: responseState,
                  results: response.results,
                };
          if (
            response.duplicate &&
            remoteCurrent !== null &&
            remaining.length === 0 &&
            !sameCurrent(remoteCurrent, {
              name: mutation.name,
              state: mutation.state,
              results: mutation.results,
            })
          ) {
            const retry: GameSessionOperation = {
              ...mutation,
              name: response.name?.trim() || mutation.name,
              mutationId: this.options.createId(),
              baseRevision: response.revision,
            };
            this.envelope = {
              ...durable,
              revision: Math.max(durable.revision, response.revision),
              claimGeneration: Math.max(durable.claimGeneration, response.claim?.generation ?? 0),
              outbox: [retry],
              failed: false,
            };
            this.storageSnapshot = raw;
            this.persist();
            active = null;
            continue;
          }
          const name = response.name?.trim();
          this.envelope = {
            ...durable,
            revision: Math.max(durable.revision, response.revision),
            claimGeneration: Math.max(durable.claimGeneration, response.claim?.generation ?? 0),
            current:
              durable.current === null || name === undefined || name === ""
                ? durable.current
                : { ...durable.current, name },
            outbox:
              name === undefined || name === ""
                ? remaining
                : remaining.map((queued) => ({ ...queued, name })),
            failed: false,
          };
          this.storageSnapshot = raw;
          this.persist();
          active = null;
        }
      } catch (error) {
        if (generation === this.generation && active !== null) {
          const activeMutationId = active.mutationId;
          const raw = this.options.storage.getItem(this.storageKey);
          if (raw === this.storageSnapshot) {
            const durable = this.readEnvelope(raw);
            if (durable.outbox.some(({ mutationId }) => mutationId === activeMutationId)) {
              this.envelope = { ...durable, failed: true };
              this.persist();
            } else {
              this.envelope = durable;
              this.notify();
            }
          } else {
            this.reloadAfterExternalChange();
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

  private updateClaimGeneration(claimGeneration: number, rebindFailed: boolean): void {
    if (!isNonNegativeInteger(claimGeneration)) {
      throw new Error("Claim generation must be a non-negative integer");
    }
    this.synchronizeDurableState();
    if (claimGeneration < this.envelope.claimGeneration) return;
    if (claimGeneration === this.envelope.claimGeneration && !rebindFailed) return;
    this.generation += 1;
    this.flushPromise = null;
    this.envelope = {
      ...this.envelope,
      claimGeneration,
      failed: rebindFailed ? false : this.envelope.failed,
    };
    this.persist();
  }

  private replaceCurrentSession(
    gameId: string,
    revision: number,
    name: string,
    state: GameSessionState,
    results: FinalGameResults | null,
    claimGeneration: number,
  ): void {
    if (!isUuid(gameId)) throw new Error("Game identity must be a UUID");
    if (!isNonNegativeInteger(revision) || !isNonNegativeInteger(claimGeneration)) {
      throw new Error("Game session revision and claim generation must be non-negative integers");
    }
    if (!isCurrentGameSessionState(state)) throw new Error("Invalid current game session state");
    if (state.events.some((entry) => entry.gameId !== gameId)) {
      throw new Error("Game session contains a cross-game event");
    }
    this.generation += 1;
    this.flushPromise = null;
    this.envelope = {
      version: 5,
      clubId: this.options.clubId,
      gameId,
      revision,
      claimGeneration,
      current: { name, state, results },
      outbox: [],
      failed: false,
      clearFailed: false,
      clearingGameId: null,
    };
    this.persist();
  }

  private synchronizeDurableState(): boolean {
    const raw = this.options.storage.getItem(this.storageKey);
    if (raw === this.storageSnapshot) return false;
    this.envelope = this.readEnvelope(raw);
    if (this.envelope.clubId !== this.options.clubId && this.envelope.gameId !== null) {
      throw new Error("The durable game belongs to another club");
    }
    this.storageSnapshot = raw;
    this.notify();
    return true;
  }

  private reloadAfterExternalChange(): void {
    const raw = this.options.storage.getItem(this.storageKey);
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
      this.envelope.gameId === null &&
      this.envelope.current === null &&
      this.envelope.outbox.length === 0
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
