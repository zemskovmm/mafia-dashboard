/* global document, window, getComputedStyle, CSS, matchMedia */
// Standalone component optics checks. Run with node --test <this file>.
// This mounts the real component, not a second implementation of the lens.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";

import { dirname, join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, webkit } from "@playwright/test";
import { PNG } from "pngjs";

const themeDirectory = dirname(fileURLToPath(import.meta.url));
const repository = join(themeDirectory, "../../../../..");
const scratchRoot =
  process.env.LIQUID_CARD_GLASS_OUTPUT_ROOT ?? join(repository, ".AI/qa/liquid-card-glass");
await mkdir(scratchRoot, { recursive: true });
const outputRoot = await mkdtemp(join(scratchRoot, "liquid-card-glass-"));
const built = await build({
  stdin: {
    contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { LiquidCardGlass } from ${JSON.stringify(join(themeDirectory, "LiquidCardGlass.tsx"))};
      createRoot(document.getElementById("fixture")).render(
        <button className="player-seat" aria-label="Ada" onClick={() => window.cardClicks += 1}>
          <LiquidCardGlass /><span className="card-content">Ada</span>
        </button>
      );
      window.cardClicks = 0;
    `,
    loader: "tsx",
    sourcefile: "liquid-card-glass-fixture.tsx",
    resolveDir: repository,
  },
  bundle: true,
  jsx: "automatic",
  format: "iife",
  platform: "browser",
  outfile: join(outputRoot, "fixture.js"),
  write: false,
});
const javascript = built.outputFiles.find((file) => file.path.endsWith(".js"))?.text;
const stylesheet = built.outputFiles.find((file) => file.path.endsWith(".css"))?.text;
assert.ok(javascript && stylesheet, "The actual component JS and CSS must be bundled");
const bundleDigest = createHash("sha256").update(javascript).update(stylesheet).digest("hex");
const sources = await Promise.all(
  ["LiquidCardGlass.tsx", "LiquidCardGlass.css", "liquid-card-lens.ts"].map((file) =>
    readFile(join(themeDirectory, file)),
  ),
);
const sourceDigest = createHash("sha256").update(Buffer.concat(sources)).digest("hex");

const fixtureCss = `
  * { box-sizing:border-box }
  html, body { margin:0; width:640px; height:480px }
  body { background:repeating-linear-gradient(90deg,#e78a40 0 3px,#1e5a97 3px 7px) }
  #fixture { position:absolute; left:64px; top:64px }
  .player-seat { position:relative; width:124px; height:108px; border:1px solid transparent;
    border-radius:14px; background:transparent; isolation:isolate; color:#fff;
    transition:scale 280ms ease,opacity 280ms ease; }
  .player-seat > :not(.vgpu-player-lighting) { z-index:1 }
  .card-content { position:relative; font:600 20px/1 system-ui }
  .player-seat.is-voted { scale:.88; opacity:.55 }
  @media(prefers-reduced-motion:reduce) { .player-seat { transition:none } }
`;

const regionDifference = (firstBuffer, secondBuffer, region) => {
  const first = PNG.sync.read(firstBuffer);
  const second = PNG.sync.read(secondBuffer);
  assert.equal(first.width, second.width);
  assert.equal(first.height, second.height);
  let total = 0;
  let channels = 0;
  for (let y = region.top; y < region.bottom; y += 1) {
    for (let x = region.left; x < region.right; x += 1) {
      const index = (y * first.width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        total += Math.abs(first.data[index + channel] - second.data[index + channel]);
        channels += 1;
      }
    }
  }
  return total / channels;
};

for (const [engine, launch] of [
  ["chrome", () => chromium.launch({ channel: "chrome", headless: true })],
  ["webkit", () => webkit.launch({ headless: true })],
]) {
  test(`${engine}: actual backdrop edge optics, fallback, finite interaction and local geometry`, async () => {
    const browser = await launch();
    const page = await browser.newPage({
      viewport: { width: 640, height: 480 },
      deviceScaleFactor: 1,
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.setContent('<div id="fixture"></div>');
      await page.addStyleTag({ content: fixtureCss + stylesheet });
      await page.addScriptTag({ content: javascript });
      await page.waitForFunction(
        () => document.querySelector("filter")?.getAttribute("width") === "124",
      );
      const card = page.getByRole("button", { name: "Ada" });
      const initialOptics = await page
        .locator(".liquid-card-glass__backdrop")
        .evaluate((surface) => ({
          backdrop:
            getComputedStyle(surface).backdropFilter ||
            getComputedStyle(surface).webkitBackdropFilter,
          urlSyntaxSupported: CSS.supports("backdrop-filter", 'url("#probe") blur(0.6px)'),
        }));
      const size = await card.evaluate((host) => {
        const surface = host.querySelector(".liquid-card-glass");
        const rect = surface.getBoundingClientRect();
        const hostRect = host.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          left: rect.left - hostRect.left,
          top: rect.top - hostRect.top,
          pointerEvents: getComputedStyle(surface).pointerEvents,
          contentFilter: getComputedStyle(host.querySelector(".card-content")).filter,
        };
      });
      assert.deepEqual(size, {
        width: 124,
        height: 108,
        left: 0,
        top: 0,
        pointerEvents: "none",
        contentFilter: "none",
      });
      await page.addStyleTag({
        content:
          ".liquid-card-glass__rim,.liquid-card-glass__caustics,.card-content {visibility:hidden}",
      });
      const refracted = await card.screenshot();
      await page.locator("feDisplacementMap").evaluate((map) => map.setAttribute("scale", "0"));
      assert.equal(await page.locator("feDisplacementMap").getAttribute("scale"), "0");
      const neutral = await card.screenshot();
      const edgeMeanDifference = regionDifference(refracted, neutral, {
        left: 1,
        right: 11,
        top: 28,
        bottom: 80,
      });
      const centreMeanDifference = regionDifference(refracted, neutral, {
        left: 32,
        right: 92,
        top: 28,
        bottom: 80,
      });
      if (engine === "chrome") {
        assert.ok(
          edgeMeanDifference > 6,
          `Backdrop displacement must change real edge pixels (${edgeMeanDifference})`,
        );
        assert.ok(
          centreMeanDifference < 3,
          `The centre must remain optically stable (${centreMeanDifference})`,
        );
      } else if (edgeMeanDifference === 0) {
        assert.match(initialOptics.backdrop, /blur\(2px\)/);
        assert.doesNotMatch(initialOptics.backdrop, /url\(/);
      }
      await writeFile(join(outputRoot, `${engine}-refracted.png`), refracted);
      await writeFile(join(outputRoot, `${engine}-neutral.png`), neutral);

      // Force the CSS-only path, without removing or replacing the component.
      await page.locator(".liquid-card-glass").evaluate((surface) => {
        surface.setAttribute("data-liquid-card-lens", "fallback");
      });
      const fallbackStyle = await page
        .locator(".liquid-card-glass__backdrop")
        .evaluate((surface) => {
          const style = getComputedStyle(surface);
          return {
            backdrop: style.backdropFilter || style.webkitBackdropFilter,
            background: style.backgroundImage,
          };
        });
      assert.match(fallbackStyle.backdrop, /blur\(2px\)/);
      assert.notEqual(fallbackStyle.background, "none");
      const fallbackBefore = await card.screenshot();
      await page.evaluate(() => {
        document.body.style.backgroundImage =
          "repeating-linear-gradient(90deg,#21c366 0 3px,#641030 3px 7px)";
      });
      const fallbackAfter = await card.screenshot();
      const fallbackBackgroundDifference = regionDifference(fallbackBefore, fallbackAfter, {
        left: 32,
        right: 92,
        top: 28,
        bottom: 80,
      });
      assert.ok(
        fallbackBackgroundDifference > 10,
        "CSS fallback must sample the real external background",
      );
      await writeFile(join(outputRoot, `${engine}-fallback.png`), fallbackBefore);
      await page.evaluate(() => {
        document.body.style.backgroundImage = "";
      });
      await page.locator(".liquid-card-glass").evaluate((surface) => {
        surface.setAttribute("data-liquid-card-lens", "ready");
      });
      await page.locator("feDisplacementMap").evaluate((map) => map.setAttribute("scale", "18"));
      await page.addStyleTag({
        content:
          ".liquid-card-glass__rim,.liquid-card-glass__caustics,.card-content {visibility:visible}",
      });
      await page.mouse.move(0, 0);
      await card.click();
      assert.equal(await page.evaluate(() => window.cardClicks), 1);
      await page.waitForFunction(
        () => document.querySelector(".liquid-card-glass__light").getAnimations().length === 0,
      );
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      if (engine === "webkit") await page.keyboard.press("Alt+Tab");
      // Focus routing is asserted by the application's integrated matrix;
      // this optics fixture proves no decoration is a keyboard target.
      assert.equal(await page.locator(".liquid-card-glass [tabindex]").count(), 0);
      await card.evaluate((host) => host.classList.add("is-voted"));
      await page.waitForFunction(() => {
        const style = getComputedStyle(document.querySelector(".player-seat"));
        return style.scale === "0.88" && style.opacity === "0.55";
      });
      const normalVoteTransition = await card.evaluate((host) => ({
        transition: getComputedStyle(host).transitionDuration,
        filterWidth: host.querySelector("filter").getAttribute("width"),
      }));
      assert.deepEqual(normalVoteTransition, { transition: "0.28s, 0.28s", filterWidth: "124" });
      await card.evaluate((host) => host.classList.remove("is-voted"));
      await page.waitForFunction(() => {
        const scale = getComputedStyle(document.querySelector(".player-seat")).scale;
        return scale === "none" || scale === "1";
      });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await card.click();
      assert.equal(
        await page
          .locator(".liquid-card-glass__light")
          .evaluate((light) => light.getAnimations().length),
        0,
      );
      await card.evaluate((host) => host.classList.add("is-voted"));
      await page.waitForFunction(
        () => getComputedStyle(document.querySelector(".player-seat")).scale === "0.88",
      );
      const votedGeometry = await card.evaluate((host) => ({
        scale: getComputedStyle(host).scale,
        opacity: getComputedStyle(host).opacity,
        transition: getComputedStyle(host).transitionDuration,
        filterWidth: host.querySelector("filter").getAttribute("width"),
      }));
      assert.deepEqual(votedGeometry, {
        scale: "0.88",
        opacity: "0.55",
        transition: "0s",
        filterWidth: "124",
      });
      let reducedTransparency = "not emulated by this engine";
      if (engine === "chrome") {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Emulation.setEmulatedMedia", {
          features: [
            { name: "prefers-reduced-motion", value: "reduce" },
            { name: "prefers-reduced-transparency", value: "reduce" },
          ],
        });
        assert.equal(
          await page.evaluate(() => matchMedia("(prefers-reduced-transparency: reduce)").matches),
          true,
        );
        await page.waitForFunction(
          () =>
            document.querySelector(".liquid-card-glass").getAttribute("data-liquid-card-lens") ===
            "fallback",
        );
        reducedTransparency = await page
          .locator(".liquid-card-glass__backdrop")
          .evaluate((surface) => {
            const style = getComputedStyle(surface);
            return {
              background: style.backgroundColor,
              backdrop: style.backdropFilter,
              image: style.backgroundImage,
            };
          });
        assert.deepEqual(reducedTransparency, {
          background: "rgb(27, 37, 32)",
          backdrop: "none",
          image: "none",
        });
      }
      assert.deepEqual(errors, []);
      const receipt = {
        engine,
        version: browser.version(),
        sourceDigest,
        bundleDigest,
        initialOptics,
        edgeMeanDifference,
        centreMeanDifference,
        fallbackStyle,
        fallbackBackgroundDifference,
        normalVoteTransition,
        votedGeometry,
        reducedTransparency,
        source: "real component in isolated 124x108 card; integrated GameTable not covered",
        outputRoot,
      };
      await writeFile(join(outputRoot, `${engine}-receipt.json`), JSON.stringify(receipt, null, 2));
      process.stdout.write(`${JSON.stringify(receipt)}\n`);
    } finally {
      await browser.close();
    }
  });
}
