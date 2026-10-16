/* global document, window, navigator, getComputedStyle, DOMMatrixReadOnly, HTMLCanvasElement, MutationObserver, DOMException, fetch */
// Run from the repository: node --test apps/web/src/features/clubs/ClubEntryTransition.browser.test.mjs
// Optional CLUB_ENTRY_BASE_URL must name a loopback disposable-fixture preview.
// Default: the CURRENT application, a private ephemeral Vite server, no backend,
// no .env, no credentials, no external requests, and no production test hooks.
import assert from "node:assert/strict";
import console from "node:console";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import process from "node:process";
import { after, before, test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { chromium, webkit } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { PNG } from "pngjs";
import { createServer } from "vite";

const directory = dirname(fileURLToPath(import.meta.url));
const repository = join(directory, "../../../../..");
const evidenceRoot = join(repository, ".AI/reports/club-entry-integration/browser");
await mkdir(evidenceRoot, { recursive: true });
const output = await mkdtemp(join(evidenceRoot, "run-"));
const fancyStuffKey = "mafia-dashboard.fancy-stuff.v1";
const fancyStuffDependencies = [
  "apps/web/src/features/effects/fancy-stuff-preferences.ts",
  "apps/web/src/features/developer/FancyStuffControls.tsx",
  "apps/web/src/features/developer/FancyStuffControls.css",
  "apps/web/src/i18n/messages/fancy-stuff.ts",
];
const timestamp = "2026-10-15T00:00:00.000Z";
const club = (id, name, city, language = "en") => ({
  id,
  name,
  city,
  language,
  headerLogo: null,
  cardLogo: null,
  bestMoveEnabled: true,
  role: "manager",
  createdAt: timestamp,
  updatedAt: timestamp,
});
const clubs = [
  club("00000000-0000-4000-8000-000000000101", "La Verdad", "Málaga"),
  club("00000000-0000-4000-8000-000000000202", "Mafia Sevilla", "Sevilla", "ru"),
];
const user = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Local preview",
  email: "preview@example.test",
  picture: null,
};
const statistics = Object.fromEntries(
  [
    "hostedGames",
    "gamesPlayed",
    "wins",
    "losses",
    "redGames",
    "redWins",
    "blackGames",
    "blackWins",
    "sheriffGames",
    "citizenGames",
    "mafiaGames",
    "donGames",
    "totalFouls",
    "eliminations",
    "redCards",
    "bestMoves",
    "bestMoveMafiaHits",
  ].map((name) => [name, 0]),
);
const players = Array.from({ length: 11 }, (_, index) => ({
  id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  nickname: index === 0 ? "Preview Host" : `Preview Player ${index}`,
  consent: false,
  clubAccess: index === 0 ? "manager" : "none",
  managerLocked: index === 0,
  firstName: null,
  lastName: null,
  email: null,
  consentAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  lastPlayedAt: null,
  statistics,
}));
const fixtureReply = (path) => {
  switch (path) {
    case "/health/ready":
      return { status: "ready", fixture: true };
    case "/health/version":
      return { version: "1.0.0", commit: "club-entry-browser-fixture", fixture: true };
    case "/api/auth/session":
      return { configured: true, user };
    case "/api/clubs":
      return { clubs };
    case "/api/players":
      return { players };
    case "/api/game-sessions":
      return { sessions: [] };
    case "/api/music/oauth/status":
      return { configured: false, connected: false, accountLabel: null };
    case "/api/music/playlists":
      return { playlists: [] };
    default:
      return undefined;
  }
};

// Bind every receipt to the real source tree, including concurrent changes.
// The manifest deliberately excludes tests/evidence; it is not a synthetic bundle.
async function sourceManifest() {
  const files = [];
  async function collect(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await collect(full);
      else if (/\.(?:tsx?|css|json)$/.test(entry.name) && !/\.test\./.test(entry.name))
        files.push(full);
    }
  }
  await collect(join(repository, "apps/web/src"));
  await collect(join(repository, "packages/game-domain/src"));
  files.push(join(repository, "apps/web/index.html"));
  for (const path of [
    "package.json",
    "package-lock.json",
    "apps/web/package.json",
    "apps/web/vite.config.ts",
    "packages/game-domain/package.json",
  ])
    files.push(join(repository, path));
  const manifest = await Promise.all(
    files.sort().map(async (path) => ({
      path: relative(repository, path),
      sha256: createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    })),
  );
  for (const path of fancyStuffDependencies)
    assert(
      manifest.some((entry) => entry.path === path),
      `Preference dependency bound: ${path}`,
    );
  return {
    sha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    files: manifest,
  };
}
const results = [];
const expected = [];
let sourceBefore;
let runnerBefore;
let server;
let baseURL;
const browsers = {};

before(async () => {
  sourceBefore = await sourceManifest();
  runnerBefore = createHash("sha256")
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest("hex");
  if (process.env.CLUB_ENTRY_BASE_URL) {
    const url = new URL(process.env.CLUB_ENTRY_BASE_URL);
    assert(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    assert.equal(url.pathname, "/", "Only a loopback fixture root is accepted");
    assert(!url.username && !url.password && !url.search && !url.hash);
    baseURL = url.origin;
    const response = await fetch(`${baseURL}/health/ready`, { redirect: "error" });
    assert(
      response.ok && (await response.json()).fixture === true,
      "Preview must advertise disposable fixtures",
    );
  } else {
    server = await createServer({
      root: join(repository, "apps/web"),
      configFile: false,
      envFile: false,
      cacheDir: join(output, "vite-cache"),
      logLevel: "error",
      plugins: [
        {
          name: "club-entry-browser-disposable-api",
          configureServer(vite) {
            vite.middlewares.use((request, response, next) => {
              const path = new URL(request.url, "http://127.0.0.1").pathname;
              if (!path.startsWith("/api/") && !path.startsWith("/health/")) return next();
              const host = new URL(`http://${request.headers.host}`);
              const origin = request.headers.origin;
              const allowed = host.hostname === "127.0.0.1" && (!origin || origin === host.origin);
              const body = allowed && request.method === "GET" ? fixtureReply(path) : undefined;
              response.statusCode = !allowed ? 403 : body === undefined ? 501 : 200;
              response.setHeader("Content-Type", "application/json");
              response.setHeader("Cache-Control", "no-store");
              response.end(
                JSON.stringify(body ?? { error: "Not enabled in disposable browser fixture" }),
              );
            });
          },
        },
        react(),
      ],
      server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false },
    });
    await server.listen();
    baseURL = `http://127.0.0.1:${server.httpServer.address().port}`;
  }
  browsers.chromium = await chromium.launch({ headless: true, channel: "chrome" });
  browsers.webkit = await webkit.launch({ headless: true });
});

