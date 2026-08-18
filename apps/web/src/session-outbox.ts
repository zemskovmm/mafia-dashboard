import type { FinalGameResults, GameSessionMutation, GameSessionState } from "./api/client.js";

export interface SessionSaveResponse {
  readonly revision: number;
  readonly duplicate: boolean;
}

interface OutboxOptions {
  readonly storage: Storage;
  readonly createId: () => string;
  readonly save: (gameId: string, mutation: GameSessionMutation) => Promise<SessionSaveResponse>;
}

interface CurrentSession {
  readonly name: string;
  readonly state: GameSessionState;
  readonly results: FinalGameResults | null;
}

interface PersistedEnvelope {
  readonly version: 3;
  readonly gameId: string | null;
  readonly revision: number;
  readonly current: CurrentSession | null;
  readonly outbox: readonly GameSessionMutation[];
  readonly failed: boolean;
  readonly clearFailed: boolean;
  readonly clearingGameId: string | null;
}

const storageKey = "mafia-dashboard.game-session.v3";

const emptyEnvelope = (): PersistedEnvelope => ({
  version: 3,
  gameId: null,
  revision: 0,
  current: null,
  outbox: [],
  failed: false,
  clearFailed: false,
  clearingGameId: null,
});

const loadEnvelope = (storage: Storage): PersistedEnvelope => {
  try {
    const raw = storage.getItem(storageKey);
    if (raw === null) return emptyEnvelope();
    const parsed = JSON.parse(raw) as Partial<PersistedEnvelope>;
    if (
      parsed.version !== 3 ||
      (parsed.gameId !== null && typeof parsed.gameId !== "string") ||
      !Number.isInteger(parsed.revision) ||
      (parsed.revision ?? -1) < 0 ||
      !Array.isArray(parsed.outbox)
    ) {
      return emptyEnvelope();
    }
    return {
      version: 3,
      gameId: parsed.gameId ?? null,
      revision: parsed.revision ?? 0,
      current:
        typeof parsed.current === "object" && parsed.current !== null
          ? (parsed.current as CurrentSession)
          : null,
      outbox: parsed.outbox as readonly GameSessionMutation[],
      failed: parsed.failed === true,
      clearFailed: parsed.clearFailed === true,
      clearingGameId: typeof parsed.clearingGameId === "string" ? parsed.clearingGameId : null,
    };
  } catch {
    return emptyEnvelope();
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

export class GameSessionOutbox {
  private envelope: PersistedEnvelope;
  private flushPromise: Promise<void> | null = null;
  private clearCount = 0;
  private readonly pendingClears = new Map<string, number>();
  private generation = 0;
  private readonly listeners = new Set<() => void>();

  public constructor(private readonly options: OutboxOptions) {
    this.envelope = loadEnvelope(options.storage);
  }

  public get status(): "saved" | "saving" | "offline" {
    if (this.envelope.failed || this.envelope.clearFailed) return "offline";
    if (
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
    return this.envelope.outbox.length;
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

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private persist(): void {
    if (this.envelope.current === null && this.envelope.outbox.length === 0) {
      this.options.storage.removeItem(storageKey);
    } else {
      this.options.storage.setItem(storageKey, JSON.stringify(this.envelope));
    }
    this.notify();
  }

  public enqueue(name: string, state: GameSessionState, results: FinalGameResults | null): void {
    const current = { name, state, results };
    if (sameCurrent(this.envelope.current, current)) return;
    const currentGameId = this.envelope.gameId;
    if (
      currentGameId !== null &&
      (this.pendingClears.has(currentGameId) || this.envelope.clearingGameId === currentGameId)
    ) {
      this.generation += 1;
      this.flushPromise = null;
      const gameId = this.options.createId();
      const mutation: GameSessionMutation = {
        name,
        mutationId: this.options.createId(),
        baseRevision: 0,
        state,
        results,
      };
      this.envelope = {
        version: 3,
        gameId,
        revision: 0,
        current,
        outbox: [mutation],
        failed: false,
        clearFailed: false,
        clearingGameId: null,
      };
      this.persist();
      return;
    }
    const gameId = this.envelope.gameId ?? this.options.createId();
    const mutation: GameSessionMutation = {
      name,
      mutationId: this.options.createId(),
      baseRevision: this.envelope.revision + this.envelope.outbox.length,
      state,
      results,
    };
    this.envelope = {
      ...this.envelope,
      gameId,
      current,
      outbox: [...this.envelope.outbox, mutation],
      failed: false,
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
    const durable = loadEnvelope(this.options.storage);
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
    this.flushPromise = null;
    this.envelope = {
      version: 3,
      gameId,
      revision,
      current: { name, state, results },
      outbox: [],
      failed: false,
      clearFailed: false,
      clearingGameId: null,
    };
    this.persist();
  }

  public async clear(clearRemote: (gameId: string) => Promise<void>): Promise<void> {
    const gameId = this.envelope.gameId;
    if (gameId === null) {
      this.envelope = emptyEnvelope();
      this.persist();
      return;
    }
    const durable = loadEnvelope(this.options.storage);
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
      await clearRemote(gameId);
      if (generation !== this.generation || this.envelope.gameId !== gameId) return;
      const durableAfterClear = loadEnvelope(this.options.storage);
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
        const durableAfterClear = loadEnvelope(this.options.storage);
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
    if (this.envelope.outbox.length === 0) return Promise.resolve();
    const generation = this.generation;
    let activeMutation: GameSessionMutation | null = null;
    const operation = (async () => {
      try {
        while (this.envelope.outbox.length > 0 && generation === this.generation) {
          const gameId = this.envelope.gameId;
          const mutation = this.envelope.outbox[0];
          if (gameId === null || mutation === undefined)
            throw new Error("Invalid game session outbox");
          activeMutation = mutation;
          const response = await this.options.save(gameId, mutation);
          if (generation !== this.generation) return;
          if (response.revision !== mutation.baseRevision + 1) {
            throw new Error("Unexpected game session revision");
          }
          const durable = loadEnvelope(this.options.storage);
          if (durable.gameId !== gameId) {
            this.envelope = durable;
            activeMutation = null;
            this.notify();
            return;
          }
          const durableIndex = durable.outbox.findIndex(
            ({ mutationId }) => mutationId === mutation.mutationId,
          );
          this.envelope =
            durableIndex === -1
              ? durable
              : {
                  ...durable,
                  revision: Math.max(durable.revision, response.revision),
                  outbox: durable.outbox.filter((_, index) => index !== durableIndex),
                  failed: false,
                };
          activeMutation = null;
          this.persist();
        }
      } catch (error) {
        if (generation === this.generation) {
          const durable = loadEnvelope(this.options.storage);
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
