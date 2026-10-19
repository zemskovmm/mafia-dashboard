import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";
import { JSDOM } from "jsdom";
import { build } from "vite";

const siteRoot = new URL("../", import.meta.url);
const source = JSON.parse(
  readFileSync(new URL("fixtures/source-content.json", import.meta.url), "utf8"),
);
const assets = JSON.parse(readFileSync(new URL("asset-sources.json", siteRoot), "utf8"));
const pages = [
  ["index.html", "La Verdad"],
  ["games/2026-08-17/index.html", "Последняя игра 17 августа 2026 года"],
  ["games/2026-09-06/index.html", "Бесшерифская игра 6 сентября 2026 года"],
];

test("all published pages have Russian HTML entry points at their static directory paths", () => {
  for (const [path] of pages) {
    const file = new URL(path, siteRoot);
    assert.ok(existsSync(file), `Missing published page: ${fileURLToPath(file)}`);
    const { document } = new JSDOM(readFileSync(file, "utf8")).window;
    assert.equal(document.documentElement.lang, "ru");
    assert.ok(document.title.includes("La Verdad"));
    assert.ok(document.querySelector("main"), "Content must not require client rendering");
  }
});

test("static builds preserve all routes and public metadata at root and a repository prefix", async () => {
  for (const base of ["/", "/mafia-dashboard/"]) {
    const outDir = fileURLToPath(
      new URL(
        `../../../.AI/public-website-tests/${base === "/" ? "root" : "project"}/`,
        import.meta.url,
      ),
    );
    await build({
      root: fileURLToPath(siteRoot),
      base,
      logLevel: "silent",
      build: { outDir, emptyOutDir: true },
    });
    for (const [path, heading] of pages) {
      assert.ok(existsSync(`${outDir}/${path}`), `Build omitted ${path} at base ${base}`);
      const { document } = new JSDOM(readFileSync(`${outDir}/${path}`, "utf8")).window;
      const origin = base === "/" ? "https://mafiamalaga.es" : "https://zemskovmm.github.io";
      const canonical = `${origin}${base}${path.replace(/index\.html$/, "")}`;
      assert.equal(
        document.querySelector('link[rel="canonical"]')?.getAttribute("href"),
        canonical,
      );
      assert.doesNotMatch(
        document.documentElement.outerHTML,
        /tildacdn|tilda-scripts|fonts\.googleapis|googletagmanager/,
      );
      for (const element of document.querySelectorAll("[src], [srcset], link[href], a[href]")) {
        const href =
          element.getAttribute("src") ??
          element.getAttribute("srcset") ??
          element.getAttribute("href");
        if (href?.startsWith("/")) {
          assert.ok(href.startsWith(base), `Resource escaped the site base: ${href}`);
          assert.ok(
            existsSync(`${outDir}/${href.slice(base.length)}`),
            `Missing local target: ${href}`,
          );
        }
      }
      assert.equal(document.querySelectorAll("h1").length, 1);
      assert.ok(document.querySelector("h1").textContent.includes(heading));
      const route = path.replace(/index\.html$/, "");
      for (const field of source.fields.filter((item) => item.routes.includes(route))) {
        const copies = document.querySelectorAll(`[data-copy="${field.key}"]`);
        assert.equal(copies.length, 1, `Missing or duplicated source field ${field.key}`);
        const element = copies[0];
        const textHash = createHash("sha256")
          .update(element.textContent.replace(/\s+/gu, ""))
          .digest("hex");
        assert.equal(textHash, field.sha256, `Source prose changed in ${field.key}`);
        assert.equal(element.querySelectorAll("li").length, field.listItems);
        assert.deepEqual(
          [...element.querySelectorAll("a")].map((a) => a.getAttribute("href")),
          field.links.map((href) =>
            href === "#popup:videoplayer" ? "https://www.youtube.com/watch?v=hLQM89v0XZg" : href,
          ),
        );
      }
    }
    const sitemap = readFileSync(`${outDir}/sitemap.xml`, "utf8");
    assert.equal((sitemap.match(/<loc>/g) ?? []).length, pages.length);
    assert.ok(readFileSync(`${outDir}/robots.txt`, "utf8").includes("sitemap.xml"));
    for (const asset of assets) {
      assert.equal(
        createHash("sha256")
          .update(readFileSync(`${outDir}/${asset.file}`))
          .digest("hex"),
        asset.sha256,
      );
      assert.doesNotMatch(asset.file, /Doloman|\.AI|\.env|node_modules/);
    }
  }
});
