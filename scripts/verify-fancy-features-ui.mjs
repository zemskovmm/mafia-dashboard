/* global URL, document, localStorage, getComputedStyle, HTMLCanvasElement, HTMLImageElement, FontFaceSet */
/** Actual-App optional-graphics scenarios; shares verify-ui's isolated API/media fixture. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import {
  advanceSetupPhase,
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
} from "../packages/game-domain/src/index.ts";
import { checkpoint, currentSetupState } from "./verify-federation-ui.mjs";
import { rulesSourceManifest } from "./verify-rules-sketchbook-ui.mjs";
import { assertExactOrigin } from "./session-verifier-contracts.mjs";

const preference = "mafia-dashboard.fancy-stuff.v1";
const session = "mafia-dashboard.game-session.v5";
const artwork = /\/(?:club|night)(?:-[\w-]+)?\.webp$/i;
const optionalMedia = /\/(?:club|night)(?:-[\w-]+)?\.webp$|\/cormorant[^/]*\.ttf$/i;
const manifest = async () => ({
  ...(await rulesSourceManifest()),
  "scripts/verify-fancy-features-ui.mjs": createHash("sha256")
    .update(await readFile("scripts/verify-fancy-features-ui.mjs"))
    .digest("hex"),
});

export async function runFancyFeaturesScenarios({
  page,
  baseUrl,
  club,
  players,
  api,
  evidenceDir,
}) {
  const origin = new URL(baseUrl).origin;
  assert.match(
    new URL(baseUrl).hostname,
    /^(localhost|127\.0\.0\.1|\[::1\])$/,
    "Owned loopback only",
  );
  await mkdir(evidenceDir, { recursive: true });
  const report = {
    origin,
    browser: page.context().browser().browserType().name(),
    browserVersion: page.context().browser().version(),
    viewport: page.viewportSize(),
    boundary:
      "Actual App; isolated exact-origin API fixtures and synthetic media iframe. Not backend persistence, physical devices or real-provider playback.",
    sourceBefore: await manifest(),
    scenarios: [],
    failures: [],
  };
  let requests = [];
  page.setDefaultTimeout(5000);
  const capture = (request) => {
    if (
      ["image", "font"].includes(request.resourceType()) &&
      optionalMedia.test(new URL(request.url()).pathname)
    )
      requests.push(request.url());
  };
  page.on("request", capture);
  await page.addInitScript(() => {
    window.__fancyEvidence = { webgl: 0, images: [], fonts: [] };
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...args) {
      if (String(args[0]).startsWith("webgl")) window.__fancyEvidence.webgl++;
      return getContext.apply(this, args);
    };
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function (...args) {
      return decode.apply(this, args).then((value) => {
        if (/\/(?:club|night)(?:-[\w-]+)?\.webp(?:\?|$)/i.test(this.src))
          window.__fancyEvidence.images.push(this.src);
        return value;
      });
    };
    const load = FontFaceSet.prototype.load;
    FontFaceSet.prototype.load = function (font, text) {
      return load.call(this, font, text).then((faces) => {
        if (font.includes("RulesCormorant"))
          window.__fancyEvidence.fonts.push({
            font,
            loaded: faces.length > 0 && faces.every((face) => face.status === "loaded"),
          });
        return faces;
      });
    };
  });
  let draw = beginRoleDraw(
    createSetup(players.slice(0, 10).map((p, i) => ({ id: p.id, seat: i + 1 }))),
    createSeededRandom(71),
  );
  for (let seat = 1; seat <= 10; seat++) draw = drawRoleForSeat(draw, seat);
  let game = createGame(completeRoleDraw(draw));
  while (game.phase !== "day") game = advanceSetupPhase(game);
  async function seed(enabled, live = false) {
    await page.goto(new URL("/health/ready", origin).href);
    assertExactOrigin(page.url(), origin);
    let envelope = null;
    if (live) {
      const gameId = randomUUID();
      const state = checkpoint(
        game,
        {
          ...currentSetupState(),
          setup: null,
          hostPlayerId: players[10].id,
          playlistId: "test-playlist",
        },
        gameId,
      );
      api.seed(gameId, state);
      envelope = {
        version: 5,
        clubId: club.id,
        gameId,
        creationId: null,
        revision: 1,
        current: { name: "Federation UI verification", state, results: null },
        outbox: [],
        failed: false,
        clearFailed: false,
        clearingGameId: null,
        removed: false,
        legacyGameId: null,
      };
    }
    await page.evaluate(
      ({ preference, session, enabled, envelope }) => {
        localStorage.clear();
        localStorage.setItem(preference, JSON.stringify({ version: 2, enabled }));
        localStorage.setItem("mafia-dashboard.lighting-renderer.v1", "vgpu");
        if (envelope) localStorage.setItem(session, JSON.stringify(envelope));
      },
      { preference, session, enabled, envelope },
    );
    requests = [];
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    assertExactOrigin(page.url(), origin);
  }
  const state = () => page.evaluate(() => window.__fancyEvidence);
  const master = () => page.locator(".app-shell, .club-entry-source").first();
  const saved = async () => {
    await expect(page.locator('.save-indicator[data-status="saved"]')).toBeVisible();
    const value = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), session);
    assert.deepEqual(
      api.sessions.get(value.gameId)?.state,
      value.current.state,
      "Exact fixture readback",
    );
    return value.current;
  };
  const screenshot = (name) => page.screenshot({ path: path.join(evidenceDir, `${name}.png`) });
  async function holdArtwork(fail = false) {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const matches = (url) => artwork.test(url.pathname);
    const handler = async (route) => {
      assertExactOrigin(route.request().url(), origin);
      if (route.request().resourceType() !== "image") return route.fallback();
      if (fail) return route.abort("failed");
      await gate;
      await route.continue();
    };
    await page.route(matches, handler);
    return async () => {
      release();
      await page.unroute(matches, handler);
    };
  }
  async function decoded() {
    await expect.poll(async () => (await state()).images.length).toBeGreaterThanOrEqual(2);
    const readiness = await state();
    assert.equal(readiness.fonts.length, 3, "All three declared font faces prepared");
    assert.ok(readiness.fonts.every((font) => font.loaded));
    return readiness;
  }
  let release;
  try {
    await seed(false);
    await expect(page.locator(".club-card-open").first()).toBeVisible();
    await expect(master()).toHaveAttribute("data-fancy-features", "off");
    await expect(page.locator(".fancy-preparation")).toHaveCount(0);
    await page.locator(".club-card-open").first().click();
    await expect(page.locator(".app-shell")).toBeVisible();
    await page.getByRole("button", { name: "Rules", exact: true }).click();
    await expect(page.locator("dialog.rules-sketchbook[open]")).toHaveAttribute(
      "data-presentation",
      "flat",
    );
    assert.equal(
      requests.length,
      0,
      "Cold OFF including first manual opening fetches no enhanced artwork/fonts",
    );
    assert.equal((await state()).webgl, 0, "Cold OFF starts no optional WebGL context");
    await expect(
      page.locator(".rs-binding,.rs-curl,.rs-plate-art,.glass-scene,.vgpu-table-lighting"),
    ).toHaveCount(0);
    await screenshot("cold-off-flat-manual");
    await page.keyboard.press("Escape");
    report.scenarios.push({
      name: "cold-off-no-graphics-work-flat-manual",
      resources: await state(),
    });

    release = await holdArtwork();
    await seed(true);
    await expect(page.locator(".fancy-preparation--startup")).toBeVisible();
    assert.equal((await state()).webgl, 0, "No hidden GPU warm-up behind loading");
    await screenshot("minimal-startup-loading");
    await page.getByRole("button", { name: "Continue with lightweight visuals" }).click();
    await expect(master()).toHaveAttribute("data-fancy-features", "off");
    await release();
    release = null;
    await decoded();
    await expect(master()).toHaveAttribute("data-fancy-features", "off");
    assert.equal((await state()).webgl, 0, "Late readiness cannot resurrect skipped effects");
    assert.equal(
      await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).enabled, preference),
      true,
    );
    report.scenarios.push({
      name: "continue-invalidates-late-success-preserves-preference",
      resources: await state(),
    });

    release = await holdArtwork();
    await seed(true);
    await expect(page.locator(".fancy-preparation--startup")).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry visual preparation" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator(".fancy-preparation--startup")).toHaveCount(0);
    await expect(master()).toHaveAttribute("data-fancy-features", "off");
    await release();
    release = null;
    await decoded();
    await expect(master()).toHaveAttribute("data-fancy-features", "off");
    await page.getByRole("button", { name: "Retry visual preparation" }).click();
    await expect(master()).toHaveAttribute("data-fancy-features", "on");
    report.scenarios.push({
      name: "ten-second-fallback-late-success-ignored-explicit-retry",
      resources: await state(),
    });

    release = await holdArtwork(true);
    await seed(true);
    await expect(page.getByRole("button", { name: "Retry visual preparation" })).toBeVisible();
    await expect(master()).toHaveAttribute("data-fancy-features", "off");
    await release();
    release = null;
    await page.getByRole("button", { name: "Retry visual preparation" }).click();
    await expect(master()).toHaveAttribute("data-fancy-features", "on");
    report.scenarios.push({
      name: "failed-artwork-stays-lightweight-retries-without-reload",
      resources: await decoded(),
    });

    release = await holdArtwork();
    await seed(true, true);
    await expect(page.locator(".game-shell.phase-day")).toBeVisible();
    await expect(page.locator(".fancy-preparation--inline")).toBeVisible();
    await expect(page.locator(".fancy-preparation--startup")).toHaveCount(0);
    const noticeBounds = await page.locator(".fancy-preparation--inline").boundingBox();
    const workspaceBounds = await page.locator(".club-entry-destination").boundingBox();
    assert.ok(
      noticeBounds.y >= workspaceBounds.y + workspaceBounds.height - 1,
      "Preparation reserves space rather than covering live workspace controls",
    );
    const timer = page.locator(".timer-display");
    await page.getByRole("button", { name: "Start 60 second timer", exact: true }).click();
    await expect(timer).toHaveAttribute("aria-label", "Pause timer");
    const nodes = await Promise.all(
      [
        ".app-shell",
        ".round-table",
        ".timer-display",
        ".youtube-dock",
        "iframe.youtube-player-video",
      ].map((selector) => page.locator(selector).elementHandle()),
    );
    const canonical = await saved();
    const initialTimer = await timer.innerText();
    await release();
    release = null;
    await expect(master()).toHaveAttribute("data-fancy-features", "on");
    await decoded();
    const warmRequests = requests.length;
    const privacy = page.getByRole("button", { name: /^(Hide|Show) private info$/ });
    for (let tap = 0; tap < 5; tap++) await privacy.click();
    await page.getByRole("button", { name: "Open developer menu" }).click();
    assert.equal(
      await page.getByRole("button", { name: "Enable dev mode", exact: true }).count(),
      0,
    );
    await page.locator("summary").filter({ hasText: "Fancy Features" }).click();
    await page.locator("summary").filter({ hasText: "Player exit animation" }).click();
    await expect(page.getByRole("button", { name: "Disable player exit animation" })).toBeVisible();
    await page.getByRole("slider", { name: "Lift duration", exact: true }).press("End");
    await page.getByRole("slider", { name: "Landing duration", exact: true }).press("End");
    const exitAnimations = () =>
      page
        .locator(".player-exit-preview")
        .evaluate(
          (sample) =>
            sample
              .getAnimations({ subtree: true })
              .filter((animation) => animation.id.startsWith("player-exit-")).length,
        );
    const savedChoices = await page.evaluate(() =>
      Object.fromEntries(
        [
          "mafia-dashboard.glass.v1",
          "mafia-dashboard.lighting-renderer.v1",
          "mafia-dashboard.player-exit.v1",
        ].map((key) => [key, localStorage.getItem(key)]),
      ),
    );
    await page.getByRole("button", { name: "Preview exit", exact: true }).click();
    assert.equal(await exitAnimations(), 5, "The enabled developer preview starts real WAAPI work");
    await page.getByRole("button", { name: "Disable Fancy Features" }).click();
    await expect(master()).toHaveAttribute("data-fancy-features", "off");
    assert.equal(await exitAnimations(), 0, "OFF immediately cancels the independent preview");
    await page.getByRole("button", { name: "Preview exit", exact: true }).click();
    assert.equal(await exitAnimations(), 0, "Preview while OFF starts no animation work");
    await expect(page.locator(".player-exit-preview .player-exit-face")).toHaveCount(0);
    await expect(page.locator(".player-exit-preview .deceased-cross")).toHaveCount(1);
    await expect(
      page.locator(
        ".glass-scene,.vgpu-table-lighting,.vgpu-player-lighting,.activation-glass-sweep",
      ),
    ).toHaveCount(0);
    await expect(timer).toHaveAttribute("aria-label", "Pause timer");
    await expect.poll(() => timer.innerText()).not.toBe(initialTimer);
    const staticPaint = await page.evaluate(() =>
      [
        [".app-shell", "::before"],
        [".table-center", "::before"],
        [".player-seat", "::after"],
      ].map(([selector, pseudo]) => {
        const node = document.querySelector(selector);
        return node === null ? null : { selector, filter: getComputedStyle(node, pseudo).filter };
      }),
    );
    assert.ok(
      staticPaint.every((row) => row !== null && !row.filter.includes("blur")),
      "Static cues retain no decorative blur",
    );
    await screenshot("live-lightweight-mode");
    // Neither the interrupted ON burst nor a new OFF gesture may replay later.
    for (let tap = 0; tap < 5; tap++) await privacy.click();
    await page.getByRole("button", { name: "Enable Fancy Features" }).click();
    await expect(master()).toHaveAttribute("data-fancy-features", "on");
    await expect(page.locator(".canary-firework")).toHaveCount(0);
    assert.equal(await exitAnimations(), 0, "Re-enabling does not replay an old preview");
    await expect(page.locator(".fancy-preparation--startup")).toHaveCount(0);
    assert.equal(requests.length, warmRequests, "Warm opt-in reuses prepared media/fonts");
    assert.deepEqual(
      await page.evaluate(() =>
        Object.fromEntries(
          [
            "mafia-dashboard.glass.v1",
            "mafia-dashboard.lighting-renderer.v1",
            "mafia-dashboard.player-exit.v1",
          ].map((key) => [key, localStorage.getItem(key)]),
        ),
      ),
      savedChoices,
    );
    for (const [index, selector] of [
      ".app-shell",
      ".round-table",
      ".timer-display",
      ".youtube-dock",
      "iframe.youtube-player-video",
    ].entries())
      assert.ok(
        await nodes[index].evaluate(
          (node, selector) => node === document.querySelector(selector),
          selector,
        ),
        `Retained ${selector}`,
      );
    assert.deepEqual(await saved(), canonical, "Visual changes do not change canonical snapshot");
    report.scenarios.push({
      name: "restored-game-nonblocking-cold-ready-live-toggle-warm-cache-preserves-state-timer-media",
      resources: await state(),
      warmRequests,
    });
    api.clean();
  } catch (error) {
    report.failures.push(error.stack ?? String(error));
    report.failureLayout = await page.evaluate(() =>
      [
        "#root",
        ".fancy-preparation",
        ".club-entry-source",
        ".club-portal",
        ".club-entry-destination",
      ].map((selector) => {
        const node = document.querySelector(selector);
        if (node === null) return { selector, missing: true };
        const style = getComputedStyle(node);
        return {
          selector,
          parent: node.parentElement?.className,
          parentId: node.parentElement?.id,
          box: node.getBoundingClientRect().toJSON(),
          position: style.position,
          display: style.display,
          height: style.height,
          minHeight: style.minHeight,
        };
      }),
    );
    await screenshot("failure").catch(() => {});
    throw error;
  } finally {
    if (release) await release();
    page.off("request", capture);
    report.sourceAfter = await manifest();
    report.changedSources = [
      ...new Set([...Object.keys(report.sourceBefore), ...Object.keys(report.sourceAfter)]),
    ].filter((file) => report.sourceBefore[file] !== report.sourceAfter[file]);
    report.status =
      report.failures.length === 0 && report.changedSources.length === 0 ? "PASS" : "FAIL";
    await writeFile(path.join(evidenceDir, "results.json"), JSON.stringify(report, null, 2));
  }
  assert.deepEqual(report.changedSources, [], "Source stable throughout browser evidence");
  assert.equal(report.scenarios.length, 5);
  console.log(`Fancy actual App ${report.browser}: PASS (${report.scenarios.length} scenarios)`);
}
