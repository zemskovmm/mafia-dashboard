import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";

describe("buildApp startup", () => {
  it("does not run schema migrations", async () => {
    const connect = vi.fn(() => {
      throw new Error("unexpected schema migration");
    });
    const pool = { connect } as unknown as Pool;

    const app = await buildApp({ pool, authenticateRequest: async () => null });
    await app.ready();
    await app.close();

    expect(connect).not.toHaveBeenCalled();
  });
});
