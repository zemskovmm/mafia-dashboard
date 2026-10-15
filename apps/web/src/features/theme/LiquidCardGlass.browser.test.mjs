/* global document, window, getComputedStyle, CSS, matchMedia, requestAnimationFrame */
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
      import React, { useState } from "react";
      import { createRoot } from "react-dom/client";
      import { LiquidCardGlass } from ${JSON.stringify(join(themeDirectory, "LiquidCardGlass.tsx"))};
      import { GlassScene } from ${JSON.stringify(join(themeDirectory, "GlassScene.tsx"))};
      import { SharedGlassContext } from ${JSON.stringify(join(themeDirectory, "SharedGlassContext.ts"))};
      import { PlayerCardAppearanceContext } from ${JSON.stringify(join(themeDirectory, "PlayerCardAppearanceContext.ts"))};
      import { DEFAULT_GLASS_SETTINGS } from ${JSON.stringify(join(themeDirectory, "glass-preferences.ts"))};
      import { createGlassRenderer } from ${JSON.stringify(join(themeDirectory, "glass-renderer.ts"))};
      import { PlayersScreen } from ${JSON.stringify(join(themeDirectory, "../players/PlayersScreen.tsx"))};
      window.createSharedRenderer = createGlassRenderer;
      const root = createRoot(document.getElementById("fixture"));
      window.renderAppearance = (appearance = {}) => root.render(
        <PlayerCardAppearanceContext.Provider value={{...DEFAULT_GLASS_SETTINGS,...appearance}}>
        <button className="player-seat" aria-label="Ada" onClick={() => window.cardClicks += 1}>
          <LiquidCardGlass /><span className="card-content">Ada</span>
        </button>
        </PlayerCardAppearanceContext.Provider>
      );
      window.renderAppearance();
      window.cardClicks = 0;
      const ProfileFixture = ({ enhanced = false, tint = 13, shade = "is-light-background" }) => {
        const [status, setStatus] = useState("off");
        const settings = {...DEFAULT_GLASS_SETTINGS, enabled:enhanced, tint};
        return <div className={"app-shell " + shade} data-glass-settings="local" data-glass-status={status}
          style={{"--glass-tint":tint/100,"--glass-gold-light":.25,"--glass-edge-highlights":1,"--glass-caustics":1}}>
          {enhanced ? <GlassScene settings={settings} onStatus={setStatus} /> : null}
          <SharedGlassContext.Provider value={status === "ready"}>
          <PlayersScreen players={[{
            id:"00000000-0000-4000-8000-000000000001", nickname:"Alpha", consent:false,
            clubAccess:"none", managerLocked:false, firstName:null, lastName:null, email:null,
            consentAt:null, lastPlayedAt:null, createdAt:"2026-10-15T00:00:00.000Z", updatedAt:"2026-10-15T00:00:00.000Z",
            statistics:Object.fromEntries(["hostedGames","gamesPlayed","wins","losses","redGames","redWins","blackGames","blackWins","sheriffGames","citizenGames","mafiaGames","donGames","totalFouls","eliminations","redCards","bestMoves","bestMoveMafiaHits"].map(key=>[key,0]))
          }]} onCreate={async()=>{}} onUpdate={async(id,input)=>{window.profileSaved={id,input};}} />
          </SharedGlassContext.Provider>
        </div>;
      };
      window.renderProfile = (options = {}) => root.render(<ProfileFixture {...options} />);
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
  [
    "LiquidCardGlass.tsx",
    "LiquidCardGlass.css",
    "GlassScene.tsx",
    "GlassScene.css",
    "PlayerCardAppearanceContext.ts",
    "glass-preferences.ts",
    "liquid-card-lens.ts",
    "glass-renderer.ts",
    "../players/PlayersScreen.tsx",
    "../../styles/app.css",
  ].map((file) => readFile(join(themeDirectory, file))),
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
      await page.setContent('<!doctype html><div id="fixture"></div>');
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

      // The real local material adds nomination over the existing base tint;
      // changing this state must not rebuild the lens or change host geometry.
      await card.evaluate((el) => el.classList.add("is-nominated"));
      const appearance = async (
        nominationTint,
        nominationColor = "#e6bc7e",
        nominationTreatment = "hybrid",
      ) => {
        await page.evaluate((value) => window.renderAppearance(value), {
          nominationTint,
          nominationColor,
          nominationTreatment,
        });
        await page.waitForFunction(
          (amount) =>
            document
              .querySelector(".liquid-card-glass")
              .style.getPropertyValue("--card-nomination-tint") === String(amount),
          nominationTreatment === "icons" ? 0 : nominationTint / 100,
        );
        await page.evaluate(
          () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
        );
        return card.screenshot();
      };
      const zeroNomination = await appearance(0);
      const goldNomination = await appearance(50);
      const blueNomination = await appearance(50, "#88c7e3", "tint");
      const region = { left: 32, right: 92, top: 28, bottom: 80 };
      const nominationStrengthDifference = regionDifference(zeroNomination, goldNomination, region);
      const nominationColorDifference = regionDifference(goldNomination, blueNomination, region);
      assert.ok(
        nominationStrengthDifference > 8,
        `Nomination strength must alter actual local pixels (${nominationStrengthDifference})`,
      );
      assert.ok(
        nominationColorDifference > 8,
        `Nomination color must alter actual local pixels (${nominationColorDifference})`,
      );
      assert.equal(
        regionDifference(zeroNomination, await appearance(50, "#88c7e3", "icons"), region),
        0,
      );
      await appearance(50);
      for (const priority of [
        "is-current",
        "is-voting-highlight",
        "is-sheriff-highlight",
        "is-mafia-shooter",
        "is-night-check-highlight",
        "is-goodbye-highlight",
      ]) {
        await card.evaluate((el, priority) => el.classList.add(priority), priority);
        assert.equal(
          regionDifference(zeroNomination, await card.screenshot(), region),
          0,
          `${priority} must retain priority over nomination material`,
        );
        await card.evaluate((el, priority) => el.classList.remove(priority), priority);
      }
      await page.evaluate(() => document.body.classList.add("is-table-cycle-night"));
      assert.equal(
        regionDifference(zeroNomination, await card.screenshot(), region),
        0,
        "Night material must not acquire nomination tint",
      );
      await page.evaluate(() => document.body.classList.remove("is-table-cycle-night"));
      assert.deepEqual(await card.boundingBox(), { x: 64, y: 64, width: 124, height: 108 });
      await writeFile(join(outputRoot, `${engine}-nomination-gold.png`), goldNomination);
      await writeFile(join(outputRoot, `${engine}-nomination-blue.png`), blueNomination);
      await card.evaluate((el) => el.classList.remove("is-nominated"));
      await page.evaluate(() => window.renderAppearance());

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
            background: style.backgroundColor,
          };
        });
      assert.match(fallbackStyle.backdrop, /blur\(2px\)/);
      assert.equal(fallbackStyle.background, "rgba(20, 26, 23, 0.13)");
      const fallbackBefore = await card.screenshot();
      await page.evaluate(() => document.body.style.setProperty("--glass-matte-blur", "0px"));
      const clearFallback = await card.screenshot();
      const fallbackMatteDifference = regionDifference(fallbackBefore, clearFallback, {
        left: 32,
        right: 92,
        top: 28,
        bottom: 80,
      });
      await writeFile(join(outputRoot, `${engine}-fallback-matte.png`), fallbackBefore);
      await writeFile(join(outputRoot, `${engine}-fallback-clear.png`), clearFallback);
      const clearFilter = await page
        .locator(".liquid-card-glass__backdrop")
        .evaluate(
          (el) => getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter,
        );
      assert.match(clearFilter, /blur\(0px\)/);
      // Cocoa WebKit snapshots can omit composited backdrop filters (upstream
      // WebKit 242215 / Playwright 21620). Retain the measured result, but do
      // not call accepted CSS or a near-zero snapshot difference visual proof.
      if (engine === "chrome")
        assert.ok(fallbackMatteDifference > 6, "Matte must visibly soften the fallback background");
      await page.evaluate(() => document.body.style.removeProperty("--glass-matte-blur"));
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
      const opticalMatte = await card.screenshot();
      await page.evaluate(() => {
        document.body.style.setProperty("--glass-matte-blur", "0px");
        document.body.style.setProperty("--glass-matte-lens-blur", "0px");
      });
      const clearOptical = await card.screenshot();
      const opticalMatteDifference = regionDifference(opticalMatte, clearOptical, {
        left: 32,
        right: 92,
        top: 28,
        bottom: 80,
      });
      if (engine === "chrome")
        assert.ok(opticalMatteDifference > 1, "Matte changes softness without removing the lens");
      assert.equal(await page.locator("feDisplacementMap").getAttribute("scale"), "18");
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
      } else {
        // WebKit cannot emulate this native preference here. Exercise the real
        // stylesheet's opaque branch explicitly, without claiming device proof.
        const opaqueCss = await page.evaluate(() =>
          [...document.styleSheets]
            .flatMap((sheet) =>
              [...sheet.cssRules]
                .filter((rule) => rule.conditionText?.includes("prefers-reduced-transparency"))
                .flatMap((rule) => [...rule.cssRules].map((child) => child.cssText)),
            )
            .join("\n"),
        );
        assert.ok(opaqueCss.length > 0);
        await page.addStyleTag({ content: opaqueCss });
        const opaque = await page.locator(".liquid-card-glass__backdrop").evaluate((el) => ({
          background: getComputedStyle(el).backgroundColor,
          backdrop:
            getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter,
        }));
        assert.deepEqual(opaque, { background: "rgb(27, 37, 32)", backdrop: "none" });
        reducedTransparency = "actual opaque CSS branch forced; native preference not emulated";
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
        nominationStrengthDifference,
        nominationColorDifference,
        fallbackStyle,
        fallbackBackgroundDifference,
        fallbackMatteDifference,
        opticalMatteDifference,
        mattePixelVerification:
          fallbackMatteDifference > 6 && opticalMatteDifference > 1
            ? "verified"
            : "not qualified: WebKit snapshot omits backdrop blur; native/device visual check required",
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
  test(`${engine}: shared edge profile preserves centres and independent material endpoints`, async () => {
    const browser = await launch();
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
    try {
      await page.setContent('<!doctype html><div id="fixture"></div>');
      await page.addStyleTag({ content: fixtureCss + stylesheet });
      await page.addScriptTag({ content: javascript });
      const actual = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        document.body.append(canvas);
        const renderer = window.createSharedRenderer(canvas);
        const gl = canvas.getContext("webgl");
        const surface = {
          rect: [64.25, 64.5, 124, 108],
          clip: [64.25, 64.5, 124, 108],
          radius: 14,
          tint: [0.08, 0.1, 0.09],
          opacity: 1,
        };
        const scene = {
          width: 640,
          height: 480,
          table: [0, 0, 0, 0],
          panel: [0, 0, 0, 0],
          nomination: [0, 0, 0, 0],
          workspace: [0, 0, 0, 0],
          workspaceRadius: 20,
          noir: false,
          noirContrast: 1,
          background: [0.05, 0.05, 0.05],
          top: [0.07, 0.06, 0.04],
          theme: [0.76, 0.6, 0.34],
          felt: [0.09, 0.23, 0.18],
          feltDark: [0.04, 0.14, 0.11],
          night: false,
          gold: 0.25,
          strength: 0,
          matte: false,
          frosting: 2,
          tintAmount: 0.13,
          edgeHighlights: 1,
          caustics: 1,
          profile: "edge",
          surfaces: [surface],
        };
        const pixels = (changes = {}) => {
          renderer.draw({ ...scene, ...changes });
          const data = new Uint8Array(canvas.width * canvas.height * 4);
          gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
          return data;
        };
        const zero = pixels();
        const difference = (a, b) => {
          const count = { inside: 0, outside: 0, centre: 0 };
          for (let y = 0; y < 480; y++)
            for (let x = 0; x < 640; x++) {
              const i = ((479 - y) * 640 + x) * 4;
              if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) continue;
              const dx = Math.abs(x + 0.5 - 126.25) - 48,
                dy = Math.abs(y + 0.5 - 118.5) - 40;
              const d =
                Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - 14;
              count[d <= 0 ? "inside" : "outside"]++;
              if (d < -20) count.centre++;
            }
          return count;
        };
        const edge = difference(zero, pixels({ strength: 24 }));
        const simple = difference(zero, pixels({ strength: 24, profile: "simple" }));
        const controls = Object.fromEntries(
          [
            ["frosting", { matte: true, frosting: 0 }, { matte: true, frosting: 4 }],
            ["tint", { tintAmount: 0 }, { tintAmount: 0.3 }],
            ["edges", { edgeHighlights: 0 }, { edgeHighlights: 1 }],
            ["caustics", { caustics: 0 }, { caustics: 1 }],
          ].map(([name, low, high]) => [name, difference(pixels(low), pixels(high))]),
        );
        const restored = difference(zero, pixels());
        renderer.dispose();
        return { edge, simple, controls, restored };
      });
      assert.ok(actual.edge.inside > 10, JSON.stringify(actual));
      assert.equal(actual.edge.centre, 0, "Edge refraction leaves the centre stable");
      assert.equal(actual.edge.outside, 0, "Refraction remains inside the rounded mask");
      assert.ok(actual.simple.centre > 10);
      for (const [name, diff] of Object.entries(actual.controls)) {
        assert.ok(diff.inside > 10, `${name}: ${JSON.stringify(diff)}`);
        assert.equal(diff.outside, 0, name);
      }
      assert.deepEqual(actual.restored, { inside: 0, outside: 0, centre: 0 });
      await writeFile(
        join(outputRoot, `${engine}-shared-receipt.json`),
        JSON.stringify(actual, null, 2),
      );
      process.stdout.write(`${engine} shared optics ${JSON.stringify(actual)}\n`);
    } finally {
      await browser.close();
    }
  });
  for (const enhanced of [false, true]) {
    const mode = enhanced ? "enhanced" : "fallback";
    test(`${engine}: profile light-background contrast ${mode}`, async () => {
      const browser = await launch();
      const page = await browser.newPage({
        viewport: { width: 1366, height: 1024 },
        deviceScaleFactor: 1,
        reducedMotion: "reduce",
      });
      const measurements = [];
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await page.route("https://**/*", (route) => route.abort());
        const appCss = await readFile(join(repository, "apps/web/src/styles/app.css"), "utf8");
        const sceneCss = await readFile(join(themeDirectory, "GlassScene.css"), "utf8");
        // Parse inherited styles before the body, as in the real entry page. Font URLs contain
        // semicolons, so remove the complete quoted import rather than a partial declaration.
        const profileCss = appCss.replace(/^@import url\("[^"]*"\);/, "") + sceneCss + stylesheet;
        await page.setContent(
          `<!doctype html><html><head><style>${profileCss}</style></head><body><div id="fixture"></div></body></html>`,
        );
        assert.equal(await page.evaluate(() => document.compatMode), "CSS1Compat");
        await page.addScriptTag({ content: javascript });
        const card = page.locator('[data-player-glass="profile"]');
        let geometry;
        for (const shade of ["is-light-background", "is-background-grey-66"]) {
          for (const tint of [0, 13, 30]) {
            await page.evaluate((options) => window.renderProfile(options), {
              enhanced,
              tint,
              shade,
            });
            await card.waitFor();
            await card.locator("h2").scrollIntoViewIfNeeded();
            if (enhanced) {
              await page.waitForFunction(
                () =>
                  document.querySelector('[data-player-glass="profile"]')?.dataset.glassPainted ===
                    "true" && document.querySelector(".app-shell")?.dataset.glassStatus === "ready",
              );
              assert.equal(
                await card
                  .locator(".liquid-card-glass")
                  .evaluate((el) => getComputedStyle(el).visibility),
                "hidden",
              );
            } else {
              assert.equal(
                await card
                  .locator(".liquid-card-glass")
                  .evaluate((el) => getComputedStyle(el).visibility),
                "visible",
              );
            }
            await page.evaluate(
              () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
            );
            const currentGeometry = await card.evaluate((el) => ({
              width: el.offsetWidth,
              height: el.offsetHeight,
            }));
            geometry ??= currentGeometry;
            assert.deepEqual(
              currentGeometry,
              geometry,
              "Material settings must not change profile geometry",
            );
            const prefix = `${engine}-profile-${mode}-${shade}-tint-${tint}`;
            const visible = await page.screenshot({ path: join(outputRoot, `${prefix}.png`) });
            const samples = await card.evaluate((el) => {
              const nodes = [
                ...el.querySelectorAll(
                  "h2, .statistics-summary span, .win-rate, .statistics-details dt, .statistics-details dd, .player-profile-fields label:not(.player-toggle-field), .player-toggle-field > span:first-child",
                ),
              ];
              return nodes.map((node, index) => {
                const text = [...node.childNodes].find(
                  (child) => child.nodeType === 3 && child.textContent.trim(),
                );
                const range = document.createRange();
                if (text) range.selectNodeContents(text);
                const rect = text ? range.getBoundingClientRect() : node.getBoundingClientRect();
                const color = getComputedStyle(node).color;
                node.dataset.contrastSample = String(index);
                node.style.visibility = "hidden";
                return {
                  text: node.textContent,
                  color,
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                };
              });
            });
            await page.evaluate(
              () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
            );
            const hidden = await page.screenshot({
              path: join(outputRoot, `${prefix}-background.png`),
            });
            await card
              .locator("[data-contrast-sample]")
              .evaluateAll((nodes) =>
                nodes.forEach((node) => node.style.removeProperty("visibility")),
              );
            await page.evaluate(
              () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
            );
            const background = PNG.sync.read(hidden);
            const luminance = (rgb) =>
              rgb
                .map((value) => {
                  const channel = value / 255;
                  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
                })
                .reduce(
                  (sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index],
                  0,
                );
            for (const sample of samples) {
              const foreground = sample.color
                .match(/[\d.]+/g)
                .slice(0, 3)
                .map(Number);
              const ratios = [];
              const pixels = [];
              for (const fraction of [0.2, 0.5, 0.8]) {
                const x = Math.floor(sample.x + sample.width * fraction);
                const y = Math.floor(sample.y + sample.height / 2);
                assert.ok(
                  x >= 0 && y >= 0 && x < background.width && y < background.height,
                  "Sample must be in native screenshot",
                );
                const index = (y * background.width + x) * 4;
                const rgb = [...background.data.subarray(index, index + 3)];
                const a = luminance(foreground);
                const b = luminance(rgb);
                ratios.push((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05));
                pixels.push(rgb);
              }
              measurements.push({
                engine,
                mode,
                shade,
                tint,
                text: sample.text,
                foreground,
                pixels,
                contrast: Math.min(...ratios),
              });
            }
            // Actual heading pixels, not just an assumed computed foreground, remain visible.
            const heading = samples[0];
            measurements[measurements.length - samples.length].glyphDifference = regionDifference(
              visible,
              hidden,
              {
                left: Math.ceil(heading.x),
                top: Math.ceil(heading.y),
                right: Math.floor(heading.x + heading.width),
                bottom: Math.floor(heading.y + heading.height),
              },
            );
            const input = card.getByLabel("Alpha nickname", { exact: true });
            await input.fill(`Edited ${tint}`);
            await card.getByRole("button", { name: "Save Alpha", exact: true }).focus();
            await page.keyboard.press("Enter");
            await page.waitForFunction(
              (nickname) => window.profileSaved?.input.nickname === nickname,
              `Edited ${tint}`,
            );
          }
        }
        await writeFile(
          join(outputRoot, `${engine}-profile-${mode}-contrast.json`),
          JSON.stringify({ sourceDigest, bundleDigest, measurements, errors }, null, 2),
        );
        const worst = measurements.reduce((a, b) => (a.contrast < b.contrast ? a : b));
        process.stdout.write(
          `PROFILE CONTRAST ${JSON.stringify({ engine, mode, worst, cases: measurements.length, outputRoot, sourceDigest })}\n`,
        );
        assert.deepEqual(errors, []);
        assert.ok(
          worst.contrast >= 4.5,
          `Profile ordinary text contrast must be >=4.5:1: ${JSON.stringify(worst)}`,
        );
        assert.ok(
          measurements
            .filter((sample) => sample.glyphDifference !== undefined)
            .every((sample) => sample.glyphDifference > 1),
          "Actual profile heading glyphs must be painted above the material",
        );
      } finally {
        await browser.close();
      }
    });
  }
  test(`${engine}: actual profile text and form stay above opaque fallback`, async () => {
    const browser = await launch();
    const page = await browser.newPage({
      viewport: { width: 1366, height: 1024 },
      reducedMotion: "reduce",
    });
    try {
      await page.route("https://**/*", (route) => route.abort());
      await page.setContent('<!doctype html><div id="fixture"></div>');
      // Offline fixture: omit only the external font request, retain actual layout/material CSS.
      const appCss = await readFile(join(repository, "apps/web/src/styles/app.css"), "utf8");
      await page.addStyleTag({ content: appCss.replace(/^@import url\("[^"]*"\);/, "") });
      await page.addStyleTag({ content: stylesheet });
      await page.addScriptTag({ content: javascript });
      await page.evaluate(() => window.renderProfile());
      const card = page.locator('[data-player-glass="profile"]');
      await card.waitFor();
      if (engine === "chrome") {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Emulation.setEmulatedMedia", {
          features: [
            { name: "prefers-reduced-transparency", value: "reduce" },
            { name: "prefers-reduced-motion", value: "reduce" },
          ],
        });
      } else {
        const opaque = await page.evaluate(() =>
          [...document.styleSheets]
            .flatMap((sheet) =>
              [...sheet.cssRules]
                .filter((rule) => rule.conditionText?.includes("prefers-reduced-transparency"))
                .flatMap((rule) => [...rule.cssRules].map((child) => child.cssText)),
            )
            .join("\n"),
        );
        await page.addStyleTag({ content: opaque });
      }
      await page.waitForFunction(
        () =>
          getComputedStyle(
            document.querySelector('[data-player-glass="profile"] .liquid-card-glass__backdrop'),
          ).backgroundColor === "rgb(27, 37, 32)",
      );
      const heading = card.locator("h2");
      await heading.scrollIntoViewIfNeeded();
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      const bounds = await heading.boundingBox();
      const before = await page.screenshot({ clip: bounds });
      await page.screenshot({ path: join(outputRoot, `${engine}-profile-opaque.png`) });
      await heading.evaluate((el) => (el.style.visibility = "hidden"));
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      const hidden = await page.screenshot({ clip: bounds });
      await writeFile(join(outputRoot, `${engine}-profile-heading.png`), before);
      await writeFile(join(outputRoot, `${engine}-profile-heading-hidden.png`), hidden);
      await heading.evaluate((el) => el.style.removeProperty("visibility"));
      const image = PNG.sync.read(before);
      const visibleText = regionDifference(before, hidden, {
        left: 0,
        top: 0,
        right: image.width,
        bottom: image.height,
      });
      process.stdout.write(
        `PROFILE OPAQUE TEXT ${JSON.stringify({ engine, visibleText, outputRoot })}\n`,
      );
      assert.ok(
        visibleText > 2,
        "Profile glyph pixels must be visible above the opaque decorative material",
      );
      const input = card.getByLabel("Alpha nickname", { exact: true });
      await input.fill("Updated Alpha");
      await card.getByRole("button", { name: "Save Alpha", exact: true }).click();
      await page.waitForFunction(() => window.profileSaved?.input.nickname === "Updated Alpha");
    } finally {
      await browser.close();
    }
  });
}