after(async () => {
  const sourceAfter = await sourceManifest();
  const report = {
    baseURL,
    output,
    fixture: "disposable API; current isolated candidate source; no production endpoint",
    fonts: "external font CSS fulfilled empty; native local system fallback; no network fonts",
    runnerSha256: createHash("sha256")
      .update(await readFile(fileURLToPath(import.meta.url)))
      .digest("hex"),
    sourceBefore,
    sourceAfter,
    sourceUnchanged: sourceBefore?.sha256 === sourceAfter.sha256,
    runnerBefore,
    fancyStuffDependencies,
    totals: {
      expected: expected.length,
      passed: results.filter((row) => row.status === "passed").length,
      failed: results.filter((row) => row.status === "failed").length,
      notRun: expected.filter((name) => !results.some((row) => row.name === name)),
      notVerified: expected.filter(
        (name) => !results.some((row) => row.name === name && row.status === "passed"),
      ),
    },
    coverageNotes: [
      "Hidden/background lifecycle is not simulated; actual full-document teardown and return are tested separately.",
      "Domain attachment/invalid/unresolved/recovery fixtures belong to App unit tests, not this visual suite.",
      "Source changes during a run are disclosed; a mixed-source receipt is not final candidate qualification.",
    ],
    results,
  };
  await writeFile(join(output, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(evidenceRoot, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`CLUB_ENTRY_BROWSER_RESULT ${join(output, "result.json")}`);
  console.log(
    JSON.stringify({
      ...report.totals,
      runnerSha256: report.runnerSha256,
      sourceUnchanged: report.sourceUnchanged,
    }),
  );
  await Promise.all(Object.values(browsers).map((browser) => browser.close()));
  await server?.close();
  assert(
    report.sourceUnchanged,
    "Application sources changed during this run; receipt is not qualification",
  );
  assert.equal(report.runnerSha256, runnerBefore, "Runner changed during this run");
});

function scenario(name, options, run) {
  expected.push(name);
  test(name, { timeout: 45000 }, async () => {
    const row = {
      name,
      status: "running",
      checks: [],
      errors: [],
      consoleErrors: [],
      requestFailures: [],
      requests: [],
      screenshots: [],
    };
    results.push(row);
    const { engine = "chromium", ...contextOptions } = options;
    row.environment = {
      engine,
      version: browsers[engine].version(),
      viewport: contextOptions.viewport ?? { width: 1366, height: 768 },
      locale: contextOptions.locale ?? "en-US",
      hasTouch: contextOptions.hasTouch ?? false,
    };
    const context = await browsers[engine].newContext({
      viewport: { width: 1366, height: 768 },
      deviceScaleFactor: 1,
      locale: "en-US",
      ...contextOptions,
    });
    let page;
    try {
      // All HTTP traffic is fenced before navigation, including optional previews.
      // API responses are fixture-owned even when an external loopback preview is selected.
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (!["http:", "https:"].includes(url.protocol)) return route.continue();
        if (url.origin !== baseURL) {
          if (url.hostname === "fonts.googleapis.com" && request.resourceType() === "stylesheet") {
            row.requests.push({
              url: url.href,
              policy: "font CSS replaced by empty local response",
            });
            return route.fulfill({ contentType: "text/css", body: "" });
          }
          row.errors.push(`Unexpected external request blocked: ${url.href}`);
          return route.abort("blockedbyclient");
        }
        if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/health/")) {
          const body = request.method() === "GET" ? fixtureReply(url.pathname) : undefined;
          row.requests.push({
            method: request.method(),
            path: `${url.pathname}${url.search}`,
            status: body ? 200 : 501,
          });
          if (!body)
            row.errors.push(`Unsupported fixture API: ${request.method()} ${url.pathname}`);
          return route.fulfill({
            status: body ? 200 : 501,
            json: body ?? { error: "Unknown disposable-fixture API" },
          });
        }
        return route.continue();
      });
      page = await context.newPage();
      page.setDefaultTimeout(5000);
      context.on("requestfailed", (request) =>
        row.requestFailures.push({ url: request.url(), error: request.failure()?.errorText }),
      );
      context.on("page", (newPage) => {
        newPage.on("pageerror", (error) => row.errors.push(error.message));
        newPage.on("console", (message) => {
          if (message.type() === "error") row.consoleErrors.push(message.text());
        });
      });
      // The first page predates the context listener.
      page.on("pageerror", (error) => row.errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") row.consoleErrors.push(message.text());
      });
      const capture = async (label, screenshotOptions = {}) => {
        const path = join(output, `${name.replaceAll(/[^a-z0-9-]/gi, "-")}-${label}.png`);
        const buffer = await page.screenshot({ path, ...screenshotOptions });
        row.screenshots.push(path);
        return buffer;
      };
      await run({ page, context, row, capture });
      assert.deepEqual(row.errors, [], "No page errors, external traffic or unknown APIs");
      assert.deepEqual(row.requestFailures, [], "No unclassified browser request failures");
      // Console errors are retained as raw diagnostics; GPU fallback warnings are not JS exceptions.
      row.status = "passed";
    } catch (error) {
      row.status = "failed";
      row.error = error.stack;
      row.remainingCoverage =
        "Not verified: assertions after this failure were not reached; only completed checks and raw receipts above are evidence.";
      if (page && !page.isClosed()) {
        row.failureDOM = await page
          .evaluate(() => ({
            lang: document.documentElement.lang,
            text: document.body.innerText.slice(0, 5000),
            focus: document.activeElement?.outerHTML,
            transition: document.querySelector(".club-entry-effect")?.outerHTML.slice(0, 2000),
            source: !!document.querySelector(".club-entry-source"),
            destination: !!document.querySelector(".club-entry-destination"),
          }))
          .catch(() => null);
        const path = join(output, `${name.replaceAll(/[^a-z0-9-]/gi, "-")}-failure.png`);
        await page
          .screenshot({ path, timeout: 3000 })
          .then(() => row.screenshots.push(path))
          .catch(() => {});
      }
      throw error;
    } finally {
      await writeFile(
        join(output, `${name.replaceAll(/[^a-z0-9-]/gi, "-")}.json`),
        `${JSON.stringify(row, null, 2)}\n`,
      );
      await context.close();
    }
  });
}
const englishSlogan = "The city sleeps. The game begins.";
const russianSlogan = "Город засыпает. Игра начинается.";
const openButton = (page) => page.getByRole("button", { name: /La Verdad.*Málaga/ });
async function picker(page, slogan = englishSlogan) {
  await page.goto(baseURL);
  await page.getByRole("heading", { name: slogan, exact: true }).waitFor();
  await page.locator(".club-card-open").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
}
async function burning(page) {
  await page.locator('.club-entry-effect[data-phase="burning"]').waitFor();
  assert.equal(await page.locator(".club-entry-destination .app-shell").count(), 1);
}
async function settled(page, focus = true) {
  await page.locator(".club-entry-source").waitFor({ state: "detached" });
  await page.locator(".club-exit-button").waitFor();
  assert.equal(await page.locator(".club-entry-effect").count(), 0);
  assert.equal(await page.locator(".club-entry-destination").evaluate((node) => node.inert), false);
  if (focus)
    await page.waitForFunction(
      () => document.activeElement === document.querySelector(".club-exit-button"),
    );
}
async function portalGeometry(page) {
  return page
    .locator(".club-portal-brand,.club-portal-slogan,.club-user-chip,.club-playing-card")
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          className: node.className,
          text: node.textContent,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      }),
    );
}
function pixels(first, second) {
  const a = PNG.sync.read(first),
    b = PNG.sync.read(second);
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let maxDelta = 0,
    changedPixels = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let delta = 0;
    for (let channel = 0; channel < 4; channel++)
      delta = Math.max(delta, Math.abs(a.data[i + channel] - b.data[i + channel]));
    maxDelta = Math.max(maxDelta, delta);
    if (delta > 3) changedPixels++;
  }
  return { maxDelta, changedPixels };
}
async function observeClick(page) {
  return page.evaluateHandle(() => {
    const state = { portal: document.querySelector(".club-portal"), card: null, geometry: null };
    const listener = (event) => {
      const button = event.target.closest?.(".club-card-open");
      if (!button) return;
      const card = button.closest(".club-playing-card");
      const rect = card.getBoundingClientRect(),
        style = getComputedStyle(card);
      const matrix = new DOMMatrixReadOnly(style.transform);
      state.card = card;
      state.geometry = {
        cx: rect.x + rect.width / 2,
        cy: rect.y + rect.height / 2,
        rectWidth: rect.width,
        rectHeight: rect.height,
        width: card.offsetWidth,
        height: card.offsetHeight,
        radius: parseFloat(style.borderTopLeftRadius),
        matrix: [matrix.a, matrix.b, matrix.c, matrix.d],
      };
      document.removeEventListener("click", listener, true);
    };
    document.addEventListener("click", listener, true);
    return state;
  });
}
async function burnMetrics(page, observed) {
  return page.evaluate((state) => {
    const path = document.querySelector(".club-entry-defs path").getAttribute("d");
    const parts = path.split("Z");
    const coordinates = (section) => (section?.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    const area = (section) => {
      const xy = coordinates(section);
      let sum = 0;
      for (let i = 0; i < xy.length; i += 2) {
        const next = (i + 2) % xy.length;
        sum += xy[i] * xy[next + 1] - xy[next] * xy[i + 1];
      }
      return Math.abs(sum) / 2;
    };
    const source = document.querySelector(".club-entry-source");
    const bounds = source.getBoundingClientRect(),
      card = state.geometry;
    const front = coordinates(parts[1]),
      [a, b, c, d] = card.matrix;
    const determinant = a * d - b * c;
    let maxBorderDistance = 0;
    const xs = [],
      ys = [];
    for (let i = 0; i < front.length; i += 2) {
      const x = front[i] + bounds.x - card.cx,
        y = front[i + 1] + bounds.y - card.cy;
      const localX = (d * x - c * y) / determinant,
        localY = (-b * x + a * y) / determinant;
      const qx = Math.abs(localX) - (card.width / 2 - card.radius);
      const qy = Math.abs(localY) - (card.height / 2 - card.radius);
      const distance =
        Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - card.radius;
      maxBorderDistance = Math.max(maxBorderDistance, Math.abs(distance));
      xs.push(front[i]);
      ys.push(front[i + 1]);
    }
    const rect = state.card.getBoundingClientRect();
    return {
      progress: Number(document.querySelector(".club-entry-effect").dataset.clubBurnProgress),
      renderer: document.querySelector(".club-entry-effect").dataset.renderer,
      points: front.length / 2,
      maxBorderDistance,
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
      outerArea: area(parts[1]),
      cardArea: area(parts[2]),
      cardDrift: Math.hypot(rect.x + rect.width / 2 - card.cx, rect.y + rect.height / 2 - card.cy),
      cardSizeDrift: Math.max(
        Math.abs(rect.width - card.rectWidth),
        Math.abs(rect.height - card.rectHeight),
      ),
      card,
      intactCard: !!parts[2] && parts[2] === parts[1],
      retainedCard: source.contains(state.card),
      retainedPortal: source.contains(state.portal),
      sourceInert: source.inert,
      destinationInert: document.querySelector(".club-entry-destination").inert,
      clipPath: getComputedStyle(source).clipPath,
      oldCurtain: !!document.querySelector(".club-curtain-opening"),
    };
  }, observed);
}
async function cardPixels(page, observed, initial, label, visible, capture) {
  const clip = {
    x: Math.round(initial.card.cx - 32),
    y: Math.round(initial.card.cy - 32),
    width: 64,
    height: 64,
  };
  const normal = await capture(`${label}-normal`, { clip });
  const repeated = await capture(`${label}-repeat`, { clip });
  const stability = pixels(normal, repeated);
  assert(
    stability.maxDelta <= 3,
    `${label}: frozen frame pixel noise must stay <=3, got ${JSON.stringify(stability)}`,
  );
  const previous = await observed.evaluate((state) => {
    const style = state.card.style;
    const saved = {
      value: style.getPropertyValue("visibility"),
      priority: style.getPropertyPriority("visibility"),
    };
    style.setProperty("visibility", "hidden", "important");
    return saved;
  });
  let hidden;
  try {
    hidden = await capture(`${label}-hide-card`, { clip });
  } finally {
    await observed.evaluate((state, saved) => {
      if (saved.value) state.card.style.setProperty("visibility", saved.value, saved.priority);
      else state.card.style.removeProperty("visibility");
    }, previous);
  }
  const difference = pixels(normal, hidden);
  if (visible)
    assert(
      difference.maxDelta > 8 && difference.changedPixels > 128,
      `${label}: positive visible-card control ${JSON.stringify(difference)}`,
    );
  else
    assert(
      difference.maxDelta <= 3,
      `${label}: actual card fully consumed ${JSON.stringify(difference)}`,
    );
  return { label, visible, stability, difference };
}

for (const [engine, width, height] of [
  ["chromium", 1366, 768],
  ["chromium", 1000, 600],
  ["webkit", 1366, 1024],
]) {
  scenario(
    `${engine}-${width}x${height}-actual-card`,
    { engine, viewport: { width, height } },
    async ({ page, row, capture }) => {
      await picker(page);
      row.baselineGeometry = await portalGeometry(page);
      assert.equal(await page.locator(".club-portal-brand strong").innerText(), "La Verdad");
      assert.equal(await page.locator(".club-user-chip button").innerText(), "Sign out");
      const account = await page.locator(".club-user-chip").boundingBox();
      assert(
        account.y >= 0 &&
          account.y < 50 &&
          account.x + account.width <= width &&
          account.x > width / 2,
      );
      assert.equal(await page.locator('.club-portal input[type="color"]').count(), 0);
      assert.equal(
        await page
          .locator(".new-club-card")
          .innerText()
          .then((text) => /New club.*Create freely/s.test(text)),
        true,
      );
      await capture("baseline");
      row.checks.push(
        "current La Verdad branding/slogan; upper-right account; New club; no portal colour picker; measured baseline",
      );
      const start = new Date("2026-10-15T12:00:00Z");
      await page.clock.install({ time: start });
      await page.clock.pauseAt(new Date(start.getTime() + 60000));
      row.activations = [];
      for (const activation of ["mouse", "keyboard"]) {
        const observed = await observeClick(page);
        const target = openButton(page);
        if (activation === "mouse") {
          await target.hover();
          await page.waitForTimeout(250); // CSS hover settles; the animation clock stays frozen.
          const rect = await target.boundingBox();
          await page.mouse.click(rect.x + rect.width * 0.25, rect.y + rect.height * 0.3);
        } else {
          await page.mouse.move(0, 0);
          await target.focus();
          await page.keyboard.press("Enter");
        }
        await burning(page);
        const first = await burnMetrics(page, observed);
        // Save raw geometry before the first assertion so failures stay diagnosable.
        const receipt = { activation, first, pixelChecks: [] };
        row.activations.push(receipt);
        assert.equal(first.progress, 0, "first real frame is ignition");
        assert.equal(first.renderer, "webgl", "matrix must exercise real WebGL, not fallback");
        assert(
          first.points > 200 && first.maxBorderDistance < 0.1,
          "entire transformed rounded card contour, not a click-point circle",
        );
        assert(first.width > first.card.width * 0.95 && first.height > first.card.height * 0.95);
        assert(
          first.intactCard && first.retainedCard && first.retainedPortal,
          "retain exact original DOM nodes and full card face",
        );
        assert(first.sourceInert && first.destinationInert && first.clipPath !== "none");
        assert(!first.oldCurtain);
        assert(
          first.cardDrift < 0.1 && first.cardSizeDrift < 0.1,
          "ignition cannot move or resize the original card",
        );
        receipt.pixelChecks.push(
          await cardPixels(page, observed, first, `${activation}-ignition`, true, capture),
        );
        await capture(`${activation}-ignition`);
        await page.clock.runFor(96);
        receipt.early = await burnMetrics(page, observed);
        assert(
          receipt.early.outerArea > first.outerArea &&
            receipt.early.cardArea > 0 &&
            receipt.early.cardArea < first.cardArea,
        );
        assert(receipt.early.cardDrift < 0.1 && receipt.early.cardSizeDrift < 0.1);
        await page.clock.runFor(96);
        receipt.middle = await burnMetrics(page, observed);
        assert(
          receipt.middle.outerArea > receipt.early.outerArea &&
            receipt.middle.cardArea > 0 &&
            receipt.middle.cardArea < receipt.early.cardArea,
        );
        assert(receipt.middle.cardDrift < 0.1 && receipt.middle.cardSizeDrift < 0.1);
        receipt.pixelChecks.push(
          await cardPixels(page, observed, first, `${activation}-192ms`, true, capture),
        );
        await capture(`${activation}-192ms`);
        await page.clock.runFor(160);
        receipt.at352ms = await burnMetrics(page, observed);
        assert(
          receipt.at352ms.cardArea > 0 && receipt.at352ms.cardArea < receipt.middle.cardArea,
          "card still present at352ms",
        );
        await page.clock.runFor(32);
        receipt.at384ms = await burnMetrics(page, observed);
        assert.equal(receipt.at384ms.cardArea, 0, "actual card consumed by384ms (360ms duration)");
        assert(receipt.at384ms.outerArea > receipt.at352ms.outerArea);
        assert(receipt.at384ms.cardDrift < 0.1 && receipt.at384ms.cardSizeDrift < 0.1);
        receipt.pixelChecks.push(
          await cardPixels(page, observed, first, `${activation}-384ms`, false, capture),
        );
        await capture(`${activation}-384ms`);
        await page.clock.runFor(1408);
        receipt.phase1792ms = await page.locator(".club-entry-effect").getAttribute("data-phase");
        assert.equal(receipt.phase1792ms, "burning", "outer burn remains1800ms");
        await capture(`${activation}-1792ms`);
        await page.clock.runFor(208);
        await settled(page);
        await capture(`${activation}-2000ms-workspace`);
        await page.locator(".club-exit-button").click();
        await page.getByRole("heading", { name: englishSlogan, exact: true }).waitFor();
        await observed.dispose();
        row.checks.push(
          `${activation}: original DOM; full contour; independent outer growth/inner shrink; stable card; decoded-pixel controls;352/384ms consumption;1792/2000ms completion; inert/focus/return`,
        );
      }
      await page.clock.resume();
    },
  );
}

scenario("portal-editor-long-labels", {}, async ({ page, context, row, capture }) => {
  const longName = "La Verdad international club with a deliberately long readable name";
  const longCity = "Málaga — a deliberately long city and district label";
  const longUser = "Local preview account with a deliberately long display name";
  const longEmail = "local-preview-long-account-name@example.test";
  await context.route(`${baseURL}/api/clubs`, (route) =>
    route.fulfill({ json: { clubs: [{ ...clubs[0], name: longName, city: longCity }, clubs[1]] } }),
  );
  await context.route(`${baseURL}/api/auth/session`, (route) =>
    route.fulfill({
      json: { configured: true, user: { ...user, name: longUser, email: longEmail } },
    }),
  );
  await page.addInitScript(() =>
    window.localStorage.setItem("mafia-dashboard.theme-color.v1", "#7170ff"),
  );
  await picker(page);
  row.geometry = await portalGeometry(page);
  assert.equal(await page.locator(".club-user-chip strong").getAttribute("title"), longUser);
  assert.equal(await page.locator(".club-user-chip small").getAttribute("title"), longEmail);
  const card = page.locator(".club-card-open").first();
  assert((await card.getAttribute("aria-label")).includes(longName));
  // CSS deliberately uppercases/ellipsizes the face; source and accessible
  // labels must still retain the full original values, not the transformed innerText.
  assert((await card.textContent()).includes(longCity));
  assert((await card.getAttribute("aria-label")).includes(longCity));
  assert.equal(
    await page.evaluate(() => document.documentElement.style.getPropertyValue("--theme-base")),
    "#7170ff",
  );
  await capture("long-labels-picker");
  await page.locator(".new-club-card").click();
  await page.getByRole("heading", { name: "Create a new club", exact: true }).waitFor();
  assert.equal(await page.locator(".club-editor-card").count(), 1);
  assert.equal(await page.locator(".club-entry-effect").count(), 0);
  assert.equal(await page.locator(".club-user-chip").count(), 0);
  await page.getByLabel("Club name", { exact: true }).fill("Unsaved local editor probe");
  assert.equal(
    await page.getByLabel("Club name", { exact: true }).inputValue(),
    "Unsaved local editor probe",
  );
  assert.equal(
    await page.getByRole("button", { name: "Save club", exact: true }).isDisabled(),
    true,
  );
  await capture("new-club-editor");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("heading", { name: englishSlogan, exact: true }).waitFor();
  assert.equal(await page.locator(".club-entry-effect").count(), 0);
  assert.equal(
    await page.evaluate(() => window.localStorage.getItem("mafia-dashboard.theme-color.v1")),
    "#7170ff",
  );
  row.checks.push(
    "long account titles and original club labels retained despite CSS uppercase/ellipsis; real New club/editor/cancel handlers; no accidental burn/save; saved theme retained",
  );
});

scenario(
  "saved-theme-entry-and-return",
  { reducedMotion: "reduce" },
  async ({ page, row, capture }) => {
    await page.addInitScript(() =>
      window.localStorage.setItem("mafia-dashboard.theme-color.v1", "#7170ff"),
    );
    await picker(page);
    await openButton(page).click();
    await settled(page);
    assert.equal(
      await page.evaluate(() => window.localStorage.getItem("mafia-dashboard.theme-color.v1")),
      "#7170ff",
    );
    await capture("saved-theme-workspace");
    await page.locator(".club-exit-button").click();
    await page.getByRole("heading", { name: englishSlogan, exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.style.getPropertyValue("--theme-base")),
      "#7170ff",
    );
    row.checks.push(
      "persisted custom theme survives real entry and return without a portal colour picker",
    );
  },
);

scenario(
  "reduced-motion-real-keyboard",
  { reducedMotion: "reduce" },
  async ({ page, row, capture }) => {
    await picker(page);
    // Native traversal rather than dispatchEvent or invoking a React callback.
    for (
      let i = 0;
      i < 20 && !(await openButton(page).evaluate((node) => node === document.activeElement));
      i++
    )
      await page.keyboard.press("Tab");
    assert(await openButton(page).evaluate((node) => node === document.activeElement));
    await page.keyboard.press("Enter");
    await settled(page);
    await capture("workspace");
    row.checks.push(
      "native Tab/Enter; reduced-motion ordinary navigation; no retained overlay; destination receives focus",
    );
  },
);

scenario("locale-source-freeze-destination-and-return", {}, async ({ page, row, capture }) => {
  await picker(page);
  await page.getByRole("button", { name: /Mafia Sevilla.*Sevilla/ }).click();
  await burning(page);
  assert.equal(await page.locator("html").getAttribute("lang"), "ru");
  assert.equal(
    await page.locator(".club-entry-source .club-portal-slogan").innerText(),
    englishSlogan,
  );
  await capture("ru-destination-en-source");
  await settled(page);
  await page.locator(".club-exit-button").click();
  await page.getByRole("heading", { name: englishSlogan, exact: true }).waitFor();
  // Portal has its frozen locale provider; document locale is restored by the
  // App effect on the following commit. Observe that real boundary, not a sleep.
  row.documentLangAtPortalReturn = await page.locator("html").getAttribute("lang");
  await page.waitForFunction(() => document.documentElement.lang === "en", undefined, {
    polling: 10,
  });
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  await capture("english-portal-and-document-restored");
  row.checks.push(
    "outgoing English source frozen; real Russian destination; focus; English portal restored",
  );
});

scenario("russian-portal-branding", { locale: "ru-RU" }, async ({ page, row, capture }) => {
  await picker(page, russianSlogan);
  assert.equal(await page.locator(".club-portal-brand strong").innerText(), "La Verdad");
  assert.equal(await page.locator("html").getAttribute("lang"), "ru");
  row.geometry = await portalGeometry(page);
  await capture("ru-picker");
  row.checks.push("current Russian slogan and retained La Verdad brand");
});

scenario("duplicate-real-double-click", {}, async ({ page, row, capture }) => {
  await picker(page);
  const rect = await openButton(page).boundingBox();
  await page.mouse.dblclick(rect.x + rect.width / 2, rect.y + rect.height / 2, { delay: 15 });
  await burning(page);
  assert.equal(await page.locator(".club-entry-destination").count(), 1);
  assert.equal(await page.locator(".club-entry-effect").count(), 1);
  await capture("single-handoff");
  await settled(page);
  row.checks.push("rapid native double activation creates exactly one destination and effect");
});

scenario("real-webgl-context-loss", {}, async ({ page, row, capture }) => {
  await picker(page);
  await openButton(page).click();
  await burning(page);
  row.actualContextLoss = await page.locator(".club-entry-canvas").evaluate((canvas) => {
    const extension = canvas.getContext("webgl")?.getExtension("WEBGL_lose_context");
    extension?.loseContext();
    return !!extension;
  });
  assert(row.actualContextLoss, "must actually lose an acquired GPU context");
  await settled(page);
  await capture("ordinary-workspace");
  row.checks.push("actual WEBGL_lose_context loss; bounded fallback; inert and focus restored");
});

scenario("webgl-unavailable-static-fallback", {}, async ({ page, row, capture }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
      return /webgl/.test(kind) ? null : original.call(this, kind, ...args);
    };
  });
  await picker(page);
  // The unused GPU canvas is intentionally hidden in the static fallback.
  await page
    .locator('.club-fire-canvas[data-renderer="static-unavailable"]')
    .waitFor({ state: "attached" });
  row.staticCards = await page
    .locator('.club-playing-card[data-club-fire-static="true"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        newClub: node.classList.contains("new-club-card"),
        content: getComputedStyle(node, "::after").content,
        background: getComputedStyle(node, "::after").backgroundImage,
        pointerEvents: getComputedStyle(node, "::after").pointerEvents,
      })),
    );
  assert.equal(row.staticCards.length, 2);
  assert(
    row.staticCards.every(
      (card) =>
        !card.newClub &&
        card.content === '""' &&
        card.background.includes("radial-gradient") &&
        card.pointerEvents === "none",
    ),
  );
  await capture("static-picker");
  await openButton(page).click();
  await settled(page);
  await capture("ordinary-workspace");
  row.checks.push(
    "real canvas acquisition unavailable; static fire remains; ordinary usable navigation",
  );
});

