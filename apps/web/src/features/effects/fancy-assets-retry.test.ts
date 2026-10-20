import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BACKGROUND } from "../theme/background-preferences.js";

// jsdom has no font registration/rendering. Keep every preparation/cache layer real.
vi.mock("../rules/RulesBookContent.js", () => ({ default: () => null }));

const deferred = () => {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const images: ReturnType<typeof deferred>[] = [];
const fonts: ReturnType<typeof deferred>[] = [];
const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
const loadedFaces = [{ status: "loaded" }];
const request = { background: DEFAULT_BACKGROUND, glass: false, vgpu: false } as const;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  images.length = fonts.length = 0;
  vi.stubGlobal(
    "Image",
    class {
      decode() {
        const pending = deferred();
        images.push(pending);
        return pending.promise;
      }
    },
  );
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      [Symbol.iterator]: () =>
        [
          { family: "RulesCormorant", style: "normal", weight: "400" },
          { family: "RulesCormorant", style: "normal", weight: "600" },
          { family: "RulesCormorant", style: "italic", weight: "400" },
        ].values(),
      load() {
        const pending = deferred();
        fonts.push(pending);
        return pending.promise;
      },
    },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
  else Reflect.deleteProperty(document, "fonts");
});

describe("Retry through the actual nested visual preparation caches", () => {
  it.each([
    ["fonts", "resolve"],
    ["fonts", "reject"],
    ["artwork", "reject"],
  ] as const)(
    "restarts stalled %s after the deadline and ignores the old attempt's late %s",
    async (stalled, lateResult) => {
      const { useFancyPreparation, FANCY_PREPARATION_TIMEOUT_MS } =
        await import("./useFancyPreparation.js");
      const { prepareFancyAssets, areFancyAssetsReady } = await import("./fancy-assets.js");
      const { preloadRulesBook } = await import("../rules/RulesBookHost.js");
      const { isRulesBookReady } = await import("../rules/rules-book-loading.js");
      const { preloadRulesBookAssets } = await import("../rules/rules-book-assets.js");
      const view = renderHook(({ enabled }) => useFancyPreparation(enabled, request), {
        initialProps: { enabled: true },
      });
      const original = prepareFancyAssets(request);
      await act(async () => {
        await vi.waitFor(() => expect(fonts).toHaveLength(3));
        images[0]!.resolve(undefined);
        fonts[0]!.resolve(loadedFaces);
        if (stalled === "fonts") images[1]!.resolve(undefined);
        else fonts.slice(1).forEach((font) => font.resolve(loadedFaces));
      });
      act(() => vi.advanceTimersByTime(FANCY_PREPARATION_TIMEOUT_MS));
      expect(view.result.current.status).toBe("fallback");
      expect(view.result.current.enabled).toBe(false);

      act(() => view.result.current.retry());
      await act(async () => {
        await vi.waitFor(() => {
          expect(fonts).toHaveLength(stalled === "fonts" ? 5 : 3);
          expect(images).toHaveLength(stalled === "artwork" ? 3 : 2);
        });
      });
      expect(view.result.current.status).toBe("preparing");
      const current = prepareFancyAssets(request);
      const currentBook = preloadRulesBook();
      const currentAssets = preloadRulesBookAssets();
      expect(current).not.toBe(original);

      await act(async () => {
        const oldPending = stalled === "fonts" ? fonts.slice(1, 3) : [images[1]!];
        for (const pending of oldPending) {
          if (lateResult === "reject") pending.reject(new Error("obsolete asset failure"));
          else pending.resolve(loadedFaces);
        }
        await original.catch(() => undefined);
      });
      expect(view.result.current.status).toBe("preparing");
      expect(areFancyAssetsReady(request)).toBe(false);
      expect(isRulesBookReady()).toBe(false);
      expect(preloadRulesBook()).toBe(currentBook);
      expect(preloadRulesBookAssets()).toBe(currentAssets);
      expect(prepareFancyAssets(request)).toBe(current);

      await act(async () => {
        fonts.slice(3).forEach((font) => font.resolve(loadedFaces));
        images.slice(2).forEach((image) => image.resolve(undefined));
        await current;
      });
      expect(view.result.current.status).toBe("ready");
      expect(view.result.current.enabled).toBe(true);
      expect(isRulesBookReady()).toBe(true);
      view.rerender({ enabled: false });
      view.rerender({ enabled: true });
      expect(view.result.current.status).toBe("ready");
      expect(preloadRulesBookAssets()).toBe(currentAssets);
      expect(fonts).toHaveLength(stalled === "fonts" ? 5 : 3);
      expect(images).toHaveLength(stalled === "artwork" ? 3 : 2);
    },
  );
});
