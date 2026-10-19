/* global window, document, getComputedStyle, innerWidth, innerHeight, localStorage, Response, URL, requestAnimationFrame */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { validateGlassSettings } from "./glass-preferences.ts";

const glassKey = "mafia-dashboard.glass.v1";
const sessionKey = "mafia-dashboard.game-session.v5";
const settle = (page) =>
  page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
// The owner intentionally seeds a partial legacy preference; compare effective
// validated settings, not absent properties against their persisted defaults.
const saved = async (page) =>
  validateGlassSettings(
    await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), glassKey),
  );
const withoutButtons = (settings) =>
  Object.fromEntries(
    Object.entries(settings).filter(([key]) => !["buttonFrosting", "buttonGold"].includes(key)),
  );

// Observe only: never focus/blur, dispatch a DOM event, or assign scrolling.
async function inspect(page) {
  return page.evaluate(() => {
    const css = (node, pseudo) => {
      if (!node) return null;
      const s = getComputedStyle(node, pseudo);
      return Object.fromEntries(
        [
          "display",
          "position",
          "zIndex",
          "content",
          "backgroundImage",
          "backgroundColor",
          "backgroundSize",
          "backgroundPosition",
          "opacity",
          "filter",
          "backdropFilter",
          "webkitBackdropFilter",
          "overflowY",
          "touchAction",
          "borderColor",
          "color",
          "boxShadow",
          "pointerEvents",
          "top",
          "right",
          "bottom",
          "left",
        ].map((key) => [key, s[key]]),
      );
    };
    const selectors = [
      ".app-shell",
      ".setup-shell",
      ".player-setup-card",
      ".availability-selection-card",
      ".live-side-panel",
      ".players-shell",
      ".statistics-screen",
      ".app-shell > div:has(> .statistics-screen)",
      ".statistics-screen > section:last-of-type",
      ".youtube-dock",
      ".setup-player-popup",
      ".app-status-bar",
      ".app-fixed-toolbar",
    ];
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        x: window.scrollX,
        y: window.scrollY,
      },
      glass: { ...document.querySelector(".app-shell")?.dataset },
      active: {
        tag: document.activeElement?.tagName,
        id: document.activeElement?.id,
        label: document.activeElement?.getAttribute("aria-label"),
        editable: document.activeElement?.matches("input,textarea,[contenteditable=true]"),
      },
      nodes: Object.fromEntries(
        selectors.map((selector) => {
          const node = document.querySelector(selector);
          return [
            selector,
            node
              ? {
                  rect: node.getBoundingClientRect().toJSON(),
                  css: css(node),
                  before: css(node, "::before"),
                  after: css(node, "::after"),
                  top: node.scrollTop,
                  client: node.clientHeight,
                  scroll: node.scrollHeight,
                  html: node.outerHTML.slice(0, 1600),
                }
              : null,
          ];
        }),
      ),
    };
  });
}

async function buttonStyle(locator) {
  return locator.evaluate((node) => {
    const s = getComputedStyle(node);
    return {
      tag: node.tagName,
      disabled: node.disabled,
      pressed: node.getAttribute("aria-pressed"),
      hover: node.matches(":hover"),
      active: node.matches(":active"),
      opacity: s.opacity,
      pointerEvents: s.pointerEvents,
      color: s.color,
      border: s.borderColor,
      background: s.backgroundImage,
      filter: s.filter,
      backdrop: s.backdropFilter || s.webkitBackdropFilter,
      frost: s.getPropertyValue("--button-glass-frost"),
      gold: s.getPropertyValue("--button-glass-gold"),
    };
  });
}

async function rules(page) {
  await page.getByRole("button", { name: "Rules", exact: true }).tap();
  const reader = page.locator("dialog.rules-sketchbook[open]");
  await reader.waitFor();
  assert.ok(await reader.locator(".rs-close").isVisible(), "Rules Close is usable");
  await reader.locator(".rs-close").tap();
  await page.locator("dialog.rules-sketchbook[open]").waitFor({ state: "detached" });
}

export async function menu(page, name, locale = "en") {
  await page
    .getByRole("button", {
      name: locale === "ru" ? "Открыть меню управления" : "Open Manage menu",
      exact: true,
    })
    .tap();
  await page.getByRole("button", { name, exact: true }).tap();
}

async function openGlass(page) {
  await page.getByRole("button", { name: "Open developer menu", exact: true }).tap();
  const disclosure = page.locator(".dev-glass-controls");
  if (!(await disclosure.evaluate((node) => node.open)))
    await disclosure.locator(":scope > summary").tap();
  const buttons = disclosure
    .locator("details")
    .filter({ has: page.locator("input[aria-label='Button frosting']") });
  if (!(await buttons.evaluate((node) => node.open)))
    await buttons.locator(":scope > summary").tap();
}

async function nativeRange(page, label, fraction) {
  const control = page.getByRole("slider", { name: label, exact: true });
  await control.scrollIntoViewIfNeeded();
  const before = await control.inputValue();
  const b = await control.boundingBox();
  await page.mouse.click(b.x + 8 + (b.width - 16) * fraction, b.y + b.height / 2);
  await page.waitForFunction(
    ({ label, before }) => document.querySelector(`input[aria-label="${label}"]`).value !== before,
    { label, before },
  );
  return Number(await control.inputValue());
}

