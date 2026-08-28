import { describe, expect, it, vi } from "vitest";
import { createShutdown, registerShutdownSignals } from "./server-lifecycle.js";

describe("createShutdown", () => {
  it("closes Fastify before PostgreSQL", async () => {
    const order: string[] = [];
    const shutdown = createShutdown(
      { close: async () => void order.push("app") },
      { end: async () => void order.push("pool") },
    );

    await shutdown();

    expect(order).toEqual(["app", "pool"]);
  });

  it("shares one shutdown across repeated signals", async () => {
    const app = { close: vi.fn().mockResolvedValue(undefined) };
    const pool = { end: vi.fn().mockResolvedValue(undefined) };
    const shutdown = createShutdown(app, pool);

    await Promise.all([shutdown(), shutdown()]);

    expect(app.close).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("closes PostgreSQL and preserves a Fastify close failure", async () => {
    const app = { close: vi.fn().mockRejectedValue(new Error("app close failed")) };
    const pool = { end: vi.fn().mockResolvedValue(undefined) };
    const shutdown = createShutdown(app, pool);

    await expect(shutdown()).rejects.toThrow("app close failed");
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("routes repeated process signals through the same shutdown", async () => {
    const listeners = new Map<string, () => void>();
    const registrar = {
      on: vi.fn((signal: string, listener: () => void) => void listeners.set(signal, listener)),
    };
    const app = { close: vi.fn().mockResolvedValue(undefined) };
    const pool = { end: vi.fn().mockResolvedValue(undefined) };
    const shutdown = createShutdown(app, pool);

    registerShutdownSignals(registrar, () => void shutdown());
    listeners.get("SIGTERM")?.();
    listeners.get("SIGTERM")?.();
    await shutdown();

    expect(registrar.on).toHaveBeenCalledTimes(2);
    expect(app.close).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });
});
