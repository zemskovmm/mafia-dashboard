import type { GameSessionClaimCredential } from "./api/client.js";

type ClaimStatus = "idle" | "owned" | "offline" | "blocked";

interface ClaimState {
  readonly claimId: string;
  readonly generation: number;
  readonly status: ClaimStatus;
}

interface ClaimControllerOptions {
  readonly storage: Storage;
  readonly coordinationStorage?: Storage;
  readonly clubId: string;
  readonly createId: () => string;
  readonly lockRequest?: GameSessionClaimLockRequest;
}

type GameSessionClaimLockRequest = (
  name: string,
  options: { readonly mode: "exclusive"; readonly ifAvailable: true },
  callback: (lock: { readonly name: string } | null) => Promise<void>,
) => Promise<void>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const gameSessionClaimStoragePrefix = (clubId: string): string =>
  `mafia-dashboard.game-session.v4.claim.${clubId}`;
export const gameSessionClaimTabStorageKey = (clubId: string): string =>
  `${gameSessionClaimStoragePrefix(clubId)}.tab`;

export class GameSessionClaimController {
  private readonly states = new Map<string, ClaimState>();
  private renewalGameId: string | null = null;
  private renewalTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private readyState: boolean;
  private readyPromise: Promise<void> | null = null;
  private disposed = false;
  private lifecycleVersion = 0;
  private fallbackOwnerKey: string | null = null;
  private fallbackOwnerId: string | null = null;
  private releaseTabLock!: () => void;
  private tabLockRelease: Promise<void>;

  public constructor(private readonly options: ClaimControllerOptions) {
    this.readyState = false;
    this.tabLockRelease = this.createTabLockRelease();
  }

  public get isReady(): boolean {
    return this.readyState;
  }

  public get isDisposed(): boolean {
    return this.disposed;
  }

  public get lifecycle(): number {
    return this.lifecycleVersion;
  }

  public ownedClaims(): readonly (GameSessionClaimCredential & { readonly gameId: string })[] {
    return [...this.states.entries()]
      .filter(([, state]) => state.status === "owned")
      .map(([gameId, state]) => ({
        gameId,
        claimId: state.claimId,
        claimGeneration: state.generation,
      }));
  }

