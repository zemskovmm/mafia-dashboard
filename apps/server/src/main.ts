import { Pool } from "pg";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { GoogleAuthService } from "./google-auth.js";
import { createShutdown, registerShutdownSignals } from "./server-lifecycle.js";
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
  trustedProxyHops: config.TRUST_PROXY_HOPS,
});

const shutdown = createShutdown(app, pool);
let shutdownFailureReported = false;
const handleSignal = () => {
  void shutdown().catch((error: unknown) => {
    if (shutdownFailureReported) return;
    shutdownFailureReported = true;
    console.error("Graceful shutdown failed", error);
    process.exitCode = 1;
  });
};

registerShutdownSignals(process, handleSignal);

await app.listen({ host: config.HOST, port: config.PORT });
