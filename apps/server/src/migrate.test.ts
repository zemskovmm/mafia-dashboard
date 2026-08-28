import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { runMigration } from "./run-migration.js";

describe("runMigration", () => {
  it("closes the pool after a successful migration", async () => {
    const pool = { end: vi.fn().mockResolvedValue(undefined) } as unknown as Pool;
    const migrate = vi.fn().mockResolvedValue(undefined);

    await runMigration(pool, migrate);

    expect(migrate).toHaveBeenCalledOnce();
    expect(migrate).toHaveBeenCalledWith(pool);
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("closes the pool and preserves a migration failure", async () => {
    const pool = { end: vi.fn().mockResolvedValue(undefined) } as unknown as Pool;
    const migrate = vi.fn().mockRejectedValue(new Error("migration failed"));

    await expect(runMigration(pool, migrate)).rejects.toThrow("migration failed");
    expect(pool.end).toHaveBeenCalledOnce();
  });
});
