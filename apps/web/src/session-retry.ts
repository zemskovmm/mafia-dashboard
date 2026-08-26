import { ApiError } from "./api/client.js";

export type SessionSyncPhase = "saved" | "saving" | "retrying" | "offline";
export type SessionSyncTerminalReason = "unreachable" | "rejected" | null;

export interface SessionRetrySnapshot {
  readonly phase: SessionSyncPhase;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly nextRetryAt: number | null;
  readonly terminalReason: SessionSyncTerminalReason;
}

interface SessionRetryOptions {
  readonly flush: () => Promise<void>;
  readonly probe: () => Promise<void>;
  readonly pendingCount: () => number;
  readonly reportTerminal: (error: unknown) => void;
  readonly retryDelaysMs?: readonly number[];
  readonly now?: () => number;
}

const isRetryable = (error: unknown): boolean =>
  !(error instanceof ApiError) ||
  error.status === 408 ||
  error.status === 425 ||
  error.status === 429 ||
  error.status >= 500;

export class SessionRetryController {
  private readonly retryDelaysMs: readonly number[];
  private readonly listeners = new Set<() => void>();
  private snapshot: SessionRetrySnapshot;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private disposed = false;
  private generation = 0;

  public constructor(private readonly options: SessionRetryOptions) {
    this.retryDelaysMs = options.retryDelaysMs ?? [1_000, 2_000];
    this.snapshot = {
      phase: options.pendingCount() > 0 ? "saving" : "saved",
      attempt: 0,
      maxAttempts: this.retryDelaysMs.length + 1,
      nextRetryAt: null,
      terminalReason: null,
    };
  }

  public getSnapshot = (): SessionRetrySnapshot => this.snapshot;

  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  public requestAutoSync(): void {
    if (
      this.disposed ||
      this.snapshot.phase === "offline" ||
      this.active ||
      this.timer !== null ||
      this.options.pendingCount() === 0
    ) {
      return;
    }
    this.start(false);
  }

  public retryNow(): void {
    if (this.disposed || this.active) return;
    this.cancelTimer();
    this.start(true);
  }

  public activate(): void {
    if (!this.disposed) return;
    this.disposed = false;
    this.active = false;
    this.update({
      phase: this.options.pendingCount() > 0 ? "saving" : "saved",
      attempt: 0,
      nextRetryAt: null,
      terminalReason: null,
    });
  }

  public dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.cancelTimer();
    this.listeners.clear();
  }

  private start(manual: boolean): void {
    this.generation += 1;
    const generation = this.generation;
    this.update({
      phase: "saving",
      attempt: 0,
      nextRetryAt: null,
      terminalReason: null,
    });
    void this.runAttempt(generation, manual);
  }

  private async runAttempt(generation: number, manual: boolean): Promise<void> {
    if (this.disposed || generation !== this.generation) return;
    const attempt = this.snapshot.attempt + 1;
    this.active = true;
    this.update({
      phase: attempt === 1 ? "saving" : "retrying",
      attempt,
      nextRetryAt: null,
      terminalReason: null,
    });
    try {
      const startedWithPendingChanges = this.options.pendingCount() > 0;
      if (startedWithPendingChanges) await this.options.flush();
      else if (manual) await this.options.probe();
      if (!startedWithPendingChanges && this.options.pendingCount() > 0) {
        await this.options.flush();
      }
      if (this.options.pendingCount() > 0) {
        throw new Error("Game session flush completed with pending changes");
      }
      if (this.disposed || generation !== this.generation) return;
      this.active = false;
      this.update({ phase: "saved", nextRetryAt: null, terminalReason: null });
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.active = false;
      if (!isRetryable(error)) {
        this.update({
          phase: "offline",
          nextRetryAt: null,
          terminalReason: "rejected",
        });
        this.options.reportTerminal(error);
        return;
      }
      const delay = this.retryDelaysMs[attempt - 1];
      if (delay === undefined) {
        this.update({
          phase: "offline",
          nextRetryAt: null,
          terminalReason: "unreachable",
        });
        this.options.reportTerminal(error);
        return;
      }
      const nextRetryAt = (this.options.now ?? Date.now)() + delay;
      this.update({ phase: "retrying", nextRetryAt, terminalReason: null });
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.runAttempt(generation, manual);
      }, delay);
    }
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private update(update: Partial<SessionRetrySnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
}