scenario("mid-burn-real-resize", {}, async ({ page, row, capture }) => {
  await picker(page);
  await openButton(page).click();
  await burning(page);
  await page.setViewportSize({ width: 1000, height: 600 });
  await settled(page);
  await capture("resized-workspace");
  row.checks.push("real viewport resize aborts burn safely and restores workspace interaction");
});

scenario(
  "narrow-nine-club-scroll-real-touch",
  { hasTouch: true, viewport: { width: 390, height: 844 } },
  async ({ page, context, row, capture }) => {
    const many = [
      ...clubs,
      ...Array.from({ length: 7 }, (_, i) =>
        club(
          `00000000-0000-4000-8000-${String(301 + i).padStart(12, "0")}`,
          `Preview club ${i + 1}`,
          "Local fixture",
        ),
      ),
    ];
    await context.route(`${baseURL}/api/clubs`, (route) =>
      route.fulfill({ json: { clubs: many } }),
    );
    await picker(page);
    assert.equal(await page.locator(".club-playing-card:not(.new-club-card)").count(), 9);
    const last = page.getByRole("button", { name: /Preview club 7/ });
    await last.scrollIntoViewIfNeeded();
    row.scrollBefore = await page
      .locator(".club-portal-content")
      .evaluate((node) => node.scrollTop);
    assert(row.scrollBefore > 0);
    await capture("scrolled-picker");
    const rect = await last.boundingBox();
    await page.touchscreen.tap(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await burning(page);
    row.scrollDuring = await page
      .locator(".club-portal-content")
      .evaluate((node) => node.scrollTop);
    assert.equal(row.scrollDuring, row.scrollBefore, "retained source scroll must not jump");
    await capture("scrolled-touch-burn");
    await settled(page);
    assert.match(
      await page.locator(".club-exit-button").getAttribute("aria-label"),
      /Preview club 7/,
    );
    row.checks.push(
      "nine actual cards plus New club; real narrow scrolling; real touch last-card entry; preserved source scroll and correct destination",
    );
  },
);

scenario(
  "native-web-locks-contending-tab-refused",
  { reducedMotion: "reduce" },
  async ({ page, context, row, capture }) => {
    await picker(page);
    await openButton(page).click();
    // Lock refusal is independently meaningful before the presentation feature
    // lands; do not gate this safety assertion on the visual wrapper contract.
    await page.locator(".club-exit-button").waitFor();
    row.locks = await page.evaluate(() => navigator.locks.query());
    assert(
      row.locks.held.some((lock) => lock.name === "mafia-dashboard.game-session.v5.transaction"),
    );
    const other = await context.newPage();
    await other.goto(baseURL);
    await other.getByRole("alert").waitFor();
    row.refusal = await other.getByRole("alert").innerText();
    assert.match(row.refusal, /another tab/i);
    assert.equal(
      await other
        .locator(
          ".app-shell,.club-entry-effect,.club-card-open,.new-club-card,.club-user-chip button",
        )
        .count(),
      0,
    );
    const path = join(output, "native-web-locks-contending-tab-refused-blocked.png");
    await other.screenshot({ path });
    row.screenshots.push(path);
    await capture("owning-workspace");
    await other.close();
    row.checks.push(
      "real same-context Web Locks contention; localized blocking refusal; no burn/workspace/create/signout bypass",
    );
  },
);

scenario("missing-web-locks-refused", {}, async ({ page, row, capture }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined }),
  );
  await page.goto(baseURL);
  await page.getByRole("alert").waitFor();
  row.refusal = await page.getByRole("alert").innerText();
  assert.match(row.refusal, /safely|safety|browser|lock/i);
  assert.equal(
    await page
      .locator(
        ".app-shell,.club-entry-effect,.club-card-open,.new-club-card,.club-user-chip button",
      )
      .count(),
    0,
  );
  await capture("blocked");
  row.checks.push("missing native locking API fails closed before any handoff or workspace");
});

