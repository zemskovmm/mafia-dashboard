/* global window, document, localStorage, getComputedStyle, innerWidth, innerHeight,
   Image, HTMLCanvasElement, Storage, DOMException, setTimeout, URL */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { PNG } from "pngjs";
import { capturePlayerCardSources } from "./GlassScene.player-card-scenarios.mjs";
import {
  defaults,
  installPixelProbe,
  settle,
  redraw,
  snapshot,
  difference,
  hostState,
  assertPainted,
  setRange,
} from "./GlassScene.shared-scenarios.mjs";

// These are named cases in the existing actual-App runner, not another test app.
export const backgroundCases = ["contract", "optics", "routes", "resilience"];
const cities = ["noir-skyline", "old-town", "harbour"];
const choices = [...cities, "black", "grey-33", "grey-66", "white"];
const backgroundKey = "mafia-dashboard.background.v1";
const glassKey = "mafia-dashboard.glass.v1";
const gameKey = "mafia-dashboard.game-session.v5";
const labels = {
  en: {
    picker: "Application background",
    open: "Open developer menu",
    close: "Close developer menu",
    gold: "Gold background light",
    refraction: "Refraction strength",
    options: ["Noir skyline", "Old town", "Harbour", "black", "33% grey", "66% grey", "white"],
    neutral: /City backgrounds stay monochrome/,
  },
  ru: {
    picker: "Фон приложения",
    open: "Открыть меню разработчика",
    close: "Закрыть меню разработчика",
    gold: "Золотой фоновый свет",
    refraction: "Сила преломления",
    options: [
      "Ночной мегаполис",
      "Старый город",
      "Гавань",
      "чёрный",
      "серый 33%",
      "серый 66%",
      "белый",
    ],
    neutral: /Городские фоны остаются монохромными/,
  },
};

export async function captureBackgroundSources(root) {
  // This includes actual App, Provider/CSS, preferences and the real renderer.
  const { files } = await capturePlayerCardSources(root);
  for (const path of [
    ...cities.map((id) => `apps/web/public/backgrounds/${id}.svg`),
    "apps/web/public/la-verdad.svg",
  ])
    files[path] = createHash("sha256")
      .update(await readFile(join(root, path)))
      .digest("hex");
  const ordered = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  return {
    files: ordered,
    digest: createHash("sha256").update(JSON.stringify(ordered)).digest("hex"),
  };
}

