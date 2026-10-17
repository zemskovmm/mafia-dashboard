import { describe, expect, it, vi } from "vitest";
import { createShutdown, registerShutdownSignals } from "./server-lifecycle.js";

describe("createShutdown", () => {
  it("closes Fastify before Azure storage", async () => {
    const order: string[] = [];
    const shutdown = createShutdown(
      { close: async () => void order.push("app") },
      { end: async () => void order.push("storage") },
    );

    await shutdown();

    expect(order).toEqual(["app", "storage"]);
  });

  it("shares one shutdown across repeated signals", async () => {
    const app = { close: vi.fn().mockResolvedValue(undefined) };
    const storage = { end: vi.fn().mockResolvedValue(undefined) };
    const shutdown = createShutdown(app, storage);

    await Promise.all([shutdown(), shutdown()]);

    expect(app.close).toHaveBeenCalledOnce();
    expect(storage.end).toHaveBeenCalledOnce();
  });

  it("closes Azure storage and preserves a Fastify close failure", async () => {
    const app = { close: vi.fn().mockRejectedValue(new Error("app close failed")) };
    const storage = { end: vi.fn().mockResolvedValue(undefined) };
    const shutdown = createShutdown(app, storage);

    await expect(shutdown()).rejects.toThrow("app close failed");
    expect(storage.end).toHaveBeenCalledOnce();
  });

  it("routes repeated process signals through the same shutdown", async () => {
    const listeners = new Map<string, () => void>();
    const registrar = {
      on: vi.fn((signal: string, listener: () => void) => void listeners.set(signal, listener)),
    };
    const app = { close: vi.fn().mockResolvedValue(undefined) };
    const storage = { end: vi.fn().mockResolvedValue(undefined) };
    const shutdown = createShutdown(app, storage);

    registerShutdownSignals(registrar, () => void shutdown());
    listeners.get("SIGTERM")?.();
    listeners.get("SIGTERM")?.();
    await shutdown();

    expect(registrar.on).toHaveBeenCalledTimes(2);
    expect(app.close).toHaveBeenCalledOnce();
    expect(storage.end).toHaveBeenCalledOnce();
  });
});
