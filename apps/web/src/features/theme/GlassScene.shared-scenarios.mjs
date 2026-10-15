/* global window, document, localStorage, getComputedStyle, HTMLInputElement,
   WebGLRenderingContext, Event, innerWidth, innerHeight, queueMicrotask,
   requestAnimationFrame, console */
import assert from "node:assert/strict";
import { join } from "node:path";
import process from "node:process";
import { PNG } from "pngjs";

const defaults = {
  version: 1,
  enabled: true,
  refraction: 14,
  goldLight: 25,
  matte: true,
  profile: "edge",
  frosting: 50,
  tint: 13,
  edgeHighlights: 100,
  caustics: 100,
  noirContrast: 100,
  nominationTint: 18,
  nominationColor: "#e6bc7e",
  nominationTreatment: "hybrid",
  nominationIcon: "vote",
  supportIcon: "hand",
  selectionStyle: "check-outline",
};
const controls = [
  ["refraction", "Refraction strength", 24],
  ["frosting", "Frosting amount", 100],
  ["tint", "Glass tint", 30],
  ["edgeHighlights", "Edge highlights", 100],
  ["caustics", "Caustic light", 100],
  ["goldLight", "Gold background light", 100],
  ["noirContrast", "Noir contrast · Available players only", 100],
];
const families = ["setup", "availability", "profile", "table", "nomination", "deceased", "roles"];
function screenshotDelta(first, second) {
  const a = PNG.sync.read(first),
    b = PNG.sync.read(second);
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4)
    if (
      a.data[i] !== b.data[i] ||
      a.data[i + 1] !== b.data[i + 1] ||
      a.data[i + 2] !== b.data[i + 2]
    )
      changed++;
  return changed;
}

