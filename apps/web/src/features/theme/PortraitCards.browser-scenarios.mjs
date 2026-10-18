/* global document, window, localStorage, getComputedStyle, requestAnimationFrame, HTMLCanvasElement, WebGLRenderingContext, innerWidth, queueMicrotask, HTMLInputElement, Event, URL, Response */
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

const selector = ".game-shell .table-stage .seat-anchor > .player-seat";
const seat = (page, n) =>
  page.locator(`${selector}`).filter({
    has: page.locator(`.card-index .seat-number`).filter({ hasText: new RegExp(`^${n}$`) }),
  });
const state = (page) =>
  page.evaluate(
    () => JSON.parse(localStorage.getItem("mafia-dashboard.game-session.v5")).current.state,
  );
const settle = (page) =>
  page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
const overlaps = (a, b) =>
  Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
  Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;

async function layout(page) {
  return page.locator(selector).evaluateAll((nodes) =>
    nodes.map((node) => {
      const r = (el) => el.getBoundingClientRect().toJSON();
      return {
        seat: Number(node.parentElement.dataset.seat),
        card: r(node),
        workspace: r(node.closest(".table-workspace")),
        role: r(node.querySelector(".player-role-icon")),
        name: r(node.querySelector(".seat-name")),
        indices: [...node.querySelectorAll(".card-index")].map((el) => ({
          rect: r(el),
          text: el.textContent,
          transform: getComputedStyle(el).transform,
          hidden: el.getAttribute("aria-hidden"),
        })),
        markers: [...node.querySelectorAll(".card-status-slot")].map((el) => ({
          rect: r(el),
          label: el.getAttribute("aria-label"),
        })),
        aspect: node.offsetWidth / node.offsetHeight,
        scale: node.getBoundingClientRect().width / node.offsetWidth,
        filter: getComputedStyle(node.querySelector(".player-role-icon")).filter,
      };
    }),
  );
}
function assertLayout(cards, viewport) {
  assert.equal(cards.length, 10);
  for (const c of cards) {
    assert.ok(Math.abs(c.aspect - 5 / 7) < 0.015, `Portrait aspect seat ${c.seat}`);
    assert.equal(c.indices.length, 2);
    assert.equal(c.indices[0].text, c.indices[1].text);
    assert.equal(c.indices[1].transform, "matrix(-1, 0, 0, -1, 0, 0)");
    assert.equal(c.indices[0].hidden, "true");
    assert.equal(c.filter, "none");
    for (const m of c.markers)
      assert.equal(overlaps(m.rect, c.role), false, `Marker/artwork ${c.seat}`);
    if (viewport.width >= 700) {
      assert.ok(
        c.card.left >= c.workspace.left - 1 && c.card.right <= c.workspace.right + 1,
        `Horizontal clipping seat ${c.seat}`,
      );
      assert.ok(
        c.card.top >= c.workspace.top - 1 && c.card.bottom <= c.workspace.bottom + 1,
        `Vertical clipping seat ${c.seat}`,
      );
    }
  }
  for (let a = 0; a < cards.length; a++)
    for (let b = a + 1; b < cards.length; b++)
      assert.equal(
        overlaps(cards[a].card, cards[b].card),
        false,
        `Seat collision ${cards[a].seat}/${cards[b].seat}`,
      );
}
async function gpuSample(page, n) {
  await page.waitForFunction(() => window.portraitFrame);
  return page.evaluate(
    ({ selector, n }) => {
      const frame = window.portraitFrame;
      const card = document.querySelector(
        selector.replace(".seat-anchor >", `.seat-anchor[data-seat="${n}"] >`),
      );
      const rect = card.getBoundingClientRect();
      const canvas = document.querySelector(".glass-scene-canvas");
      const cr = canvas.getBoundingClientRect();
      const sx = frame.width / cr.width,
        sy = frame.height / cr.height;
      const samples = [];
      // Interior only: no border, text or outer semantic glow in this canvas.
      for (let y = 0.25; y <= 0.75; y += 0.1)
        for (let x = 0.25; x <= 0.75; x += 0.1) {
          const px = Math.floor((rect.left - cr.left + rect.width * x) * sx);
          const py = Math.floor(frame.height - (rect.top - cr.top + rect.height * y) * sy);
          const i = (py * frame.width + px) * 4;
          samples.push(...frame.pixels.slice(i, i + 4));
        }
      return samples;
    },
    { selector, n },
  );
}

