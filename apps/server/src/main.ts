import { Pool } from "pg";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { GoogleAuthService } from "./google-auth.js";
import { YouTubeOAuthService } from "./youtube-oauth.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.DATABASE_URL });
const youtubeOAuth =
  config.youtubeOAuth === undefined
    ? undefined
    : new YouTubeOAuthService(pool, config.youtubeOAuth);
const googleAuth =
  config.googleAuth === undefined ? undefined : new GoogleAuthService(pool, config.googleAuth);
const app = await buildApp({
  pool,
  staticDir: config.STATIC_DIR,
  googleAuth,
  youtubeOAuth,
  publicAppUrl: config.PUBLIC_APP_URL,
});

const shutdown = async () => {
  await app.close();
  await pool.end();
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await app.listen({ host: config.HOST, port: config.PORT });
