import { reportError } from "../console/error-console.js";

export interface MusicPlayerAdapter {
  play(): void | Promise<void>;
  pause(): void;
  setVolume(volume: number): void;
  getVolume(): number;
}

export type FadeResult = "completed" | "cancelled";

interface ActiveFade {
  readonly generation: number;
  readonly resolve: (result: FadeResult) => void;
  readonly reject: (error: unknown) => void;
  timer: ReturnType<typeof setInterval> | null;
  cancelledAtGeneration: number | null;
  pauseWhenCancelledPlayResolves: boolean;
}

export class MusicController {
  private activeFade: ActiveFade | null = null;
  private generation = 0;
  private readonly stepMs: number;

  public constructor(
    private readonly player: MusicPlayerAdapter,
    options: { readonly stepMs?: number } = {},
  ) {
    this.stepMs = options.stepMs ?? 100;
  }

  public fadeIn({
    durationMs,
    targetVolume,
  }: {
    readonly durationMs: number;
    readonly targetVolume: number;
  }): Promise<FadeResult> {
    const operation = this.beginOperation();
    this.player.setVolume(0);

    let playResult: void | Promise<void>;
    try {
      playResult = this.player.play();
    } catch (error) {
      this.failOperation(operation, error);
      return operation.promise;
    }

    void Promise.resolve(playResult).then(
      () => {
        if (!this.isActive(operation.active)) {
          if (
            operation.active.pauseWhenCancelledPlayResolves &&
            operation.active.cancelledAtGeneration === this.generation
          )
            this.player.pause();
          return;
        }
        this.startFade(operation.active, 0, targetVolume, durationMs, false);
      },
      (error: unknown) => {
        if (this.isActive(operation.active)) this.failOperation(operation, error);
      },
    );
    return operation.promise;
  }

  public fadeOut({ durationMs }: { readonly durationMs: number }): Promise<FadeResult> {
    const operation = this.beginOperation();
    this.startFade(operation.active, this.player.getVolume(), 0, durationMs, true);
    return operation.promise;
  }

  public cancelActiveFade({
    pausePendingPlayback = true,
  }: { readonly pausePendingPlayback?: boolean } = {}): void {
    this.generation += 1;
    const active = this.activeFade;
    if (active === null) return;
    if (active.timer !== null) clearInterval(active.timer);
    active.cancelledAtGeneration = this.generation;
    active.pauseWhenCancelledPlayResolves = pausePendingPlayback;
    this.activeFade = null;
    active.resolve("cancelled");
  }

  private beginOperation(): {
    readonly active: ActiveFade;
    readonly promise: Promise<FadeResult>;
  } {
    this.cancelActiveFade({ pausePendingPlayback: false });
    const generation = ++this.generation;
    let resolve!: (result: FadeResult) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<FadeResult>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    const active: ActiveFade = {
      generation,
      resolve,
      reject,
      timer: null,
      cancelledAtGeneration: null,
      pauseWhenCancelledPlayResolves: false,
    };
    this.activeFade = active;
    return { active, promise };
  }

  private isActive(operation: ActiveFade): boolean {
    return this.activeFade === operation && operation.generation === this.generation;
  }

  private failOperation(operation: { readonly active: ActiveFade }, error: unknown): void {
    if (this.activeFade === operation.active) this.activeFade = null;
    reportError(error, { source: "application", context: "music.fade" });
    operation.active.reject(error);
  }

  private startFade(
    operation: ActiveFade,
    startVolume: number,
    targetVolume: number,
    durationMs: number,
    pauseWhenComplete: boolean,
  ): void {
    if (!this.isActive(operation)) return;
    if (durationMs <= 0) {
      this.player.setVolume(targetVolume);
      if (pauseWhenComplete) {
        this.player.pause();
        this.player.setVolume(startVolume);
      }
      this.activeFade = null;
      operation.resolve("completed");
      return;
    }

    const steps = Math.max(1, Math.ceil(durationMs / this.stepMs));
    let currentStep = 0;
    operation.timer = setInterval(() => {
      if (!this.isActive(operation)) return;
      currentStep += 1;
      const progress = Math.min(1, currentStep / steps);
      const volume = Math.round(startVolume + (targetVolume - startVolume) * progress);
      this.player.setVolume(volume);

      if (currentStep >= steps) {
        if (operation.timer !== null) clearInterval(operation.timer);
        this.activeFade = null;
        if (pauseWhenComplete) {
          this.player.pause();
          this.player.setVolume(startVolume);
        }
        operation.resolve("completed");
      }
    }, this.stepMs);
  }
}