// Extend only the runner's API fixture before render. The App alone owns state
// transitions; no localStorage/domain state is inserted after mounting.
async function installContinuityApi(page) {
  await page.addInitScript(() => {
    const gameId = "00000000-0000-4000-8000-000000000599";
    window.portraitApiRequests = [];
    let transport;
    Object.defineProperty(window, "fetch", {
      configurable: true,
      get: () => transport,
      set: (fixture) => {
        transport = async (input, options = {}) => {
          const path = new URL(input, window.location.origin).pathname;
          const method = options.method ?? "GET";
          const request = options.body ? JSON.parse(options.body) : null;
          window.portraitApiRequests.push({ path, method, body: request });
          if (
            (method === "POST" && path === "/api/game-sessions") ||
            path === `/api/game-sessions/${gameId}`
          ) {
            const stored = JSON.parse(localStorage.getItem("mafia-dashboard.game-session.v5"));
            const session = {
              gameId,
              clubId: "00000000-0000-4000-8000-000000000101",
              name: request?.name ?? stored?.current?.name ?? "Portrait continuity",
              hostName: "Portrait fixture host",
              status: "active",
              revision: method === "POST" ? 1 : (stored?.revision ?? 1) + 1,
              appliedOperationId: request?.mutationId ?? null,
              results: null,
              createdAt: "2026-10-15T00:00:00.000Z",
              updatedAt: "2026-10-15T00:00:00.000Z",
              state: request?.state ?? stored?.current?.state,
            };
            return new Response(JSON.stringify(method === "GET" ? { session } : session), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          const response = await fixture(input, options);
          if (path !== "/api/players" || method !== "GET") return response;
          const body = await response.json();
          body.players.push({
            ...body.players[0],
            id: "00000000-0000-4000-8000-000000000011",
            nickname: "Portrait fixture host",
          });
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        };
      },
    });
  });
}

async function verifySuitContinuity(page, result, screenshot, ru, baselineSuits) {
  const envelope = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem("mafia-dashboard.game-session.v5")));
  const suitMap = async (players, scope = selector) => {
    const values = await page.locator(scope).evaluateAll((nodes) =>
      nodes.map((node) => ({
        seat: Number(node.closest(".seat-anchor").dataset.seat),
        suits: [...node.querySelectorAll(".card-suit")].map((el) => el.textContent),
      })),
    );
    assert.equal(values.length, 10);
    return Object.fromEntries(
      values.map(({ seat, suits }) => {
        assert.equal(suits.length, 2);
        assert.equal(suits[0], suits[1]);
        assert.match(suits[0], /^[♠♥♦♣]$/);
        return [players.find((p) => p.seat === seat).id, suits[0]];
      }),
    );
  };
  const before = await state(page);
  const oldGameId = (await envelope()).gameId;
  const original = await suitMap(before.game.players);
  assert.equal(await page.locator(selector + ' .player-role-icon[role="img"]').count(), 10);
  await page.locator(".privacy-button").click();
  assert.equal(await page.locator(selector + ' .player-role-icon[role="img"]').count(), 0);
  assert.deepEqual(await state(page), before, "Day privacy is presentation-only");
  const previewSequence = before.events.at(-1).sequence;
  await page
    .getByRole("button", { name: ru ? "Открыть журнал игры" : "Open game log", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: ru
        ? `Просмотреть состояние после записи журнала №${previewSequence}`
        : `Preview state after log #${previewSequence}`,
      exact: true,
    })
    .click();
  const exitPreview = page.getByRole("button", {
    name: ru ? "Выйти из просмотра" : "Exit preview",
    exact: true,
  });
  await exitPreview.waitFor();
  await settle(page);
  assert.deepEqual(await state(page), before, "Event preview never changes canonical state");
  assert.deepEqual(await suitMap(before.game.players), original, "Preview keeps game/player suits");
  assert.equal(await page.locator(selector + " .role-badge").count(), 0);
  assert.equal(
    await page.locator(selector + ' .player-role-icon[role="img"]').count(),
    0,
    "Masked event preview conceals actual role artwork",
  );
  const previewBox = await seat(page, 2).boundingBox();
  await page.mouse.click(previewBox.x + previewBox.width / 2, previewBox.y + previewBox.height / 2);
  await settle(page);
  assert.deepEqual(
    await state(page),
    before,
    "Native preview-card click has no mutation authority",
  );
  await screenshot("event-preview");
  await exitPreview.click();
  await exitPreview.waitFor({ state: "detached" });
  assert.deepEqual(await state(page), before);
  assert.deepEqual(await suitMap(before.game.players), original);

  await page
    .getByRole("button", {
      name: ru ? "Отменить последнее действие" : "Undo last action",
      exact: true,
    })
    .click();
  await page.waitForFunction(
    (head) =>
      JSON.parse(localStorage.getItem("mafia-dashboard.game-session.v5")).current.state
        .headEventId !== head,
    before.headEventId,
  );
  const undone = await state(page);
  assert.equal(
    undone.events.length,
    before.events.length - 1,
    "Undo rewinds exactly one accepted event",
  );
  assert.equal(undone.headEventId, before.events.at(-2).id);
  assert.deepEqual(undone.game.nominations, []);
  assert.deepEqual(await suitMap(undone.game.players), original, "Undo does not redeal decoration");
  assert.deepEqual(await page.locator(selector + " .card-suit").allTextContents(), baselineSuits);
  await screenshot("undo");
  const forbiddenKeys = /^(suit|cardSuit|cardDecoration|roleIcon|roleArtwork)$/;
  const assertNoDecorativeState = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(
        forbiddenKeys.test(key),
        false,
        `Presentation key leaked into canonical state: ${key}`,
      );
      assertNoDecorativeState(child);
    }
  };
  assertNoDecorativeState(undone);

  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: ru ? "Открыть меню управления" : "Open Manage menu", exact: true })
    .click();
  await page
    .getByRole("button", { name: ru ? "Начать новую игру" : "Start new game", exact: true })
    .click();
  await page.locator(".availability-player-card").first().waitFor();
  for (const player of await page.locator(".availability-player-card").all())
    if ((await player.getAttribute("aria-pressed")) !== "true") await player.click();
  await page.locator(".availability-close-button").click();
  await page.locator("#host-player").click();
  await page.locator(".setup-player-popup input[type=search]").fill("Portrait fixture host");
  await page.getByRole("option", { name: "Portrait fixture host", exact: true }).click();
  // Choose each original identity explicitly; random filling would change the mapping.
  for (let n = 1; n <= 10; n++) {
    await page.locator(`#seat-${n}-player`).click();
    // The accessible option label is the current fixture profile's long nickname.
    const label = ((ru ? "Очень длинное имя игрока " : "A very long English nickname ") + n).slice(
      0,
      32,
    );
    await page.locator(".setup-player-popup input[type=search]").fill(label);
    await page.getByRole("option", { name: label, exact: true }).click();
  }
  await page.getByRole("button", { name: ru ? "Начать игру" : "Start game", exact: true }).click();
  const roleSelector = ".role-draw-screen .seat-anchor > .player-seat";
  await page.locator(roleSelector).first().waitFor();
  const created = await envelope();
  assert.equal(created.gameId, "00000000-0000-4000-8000-000000000599");
  assert.notEqual(created.gameId, oldGameId);
  const roleSetup = created.current.state.setup.setup;
  const nextSuits = await suitMap(roleSetup.players, roleSelector);
  assert.ok(
    Object.keys(original).some((id) => original[id] !== nextSuits[id]),
    "New server game ID changes its deterministic suit vector",
  );
  assert.deepEqual(
    roleSetup.players.map((p) => p.id),
    before.game.players.map((p) => p.id),
  );
  assert.equal(
    Object.keys(roleSetup.assignments).length,
    0,
    "Observing new-game decoration does not deal a role",
  );
  assertNoDecorativeState(created.current.state);
  assert.equal(await page.locator(roleSelector + " .role-badge").count(), 0);
  await screenshot("new-game-undealt");
  result.fixtureRequests = await page.evaluate(() => window.portraitApiRequests);
  await page.reload();
  await page.locator(roleSelector).first().waitFor();
  await settle(page);
  const restored = await envelope();
  assert.equal(restored.gameId, created.gameId);
  assert.deepEqual(restored.current.state, created.current.state);
  assert.deepEqual(
    await suitMap(roleSetup.players, roleSelector),
    nextSuits,
    "New-game reload preserves suits per player",
  );
  // Deliberate giveaway and night remain positive role-artwork surfaces, including
  // when the ordinary daytime privacy toggle is enabled.
  if ((await page.locator(".privacy-button").getAttribute("aria-pressed")) !== "true")
    await page.locator(".privacy-button").click();
  assert.equal(await page.locator(roleSelector + ' .player-role-icon[role="img"]').count(), 0);
  for (let n = 1; n <= 10; n++) {
    await page.locator(`.role-draw-screen .seat-anchor[data-seat="${n}"] > .player-seat`).click();
    await page.waitForFunction(
      (count) =>
        Object.keys(
          JSON.parse(localStorage.getItem("mafia-dashboard.game-session.v5")).current.state.setup
            .setup.assignments,
        ).length === count,
      n,
    );
  }
  assert.equal(await page.locator(roleSelector + ' .player-role-icon[role="img"]').count(), 10);
  assert.equal(await page.locator(roleSelector + " .role-badge").count(), 0);
  assert.deepEqual(await suitMap(roleSetup.players, roleSelector), nextSuits);
  await screenshot("new-game-giveaway");
  await page
    .getByRole("button", {
      name: ru ? "Начать этап планирования мафии" : "Begin Mafia planning stage",
      exact: true,
    })
    .click();
  await page.locator(".game-shell.phase-mafia-planning").waitFor();
  assert.equal(await page.locator(selector + ' .player-role-icon[role="img"]').count(), 10);
  assert.equal(await page.locator(selector + " .role-badge").count(), 0);
  assert.deepEqual(await suitMap(roleSetup.players), nextSuits);
  assertNoDecorativeState(await state(page));
  await screenshot("new-game-night");
  result.continuity = {
    oldGameId,
    newGameId: created.gameId,
    original,
    newGame: nextSuits,
    previewSequence,
    undoHead: undone.headEventId,
  };
  result.fixtureRequests.push(...(await page.evaluate(() => window.portraitApiRequests)));
  assert.equal(
    result.fixtureRequests.filter((r) => r.method === "POST" && r.path === "/api/game-sessions")
      .length,
    1,
  );
  result.checks.push(
    "real App event preview/cancel is immutable; Undo rewinds one event without suit changes; native new-game/setup gets new server game ID and stable new suits through reload, without canonical presentation keys",
  );
}