// Read the actual final GPU frame before the compositor discards its buffer.
// This works with preserveDrawingBuffer:false and does not change that option.
// An opt-in diagnostic replaces only scene colours, never lens geometry/math:
// background and refracted samples still call the exact same scene function.
async function installPixelProbe(page) {
  await page.addInitScript(() => {
    window.sharedProbe = { frames: new Map(), contexts: new Set(), pattern: false, offset: 0 };
    const source = WebGLRenderingContext.prototype.shaderSource;
    WebGLRenderingContext.prototype.shaderSource = function (shader, text) {
      if (/vec3\s+scene\s*\(\s*vec2\s+p\s*\)/.test(text) && text.includes("u_lens")) {
        text = text.replace(/vec3\s+scene\s*\(\s*vec2\s+p\s*\)/, "vec3 originalScene(vec2 p)");
        text = text.replace(
          /void\s+main\s*\(/,
          `
          uniform float u_verifier_pattern;
          uniform float u_verifier_offset;
          vec3 scene(vec2 p) {
            if(u_verifier_pattern<0.5)return originalScene(p);
            float band=step(9.0,mod(p.x*.78+p.y*.63+u_verifier_offset,24.0));
            return mix(originalScene(p),mix(vec3(.08,.12,.15),vec3(.88,.75,.51),band),.65);
          }
          void main(`,
        );
      }
      return source.call(this, shader, text);
    };
    const draw = WebGLRenderingContext.prototype.drawArrays;
    const pending = new Set();
    WebGLRenderingContext.prototype.drawArrays = function (...args) {
      const canvas = this.canvas;
      const isGlass = canvas.classList.contains("glass-scene-canvas");
      if (isGlass) {
        window.sharedProbe.contexts.add(this);
        const program = this.getParameter(this.CURRENT_PROGRAM);

        this.uniform1f(
          this.getUniformLocation(program, "u_verifier_pattern"),
          window.sharedProbe.pattern ? 1 : 0,
        );
        this.uniform1f(
          this.getUniformLocation(program, "u_verifier_offset"),
          window.sharedProbe.offset,
        );
      }
      const result = draw.apply(this, args);
      if (isGlass && !pending.has(canvas)) {
        pending.add(canvas);
        queueMicrotask(() => {
          pending.delete(canvas);
          if (this.isContextLost()) return;
          const pixels = new Uint8Array(canvas.width * canvas.height * 4);
          this.readPixels(0, 0, canvas.width, canvas.height, this.RGBA, this.UNSIGNED_BYTE, pixels);
          window.sharedProbe.frames.set(canvas, {
            pixels,
            width: canvas.width,
            height: canvas.height,
          });
        });
      }
      return result;
    };
  });
}

async function settle(page) {
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
}
async function redraw(page) {
  const before = await page.locator(".glass-scene-canvas").getAttribute("data-glass-draws");
  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
  await page.waitForFunction(
    (before) =>
      Number(document.querySelector(".glass-scene-canvas")?.dataset.glassDraws) > Number(before),
    before,
  );
  await settle(page);
}
async function snapshot(page, key) {
  await page.evaluate((key) => {
    const canvas = document.querySelector(".glass-scene-canvas");
    const frame = window.sharedProbe.frames.get(canvas);
    if (!frame || !frame.pixels.some((n) => n > 0))
      throw new Error("Missing nonempty actual GPU frame");
    window.sharedProbe[key] = { ...frame, pixels: frame.pixels.slice() };
  }, key);
}
async function difference(page, key, family) {
  return page.evaluate(
    ({ key, family }) => {
      const canvas = document.querySelector(".glass-scene-canvas");
      const now = window.sharedProbe.frames.get(canvas);
      const old = window.sharedProbe[key];
      if (!now || !old || now.width !== old.width || now.height !== old.height)
        throw new Error("Frame dimensions changed during material comparison");
      const rect = (node) => {
        const b = node.getBoundingClientRect();
        return { x: b.x, y: b.y, w: b.width, h: b.height };
      };
      const intersect = (a, b) => {
        const x = Math.max(a.x, b.x),
          y = Math.max(a.y, b.y);
        return {
          x,
          y,
          w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x),
          h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y),
        };
      };
      const all = [...document.querySelectorAll("[data-player-glass]")].flatMap((node, index) => {
        if (node.closest("[hidden]") || getComputedStyle(node).visibility === "hidden") return [];
        const r = rect(node);
        let clip = intersect(r, { x: 0, y: 0, w: innerWidth, h: innerHeight });
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          const s = getComputedStyle(parent);
          if (/auto|scroll|hidden|clip/.test(s.overflowX + s.overflowY))
            clip = intersect(clip, rect(parent));
        }
        if (clip.w <= 0 || clip.h <= 0) return [];
        return [
          {
            index,
            family: node.dataset.playerGlass,
            r,
            clip,
            radius: Math.min(
              parseFloat(getComputedStyle(node).borderTopLeftRadius),
              r.w / 2,
              r.h / 2,
            ),
            changed: 0,
            edge: 0,
            centre: 0,
          },
        ];
      });
      const sdf = (p, s) => {
        const qx = Math.abs(p.x - s.r.x - s.r.w / 2) - (s.r.w / 2 - s.radius);
        const qy = Math.abs(p.y - s.r.y - s.r.h / 2) - (s.r.h / 2 - s.radius);
        return (
          Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - s.radius
        );
      };
      const inClip = (p, s, margin = 0) =>
        p.x >= s.clip.x - margin &&
        p.x <= s.clip.x + s.clip.w + margin &&
        p.y >= s.clip.y - margin &&
        p.y <= s.clip.y + s.clip.h + margin;
      let outside = 0,
        allChanged = 0;
      for (let y = 0; y < now.height; y++)
        for (let x = 0; x < now.width; x++) {
          const i = ((now.height - 1 - y) * now.width + x) * 4;
          const changed =
            Math.abs(now.pixels[i] - old.pixels[i]) +
              Math.abs(now.pixels[i + 1] - old.pixels[i + 1]) +
              Math.abs(now.pixels[i + 2] - old.pixels[i + 2]) >
            0;
          if (!changed) continue;
          allChanged++;
          const p = {
            x: ((x + 0.5) / now.width) * innerWidth,
            y: ((y + 0.5) / now.height) * innerHeight,
          };
          let masked = false;
          for (const s of all) {
            const d = sdf(p, s);
            // Raster guard excludes only the one-pixel boundary, not outside regions.
            if (d <= 1.25 && inClip(p, s, 1.25)) masked = true;
            if (d > -0.75 || !inClip(p, s)) continue;
            s.changed++;
            if (d > -18) s.edge++;
            if (
              Math.abs(p.x - s.r.x - s.r.w / 2) < Math.min(8, s.r.w * 0.08) &&
              Math.abs(p.y - s.r.y - s.r.h / 2) < Math.min(8, s.r.h * 0.08)
            )
              s.centre++;
          }
          if (!masked) outside++;
        }
      return { surfaces: all.filter((s) => s.family === family), outside, allChanged };
    },
    { key, family },
  );
}
async function hostState(page, family) {
  return page
    .locator(`[data-player-glass="${family}"]:not(.dev-menu-actions *)`)
    .evaluateAll((nodes) =>
      // Developer preview cards move as their own controls scroll/expand; they
      // are not production table geometry and remain covered by PlayerExit tests.
      nodes
        .filter((node) => !node.closest(".dev-menu-actions"))
        .map((node) => {
          const style = getComputedStyle(node);
          return {
            rect: node.getBoundingClientRect().toJSON(),
            text: node.textContent,
            classes: node.className,
            border: style.borderColor,
            shadow: style.boxShadow,
            opacity: style.opacity,
            color: style.color,
            fields: [...node.querySelectorAll("input")].map((el) => ({
              value: el.value,
              filter: getComputedStyle(el).filter,
            })),
            contentFilters: [...node.querySelectorAll("strong,span,button")]
              .filter((el) => !el.closest(".liquid-card-glass,.vgpu-player-lighting"))
              .map((el) => getComputedStyle(el).filter),
          };
        }),
    );
}
async function assertPainted(page, family) {
  const state = await page
    .locator(`[data-player-glass="${family}"]:not(.dev-menu-actions *)`)
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        let r = node.getBoundingClientRect();
        let left = Math.max(0, r.left),
          right = Math.min(innerWidth, r.right);
        let top = Math.max(0, r.top),
          bottom = Math.min(innerHeight, r.bottom);
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          const s = getComputedStyle(parent),
            b = parent.getBoundingClientRect();
          if (/auto|scroll|hidden|clip/.test(s.overflowX + s.overflowY)) {
            left = Math.max(left, b.left);
            right = Math.min(right, b.right);
            top = Math.max(top, b.top);
            bottom = Math.min(bottom, b.bottom);
          }
        }
        const visible = right > left && bottom > top && !node.closest("[hidden]");
        const fallback = node.firstElementChild;
        const s = fallback && getComputedStyle(fallback);
        return {
          visible,
          painted: node.dataset.glassPainted,
          fallback: fallback?.classList.contains("liquid-card-glass"),
          hidden: s?.display === "none" || s?.visibility === "hidden" || s?.opacity === "0",
        };
      }),
    );
  assert.ok(state.length > 0, `${family}: no registered hosts`);
  assert.ok(
    state.every((s) => s.fallback),
    `${family}: fallback must remain the first child: ${JSON.stringify(state)}`,
  );
  assert.ok(state.filter((s) => s.visible).length > 0, `${family}: no visible hosts`);
  for (const s of state) {
    assert.equal(
      s.painted === "true",
      s.visible,
      `${family}: readiness must be per actually drawn visible host: ${JSON.stringify(state)}`,
    );
    assert.equal(
      s.hidden,
      s.visible,
      `${family}: global readiness must not suppress offscreen fallback: ${JSON.stringify(state)}`,
    );
  }
  return state;
}
async function openControls(page) {
  await page.getByRole("button", { name: "Open developer menu", exact: true }).click();
  if ((await page.locator(".dev-glass-controls").getAttribute("open")) === null)
    await page.locator(".dev-glass-controls > summary").click();
  if ((await page.locator(".dev-glass-advanced").getAttribute("open")) === null)
    await page.locator(".dev-glass-advanced summary").click();
}
async function setRange(page, label, value) {
  const control = page.getByLabel(label, { exact: true });
  if ((await control.inputValue()) === String(value)) return;
  const before = await page.locator(".glass-scene-canvas").getAttribute("data-glass-draws");
  await control.evaluate((el, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(
      el,
      String(value),
    );
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  assert.equal(await control.inputValue(), String(value));
  await page.waitForFunction(
    (before) =>
      Number(document.querySelector(".glass-scene-canvas")?.dataset.glassDraws) > Number(before),
    before,
  );
  await settle(page);
}
async function saved(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("mafia-dashboard.glass.v1")));
}

