import { describe, expect, it, vi } from "vitest";
import { GainAudioAdapter } from "./gain-audio-adapter.js";

const media = () => ({
  currentTime: 0,
  volume: 1,
  play: vi.fn().mockResolvedValue(undefined),
  pause: vi.fn(),
});

describe("GainAudioAdapter", () => {
  it("uses a Web Audio gain value instead of the non-settable iOS media volume", () => {
    const audio = media();
    const gain = { value: 1 };
    const adapter = new GainAudioAdapter(audio, gain);

    adapter.setVolume(65);

    expect(gain.value).toBe(0.65);
    expect(audio.volume).toBe(1);
    expect(adapter.getVolume()).toBe(65);
  });

  it("accepts normalized crossfade values and controls playback position", async () => {
    const audio = media();
    const gain = { value: 1 };
    const adapter = new GainAudioAdapter(audio, gain);

    adapter.setVolume(0.25);
    adapter.seek(12.5);
    await adapter.play();
    adapter.pause();

    expect(gain.value).toBe(0.25);
    expect(audio.currentTime).toBe(12.5);
    expect(audio.play).toHaveBeenCalledOnce();
    expect(audio.pause).toHaveBeenCalledOnce();
  });
});
