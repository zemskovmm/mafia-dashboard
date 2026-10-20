import { describe, expect, it, vi } from "vitest";
import * as host from "./RulesBookHost.js";

const load = vi.hoisted(() => ({
  imports: 0,
  assets: 0,
  resolve: null as null | (() => void),
}));
vi.mock("./RulesBookContent.js", () => {
  load.imports++;
  return { default: () => null };
});
vi.mock("./rules-book-assets.js", () => ({
  preloadRulesBookAssets: () => {
    load.assets++;
    return new Promise<void>((resolve) => {
      load.resolve = resolve;
    });
  },
}));

describe("explicit shared rules-book preload", () => {
  it("deduplicates reader code/CSS and asset readiness without opening a hidden reader", async () => {
    expect(load.imports).toBe(0);
    expect(load.assets).toBe(0);
    expect(host).toHaveProperty("preloadRulesBook", expect.any(Function));
    const ready = host.preloadRulesBook();
    expect(host.preloadRulesBook()).toBe(ready);
    await vi.waitFor(() => expect(load.resolve).not.toBeNull());
    expect(load.imports).toBe(1);
    expect(load.assets).toBe(1);
    let completed = false;
    void ready.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(document.querySelector("dialog, canvas, .rs-book")).toBeNull();
    load.resolve!();
    await ready;
    expect(completed).toBe(true);
    expect(host.preloadRulesBook()).toBe(ready);
    expect(load.imports).toBe(1);
    expect(load.assets).toBe(1);
  });
});