export async function wheelToEnd(page, selector, lastSelector) {
  const wheel = await nativeEnd(page, selector, lastSelector, "wheel-end");
  let touch = null;
  if (page.context().browser().browserType().name() === "chromium") {
    // Independent start: do not credit touch's movement to the wheel oracle.
    await page
      .locator(lastSelector)
      .first()
      .evaluate((node) => node.scrollIntoView({ block: "start" }));
    const cdp = await page.context().newCDPSession(page);
    try {
      touch = await nativeEnd(page, selector, lastSelector, "touch", cdp);
    } finally {
      await cdp.detach();
    }
  }
  return { ...wheel, touch };
}

// The owning bundle has the real ClubWorkspace and synthetic API/identity only.
// Add the missing populated read-only statistics response to its existing fetch
// fixture; leave application transport and every rendering component untouched.
export async function statisticsFixture(page) {
  await page.evaluate(() => {
    const original = window.fetch;
    const totals = { games: 3, outcomeGames: 3, wins: 1, draws: 1, losses: 1, winRate: 33.3 };
    const players = Array.from({ length: 36 }, (_, i) => ({
      playerId: `00000000-0000-4000-8000-${String(i + 501).padStart(12, "0")}`,
      nickname: `Statistics fixture ${String(i + 1).padStart(2, "0")}`,
      totals,
      teams: { red: totals, black: totals },
      roles: { citizen: totals, sheriff: totals, mafia: totals, don: totals },
      fouls: 0,
      foulGames: 0,
      foulsPerGame: 0,
      statusGames: 3,
      redCards: 0,
      eliminations: 0,
      bestMoveResults: 0,
      bestMoveHits: 0,
      bestMoveMean: null,
      hostedGames: 0,
      lastHostedAt: null,
      lastPlayedAt: "2026-10-15T00:00:00Z",
      recentForm: ["win", "draw", "loss"],
      rating: {
        algorithm: "club-team-elo-v1",
        value: 1500,
        ratedGames: 3,
        status: "provisional",
        rank: null,
        lastChange: 0,
      },
      scopedRatingChange: 0,
      scopedRatedGames: 3,
    }));
    window.hostUiStatisticsRequests = [];
    window.fetch = async (url, options = {}) => {
      const path = new URL(url, window.location.origin).pathname;
      const player = players.find(({ playerId }) => path === `/api/statistics/players/${playerId}`);
      if (["/api/statistics", "/api/tournaments"].includes(path) || player) {
        if ((options.method ?? "GET") !== "GET")
          throw new Error("Host UI statistics fixture is read-only");
        window.hostUiStatisticsRequests.push(
          `${path}${new URL(url, window.location.origin).search}`,
        );
        // Match getPlayerStatistics / StatisticsScreen's real detail contract.
        const cursor = new URL(url, window.location.origin).searchParams.get("cursor");
        if (cursor !== null && cursor !== "host-ui-next")
          throw new Error("Unexpected history cursor");
        const total = player === players[33] ? 0 : player === players[34] ? 1 : 24;
        const history = player
          ? Array.from({ length: cursor ? 6 : Math.min(total, 18) }, (_, index) => {
              const i = index + (cursor ? 18 : 0);
              return {
                gameId: `00000000-0000-4000-8000-${String(i + 901).padStart(12, "0")}`,
                name: `Statistics history ${String(i + 1).padStart(2, "0")}`,
                playedAt: "2026-10-15T00:00:00Z",
                hasCasper: false,
                outcome: "red",
                reason: "Saved outcome",
                tournamentId: null,
                hostPlayerId: null,
                isHost: false,
                statisticsAvailable: true,
                timelineAvailable: false,
                participant: {
                  playerId: player.playerId,
                  seat: 1,
                  role: "citizen",
                  team: "red",
                  status: "eliminated",
                  fouls: 0,
                  bestMoveHits: null,
                },
                unratedReason: null,
                ratingChange: {
                  before: 1484,
                  after: 1500,
                  change: 16,
                  redAverage: 1500,
                  blackAverage: 1500,
                  expectedScore: 0.5,
                  score: 1,
                },
              };
            })
          : [];
        const body =
          path === "/api/tournaments"
            ? { tournaments: [] }
            : player
              ? {
                  player,
                  history,
                  nextCursor: total === 24 && !cursor ? "host-ui-next" : null,
                  total,
                }
              : {
                  players,
                  tournaments: [],
                  coverage: {
                    completedGames: 3,
                    partialGames: 0,
                    unavailableGames: 0,
                    pendingGames: 0,
                  },
                  algorithm: "club-team-elo-v1",
                };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return original(url, options);
    };
  });
}

const scrollState = (scroller) =>
  scroller.evaluate((node) => ({
    top: node.scrollTop,
    client: node.clientHeight,
    scroll: node.scrollHeight,
  }));

// Recompute clipped geometry and the real hit before EVERY input; stale table
// coordinates can otherwise drift into the gutter and falsely pass chaining.
async function gesturePoint(target) {
  const point = await target.evaluate((node) => {
    const r = node.getBoundingClientRect();
    let left = Math.max(1, r.left),
      right = Math.min(innerWidth - 1, r.right);
    let top = Math.max(1, r.top),
      bottom = Math.min(innerHeight - 1, r.bottom);
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const css = getComputedStyle(parent),
        box = parent.getBoundingClientRect();
      if (css.overflowX !== "visible") {
        left = Math.max(left, box.left);
        right = Math.min(right, box.right);
      }
      if (css.overflowY !== "visible") {
        top = Math.max(top, box.top);
        bottom = Math.min(bottom, box.bottom);
      }
    }
    for (const fx of [0.5, 0.2, 0.8])
      for (const fy of [0.5, 0.8, 0.2]) {
        const x = left + (right - left) * fx,
          y = top + (bottom - top) * fy;
        const hit = document.elementFromPoint(x, y);
        if (right - left > 4 && bottom - top > 4 && node.contains(hit))
          return { x, y, hit: hit.tagName, rect: { left, right, top, bottom } };
      }
    return null;
  });
  assert.ok(point, `Native gesture target is visible and unobstructed: ${target}`);
  return point;
}