scenario("late-native-lock-readiness-and-eventual-focus", {}, async ({ page, row, capture }) => {
  await picker(page);
  // Hold delivery of the NEXT real lock callback, not app state or a readiness prop.
  // Native locking still owns the transaction until the deferred callback completes.
  const gate = await deferNextNativeLock(page);
  try {
    const start = new Date("2026-10-15T12:00:00Z");
    await page.clock.install({ time: start });
    await page.clock.pauseAt(new Date(start.getTime() + 60000));
    await openButton(page).click();
    await page.locator('.club-entry-effect[data-phase="waiting"]').waitFor();
    // React's waiting frame can precede native lock callback delivery. Wait for
    // the real platform callback, not another animation frame or a guessed delay.
    await page.waitForFunction((state) => state.acquired(), gate, { polling: 10 });
    assert(
      await gate.evaluate((state) => state.acquired()),
      "platform acquired the real lock before deferring callback readiness",
    );
    row.locksWhileDeferred = await page.evaluate(() => navigator.locks.query());
    assert(
      row.locksWhileDeferred.held.some(
        (lock) => lock.name === "mafia-dashboard.game-session.v5.transaction",
      ),
    );
    assert.equal(await page.locator(".club-entry-source").evaluate((node) => node.inert), true);
    assert.equal(
      await page.locator(".club-entry-destination").evaluate((node) => node.inert),
      true,
    );
    await capture("waiting-for-native-lock-callback");
    await page.clock.runFor(3200);
    assert.equal(
      await page.locator(".club-entry-source").count(),
      0,
      "3000ms readiness watchdog removes source within3200ms",
    );
    assert.equal(await page.locator(".club-entry-effect").count(), 0);
    assert.equal(
      await page.locator(".club-exit-button").count(),
      0,
      "workspace still genuinely not mounted while callback held",
    );
    await capture("readiness-watchdog-expired");
    await gate.evaluate((state) => state.release());
    await page.clock.runFor(32);
    await settled(page);
    await capture("late-ready-focused-workspace");
    row.checks.push(
      "actual native-lock callback held past3000ms; bounded source removal; late workspace readiness receives eventual focus",
    );
  } finally {
    await gate.evaluate((state) => state.release()).catch(() => {});
    await gate.dispose();
  }
});

