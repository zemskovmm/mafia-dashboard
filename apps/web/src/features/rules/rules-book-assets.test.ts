import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pending = () => {
  let resolve!: (value?: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

const decoded: ReturnType<typeof pending>[] = [];
const fonts: ReturnType<typeof pending>[] = [];
const imageUrls: string[] = [];
const fontRequests: { font: string; text?: string }[] = [];
const declaredFaces = [
  { family: "RulesCormorant", style: "normal", weight: "400" },
  { family: "RulesCormorant", style: "normal", weight: "600" },
  { family: "RulesCormorant", style: "italic", weight: "400" },
];
let registeredFaces = [...declaredFaces];
const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");

beforeEach(() => {
  vi.resetModules();
  decoded.length = fonts.length = imageUrls.length = fontRequests.length = 0;
  registeredFaces = [...declaredFaces];
  vi.stubGlobal(
    "Image",
    class {
      set src(value: string) {
        imageUrls.push(value);
      }
      decode() {
        const next = pending();
        decoded.push(next);
        return next.promise;
      }
    },
  );
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      [Symbol.iterator]: () => registeredFaces.values(),
      load(font: string, text?: string) {
        fontRequests.push({ font, text });
        const next = pending();
        fonts.push(next);
        return next.promise;
      },
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
  else Reflect.deleteProperty(document, "fonts");
});

const finishFont = (index: number) => fonts[index]!.resolve([{ status: "loaded" }] as never);

describe("rules book asset readiness", () => {
  it("waits for every declared face to register before loading fonts, not just fonts.ready", async () => {
    vi.useFakeTimers();
    registeredFaces = [];
    const { preloadRulesBookAssets } = await import("./rules-book-assets.js");
    const ready = preloadRulesBookAssets();
    expect(fontRequests).toHaveLength(0);
    registeredFaces = declaredFaces.slice(0, 2);
    await vi.advanceTimersByTimeAsync(100);
    expect(fontRequests).toHaveLength(0);
    registeredFaces = [...declaredFaces];
    await vi.advanceTimersByTimeAsync(100);
    expect(fontRequests).toHaveLength(3);
    decoded.forEach((image) => image.resolve());
    fonts.forEach((_font, index) => finishFont(index));
    await ready;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds absent font registration and permits recovery without a lingering poll", async () => {
    vi.useFakeTimers();
    registeredFaces = [];
    const { preloadRulesBookAssets } = await import("./rules-book-assets.js");
    const ready = preloadRulesBookAssets();
    const rejected = expect(ready).rejects.toThrow(/font registration timed out/i);
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(fontRequests).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    registeredFaces = [...declaredFaces];
    const retry = preloadRulesBookAssets();
    decoded.forEach((image) => image.resolve());
    fonts.forEach((_font, index) => finishFont(index));
    await retry;
    expect(fontRequests).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 1, 2, 3, 4])(
    "cannot finish while required asset %i is still pending",
    async (pendingIndex) => {
      const { preloadRulesBookAssets } = await import("./rules-book-assets.js");
      const ready = preloadRulesBookAssets();
      let complete = false;
      void ready.then(() => {
        complete = true;
      });
      const required = [...decoded, ...fonts];
      required.forEach((asset, index) => {
        if (index !== pendingIndex) asset.resolve(index < 2 ? undefined : [{ status: "loaded" }]);
      });
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      expect(complete).toBe(false);
      required[pendingIndex]!.resolve(pendingIndex < 2 ? undefined : [{ status: "loaded" }]);
      await ready;
      expect(complete).toBe(true);
    },
  );

  it("waits for both decoded images and all three faces with EN/RU coverage, without mounting a book", async () => {
    const { preloadRulesBookAssets } = await import("./rules-book-assets.js");
    expect(imageUrls).toEqual([]);
    expect(fontRequests).toEqual([]);
    const ready = preloadRulesBookAssets();
    expect(preloadRulesBookAssets()).toBe(ready);
    let completed = false;
    void ready.then(() => {
      completed = true;
    });
    expect(imageUrls).toHaveLength(2);
    expect(imageUrls.join(" ")).toMatch(/club\.webp/);
    expect(imageUrls.join(" ")).toMatch(/night\.webp/);
    expect(fontRequests.map((item) => item.font)).toEqual([
      'normal 400 20px "RulesCormorant"',
      'normal 600 20px "RulesCormorant"',
      'italic 400 20px "RulesCormorant"',
    ]);
    expect(fontRequests.every(({ text }) => /[A-Z]/.test(text!) && /[А-ЯЁ]/.test(text!))).toBe(
      true,
    );
    decoded.forEach((image) => image.resolve());
    finishFont(0);
    finishFont(1);
    await Promise.resolve();
    expect(completed).toBe(false);
    finishFont(2);
    await ready;
    expect(completed).toBe(true);
    expect(preloadRulesBookAssets()).toBe(ready);
    expect(document.querySelector("dialog, canvas, .rs-book")).toBeNull();
  });

  it("rejects a failed asset and retries only on an explicit call, retaining successful work", async () => {
    const { preloadRulesBookAssets } = await import("./rules-book-assets.js");
    const first = preloadRulesBookAssets();
    decoded[0]!.resolve();
    decoded[1]!.reject(new Error("art decode failed"));
    fonts.forEach((_font, index) => finishFont(index));
    await expect(first).rejects.toThrow("art decode failed");
    await Promise.resolve();
    expect(imageUrls).toHaveLength(2);
    expect(fontRequests).toHaveLength(3);
    const retry = preloadRulesBookAssets();
    expect(retry).not.toBe(first);
    expect(imageUrls).toHaveLength(3);
    expect(fontRequests).toHaveLength(3);
    decoded[2]!.resolve();
    await retry;
  });

  it("does not claim font readiness when no registered face was loaded", async () => {
    const { preloadRulesBookAssets } = await import("./rules-book-assets.js");
    const ready = preloadRulesBookAssets();
    decoded.forEach((image) => image.resolve());
    fonts[0]!.resolve([] as never);
    finishFont(1);
    finishFont(2);
    await expect(ready).rejects.toThrow(/font/i);
  });
});
