import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MusicController } from "./music-controller.js";
import type { MusicPlayerAdapter } from "./music-controller.js";

class FakePlayer implements MusicPlayerAdapter {
  public volume = 80;
  public playCalls = 0;
  public pauseCalls = 0;
  public volumes: number[] = [];

  public play(): void {
    this.playCalls += 1;
  }

  public pause(): void {
    this.pauseCalls += 1;
  }

  public setVolume(volume: number): void {
    this.volume = volume;
    this.volumes.push(volume);
  }

  public getVolume(): number {
    return this.volume;
  }
}

describe("MusicController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts playback at zero and fades to the target volume", async () => {
    const player = new FakePlayer();
    const controller = new MusicController(player, { stepMs: 100 });

    const fade = controller.fadeIn({ durationMs: 500, targetVolume: 50 });
    expect(player.playCalls).toBe(1);
    expect(player.volumes[0]).toBe(0);

    await vi.advanceTimersByTimeAsync(500);
    await fade;

    expect(player.volume).toBe(50);
    expect(player.volumes).toEqual([0, 10, 20, 30, 40, 50]);
  });

  it("fades to zero before pausing", async () => {
    const player = new FakePlayer();
    player.volume = 60;
    const controller = new MusicController(player, { stepMs: 100 });

    const fade = controller.fadeOut({ durationMs: 300 });
    expect(player.pauseCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(300);
    await fade;

    expect(player.volumes).toEqual([40, 20, 0]);
    expect(player.pauseCalls).toBe(1);
  });

  it("cancels an in-progress fade when a new fade starts", async () => {
    const player = new FakePlayer();
    const controller = new MusicController(player, { stepMs: 100 });

    const first = controller.fadeIn({ durationMs: 1_000, targetVolume: 80 });
    await vi.advanceTimersByTimeAsync(200);
    const second = controller.fadeOut({ durationMs: 200 });
    await vi.advanceTimersByTimeAsync(200);

    await expect(first).resolves.toBe("cancelled");
    await expect(second).resolves.toBe("completed");
    expect(player.volume).toBe(0);
    expect(player.pauseCalls).toBe(1);
  });
});
