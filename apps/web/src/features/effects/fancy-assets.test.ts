import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BACKGROUND, backgroundAsset } from "../theme/background-preferences.js";

const assets = vi.hoisted(() => ({ book: vi.fn(), gpu: vi.fn(), image: vi.fn() }));
vi.mock("../rules/RulesBookHost.js", () => ({ preloadRulesBook: assets.book }));
vi.mock("./vgpu/VgpuLightingRuntime.js", () => ({ preloadVgpuLighting: assets.gpu }));
vi.mock("./image-assets.js", () => ({ loadVisualImage: assets.image }));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
beforeEach(() => {
  vi.resetModules();
  for (const loader of Object.values(assets)) loader.mockReset().mockResolvedValue(undefined);
});

describe("enabled visual asset preparation", () => {
  it("shares complete preparation and waits for book, selected image decode and requested GPU module", async () => {
    const { prepareFancyAssets, areFancyAssetsReady } = await import("./fancy-assets.js");
    const book = deferred(),
      image = deferred(),
      gpu = deferred();
    assets.book.mockReturnValue(book.promise);
    assets.image.mockReturnValue(image.promise);
    assets.gpu.mockReturnValue(gpu.promise);
    const request = { background: DEFAULT_BACKGROUND, glass: true, vgpu: true } as const;
    const preparation = prepareFancyAssets(request);
    expect(prepareFancyAssets(request)).toBe(preparation);
    expect(assets.image).toHaveBeenCalledExactlyOnceWith(backgroundAsset(DEFAULT_BACKGROUND));
    book.resolve();
    image.resolve();
    await Promise.resolve();
    expect(areFancyAssetsReady(request)).toBe(false);
    gpu.resolve();
    await preparation;
    expect(areFancyAssetsReady(request)).toBe(true);
    await prepareFancyAssets(request);
    expect(assets.book).toHaveBeenCalledTimes(1);
    expect(assets.gpu).toHaveBeenCalledTimes(1);
  });

  it("does not request disabled renderer assets and releases a failed preparation for deliberate retry", async () => {
    const { prepareFancyAssets, areFancyAssetsReady } = await import("./fancy-assets.js");
    const request = { background: DEFAULT_BACKGROUND, glass: false, vgpu: false } as const;
    assets.book.mockRejectedValueOnce(new Error("missing font"));
    await expect(prepareFancyAssets(request)).rejects.toThrow("missing font");
    expect(areFancyAssetsReady(request)).toBe(false);
    await prepareFancyAssets(request);
    expect(assets.book).toHaveBeenCalledTimes(2);
    expect(assets.image).not.toHaveBeenCalled();
    expect(assets.gpu).not.toHaveBeenCalled();
    expect(areFancyAssetsReady(request)).toBe(true);
  });
});
