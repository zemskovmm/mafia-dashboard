import type { Pool } from "pg";
import { initializeSchema } from "./initialize-schema.js";

type Migration = (pool: Pool) => Promise<void>;

export const runMigration = async (
  pool: Pool,
  migrate: Migration = initializeSchema,
): Promise<void> => {
  let failed = false;
  let failure: unknown;
  try {
    await migrate(pool);
  } catch (error) {
    failed = true;
    failure = error;
  }

  try {
    await pool.end();
  } catch (error) {
    if (!failed) throw error;
  }

  if (failed) throw failure;
};