const otherPreferences = {
  "mafia-dashboard.theme-color.v1": "#7170ff",
  "mafia-dashboard.glass.v1": JSON.stringify({
    version: 1,
    enabled: false,
    refraction: 12,
    goldLight: 31,
  }),
  "mafia-dashboard.player-exit.v1": JSON.stringify({
    version: 1,
    enabled: true,
    liftMs: 120,
    landingMs: 520,
    overlap: 75,
  }),
  "mafia-dashboard.lighting-renderer.v1": "legacy",
  "mafia-dashboard.player-pulse.v1": JSON.stringify({ enabled: true, speed: 1.5, strength: 0.12 }),
};
const fancyLabels = {
  en: {
    section: "Fancy stuff",
    disable: "Disable club entry effects",
    enable: "Enable club entry effects",
    developer: "Open developer menu",
    privacy: "Hide private info",
  },
  ru: {
    section: "Красивые эффекты",
    disable: "Выключить эффекты входа в клуб",
    enable: "Включить эффекты входа в клуб",
    developer: "Открыть меню разработчика",
    privacy: "Скрыть личную информацию",
  },
};
async function seedOtherPreferences(page, effects) {
  await page.addInitScript(
    ({ entries, key, effects }) => {
      for (const [name, value] of entries)
        if (window.localStorage.getItem(name) === null) window.localStorage.setItem(name, value);
      if (effects !== undefined)
        window.localStorage.setItem(key, JSON.stringify({ version: 1, clubEntryEffects: effects }));
    },
    { entries: Object.entries(otherPreferences), key: fancyStuffKey, effects },
  );
}
async function preferenceSnapshot(page) {
  return page.evaluate(
    (keys) => Object.fromEntries(keys.map((key) => [key, window.localStorage.getItem(key)])),
    Object.keys(otherPreferences),
  );
}
async function assertOtherPreferences(page) {
  assert.deepEqual(
    await preferenceSnapshot(page),
    otherPreferences,
    "Unrelated preferences retain exact bytes",
  );
}
async function storedFancyStuff(page) {
  return page.evaluate((key) => JSON.parse(window.localStorage.getItem(key)), fancyStuffKey);
}
async function visibleControlGeometry(page, control) {
  await control.scrollIntoViewIfNeeded();
  const rect = await control.boundingBox();
  const viewport = page.viewportSize();
  assert(rect && rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0);
  assert(rect.x + rect.width <= viewport.width + 1 && rect.y + rect.height <= viewport.height + 1);
  assert(
    await control.evaluate((node) => {
      const r = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }),
    "Native hit target is not occluded",
  );
  const layout = await page.evaluate(() => ({
    scrollY: window.scrollY,
    width: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  assert(layout.width <= layout.viewport + 1, "No horizontal overflow");
  assert.equal(layout.scrollY, 0, "Drawer/control scroll must not displace the document");
  return { rect, ...layout };
}
async function openFancyStuff(page, locale, unlock = false, capture) {
  const labels = fancyLabels[locale];
  if (unlock) {
    assert.equal(await page.locator(".dev-toolbar-button").count(), 0);
    const privacy = page.locator(".privacy-button");
    assert.equal(await privacy.getAttribute("aria-label"), labels.privacy);
    for (let i = 0; i < 6; i++) await privacy.click();
    assert.equal(
      await privacy.getAttribute("aria-pressed"),
      "false",
      "Six native clicks restore privacy visibility",
    );
  }
  await page.getByRole("button", { name: labels.developer, exact: true }).click();
  const details = page.locator("#dev-menu-drawer .fancy-stuff-controls");
  assert.equal(await details.evaluate((node) => node.open), false, "Fancy stuff starts collapsed");
  const summary = details.locator("summary");
  assert.equal(await summary.innerText(), labels.section);
  const geometry = await visibleControlGeometry(page, summary);
  if (capture) await capture("fancy-section-collapsed");
  await summary.click();
  return { details, geometry };
}
async function toggleFancyStuff(page, locale, enabled, activation = "mouse") {
  const control = page.getByRole("button", {
    name: fancyLabels[locale][enabled ? "disable" : "enable"],
    exact: true,
  });
  assert.equal(await control.getAttribute("aria-pressed"), String(enabled));
  const geometry = await visibleControlGeometry(page, control);
  if (activation === "keyboard") {
    // Summary received native focus from its click; Tab must reach the real toggle.
    await page.keyboard.press("Tab");
    assert(await control.evaluate((node) => node === document.activeElement));
    await page.keyboard.press("Space");
  } else await control.click();
  const changed = page.getByRole("button", {
    name: fancyLabels[locale][enabled ? "enable" : "disable"],
    exact: true,
  });
  assert.equal(await changed.getAttribute("aria-pressed"), String(!enabled));
  assert(await changed.evaluate((node) => node === document.activeElement), "Toggle retains focus");
  await assertOtherPreferences(page);
  return geometry;
}
async function closeFancyStuff(page) {
  await page.keyboard.press("Escape");
  await page.locator("#dev-menu-drawer").waitFor({ state: "detached" });
  assert(
    await page.locator(".dev-toolbar-button").evaluate((node) => node === document.activeElement),
  );
}
async function offPortal(page, slogan = englishSlogan) {
  await page.getByRole("heading", { name: slogan, exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".club-portal img")].every(
        (image) => image.complete && image.naturalWidth > 0,
      ),
    undefined,
    { polling: 10 },
  );
  const state = await page.evaluate(() => ({
    effects: document.querySelectorAll(
      ".club-fire-canvas,.club-entry-effect,.club-entry-canvas,.club-entry-defs,[data-club-fire-static]",
    ).length,
    clip: getComputedStyle(document.querySelector(".club-entry-source")).clipPath,
    inert: document.querySelector(".club-entry-source").inert,
    after: [...document.querySelectorAll(".club-playing-card:not(.new-club-card)")].map(
      (node) => getComputedStyle(node, "::after").content,
    ),
    images: [...document.querySelectorAll(".club-portal img")].map((image) => ({
      complete: image.complete,
      width: image.naturalWidth,
    })),
  }));
  assert.equal(state.effects, 0, "OFF removes canvas, clip definitions and static cue attributes");
  assert.equal(state.clip, "none");
  assert.equal(state.inert, false);
  assert(
    state.after.every((content) => content === "none" || content === "normal"),
    "No static ember pseudo-elements",
  );
  assert(
    state.images.every((image) => image.complete && image.width > 0),
    "Real portal images loaded",
  );
  return state;
}
async function observeDirectEntry(page) {
  return page.evaluateHandle(() => {
    const seen = [];
    const trusted = [];
    const inputs = [];
    const selector =
      ".club-entry-effect,.club-entry-canvas,.club-entry-defs,.club-fire-canvas,[data-burning='true']";
    const observer = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node.nodeType === 1 && (node.matches(selector) || node.querySelector(selector)))
            seen.push(node.outerHTML.slice(0, 1000));
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const click = (event) => {
      if (event.target.closest?.(".club-card-open"))
        trusted.push({
          isTrusted: event.isTrusted,
          detail: event.detail,
          pointerType: event.pointerType ?? null,
        });
    };
    const input = (event) => {
      if (event.target.closest?.(".club-card-open"))
        inputs.push({
          type: event.type,
          isTrusted: event.isTrusted,
          pointerType: event.pointerType ?? null,
        });
    };
    const inputTypes = ["pointerdown", "pointerup", "touchstart", "touchend"];
    for (const type of inputTypes) document.addEventListener(type, input, true);
    document.addEventListener("click", click, true);
    return {
      finish: () => {
        observer.disconnect();
        document.removeEventListener("click", click, true);
        for (const type of inputTypes) document.removeEventListener(type, input, true);
        return { seen, trusted, inputs };
      },
    };
  });
}
async function directEntry(page, activation, target = openButton(page)) {
  const observed = await observeDirectEntry(page);
  try {
    if (activation === "keyboard") {
      for (
        let i = 0;
        i < 20 && !(await target.evaluate((node) => node === document.activeElement));
        i++
      )
        await page.keyboard.press("Tab");
      assert(
        await target.evaluate((node) => node === document.activeElement),
        "Native Tab reaches club entry",
      );
      await page.keyboard.press("Shift+Tab");
      assert(!(await target.evaluate((node) => node === document.activeElement)));
      await page.keyboard.press("Tab");
      assert(await target.evaluate((node) => node === document.activeElement));
      await page.keyboard.press("Enter");
    } else if (activation === "touch") await target.tap();
    else await target.click();
    // The animation clock is frozen: readiness may resolve, but no decorative
    // frame or watchdog may be necessary for OFF entry and focus to complete.
    await settled(page);
    const state = await page.locator(".club-entry-destination").evaluate((node) => ({
      clip: getComputedStyle(node).clipPath,
      hidden: node.getAttribute("aria-hidden"),
      inert: node.inert,
    }));
    assert.deepEqual(state, { clip: "none", hidden: null, inert: false });
    const receipt = await observed.evaluate((state) => state.finish());
    assert.deepEqual(receipt.seen, [], "No transient transition/decorative DOM was mounted");
    assert.equal(receipt.trusted.length, 1, "Exactly one real native activation");
    assert(receipt.trusted[0].isTrusted);
    if (activation === "touch") {
      // WebKit delivers a compatibility click labelled mouse after genuine
      // touch events. Assert the native contact, not Chromium's click shape.
      assert(receipt.inputs.some((event) => event.type === "touchend" && event.isTrusted));
      assert(
        receipt.inputs.some(
          (event) =>
            event.type === "pointerdown" && event.pointerType === "touch" && event.isTrusted,
        ),
      );
    }
    return { activation, ...receipt, destination: state };
  } finally {
    await observed.dispose();
  }
}
async function pauseEntryClock(page) {
  const start = new Date("2026-10-15T12:00:00Z");
  await page.clock.install({ time: start });
  await page.clock.pauseAt(new Date(start.getTime() + 60000));
}

for (const [engine, width, height, locale] of [
  ["chromium", 1366, 768, "en"],
  ["chromium", 1000, 600, "ru"],
  ["webkit", 1366, 1024, "ru"],
]) {
  scenario(
    `fancy-stuff-${engine}-${width}x${height}-${locale}-real-control-lifecycle`,
    {
      engine,
      viewport: { width, height },
      hasTouch: true,
      locale: locale === "ru" ? "ru-RU" : "en-US",
    },
    async ({ page, row, capture }) => {
      await seedOtherPreferences(page);
      const slogan = locale === "ru" ? russianSlogan : englishSlogan;
      // Keep both portal and entered club in the requested locale.
      if (locale === "ru")
        await page.route(`${baseURL}/api/clubs`, (route) =>
          route.fulfill({ json: { clubs: clubs.map((entry) => ({ ...entry, language: "ru" })) } }),
        );
      await picker(page, slogan);
      assert.equal(
        await storedFancyStuff(page),
        null,
        "Fresh browser defaults ON without a saved preference",
      );
      await page.locator('.club-fire-canvas[data-renderer="webgl"]').waitFor();
      await capture("default-on-picker");
      await pauseEntryClock(page);
      const initial = await observeClick(page);
      await openButton(page).click();
      await burning(page);
      row.defaultOn = await burnMetrics(page, initial);
      assert(
        row.defaultOn.retainedCard && row.defaultOn.retainedPortal && row.defaultOn.intactCard,
      );
      await capture("default-on-real-dom-burn");
      await page.clock.runFor(2000);
      await settled(page);
      await initial.dispose();
      row.drawer = await openFancyStuff(page, locale, true, capture);
      delete row.drawer.details;
      await capture("collapsed-section-opened");
      row.toggleOff = await toggleFancyStuff(
        page,
        locale,
        true,
        locale === "ru" ? "keyboard" : "mouse",
      );
      assert.deepEqual(await storedFancyStuff(page), { version: 1, clubEntryEffects: false });
      await capture("effects-off-control");
      await closeFancyStuff(page);
      row.checks.push(
        "default ON actual-DOM burn; six native Private info clicks; collapsed localized Fancy stuff; accessible real toggle OFF; exact dedicated stored value and retained focus",
      );
      row.directEntries = [];
      for (const activation of ["mouse", "keyboard", "touch"]) {
        await page.locator(".club-exit-button").click();
        row.offPortal = await offPortal(page, slogan);
        await capture(`${activation}-off-picker`);
        row.directEntries.push(await directEntry(page, activation));
        await capture(`${activation}-direct-focused-workspace`);
      }
      // Reduced-motion fallback must not resurrect still ember cues while OFF.
      await page.locator(".club-exit-button").click();
      await page.emulateMedia({ reducedMotion: "reduce" });
      await offPortal(page, slogan);
      await capture("off-reduced-motion-no-static-cues");
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.clock.resume();
      await page.reload();
      await offPortal(page, slogan);
      assert.deepEqual(await storedFancyStuff(page), { version: 1, clubEntryEffects: false });
      await assertOtherPreferences(page);
      await pauseEntryClock(page);
      row.reloadEntry = await directEntry(page, "keyboard");
      await openFancyStuff(page, locale);
      await capture("reloaded-preserved-off");
      row.toggleOn = await toggleFancyStuff(
        page,
        locale,
        false,
        locale === "ru" ? "keyboard" : "mouse",
      );
      assert.deepEqual(await storedFancyStuff(page), { version: 1, clubEntryEffects: true });
      await closeFancyStuff(page);
      await page.locator(".club-exit-button").click();
      await page.getByRole("heading", { name: slogan, exact: true }).waitFor();
      await page.locator('.club-fire-canvas[data-renderer="webgl"]').waitFor();
      await capture("reenabled-on-picker");
      const restored = await observeClick(page);
      await openButton(page).click();
      await burning(page);
      row.restored = { ignition: await burnMetrics(page, restored) };
      assert(
        row.restored.ignition.retainedCard &&
          row.restored.ignition.retainedPortal &&
          row.restored.ignition.intactCard,
      );
      await page.clock.runFor(352);
      row.restored.at352ms = await burnMetrics(page, restored);
      assert(
        row.restored.at352ms.cardArea > 0 &&
          row.restored.at352ms.cardArea < row.restored.ignition.cardArea,
      );
      await capture("reenabled-352ms-inward-burn");
      await page.clock.runFor(32);
      row.restored.at384ms = await burnMetrics(page, restored);
      assert.equal(row.restored.at384ms.cardArea, 0);
      await page.clock.runFor(1408);
      assert.equal(await page.locator(".club-entry-effect").getAttribute("data-phase"), "burning");
      await capture("reenabled-1792ms-outward-burn");
      await page.clock.runFor(208);
      await settled(page);
      await assertOtherPreferences(page);
      await restored.dispose();
      await capture("reenabled-focused-workspace");
      await page.clock.resume();
      row.checks.push(
        "OFF removes ambient canvas/static cues/clip/decorative delay; frozen-clock trusted mouse, Tab/Shift+Tab/Enter and touch entry; destination focus; reload persists OFF; real re-enable restores ambient WebGL and actual-DOM 360ms inward/1800ms outward burn; unrelated preferences unchanged",
      );
    },
  );
}

scenario("fancy-stuff-preference-only-denied-setitem", {}, async ({ page, row, capture }) => {
  await seedOtherPreferences(page);
  await picker(page);
  await pauseEntryClock(page);
  await openButton(page).click();
  await burning(page);
  await page.clock.runFor(2000);
  await settled(page);
  await openFancyStuff(page, "en", true);
  const denial = await page.evaluateHandle((key) => {
    const prototype = Object.getPrototypeOf(window.localStorage);
    const original = prototype.setItem;
    const rejected = [];
    prototype.setItem = function (name, value) {
      if (name === key) {
        rejected.push({ key: name, value });
        throw new DOMException("Fixture denies only the appearance preference", "SecurityError");
      }
      return original.call(this, name, value);
    };
    window.localStorage.setItem("club-entry-test.allowed-storage", "yes");
    const unrelatedWrite = window.localStorage.getItem("club-entry-test.allowed-storage");
    window.localStorage.removeItem("club-entry-test.allowed-storage");
    return {
      receipt: () => ({ rejected, unrelatedWrite }),
      restore: () => {
        prototype.setItem = original;
      },
    };
  }, fancyStuffKey);
  try {
    await toggleFancyStuff(page, "en", true);
    assert.equal(await storedFancyStuff(page), null, "Denied OFF is not falsely persisted");
    row.storageDenial = await denial.evaluate((state) => state.receipt());
    assert.deepEqual(row.storageDenial, {
      rejected: [
        { key: fancyStuffKey, value: JSON.stringify({ version: 1, clubEntryEffects: false }) },
      ],
      unrelatedWrite: "yes",
    });
    await capture("denied-write-live-off");
    await closeFancyStuff(page);
    await page.locator(".club-exit-button").click();
    await offPortal(page);
    row.directEntry = await directEntry(page, "keyboard");
    await assertOtherPreferences(page);
    await capture("denied-write-direct-focused-workspace");
    await page.locator(".club-exit-button").click();
    await offPortal(page);
  } finally {
    await denial.evaluate((state) => state.restore());
    await denial.dispose();
  }
  await page.clock.resume();
  await page.reload();
  await page.getByRole("heading", { name: englishSlogan, exact: true }).waitFor();
  await page.locator('.club-fire-canvas[data-renderer="webgl"]').waitFor();
  assert.equal(await storedFancyStuff(page), null);
  await assertOtherPreferences(page);
  await capture("denied-write-reload-defaults-on");
  row.checks.push(
    "Only dedicated preference setItem denied; unrelated native writes work; real toggle stays OFF in memory; direct keyboard entry/focus safe; reload honestly returns unsaved default ON; other preferences unchanged",
  );
});

scenario(
  "fancy-stuff-off-native-web-locks-contention",
  {},
  async ({ page, context, row, capture }) => {
    await seedOtherPreferences(page, false);
    await picker(page);
    await offPortal(page);
    await pauseEntryClock(page);
    row.directEntry = await directEntry(page, "mouse");
    row.locks = await page.evaluate(() => navigator.locks.query());
    assert(
      row.locks.held.some((lock) => lock.name === "mafia-dashboard.game-session.v5.transaction"),
    );
    const other = await context.newPage();
    await other.goto(baseURL);
    await other.getByRole("alert").waitFor();
    row.refusal = await other.getByRole("alert").innerText();
    assert.match(row.refusal, /another tab/i);
    assert.deepEqual(await storedFancyStuff(other), { version: 1, clubEntryEffects: false });
    assert.equal(
      await other
        .locator(
          ".app-shell,.club-entry-effect,.club-fire-canvas,.club-card-open,.new-club-card,.club-user-chip button",
        )
        .count(),
      0,
    );
    const path = join(output, "fancy-stuff-off-native-web-locks-contention-blocked.png");
    await other.screenshot({ path });
    row.screenshots.push(path);
    await capture("off-owning-focused-workspace");
    await other.close();
    await page.clock.resume();
    row.checks.push(
      "Saved OFF still holds real native transaction ownership; second tab fails closed without entry/create/signout bypass or decoration",
    );
  },
);

scenario("fancy-stuff-off-missing-web-locks-refused", {}, async ({ page, row, capture }) => {
  await seedOtherPreferences(page, false);
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined }),
  );
  await page.goto(baseURL);
  await page.getByRole("alert").waitFor();
  row.refusal = await page.getByRole("alert").innerText();
  assert.match(row.refusal, /safely|safety|browser|lock/i);
  assert.equal(
    await page
      .locator(
        ".app-shell,.club-entry-effect,.club-fire-canvas,.club-card-open,.new-club-card,.club-user-chip button",
      )
      .count(),
    0,
  );
  await capture("off-missing-lock-fails-closed");
  row.checks.push("Saved OFF cannot bypass absent native storage locking API");
});