export async function verifyPortraitCards({ browser, config, url, evidence, results }) {
  for (const mode of [
    "enhanced",
    "fallback",
    "css",
    ...(config.name.startsWith("chrome") ? ["reduced-transparency"] : []),
  ]) {
    const page = await browser.newPage({
      viewport: config.viewport,
      screen: config.viewport,
      deviceScaleFactor: 2,
      hasTouch: true,
      reducedMotion: "reduce",
    });
    if (mode === "reduced-transparency") {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-reduced-transparency", value: "reduce" },
          { name: "prefers-reduced-motion", value: "reduce" },
        ],
      });
    }
    page.setDefaultTimeout(8000);
    const result = {
      scenario: "portrait-cards",
      engine: config.name,
      mode,
      viewport: config.viewport,
      status: "running",
      screenshots: [],
      checks: [],
      errors: [],
    };
    results.push(result);
    const continuity = mode === "css" && ["chrome-landscape", "webkit-ipad"].includes(config.name);
    if (continuity) await installContinuityApi(page);
    page.on("pageerror", (e) => result.errors.push(e.message));
    await page.route("**/*", (route) =>
      route
        .request()
        .url()
        .startsWith(url + "/")
        ? route.continue()
        : route.abort(),
    );
    await page.addInitScript(
      ({ mode }) => {
        localStorage.setItem("mafia-dashboard.developer-unlocked.v1", "unlocked");
        localStorage.setItem("mafia-dashboard.developer-mode.v1", "enabled");
        if (mode === "fallback") {
          const get = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
            return kind === "webgl" ? null : get.call(this, kind, ...args);
          };
        }
        const original = WebGLRenderingContext.prototype.drawArrays;
        WebGLRenderingContext.prototype.drawArrays = function (...args) {
          const result = original.apply(this, args);
          if (!window.portraitPending && this.canvas.classList.contains("glass-scene-canvas")) {
            window.portraitPending = true;
            queueMicrotask(() => {
              window.portraitPending = false;
              const pixels = new Uint8Array(this.canvas.width * this.canvas.height * 4);
              this.readPixels(
                0,
                0,
                this.canvas.width,
                this.canvas.height,
                this.RGBA,
                this.UNSIGNED_BYTE,
                pixels,
              );
              window.portraitFrame = {
                pixels,
                width: this.canvas.width,
                height: this.canvas.height,
              };
            });
          }
          return result;
        };
      },
      { mode },
    );
    const screenshot = async (name) => {
      const path = join(evidence, `${config.name}-${mode}-portrait-${name}.png`);
      await page.mouse.move(0, 0);
      await page.screenshot({ path, fullPage: true });
      result.screenshots.push(path);
    };
    try {
      const ru = config.name.includes("webkit");
      await page.goto(
        `${url}/?phase=player-cards&long-names${mode !== "css" ? "&fresh" : ""}${ru ? "&locale=ru" : ""}`,
      );
      await page.locator(selector).first().waitFor();
      await page.waitForFunction(() => !document.querySelector(".club-curtain-opening"));
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(
        () => document.querySelector(".game-shell .seat-name")?.textContent.length > 20,
      );
      await settle(page);
      await screenshot("initial");
      result.layout = await layout(page);
      assertLayout(result.layout, config.viewport);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      result.checks.push(
        "ten 5:7 cards, opposite decorative indices, no neighbour/workspace clipping or marker/artwork collisions",
      );
      const before = await state(page);
      const baselineSuits = await page.locator(selector + " .card-suit").allTextContents();
      result.gameIdentityConnected = baselineSuits.some((suit) => suit !== "◇");
      await seat(page, 2).tap();
      await page.waitForFunction(
        () =>
          document
            .querySelector('.game-shell .seat-anchor[data-seat="2"] > .player-seat')
            ?.getAttribute("aria-pressed") === "true",
      );
      await settle(page);
      assert.equal(
        await page.locator(selector + " .card-selection," + selector + " .role-badge").count(),
        0,
      );
      assert.equal(await seat(page, 2).locator(".card-nomination-symbol .lucide-hand").count(), 1);
      result.glassStatus = await page.locator(".app-shell").getAttribute("data-glass-status");
      if (mode === "enhanced")
        await page.waitForFunction(
          () => document.querySelector(".app-shell")?.dataset.glassStatus === "ready",
        );
      else
        assert.equal(
          result.glassStatus,
          mode === "fallback" ? "unavailable" : mode === "css" ? "off" : "reduced-transparency",
        );
      await screenshot("selected");
      result.checks.push(
        "trusted whole-card nomination retains pressed state with fixed slim hand and no role/check pill",
      );
      // Probe only material presentation on one already nominated card. Canonical state is unchanged.
      const selectedState = await state(page);
      for (const frosting of [0, 50, 100]) {
        if (mode === "css" && frosting !== 50) continue;
        if (mode !== "css") {
          await page
            .getByRole("button", {
              name: ru ? "Открыть меню разработчика" : "Open developer menu",
              exact: true,
            })
            .click();
          if (!(await page.locator(".dev-glass-controls").evaluate((el) => el.open)))
            await page.locator(".dev-glass-controls > summary").click();
          if (!(await page.locator(".dev-glass-advanced").evaluate((el) => el.open)))
            await page.locator(".dev-glass-advanced > summary").click();
          await page
            .getByLabel(ru ? "Степень матовости" : "Frosting amount", { exact: true })
            .evaluate((input, value) => {
              Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(
                input,
                String(value),
              );
              input.dispatchEvent(new Event("input", { bubbles: true }));
              input.dispatchEvent(new Event("change", { bubbles: true }));
            }, frosting);
          const matte = page.getByRole("button", { name: ru ? /матовое стекло/ : /matte glass/ });
          if (((await matte.getAttribute("aria-pressed")) === "true") !== (frosting !== 0))
            await matte.click();
          await page
            .getByRole("button", {
              name: ru ? "Закрыть меню разработчика" : "Close developer menu",
              exact: true,
            })
            .click();
          await page.waitForFunction(
            ({ frosting }) =>
              JSON.parse(localStorage.getItem("mafia-dashboard.glass.v1")).frosting === frosting,
            { frosting },
          );
        }
        await seat(page, 2).evaluate((el) => el.classList.remove("is-nomination-selected"));
        await settle(page);
        const normal =
          mode === "enhanced"
            ? await gpuSample(page, 2)
            : await seat(page, 2)
                .locator(".liquid-card-glass__backdrop")
                .evaluate((el) => ({
                  filter: getComputedStyle(el).backdropFilter,
                  veil: getComputedStyle(el, "::before").backgroundColor,
                }));
        if (frosting === 50) await screenshot("finish-off");
        const neighbor = mode === "enhanced" ? await gpuSample(page, 3) : null;
        await seat(page, 2).evaluate((el) => el.classList.add("is-nomination-selected"));
        await settle(page);
        const selected =
          mode === "enhanced"
            ? await gpuSample(page, 2)
            : await seat(page, 2)
                .locator(".liquid-card-glass__backdrop")
                .evaluate((el) => ({
                  filter: getComputedStyle(el).backdropFilter,
                  veil: getComputedStyle(el, "::before").backgroundColor,
                }));
        if (frosting === 50) await screenshot("finish-on");
        assert.notDeepEqual(normal, selected, "Actual selected material must differ");
        if (mode === "enhanced")
          assert.deepEqual(await gpuSample(page, 3), neighbor, "Neighbour shader pixels unchanged");
        result[`material${frosting}`] = { normal, selected };
      }
      assert.deepEqual(await state(page), selectedState);
      result.checks.push(
        "isolated selected material has real GPU readback/fallback filter difference; neighbour GPU pixels and canonical state unchanged",
      );
      await page.reload();
      await page.locator(selector).first().waitFor();
      await settle(page);
      assert.deepEqual(
        await page.locator(selector + " .card-suit").allTextContents(),
        baselineSuits,
      );
      assert.equal((await state(page)).events.length, before.events.length + 1);
      await screenshot("reload");
      result.checks.push(
        "decorative indices stable through canonical nomination and reload; one accepted event only",
      );
      assert.equal(
        result.gameIdentityConnected,
        true,
        "Parent integration required: App must provide the rendered server game ID through CardGameIdentityContext",
      );
      result.checks.push("real rendered game uses non-neutral deterministic suits");
      if (continuity) await verifySuitContinuity(page, result, screenshot, ru, baselineSuits);
      assert.deepEqual(result.errors, []);
      result.status = "passed";
    } catch (e) {
      result.status = "failed";
      result.failure = e.stack;
      await screenshot("failure");
    } finally {
      await writeFile(
        join(evidence, `${config.name}-${mode}-portrait.json`),
        JSON.stringify(result, null, 2),
      );
      await page.close();
    }
  }
}