  public ready(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.readyPromise === null) {
      this.readyPromise =
        this.options.lockRequest === undefined
          ? this.acquireFallbackOwnership(this.tabId())
          : this.acquireTabLock(this.tabId());
    }
    return this.readyPromise;
  }

  public restart(): Promise<void> {
    this.dispose();
    this.disposed = false;
    this.readyState = false;
    this.readyPromise = null;
    this.fallbackOwnerKey = null;
    this.fallbackOwnerId = null;
    this.tabLockRelease = this.createTabLockRelease();
    return this.ready();
  }

  public credential(gameId: string, generation: number): GameSessionClaimCredential {
    if (this.disposed) throw new Error("Game-session claim controller is disposed");
    const state = this.state(gameId);
    const next = { ...state, generation: Math.max(state.generation, generation) };
    this.states.set(gameId, next);
    this.persistGeneration(gameId, next.generation);
    return { claimId: next.claimId, claimGeneration: next.generation };
  }

  public canWrite(gameId: string, revision: number, claimGeneration: number): boolean {
    if (!this.readyState) return false;
    const status = this.states.get(gameId)?.status;
    if (status === "blocked" || status === "offline") return false;
    if (revision === 0 && claimGeneration === 0) return true;
    return this.isOwned(gameId, claimGeneration);
  }

  public isOwned(gameId: string, claimGeneration: number): boolean {
    const state = this.states.get(gameId);
    return state?.status === "owned" && state.generation === claimGeneration;
  }

  public markOwned(gameId: string, generation: number): void {
    if (this.disposed) throw new Error("Game-session claim controller is disposed");
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new Error("Owned game-session claims require a positive generation");
    }
    const state = this.state(gameId);
    const next = {
      ...state,
      generation: Math.max(state.generation, generation),
      status: "owned",
    } as const;
    this.states.set(gameId, next);
    this.persistGeneration(gameId, next.generation);
  }

  public markOffline(gameId: string): void {
    this.updateStatus(gameId, "offline");
  }

  public markBlocked(gameId: string): void {
    this.updateStatus(gameId, "blocked");
    if (this.renewalGameId === gameId) this.stopRenewal();
  }

  public startRenewal(gameId: string, renew: () => void): void {
    if (this.disposed) return;
    this.stopRenewal();
    this.renewalGameId = gameId;
    renew();
    this.renewalTimer = globalThis.setInterval(renew, 15_000);
  }

  public stopRenewal(): void {
    if (this.renewalTimer !== null) globalThis.clearInterval(this.renewalTimer);
    this.renewalTimer = null;
    this.renewalGameId = null;
  }

  public clear(gameId: string): void {
    if (this.renewalGameId === gameId) this.stopRenewal();
    this.states.delete(gameId);
    this.options.storage.removeItem(this.storageKey(gameId));
    this.options.storage.removeItem(this.generationStorageKey(gameId));
  }

  public clearAll(): void {
    this.stopRenewal();
    this.states.clear();
    const prefix = `${gameSessionClaimStoragePrefix(this.options.clubId)}.`;
    for (let index = this.options.storage.length - 1; index >= 0; index -= 1) {
      const key = this.options.storage.key(index);
      if (key?.startsWith(prefix)) this.options.storage.removeItem(key);
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycleVersion += 1;
    this.stopRenewal();
    this.readyState = false;
    try {
      if (
        this.fallbackOwnerKey !== null &&
        this.options.coordinationStorage?.getItem(this.fallbackOwnerKey) === this.fallbackOwnerId
      ) {
        this.options.coordinationStorage.removeItem(this.fallbackOwnerKey);
      }
    } catch {
      // Page teardown must still release a held Web Lock when storage is unavailable.
    }
    this.releaseTabLock();
  }

  private updateStatus(gameId: string, status: ClaimStatus): void {
    this.states.set(gameId, { ...this.state(gameId), status });
  }

  private state(gameId: string): ClaimState {
    const current = this.states.get(gameId);
    if (current !== undefined) return current;
    const key = this.storageKey(gameId);
    const stored = this.options.storage.getItem(key);
    const claimId = stored !== null && uuidPattern.test(stored) ? stored : this.options.createId();
    this.options.storage.setItem(key, claimId);
    const storedGeneration = Number(
      this.options.storage.getItem(this.generationStorageKey(gameId)),
    );
    const generation =
      Number.isSafeInteger(storedGeneration) && storedGeneration >= 0 ? storedGeneration : 0;
    const created: ClaimState = { claimId, generation, status: "idle" };
    this.states.set(gameId, created);
    return created;
  }

  private tabId(): string {
    const key = gameSessionClaimTabStorageKey(this.options.clubId);
    const stored = this.options.storage.getItem(key);
    if (stored !== null && uuidPattern.test(stored)) return stored;
    const tabId = this.options.createId();
    this.options.storage.setItem(key, tabId);
    return tabId;
  }

  private async acquireFallbackOwnership(tabId: string): Promise<void> {
    const storage = this.options.coordinationStorage;
    if (storage === undefined) {
      this.clearAll();
      this.tabId();
      this.readyState = true;
      return;
    }
    const key = `mafia-dashboard-claim-tab-owner:${tabId}`;
    let ownerId: string | null = null;
    try {
      if (storage.getItem(key) !== null) {
        this.clearAll();
        await this.acquireFallbackOwnership(this.tabId());
        return;
      }
      ownerId = this.options.createId();
      storage.setItem(key, ownerId);
      await Promise.resolve();
      if (storage.getItem(key) !== ownerId) {
        this.clearAll();
        await this.acquireFallbackOwnership(this.tabId());
        return;
      }
      this.fallbackOwnerKey = key;
      this.fallbackOwnerId = ownerId;
      this.readyState = true;
    } catch {
      try {
        if (ownerId !== null && storage.getItem(key) === ownerId) storage.removeItem(key);
      } catch {
        // The fallback below deliberately rotates session credentials when storage is unusable.
      }
      this.clearAll();
      this.tabId();
      this.readyState = true;
    }
  }

  private acquireTabLock(tabId: string): Promise<void> {
    const lockRelease = this.tabLockRelease;
    return new Promise((resolve) => {
      const fallback = () => {
        if (this.disposed) {
          resolve();
          return;
        }
        this.clearAll();
        this.tabId();
        this.readyState = true;
        resolve();
      };
      try {
        void this.options.lockRequest!(
          `mafia-dashboard-claim-tab:${tabId}`,
          { mode: "exclusive", ifAvailable: true },
          async (lock) => {
            if (lock === null) {
              if (this.disposed) {
                resolve();
                return;
              }
              this.clearAll();
              await this.acquireTabLock(this.tabId());
              resolve();
              return;
            }
            if (this.disposed) {
              resolve();
              return;
            }
            this.readyState = true;
            resolve();
            await lockRelease;
          },
        ).catch(fallback);
      } catch {
        fallback();
      }
    });
  }

  private storageKey(gameId: string): string {
    return `${gameSessionClaimStoragePrefix(this.options.clubId)}.${gameId}`;
  }

  private generationStorageKey(gameId: string): string {
    return `${this.storageKey(gameId)}.generation`;
  }

  private persistGeneration(gameId: string, generation: number): void {
    this.options.storage.setItem(this.generationStorageKey(gameId), String(generation));
  }

  private createTabLockRelease(): Promise<void> {
    return new Promise((resolve) => {
      this.releaseTabLock = resolve;
    });
  }
}
