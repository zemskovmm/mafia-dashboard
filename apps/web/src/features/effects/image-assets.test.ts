import { afterEach, describe, expect, it, vi } from "vitest";
import { loadVisualImage } from "./image-assets.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("shared decoded visual images", () => {
  it("shares pending and successful decode work, then evicts failures for retry", async () => {
    let resolve!: () => void;
    const image = document.createElement("img");
    const decode = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<void>((done) => {
          resolve = done;
        }),
      )
      .mockRejectedValueOnce(new Error("decode failed"))
      .mockResolvedValue(undefined);
    image.decode = decode;
    const construct = vi.fn(function () {
      return image;
    });
    vi.stubGlobal("Image", construct);
    const first = loadVisualImage("/shared-test.svg");
    expect(loadVisualImage("/shared-test.svg")).toBe(first);
    resolve();
    expect(await first).toBe(image);
    expect(loadVisualImage("/shared-test.svg")).toBe(first);
    expect(construct).toHaveBeenCalledTimes(1);
    await expect(loadVisualImage("/failed-test.svg")).rejects.toThrow("decode failed");
    expect(await loadVisualImage("/failed-test.svg")).toBe(image);
    expect(decode).toHaveBeenCalledTimes(3);
  });

  it("bounds a stalled image without publishing it as ready", async () => {
    vi.useFakeTimers();
    const image = document.createElement("img");
    image.decode = () => new Promise(() => undefined);
    vi.stubGlobal("Image", function () {
      return image;
    });
    const result = expect(loadVisualImage("/stalled-test.svg")).rejects.toThrow("timed out");
    vi.advanceTimersByTime(10_000);
    await result;
    expect(image.getAttribute("src")).toBeNull();
  });
});