async function stored(page, key) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)), key);
}
async function canonical(page) {
  const envelope = await stored(page, gameKey);
  assert.ok(envelope?.current?.state, "Actual durable canonical game/setup is present");
  // Entire state includes events, head/undo/nomination data, not just an event count.
  return { gameId: envelope.gameId, clubId: envelope.clubId, current: envelope.current };
}
async function unchanged(page, before) {
  await settle(page);
  assert.deepEqual(
    await canonical(page),
    before,
    "Background/material/navigation must preserve canonical state, event log and undo data",
  );
  assert.deepEqual(
    await page.evaluate(() => window.fixtureUnexpected),
    [],
    "No unhandled API transport may be hidden by fixture defaults",
  );
}
async function ready(page, id) {
  await page.locator('.app-shell[data-glass-status="ready"]').waitFor();
  await page.waitForFunction(
    (id) => document.querySelector(".glass-scene-canvas")?.dataset.glassBackground === id,
    id,
  );
  assert.equal(await page.locator(".glass-scene-canvas").count(), 1);
  await settle(page);
}
async function enter(page, url, query = "phase=day&fresh&full-app") {
  await page.goto(`${url}/?${query}`);
  await page.locator(".club-entry-destination .app-shell").waitFor();
  await page.locator('.save-indicator[data-status="saved"]').waitFor();
  await ready(page, await page.locator(".app-background-root").getAttribute("data-background"));
}
async function developer(page, locale = "en", controls = false) {
  const text = labels[locale];
  if (!(await page.locator("#dev-menu-drawer").count()))
    await page.getByRole("button", { name: text.open, exact: true }).click();
  if (controls && (await page.locator(".dev-glass-controls").getAttribute("open")) === null)
    await page.locator(".dev-glass-controls > summary").click();
  return page.getByRole("combobox", { name: text.picker, exact: true });
}
async function closeDeveloper(page, locale = "en") {
  if (await page.locator("#dev-menu-drawer").count())
    await page.getByRole("button", { name: labels[locale].close, exact: true }).click();
}
async function grantDeveloper(page, id) {
  await page.evaluate(() =>
    localStorage.setItem("mafia-dashboard.developer-unlocked.v1", "unlocked"),
  );
  await page.reload();
  await page.locator('.save-indicator[data-status="saved"]').waitFor();
  await ready(page, id);
}
async function pick(page, id, locale = "en", enhanced = true) {
  const writes = await page.evaluate(
    () => window.fixtureRequests.filter((request) => request.method !== "GET").length,
  );
  await (await developer(page, locale)).selectOption(id);
  await page.waitForFunction(
    (id) => document.querySelector(".app-background-root")?.dataset.background === id,
    id,
  );
  if (enhanced) await ready(page, id);
  assert.deepEqual(await stored(page, backgroundKey), { version: 1, background: id });
  await settle(page);
  assert.equal(
    await page.evaluate(
      () => window.fixtureRequests.filter((request) => request.method !== "GET").length,
    ),
    writes,
    "Application background is local presentation, not an API/session/profile mutation",
  );
}
async function manage(page, name) {
  await page.getByRole("button", { name: "Open Manage menu", exact: true }).click();
  await page.getByRole("button", { name, exact: true }).click();
  await settle(page);
}
async function hitTarget(locator) {
  await locator.scrollIntoViewIfNeeded();
  assert.equal(await locator.isEnabled(), true, "Foreground control remains enabled");
  assert.equal(
    await locator.evaluate((node) => {
      const r = node.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return hit === node || node.contains(hit);
    }),
    true,
    "Decorative background/canvas must not intercept real foreground input",
  );
}
async function globalRoot(page, id) {
  assert.equal(
    await page.locator(".app-background-root").count(),
    1,
    "App/workspace must share one preference owner",
  );
  assert.equal(
    await page.locator(".app-background").count(),
    1,
    "Only one global decorative backdrop",
  );
  const root = page.locator(".app-background-root");
  assert.equal(await root.getAttribute("data-background"), id);
  assert.equal(
    await root.getAttribute("data-background-kind"),
    cities.includes(id) ? "city" : "plain",
  );
  assert.equal(await page.locator(".app-background").getAttribute("aria-hidden"), "true");
  const css = await page.locator(".app-background").evaluate((node) => {
    const s = getComputedStyle(node),
      r = node.getBoundingClientRect();
    return {
      position: s.position,
      pointerEvents: s.pointerEvents,
      image: s.backgroundImage,
      size: s.backgroundSize,
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      viewport: [innerWidth, innerHeight],
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  });
  assert.equal(css.position, "fixed");
  assert.equal(css.pointerEvents, "none");
  assert.equal(css.x, 0);
  assert.equal(css.y, 0);
  assert.deepEqual(
    [css.width, css.height],
    css.viewport,
    "Backdrop covers this viewport without page/layout overflow",
  );
  assert.equal(css.overflow, false);
  if (cities.includes(id)) {
    assert.ok(css.image.endsWith(`/backgrounds/${id}.svg")`), css.image);
    assert.equal(css.size, "cover");
  } else assert.equal(css.image, "none");
  if (await page.locator(".app-shell[data-glass-settings]").count()) {
    assert.equal(
      await page.locator(".app-shell[data-glass-settings]").getAttribute("data-background"),
      id,
    );
    assert.equal(
      await page.locator(".app-shell[data-glass-settings]").getAttribute("data-background-shade"),
      cities.includes(id) ? "black" : id,
    );
  }
  return css;
}

// Independently decode the exact served SVG and CSS center/cover transform.
// It is an image reference, never an injected shader or substitute app scene.
async function imageReference(page, id) {
  return page.evaluate(async (id) => {
    const image = new Image();
    image.src = `/backgrounds/${id}.svg`;
    await image.decode();
    if (!image.complete || image.naturalWidth < 100 || image.naturalHeight < 100)
      throw new Error("City SVG was not decoded as a real image");
    const canvas = document.createElement("canvas");
    canvas.width = innerWidth;
    canvas.height = innerHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const scale = Math.max(innerWidth / image.naturalWidth, innerHeight / image.naturalHeight);
    ctx.drawImage(
      image,
      (innerWidth - image.naturalWidth * scale) / 2,
      (innerHeight - image.naturalHeight * scale) / 2,
      image.naturalWidth * scale,
      image.naturalHeight * scale,
    );
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    // Retain raw reference in-page rather than sending megabytes to Node.
    window.backgroundReference = { pixels, width: canvas.width, height: canvas.height };
    return {
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      scale,
      viewport: [innerWidth, innerHeight],
    };
  }, id);
}
async function actualCitySource(page, id) {
  const decoded = await imageReference(page, id);
  const comparison = await page.evaluate(() => {
    const canvas = document.querySelector(".glass-scene-canvas"),
      frame = window.sharedProbe.frames.get(canvas);
    if (!frame) throw new Error("Missing real final GPU frame for city content comparison");
    const ref = window.backgroundReference;
    const exclusions = [
      ...document.querySelectorAll(
        "[data-player-glass],.round-table,.live-side-panel,.nomination-panel,.availability-selection-card,.player-setup-card",
      ),
    ].map((node) => node.getBoundingClientRect());
    let samples = 0,
      error = 0,
      mismatches = 0,
      low = 255,
      high = 0,
      chroma = 0;
    for (let y = 5; y < ref.height; y += 13)
      for (let x = 5; x < ref.width; x += 13) {
        if (
          exclusions.some(
            (r) => x > r.left - 3 && x < r.right + 3 && y > r.top - 3 && y < r.bottom + 3,
          )
        )
          continue;
        const i = (y * ref.width + x) * 4;
        const px = Math.min(frame.width - 1, Math.floor(((x + 0.5) / ref.width) * frame.width));
        const py = Math.min(frame.height - 1, Math.floor(((y + 0.5) / ref.height) * frame.height));
        const j = ((frame.height - 1 - py) * frame.width + px) * 4;
        const d = Math.max(
          ...[0, 1, 2].map((c) => Math.abs(ref.pixels[i + c] - frame.pixels[j + c])),
        );
        error += d;
        if (d > 8) mismatches++;
        low = Math.min(low, ref.pixels[i]);
        high = Math.max(high, ref.pixels[i]);
        chroma = Math.max(
          chroma,
          Math.max(...frame.pixels.subarray(j, j + 3)) -
            Math.min(...frame.pixels.subarray(j, j + 3)),
        );
        samples++;
      }
    return { samples, meanError: error / samples, mismatches, referenceSpread: high - low, chroma };
  });
  assert.ok(comparison.samples > 50 && comparison.referenceSpread > 15, JSON.stringify(comparison));
  assert.ok(
    comparison.meanError < 4 && comparison.mismatches < comparison.samples * 0.08,
    `GPU must contain the actual selected SVG with viewport-centered cover, not stale/procedural/flat pixels: ${JSON.stringify(comparison)}`,
  );
  assert.ok(
    comparison.chroma <= 8,
    "City source outside lenses/semantic surfaces stays monochrome",
  );
  return { decoded, comparison };
}

// Prove wallpaper visibility in the COMPOSITED screen, not just dataset/style or
// a valid network response. Sample the real PNG against the decoded cover image.
async function screenEvidence(page, id, name, context, { overlay = false } = {}) {
  const { config, evidence, receipt } = context;
  const root = await globalRoot(page, id);
  for (const selector of [".club-portal", ".timeline-screen", ".error-console-screen"])
    if (await page.locator(selector).count()) {
      const s = await page
        .locator(selector)
        .first()
        .evaluate((node) => ({
          image: getComputedStyle(node).backgroundImage,
          color: getComputedStyle(node).backgroundColor,
        }));
      assert.deepEqual(
        s,
        { image: "none", color: "rgba(0, 0, 0, 0)" },
        `${selector} must not reinstate an opaque wallpaper`,
      );
    }
  let decoded = null;
  if (cities.includes(id)) decoded = await imageReference(page, id);
  const points = await page.evaluate(
    ({ city, overlay }) => {
      const ref = window.backgroundReference;
      const points = [];
      const xs = [2, innerWidth - 3],
        ys = [2, innerHeight - 3];
      for (let x = 19; x < innerWidth; x += 37) xs.push(x);
      for (let y = 19; y < innerHeight; y += 37) ys.push(y);
      for (const y of ys)
        for (const x of xs) {
          const i = (y * innerWidth + x) * 4;
          points.push({ x, y, expected: city ? [...ref.pixels.subarray(i, i + 3)] : null });
        }
      return { points, overlay };
    },
    { city: cities.includes(id), overlay },
  );
  const path = join(evidence, `${config.name}-${receipt.scenario}-${name}.png`);
  const png = PNG.sync.read(await page.screenshot({ path, scale: "css" }));
  let matched = 0,
    low = 255,
    high = 0,
    bright = 0;
  for (const point of points.points) {
    const i = (point.y * png.width + point.x) * 4;
    const actual = [...png.data.subarray(i, i + 3)];
    if (Math.min(...actual) > 170) bright++;
    if (point.expected && Math.max(...actual.map((v, c) => Math.abs(v - point.expected[c]))) <= 6) {
      matched++;
      low = Math.min(low, point.expected[0]);
      high = Math.max(high, point.expected[0]);
    }
  }
  if (cities.includes(id) && !overlay)
    assert.ok(
      matched >= 20 && high - low >= 12,
      `${name}: actual composited wallpaper must remain visibly textured, not hidden by an opaque root (${JSON.stringify({ matched, spread: high - low })})`,
    );
  if (id === "white")
    assert.ok(
      bright >= 30,
      `${name}: selected light background is actually visible, not the old dark wallpaper`,
    );
  receipt.screens.push({
    name,
    id,
    path,
    root,
    decoded,
    matched,
    spread: high - low,
    bright,
    ...(overlay
      ? {
          visibility:
            "Intentional recovery-dialog dim/blur; root and decoded asset checked separately",
        }
      : {}),
  });
}

async function contract(page, context) {
  const { url, receipt } = context;
  await enter(page, url);
  assert.equal(
    await page.locator(".app-background-root").getAttribute("data-background"),
    "noir-skyline",
    "Fresh actual App defaults to Noir skyline",
  );
  assert.equal(
    await page.getByRole("button", { name: labels.en.open, exact: true }).count(),
    0,
    "New default renders before developer access",
  );
  assert.deepEqual(
    (await stored(page, glassKey)) ?? defaults,
    defaults,
    "Use actual default-on matte glass",
  );
  await screenEvidence(page, "noir-skyline", "fresh-default", context);
  await grantDeveloper(page, "noir-skyline");
  receipt.choices = [];
  for (const locale of ["en", "ru"]) {
    if (locale === "ru") await enter(page, url, "phase=day&fresh&full-app&locale=ru");
    const before = await canonical(page),
      text = labels[locale];
    const picker = await developer(page, locale, true);
    assert.equal(
      await picker.evaluate((node) => node.tagName),
      "SELECT",
      "Background selection is the native Dev select",
    );
    assert.deepEqual(
      await picker
        .locator("option")
        .evaluateAll((nodes) => nodes.map((node) => ({ id: node.value, text: node.textContent }))),
      choices.map((id, i) => ({ id, text: text.options[i] })),
      `${locale}: exactly seven localized existing and city choices`,
    );
    for (const id of choices) {
      await pick(page, id, locale);
      await developer(page, locale, true);
      const gold = page.getByRole("slider", { name: text.gold, exact: true });
      assert.equal(
        await gold.isDisabled(),
        cities.includes(id),
        `${id}: city gold light is neutral without disabling the stored preference on plain choices`,
      );
      assert.equal(await gold.inputValue(), String(defaults.goldLight));
      if (cities.includes(id))
        assert.match(await page.locator("#glass-gold-description").textContent(), text.neutral);
      assert.deepEqual(
        (await stored(page, glassKey)) ?? defaults,
        defaults,
        "Background changes cannot rewrite matte, refraction or saved gold light",
      );
      await closeDeveloper(page, locale);
      await globalRoot(page, id);
      await unchanged(page, before);
      await page.reload();
      await ready(page, id);
      assert.deepEqual(
        await stored(page, backgroundKey),
        { version: 1, background: id },
        "Every selected choice survives reload",
      );
      await unchanged(page, before);
      receipt.choices.push({ locale, id, reloaded: true });
    }
  }
  // Resetting glass must not reset this separate, versioned application choice.
  const stable = await canonical(page);
  await pick(page, "old-town", "ru");
  await developer(page, "ru", true);
  await page.getByRole("button", { name: "Сбросить настройки стекла", exact: true }).click();
  assert.deepEqual(await stored(page, backgroundKey), { version: 1, background: "old-town" });
  await closeDeveloper(page, "ru");
  receipt.invalid = [];
  for (const value of [
    "{",
    JSON.stringify({ version: 2, background: "harbour" }),
    JSON.stringify({ version: 1, background: "unknown-city" }),
  ]) {
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
      key: backgroundKey,
      value,
    });
    await page.reload();
    await ready(page, "noir-skyline");
    await globalRoot(page, "noir-skyline");
    await unchanged(page, stable);
    receipt.invalid.push({ value, resolved: "noir-skyline" });
  }
  assert.equal(receipt.choices.length, choices.length * 2);
  const denied = await newPage(context, "denied-background-storage");
  try {
    await denied.addInitScript(() => {
      const get = Storage.prototype.getItem,
        set = Storage.prototype.setItem;
      set.call(
        localStorage,
        "mafia-dashboard.background.v1",
        JSON.stringify({ version: 1, background: "harbour" }),
      );
      window.readDeniedBackground = () => get.call(localStorage, "mafia-dashboard.background.v1");
      Storage.prototype.getItem = function (key) {
        if (key === "mafia-dashboard.background.v1")
          throw new DOMException("Denied background read", "SecurityError");
        return get.call(this, key);
      };
      Storage.prototype.setItem = function (key, value) {
        if (key === "mafia-dashboard.background.v1")
          throw new DOMException("Denied background write", "SecurityError");
        return set.call(this, key, value);
      };
    });
    await enter(denied, context.url, "phase=day&full-app");
    await ready(denied, "noir-skyline");
    const initial = await canonical(denied);
    await (await developer(denied)).selectOption("old-town");
    await ready(denied, "old-town");
    await globalRoot(denied, "old-town");
    assert.deepEqual(
      JSON.parse(await denied.evaluate(() => window.readDeniedBackground())),
      { version: 1, background: "harbour" },
      "Denied writes leave durable preference untouched while the current session remains usable",
    );
    await unchanged(denied, initial);
    await assertTransport(denied, receipt);
    receipt.deniedStorage =
      "Reads fall back safely; writes fail without breaking real native selection or canonical game storage";
  } finally {
    await denied.close();
  }
}