async function verifyNominationMaterial(page) {
  await page.locator(".dev-player-card-appearance > summary").click();
  // Exercise the renderer's input class on a real idle production card. The
  // parent GameTable integration separately owns derivation from nominations.
  const seat = await page
    .locator(".round-table .player-seat:not(.is-current):not(.is-voting-highlight)")
    .first()
    .evaluate((el) => el.closest(".seat-anchor").dataset.seat);
  const probe = page.locator(`.round-table .seat-anchor[data-seat="${seat}"] .player-seat`);
  const original = await probe.getAttribute("class");
  await probe.evaluate((el) => el.classList.add("is-nominated"));
  const index = await probe.evaluate((el) =>
    [...document.querySelectorAll("[data-player-glass]")].indexOf(el),
  );
  const target = (delta) => delta.surfaces.find((surface) => surface.index === index);
  const canonical = await gameState(page);
  const geometry = await probe.boundingBox();
  await setRange(page, "Nomination tint", 0);
  await snapshot(page, "nominationZero");
  await setRange(page, "Nomination tint", 50);
  const strength = await difference(page, "nominationZero", "table");

  assert.ok(
    target(strength)?.changed > 100,
    `Nomination strength must alter actual GPU card pixels: ${JSON.stringify(strength)}`,
  );
  assert.equal(strength.outside, 0, "Nomination wash must remain inside existing material bounds");
  await snapshot(page, "nominationGold");
  await page.getByRole("button", { name: "Blue nomination tint", exact: true }).click();
  await redraw(page);
  const color = await difference(page, "nominationGold", "table");
  assert.ok(target(color)?.changed > 100, "Nomination color must change actual GPU pixels");
  assert.equal(color.outside, 0);
  await page.getByLabel("Nomination treatment", { exact: true }).selectOption("icons");
  await redraw(page);
  assert.equal(
    (await difference(page, "nominationZero", "table")).allChanged,
    0,
    "Icons-only must remove the extra wash, not the base tint",
  );
  await page.getByLabel("Nomination treatment", { exact: true }).selectOption("tint");
  await redraw(page);
  for (const priority of [
    "is-current",
    "is-voting-highlight",
    "is-sheriff-highlight",
    "is-mafia-shooter",
    "is-night-check-highlight",
    "is-goodbye-highlight",
  ]) {
    await probe.evaluate((el, priority) => el.classList.add(priority), priority);
    await setRange(page, "Nomination tint", 0);
    await snapshot(page, "priorityZero");
    await setRange(page, "Nomination tint", 50);
    assert.equal(
      target(await difference(page, "priorityZero", "table"))?.changed,
      0,
      `${priority}: active cue must retain material priority`,
    );
    await probe.evaluate((el, priority) => el.classList.remove(priority), priority);
  }
  await probe.evaluate((el) => el.closest(".table-stage").classList.add("is-table-cycle-night"));
  await setRange(page, "Nomination tint", 0);
  await snapshot(page, "nightZero");
  await setRange(page, "Nomination tint", 50);
  assert.equal(
    target(await difference(page, "nightZero", "table"))?.changed,
    0,
    "Night must retain material priority even without a role cue",
  );
  await probe.evaluate((el) => el.closest(".table-stage").classList.remove("is-table-cycle-night"));
  assert.deepEqual(
    await probe.boundingBox(),
    geometry,
    "Appearance controls must not change card geometry",
  );
  assert.deepEqual(
    await gameState(page),
    canonical,
    "Appearance controls must not change events/state",
  );
  await probe.evaluate((el, original) => el.setAttribute("class", original), original);
  await page.getByLabel("Nomination icon", { exact: true }).selectOption("flag");
  await page.getByLabel("Support icon", { exact: true }).selectOption("thumbs-up");
  await page.getByLabel("This speaker’s choice", { exact: true }).selectOption("check");
  const customized = {
    ...defaults,
    nominationTint: 50,
    nominationColor: "#88c7e3",
    nominationTreatment: "tint",
    nominationIcon: "flag",
    supportIcon: "thumbs-up",
    selectionStyle: "check",
  };
  assert.deepEqual(await saved(page), customized);
  await page.reload();
  await page.waitForFunction(
    () => document.querySelector(".app-shell")?.dataset.glassStatus === "ready",
  );
  await openControls(page);
  await page.locator(".dev-player-card-appearance > summary").click();
  for (const [field, label] of [
    ["nominationTint", "Nomination tint"],
    ["nominationColor", "Nomination color"],
    ["nominationTreatment", "Nomination treatment"],
    ["nominationIcon", "Nomination icon"],
    ["supportIcon", "Support icon"],
    ["selectionStyle", "This speaker’s choice"],
  ])
    assert.equal(
      await page.getByLabel(label, { exact: true }).inputValue(),
      String(customized[field]),
      `${field}: chosen appearance must survive reload`,
    );
  assert.deepEqual(await saved(page), customized);
  assert.deepEqual(await gameState(page), canonical);
  await page.getByRole("button", { name: "Reset glass settings", exact: true }).click();
  await redraw(page);
  assert.deepEqual(await saved(page), defaults);
  return {
    strength,
    color,
    priorities: "speaker/ballot/night-role/goodbye retained; base tint restored exactly",
    geometry,
  };
}
async function gameState(page) {
  return page.evaluate(
    () => JSON.parse(localStorage.getItem("mafia-dashboard.game-session.v5"))?.current?.state,
  );
}
async function visitFamily(page, url, family, fresh = true) {
  const phase = ["setup", "availability", "profile", "roles"].includes(family)
    ? "setup"
    : family === "deceased"
      ? "deceased"
      : family === "nomination"
        ? "voting"
        : "day";
  await page.goto(`${url}/?phase=${phase}${fresh ? "&fresh" : ""}`);
  if (family === "availability") {
    await page.getByRole("button", { name: "Select available players", exact: true }).click();
  } else if (family === "profile") {
    await page.getByRole("button", { name: "Open Manage menu", exact: true }).click();
    await page.getByRole("button", { name: "Players screen", exact: true }).click();
  } else if (family === "roles") {
    await page.getByRole("button", { name: "Start game", exact: true }).click();
  }
  await page
    .locator(`[data-player-glass="${family === "roles" ? "table" : family}"]`)
    .first()
    .waitFor();
}
async function verifyInteractions(page, family) {
  if (family === "setup") {
    await page.locator("#seat-1-player").click();
    await page.getByRole("listbox").waitFor();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#seat-1-player").inputValue(), "Player 1");
    const handle = page.locator('[data-setup-seat="1"] .setup-seat-drag-handle');
    const source = await handle.boundingBox(),
      target = await page.locator('[data-setup-seat="2"]').boundingBox();
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(
      () =>
        document.querySelector("#seat-1-player")?.value === "Player 2" &&
        document.querySelector("#seat-2-player")?.value === "Player 1",
    );
    const state = await gameState(page);
    assert.ok(state.setup.selectedPlayerIds[0].endsWith("000000000002"));
    assert.ok(state.setup.selectedPlayerIds[1].endsWith("000000000001"));
    return "actual picker Escape and pointer drag swap, canonical setup readback";
  }
  if (family === "availability") {
    const search = page.getByRole("searchbox", { name: "Search available players" });
    await search.fill("Player 10");
    assert.equal(await page.locator('[data-player-glass="availability"]').count(), 1);
    const card = page.locator('[data-player-glass="availability"]');
    const before = await card.getAttribute("aria-pressed");
    await card.focus();
    await page.keyboard.press("Space");
    assert.equal(await card.getAttribute("aria-pressed"), before === "true" ? "false" : "true");
    for (let i = 0; i < 4; i++) await card.click();
    assert.equal(await card.getAttribute("aria-pressed"), before === "true" ? "false" : "true");
    assert.equal(
      await card.locator(".state-badge").textContent(),
      before === "true" ? "Tap to select" : "Selected",
    );
    await search.fill("");
    assert.equal(await page.locator('[data-player-glass="availability"]').count(), 11);
    await page.getByRole("button", { name: "Close available players", exact: true }).click();
    await page.locator(".setup-seat-card").first().waitFor();
    return "search, keyboard, rapid binary selection, badge and close";
  }
  if (family === "profile") {
    const card = page.locator('[data-player-glass="profile"]').filter({
      has: page.locator('input[id="player-00000000-0000-4000-8000-000000000001-nickname"]'),
    });
    const input = card.locator('input[id$="-nickname"]');
    await input.fill("Player 1 edited");
    await card.getByRole("button", { name: "Save Player 1", exact: true }).click();
    await card.getByRole("heading", { name: "Player 1 edited", exact: true }).waitFor();
    const writes = await page.evaluate(() =>
      window.fixtureRequests.filter(
        (r) => r.path.startsWith("/api/players/") && r.method === "PUT",
      ),
    );
    assert.equal(writes.length, 1);
    assert.equal(writes[0].body.nickname, "Player 1 edited");
    assert.equal(await input.inputValue(), "Player 1 edited");
    assert.equal(await input.evaluate((el) => getComputedStyle(el).filter), "none");
    return "profile form edit/save and fixture PUT/readback; sharp input";
  }
  if (family === "deceased") {
    const card = page.locator('[data-player-glass="deceased"]');
    assert.match(await card.innerText(), /#1/);
    assert.match(await card.innerText(), /Player 1/);
    const state = await gameState(page);
    assert.equal(state.game.phase, "night-mafia-result");
    assert.ok(
      state.game.players
        .filter((p) => p.team === "black" && p.status === "active")
        .every((p) => state.game.shotAssignments[p.seat] === 1),
      "Canonical legacy Mafia assignments must all resolve to deceased seat 1",
    );
    return "canonical resolved Mafia shot retains deceased seat/name";
  }
  if (family === "nomination") {
    const target = page.locator('[data-player-glass="nomination"]').nth(1).locator("button");
    await target.focus();
    await page.keyboard.press("Enter");
    assert.equal(await target.getAttribute("aria-pressed"), "true");
    return "whole-row keyboard candidate selection; broad scenario retains ballot taps/counts";
  }
  if (family === "table") {
    const glow = page.locator(".player-seat.is-current").first();
    assert.notEqual(await glow.evaluate((el) => getComputedStyle(el).boxShadow), "none");
    return "day semantic current-player glow retained; broad scenario retains night/GPU/privacy";
  }
  return "real setup → role-giveaway navigation";
}

// Default remains the full existing browser/viewport matrix. These opt-in
// selectors are for RED/iteration; unknown values fail rather than silently skip.
export async function verifySharedPlayerGlass({ browser, config, url, evidence, results }) {
  const selected = process.env.GLASS_FAMILY ? process.env.GLASS_FAMILY.split(",") : families;
  assert.ok(
    selected.length && selected.every((family) => families.includes(family)),
    "Unknown GLASS_FAMILY",
  );
  for (const scenario of selected) {
    const family = scenario === "roles" ? "table" : scenario;
    const page = await browser.newPage({
      viewport: config.viewport,
      deviceScaleFactor: 2,
      hasTouch: true,
      reducedMotion: "reduce",
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) =>
      route.request().url().startsWith(url) ? route.continue() : route.abort(),
    );
    await installPixelProbe(page);
    const receipt = {
      engine: config.name,
      scenario: `shared-${scenario}`,
      family,
      status: "running",
      errors,
    };
    results.push(receipt);
    try {
      await visitFamily(page, url, scenario);
      assert.equal(
        await page.getByRole("button", { name: "Open developer menu" }).count(),
        0,
        "Fresh rendering must not require developer access",
      );
      await page.screenshot({
        path: join(evidence, `${config.name}-shared-${scenario}-fresh.png`),
      });
      await page
        .waitForFunction(
          () => document.querySelector(".app-shell")?.dataset.glassStatus === "ready",
          null,
          { timeout: 5000 },
        )
        .catch(async (error) =>
          assert.fail(
            `Fresh ${scenario} must render default-on shared glass without developer access; actual status=${await page.locator(".app-shell").getAttribute("data-glass-status")}; ${error.message}`,
          ),
        );
      assert.equal(await page.locator(".glass-scene-canvas").count(), 1);
      // Keep a paint/fallback contract failure while collecting independent
      // material evidence during integration; it still fails this scenario.
      let hostContractError = null;
      try {
        receipt.hosts = await assertPainted(page, family);
      } catch (error) {
        receipt.hostContractError = hostContractError = error.message;
      }
      // Only now grant access to the existing guarded controls in the fixture.
      // This does not seed glass settings, and rendering has already been proved.
      await page.evaluate(() =>
        localStorage.setItem("mafia-dashboard.developer-unlocked.v1", "unlocked"),
      );
      await page.reload();
      if (scenario === "availability")
        await page.getByRole("button", { name: "Select available players", exact: true }).click();
      if (scenario === "profile") {
        await page.getByRole("button", { name: "Open Manage menu", exact: true }).click();
        await page.getByRole("button", { name: "Players screen", exact: true }).click();
      }
      await page.waitForFunction(
        () => document.querySelector(".app-shell")?.dataset.glassStatus === "ready",
      );
      await openControls(page);
      assert.deepEqual(
        (await saved(page)) ?? defaults,
        defaults,
        "Any fresh stored settings must agree with canonical defaults; missing storage uses the controls below",
      );
      const canonical = await gameState(page);
      if (scenario === "table") receipt.nominationMaterial = await verifyNominationMaterial(page);
      const preserved = await hostState(page, family);
      for (const [field, label] of controls)
        assert.equal(
          await page.getByLabel(label, { exact: true }).inputValue(),
          String(defaults[field]),
        );
      assert.equal(
        await page.getByLabel("Refraction profile", { exact: true }).inputValue(),
        "edge",
      );
      await redraw(page);
      await snapshot(page, "ordinary");
      await page.evaluate(() => {
        window.sharedProbe.pattern = true;
      });
      await redraw(page);
      const source = await difference(page, "ordinary", family);
      assert.ok(
        source.surfaces.length > 0 && source.surfaces.every((s) => s.changed > 8),
        JSON.stringify({ scenario, source }),
      );
      assert.ok(source.outside > 20, "Diagnostic source must be visible outside lenses too");
      await snapshot(page, "sourceAtZero");
      await page.evaluate(() => {
        window.sharedProbe.offset = 7.25;
      });
      await redraw(page);
      const moved = await difference(page, "sourceAtZero", family);
      assert.ok(
        moved.surfaces.every((s) => s.changed > 8) && moved.outside > 20,
        JSON.stringify({ scenario, moved }),
      );
      receipt.source = { original: source, moved };
      receipt.controls = {};
      // Isolate every endpoint: each starts and ends at the full defaults.
      // Noir is intentionally a negative control on every other family.
      for (const [field, label, maximum] of controls) {
        await setRange(page, label, 0);
        await snapshot(page, "endpointZero");
        let defaultRefraction;
        if (field === "refraction") {
          await setRange(page, label, defaults.refraction);
          defaultRefraction = await difference(page, "endpointZero", family);
          assert.ok(
            defaultRefraction.surfaces.length &&
              defaultRefraction.surfaces.every((s) => s.changed > 8 && s.centre === 0),
            JSON.stringify({ scenario, defaultRefraction }),
          );
          assert.equal(defaultRefraction.outside, 0);
          await snapshot(page, "refractionDefault");
        }
        await setRange(page, label, maximum);
        const delta = await difference(page, "endpointZero", family);
        if (field === "refraction") {
          const aboveDefault = await difference(page, "refractionDefault", family);
          assert.ok(
            aboveDefault.surfaces.every((s) => s.changed > 8 && s.centre === 0),
            JSON.stringify({ scenario, aboveDefault }),
          );
          assert.equal(aboveDefault.outside, 0);
          delta.zeroToDefault = defaultRefraction;
          delta.defaultToMaximum = aboveDefault;
        }
        if (field === "goldLight") {
          // This is the existing APP background control, not a per-card tint.
          // A deceased lens over the fixed table centre need not contain gold.
          assert.ok(
            delta.outside > 8 && delta.allChanged > 8,
            `${scenario}: gold must change its actual source background`,
          );
        } else if (field === "noirContrast" && family !== "availability")
          assert.equal(delta.allChanged, 0, `${scenario}: Noir must be scoped to availability`);
        else {
          assert.ok(
            delta.surfaces.length > 0 && delta.surfaces.every((s) => s.changed > 8),
            JSON.stringify({ scenario, field, delta }),
          );
          if (field === "goldLight" || field === "noirContrast")
            assert.ok(delta.outside > 8, `${field} must change its visible source background`);
          else
            assert.equal(
              delta.outside,
              0,
              `${scenario}/${field}: material escaped the rounded/clipped card masks`,
            );
        }
        if (field === "refraction")
          assert.ok(
            delta.surfaces.every((s) => s.centre === 0),
            `${scenario}: edge refraction must keep centres stable: ${JSON.stringify(delta)}`,
          );
        assert.deepEqual(
          await saved(page),
          { ...defaults, [field]: maximum },
          `${field}: setting changed another preference`,
        );
        await setRange(page, label, defaults[field]);
        receipt.controls[field] = delta;
      }
      await snapshot(page, "edgeProfile");
      await page.getByLabel("Refraction profile", { exact: true }).selectOption("simple");
      await redraw(page);
      const profile = await difference(page, "edgeProfile", family);
      assert.ok(
        profile.surfaces.every((s) => s.changed > 8),
        JSON.stringify({ scenario, profile }),
      );
      assert.equal(profile.outside, 0);
      assert.deepEqual(await saved(page), { ...defaults, profile: "simple" });
      await page.getByLabel("Refraction profile", { exact: true }).selectOption("edge");
      await redraw(page);
      assert.equal(
        (await difference(page, "edgeProfile", family)).allChanged,
        0,
        "Edge/simple/edge must restore the exact baseline",
      );
      receipt.controls.profile = profile;
      await snapshot(page, "matteOn");
      await page.getByRole("button", { name: "Disable matte glass", exact: true }).click();
      await redraw(page);
      assert.equal(await page.getByLabel("Frosting amount", { exact: true }).isDisabled(), true);
      const matte = await difference(page, "matteOn", family);
      assert.ok(
        matte.surfaces.every((s) => s.changed > 8),
        JSON.stringify({ scenario, matte }),
      );
      assert.equal(matte.outside, 0);
      assert.deepEqual(await saved(page), { ...defaults, matte: false });
      await page.getByRole("button", { name: "Enable matte glass", exact: true }).click();
      await redraw(page);
      assert.equal(
        (await difference(page, "matteOn", family)).allChanged,
        0,
        "Matte roundtrip must restore exact pixels",
      );
      receipt.controls.matte = matte;
      assert.deepEqual(
        await hostState(page, family),
        preserved,
        "Material tuning must preserve content, geometry, semantic cues and sharp fields",
      );
      assert.deepEqual(
        await gameState(page),
        canonical,
        "Glass controls must not change canonical game/setup/events",
      );
      assert.equal(
        await page.evaluate(() => window.sharedProbe.contexts.size),
        1,
        "Tuning must reuse the one shared GL context",
      );
      await page.evaluate(() => {
        window.sharedProbe.pattern = false;
      });
      await redraw(page);
      await page.getByRole("button", { name: "Close developer menu", exact: true }).click();
      await page.screenshot({
        path: join(evidence, `${config.name}-shared-${scenario}-enhanced.png`),
      });
      const enhancedHostImage = await page
        .locator(`[data-player-glass="${family}"]:not(.dev-menu-actions *)`)
        .first()
        .screenshot();
      await openControls(page);
      await page.getByRole("button", { name: "Disable enhanced glass", exact: true }).click();
      await page.waitForFunction(
        () => document.querySelector(".app-shell")?.dataset.glassStatus === "off",
      );
      assert.equal(await page.locator(".glass-scene-canvas").count(), 0);
      const fallback = await page
        .locator(`[data-player-glass="${family}"]:not(.dev-menu-actions *)`)
        .evaluateAll((nodes) =>
          nodes.map((node) => ({
            marked: node.dataset.glassPainted,
            fallback: node.firstElementChild?.classList.contains("liquid-card-glass"),
            display: getComputedStyle(node.firstElementChild).display,
            opacity: getComputedStyle(node.firstElementChild).opacity,
          })),
        );
      assert.ok(
        fallback.length &&
          fallback.every(
            (s) => s.marked !== "true" && s.fallback && s.display !== "none" && s.opacity !== "0",
          ),
        JSON.stringify(fallback),
      );
      assert.deepEqual(await saved(page), { ...defaults, enabled: false });
      await page.getByRole("button", { name: "Close developer menu", exact: true }).click();
      await page.screenshot({
        path: join(evidence, `${config.name}-shared-${scenario}-fallback.png`),
      });
      receipt.controls.enabled = {
        screenshotPixels: screenshotDelta(
          enhancedHostImage,
          await page
            .locator(`[data-player-glass="${family}"]:not(.dev-menu-actions *)`)
            .first()
            .screenshot(),
        ),
      };
      assert.ok(
        receipt.controls.enabled.screenshotPixels > 8,
        "Enhanced toggle must change actual visible card pixels",
      );
      if (scenario === "availability") {
        receipt.noAvailabilityFire = {};
        for (const mode of ["legacy", "vgpu"]) {
          if (mode === "vgpu") {
            await openControls(page);
            await page.getByRole("button", { name: "Enable Raytracing", exact: true }).click();
            await page.getByRole("button", { name: "Close developer menu", exact: true }).click();
            await settle(page);
          }
          const noFire = await page.locator(".availability-player-card").evaluateAll((nodes) =>
            nodes.map((node) => ({
              gpu: node.querySelectorAll(".vgpu-player-lighting,canvas").length,
              before: getComputedStyle(node, "::before").animationName,
              after: getComputedStyle(node, "::after").animationName,
              classes: node.className,
            })),
          );
          assert.ok(
            noFire.length &&
              noFire.every(
                (s) => s.gpu === 0 && !/fire|mafia/.test(s.before + s.after + s.classes),
              ),
            JSON.stringify(noFire),
          );
          receipt.noAvailabilityFire[mode] = noFire;
        }
      }
      await openControls(page);
      await page.getByRole("button", { name: "Reset glass settings", exact: true }).click();
      await page.waitForFunction(
        () => document.querySelector(".app-shell")?.dataset.glassStatus === "ready",
      );
      assert.deepEqual(
        await saved(page),
        defaults,
        "Reset must enable rendering and restore every field",
      );
      await page.getByRole("button", { name: "Close developer menu", exact: true }).click();
      receipt.interactions = await verifyInteractions(page, scenario);
      // Reset remains ON after removing the fixture's temporary access grant.
      // It must not depend on reopening or retaining any developer controls.
      await page.evaluate(() => {
        localStorage.removeItem("mafia-dashboard.developer-unlocked.v1");
        localStorage.removeItem("mafia-dashboard.developer-mode.v1");
      });
      await page.reload();
      await page.waitForFunction(
        () => document.querySelector(".app-shell")?.dataset.glassStatus === "ready",
      );
      assert.equal(await page.getByRole("button", { name: "Open developer menu" }).count(), 0);
      assert.deepEqual(await saved(page), defaults);
      receipt.resetWithoutDeveloperAccess = "ready after reload with no access/menu";
      assert.equal(
        hostContractError,
        null,
        "Paint/fallback contract failed earlier in this scenario",
      );
      assert.deepEqual(errors, []);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      receipt.status = "passed";
      console.log("SHARED GLASS PASS", config.name, scenario);
    } catch (error) {
      receipt.status = "failed";
      receipt.error = error.message;
      await page.screenshot({
        path: join(evidence, `${config.name}-shared-${scenario}-failure.png`),
      });
      throw error;
    } finally {
      await page.close();
    }
  }
}
