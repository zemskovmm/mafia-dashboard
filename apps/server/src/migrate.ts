import { Pool } from "pg";
import { loadConfig } from "./config.js";
import { runMigration } from "./run-migration.js";

const config = loadConfig();
await runMigration(new Pool({ connectionString: config.DATABASE_URL }));