async function optics(page, context) {
  await enter(page, context.url);
  await grantDeveloper(page, "noir-skyline");
  await manage(page, "Players screen");
  await page.locator(".player-card-grid > article").first().waitFor();
  await ready(page, "noir-skyline");
  const before = await canonical(page);
  context.receipt.optics = [];
  for (const id of cities) {
    await pick(page, id);
    await developer(page, "en", true);
    assert.equal(
      await page.getByRole("slider", { name: "Refraction strength", exact: true }).inputValue(),
      "14",
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Disable matte glass", exact: true })
        .getAttribute("aria-pressed"),
      "true",
    );
    assert.deepEqual(
      (await stored(page, glassKey)) ?? defaults,
      defaults,
      "Core proof never clears matte, frosting or semantic material",
    );
    await redraw(page);
    const source = await actualCitySource(page, id);
    const hosts = await assertPainted(page, "profile"),
      foreground = await hostState(page, "profile");
    await snapshot(page, "cityDefault");
    await setRange(page, "Refraction strength", 0);
    const zero = await difference(page, "cityDefault", "profile");
    assert.ok(
      zero.surfaces.some((s) => s.edge > 8) &&
        zero.surfaces.reduce((n, s) => n + s.changed, 0) > 64,
      `${id}: actual default city texture must refract at production profile edges: ${JSON.stringify(zero)}`,
    );
    assert.ok(
      zero.surfaces.every((s) => s.centre === 0),
      "Edge profile keeps all centres stable",
    );
    assert.equal(
      zero.outside,
      0,
      "Refraction must not move the global wallpaper outside rounded/clipped surfaces",
    );
    assert.deepEqual(
      await hostState(page, "profile"),
      foreground,
      "Labels, fields, hit geometry and semantic borders are not displaced",
    );
    await setRange(page, "Refraction strength", defaults.refraction);
    const restored = await difference(page, "cityDefault", "profile");
    assert.equal(
      restored.allChanged,
      0,
      "Default/zero/default restores the exact actual GPU frame",
    );
    await unchanged(page, before);
    await closeDeveloper(page);
    await screenEvidence(page, id, `${id}-matte`, context);
    context.receipt.optics.push({ id, source, hosts, zero, restored });
  }
  // A portrait crop checks the same viewport-cover math, not a different mobile demo.
  await page.setViewportSize({ width: 768, height: 1024 });
  await ready(page, "harbour");
  await redraw(page);
  context.receipt.portraitSource = await actualCitySource(page, "harbour");
  await screenEvidence(page, "harbour", "portrait-cover", context);
  await unchanged(page, before);
}