/** Independent phase qualification: no API writes or gameplay mutations. */
export async function verifyPortraitNightLayout({ browser, config, url, evidence, results }) {
  const page = await browser.newPage({
    viewport: config.viewport,
    screen: config.viewport,
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
  });
  const result = {
    scenario: "portrait-night-actions",
    engine: config.name,
    status: "running",
    checks: [],
  };
  results.push(result);
  await page.route("**/*", (route) =>
    route
      .request()
      .url()
      .startsWith(url + "/")
      ? route.continue()
      : route.abort(),
  );
  try {
    await page.goto(`${url}/?phase=night&long-names&fresh`);
    await page.locator(".game-shell.phase-night-mafia").waitFor();
    await page.waitForFunction(
      () => document.querySelector(".game-shell .seat-name")?.textContent.length > 20,
    );
    await page.waitForFunction(() => !document.querySelector(".club-curtain-opening"));
    await page.evaluate(() => document.fonts.ready);
    await settle(page);
    result.layout = await layout(page);
    result.actions = await page.locator(".game-shell .seat-actions > button").evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return {
          seat: Number(node.closest(".seat-anchor").dataset.seat),
          label: node.getAttribute("aria-label"),
          rect: rect.toJSON(),
          hit: node === hit || node.contains(hit),
        };
      }),
    );
    result.screenshot = join(evidence, `${config.name}-portrait-night-actions.png`);
    await page.screenshot({ path: result.screenshot, fullPage: true });
    assertLayout(result.layout, config.viewport);
    assert.equal(
      result.actions.length,
      30,
      "All three native shooter controls on all ten real target cards",
    );
    for (const action of result.actions) {
      assert.equal(
        action.hit,
        true,
        `Night shooter action occluded, seat ${action.seat}: ${action.label}`,
      );
      for (const other of result.layout)
        if (other.seat !== action.seat)
          assert.equal(
            overlaps(action.rect, other.card),
            false,
            `Night action overlaps card ${other.seat}, action seat ${action.seat}`,
          );
      const workspace = result.layout.find((c) => c.seat === action.seat).workspace;
      assert.ok(
        action.rect.left >= workspace.left - 1 && action.rect.right <= workspace.right + 1,
        `Night action outside table horizontally, seat ${action.seat}`,
      );
      assert.ok(
        action.rect.top >= workspace.top - 1 && action.rect.bottom <= workspace.bottom + 1,
        `Night action outside table vertically, seat ${action.seat}`,
      );
    }
    result.checks.push(
      "ten portrait night targets and thirty unoccluded native shooter controls stay inside table workspace",
    );
    result.status = "passed";
  } catch (e) {
    result.status = "failed";
    result.failure = e.stack;
  } finally {
    await writeFile(
      join(evidence, `${config.name}-portrait-night-actions.json`),
      JSON.stringify(result, null, 2),
    );
    await page.close();
  }
}