const nestedScrollState = (target) =>
  target.evaluate((node) => {
    const table = node.closest(".statistics-table-scroll");
    return table
      ? { left: table.scrollLeft, width: table.scrollWidth, client: table.clientWidth }
      : null;
  });

async function nativeScrollStep(page, scroller, target, input, direction, cdp = null) {
  const point = await gesturePoint(target);
  const before = await scrollState(scroller);
  const nestedBefore = await nestedScrollState(target);
  await scroller.evaluate(
    (node, target) => {
      node.nativeTarget = target;
      node.nativeInput = null;
      if (node.nativeInputObserved) return;
      node.nativeInputObserved = true;
      for (const type of ["wheel", "touchstart"])
        node.addEventListener(
          type,
          (event) => {
            Promise.resolve().then(() => {
              node.nativeInput = {
                type,
                trusted: event.isTrusted,
                prevented: event.defaultPrevented,
                target: event.target.tagName,
                withinTarget: node.nativeTarget.contains(event.target),
                dispatchTop: node.scrollTop,
                dx: event.deltaX,
                dy: event.deltaY,
              };
            });
          },
          { passive: true },
        );
    },
    await target.elementHandle(),
  );
  if (input === "touch") {
    const box = await scroller.boundingBox();
    const distance = Math.min(
      320,
      direction > 0 ? point.y - box.y - 12 : box.y + box.height - point.y - 12,
    );
    assert.ok(distance >= 40, "Touch endpoints remain inside the scroll viewport");
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: point.x, y: point.y }],
    });
    for (let step = 1; step <= 8; step++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: point.x, y: point.y - (direction * distance * step) / 8 }],
      });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await page.mouse.move(point.x, point.y);
    assert.ok(
      await target.evaluate(
        (node, point) => node.contains(document.elementFromPoint(point.x, point.y)),
        point,
      ),
      "Exact target still owns the live hit immediately before native wheel delivery",
    );
    await page.mouse.wheel(
      input === "mixed" ? direction * 3 : 0,
      direction * (input === "mixed" ? 24 : input === "wheel-end" ? 1600 : 120),
    );
  }
  await page.waitForTimeout(120);
  // Wait for actual native momentum to settle; never assign a scroll offset.
  await scroller.evaluate(
    (node) =>
      new Promise((resolve) => {
        let last = node.scrollTop,
          stable = 0,
          frames = 0;
        const tick = () => {
          stable = Math.abs(last - node.scrollTop) < 0.1 ? stable + 1 : 0;
          last = node.scrollTop;
          if (stable >= 4 || ++frames >= 120) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
  const after = await scrollState(scroller);
  const event = await scroller.evaluate((node) => node.nativeInput);
  assert.equal(event?.trusted, true, "Native input actually delivered to scroll owner");
  assert.equal(event.prevented, false, "Native scroll input remains unprevented");
  // Passive compositor scrolling may move the target before wheel dispatch is
  // observed on the main thread. Judge initial ownership by the live pre-input
  // node-identity hit above, not by a tag or a post-scroll event target.
  const targetAfter = await target.evaluate((node) => {
    const r = node.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  });
  return {
    input,
    direction,
    point,
    event,
    before,
    after,
    targetAfter,
    nested: { before: nestedBefore, after: await nestedScrollState(target) },
  };
}

async function nativeEnd(page, selector, lastSelector, input, cdp = null) {
  const scroller = page.locator(selector),
    before = await scrollState(scroller);
  assert.ok(
    before.scroll > before.client + 1 && before.client <= page.viewportSize().height + 1,
    `${selector}: viewport-bounded native scroll owner`,
  );
  for (let attempt = 0; attempt < 50; attempt++) {
    const state = await scrollState(scroller);
    if (state.top + state.client >= state.scroll - 2) break;
    await nativeScrollStep(page, scroller, scroller, input, 1, cdp);
  }
  const after = await scrollState(scroller);
  assert.ok(after.top > before.top + 1, `${input} alone moves ${selector} toward bottom`);
  assert.ok(after.top + after.client >= after.scroll - 2, `${input} alone reaches actual bottom`);
  const lastTarget = page.locator(lastSelector).last();
  const last = await gesturePoint(lastTarget);
  assert.ok(
    await lastTarget.evaluate((node) => node.getBoundingClientRect().bottom <= innerHeight + 1),
    "Last content bottom remains inside the viewport",
  );
  return { input, before, after, last };
}

async function statisticsPlayerScroll(page, locale, capture, checks) {
  const ru = locale === "ru",
    screen = page.locator(".statistics-screen");
  const closeName = ru ? "Закрыть данные игрока" : "Close player details";
  const detail = page.locator(".statistics-player");
  checks.timelineReturn = "Not covered: fixture records have no timeline";
  checks.failures = [];
  const open = async (number, count) => {
    await page.getByRole("button", { name: `Statistics fixture ${number}`, exact: true }).tap();
    await page.waitForFunction(
      (count) =>
        document.querySelectorAll(".statistics-player .statistics-history-game").length === count &&
        !!document.querySelector(".statistics-rating-summary"),
      count,
    );
    assert.equal(
      await detail.getAttribute("aria-label"),
      `${ru ? "Данные игрока" : "Player details"}: Statistics fixture ${number}`,
    );
  };
  const position = async (target) => {
    // Arrangement only. Every movement oracle starts AFTER this positioning.
    await target.evaluate((node) => node.scrollIntoView({ block: "center", inline: "nearest" }));
    await page.waitForTimeout(120);
  };
  const probe = async (target, name, input, cdp = null, boundaryControl = false) => {
    for (const direction of [1, -1]) {
      await position(target);
      if (boundaryControl) {
        const table = detail.locator(".statistics-breakdowns .statistics-table-scroll").first();
        const point = await gesturePoint(table);
        await page.mouse.move(point.x, point.y);
        await page.mouse.wheel(direction * 5000, 0);
        await page.waitForTimeout(160);
        const edge = await nestedScrollState(target);
        assert.ok(
          direction > 0 ? edge.left >= edge.width - edge.client - 1 : edge.left <= 1,
          "Boundary control starts at the native horizontal endpoint",
        );
      }
      const result = await nativeScrollStep(page, screen, target, input, direction, cdp);
      checks.probes.push({ name, ...result });
      if (direction * (result.after.top - result.before.top) <= 1)
        checks.failures.push({ name, ...result });
    }
  };
  await open("36", 18);
  const targets = [
    [detail.locator(".statistics-rating-summary"), "summary"],
    [detail.locator(".statistics-breakdowns td").first(), "breakdown-cell"],
    [detail.locator(".statistics-history-game").first(), "history"],
  ];
  for (const [target, name] of targets) {
    await probe(target, name, "wheel");
    await probe(target, name, "mixed"); // Retain the reproduced (3,24) nested-cell stall.
  }
  await probe(targets[1][0], "breakdown-boundary-control", "mixed", null, true);
  const viewport = page.viewportSize();
  for (const breakdown of await detail.locator(".statistics-table-scroll").all())
    assert.ok(
      await breakdown.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
      "Player breakdowns do not inherit oversized leaderboard columns",
    );
  const table = page.locator(".statistics-table-scroll").first();
  const horizontalState = () =>
    table.evaluate((node) => ({
      left: node.scrollLeft,
      range: node.scrollWidth - node.clientWidth,
    }));
  if ((await horizontalState()).range <= 1)
    await page.setViewportSize({ width: 1000, height: 600 });
  await position(table);
  const horizontal = { viewport: page.viewportSize(), before: await horizontalState() };
  assert.ok(horizontal.before.range > 1, "Real leaderboard table overflows at compact width");
  for (const direction of [1, -1]) {
    const point = await gesturePoint(table);
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(direction * 300, 0);
    await page.waitForTimeout(160);
    horizontal[direction > 0 ? "right" : "left"] = await horizontalState();
  }
  assert.ok(
    horizontal.right.left > horizontal.before.left + 1,
    "Native horizontal table scrolling preserved",
  );
  assert.ok(horizontal.left.left < horizontal.right.left - 1, "Native horizontal return preserved");
  checks.horizontal = horizontal;
  await capture(`statistics-${locale}-horizontal-table`);
  await page.setViewportSize(viewport);
  await position(targets[0][0]);
  await capture(`statistics-${locale}-player-summary`);
  checks.wheelBottom = await nativeEnd(
    page,
    ".statistics-screen",
    ".statistics-history-game",
    "wheel-end",
  );
  await capture(`statistics-${locale}-history-bottom`);
  // Real pagination: native bottom first, then the supported load-more control.
  await detail
    .getByRole("button", { name: ru ? "Загрузить ещё игры" : "Load more games", exact: true })
    .tap();
  await page.waitForFunction(
    () => document.querySelectorAll(".statistics-history-game").length === 24,
  );
  assert.equal(
    await detail
      .getByRole("button", { name: ru ? "Загрузить ещё игры" : "Load more games", exact: true })
      .count(),
    0,
  );
  checks.pagedBottom = await nativeEnd(
    page,
    ".statistics-screen",
    ".statistics-history-game",
    "wheel-end",
  );
  const summary = detail.locator(".statistics-history-game").last().locator("details > summary");
  await summary.tap();
  assert.equal(await summary.evaluate((node) => node.parentElement.open), true);
  assert.equal(
    await detail.locator(".statistics-history-game").last().locator("code").innerText(),
    "00000000-0000-4000-8000-000000000924",
  );
  await summary.tap();
  assert.equal(await summary.evaluate((node) => node.parentElement.open), false);
  if (page.context().browser().browserType().name() === "chromium") {
    const cdp = await page.context().newCDPSession(page);
    try {
      for (const [target, name] of targets) await probe(target, name, "touch", cdp);
      await position(targets[0][0]);
      // No wheel fallback: touch gets its own fresh start, movement and bottom oracle.
      checks.touchBottom = await nativeEnd(
        page,
        ".statistics-screen",
        ".statistics-history-game",
        "touch",
        cdp,
      );
    } finally {
      await cdp.detach();
    }
  } else checks.touchBottom = "Not verified: WebKit has no Chromium CDP touch route";
  await capture(`statistics-${locale}-paged-history-bottom`);
  await detail.getByRole("button", { name: closeName, exact: true }).tap();
  assert.equal(await detail.count(), 0);
  await open("36", 18); // Reopen resets paging through a new detail request.
  await detail.getByRole("button", { name: closeName, exact: true }).tap();
  for (const [number, count] of [
    ["35", 1],
    ["34", 0],
  ]) {
    await open(number, count);
    await probe(detail.locator(".statistics-rating-summary"), `history-${count}`, "mixed");
    assert.equal(await detail.locator(".statistics-history-game").count(), count);
    if (!count)
      assert.ok(
        await detail
          .getByText(ru ? "В этой области нет сохранённых игр." : "No saved games in this scope.", {
            exact: true,
          })
          .isVisible(),
      );
    await detail.getByRole("button", { name: closeName, exact: true }).tap();
  }
  checks.requests = await page.evaluate(() => window.hostUiStatisticsRequests);
  assert.ok(
    checks.requests.some((path) => path.includes("cursor=host-ui-next")),
    "History continuation requested",
  );
  assert.deepEqual(
    checks.failures,
    [],
    `${locale}: every native directional probe must move Statistics`,
  );
  return checks;
}

export const verifyHostUi = async ({ browser, config, url, evidence, results }) => {
  const page = await browser.newPage({
    viewport: config.viewport,
    screen: config.viewport,
    hasTouch: true,
  });
  page.setDefaultTimeout(10000);
  const receipt = {
    hostUi: config.name,
    browserVersion: browser.version(),
    viewport: config.viewport,
    fixture:
      "Actual ClubWorkspace; isolated synthetic identity/API; populated statistics read fixture",
    checks: [],
    defects: [],
    screenshots: [],
    errors: [],
    manualGap: "Physical iPad software keyboard/Home Screen not established by desktop engines",
  };
  page.on("pageerror", (error) => receipt.errors.push(error.message));
  await page.route("**/*", (route) =>
    route.request().url().startsWith(`${url}/`) ? route.continue() : route.abort(),
  );
  const capture = async (name) => {
    const path = join(evidence, `${config.name}-host-ui-${name}.png`);
    await page.screenshot({ path });
    receipt.screenshots.push(path);
  };
  const checkpoint = async (name, detail) => {
    receipt.checks.push({ name, ...detail });
    await writeFile(
      join(evidence, `${config.name}-host-ui-receipt.json`),
      JSON.stringify(receipt, null, 2),
    );
  };
  // Independent checks continue for evidence, but every acceptance failure is
  // retained verbatim and makes the scenario fail at the final assertion.
  const acceptance = async (name, run) => {
    try {
      return await run();
    } catch (error) {
      receipt.defects.push({
        name,
        assertion: error.message,
        stack: error.stack,
        view: await inspect(page),
      });
      await capture(`${name.replaceAll(" ", "-")}-failure`);
      return null;
    }
  };
  let step = "initial setup";
  try {
    receipt.bundle = {};
    for (const path of ["fixture.js", "fixture.css"])
      receipt.bundle[path] = createHash("sha256")
        .update(await (await page.request.get(`${url}/${path}`)).body())
        .digest("hex");
    await page.goto(`${url}/?phase=setup&empty`);
    await page.getByRole("combobox", { name: "Host player", exact: true }).waitFor();
    await page.locator(".live-side-panel").waitFor();
    await settle(page);

    step = "continuous background and setup geometry";
    for (const viewport of [
      config.viewport,
      ...(/ipad/.test(config.name) ? [{ width: 1024, height: 1366 }] : []),
    ]) {
      await page.setViewportSize(viewport);
      await settle(page);
      const view = await inspect(page);
      await checkpoint(`setup-${viewport.width}x${viewport.height}`, { view });
      await capture(`setup-${viewport.width}x${viewport.height}`);
      const main = view.nodes[".player-setup-card"].rect;
      const side = view.nodes[".live-side-panel"].rect;
      const shell = view.nodes[".app-shell"];
      assert.equal(
        shell.before.position,
        "fixed",
        "Decorative background belongs to fixed global shell",
      );
      assert.ok(
        shell.before.backgroundImage.includes("repeating-linear-gradient"),
        "One global decorative pattern exists in CSS fallback",
      );
      for (const selector of [".setup-shell", ".player-setup-card"])
        for (const part of ["css", "before", "after"])
          assert.ok(
            !/repeating-linear|radial-gradient/.test(view.nodes[selector][part].backgroundImage),
            `${selector} ${part}: no panel-local decorative restart`,
          );
      assert.ok(view.document.width <= viewport.width, "Setup has no horizontal document overflow");
      assert.ok(main.width > viewport.width * 0.55, "Setup occupies remaining main-column width");
      assert.ok(
        main.bottom >= viewport.height - 20 && main.bottom <= viewport.height + 1,
        "Setup fills available main-column height",
      );
      if (viewport.width >= 761) {
        assert.ok(side.x >= main.right - 1, "Sidebar stays beside the setup main column");
        assert.ok(
          side.y >= 0 && side.bottom <= viewport.height && side.height > 0,
          "Sidebar stays inside the viewport",
        );
        assert.ok(Math.abs(main.y - side.y) <= 2, "Main/sidebar top alignment");
        assert.ok(Math.abs(main.bottom - side.bottom) <= 2, "Setup fills sidebar height");
        assert.ok(side.x - main.right <= 20, "No wasted gap between setup and sidebar");
      }
    }
    await page.setViewportSize(config.viewport);
    await settle(page);

    step = "availability background and deliberate fixture availability";
    await page.getByRole("button", { name: "Select available players", exact: true }).tap();
    await page.locator(".availability-selection-card").waitFor();
    const initialAvailability = await inspect(page);
    await checkpoint("availability-initial-background", { view: initialAvailability });
    await capture("availability-initial");
    for (const part of ["css", "before", "after"])
      assert.ok(
        !/repeating-linear|radial-gradient/.test(
          initialAvailability.nodes[".availability-selection-card"][part].backgroundImage,
        ),
        `Availability ${part}: no panel-local decorative restart`,
      );
    const cards = page.locator(".availability-player-card");
    assert.equal(
      await cards.count(),
      11,
      "Eleven actual fixture profiles available to deliberate selection",
    );
    for (const card of await cards.all())
      if ((await card.getAttribute("aria-pressed")) === "false") await card.tap();
    await page.getByRole("button", { name: "Close available players", exact: true }).tap();

    step = "browse-first host and player popups";
    await page.evaluate(() => {
      window.hostUiPickerEvents = [];
      for (const type of [
        "pointerdown",
        "touchstart",
        "focusin",
        "focusout",
        "mousedown",
        "mouseup",
        "click",
        "input",
      ])
        document.addEventListener(
          type,
          (event) => {
            const target = event.target;
            if (!target.closest?.(".setup-player-popup,.player-combobox")) return;
            window.hostUiPickerEvents.push({
              type,
              trusted: event.isTrusted,
              target: target.outerHTML.slice(0, 450),
              relatedTarget: event.relatedTarget?.outerHTML?.slice(0, 450),
              active: document.activeElement?.outerHTML?.slice(0, 450),
            });
          },
          { capture: true, passive: true },
        );
    });
    const triggers = await page.locator(".player-combobox-opener").evaluateAll((nodes) =>
      nodes.map((node) => ({
        tag: node.tagName,
        type: node.type,
        editable: node.isContentEditable,
      })),
    );
    assert.equal(triggers.length, 11, "Host plus ten browse-first seat triggers");
    assert.ok(
      triggers.every((node) => node.tag === "BUTTON" && node.type === "button" && !node.editable),
      "Browse triggers are noneditable native buttons",
    );
    for (const [label, selection, query] of [
      ["Host player", "Host", null],
      ["Seat 1 player", "Player 1", "Player 1"],
      ["Seat 5 player", "Player 5", null],
      ["Seat 10 player", "Player 10", null],
    ]) {
      const trigger = page.getByRole("combobox", { name: label, exact: true });
      await trigger.tap();
      const popup = page.locator(".setup-player-popup");
      await popup.waitFor();
      const popupState = await popup.evaluate((node) => {
        const r = node.getBoundingClientRect();
        const s = getComputedStyle(node);
        const samples = [
          [r.left + 8, r.top + 8],
          [r.right - 8, r.top + 8],
          [r.left + 8, r.bottom - 8],
          [r.right - 8, r.bottom - 8],
          [r.left + r.width / 2, r.top + r.height / 2],
        ].map(([x, y]) => {
          const hit = document.elementFromPoint(x, y);
          return { x, y, inside: node.contains(hit), hit: hit?.outerHTML.slice(0, 250) };
        });
        return {
          rect: r.toJSON(),
          background: s.backgroundColor,
          zIndex: s.zIndex,
          position: s.position,
          editableActive: document.activeElement?.matches("input,textarea,[contenteditable=true]"),
          samples,
        };
      });
      await checkpoint(`browse-${label}`, { popup: popupState });
      await capture(`browse-${label.replaceAll(" ", "-").toLowerCase()}`);
      assert.equal(
        popupState.editableActive,
        false,
        `${label}: first tap does not focus an editable input`,
      );
      assert.ok(
        popupState.samples.every((sample) => sample.inside),
        `${label}: popup stays above neighboring controls`,
      );
      assert.ok(
        !/rgba\(.*?,\s*0(?:\.[0-9]+)?\)$/.test(popupState.background),
        `${label}: popup has opaque material preventing placeholder bleed`,
      );
      assert.ok(
        popupState.rect.top >= 0 && popupState.rect.bottom <= config.viewport.height,
        `${label}: popup stays inside viewport`,
      );
      if (query) {
        const input = popup.locator("input[type=search]");
        assert.equal(await input.inputValue(), "");
        await input.tap();
        await page.keyboard.type(query);
        assert.equal(
          await input.inputValue(),
          query,
          "Deliberate tap enables ordinary native typing",
        );
        assert.equal(await input.evaluate((node) => document.activeElement === node), true);
      }
      await popup.getByRole("option", { name: selection, exact: true }).tap();
      await popup.waitFor({ state: "detached" });
      await acceptance(`selection-${label.replaceAll(" ", "-")}`, async () => {
        assert.equal(
          (await trigger.textContent()).trim(),
          selection,
          `${label}: real selection commits displayed identity`,
        );
      });
    }
    step = "pointer-free native picker traversal";
    for (const [label, searchName, selection] of [
      ["Host player", "Search Host", "Host"],
      ["Seat 2 player", "Search Seat 2", "Player 2"],
    ]) {
      const trigger = page.getByRole("combobox", { name: label, exact: true });
      for (
        let step = 0;
        step < 90 && !(await trigger.evaluate((node) => document.activeElement === node));
        step++
      )
        await page.keyboard.press("Tab");
      assert.equal(await trigger.evaluate((node) => document.activeElement === node), true);
      await page.keyboard.press("Enter");
      const search = page.getByRole("searchbox", { name: searchName, exact: true });
      assert.equal(await search.evaluate((node) => document.activeElement === node), false);
      for (
        let step = 0;
        step < 4 && !(await search.evaluate((node) => document.activeElement === node));
        step++
      )
        await page.keyboard.press("Tab");
      assert.equal(
        await search.evaluate((node) => document.activeElement === node),
        true,
        `${label}: native Tab reaches search`,
      );
      await page.keyboard.type(selection);
      await page.keyboard.press("Tab");
      assert.equal(
        await page
          .getByRole("option", { name: selection, exact: true })
          .evaluate((node) => document.activeElement === node),
        true,
      );
      await page.keyboard.press("Enter");
      assert.equal((await trigger.textContent()).trim(), selection);
      assert.equal(await page.locator(".setup-player-popup").count(), 0);
    }
    await checkpoint("picker-native-selection", {
      triggers,
      events: await page.evaluate(() => window.hostUiPickerEvents),
      session: await page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key))?.current?.state.setup,
        sessionKey,
      ),
    });

    step = "Rules and toolbar order";
    const toolbar = await page.locator(".app-fixed-toolbar > button").evaluateAll((nodes) =>
      nodes.map((node) => ({
        label: node.getAttribute("aria-label"),
        className: node.className,
        rect: node.getBoundingClientRect().toJSON(),
      })),
    );
    const devIndex = toolbar.findIndex((node) => node.className.includes("dev-toolbar-button"));
    const privacyIndex = toolbar.findIndex((node) => node.className.includes("privacy-button"));
    assert.equal(
      devIndex + 1,
      privacyIndex,
      "Dev is immediately before role-visibility control in native DOM order",
    );
    assert.ok(
      toolbar[devIndex].rect.right <= toolbar[privacyIndex].rect.left + 1,
      "Dev is visually left of role visibility",
    );
    await rules(page);
    await checkpoint("setup-rules-toolbar", { toolbar });

    step = "native frosted-gold button states";
    const undo = page.locator(".undo-button");
    const disabled = await buttonStyle(undo);
    assert.equal(disabled.tag, "BUTTON");
    assert.equal(
      disabled.disabled,
      true,
      "Native Undo disabled state retained for empty game history",
    );
    assert.ok(Number(disabled.opacity) < 1, "Disabled button remains visually distinct");
    const privacy = page.locator(".privacy-button");
    const beforePrivacy = await privacy.getAttribute("aria-pressed");
    await privacy.tap();
    assert.notEqual(
      await privacy.getAttribute("aria-pressed"),
      beforePrivacy,
      "Frosted native toggle retains pressed semantics",
    );
    await privacy.tap();
    const dev = page.locator(".dev-toolbar-button");
    await dev.hover();
    const hover = await buttonStyle(dev);
    await page.mouse.down();
    const active = await buttonStyle(dev);
    await page.mouse.up();
    assert.equal(hover.hover, true, "Native button hover remains available");
    assert.equal(active.active, true, "Native button active state remains available");
    await page.getByRole("button", { name: "Close developer menu", exact: true }).tap();
    await checkpoint("native-button-states", { disabled, hover, active });

    step = "independent button-only controls and reload";
    const baselineButton = await buttonStyle(page.locator(".dev-toolbar-button"));
    await openGlass(page);
    const beforeSettings = await saved(page);
    const baselineResolved = await page.locator(".app-shell").evaluate((node) => {
      const s = getComputedStyle(node);
      return {
        gold: s.getPropertyValue("--glass-gold-light"),
        frost: s.getPropertyValue("--glass-matte-blur"),
        tint: s.getPropertyValue("--glass-tint"),
        nomination: s.getPropertyValue("--card-nomination-tint"),
      };
    });
    const buttonFrosting = await nativeRange(page, "Button frosting", 0.18);
    const buttonGold = await nativeRange(page, "Button gold strength", 0.84);
    const afterSettings = await saved(page);
    assert.equal(
      afterSettings.buttonFrosting,
      buttonFrosting,
      "Native frost control persists its actual selected value",
    );
    assert.equal(
      afterSettings.buttonGold,
      buttonGold,
      "Native gold control persists its actual selected value",
    );
    assert.deepEqual(
      withoutButtons(afterSettings),
      withoutButtons(beforeSettings),
      "Button-only tuning leaves every player-card/background setting unchanged",
    );
    const afterResolved = await page.locator(".app-shell").evaluate((node) => {
      const s = getComputedStyle(node);
      return {
        gold: s.getPropertyValue("--glass-gold-light"),
        frost: s.getPropertyValue("--glass-matte-blur"),
        tint: s.getPropertyValue("--glass-tint"),
        nomination: s.getPropertyValue("--card-nomination-tint"),
      };
    });
    assert.deepEqual(
      afterResolved,
      baselineResolved,
      "Background/player-card CSS controls unchanged",
    );
    await capture("button-controls");
    await page.getByRole("button", { name: "Close developer menu", exact: true }).tap();
    await page
      .locator(".dev-toolbar-button")
      .evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
    const changedButton = await buttonStyle(page.locator(".dev-toolbar-button"));
    assert.notEqual(
      changedButton.backdrop,
      baselineButton.backdrop,
      "Button frosting changes actual CSS fallback backdrop",
    );
    assert.notEqual(
      changedButton.background,
      baselineButton.background,
      "Button gold changes actual material, not only stored value",
    );
    assert.equal(changedButton.filter, "none", "Sharp HTML icons/text are not filtered");
    await page.reload();
    await page.getByRole("combobox", { name: "Host player", exact: true }).waitFor();
    assert.deepEqual(
      await saved(page),
      afterSettings,
      "Button-only settings survive actual reload",
    );
    assert.equal(
      (await buttonStyle(page.locator(".dev-toolbar-button"))).backdrop,
      changedButton.backdrop,
      "Reload applies persisted button frosting",
    );
    await openGlass(page);
    await page.getByRole("button", { name: "Reset button glass", exact: true }).tap();
    const resetSettings = await saved(page);
    assert.equal(resetSettings.buttonFrosting, 70);
    assert.equal(resetSettings.buttonGold, 35);
    assert.deepEqual(
      withoutButtons(resetSettings),
      withoutButtons(afterSettings),
      "Button-only reset preserves other settings",
    );
    await page.getByRole("button", { name: "Enable enhanced glass", exact: true }).tap();
    await page.getByRole("button", { name: "Close developer menu", exact: true }).tap();
    await page.waitForFunction(() =>
      ["ready", "unavailable", "context-lost", "reduced-transparency"].includes(
        document.querySelector(".app-shell").dataset.glassStatus,
      ),
    );
    const enhancedButton = await buttonStyle(page.locator(".dev-toolbar-button"));
    assert.ok(
      enhancedButton.backdrop.includes("blur("),
      "Button frosting remains independent of enhanced renderer status",
    );
    await capture("button-enhanced-requested");
    await openGlass(page);
    await page.getByRole("button", { name: "Disable enhanced glass", exact: true }).tap();
    await page.getByRole("button", { name: "Close developer menu", exact: true }).tap();
    assert.equal(
      await page.locator(".app-shell").getAttribute("data-glass-status"),
      "off",
      "CSS fallback explicitly exercised",
    );
    assert.ok(
      (await buttonStyle(page.locator(".dev-toolbar-button"))).backdrop.includes("blur("),
      "CSS fallback retains frosted button material",
    );
    await checkpoint("button-independent-storage-reload-reset-fallback", {
      beforeSettings,
      afterSettings,
      resetSettings,
      baselineButton,
      changedButton,
      enhancedButton,
      view: await inspect(page),
    });

    step = "availability background and geometry";
    await page.getByRole("button", { name: "Select available players", exact: true }).tap();
    await page.locator(".availability-selection-card").waitFor();
    const availability = await inspect(page);
    await checkpoint("availability-background", { view: availability });
    await capture("availability");
    for (const part of ["css", "before", "after"])
      assert.ok(
        !/repeating-linear|radial-gradient/.test(
          availability.nodes[".availability-selection-card"][part].backgroundImage,
        ),
        `Availability ${part}: global decoration does not restart inside panel`,
      );
    await rules(page);
    await page.getByRole("button", { name: "Close available players", exact: true }).tap();

    step = "Players native scroll and Back/Rules";
    await menu(page, "Players screen");
    await page.locator(".player-card-grid > article").last().waitFor();
    await capture("players-top");
    const directoryScroll = await wheelToEnd(page, ".players-shell", ".player-card-grid > article");
    await checkpoint("players-native-bottom", { directoryScroll, view: await inspect(page) });
    await capture("players-bottom");
    await rules(page);
    await page.getByRole("button", { name: "Back to game", exact: true }).tap();
    await page.locator(".player-setup-card").waitFor();

    step = "Statistics native scroll and Back/Rules";
    await statisticsFixture(page);
    await menu(page, "Statistics");
    await page.getByRole("button", { name: "Statistics fixture 36", exact: true }).waitFor();
    assert.equal(
      await page.locator(".statistics-table tbody tr:not(.statistics-group)").count(),
      36,
      "Populated statistics fixture is complete",
    );
    await capture("statistics-top");
    const statisticsScroll = await acceptance("statistics-native-scroll", () =>
      wheelToEnd(page, ".statistics-screen", ".statistics-table tbody tr:not(.statistics-group)"),
    );
    await checkpoint("statistics-native-bottom", {
      statisticsScroll,
      view: await inspect(page),
      requests: await page.evaluate(() => window.hostUiStatisticsRequests),
    });
    await capture(statisticsScroll ? "statistics-bottom" : "statistics-unscrollable");
    for (const locale of ["en", "ru"]) {
      step = `Statistics ${locale} selected-player native scrolling`;
      if (locale === "ru") {
        await page.goto(`${url}/?phase=setup&empty&locale=ru`);
        await page.locator(".player-setup-card").waitFor();
        await statisticsFixture(page);
        await menu(page, "Статистика", locale);
        await page.getByRole("heading", { name: "Статистика клуба", exact: true }).waitFor();
      }
      const detail = { locale, probes: [] };
      await acceptance(`statistics-${locale}-player-scroll`, () =>
        statisticsPlayerScroll(page, locale, capture, detail),
      );
      await checkpoint(`statistics-${locale}-selected-player-native-scroll`, { detail });
    }
    await page.goto(`${url}/?phase=setup&empty`);
    await page.locator(".player-setup-card").waitFor();
    await statisticsFixture(page);
    await menu(page, "Statistics");
    await page.getByRole("button", { name: "Statistics fixture 36", exact: true }).waitFor();
    await rules(page);
    const statsScroller = page.locator(".statistics-screen");
    const b = await statsScroller.boundingBox();
    await page.mouse.move(b.x + 24, b.y + Math.min(300, b.height / 2));
    await page.mouse.wheel(0, -20000);
    await page.waitForFunction(() => document.querySelector(".statistics-screen").scrollTop <= 1);
    await page
      .locator(".statistics-header")
      .getByRole("button", { name: "Back to game", exact: true })
      .tap();
    await page.locator(".player-setup-card").waitFor();
    assert.deepEqual(receipt.errors, [], "No browser errors");
    assert.deepEqual(
      receipt.defects.map(({ name, assertion }) => ({ name, assertion })),
      [],
      "All host-UI acceptance checks must pass",
    );
    await checkpoint("complete", { status: "passed" });
  } catch (error) {
    receipt.failure = {
      step,
      assertion: error.message,
      stack: error.stack,
      view: await inspect(page).catch(() => null),
    };
    await capture("failure").catch(() => {});
    await writeFile(
      join(evidence, `${config.name}-host-ui-failure.html`),
      await page.content(),
    ).catch(() => {});
    throw error;
  } finally {
    results.push(receipt);
    await writeFile(
      join(evidence, `${config.name}-host-ui-receipt.json`),
      JSON.stringify(receipt, null, 2),
    );
    await page.close();
  }
};
