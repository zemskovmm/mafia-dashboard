import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrossfadeController } from "./crossfade-controller.js";
import type { AudioDeckAdapter } from "./crossfade-controller.js";

class FakeDeck implements AudioDeckAdapter {
  public volume = 0.65;
  public currentTime = 0;
  public playCalls = 0;
  public pauseCalls = 0;
  public volumes: number[] = [];
  public playError: Error | null = null;

  public play(): Promise<void> {
    this.playCalls += 1;
    return this.playError === null ? Promise.resolve() : Promise.reject(this.playError);
  }

  public pause(): void {
    this.pauseCalls += 1;
  }

  public setVolume(volume: number): void {
    this.volume = volume;
    this.volumes.push(volume);
  }

  public seek(seconds: number): void {
    this.currentTime = seconds;
  }
}

class DeferredDeck extends FakeDeck {
  public resolvePlay!: () => void;

  public override play(): Promise<void> {
    this.playCalls += 1;
    return new Promise((resolve) => {
      this.resolvePlay = resolve;
    });
  }
}

describe("CrossfadeController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts the next deck at its chosen position and fades both decks", async () => {
    const current = new FakeDeck();
    const next = new FakeDeck();
    const controller = new CrossfadeController({ stepMs: 100 });

    const transition = controller.crossfade({
      current,
      next,
      nextStartSeconds: 37.5,
      durationMs: 500,
      targetVolume: 0.65,
    });

    expect(next.currentTime).toBe(37.5);
    expect(next.volumes[0]).toBe(0);
    expect(next.playCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(500);
    await expect(transition).resolves.toBe("completed");

    expect(current.volume).toBe(0);
    expect(current.pauseCalls).toBe(1);
    expect(next.volume).toBe(0.65);
  });

  it("cancels an active transition before starting another", async () => {
    const first = new FakeDeck();
    const second = new FakeDeck();
    const third = new FakeDeck();
    const controller = new CrossfadeController({ stepMs: 100 });

    const abandoned = controller.crossfade({
      current: first,
      next: second,
      nextStartSeconds: 0,
      durationMs: 1_000,
      targetVolume: 0.65,
    });
    await vi.advanceTimersByTimeAsync(200);
    const replacement = controller.crossfade({
      current: second,
      next: third,
      nextStartSeconds: 12,
      durationMs: 200,
      targetVolume: 0.65,
    });
    await vi.advanceTimersByTimeAsync(200);

    await expect(abandoned).resolves.toBe("cancelled");
    await expect(replacement).resolves.toBe("completed");
    expect(third.currentTime).toBe(12);
  });

  it("does not fade the current deck when the next deck cannot start", async () => {
    const current = new FakeDeck();
    const next = new FakeDeck();
    next.playError = new Error("play blocked");
    const controller = new CrossfadeController();

    await expect(
      controller.crossfade({
        current,
        next,
        nextStartSeconds: 4,
        durationMs: 500,
        targetVolume: 0.65,
      }),
    ).rejects.toThrow("play blocked");

    expect(current.volume).toBe(0.65);
    expect(current.pauseCalls).toBe(0);
  });

  it("cancels while the next deck play is pending and never starts gain timers later", async () => {
    const current = new FakeDeck();
    const next = new DeferredDeck();
    const controller = new CrossfadeController({ stepMs: 100 });
    let settled: string | undefined;
    const transition = controller.crossfade({
      current,
      next,
      nextStartSeconds: 8,
      durationMs: 500,
      targetVolume: 0.65,
    });
    void transition.then((result) => {
      settled = result;
    });

    controller.cancel();
    await Promise.resolve();

    expect(settled).toBe("cancelled");
    next.resolvePlay();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);
    await expect(transition).resolves.toBe("cancelled");
    expect(current.volumes).toEqual([]);
    expect(current.pauseCalls).toBe(0);
    expect(next.volumes).toEqual([0]);
    expect(next.pauseCalls).toBeGreaterThanOrEqual(1);
  });

  it("stops both gain writers and the incoming deck when an active crossfade is cancelled", async () => {
    const current = new FakeDeck();
    const next = new FakeDeck();
    const controller = new CrossfadeController({ stepMs: 100 });
    const transition = controller.crossfade({
      current,
      next,
      nextStartSeconds: 0,
      durationMs: 1_000,
      targetVolume: 0.65,
    });
    await vi.advanceTimersByTimeAsync(200);
    const currentWrites = current.volumes.length;
    const nextWrites = next.volumes.length;

    controller.cancel();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(transition).resolves.toBe("cancelled");
    expect(current.volumes).toHaveLength(currentWrites);
    expect(next.volumes).toHaveLength(nextWrites);
    expect(next.pauseCalls).toBe(1);
    expect(current.pauseCalls).toBe(0);
  });
});
