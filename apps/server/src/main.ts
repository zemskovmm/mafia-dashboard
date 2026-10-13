import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { buildApp } from "./app.js";
import { composeAppVersion } from "./app-version.js";
import { loadConfig } from "./config.js";
import { GoogleAuthService } from "./google-auth.js";
import { createShutdown, registerShutdownSignals } from "./server-lifecycle.js";
import { YouTubeOAuthService } from "./youtube-oauth.js";
import { createAzureStores } from "./azure-stores.js";

const config = loadConfig();
const version = composeAppVersion(
  JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version,
  config.APP_BUILD_INDEX,
);
const azure =
  config.STORAGE_PROVIDER === "azure" ? createAzureStores(config.azureStorage!) : undefined;
const pool = azure === undefined ? new Pool({ connectionString: config.DATABASE_URL }) : undefined;
if (azure !== undefined) {
  if (config.AZURE_STORAGE_INITIALIZE) await azure.initialize();
  else await azure.ready();
}
const youtubeOAuth =
  config.youtubeOAuth === undefined
    ? undefined
    : new YouTubeOAuthService(azure?.music ?? pool!, config.youtubeOAuth);
const googleAuth =
  config.googleAuth === undefined
    ? undefined
    : new GoogleAuthService(azure?.auth ?? pool!, config.googleAuth);
const app = await buildApp({
  ...(azure === undefined ? { pool: pool! } : { stores: azure.stores }),
  staticDir: config.STATIC_DIR,
  googleAuth,
  youtubeOAuth,
  publicAppUrl: config.PUBLIC_APP_URL,
  releaseIdentity: { version, commit: config.APP_COMMIT },
  trustedProxyHops: config.TRUST_PROXY_HOPS,
});

const shutdown = createShutdown(app, azure ?? pool!);
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
