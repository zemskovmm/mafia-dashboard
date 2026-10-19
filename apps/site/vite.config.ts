import { relative } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { hostingAppUrl } from "./src/site-settings.ts";

const root = fileURLToPath(new URL(".", import.meta.url));
const routes = ["", "games/2026-08-17/", "games/2026-09-06/"];

export default defineConfig(() => {
  let base = "/";
  let origin = "https://mafiamalaga.es";

  return {
    root,
    plugins: [
      {
        name: "public-site-metadata",
        configResolved(config) {
          base = config.base;
          if (
            !base.startsWith("/") ||
            !base.endsWith("/") ||
            /[<>\s&"'?#\\]/.test(base) ||
            new URL(base, origin).pathname !== base
          ) {
            throw new Error("The website base must be an absolute directory path.");
          }
          origin =
            process.env.SITE_ORIGIN ?? (base === "/" ? origin : "https://zemskovmm.github.io");
          const url = new URL(origin);
          if (url.protocol !== "https:" || url.origin !== origin) {
            throw new Error(
              "SITE_ORIGIN must be an HTTPS origin without a path or trailing slash.",
            );
          }
        },
        transformIndexHtml: {
          order: "pre",
          handler(html, context) {
            const route = relative(root, context.filename)
              .replaceAll("\\", "/")
              .replace(/index\.html$/, "");
            if (!routes.includes(route)) throw new Error(`Unknown static entry: ${route}`);
            const name = route === "" ? "home" : `game-${route.split("/")[1]}`;
            const content = readFileSync(
              new URL(`src/content/${name}.html`, import.meta.url),
              "utf8",
            );
            const footer = readFileSync(
              new URL("src/content/footer.html", import.meta.url),
              "utf8",
            );
            return {
              html: html
                .replace("<!-- page-content -->", content)
                .replace("<!-- site-footer -->", footer)
                .replaceAll("%APP_URL%", hostingAppUrl)
                .replaceAll("%HOME_URL%", base),
              tags: [
                { tag: "link", attrs: { rel: "canonical", href: `${origin}${base}${route}` } },
                { tag: "meta", attrs: { property: "og:url", content: `${origin}${base}${route}` } },
                {
                  tag: "meta",
                  attrs: {
                    property: "og:image",
                    content: `${origin}${base}assets/roles-desktop.png`,
                  },
                },
              ],
            };
          },
        },
        generateBundle() {
          this.emitFile({
            type: "asset",
            fileName: "sitemap.xml",
            source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${routes.map((route) => `  <url><loc>${origin}${base}${route}</loc></url>`).join("\n")}\n</urlset>\n`,
          });
          this.emitFile({
            type: "asset",
            fileName: "robots.txt",
            source: `User-agent: *\nAllow: /\nSitemap: ${origin}${base}sitemap.xml\n`,
          });
          this.emitFile({ type: "asset", fileName: ".nojekyll", source: "" });
        },
      },
    ],
    build: {
      rolldownOptions: {
        input: routes.map((route) => fileURLToPath(new URL(`${route}index.html`, import.meta.url))),
      },
    },
  };
});
