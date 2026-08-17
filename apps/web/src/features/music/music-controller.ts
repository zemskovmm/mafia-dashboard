export interface MusicPlayerAdapter {
  play(): void;
  pause(): void;
  setVolume(volume: number): void;
  getVolume(): number;
}

export type FadeResult = "completed" | "cancelled";

interface ActiveFade {
  readonly timer: ReturnType<typeof setInterval>;
  readonly resolve: (result: FadeResult) => void;
}

export class MusicController {
  private activeFade: ActiveFade | null = null;
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
    this.cancelActiveFade();
    this.player.setVolume(0);
    this.player.play();
    return this.runFade(0, targetVolume, durationMs, false);
  }

  public fadeOut({ durationMs }: { readonly durationMs: number }): Promise<FadeResult> {
    this.cancelActiveFade();
    return this.runFade(this.player.getVolume(), 0, durationMs, true);
  }

  public cancelActiveFade(): void {
    if (this.activeFade === null) {
      return;
    }
    clearInterval(this.activeFade.timer);
    this.activeFade.resolve("cancelled");
    this.activeFade = null;
  }

  private runFade(
    startVolume: number,
    targetVolume: number,
    durationMs: number,
    pauseWhenComplete: boolean,
  ): Promise<FadeResult> {
    if (durationMs <= 0) {
      this.player.setVolume(targetVolume);
      if (pauseWhenComplete) {
        this.player.pause();
      }
      return Promise.resolve("completed");
    }

    const steps = Math.max(1, Math.ceil(durationMs / this.stepMs));
    let currentStep = 0;

    return new Promise<FadeResult>((resolve) => {
      const timer = setInterval(() => {
        currentStep += 1;
        const progress = Math.min(1, currentStep / steps);
        const volume = Math.round(startVolume + (targetVolume - startVolume) * progress);
        this.player.setVolume(volume);

        if (currentStep >= steps) {
          clearInterval(timer);
          this.activeFade = null;
          if (pauseWhenComplete) {
            this.player.pause();
          }
          resolve("completed");
        }
      }, this.stepMs);
      this.activeFade = { timer, resolve };
    });
  }
}
