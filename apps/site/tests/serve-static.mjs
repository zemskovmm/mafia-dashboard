import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { log } from "node:console";
import { build } from "vite";

// Test-only plain static host: no SPA fallback, proxy, account or API.
const port = Number(process.argv[2]);
const base = process.argv[3];
if (!["/", "/mafia-dashboard/"].includes(base) || !Number.isInteger(port)) {
  throw new Error("Expected an explicit test port and root/project base");
}
const root = fileURLToPath(new URL("../", import.meta.url));
const output = fileURLToPath(
  new URL(`../../../.AI/public-website-browser/${port}/`, import.meta.url),
);
await build({ root, base, logLevel: "silent", build: { outDir: output, emptyOutDir: true } });
const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css"],
  [".js", "text/javascript"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".txt", "text/plain; charset=utf-8"],
  [".xml", "application/xml"],
]);
const server = createServer(async (request, response) => {
  try {
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405).end();
      return;
    }
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (base !== "/" && url.pathname === base.slice(0, -1)) {
      response.writeHead(308, { Location: base + url.search }).end();
      return;
    }
    if (!url.pathname.startsWith(base)) throw new Error("Outside site base");
    let path = resolve(output, decodeURIComponent(url.pathname.slice(base.length)));
    if (path !== resolve(output) && !path.startsWith(resolve(output) + sep))
      throw new Error("Outside build");
    if ((await stat(path)).isDirectory()) {
      if (!url.pathname.endsWith("/")) {
        response.writeHead(308, { Location: url.pathname + "/" + url.search }).end();
        return;
      }
      path = resolve(path, "index.html");
    }
    const bytes = await readFile(path);
    response.writeHead(200, {
      "Content-Type": mime.get(extname(path)) ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : bytes);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
});
server.listen(port, "127.0.0.1", () => log(`Static website: http://127.0.0.1:${port}${base}`));
process.on("SIGTERM", () => server.close());
process.on("SIGINT", () => server.close());
