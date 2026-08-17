import { Pool } from "pg";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.DATABASE_URL });
const app = await buildApp({ pool, staticDir: config.STATIC_DIR });

const shutdown = async () => {
  await app.close();
  await pool.end();
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await app.listen({ host: config.HOST, port: config.PORT });