async function routes(page, context) {
  await enter(page, context.url);
  await grantDeveloper(page, "noir-skyline");
  const before = await canonical(page);
  for (const id of ["old-town", "white"]) {
    await pick(page, id);
    await closeDeveloper(page);
    await manage(page, "Players screen");
    await ready(page, id);
    await hitTarget(page.locator("#new-player-nickname"));
    await screenEvidence(page, id, `${id}-players`, context);
    await page.getByRole("button", { name: "Back to game", exact: true }).click();
    await manage(page, "Statistics");
    await page.locator(".statistics-screen").waitFor();
    await screenEvidence(page, id, `${id}-statistics`, context);
    await page.locator(".statistics-header button").first().click();
    await manage(page, "Past game timeline");
    await page.locator(".timeline-screen").waitFor();
    await page.locator(".timeline-loading").waitFor({ state: "detached" });
    await screenEvidence(page, id, `${id}-timeline`, context);
    await hitTarget(page.locator(".timeline-back"));
    await page.locator(".timeline-back").click();
    await developer(page);
    await page.getByRole("button", { name: "Console", exact: true }).click();
    await page.locator(".error-console-screen").waitFor();
    await screenEvidence(page, id, `${id}-console`, context);
    await hitTarget(page.locator(".error-console-header button").first());
    await page.locator(".error-console-header button").first().click();
    await page.getByRole("button", { name: "Rules", exact: true }).click();
    await page.locator("dialog.rules-sketchbook[open]").waitFor();
    await hitTarget(page.locator(".rs-close"));
    await page.locator(".rs-close").click();
    await page.getByRole("button", { name: /Choose another club/ }).click();
    await page.locator(".club-card-open").waitFor();
    assert.equal(
      await page.locator(".glass-scene-canvas").count(),
      0,
      "Real App exit releases workspace glass but preserves the global backdrop",
    );
    await screenEvidence(page, id, `${id}-club-portal`, context);
    await page.locator(".new-club-card").click();
    await page.locator(".club-editor-card").waitFor();
    await screenEvidence(page, id, `${id}-club-editor`, context);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await hitTarget(page.locator(".club-card-open"));
    await page.locator(".club-card-open").click();
    await page.locator(".club-entry-destination:not([inert]) .app-shell").waitFor();
    await ready(page, id);
    await unchanged(page, before);
  }
  // Live read-only state preview, entered and exited through the real game log.
  await pick(page, "old-town");
  await closeDeveloper(page);
  await page.getByRole("button", { name: "Open game log", exact: true }).click();
  await page
    .getByRole("button", { name: /^Preview state after log #/ })
    .first()
    .click();
  await page.locator(".preview-state-center").waitFor();
  await screenEvidence(page, "old-town", "read-only-preview", context);
  await page.locator(".preview-state-center button").first().click();
  await unchanged(page, before);

  // Same App transport fixture: hold only auth, or return real auth/list states.
  // No recovery button is activated, so no local or remote game is discarded.
  for (const state of ["auth", "loading", "error", "recovery"]) {
    const child = await newPage(context, `portal-${state}`, "old-town");
    try {
      await child.goto(`${context.url}/?phase=day&fresh&full-app&background-state=${state}`);
      const selector = {
        auth: ".google-auth-button",
        loading: '.club-auth-status[role="status"]',
        error: ".club-portal-error",
        recovery: ".browser-game-dialog",
      }[state];
      await child.locator(selector).waitFor();
      await screenEvidence(child, "old-town", `portal-${state}`, context, {
        overlay: state === "recovery",
      });
      if (state === "auth") await hitTarget(child.locator(selector));
      if (state === "loading") {
        await child.waitForFunction(() => typeof window.releaseBackgroundLoading === "function");
        await child.evaluate(() => window.releaseBackgroundLoading());
        await child.locator(".club-entry-destination .app-shell").waitFor();
        await ready(child, "old-town");
      }
      await assertTransport(child, context.receipt);
    } finally {
      await child.close();
    }
  }
  for (const phase of ["setup", "night"]) {
    const child = await newPage(context, phase, "old-town");
    try {
      await enter(child, context.url, `phase=${phase}&fresh&full-app`);
      const initial = await canonical(child);
      await screenEvidence(child, "old-town", phase, context);
      if (phase === "setup") {
        await child.getByRole("button", { name: "Select available players", exact: true }).click();
        await child.locator(".availability-selection-card").waitFor();
        await ready(child, "old-town");
        await screenEvidence(child, "old-town", "availability", context);
        await unchanged(child, initial);
      }
      await assertTransport(child, context.receipt);
    } finally {
      await child.close();
    }
  }
}

async function fallbackContent(page) {
  const cards = await hostState(page, "table");
  assert.ok(
    cards.length > 0 &&
      cards.every(
        (card) =>
          card.text &&
          card.opacity === "1" &&
          card.contentFilters.every((filter) => filter === "none"),
      ),
    "Fallback must preserve real readable foreground/card semantics",
  );
  assert.equal(
    await page.locator('[data-player-glass][data-glass-painted="true"]').count(),
    0,
    "Fallback cannot retain stale enhanced paint markers",
  );
  return cards;
}
async function resilience(page, context) {
  await enter(page, context.url);
  await grantDeveloper(page, "noir-skyline");
  const before = await canonical(page);
  const delayed = [];
  await page.route("**/backgrounds/*.svg", async (route) => {
    const id = route.request().url().split("/").at(-1).replace(".svg", "");
    delayed.push(id);
    await new Promise((resolve) =>
      setTimeout(resolve, id === "old-town" ? 350 : id === "harbour" ? 180 : 10),
    );
    await route.continue().catch(() => {}); // A superseded image request may legitimately be cancelled.
  });
  const picker = await developer(page);
  for (const id of ["harbour", "old-town", "noir-skyline", "harbour", "old-town", "noir-skyline"])
    await picker.selectOption(id);
  await ready(page, "noir-skyline");
  // Outwait the oldest delayed request: it must never replace the newer source.
  await page.waitForTimeout(500);
  await redraw(page);
  assert.equal(
    await page.locator(".glass-scene-canvas").getAttribute("data-glass-background"),
    "noir-skyline",
  );
  context.receipt.rapid = { delayed, final: await actualCitySource(page, "noir-skyline") };
  assert.ok(
    delayed.includes("old-town") && delayed.includes("harbour"),
    "Rapid switch actually exercised asynchronous old asset loads",
  );
  await page.unroute("**/backgrounds/*.svg");
  await developer(page, "en", true);
  await page.getByRole("button", { name: "Disable enhanced glass", exact: true }).click();
  await page.locator('.app-shell[data-glass-status="off"]').waitFor();
  await pick(page, "old-town", "en", false);
  assert.equal(await page.locator(".glass-scene-canvas").count(), 0);
  context.receipt.off = await fallbackContent(page);
  assert.equal(
    await page.getByRole("slider", { name: "Refraction strength", exact: true }).isDisabled(),
    true,
  );
  await closeDeveloper(page);
  await screenEvidence(page, "old-town", "enhanced-off", context);
  await developer(page, "en", true);
  await page.getByRole("button", { name: "Enable enhanced glass", exact: true }).click();
  await ready(page, "old-town");
  await closeDeveloper(page);
  await page.evaluate(() => {
    const gl = document.querySelector(".glass-scene-canvas").getContext("webgl");
    window.backgroundContextLoss = gl.getExtension("WEBGL_lose_context");
    if (!window.backgroundContextLoss)
      throw new Error("WEBGL_lose_context is required for real restoration acceptance");
    window.backgroundContextLoss.loseContext();
  });
  await page.locator('.app-shell[data-glass-status="context-lost"]').waitFor();
  context.receipt.contextLost = await fallbackContent(page);
  await screenEvidence(page, "old-town", "context-lost", context);
  await page.evaluate(() => window.backgroundContextLoss.restoreContext());
  await ready(page, "old-town");
  await redraw(page);
  context.receipt.contextRestored = await actualCitySource(page, "old-town");
  if (context.browser.browserType().name() === "chromium") {
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-reduced-transparency", value: "reduce" },
          { name: "prefers-reduced-motion", value: "reduce" },
        ],
      });
      await page.locator('.app-shell[data-glass-status="reduced-transparency"]').waitFor();
      assert.equal(
        await page.evaluate(
          () => window.matchMedia("(prefers-reduced-transparency: reduce)").matches,
        ),
        true,
      );
      await fallbackContent(page);
      await developer(page, "en", true);
      assert.equal(
        await page.getByRole("slider", { name: "Refraction strength", exact: true }).isDisabled(),
        true,
      );
      const filters = await page
        .locator(".table-stage .liquid-card-glass__backdrop")
        .evaluateAll((nodes) =>
          nodes.map((node) => ({
            filter:
              getComputedStyle(node).backdropFilter || getComputedStyle(node).webkitBackdropFilter,
            background: getComputedStyle(node).backgroundColor,
            host: node.closest(".player-seat")?.className,
          })),
        );
      assert.ok(
        filters.length && filters.every(({ filter }) => filter === "none"),
        JSON.stringify(filters),
      );
      await closeDeveloper(page);
      await screenEvidence(page, "old-town", "reduced-transparency", context);
      context.receipt.reducedTransparency =
        "Native Chromium media emulation and real opaque CSS fallback verified";
      await cdp.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "reduce" }],
      });
      await ready(page, "old-town");
    } finally {
      await cdp.detach();
    }
  } else
    context.receipt.reducedTransparency =
      "Native media emulation unavailable in Playwright WebKit; not claimed (OFF and real context-loss fallbacks covered)";
  await unchanged(page, before);
  const failed = await newPage(context, "allocation-failure", "harbour");
  try {
    await failed.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
        return kind === "webgl" && this.classList.contains("glass-scene-canvas")
          ? null
          : getContext.call(this, kind, ...args);
      };
    });
    await failed.goto(`${context.url}/?phase=day&full-app`);
    await failed.locator('.app-shell[data-glass-status="unavailable"]').waitFor();
    const initial = await canonical(failed);
    await fallbackContent(failed);
    await developer(failed, "en", true);
    assert.equal(
      await failed.getByRole("slider", { name: "Refraction strength", exact: true }).isDisabled(),
      true,
    );
    await closeDeveloper(failed);
    await screenEvidence(failed, "harbour", "webgl-unavailable", context);
    await unchanged(failed, initial);
    await assertTransport(failed, context.receipt);
  } finally {
    await failed.close();
  }
}

