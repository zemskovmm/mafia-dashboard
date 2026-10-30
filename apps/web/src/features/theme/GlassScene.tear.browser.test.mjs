/* global document, window, getComputedStyle */
// Focused real-material contract: node --test <this file>.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium, webkit } from "@playwright/test";
import { PNG } from "pngjs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const directory = dirname(fileURLToPath(import.meta.url));
const repository = join(directory, "../../../../..");
const output = join(repository, ".AI/qa/glass-tear");
await mkdir(output, { recursive: true });
const evidence = await mkdtemp(join(output, "material-"));
const bundle = await build({
  stdin: {
    contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { createGlassRenderer } from ${JSON.stringify(join(directory, "glass-renderer.ts"))};
      import { LiquidCardGlass } from ${JSON.stringify(join(directory, "LiquidCardGlass.tsx"))};
      import { FancyFeaturesContext } from ${JSON.stringify(join(directory, "../effects/FancyFeaturesContext.js"))};
      import { PLAYER_TEAR_SEAM_POINTS, PLAYER_TEAR_LEFT_CLIP, PLAYER_TEAR_RIGHT_CLIP } from ${JSON.stringify(join(directory, "../effects/player-tear-geometry.ts"))};
      window.seam = PLAYER_TEAR_SEAM_POINTS;
      window.clips = [PLAYER_TEAR_LEFT_CLIP, PLAYER_TEAR_RIGHT_CLIP];
      window.createRenderer = createGlassRenderer;
      createRoot(document.getElementById("fixture")).render(
        <FancyFeaturesContext.Provider value={false}>
          <button data-player-glass="table" aria-label="Ada"><LiquidCardGlass /><span>Ada</span></button>
        </FancyFeaturesContext.Provider>
      );
    `,
    loader: "tsx",
    resolveDir: repository,
  },
  bundle: true,
  jsx: "automatic",
  platform: "browser",
  format: "iife",
  outfile: join(evidence, "fixture.js"),
  write: false,
});
const javascript = bundle.outputFiles.find((file) => file.path.endsWith(".js")).text;
const css = bundle.outputFiles.find((file) => file.path.endsWith(".css")).text;

for (const [engine, launcher] of [
  ["chromium", () => chromium.launch({ channel: "chrome", headless: true })],
  ["webkit", () => webkit.launch({ headless: true })],
]) {
  test(`${engine}: jagged fragment material has a real gap, bounded geometry and no uniform leakage`, async () => {
    const browser = await launcher();
    try {
      const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setContent('<!doctype html><div id="fixture"></div><canvas id="gpu"></canvas>');
      await page.addStyleTag({
        content:
          `
        * { box-sizing:border-box } html,body { margin:0; background:#304050 }
        button { position:absolute; left:100px; top:100px; width:200px; height:280px;
          border:0; border-radius:14px; background:transparent; color:white;
          --liquid-card-host-border-width:0px; --glass-tint:.3 }
        button > span:not(.liquid-card-glass) { position:relative; z-index:1 }
        canvas { position:absolute; inset:0; width:640px; height:480px; pointer-events:none }
      ` + css,
      });
      await page.addScriptTag({ content: javascript });
      await page.waitForSelector(".liquid-card-glass");
      const gpu = await page.evaluate(() => {
        const canvas = document.getElementById("gpu");
        const renderer = window.createRenderer(canvas);
        const gl = canvas.getContext("webgl");
        const surface = {
          rect: [100, 100, 200, 280],
          clip: [100, 100, 200, 280],
          radius: 14,
          tint: [0.7, 0.4, 0.2],
          opacity: 0.45,
          tintAmount: 0.3,
        };
        const scene = {
          width: 640,
          height: 480,
          table: [0, 0, 0, 0],
          panel: [0, 0, 0, 0],
          nomination: [0, 0, 0, 0],
          workspace: [0, 0, 0, 0],
          workspaceRadius: 0,
          background: [0.18, 0.25, 0.31],
          top: [0.18, 0.25, 0.31],
          theme: [0.7, 0.5, 0.3],
          felt: [0.1, 0.2, 0.1],
          feltDark: [0.1, 0.1, 0.1],
          night: false,
          gold: 0,
          strength: 14,
          matte: true,
          profile: "edge",
          frosting: 2,
          tintAmount: 0.3,
          edgeHighlights: 1,
          caustics: 1,
          surfaces: [],
        };
        const read = (surfaces) => {
          renderer.draw({ ...scene, surfaces });
          const pixels = new Uint8Array(canvas.width * canvas.height * 4);
          gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          return pixels;
        };
        const empty = read([]);
        const intact = read([surface]);
        const torn = read([{ ...surface, tear: { progress: 1, gap: 12 } }]);
        const restored = read([surface]);
        const following = read([{ ...surface, tear: { progress: 1, gap: 12 } }, surface]);
        const sample = (pixels, x, y) => {
          const index = ((canvas.height - 1 - y) * canvas.width + x) * 4;
          return [...pixels.slice(index, index + 3)];
        };
        const delta = (a, b) => Math.max(...a.map((value, index) => Math.abs(value - b[index])));
        const differences = { gap: 0, left: 0, right: 0, restored: 0, following: 0, outside: 0 };
        const seamAt = (y) => {
          const next = window.seam.findIndex((point) => point[1] >= y);
          const b = window.seam[next],
            a = window.seam[Math.max(0, next - 1)];
          return a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]);
        };
        for (let y = 110; y < 370; y++) {
          const x = 100 + seamAt((y - 100) / 280) * 200;
          const left = 100 + (x - 100) * 0.88,
            right = 124 + (x - 100) * 0.88;
          for (let px = Math.ceil(left + 2); px < right - 2; px++)
            differences.gap = Math.max(
              differences.gap,
              delta(sample(torn, px, y), sample(empty, px, y)),
            );
          differences.left = Math.max(
            differences.left,
            delta(sample(torn, 130, y), sample(empty, 130, y)),
          );
          differences.right = Math.max(
            differences.right,
            delta(sample(torn, 270, y), sample(empty, 270, y)),
          );
        }
        for (let y = 0; y < 480; y++)
          for (let x = 0; x < 640; x++) {
            differences.restored = Math.max(
              differences.restored,
              delta(sample(intact, x, y), sample(restored, x, y)),
            );
            if (x < 100 || x >= 300 || y < 100 || y >= 380)
              differences.outside = Math.max(
                differences.outside,
                delta(sample(torn, x, y), sample(empty, x, y)),
              );
            // After a torn draw, an ordinary surface must remain intact in the gap.
            if (x === 200 && y > 120 && y < 360)
              differences.following = Math.max(
                differences.following,
                delta(sample(following, x, y), sample(intact, x, y)),
              );
          }
        renderer.dispose(false);
        return { differences, clips: window.clips, seam: window.seam };
      });
      assert.equal(gpu.differences.gap, 0, "gap must be exactly the unpainted scene");
      assert.ok(
        gpu.differences.left > 5 && gpu.differences.right > 5,
        "both faded fragments must remain painted",
      );
      assert.equal(gpu.differences.restored, 0, "tear uniforms reset between frames");
      assert.equal(gpu.differences.following, 0, "tear uniforms reset between surfaces");
      assert.equal(gpu.differences.outside, 0, "fragments stay inside their semantic host");
      await page.locator("#gpu").evaluate((canvas) => canvas.remove());
      const card = page.getByRole("button", { name: "Ada" });
      await card.evaluate((element) => {
        element.style.setProperty("--player-exit-tear", "1");
        element.style.setProperty("--player-exit-gap", "12");
        element.style.setProperty("--player-exit-fade", "0.45");
      });
      const fallback = await page.screenshot({ path: join(evidence, `${engine}-fallback.png`) });
      const contract = await card.evaluate((element) => ({
        materials: element.querySelectorAll(".liquid-card-glass").length,
        first: element.firstElementChild.classList.contains("liquid-card-glass"),
        opacity: getComputedStyle(element.querySelector(".liquid-card-glass__backdrop")).opacity,
        contentOpacity: getComputedStyle(
          element.querySelector(":scope > span:not(.liquid-card-glass)"),
        ).opacity,
        resources: element.querySelectorAll("filter,canvas").length,
      }));
      assert.deepEqual(contract, {
        materials: 1,
        first: true,
        opacity: "0.45",
        contentOpacity: "1",
        resources: 0,
      });
      await page
        .locator(".liquid-card-glass")
        .evaluate((surface) => surface.style.setProperty("visibility", "hidden", "important"));
      const hidden = await page.screenshot();
      const a = PNG.sync.read(fallback),
        b = PNG.sync.read(hidden);
      const pixelDelta = (x, y) => {
        const i = (y * a.width + x) * 4;
        return Math.max(...[0, 1, 2].map((c) => Math.abs(a.data[i + c] - b.data[i + c])));
      };
      let gapDelta = 0,
        leftDelta = 0,
        rightDelta = 0;
      for (let y = 112; y < 368; y++) {
        const normalized = (y - 100) / 280;
        const n = gpu.seam.findIndex((p) => p[1] >= normalized);
        const p = gpu.seam[n - 1],
          q = gpu.seam[n];
        const seam = p[0] + ((q[0] - p[0]) * (normalized - p[1])) / (q[1] - p[1]);
        for (let x = Math.ceil(100 + seam * 176 + 2); x < 124 + seam * 176 - 2; x++)
          gapDelta = Math.max(gapDelta, pixelDelta(x, y));
        leftDelta = Math.max(leftDelta, pixelDelta(130, y));
        rightDelta = Math.max(rightDelta, pixelDelta(270, y));
      }
      assert.equal(gapDelta, 0, "fallback must not leave intact backing in the gap");
      assert.ok(leftDelta > 2 && rightDelta > 2, "both fallback fragments survive at 45%");
      assert.deepEqual(errors, []);
      await writeFile(
        join(evidence, `${engine}.json`),
        JSON.stringify({ gpu, contract, gapDelta, leftDelta, rightDelta }, null, 2),
      );
    } finally {
      await browser.close();
    }
  });
}
