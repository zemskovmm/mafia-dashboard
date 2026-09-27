import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertBrowserGameStorageGuard,
  BrowserGameStorageBusyError,
  browserGameStorageLockKey,
  withBrowserGameStorageGuard,
  withBrowserGameStorageTransaction,
} from "./browser-game-storage-lock.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("browser game storage locking", () => {
  it("requests a non-queued native lock and never runs the operation when it is busy", async () => {
    const request = vi.fn(
      (_name: string, _options: LockOptions, callback: LockGrantedCallback<unknown>) =>
        Promise.resolve().then(() => callback(null)),
    );
    vi.stubGlobal("navigator", { locks: { request } });
    const operation = vi.fn();

    await expect(
      withBrowserGameStorageGuard(operation, { ifAvailable: true }),
    ).rejects.toBeInstanceOf(BrowserGameStorageBusyError);

    expect(request).toHaveBeenCalledExactlyOnceWith(
      browserGameStorageLockKey,
      { ifAvailable: true },
      expect.any(Function),
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it("retains queued mutation transactions while refusing a busy fail-fast entry", async () => {
    let release!: () => void;
    const lifetime = new Promise<void>((resolve) => {
      release = resolve;
    });
    const owner = withBrowserGameStorageGuard(async (guard) => {
      assertBrowserGameStorageGuard(guard);
      await lifetime;
      return guard;
    });
    const mutation = vi.fn(() => "saved");
    const queued = withBrowserGameStorageTransaction(window.localStorage, mutation);
    const entry = vi.fn();
    try {
      await expect(
        withBrowserGameStorageGuard(entry, { ifAvailable: true }),
      ).rejects.toBeInstanceOf(BrowserGameStorageBusyError);
      expect(entry).not.toHaveBeenCalled();
      expect(mutation).not.toHaveBeenCalled();
    } finally {
      release();
      await owner;
      await queued;
    }
    expect(mutation).toHaveBeenCalledOnce();
    expect(entry).not.toHaveBeenCalled();
    const awaitedGuard = await owner;
    expect(() => assertBrowserGameStorageGuard(awaitedGuard)).toThrow();
  });

  it("releases the guard after a rejected operation and permits a fresh entry", async () => {
    const failure = new Error("storage failure");
    await expect(withBrowserGameStorageGuard(() => Promise.reject(failure))).rejects.toBe(failure);
    await expect(
      withBrowserGameStorageGuard(
        (guard) => {
          assertBrowserGameStorageGuard(guard);
          return "ready";
        },
        { ifAvailable: true },
      ),
    ).resolves.toBe("ready");
  });

  it("does not mistake unavailable Web Locks for another tab in production", async () => {
    vi.stubEnv("MODE", "production");
    vi.stubGlobal("navigator", {});
    const operation = vi.fn();
    await expect(withBrowserGameStorageGuard(operation, { ifAvailable: true })).rejects.toThrow(
      "This browser cannot safely lock local game storage",
    );
    expect(operation).not.toHaveBeenCalled();
  });
});
