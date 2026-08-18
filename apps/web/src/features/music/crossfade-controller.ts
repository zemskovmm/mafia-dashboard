export interface AudioDeckAdapter {
  play(): Promise<void> | void;
  pause(): void;
  setVolume(volume: number): void;
  seek(seconds: number): void;
}

export type CrossfadeResult = "completed" | "cancelled";

interface ActiveTransition {
  readonly generation: number;
  readonly next: AudioDeckAdapter;
  readonly resolve: (result: CrossfadeResult) => void;
  readonly reject: (error: unknown) => void;
  timer: ReturnType<typeof setInterval> | null;
  cancelledAtGeneration: number | null;
}

export class CrossfadeController {
  private active: ActiveTransition | null = null;
  private generation = 0;
  private readonly stepMs: number;

  public constructor(options: { readonly stepMs?: number } = {}) {
    this.stepMs = options.stepMs ?? 50;
  }

  public crossfade({
    current,
    next,
    nextStartSeconds,
    durationMs,
    targetVolume,
  }: {
    readonly current: AudioDeckAdapter;
    readonly next: AudioDeckAdapter;
    readonly nextStartSeconds: number;
    readonly durationMs: number;
    readonly targetVolume: number;
  }): Promise<CrossfadeResult> {
    this.cancel();
    const generation = ++this.generation;
    let resolve!: (result: CrossfadeResult) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<CrossfadeResult>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    const operation: ActiveTransition = {
      generation,
      next,
      resolve,
      reject,
      timer: null,
      cancelledAtGeneration: null,
    };
    this.active = operation;

    next.seek(Math.max(0, nextStartSeconds));
    next.setVolume(0);
    let playResult: Promise<void> | void;
    try {
      playResult = next.play();
    } catch (error) {
      this.fail(operation, error);
      return result;
    }

    void Promise.resolve(playResult).then(
      () => {
        if (!this.isActive(operation)) {
          if (operation.cancelledAtGeneration === this.generation) next.pause();
          return;
        }
        if (durationMs <= 0) {
          current.setVolume(0);
          current.pause();
          next.setVolume(targetVolume);
          this.active = null;
          operation.resolve("completed");
          return;
        }

        const steps = Math.max(1, Math.ceil(durationMs / this.stepMs));
        let step = 0;
        operation.timer = setInterval(() => {
          if (!this.isActive(operation)) return;
          step += 1;
          const progress = Math.min(1, step / steps);
          current.setVolume(targetVolume * (1 - progress));
          next.setVolume(targetVolume * progress);
          if (step >= steps) {
            if (operation.timer !== null) clearInterval(operation.timer);
            this.active = null;
            current.pause();
            operation.resolve("completed");
          }
        }, this.stepMs);
      },
      (error: unknown) => {
        if (this.isActive(operation)) this.fail(operation, error);
      },
    );
    return result;
  }

  public cancel(): void {
    this.generation += 1;
    const active = this.active;
    if (active === null) return;
    if (active.timer !== null) clearInterval(active.timer);
    active.cancelledAtGeneration = this.generation;
    active.next.pause();
    this.active = null;
    active.resolve("cancelled");
  }

  private isActive(operation: ActiveTransition): boolean {
    return this.active === operation && operation.generation === this.generation;
  }

  private fail(operation: ActiveTransition, error: unknown): void {
    if (this.active === operation) this.active = null;
    operation.reject(error);
  }
}