// Same real-native-callback barrier as the maintained ON readiness fixture.
async function deferNextNativeLock(page) {
  return page.evaluateHandle(() => {
    const original = navigator.locks.request.bind(navigator.locks);
    let release;
    let acquired = false;
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    navigator.locks.request = (...args) => {
      navigator.locks.request = original;
      const callback = args.pop();
      return original(...args, async (lock) => {
        acquired = !!lock;
        await barrier;
        return callback(lock);
      });
    };
    return { release: () => release(), acquired: () => acquired };
  });
}
async function assertOffPendingReadiness(page, gate) {
  await page.waitForFunction((state) => state.acquired(), gate, { polling: 10 });
  const locks = await page.evaluate(() => navigator.locks.query());
  assert(locks.held.some((lock) => lock.name === "mafia-dashboard.game-session.v5.transaction"));
  assert.equal(
    await page
      .locator(
        ".club-entry-source,.club-entry-effect,.club-entry-canvas,.club-entry-defs,.club-fire-canvas,.club-exit-button",
      )
      .count(),
    0,
  );
  assert.equal(await page.locator(".club-entry-destination").evaluate((node) => node.inert), false);
  assert.equal(await page.locator(".club-entry-destination [role='status']").count(), 1);
  assert.equal(
    await page.locator(".app-fixed-toolbar").count(),
    0,
    "No workspace access before genuine readiness",
  );
  return locks;
}
scenario("fancy-stuff-off-late-native-readiness-and-focus", {}, async ({ page, row, capture }) => {
  await seedOtherPreferences(page, false);
  await picker(page);
  await offPortal(page);
  await pauseEntryClock(page);
  const gate = await deferNextNativeLock(page);
  try {
    await openButton(page).click();
    row.locksWhileDeferred = await assertOffPendingReadiness(page, gate);
    await capture("off-real-readiness-status-not-burn");
    await page.clock.runFor(3200);
    await assertOffPendingReadiness(page, gate);
    await capture("off-still-waits-for-storage-after-3200ms");
    await gate.evaluate((state) => state.release());
    // No clock advancement after real readiness: OFF needs no decorative delay.
    await settled(page);
    await assertOtherPreferences(page);
    await capture("off-late-ready-focused-workspace");
    row.checks.push(
      "OFF renders genuine readiness status without burn/clip/source; no workspace access while native callback held past3200ms; release gives eventual focus without advancing decorative clock",
    );
  } finally {
    await gate.evaluate((state) => state.release()).catch(() => {});
    await gate.dispose();
    await page.clock.resume();
  }
});