async function newPage(context, name, seed) {
  const page = await context.browser.newPage({
    viewport: context.config.viewport,
    reducedMotion: "reduce",
    hasTouch: true,
  });
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => context.receipt.errors.push(`${name}: ${error.message}`));
  page.on("response", (response) => {
    if (/\/backgrounds\/[^/]+\.svg$/.test(response.url()))
      context.receipt.assets.push({
        page: name,
        url: response.url(),
        status: response.status(),
        contentType: response.headers()["content-type"],
      });
  });
  await page.route("**/*", (route) =>
    route.request().url().startsWith(`${context.url}/`) ? route.continue() : route.abort(),
  );
  // Only final GPU readback is enabled; never touch shader source/colours/math.
  await installPixelProbe(page, { diagnosticShader: false });
  if (seed)
    await page.addInitScript(
      ({ key, seed }) =>
        localStorage.setItem(key, JSON.stringify({ version: 1, background: seed })),
      { key: backgroundKey, seed },
    );
  return page;
}
async function assertTransport(page, receipt) {
  const requests = await page.evaluate(() => window.fixtureRequests);
  receipt.requests.push(...requests);
  assert.deepEqual(await page.evaluate(() => window.fixtureUnexpected), []);
  assert.ok(
    receipt.assets.every(
      (asset) => asset.status === 200 && asset.contentType?.startsWith("image/svg+xml"),
    ),
    "Every observed city response is the actual local SVG, never an HTML fallback or arbitrary repository file",
  );
}
export async function verifyApplicationBackgrounds({ browser, config, url, evidence, results }) {
  const selected = process.env.GLASS_BACKGROUND_CASE
    ? [process.env.GLASS_BACKGROUND_CASE]
    : backgroundCases;
  for (const name of selected) {
    const receipt = {
      engine: config.name,
      browserVersion: browser.version(),
      scenario: `backgrounds-${name}`,
      viewport: config.viewport,
      status: "running",
      errors: [],
      assets: [],
      requests: [],
      screens: [],
    };
    results.push(receipt);
    const context = { browser, config, url, evidence, receipt };
    const page = await newPage(context, name);
    try {
      await { contract, optics, routes, resilience }[name](page, context);
      await assertTransport(page, receipt);
      assert.deepEqual(receipt.errors, []);
      if (["contract", "optics"].includes(name))
        assert.deepEqual(
          [...new Set(receipt.assets.map((asset) => new URL(asset.url).pathname))].sort(),
          cities.map((id) => `/backgrounds/${id}.svg`).sort(),
          "All three real local city assets were loaded",
        );
      receipt.status = "passed";
    } catch (error) {
      receipt.status = "failed";
      receipt.failure = error.stack;
      await page
        .screenshot({ path: join(evidence, `${config.name}-${name}-failure.png`) })
        .catch(() => {});
      // Keep collecting independent named cases. The runner enforces exact count
      // and a zero-failure aggregate; partial receipts can never claim success.
    } finally {
      await writeFile(
        join(evidence, `${config.name}-${name}-receipt.json`),
        JSON.stringify(receipt, null, 2),
      );
      await page.close();
    }
  }
}
