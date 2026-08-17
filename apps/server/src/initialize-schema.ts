import { readFile } from "node:fs/promises";
import type { Pool } from "pg";

const schemaUrl = new URL("./schema.sql", import.meta.url);

export const initializeSchema = async (pool: Pool): Promise<void> => {
  const schema = await readFile(schemaUrl, "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('mafia_dashboard_schema', 0))",
    );
    await client.query(schema);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};