scenario(
  "fancy-stuff-off-pending-readiness-document-cancel",
  {},
  async ({ page, row, capture }) => {
    await seedOtherPreferences(page, false);
    await picker(page);
    await offPortal(page);
    const gate = await deferNextNativeLock(page);
    try {
      await openButton(page).click();
      await assertOffPendingReadiness(page, gate);
      await capture("off-pending-before-document-cancel");
      const oldDocument = await page.evaluateHandle(() => document.documentElement);
      await page.goto(`${baseURL}/?fancy-stuff-cancel`);
      await offPortal(page);
      row.oldDocumentDestroyed = await oldDocument
        .evaluate((node) => node.isConnected)
        .then(
          () => false,
          () => true,
        );
      assert(row.oldDocumentDestroyed);
      assert.equal(await page.locator(".club-entry-destination").count(), 0);
      await pauseEntryClock(page);
      row.freshEntry = await directEntry(page, "keyboard");
      await assertOtherPreferences(page);
      await capture("off-cancel-fresh-focused-entry");
      await page.clock.resume();
      row.checks.push(
        "Real document teardown cancels deferred OFF entry, releases native ownership, returns to undecorated portal and permits fresh keyboard entry/focus without stale callbacks",
      );
    } finally {
      await gate.evaluate((state) => state.release()).catch(() => {});
      await gate.dispose();
    }
  },
);

scenario("actual-document-unmount-and-return", {}, async ({ page, row, capture }) => {
  await picker(page);
  await openButton(page).click();
  await burning(page);
  await capture("before-document-teardown");
  const oldDocument = await page.evaluateHandle(() => document.documentElement);
  await page.goto(`${baseURL}/?club-entry-return`);
  await page.getByRole("heading", { name: englishSlogan, exact: true }).waitFor();
  assert.equal(await page.locator(".club-entry-effect,.club-entry-destination").count(), 0);
  row.oldDocumentHandleDestroyed = await oldDocument
    .evaluate((node) => node.isConnected)
    .then(
      () => false,
      () => true,
    );
  assert(row.oldDocumentHandleDestroyed, "navigation must replace the actual old document");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openButton(page).click();
  await settled(page);
  await capture("fresh-document-reentry");
  row.checks.push(
    "actual full-document teardown mid-burn; fresh portal has no stale effect; native lock released; re-entry completes",
  );
});
