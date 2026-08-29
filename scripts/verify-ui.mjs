/* global URL, document, getComputedStyle, HTMLElement, HTMLInputElement, innerHeight, innerWidth, structuredClone, sessionStorage, crypto, TextEncoder, ErrorEvent, Event */
import { chromium, webkit } from "@playwright/test";
import {
  assertExactOrigin,
  createHeadOperationExpectations,
} from "./session-verifier-contracts.mjs";

const baseUrl = process.env.APP_URL ?? "http://127.0.0.1:8080";
const expectedOrigin = new URL(baseUrl).origin;
let browserAppUrl = baseUrl;
let storageMutationUrl;
const fulfillMock = async (route, response) => {
  assertExactOrigin(route.request().url(), expectedOrigin);
  await route.fulfill(response);
};
const unlockDeveloperMenu = async (page) => {
  const menuButton = page.getByRole("button", { name: "Open developer menu" });
  if (!(await menuButton.isVisible())) {
    const privacy = page.getByRole("button", { name: /^(Hide|Show) private info$/ });
    for (let tap = 0; tap < 5; tap += 1) await privacy.dispatchEvent("click");
  }
  await menuButton.waitFor();
};
const screenshotPath = process.env.UI_SCREENSHOT ?? "/tmp/mafia-dashboard-setup.png";
const tableScreenshotPath = process.env.UI_TABLE_SCREENSHOT ?? "/tmp/mafia-dashboard-table.png";
const sidePanelScreenshotPath =
  process.env.UI_SIDE_PANEL_SCREENSHOT ?? "/tmp/mafia-dashboard-side-panel.png";
const queueTagsScreenshotPath =
  process.env.UI_QUEUE_TAGS_SCREENSHOT ?? "/tmp/mafia-dashboard-queue-tags.png";
const glassScreenshotPath =
  process.env.UI_GLASS_SCREENSHOT ?? "/tmp/mafia-dashboard-malagas-glass.png";
const playersScreenshotPath =
  process.env.UI_PLAYERS_SCREENSHOT ?? "/tmp/mafia-dashboard-players.png";
const selectionScreenshotPath =
  process.env.UI_SELECTION_SCREENSHOT ?? "/tmp/mafia-dashboard-player-selection.png";
const previewScreenshotPath =
  process.env.UI_HISTORY_PREVIEW_SCREENSHOT ?? "/tmp/mafia-dashboard-log-preview-ipad.png";
const timelineScreenshotPath =
  process.env.UI_TIMELINE_SCREENSHOT ?? "/tmp/mafia-dashboard-timeline-ipad.png";
const timelineRightScreenshotPath = timelineScreenshotPath.replace(/\.png$/i, "-right.png");
const carCrashScreenshotPath =
  process.env.UI_CAR_CRASH_SCREENSHOT ?? "/tmp/mafia-dashboard-car-crash-zero-votes-ipad.png";
const testNicknames = Array.from({ length: 11 }, (_, index) => `UI Player ${index + 1}`);
const emptyStatistics = {
  hostedGames: 0,
  gamesPlayed: 0,
  wins: 0,
  losses: 0,
  redGames: 0,
  redWins: 0,
  blackGames: 0,
  blackWins: 0,
  sheriffGames: 0,
  citizenGames: 0,
  mafiaGames: 0,
  donGames: 0,
  totalFouls: 0,
  eliminations: 0,
  redCards: 0,
};
const testPlayers = testNicknames.map((nickname, index) => ({
  id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  nickname,
  consent: false,
  firstName: null,
  lastName: null,
  email: null,
  consentAt: null,
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
  lastPlayedAt: null,
  statistics: emptyStatistics,
}));
const testClub = {
  id: "00000000-0000-4000-8000-000000000101",
  name: "Mafia Malaga",
  city: "Málaga",
  headerLogo: null,
  cardLogo: null,
  language: "en",
  role: "manager",
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z",
};
const browserName = process.env.UI_BROWSER ?? "chromium";
const viewportWidth = Number(process.env.UI_VIEWPORT_WIDTH ?? "");
const viewportHeight = Number(process.env.UI_VIEWPORT_HEIGHT ?? "");
const headerOnly = process.env.UI_HEADER_ONLY === "1";
const browser =
  browserName === "webkit"
    ? await webkit.launch({ headless: true })
    : await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({
  hasTouch: headerOnly,
  viewport:
    Number.isFinite(viewportWidth) &&
    viewportWidth > 0 &&
    Number.isFinite(viewportHeight) &&
    viewportHeight > 0
      ? { width: viewportWidth, height: viewportHeight }
      : browserName === "webkit"
        ? { width: 1376, height: 1032 }
        : { width: 1366, height: 1024 },
});
const pageErrors = [];
const routeErrors = [];
const headOperationExpectations = createHeadOperationExpectations();
page.on("console", (message) => console.log(`browser console [${message.type()}]`));
page.on("pageerror", (error) => {
  pageErrors.push(error.message);
  console.error(`browser page error: ${error.message}`);
});
const assertNoPageErrors = () => {
  headOperationExpectations.assertDrained();
  if (pageErrors.length > 0) {
    throw new Error(`Browser page errors occurred: ${pageErrors.join(" | ")}`);
  }
  if (routeErrors.length > 0) {
    throw new Error(`Unexpected verifier API requests occurred: ${routeErrors.join(" | ")}`);
  }
};

await page.addInitScript(() => {
  window.__mafiaAudioStarts = [];
  class VerifierAudioContext {
    currentTime = 5;
    destination = {};
    createOscillator() {
      return {
        frequency: { value: 0 },
        connect: () => undefined,
        disconnect: () => undefined,
        start: (when = this.currentTime) => window.__mafiaAudioStarts.push(when - this.currentTime),
        stop: () => undefined,
      };
    }
    createGain() {
      return {
        gain: {
          setValueAtTime: () => undefined,
          exponentialRampToValueAtTime: () => undefined,
        },
        connect: () => undefined,
      };
    }
    resume() {
      return Promise.resolve();
    }
  }
  Object.defineProperty(window, "AudioContext", {
    configurable: true,
    value: VerifierAudioContext,
  });
  window.__mafiaVerifierCheckpointEnvelope = async (envelope, game) => {
    const root = envelope.entries.find((entry) => entry.parentEventId === null);
    if (root === undefined) throw new Error("Expected a persisted replay root");
    const canonical = (value) =>
      Array.isArray(value)
        ? value.map(canonical)
        : value === null || typeof value !== "object"
          ? value
          : Object.fromEntries(
              Object.entries(value)
                .filter(([, entry]) => entry !== undefined)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, entry]) => [key, canonical(entry)]),
            );
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(canonical(game))),
    );
    Object.assign(root, {
      sequence: 1,
      parentEventId: null,
      type: "game.checkpointed",
      payload: {},
      phaseBefore: game.phase,
      phaseAfter: game.phase,
      dayBefore: game.day,
      dayAfter: game.day,
      stateHashAfter: `sha256:${Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("")}`,
    });
    envelope.baseline = { replayVersion: 1, game };
    envelope.entries = [root];
    envelope.headEventId = root.id;
  };
});

await page.route("**/api/**", async (route) => {
  const request = route.request();
  assertExactOrigin(request.url(), expectedOrigin);
  const pathname = new URL(request.url()).pathname;
  if (!pathname.startsWith("/api/")) {
    await route.fallback();
    return;
  }
  routeErrors.push(`${request.method()} ${pathname}`);
  await fulfillMock(route, { status: 500, contentType: "application/json", body: "{}" });
});

await page.route("**/api/auth/session", async (route) => {
  await fulfillMock(route, {
    contentType: "application/json",
    body: JSON.stringify({
      configured: true,
      user: {
        id: "00000000-0000-4000-8000-000000000001",
        email: "ui@example.com",
        name: "UI Verification",
        picture: null,
      },
    }),
  });
});
await page.route("**/api/clubs", async (route) => {
  await fulfillMock(route, {
    contentType: "application/json",
    body: JSON.stringify({ clubs: [testClub] }),
  });
});
await page.route("**/api/music/oauth/status", async (route) => {
  await fulfillMock(route, {
    contentType: "application/json",
    body: JSON.stringify({ configured: true, connected: true, accountLabel: "ui@example.com" }),
  });
});
await page.route("**/api/music/playlists", async (route) => {
  await fulfillMock(route, {
    contentType: "application/json",
    body: JSON.stringify({
      playlists: [{ id: "test-playlist", title: "UI Verification", itemCount: 12 }],
    }),
  });
});
await page.route("**/api/music/playlists/*/items", async (route) => {
  await fulfillMock(route, {
    contentType: "application/json",
    body: JSON.stringify({
      items: [
        {
          videoId: "ui-track-1",
          title: "UI verification track",
          channelTitle: "UI verification",
          thumbnailUrl: null,
          position: 0,
        },
        {
          videoId: "ui-track-2",
          title: "UI verification middle",
          channelTitle: "UI verification",
          thumbnailUrl: null,
          position: 1,
        },
        {
          videoId: "ui-track-3",
          title: "UI verification finale",
          channelTitle: "UI verification",
          thumbnailUrl: null,
          position: 2,
        },
        {
          videoId: "ui-track-4",
          title: "UI verification opening two",
          channelTitle: "UI verification",
          thumbnailUrl: null,
          position: 3,
        },
        {
          videoId: "ui-track-5",
          title: "UI verification ordinary two",
          channelTitle: "UI verification",
          thumbnailUrl: null,
          position: 4,
        },
      ],
    }),
  });
});
await page.route("**/api/players*", async (route) => {
  if (route.request().method() !== "GET") {
    routeErrors.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    await fulfillMock(route, { status: 400, contentType: "application/json", body: "{}" });
    return;
  }
  await fulfillMock(route, {
    contentType: "application/json",
    body: JSON.stringify({ players: testPlayers }),
  });
});
await page.route("**/api/game-sessions", async (route) => {
  if (route.request().method() !== "GET") {
    routeErrors.push(`${route.request().method()} /api/game-sessions`);
  }
  await fulfillMock(route, {
    contentType: "application/json",
    body: JSON.stringify({ sessions: [] }),
  });
});
await page.route("**/api/game-sessions?*", async (route) => {
  if (route.request().method() !== "GET") {
    routeErrors.push(`${route.request().method()} /api/game-sessions?status`);
  }
  await fulfillMock(route, {
    contentType: "application/json",
    body: JSON.stringify({ sessions: [] }),
  });
});
await page.route("**/api/game-sessions/**", async (route) => {
  const request = route.request();
  if (request.method() === "DELETE") {
    const requestUrl = new URL(request.url());
    const validDelete =
      /^\/api\/game-sessions\/[0-9a-f-]{36}$/i.test(requestUrl.pathname) &&
      /^\d+$/.test(requestUrl.searchParams.get("expectedRevision") ?? "");
    if (!validDelete) {
      routeErrors.push(`DELETE ${requestUrl.pathname}`);
      await fulfillMock(route, { status: 400, contentType: "application/json", body: "{}" });
      return;
    }
    await fulfillMock(route, { status: 204, body: "" });
    return;
  }
  if (request.method() === "POST") {
    const operation = request.postDataJSON();
    const operationName = new URL(request.url()).pathname.split("/").at(-1);
    let valid =
      Number.isSafeInteger(operation.baseRevision) && typeof operation.mutationId === "string";
    if (operationName === "head") {
      try {
        headOperationExpectations.consume(operation);
      } catch (error) {
        routeErrors.push(error instanceof Error ? error.message : String(error));
        valid = false;
      }
    } else {
      valid &&=
        (operationName === "start" &&
          (operation.event?.type === "game.started" ||
            operation.event?.type === "game.checkpointed")) ||
        (operationName === "events" && typeof operation.event?.type === "string") ||
        (operationName === "complete" && operation.results != null);
    }
    if (!valid) {
      routeErrors.push(`POST ${new URL(request.url()).pathname}`);
      await fulfillMock(route, { status: 400, contentType: "application/json", body: "{}" });
      return;
    }
    await fulfillMock(route, {
      contentType: "application/json",
      body: JSON.stringify({
        revision: operation.baseRevision + 1,
        duplicate: false,
      }),
    });
    return;
  }
  if (request.method() !== "PUT") {
    await fulfillMock(route, { status: 404, contentType: "application/json", body: "{}" });
    return;
  }
  const mutation = request.postDataJSON();
  if (
    mutation.state?.game !== null ||
    mutation.state?.initialGame !== undefined ||
    mutation.state?.events !== undefined ||
    mutation.state?.headEventId !== undefined
  ) {
    routeErrors.push(`PUT ${new URL(request.url()).pathname}`);
    await fulfillMock(route, { status: 400, contentType: "application/json", body: "{}" });
    return;
  }
  const gameId = new globalThis.URL(request.url()).pathname.split("/").at(-1);
  await fulfillMock(route, {
    status: mutation.baseRevision === 0 ? 201 : 200,
    contentType: "application/json",
    body: JSON.stringify({
      gameId,
      name: mutation.name,
      revision: mutation.baseRevision + 1,
      duplicate: false,
      status: mutation.results === null ? "active" : "completed",
      hostName: mutation.state.hostName,
      phase: mutation.state.game?.phase ?? "setup-players",
      day: mutation.state.game?.day ?? 0,
      updatedAt: "2026-08-18T00:00:00.000Z",
      state: mutation.state,
      results: mutation.results,
    }),
  });
});

try {
  await page.goto(browserAppUrl, { waitUntil: "networkidle" });
  assertExactOrigin(page.url(), expectedOrigin);
  browserAppUrl = page.url();
  storageMutationUrl = new URL("/health/ready", browserAppUrl).href;
  if ((await page.title()) !== "Mafia Dashboard") throw new Error("Unexpected page title");
  const clubPortal = page.getByRole("heading", { name: "Choose your club" });
  if (await clubPortal.isVisible()) {
    await page.locator(".club-playing-card:not(.new-club-card)").first().click();
    await page.waitForTimeout(950);
  }
  await unlockDeveloperMenu(page);
  const setupHeading = page.getByRole("heading", { name: "Select 10 players + host" });
  if (!(await setupHeading.isVisible())) {
    await page.getByRole("heading", { name: "Players & statistics" }).waitFor();
    await page.getByRole("article", { name: "Player UI Player 1", exact: true }).waitFor();
    await page.screenshot({ path: playersScreenshotPath, fullPage: true });
    await page.getByRole("button", { name: "Open developer menu" }).click();
    await page.getByRole("button", { name: "Game screen" }).click();
  }
  await setupHeading.waitFor();
  const saveButton = page.getByRole("button", {
    name: "Saved to server · tap to check connection",
  });
  await saveButton.waitFor();
  const saveIndicator = await saveButton.evaluate(async (button) => {
    const original = button.dataset.status;
    const colors = {};
    for (const status of ["saved", "saving", "offline"]) {
      button.dataset.status = status;
      await new Promise(window.requestAnimationFrame);
      colors[status] = getComputedStyle(button).color;
    }
    button.dataset.status = original;
    return { tagName: button.tagName, original, colors };
  });
  if (saveIndicator.tagName !== "BUTTON" || saveIndicator.original !== "saved") {
    throw new Error("The Save indicator must be an interactive saved-state button");
  }
  if (new Set(Object.values(saveIndicator.colors)).size !== 3) {
    throw new Error(
      `Saved, retrying, and offline Save colors must be visually distinct: ${JSON.stringify(saveIndicator.colors)}`,
    );
  }
  if (headerOnly) {
    if ((await page.getByText("Development only", { exact: true }).count()) !== 0) {
      throw new Error("Development-only setup tools must be hidden before Dev mode is enabled");
    }
    await page.evaluate(() => {
      console.error(new Error("Verifier console error"));
      window.dispatchEvent(
        new ErrorEvent("error", {
          message: "Verifier window error",
          error: new Error("Verifier window error"),
        }),
      );
      const rejection = new Event("unhandledrejection");
      Object.defineProperty(rejection, "reason", { value: new Error("Verifier promise error") });
      window.dispatchEvent(rejection);
    });
    await page.getByRole("button", { name: "Open developer menu" }).click();
    await page.getByRole("button", { name: "Enable dev mode" }).waitFor();
    if ((await page.getByRole("button", { name: /table center shadow/i }).count()) !== 0) {
      throw new Error("The permanent table-center shadow must not expose a Dev setting");
    }
    await page.getByRole("button", { name: "Console" }).click();
    await page.getByRole("heading", { name: "Console", exact: true }).waitFor();
    for (const message of [
      "Verifier console error",
      "Verifier window error",
      "Verifier promise error",
    ]) {
      await page.getByText(message, { exact: true }).waitFor();
    }
    const consoleGeometry = await page.locator(".error-console-screen").evaluate((screen) => {
      const box = screen.getBoundingClientRect();
      const list = screen.querySelector(".error-console-list");
      return {
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        documentHeight: document.documentElement.scrollHeight,
        listScrollable:
          list instanceof HTMLElement ? list.scrollHeight >= list.clientHeight : false,
      };
    });
    if (
      Math.abs(consoleGeometry.left) > 1 ||
      Math.abs(consoleGeometry.top) > 1 ||
      Math.abs(consoleGeometry.width - consoleGeometry.viewportWidth) > 1 ||
      Math.abs(consoleGeometry.height - consoleGeometry.viewportHeight) > 1 ||
      consoleGeometry.documentHeight > consoleGeometry.viewportHeight + 1
    ) {
      throw new Error(`Console must fill the fixed viewport: ${JSON.stringify(consoleGeometry)}`);
    }
    await page.getByRole("button", { name: "Clear console" }).click();
    await page.getByText("No errors have been captured.").waitFor();
    await page.getByRole("button", { name: "Back" }).click();
    await setupHeading.waitFor();

    await page.getByRole("button", { name: "Select available players" }).click();
    const availablePlayers = page.getByRole("button", { name: /^Mark UI Player \d+ available$/ });
    if ((await availablePlayers.count()) !== 11) {
      throw new Error("Expected eleven players in the availability picker");
    }
    for (let playerIndex = 0; playerIndex < 11; playerIndex += 1) {
      await availablePlayers.first().click();
    }
    await page.getByRole("button", { name: "Close available players" }).click();
    await page.getByRole("combobox", { name: "Host player" }).click();
    await page.getByRole("option", { name: testNicknames[10], exact: true }).click();
    await page.getByRole("button", { name: "Assign players" }).click();
    const startGame = page.getByRole("button", { name: "Start game" });
    await startGame.waitFor();
    await page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Start game" && !button.disabled,
      ),
    );
    if ((await page.getByRole("button", { name: /set up music/i }).count()) !== 0) {
      throw new Error("Music setup must not remain on the game-setup screen");
    }
    const playerSetupActions = page.getByRole("group", { name: "Player setup actions" });
    const actionRowGeometry = await playerSetupActions.getByRole("button").evaluateAll((buttons) =>
      buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return { text: button.textContent?.trim(), top: box.top, left: box.left, right: box.right };
      }),
    );
    if (
      actionRowGeometry.length !== 3 ||
      actionRowGeometry.some(({ top }) => Math.abs(top - actionRowGeometry[0].top) > 1) ||
      actionRowGeometry.some((_, index) =>
        index === 0 ? false : actionRowGeometry[index - 1].right > actionRowGeometry[index].left,
      )
    ) {
      throw new Error(
        `Player setup actions must share one non-overlapping row when labels fit: ${JSON.stringify(actionRowGeometry)}`,
      );
    }
    const wrappedActionGeometry = await playerSetupActions.evaluate((group) => {
      const previousWidth = group.style.width;
      group.style.width = "220px";
      const groupBox = group.getBoundingClientRect();
      const buttons = [...group.querySelectorAll("button")].map((button) => {
        const box = button.getBoundingClientRect();
        return { top: box.top, width: box.width };
      });
      group.style.width = previousWidth;
      return { groupWidth: groupBox.width, buttons };
    });
    const wrappedRows = wrappedActionGeometry.buttons.reduce((rows, button) => {
      const key = Math.round(button.top);
      rows.set(key, [...(rows.get(key) ?? []), button]);
      return rows;
    }, new Map());
    if (
      wrappedRows.size < 2 ||
      [...wrappedRows.values()].some(
        (row) => row.length === 1 && Math.abs(row[0].width - wrappedActionGeometry.groupWidth) > 1,
      )
    ) {
      throw new Error(
        `Wrapped player setup actions must fill singleton rows: ${JSON.stringify(wrappedActionGeometry)}`,
      );
    }
    const firstSeat = page.getByRole("combobox", { name: "Seat 1 player" });
    const firstSeatName = await firstSeat.inputValue();
    await page.getByRole("button", { name: "Clear Seat 1", exact: true }).click();
    if ((await firstSeat.inputValue()) !== "" || (await startGame.isEnabled())) {
      throw new Error("Clearing Seat 1 must empty the seat and disable Start game");
    }
    await firstSeat.click();
    await page.getByRole("option", { name: firstSeatName, exact: true }).click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Start game" && !button.disabled,
      ),
    );
    const playerControlGeometry = await firstSeat.evaluate((input) => {
      const control = input.closest(".player-combobox-control");
      const clear = control?.querySelector(".player-combobox-clear");
      const chevron = control?.querySelector(".player-combobox-chevron");
      if (
        !(input instanceof HTMLElement) ||
        !(clear instanceof HTMLElement) ||
        !(chevron instanceof HTMLElement)
      ) {
        throw new Error("Expected the player input, Clear button, and down arrow");
      }
      const inputBox = input.getBoundingClientRect();
      const clearBox = clear.getBoundingClientRect();
      const chevronBox = chevron.getBoundingClientRect();
      return {
        inputCenterY: inputBox.top + inputBox.height / 2,
        clearCenterY: clearBox.top + clearBox.height / 2,
        chevronCenterY: chevronBox.top + chevronBox.height / 2,
        clearRight: clearBox.right,
        chevronLeft: chevronBox.left,
      };
    });
    if (
      Math.abs(playerControlGeometry.inputCenterY - playerControlGeometry.clearCenterY) > 1 ||
      Math.abs(playerControlGeometry.inputCenterY - playerControlGeometry.chevronCenterY) > 1 ||
      playerControlGeometry.clearRight >= playerControlGeometry.chevronLeft
    ) {
      throw new Error(
        `Clear must sit left of a vertically centered arrow: ${JSON.stringify(playerControlGeometry)}`,
      );
    }
    const playerControlsScreenshotPath = screenshotPath.replace(/\.png$/i, "-player-controls.png");
    await page.screenshot({ path: playerControlsScreenshotPath, fullPage: true });

    await page.getByRole("button", { name: "Open developer menu" }).click();
    if ((await page.getByRole("button", { name: /Day\/night table indication/i }).count()) !== 0) {
      throw new Error("The static Day/night tint must not expose a Dev setting");
    }
    if ((await page.getByRole("button", { name: "Reload music player" }).count()) !== 0) {
      throw new Error("Reload music player must stay inside the music setup submenu");
    }
    await page.getByRole("button", { name: "Close developer menu" }).click();
    await page.getByRole("button", { name: "Open Manage menu" }).click();
    await page.getByRole("button", { name: "Music player setup" }).click();
    const musicSetup = page.getByRole("region", { name: "Music player setup" });
    await musicSetup.waitFor();
    await musicSetup.getByRole("button", { name: "Reload music player" }).waitFor();
    await musicSetup.getByRole("combobox", { name: "YouTube Music playlist" }).waitFor();
    if (
      (await musicSetup.getByLabel("Low").count()) !== 0 ||
      (await musicSetup.getByLabel("High").count()) !== 0 ||
      (await musicSetup.getByRole("combobox").count()) !== 1
    ) {
      throw new Error("Dev music setup must expose one playlist and no app volume presets");
    }
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await page.getByRole("button", { name: "Close Manage menu" }).click();
    await startGame.click();
    for (let roleIndex = 0; roleIndex < 10; roleIndex += 1) {
      await page
        .getByRole("button", { name: /^Draw role for / })
        .first()
        .click();
    }
    await page.getByRole("button", { name: "Begin Mafia planning stage" }).click();
    await page.locator(".game-shell.is-table-cycle-night").waitFor();
    await page.waitForTimeout(620);
    const centerShadowStyle = await page.locator(".table-center").evaluate((center) => {
      const shadow = getComputedStyle(center, "::before");
      return { display: shadow.display, backgroundImage: shadow.backgroundImage };
    });
    if (
      centerShadowStyle.display === "none" ||
      !centerShadowStyle.backgroundImage.includes("radial-gradient")
    ) {
      throw new Error(
        `The permanent table-center shadow is missing: ${JSON.stringify(centerShadowStyle)}`,
      );
    }
    const nightCycleStyle = await page.locator(".round-table").evaluate((table) => {
      const ambient = getComputedStyle(table, "::before");
      const mark = getComputedStyle(table, "::after");
      return {
        content: mark.content,
        ambientAnimation: ambient.animationName,
        markAnimation: mark.animationName,
        ambientBackground: ambient.backgroundImage,
        transitionDuration: getComputedStyle(table).transitionDuration,
      };
    });
    if (
      nightCycleStyle.content.includes("NIGHT") ||
      nightCycleStyle.ambientAnimation !== "none" ||
      nightCycleStyle.markAnimation !== "none" ||
      !nightCycleStyle.ambientBackground.includes("gradient") ||
      !nightCycleStyle.transitionDuration.includes("0.9s")
    ) {
      throw new Error(
        `Night tint must be static and retain its gradient: ${JSON.stringify(nightCycleStyle)}`,
      );
    }
    const nightCycleScreenshotPath = tableScreenshotPath.replace(/\.png$/i, "-night-cycle.png");
    await page.screenshot({ path: nightCycleScreenshotPath, fullPage: true });
    await page.getByRole("button", { name: "Continue to Sheriff wake-up" }).click();
    await page.getByRole("button", { name: "Begin day one" }).click();
    await page.locator(".game-shell.is-table-cycle-day").waitFor();
    await page.waitForTimeout(620);
    const dayCycleStyle = await page.locator(".round-table").evaluate((table) => {
      const ambient = getComputedStyle(table, "::before");
      const mark = getComputedStyle(table, "::after");
      return {
        content: mark.content,
        ambientAnimation: ambient.animationName,
        markAnimation: mark.animationName,
        ambientBackground: ambient.backgroundImage,
      };
    });
    if (
      dayCycleStyle.content.includes("DAY") ||
      dayCycleStyle.ambientAnimation !== "none" ||
      dayCycleStyle.markAnimation !== "none" ||
      !dayCycleStyle.ambientBackground.includes("gradient")
    ) {
      throw new Error(
        `Day tint must be static and retain its gradient: ${JSON.stringify(dayCycleStyle)}`,
      );
    }
    const dayCycleScreenshotPath = tableScreenshotPath.replace(/\.png$/i, "-day-cycle.png");
    await page.screenshot({ path: dayCycleScreenshotPath, fullPage: true });

    const sidePanelGeometry = await page.evaluate(() => {
      const box = (selector) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
        const bounds = element.getBoundingClientRect();
        return {
          left: bounds.left,
          right: bounds.right,
          top: bounds.top,
          bottom: bounds.bottom,
          width: bounds.width,
          height: bounds.height,
        };
      };
      const style = (selector) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
        const computed = getComputedStyle(element);
        return {
          borderTopLeftRadius: Number.parseFloat(computed.borderTopLeftRadius),
          borderTopRightRadius: Number.parseFloat(computed.borderTopRightRadius),
          borderLeftWidth: Number.parseFloat(computed.borderLeftWidth),
          borderRightWidth: Number.parseFloat(computed.borderRightWidth),
          borderTopWidth: Number.parseFloat(computed.borderTopWidth),
          borderBottomWidth: Number.parseFloat(computed.borderBottomWidth),
        };
      };
      const rail = document.querySelector(".live-side-panel.has-live-utilities");
      if (!(rail instanceof HTMLElement)) throw new Error("Missing unified live side panel");
      return {
        main: box(".table-workspace"),
        rail: box(".live-side-panel.has-live-utilities"),
        upperGrip: box(".utility-panels-toggle"),
        timerSection: box('.utility-panel-section[data-panel="timer"]'),
        votingSection: box('.utility-panel-section[data-panel="voting"]'),
        timer: box(".timer-panel"),
        voting: box(".nomination-panel"),
        music: box(".live-side-panel .youtube-dock"),
        railStyle: style(".live-side-panel.has-live-utilities"),
        upperGripStyle: style(".utility-panels-toggle"),
        votingStyle: style('.utility-panel-section[data-panel="voting"]'),
        musicStyle: style(".live-side-panel .youtube-dock"),
        handles: [...rail.querySelectorAll(".panel-swipe-handle")].map((element) => {
          const bounds = element.getBoundingClientRect();
          return { width: bounds.width, height: bounds.height };
        }),
        viewportWidth: innerWidth,
        documentHeight: document.documentElement.scrollHeight,
        viewportHeight: innerHeight,
      };
    });
    const near = (actual, expected, tolerance = 1) => Math.abs(actual - expected) <= tolerance;
    if (
      !near(sidePanelGeometry.main.left, 14) ||
      !near(sidePanelGeometry.main.width, 918) ||
      !near(sidePanelGeometry.rail.left - sidePanelGeometry.main.right, 14) ||
      !near(sidePanelGeometry.rail.width, 406) ||
      !near(sidePanelGeometry.viewportWidth - sidePanelGeometry.rail.right, 14)
    ) {
      throw new Error(
        `Unified side-panel geometry violates the 14/918/14/406/14 contract: ${JSON.stringify(
          sidePanelGeometry,
        )}`,
      );
    }
    if (
      !near(sidePanelGeometry.timer.left - sidePanelGeometry.rail.left, 8) ||
      !near(sidePanelGeometry.rail.right - sidePanelGeometry.timer.right, 8) ||
      !near(sidePanelGeometry.voting.left - sidePanelGeometry.rail.left, 8) ||
      !near(sidePanelGeometry.rail.right - sidePanelGeometry.voting.right, 8) ||
      !near(sidePanelGeometry.music.width, sidePanelGeometry.rail.width)
    ) {
      throw new Error(
        `Integrated pane widths violate the utility-inset/music-flush contract: ${JSON.stringify(
          sidePanelGeometry,
        )}`,
      );
    }
    if (
      !near(sidePanelGeometry.upperGrip.left, sidePanelGeometry.rail.left) ||
      !near(sidePanelGeometry.upperGrip.right, sidePanelGeometry.rail.right) ||
      !near(sidePanelGeometry.upperGrip.top, sidePanelGeometry.rail.top) ||
      !near(sidePanelGeometry.music.left, sidePanelGeometry.rail.left) ||
      !near(sidePanelGeometry.music.right, sidePanelGeometry.rail.right) ||
      !near(sidePanelGeometry.music.bottom, sidePanelGeometry.rail.bottom)
    ) {
      throw new Error(
        `Top grip and music must meet the pane edges: ${JSON.stringify(sidePanelGeometry)}`,
      );
    }
    if (
      !near(
        sidePanelGeometry.upperGripStyle.borderTopLeftRadius,
        sidePanelGeometry.railStyle.borderTopLeftRadius,
      ) ||
      !near(
        sidePanelGeometry.upperGripStyle.borderTopRightRadius,
        sidePanelGeometry.railStyle.borderTopRightRadius,
      ) ||
      sidePanelGeometry.musicStyle.borderLeftWidth !== 0 ||
      sidePanelGeometry.musicStyle.borderRightWidth !== 0 ||
      sidePanelGeometry.musicStyle.borderBottomWidth !== 0
    ) {
      throw new Error(
        `Pane edge radii and music chrome are not integrated: ${JSON.stringify(sidePanelGeometry)}`,
      );
    }
    if (
      sidePanelGeometry.votingStyle.borderTopWidth !== 0 ||
      sidePanelGeometry.votingSection.top - sidePanelGeometry.timerSection.bottom < 28
    ) {
      throw new Error(
        `Voting must be borderless and separated from the timer by 28px: ${JSON.stringify(
          sidePanelGeometry,
        )}`,
      );
    }
    if (
      sidePanelGeometry.handles.length !== 2 ||
      sidePanelGeometry.handles.some(({ width, height }) => width < 44 || height < 44)
    ) {
      throw new Error(
        `Panel swipe handles are not touch-sized: ${JSON.stringify(sidePanelGeometry)}`,
      );
    }
    if (sidePanelGeometry.documentHeight > sidePanelGeometry.viewportHeight + 1) {
      throw new Error(
        `Music is not pinned inside a non-scrolling rail: ${JSON.stringify(sidePanelGeometry)}`,
      );
    }

    await page.getByRole("button", { name: "Hide timer and voting" }).click();
    await page.locator("#game-utility-panels[hidden]").waitFor({ state: "attached" });
    await page.getByRole("button", { name: "Show timer and voting" }).click();
    await page.getByRole("region", { name: "Timer controls" }).waitFor();
    await page.getByRole("region", { name: "Voting order" }).waitFor();

    const musicHandle = page.getByRole("button", { name: "Music player panel handle" });
    const playerNodeId = await page.locator(".youtube-player-video").evaluate((player) => {
      player.dataset.verifierNode = crypto.randomUUID();
      return player.dataset.verifierNode;
    });
    await page.screenshot({ path: sidePanelScreenshotPath, fullPage: true });
    await musicHandle.dispatchEvent("touchstart", {
      touches: [{ identifier: 4, clientX: 100, clientY: 100 }],
    });
    await musicHandle.dispatchEvent("touchend", {
      changedTouches: [{ identifier: 4, clientX: 102, clientY: 35 }],
    });
    await page.locator(".youtube-dock.is-expanded").waitFor();
    await musicHandle.dispatchEvent("touchstart", {
      touches: [{ identifier: 5, clientX: 100, clientY: 35 }],
    });
    await musicHandle.dispatchEvent("touchend", {
      changedTouches: [{ identifier: 5, clientX: 102, clientY: 100 }],
    });
    await page.locator(".youtube-dock:not(.is-expanded)").waitFor();
    const playerNodeAfterGestures = await page
      .locator(".youtube-player-video")
      .getAttribute("data-verifier-node");
    if (playerNodeAfterGestures !== playerNodeId) {
      throw new Error("Panel gestures remounted the persistent music player");
    }

    await page.getByRole("button", { name: "Open developer menu" }).click();
    await page.getByRole("button", { name: "Use Málaga gold theme" }).click();
    await page.getByRole("button", { name: "Use Málaga Glass theme" }).click();
    const expectedGlassMode = browserName === "webkit" ? "fallback" : "refractive";
    await page.waitForFunction((expectedMode) => {
      const rail = document.querySelector(".live-side-panel.has-live-utilities");
      const surface = rail?.querySelector(".live-side-panel-glass");
      if (!(rail instanceof HTMLElement) || !(surface instanceof HTMLElement)) return false;
      if (!surface.classList.contains(`is-glass-${expectedMode}`)) return false;

      const style = getComputedStyle(surface);
      const computedFilter = style.backdropFilter || style.webkitBackdropFilter || "";
      const filterReference = computedFilter.match(/url\((?:["']?)([^"')]+)(?:["']?)\)/)?.[1];
      const encodedFilterId = filterReference?.slice(filterReference.lastIndexOf("#") + 1);
      const filterId = encodedFilterId ? decodeURIComponent(encodedFilterId) : null;
      const matchingFilter = filterId === null ? null : document.getElementById(filterId);

      return expectedMode === "refractive"
        ? matchingFilter?.namespaceURI === "http://www.w3.org/2000/svg" &&
            matchingFilter.localName === "filter" &&
            rail.contains(matchingFilter)
        : filterId === null && computedFilter.includes("blur");
    }, expectedGlassMode);
    const glassEvidence = await page.evaluate(() => {
      const rail = document.querySelector(".live-side-panel.has-live-utilities");
      const surface = rail?.querySelector(".live-side-panel-glass");
      if (!(surface instanceof HTMLElement)) throw new Error("Live rail glass surface is missing");
      const style = getComputedStyle(surface);
      const computedFilter = style.backdropFilter || style.webkitBackdropFilter || "";
      const filterReference = computedFilter.match(/url\((?:["']?)([^"')]+)(?:["']?)\)/)?.[1];
      const encodedFilterId = filterReference?.slice(filterReference.lastIndexOf("#") + 1);
      const filterId = encodedFilterId ? decodeURIComponent(encodedFilterId) : null;
      const matchingFilter = filterId === null ? null : document.getElementById(filterId);
      const filterBelongsToRail =
        rail instanceof HTMLElement &&
        matchingFilter?.namespaceURI === "http://www.w3.org/2000/svg" &&
        matchingFilter.localName === "filter" &&
        rail.contains(matchingFilter);
      const railBounds = rail?.getBoundingClientRect();
      const visible = (selector) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) return false;
        const bounds = element.getBoundingClientRect();
        return (
          bounds.width > 0 && bounds.height > 0 && getComputedStyle(element).display !== "none"
        );
      };
      return {
        theme: document.documentElement.dataset.theme,
        mode: surface.className,
        computedFilter,
        filterId,
        matchingFilterId: filterBelongsToRail ? matchingFilter.id : null,
        playerNode: document
          .querySelector(".youtube-player-video")
          ?.getAttribute("data-verifier-node"),
        rail: railBounds
          ? {
              left: railBounds.left,
              top: railBounds.top,
              width: railBounds.width,
              height: railBounds.height,
            }
          : null,
        timerVisible: visible(".timer-panel"),
        votingVisible: visible(".nomination-panel"),
        musicVisible: visible(".youtube-dock"),
      };
    });
    if (
      glassEvidence.theme !== "malaga-glass" ||
      !glassEvidence.mode.includes(`is-glass-${expectedGlassMode}`) ||
      glassEvidence.playerNode !== playerNodeId ||
      glassEvidence.rail === null ||
      !near(glassEvidence.rail.left, sidePanelGeometry.rail.left) ||
      !near(glassEvidence.rail.top, sidePanelGeometry.rail.top) ||
      !near(glassEvidence.rail.width, sidePanelGeometry.rail.width) ||
      !near(glassEvidence.rail.height, sidePanelGeometry.rail.height) ||
      !glassEvidence.timerVisible ||
      !glassEvidence.votingVisible ||
      !glassEvidence.musicVisible ||
      (browserName === "webkit"
        ? glassEvidence.filterId !== null || !glassEvidence.computedFilter.includes("blur")
        : glassEvidence.filterId === null ||
          glassEvidence.matchingFilterId !== glassEvidence.filterId)
    ) {
      throw new Error(`Málaga Glass mode is invalid: ${JSON.stringify(glassEvidence)}`);
    }
    await page.getByRole("button", { name: "Close developer menu" }).click();
    await page.screenshot({ path: glassScreenshotPath, fullPage: true });
    await page.getByRole("button", { name: "Open developer menu" }).click();
    await page.getByRole("button", { name: "Use Midnight theme" }).click();
    await page.getByRole("button", { name: "Close developer menu" }).click();

    const durableBeforePreview = await page.evaluate(() =>
      sessionStorage.getItem("mafia-dashboard.game-session.v4"),
    );
    const persistedCheckpoint = JSON.parse(durableBeforePreview ?? "null");
    const persistedEvents = Array.isArray(persistedCheckpoint?.entries)
      ? persistedCheckpoint.entries
      : [];
    const intermediateEvents = persistedEvents.filter(
      (event) =>
        event?.type === "turn.completed" ||
        (event?.type === "phase.changed" &&
          ["sheriff-wake", "night-don", "night-sheriff", "best-move"].includes(event?.payload?.to)),
    );
    if (persistedEvents.length !== 2 || intermediateEvents.length !== 0) {
      throw new Error(
        `Initial Night and Day must persist only root + Day checkpoints: ${JSON.stringify(
          persistedEvents.map(({ type, payload }) => ({ type, payload })),
        )}`,
      );
    }
    const rootCheckpoint = persistedEvents[0];
    const dayCheckpoint = persistedEvents[1];
    if (
      rootCheckpoint?.phaseAfter !== "mafia-planning" ||
      rootCheckpoint.dayAfter !== 0 ||
      dayCheckpoint?.phaseAfter !== "day" ||
      dayCheckpoint.dayAfter !== 1
    ) {
      throw new Error(
        "Preview verifier fixtures do not describe the canonical root and Day 1 states",
      );
    }
    await page.getByRole("button", { name: "Open game log" }).click();
    await page.getByRole("button", { name: "Preview state after log #1" }).click();
    await page.getByRole("heading", { name: /preview/i }).waitFor();
    await page.getByRole("heading", { name: "Mafia planning stage" }).waitFor();
    const previewActions = await page
      .locator("main button:not([disabled]):visible")
      .allTextContents();
    if (
      JSON.stringify(previewActions.map((text) => text.trim())) !==
      JSON.stringify(["Exit preview", "Reset game to this state"])
    ) {
      throw new Error(
        `Preview game surface must expose exactly Exit and Reset: ${JSON.stringify(previewActions)}`,
      );
    }
    await page.getByRole("region", { name: "Timer controls" }).waitFor();
    await page.getByRole("region", { name: "Voting order" }).waitFor();
    if ((await page.getByLabel("Application tools").count()) !== 0) {
      throw new Error("Application toolbar must be unavailable during history preview");
    }
    await page.screenshot({ path: previewScreenshotPath, fullPage: true });
    await page.getByRole("button", { name: "Exit preview" }).click();
    await page.getByRole("heading", { name: "Day 1" }).waitFor();
    const durableAfterPreview = await page.evaluate(() =>
      sessionStorage.getItem("mafia-dashboard.game-session.v4"),
    );
    if (durableAfterPreview !== durableBeforePreview) {
      throw new Error("Read-only preview changed the durable game head, revision, or outbox");
    }

    await page.getByRole("button", { name: "Open developer menu" }).click();
    await page.getByRole("button", { name: "Enable dev mode" }).click();
    await page.getByRole("button", { name: "Past game timeline" }).click();
    await page.getByRole("heading", { name: "Game timeline" }).waitFor();
    await page.getByText(/Checkpoint #2$/).waitFor();
    if ((await page.locator(".timeline-marker").count()) !== 2) {
      throw new Error("The current Timeline must contain exactly root and Day checkpoints");
    }
    await page.getByRole("button", { name: "Phase: day" }).click();
    await page.getByRole("button", { name: "Preview timeline checkpoint" }).click();
    await page.getByRole("heading", { name: /preview/i }).waitFor();
    await page.getByRole("heading", { name: "Day 1" }).waitFor();
    await page.getByRole("button", { name: "Exit preview" }).click();
    await page.getByRole("heading", { name: "Day 1" }).waitFor();

    await page.getByRole("button", { name: "Open developer menu" }).click();
    await page.getByRole("button", { name: "Past game timeline" }).click();
    await page.getByRole("heading", { name: "Game timeline" }).waitFor();
    await page.getByRole("button", { name: "Imported game checkpoint" }).click();
    const resetTarget = rootCheckpoint;
    if (resetTarget === undefined || persistedCheckpoint.headEventId === null) {
      throw new Error("Reset verifier fixture has no canonical target or active head");
    }
    headOperationExpectations.expect({
      baseRevision: persistedCheckpoint.revision,
      targetEventId: resetTarget.id,
      reason: "reset",
    });
    const resetSave = page.waitForResponse((response) => {
      if (
        response.request().method() !== "POST" ||
        !new URL(response.url()).pathname.endsWith("/head")
      ) {
        return false;
      }
      return response.request().postDataJSON()?.reason === "reset";
    });
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Reset game to timeline checkpoint" }).click();
    await page.getByRole("heading", { name: "Mafia planning stage" }).waitFor();
    if (!(await resetSave).ok()) throw new Error("Reset verifier operation failed");
    headOperationExpectations.expect({
      baseRevision: persistedCheckpoint.revision + 1,
      targetEventId: persistedCheckpoint.headEventId,
      reason: "restore-reset",
    });
    const restoreSave = page.waitForResponse((response) => {
      if (
        response.request().method() !== "POST" ||
        !new URL(response.url()).pathname.endsWith("/head")
      ) {
        return false;
      }
      return response.request().postDataJSON()?.reason === "restore-reset";
    });
    await page.getByRole("button", { name: /undo last action/i }).click();
    await page.getByRole("heading", { name: "Day 1" }).waitFor();
    if (!(await restoreSave).ok()) throw new Error("Reset recovery verifier operation failed");
    headOperationExpectations.assertDrained();

    await page.getByRole("button", { name: "Open developer menu" }).click();
    await page.getByRole("button", { name: "Past game timeline" }).click();
    await page.getByRole("heading", { name: "Game timeline" }).waitFor();
    await page.getByRole("button", { name: "Generate sample game data" }).click();
    if (
      (await page.getByRole("button", { name: /show private info|hide private info/i }).count()) !==
        0 ||
      (await page.getByText(/Scroll timeline/i).count()) !== 0 ||
      (await page.getByText("Visibility", { exact: true }).count()) !== 0 ||
      (await page.getByRole("button", { name: "Private event" }).count()) !== 0
    ) {
      throw new Error("Timeline still exposes retired private-view, Scroll, or Visibility chrome");
    }
    if ((await page.getByRole("button", { name: /Don checked/i }).count()) === 0) {
      throw new Error(
        "Timeline must show real host-secret check labels without private-view redaction",
      );
    }
    for (const label of [
      "Initial night",
      "Day 1",
      "Voting 1",
      "Night 1",
      "Day 2",
      "Voting 2",
      "Night 2",
    ]) {
      await page.getByText(label, { exact: true }).waitFor();
    }
    const timelineGeometry = await page.evaluate(() => ({
      documentScroll: document.scrollingElement?.scrollHeight ?? 0,
      viewportHeight: innerHeight,
      markerCount: document.querySelectorAll(".timeline-marker").length,
      regionCount: document.querySelectorAll(".timeline-region").length,
    }));
    if (
      timelineGeometry.documentScroll > timelineGeometry.viewportHeight + 1 ||
      timelineGeometry.markerCount !== 22 ||
      timelineGeometry.regionCount !== 7
    ) {
      throw new Error(
        `Timeline geometry/contents are invalid: ${JSON.stringify(timelineGeometry)}`,
      );
    }
    await page.screenshot({ path: timelineScreenshotPath, fullPage: true });
    await page.locator(".timeline-track-scroll").evaluate((track) => {
      track.scrollLeft = track.scrollWidth;
    });
    await page.screenshot({ path: timelineRightScreenshotPath, fullPage: true });
    await page.getByRole("button", { name: /back/i }).click();
    await page.getByRole("heading", { name: "Day 1" }).waitFor();

    for (const seconds of [60, 30, 10]) {
      await page.getByRole("button", { name: `Start ${seconds} second timer` }).click();
      await page.getByRole("button", { name: "Stop timer" }).click();
    }
    const timerAudioStarts = await page.evaluate(() => window.__mafiaAudioStarts);
    if (
      timerAudioStarts.length !== 3 ||
      timerAudioStarts.some((delay, index) => Math.abs(delay - [50, 20, 0][index]) > 0.001)
    ) {
      throw new Error(`Timer warning chimes were not scheduled at 10 seconds: ${timerAudioStarts}`);
    }

    if ((await page.getByRole("button", { name: /^Red card / }).count()) !== 0) {
      throw new Error("Day player cards must not expose a direct red-card button");
    }
    if ((await page.locator(".table-center button").count()) !== 0) {
      throw new Error("Day table center must not contain a Start player turn button");
    }
    const actionGeometry = await page
      .locator(".seat-anchor")
      .first()
      .evaluate((anchor) => {
        const card = anchor.querySelector(".player-seat")?.getBoundingClientRect();
        const actions = anchor.querySelector(".seat-actions")?.getBoundingClientRect();
        const buttons = [...anchor.querySelectorAll(".seat-actions button")].map((button) =>
          button.getBoundingClientRect(),
        );
        return {
          cardWidth: card?.width ?? 0,
          actionsWidth: actions?.width ?? 0,
          buttonWidths: buttons.map(({ width }) => width),
        };
      });
    if (
      actionGeometry.buttonWidths.length !== 2 ||
      Math.abs(actionGeometry.actionsWidth - actionGeometry.cardWidth) > 1 ||
      actionGeometry.buttonWidths.some(
        (width) => Math.abs(width - actionGeometry.actionsWidth / 2) > 1,
      )
    ) {
      throw new Error(
        `Foul and Vote must split the full action bar: ${JSON.stringify(actionGeometry)}`,
      );
    }

    const firstPlayerCard = page.locator(".player-seat.is-current");
    const firstPlayerLabel = await firstPlayerCard.getAttribute("aria-label");
    const firstPlayerMatch = firstPlayerLabel?.match(/^Seat (\d+): (.+)$/);
    if (firstPlayerMatch === undefined || firstPlayerMatch === null) {
      throw new Error(`Could not identify the first speaker: ${firstPlayerLabel ?? "missing"}`);
    }
    const firstPlayerName = firstPlayerMatch[2];
    await firstPlayerCard.dispatchEvent("touchstart", {
      touches: [{ identifier: 1, clientX: 20, clientY: 50 }],
    });
    await firstPlayerCard.dispatchEvent("touchend", {
      changedTouches: [{ identifier: 1, clientX: 82, clientY: 52 }],
    });
    await page.getByRole("button", { name: `Red card ${firstPlayerName}`, exact: true }).waitFor();
    const swipeMenuGeometry = await page.locator(".table-swipe-menu").evaluate((menu) => {
      const style = getComputedStyle(menu);
      const close = menu.querySelector(".table-swipe-close");
      const redCard = menu.querySelector(".table-swipe-red-card");
      if (!(close instanceof HTMLElement) || !(redCard instanceof HTMLElement)) {
        throw new Error("Expected red-card and close controls in the swipe menu");
      }
      const closeStyle = getComputedStyle(close);
      const redCardStyle = getComputedStyle(redCard);
      return {
        borderRadius: style.borderRadius,
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
        closeBackground: closeStyle.backgroundColor,
        closeBorderWidth: closeStyle.borderTopWidth,
        closeFontSize: closeStyle.fontSize,
        redCardBorderRadius: redCardStyle.borderRadius,
      };
    });
    if (
      swipeMenuGeometry.borderRadius !== "18px" ||
      swipeMenuGeometry.paddingLeft !== swipeMenuGeometry.paddingRight ||
      swipeMenuGeometry.closeBackground !== "rgba(0, 0, 0, 0)" ||
      swipeMenuGeometry.closeBorderWidth !== "0px" ||
      swipeMenuGeometry.closeFontSize !== "32px" ||
      swipeMenuGeometry.redCardBorderRadius !== "10px"
    ) {
      throw new Error(
        `Swipe menu must be symmetric and use a bare 2× close icon: ${JSON.stringify(swipeMenuGeometry)}`,
      );
    }
    const swipeMenuScreenshotPath = tableScreenshotPath.replace(/\.png$/i, "-swipe-menu.png");
    await page.screenshot({ path: swipeMenuScreenshotPath, fullPage: true });
    await page
      .getByRole("button", { name: `Close actions for ${firstPlayerName}`, exact: true })
      .click();

    const nominatorCard = page.locator(".player-seat.is-current");
    const nominatorLabel = await nominatorCard.getAttribute("aria-label");
    const nominatorMatch = nominatorLabel?.match(/^Seat (\d+): (.+)$/);
    if (nominatorMatch === undefined || nominatorMatch === null) {
      throw new Error(`Could not identify the next speaker: ${nominatorLabel ?? "missing"}`);
    }
    const nominatorSeat = Number(nominatorMatch[1]);
    const nominatorName = nominatorMatch[2];
    await page.getByRole("button", { name: `Foul ${nominatorName}`, exact: true }).click();
    await page.getByRole("button", { name: `Nominate ${nominatorName}`, exact: true }).click();
    await page
      .getByText(`Initiated by #${nominatorSeat} ${nominatorName}`, { exact: true })
      .waitFor();
    const statusLayout = await nominatorCard.evaluate((card) => {
      const name = card.querySelector(".seat-name");
      const badges = card.querySelector(".seat-badges");
      if (!(name instanceof HTMLElement) || !(badges instanceof HTMLElement)) {
        throw new Error("Expected separate nickname and status-pill containers");
      }
      const cardBox = card.getBoundingClientRect();
      const nameBox = name.getBoundingClientRect();
      const badgeBoxes = [...badges.children].map((badge) => badge.getBoundingClientRect());
      return {
        nickname: name.textContent,
        nameHeight: nameBox.height,
        nameInsideCard: nameBox.top >= cardBox.top && nameBox.bottom <= cardBox.bottom,
        badgeCount: badgeBoxes.length,
        badgeRows: new Set(badgeBoxes.map(({ top }) => Math.round(top))).size,
        flexWrap: getComputedStyle(badges).flexWrap,
      };
    });
    if (
      statusLayout.nickname !== nominatorName ||
      statusLayout.nameHeight <= 0 ||
      !statusLayout.nameInsideCard ||
      statusLayout.badgeCount !== 3 ||
      statusLayout.badgeRows >= statusLayout.badgeCount ||
      statusLayout.flexWrap !== "wrap"
    ) {
      throw new Error(
        `Nickname must remain visible while three status pills wrap: ${JSON.stringify(statusLayout)}`,
      );
    }
    await page.screenshot({ path: tableScreenshotPath, fullPage: true });

    const nextPlayer = page.getByRole("button", { name: "Next player" });
    await nextPlayer.click();
    const secondNominatorCard = page.locator(".player-seat.is-current");
    const secondNominatorLabel = await secondNominatorCard.getAttribute("aria-label");
    const secondNominatorMatch = secondNominatorLabel?.match(/^Seat (\d+): (.+)$/);
    if (secondNominatorMatch === undefined || secondNominatorMatch === null) {
      throw new Error(
        `Could not identify the second speaker: ${secondNominatorLabel ?? "missing"}`,
      );
    }
    await page
      .getByRole("button", { name: `Nominate ${secondNominatorMatch[2]}`, exact: true })
      .click();
    while ((await nextPlayer.count()) > 0) await nextPlayer.click();
    await page.getByRole("button", { name: "Begin voting" }).click();
    const votingCandidate = page.getByRole("group", { name: "Voting candidate" });
    await votingCandidate.waitFor();
    const votingText = await votingCandidate.innerText();
    if (!votingText.includes(`#${nominatorSeat} ${nominatorName}`)) {
      throw new Error(`Voting candidate must include seat and name: ${votingText}`);
    }
    if ((await page.getByRole("button", { name: /^Foul / }).count()) !== 10) {
      throw new Error("Voting must show a Foul button above every active player card");
    }
    const toggleVoterIndex = await page
      .locator(".player-seat")
      .evaluateAll((cards) => cards.findIndex((card) => !card.classList.contains("is-inactive")));
    if (toggleVoterIndex < 0) throw new Error("Expected an unassigned voter card");
    const toggleVoter = page.locator(".player-seat").nth(toggleVoterIndex);
    await toggleVoter.click();
    const selectedAfterFirstTap = await toggleVoter.evaluate((card) =>
      card.classList.contains("is-voting-highlight"),
    );
    await toggleVoter.click();
    const voteToggleState = {
      selectedAfterFirstTap,
      selectedAfterSecondTap: await toggleVoter.evaluate((card) =>
        card.classList.contains("is-voting-highlight"),
      ),
      labelAfterSecondTap: await toggleVoter.getAttribute("aria-label"),
      candidateTextAfterSecondTap: await votingCandidate.innerText(),
    };
    if (
      !voteToggleState.selectedAfterFirstTap ||
      voteToggleState.selectedAfterSecondTap ||
      !voteToggleState.labelAfterSecondTap?.startsWith("Vote as ") ||
      !voteToggleState.candidateTextAfterSecondTap.includes("0 votes")
    ) {
      throw new Error(
        `Tapping a voting card twice must remove its vote: ${JSON.stringify(voteToggleState)}`,
      );
    }
    await toggleVoter.click();
    await page.locator(".player-seat:not(.is-inactive)").first().click();
    const votingHighlight = page.locator(".player-seat.is-voting-highlight");
    if ((await votingHighlight.count()) !== 2) {
      throw new Error("Every voter for the current candidate must remain highlighted");
    }
    await page.waitForTimeout(320);
    const votingHighlightStyle = await votingHighlight.first().evaluate((card) => {
      const style = getComputedStyle(card);
      return {
        animationName: style.animationName,
        backgroundImage: style.backgroundImage,
        borderColor: style.borderColor,
        opacity: style.opacity,
      };
    });
    if (
      !votingHighlightStyle.animationName.includes("voting-highlight-enter") ||
      !votingHighlightStyle.animationName.includes("voting-fire-pulse") ||
      !votingHighlightStyle.backgroundImage.includes("gradient") ||
      votingHighlightStyle.opacity !== "1"
    ) {
      throw new Error(
        `Selected voting card must use the bright fire treatment: ${JSON.stringify(votingHighlightStyle)}`,
      );
    }
    const votingScreenshotPath = tableScreenshotPath.replace(/\.png$/i, "-voting.png");
    await page.screenshot({ path: votingScreenshotPath, fullPage: true });
    await page.getByRole("button", { name: "Next candidate" }).click();
    const autoVotingHighlight = page.locator(".player-seat.is-voting-highlight");
    if ((await autoVotingHighlight.count()) !== 8) {
      throw new Error("Every auto-assigned voter for the final candidate must be highlighted");
    }
    const autoVotingScreenshotPath = tableScreenshotPath.replace(/\.png$/i, "-voting-auto.png");
    await page.screenshot({ path: autoVotingScreenshotPath, fullPage: true });
    const redCardTarget = autoVotingHighlight.first();
    const redCardTargetName = await redCardTarget.locator(".seat-name").innerText();
    await redCardTarget.dispatchEvent("touchstart", {
      touches: [{ identifier: 2, clientX: 20, clientY: 50 }],
    });
    await redCardTarget.dispatchEvent("touchend", {
      changedTouches: [{ identifier: 2, clientX: 82, clientY: 52 }],
    });
    await page.getByRole("button", { name: `Red card ${redCardTargetName}`, exact: true }).click();
    const cancellation = page.getByRole("status", { name: "Voting cancelled" });
    await cancellation.waitFor();
    if (
      !(await cancellation.innerText()).includes(
        "A player received a red card, so voting is cancelled for this day.",
      )
    ) {
      throw new Error("The cancelled voting screen must explain the red-card reason");
    }
    const cancellationScreenshotPath = tableScreenshotPath.replace(
      /\.png$/i,
      "-voting-cancelled.png",
    );
    await page.screenshot({ path: cancellationScreenshotPath, fullPage: true });
    await page.getByRole("button", { name: "Begin night" }).click();
    await page.getByRole("heading", { name: "Mafia shots" }).waitFor();
    const shotLogCount = page.locator(".log-toolbar-button .toolbar-count");
    const logCountBeforeShots = Number(await shotLogCount.innerText());
    const firstShot = page.getByRole("button", { name: /^Assign shooter \d+ to target / }).first();
    await firstShot.click();
    const selectedShot = page.locator(".shooter-button.is-selected");
    if ((await selectedShot.count()) !== 1 || !(await selectedShot.isEnabled())) {
      throw new Error("A selected Mafia shot must stay enabled so it can be toggled off");
    }
    const shotToggleScreenshotPath = tableScreenshotPath.replace(
      /\.png$/i,
      "-mafia-shot-toggle.png",
    );
    await page.screenshot({ path: shotToggleScreenshotPath, fullPage: true });
    await selectedShot.click();
    if (
      (await page.locator(".shooter-button.is-selected").count()) !== 0 ||
      Number(await shotLogCount.innerText()) !== logCountBeforeShots
    ) {
      throw new Error("Toggling Mafia shots must not write to the game log");
    }
    const shooterCount = await page
      .locator(".seat-anchor")
      .first()
      .locator(".shooter-button")
      .count();
    const targetCard = page.locator("button.player-seat.status-active:has(.role-citizen)").first();
    await targetCard.click();
    if ((await page.locator(".shooter-button.is-selected").count()) !== shooterCount) {
      throw new Error("Clicking a player card must assign every active Mafia shot");
    }
    await targetCard.click();
    if ((await page.locator(".shooter-button.is-selected").count()) !== 0) {
      throw new Error("Clicking the selected player card again must clear every Mafia shot");
    }
    await targetCard.click();
    if (Number(await shotLogCount.innerText()) !== logCountBeforeShots) {
      throw new Error("Assigning Mafia shots must not write to the game log");
    }
    const durableBeforeNightTimeline = await page.evaluate(() =>
      sessionStorage.getItem("mafia-dashboard.game-session.v4"),
    );
    await page.getByRole("button", { name: "Open developer menu" }).click();
    await page.getByRole("button", { name: "Past game timeline" }).click();
    await page.getByRole("heading", { name: "Game timeline" }).waitFor();
    await page.locator(".timeline-marker").first().click();
    await page.getByRole("button", { name: "Back" }).click();
    await page.getByRole("heading", { name: "Mafia shots" }).waitFor();
    const evaluateShots = page.getByRole("button", { name: "Evaluate Mafia shots" });
    const assignmentSummary = await page.locator(".table-night-center strong").innerText();
    const selectedAfterTimeline = await page.locator(".shooter-button.is-selected").count();
    const evaluateDisabled = await evaluateShots.isDisabled();
    const durableAfterNightTimeline = await page.evaluate(() =>
      sessionStorage.getItem("mafia-dashboard.game-session.v4"),
    );
    if (
      selectedAfterTimeline !== shooterCount ||
      assignmentSummary !== `${shooterCount} of ${shooterCount} shooters assigned` ||
      evaluateDisabled ||
      durableAfterNightTimeline !== durableBeforeNightTimeline
    ) {
      throw new Error(
        `Timeline browsing stranded the Mafia draft: ${JSON.stringify({ assignmentSummary, shooterCount, selectedAfterTimeline, evaluateDisabled, durableChanged: durableAfterNightTimeline !== durableBeforeNightTimeline })}`,
      );
    }
    const acceptedShotRequest = page.waitForRequest((request) => {
      if (request.method() !== "POST") return false;
      if (!new URL(request.url()).pathname.endsWith("/events")) return false;
      return request.postDataJSON().event?.type === "mafia.shots-resolved";
    });
    await evaluateShots.click();
    const acceptedShotEvent = (await acceptedShotRequest).postDataJSON().event;
    if (
      acceptedShotEvent?.replayVersion !== 1 ||
      acceptedShotEvent?.type !== "mafia.shots-resolved" ||
      typeof acceptedShotEvent?.parentEventId !== "string" ||
      !Number.isInteger(acceptedShotEvent?.sequence) ||
      acceptedShotEvent.sequence < 2 ||
      !/^sha256:[0-9a-f]{64}$/.test(acceptedShotEvent?.stateHashAfter ?? "") ||
      !Array.isArray(acceptedShotEvent?.payload?.shots) ||
      acceptedShotEvent.payload.shots.length !== shooterCount ||
      acceptedShotEvent.payload.shots.some(
        ({ shooterSeat, targetSeat, secret }) =>
          !Number.isInteger(shooterSeat) || !Number.isInteger(targetSeat) || secret !== true,
      ) ||
      typeof acceptedShotEvent?.payload?.result?.kind !== "string"
    ) {
      throw new Error("Mafia evaluation emitted an invalid canonical private event");
    }
    if ((await page.getByRole("button", { name: "Re-evaluate Mafia shots" }).count()) !== 0) {
      throw new Error("Mafia result must not offer Re-evaluate Mafia shots");
    }
    const logCountAfterEvaluation = Number(await shotLogCount.innerText());
    if (logCountAfterEvaluation - logCountBeforeShots !== 1) {
      throw new Error(
        `Evaluating Mafia shots must log one accepted resolution containing all ${shooterCount} shots: ${logCountBeforeShots} -> ${logCountAfterEvaluation}`,
      );
    }
    const resultGeometry = await page.locator(".table-night-center").evaluate((center) => {
      const resultCard = center.querySelector(".night-miss-card, .deceased-player-card");
      if (!(resultCard instanceof HTMLElement)) throw new Error("Expected the Mafia result card");
      const card = resultCard.getBoundingClientRect();
      return {
        cardLeft: card.left,
        cardWidth: card.width,
        centerLeft: center.getBoundingClientRect().left,
        centerWidth: center.getBoundingClientRect().width,
      };
    });
    const mafiaResultScreenshotPath = tableScreenshotPath.replace(/\.png$/i, "-mafia-result.png");
    await page.screenshot({ path: mafiaResultScreenshotPath, fullPage: true });
    await page.getByRole("button", { name: "Continue night" }).click();
    await page.getByRole("heading", { name: "Don check" }).waitFor();
    if ((await page.getByRole("button", { name: /^Red card / }).count()) !== 0) {
      throw new Error("Don check must use swipe Red without inline Red buttons");
    }
    await page.getByRole("button", { name: "Skip Don check" }).click();
    await page.getByRole("heading", { name: "Sheriff check" }).waitFor();
    if ((await page.getByRole("button", { name: /^Red card / }).count()) !== 0) {
      throw new Error("Sheriff check must use swipe Red without inline Red buttons");
    }
    await page.getByRole("button", { name: "Skip Sheriff check" }).click();
    await page.getByRole("heading", { name: "Night complete" }).waitFor();
    if ((await page.locator(".night-miss-card, .deceased-player-card").count()) !== 1) {
      throw new Error("Night complete must retain the evaluated Mafia result");
    }
    if ((await page.getByRole("button", { name: /^Red card / }).count()) !== 0) {
      throw new Error("Night complete must not show direct red-card buttons above player cards");
    }
    const nightCompleteScreenshotPath = tableScreenshotPath.replace(
      /\.png$/i,
      "-night-complete.png",
    );
    await page.screenshot({ path: nightCompleteScreenshotPath, fullPage: true });
    await page.getByRole("button", { name: /^Begin day \d+$/ }).click();
    await page.getByRole("heading", { name: "Best move" }).waitFor();
    const postNightHighlight = page.locator(".player-seat.is-voting-highlight");
    if ((await postNightHighlight.count()) !== 1) {
      throw new Error("The night victim must stay brightly highlighted during Best move");
    }
    await page.waitForTimeout(320);
    const postNightHighlightStyle = await postNightHighlight.evaluate((card) => ({
      animationName: getComputedStyle(card).animationName,
      opacity: getComputedStyle(card).opacity,
    }));
    if (
      !postNightHighlightStyle.animationName.includes("voting-fire-pulse") ||
      postNightHighlightStyle.opacity !== "1"
    ) {
      throw new Error(
        `The post-night victim must use the voting-fire animation: ${JSON.stringify(postNightHighlightStyle)}`,
      );
    }
    const bestMoveScreenshotPath = tableScreenshotPath.replace(/\.png$/i, "-best-move.png");
    await page.screenshot({ path: bestMoveScreenshotPath, fullPage: true });
    for (let selection = 0; selection < 3; selection += 1) {
      await page
        .getByRole("button", { name: /^Add .* to Best move$/ })
        .first()
        .click();
    }
    await page.getByRole("button", { name: "Save Best move" }).click();
    await page.getByRole("heading", { name: "Goodbye speech" }).waitFor();
    if ((await page.locator(".player-seat.is-voting-highlight").count()) !== 1) {
      throw new Error("The night victim must stay brightly highlighted during the goodbye speech");
    }
    const goodbyeScreenshotPath = tableScreenshotPath.replace(/\.png$/i, "-goodbye.png");
    await page.screenshot({ path: goodbyeScreenshotPath, fullPage: true });
    await page.getByRole("button", { name: /^Begin day \d+$/ }).click();
    await page.getByRole("heading", { name: /^Day \d+$/ }).waitFor();
    if ((await page.locator(".player-seat.is-voting-highlight").count()) !== 0) {
      throw new Error("The post-night voting-fire highlight must end when the day starts");
    }
    await page.goto(storageMutationUrl, { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      const storageKey = "mafia-dashboard.game-session.v4";
      const raw = window.sessionStorage.getItem(storageKey);
      if (raw === null) throw new Error("Expected a persisted game session");
      const envelope = JSON.parse(raw);
      const game = structuredClone(envelope.baseline?.game);
      if (game === null || game === undefined)
        throw new Error("Expected a persisted replay baseline");
      const activeSeats = game.players
        .filter((player) => player.status === "active")
        .slice(0, 3)
        .map((player) => player.seat);
      game.phase = "car-crash-decision";
      game.day = Math.max(1, game.day);
      game.carCrashSeats = activeSeats;
      game.carCrashVotes = {};
      game.voteAssignments = {};
      game.votingRound = "repeat";
      game.winner = null;
      await window.__mafiaVerifierCheckpointEnvelope(envelope, game);
      envelope.resetReturnEventId = null;
      envelope.results = null;
      envelope.outbox = [];
      envelope.failed = false;
      window.sessionStorage.setItem(storageKey, JSON.stringify(envelope));
    });
    await page.goto(browserAppUrl, { waitUntil: "networkidle" });
    await page.locator(".club-playing-card:not(.new-club-card)").first().click();
    await page.waitForTimeout(950);
    await page.getByRole("heading", { name: "Car crash decision" }).waitFor();
    await page.getByText("Eliminate all players voting").waitFor();
    if (
      (await page.getByRole("button", { name: /^Eliminate (all|both) nominees$/ }).count()) !== 0 ||
      (await page.getByRole("button", { name: /^Keep (all|both) nominees$/ }).count()) !== 0
    ) {
      throw new Error("The eliminate-all ballot must not expose separate Eliminate/Keep buttons");
    }
    const zeroVoteResolve = page.getByRole("button", { name: "Resolve car crash" });
    if (!(await zeroVoteResolve.isEnabled())) {
      throw new Error("Zero eliminate-all votes must be immediately resolvable");
    }
    await page.screenshot({ path: carCrashScreenshotPath, fullPage: true });
    await zeroVoteResolve.click();
    await page.getByRole("heading", { name: "Car crash result" }).waitFor();
    await page
      .getByRole("status", { name: "Car-crash result" })
      .getByText("Players stay")
      .waitFor();
    const keptResultActivePlayers = await page.locator(".player-seat.status-active").count();
    if (
      (await page.getByRole("button", { name: /^Foul / }).count()) !== keptResultActivePlayers ||
      (await page.locator(".player-seat.is-provisional-deceased").count()) !== 0
    ) {
      throw new Error(
        "A kept car-crash result must retain every active player's Foul control without provisional deaths",
      );
    }
    await page.getByRole("button", { name: "Continue" }).click();
    await page.locator(".game-shell.phase-night-mafia").waitFor();
    await page.goto(storageMutationUrl, { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      const storageKey = "mafia-dashboard.game-session.v4";
      const raw = window.sessionStorage.getItem(storageKey);
      if (raw === null) throw new Error("Expected a persisted game session");
      const envelope = JSON.parse(raw);
      const game = structuredClone(envelope.baseline?.game);
      if (game === null || game === undefined)
        throw new Error("Expected a persisted replay baseline");
      game.phase = "car-crash-decision";
      game.day = Math.max(1, game.day);
      game.carCrashSeats = game.players
        .filter((player) => player.status === "active")
        .slice(0, 3)
        .map((player) => player.seat);
      game.carCrashVotes = {};
      game.voteAssignments = {};
      game.votingRound = "repeat";
      game.winner = null;
      await window.__mafiaVerifierCheckpointEnvelope(envelope, game);
      envelope.resetReturnEventId = null;
      envelope.results = null;
      envelope.outbox = [];
      envelope.failed = false;
      window.sessionStorage.setItem(storageKey, JSON.stringify(envelope));
    });
    await page.goto(browserAppUrl, { waitUntil: "networkidle" });
    await page.locator(".club-playing-card:not(.new-club-card)").first().click();
    await page.waitForTimeout(950);
    const eliminateVotes = page.getByRole("button", {
      name: /^Vote as .* to eliminate all car-crash players$/,
    });
    for (let index = 0; index < 6; index += 1) await eliminateVotes.first().click();
    const decisionActivePlayers = await page.locator(".player-seat.status-active").count();
    if ((await page.getByRole("button", { name: /^Foul / }).count()) !== decisionActivePlayers) {
      throw new Error("Car-crash voting must retain every active player's Foul control");
    }
    await page.getByRole("button", { name: "Resolve car crash" }).click();
    await page.getByRole("heading", { name: "Car crash result" }).waitFor();
    await page.getByRole("status", { name: "Car-crash result" }).getByText("Eliminated").waitFor();
    if (
      (await page.locator(".player-seat.is-provisional-deceased").count()) !== 3 ||
      (await page.getByRole("button", { name: /^Foul / }).count()) !== decisionActivePlayers
    ) {
      throw new Error(
        "Every car-crash participant must be provisional while every active Foul control remains available",
      );
    }
    const carCrashResultScreenshotPath = carCrashScreenshotPath.replace(
      /\.png$/i,
      "-eliminated-result.png",
    );
    await page.screenshot({ path: carCrashResultScreenshotPath, fullPage: true });
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("heading", { name: "Goodbye speech" }).waitFor();
    await page.goto(storageMutationUrl, { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      const storageKey = "mafia-dashboard.game-session.v4";
      const raw = window.sessionStorage.getItem(storageKey);
      if (raw === null) throw new Error("Expected a persisted game session");
      const envelope = JSON.parse(raw);
      const game = structuredClone(envelope.baseline?.game);
      if (game === null || game === undefined)
        throw new Error("Expected a persisted replay baseline");
      game.phase = "night-don";
      game.day = Math.max(1, game.day);
      game.players = game.players.map((player) =>
        player.role === "don" || player.role === "sheriff"
          ? { ...player, status: "eliminated" }
          : player,
      );
      game.carCrashSeats = undefined;
      game.carCrashVotes = undefined;
      game.carCrashResult = undefined;
      game.votingCancellation = undefined;
      game.goodbyeSeats = undefined;
      game.goodbyeNext = undefined;
      game.bestMove = undefined;
      game.checkResult = undefined;
      game.winner = null;
      await window.__mafiaVerifierCheckpointEnvelope(envelope, game);
      envelope.resetReturnEventId = null;
      envelope.results = null;
      envelope.outbox = [];
      envelope.failed = false;
      window.sessionStorage.setItem(storageKey, JSON.stringify(envelope));
    });
    await page.goto(browserAppUrl, { waitUntil: "networkidle" });
    await page.locator(".club-playing-card:not(.new-club-card)").first().click();
    await page.waitForTimeout(950);
    const assertOnlyCheckAction = async (expected) => {
      const phaseActions = (
        await page.locator(".table-advance button:visible").allTextContents()
      ).map((text) => text.trim());
      if (
        JSON.stringify(phaseActions) !== JSON.stringify([expected]) ||
        (await page.locator(".seat-actions button:visible").count()) !== 0 ||
        (await page.locator(".table-center button:visible").count()) !== 0
      ) {
        throw new Error(
          `A dead check owner must expose only ${expected}: ${JSON.stringify(phaseActions)}`,
        );
      }
    };
    await page.getByRole("heading", { name: "Don check" }).waitFor();
    await assertOnlyCheckAction("Skip Don check");
    const deadDonScreenshotPath = tableScreenshotPath.replace(/\.png$/i, "-dead-don-check.png");
    await page.screenshot({ path: deadDonScreenshotPath, fullPage: true });
    await page.getByRole("button", { name: "Skip Don check" }).click();
    await page.getByRole("heading", { name: "Sheriff check" }).waitFor();
    await assertOnlyCheckAction("Skip Sheriff check");
    const deadSheriffScreenshotPath = tableScreenshotPath.replace(
      /\.png$/i,
      "-dead-sheriff-check.png",
    );
    await page.screenshot({ path: deadSheriffScreenshotPath, fullPage: true });
    await page.getByRole("button", { name: "Skip Sheriff check" }).click();
    await page.getByRole("heading", { name: "Night complete" }).waitFor();
    await page.goto(storageMutationUrl, { waitUntil: "domcontentloaded" });
    const staleGoodbyeFixture = await page.evaluate(async () => {
      const storageKey = "mafia-dashboard.game-session.v4";
      const raw = window.sessionStorage.getItem(storageKey);
      if (raw === null) throw new Error("Expected a persisted game session");
      const envelope = JSON.parse(raw);
      const game = structuredClone(envelope.baseline?.game);
      if (game === null || game === undefined)
        throw new Error("Expected a persisted replay baseline");
      const earlierSeat = game.players[0]?.seat;
      const speaker = game.players.find(
        (player) => player.status === "active" && player.seat !== earlierSeat,
      );
      if (earlierSeat === undefined || speaker === undefined) {
        throw new Error("Expected an earlier Best move victim and another active player");
      }
      game.phase = "goodbye-speech";
      game.day = Math.max(1, game.day);
      game.players = game.players.map((player) =>
        player.seat === speaker.seat ? { ...player, status: "eliminated" } : player,
      );
      game.bestMove = { playerSeat: earlierSeat, selectedSeats: [], mafiaHits: 0 };
      game.goodbyeSeats = [speaker.seat];
      game.goodbyeNext = "day";
      await window.__mafiaVerifierCheckpointEnvelope(envelope, game);
      envelope.resetReturnEventId = null;
      envelope.results = null;
      envelope.metadata = { ...envelope.metadata, legacyLog: [] };
      envelope.outbox = [];
      envelope.failed = false;
      window.sessionStorage.setItem(storageKey, JSON.stringify(envelope));
      return { earlierSeat, speakerSeat: speaker.seat, speakerName: speaker.name };
    });
    await page.goto(browserAppUrl, { waitUntil: "networkidle" });
    await page.locator(".club-playing-card:not(.new-club-card)").first().click();
    await page.waitForTimeout(950);
    await page.getByRole("heading", { name: "Goodbye speech" }).waitFor();
    const staleGoodbyeHighlights = page.locator(".player-seat.is-voting-highlight");
    const staleGoodbyeHighlightState = {
      count: await staleGoodbyeHighlights.count(),
      earlierHighlighted: await page
        .getByRole("button", { name: new RegExp(`^Seat ${staleGoodbyeFixture.earlierSeat}:`) })
        .evaluate((card) => card.classList.contains("is-voting-highlight")),
      speakerHighlighted: await page
        .getByRole("button", {
          name: `Seat ${staleGoodbyeFixture.speakerSeat}: ${staleGoodbyeFixture.speakerName}`,
        })
        .evaluate((card) => card.classList.contains("is-voting-highlight")),
    };
    if (
      staleGoodbyeHighlightState.count !== 1 ||
      staleGoodbyeHighlightState.earlierHighlighted ||
      !staleGoodbyeHighlightState.speakerHighlighted
    ) {
      throw new Error(
        `Only the current goodbye speaker may be highlighted: ${JSON.stringify(staleGoodbyeHighlightState)}`,
      );
    }
    const goodbyeTransitionStyle = await staleGoodbyeHighlights.evaluate((card) => {
      const style = getComputedStyle(card);
      return {
        animationName: style.animationName,
        transitionDuration: style.transitionDuration,
      };
    });
    if (
      !goodbyeTransitionStyle.animationName.includes("voting-highlight-enter") ||
      !goodbyeTransitionStyle.animationName.includes("voting-fire-pulse") ||
      !goodbyeTransitionStyle.transitionDuration.includes("0.28s")
    ) {
      throw new Error(
        `Goodbye highlight state changes must animate: ${JSON.stringify(goodbyeTransitionStyle)}`,
      );
    }
    const staleGoodbyeScreenshotPath = tableScreenshotPath.replace(
      /\.png$/i,
      "-goodbye-stale-best-move.png",
    );
    await page.screenshot({ path: staleGoodbyeScreenshotPath, fullPage: true });
    await page.goto(storageMutationUrl, { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      const storageKey = "mafia-dashboard.game-session.v4";
      const raw = window.sessionStorage.getItem(storageKey);
      if (raw === null) throw new Error("Expected a persisted game session");
      const envelope = JSON.parse(raw);
      const game = structuredClone(envelope.baseline?.game);
      if (game === null || game === undefined)
        throw new Error("Expected a persisted replay baseline");
      game.phase = "finished";
      game.day = Math.max(1, game.day);
      game.winner = "red";
      game.goodbyeSeats = undefined;
      game.goodbyeNext = undefined;
      await window.__mafiaVerifierCheckpointEnvelope(envelope, game);
      envelope.resetReturnEventId = null;
      envelope.results = null;
      envelope.metadata = { ...envelope.metadata, legacyLog: [] };
      envelope.outbox = [];
      envelope.failed = false;
      window.sessionStorage.setItem(storageKey, JSON.stringify(envelope));
    });
    await page.goto(browserAppUrl, { waitUntil: "networkidle" });
    await page.locator(".club-playing-card:not(.new-club-card)").first().click();
    await page.waitForTimeout(950);
    const finishCopy = page.getByText("Citizens won", { exact: true });
    if ((await finishCopy.count()) < 2) {
      throw new Error("Finish screen and phase banner must both say Citizens won");
    }
    const finishScreenshotPath = tableScreenshotPath.replace(/\.png$/i, "-finished.png");
    await page.screenshot({ path: finishScreenshotPath, fullPage: true });
    assertNoPageErrors();
    console.log(
      `Focused iPad gameplay verification: PASS ${JSON.stringify({ consoleGeometry, actionRowGeometry, wrappedActionGeometry, timerAudioStarts, centerShadowStyle, sidePanelGeometry, glassEvidence, playerControlGeometry, actionGeometry, swipeMenuGeometry, statusLayout, voteToggleState, votingHighlightStyle, postNightHighlightStyle, staleGoodbyeHighlightState, goodbyeTransitionStyle, nightCycleStyle, dayCycleStyle, resultGeometry, playerControlsScreenshotPath, sidePanelScreenshotPath, glassScreenshotPath, nightCycleScreenshotPath, dayCycleScreenshotPath, swipeMenuScreenshotPath, tableScreenshotPath, votingScreenshotPath, autoVotingScreenshotPath, cancellationScreenshotPath, shotToggleScreenshotPath, mafiaResultScreenshotPath, nightCompleteScreenshotPath, bestMoveScreenshotPath, goodbyeScreenshotPath, staleGoodbyeScreenshotPath, finishScreenshotPath, previewScreenshotPath, timelineScreenshotPath, timelineRightScreenshotPath, carCrashScreenshotPath, carCrashResultScreenshotPath, deadDonScreenshotPath, deadSheriffScreenshotPath })}`,
    );
    await browser.close();
    process.exit(0);
  }
  await page.getByRole("button", { name: "Select available players" }).click();
  const availablePlayers = page.getByRole("button", { name: /^Mark UI Player \d+ available$/ });
  if ((await availablePlayers.count()) !== 11) {
    throw new Error("Expected eleven players in the availability picker");
  }
  for (let playerIndex = 0; playerIndex < 11; playerIndex += 1) {
    await availablePlayers.first().click();
  }
  await page.getByRole("button", { name: "Close available players" }).click();
  await page.getByRole("combobox", { name: "Host player" }).click();
  await page.getByRole("option", { name: testNicknames[10], exact: true }).click();
  await page.getByRole("button", { name: "Assign players" }).click();
  const playerSelectors = page.getByRole("combobox", { name: /^Seat \d+ player$/ });
  if ((await playerSelectors.count()) !== 10) throw new Error("Expected ten player selectors");
  await page.waitForFunction(() =>
    [...document.querySelectorAll('input[aria-label^="Seat "][aria-label$=" player"]')].every(
      (input) => input instanceof HTMLInputElement && input.value !== "",
    ),
  );
  const selectedPlayerNames = await playerSelectors.evaluateAll((selectors) =>
    selectors.map((selector) => {
      if (!(selector instanceof HTMLInputElement)) throw new Error("Expected player input");
      return selector.value;
    }),
  );
  const selectedPlayers = selectedPlayerNames.flatMap((nickname) => {
    const player = testPlayers.find((candidate) => candidate.nickname === nickname);
    return player === undefined ? [] : [player];
  });
  if (
    selectedPlayers.length !== 10 ||
    new Set(selectedPlayers.map(({ id }) => id)).size !== 10 ||
    selectedPlayers.some(({ id }) => id === testPlayers[10].id)
  ) {
    throw new Error(
      `Assigned seats must contain ten unique non-host players: ${JSON.stringify(selectedPlayerNames)}`,
    );
  }
  await page.screenshot({ path: selectionScreenshotPath, fullPage: true });

  await page.evaluate(() => {
    class FakeYouTubePlayer {
      constructor(_elementId, options) {
        this.options = options;
        this.volume = 65;
        this.volumeChanges = [];
        this.played = false;
        this.videoIds = [];
        this.iframe = document.createElement("iframe");
        window.__uiYouTubePlayer = this;
        setTimeout(() => options.events?.onReady?.({ target: this }), 0);
      }
      playVideo() {
        this.played = true;
        this.options.events?.onStateChange?.({ target: this, data: 1 });
      }
      pauseVideo() {
        this.options.events?.onStateChange?.({ target: this, data: 2 });
      }
      cuePlaylist(videoIds, index = 0) {
        this.videoIds = [...videoIds];
        this.playlistIndex = index;
        this.options.events?.onStateChange?.({ target: this, data: 5 });
      }
      loadPlaylist(_videoIds, index = 0) {
        this.playlistIndex = index;
        this.options.events?.onStateChange?.({ target: this, data: 1 });
      }
      playVideoAt(index) {
        this.playlistIndex = index;
        this.playVideo();
      }
      setVolume(volume) {
        this.volume = volume;
        this.volumeChanges.push(volume);
      }
      getVolume() {
        return this.volume;
      }
      getIframe() {
        return this.iframe;
      }
      getPlaylistIndex() {
        return this.playlistIndex ?? 0;
      }
      getCurrentTime() {
        return 0;
      }
      destroy() {}
    }
    window.YT = {
      Player: FakeYouTubePlayer,
      PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0, BUFFERING: 3, CUED: 5 },
    };
  });
  await page.getByRole("button", { name: "Open Manage menu" }).click();
  await page.getByRole("button", { name: "Music player setup" }).click();
  const musicSetup = page.getByRole("region", { name: "Music player setup" });
  await musicSetup.getByLabel("YouTube Music playlist").selectOption("test-playlist");
  await page.getByText("Ready · paused").waitFor();
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await page.getByRole("button", { name: "Close Manage menu" }).click();
  const queueHandle = page.getByRole("button", { name: "Music player panel handle" });
  await queueHandle.click();
  const queue = page.getByRole("region", { name: "Session playlist queue" });
  const finaleRow = queue.getByRole("listitem").filter({ hasText: "UI verification finale" });
  const finaleContent = finaleRow.locator(".queue-item-content");
  const revealTrackTypes = async (row, content, identifier) => {
    await content.dispatchEvent("touchstart", {
      touches: [{ identifier, clientX: 180, clientY: 40 }],
    });
    await content.dispatchEvent("touchend", {
      changedTouches: [{ identifier, clientX: 80, clientY: 42 }],
    });
    if (
      !(await row.evaluate((candidate) => candidate.classList.contains("is-queue-tags-revealed")))
    ) {
      throw new Error("Queue browser fixture did not reveal the track-type tray");
    }
    await content.click();
  };
  await revealTrackTypes(finaleRow, finaleContent, 9);
  await finaleRow
    .getByRole("button", { name: "Mark UI verification finale for Role giveaway" })
    .click();
  await page.waitForFunction(() => {
    const row = [...document.querySelectorAll(".youtube-session-queue li")].find((candidate) =>
      candidate.textContent?.includes("UI verification finale"),
    );
    return row?.getAttribute("data-initial-stage") === "true";
  });
  const initialMarkerColor = await finaleRow.evaluate(
    (row) => getComputedStyle(row, "::before").backgroundColor,
  );
  await revealTrackTypes(finaleRow, finaleContent, 10);
  await page.waitForTimeout(180);
  const initialAction = finaleRow.getByRole("button", {
    name: "Unmark UI verification finale for Role giveaway",
  });
  const initialActionStyle = await initialAction.evaluate((button) => {
    const style = getComputedStyle(button);
    return {
      backgroundColor: style.backgroundColor,
      boxShadow: style.boxShadow,
      fontWeight: style.fontWeight,
    };
  });
  await finaleRow
    .getByRole("button", { name: "Mark UI verification finale for Critical endgame" })
    .click();
  await page.waitForFunction(() => {
    const row = [...document.querySelectorAll(".youtube-session-queue li")].find((candidate) =>
      candidate.textContent?.includes("UI verification finale"),
    );
    return (
      row?.getAttribute("data-initial-stage") === "false" &&
      row.getAttribute("data-endgame") === "true"
    );
  });
  const endgameMarkerColor = await finaleRow.evaluate(
    (row) => getComputedStyle(row, "::before").backgroundColor,
  );
  await revealTrackTypes(finaleRow, finaleContent, 11);
  await page.waitForTimeout(180);
  const endgameAction = finaleRow.getByRole("button", {
    name: "Unmark UI verification finale for Critical endgame",
  });
  const endgameActionStyle = await endgameAction.evaluate((button) => {
    const style = getComputedStyle(button);
    return {
      backgroundColor: style.backgroundColor,
      boxShadow: style.boxShadow,
      fontWeight: style.fontWeight,
    };
  });
  if (
    initialMarkerColor !== "rgb(53, 201, 120)" ||
    endgameMarkerColor !== "rgb(228, 75, 85)" ||
    initialActionStyle.backgroundColor !== "rgb(22, 133, 83)" ||
    endgameActionStyle.backgroundColor !== "rgb(167, 43, 53)" ||
    !initialActionStyle.boxShadow.includes("inset") ||
    !endgameActionStyle.boxShadow.includes("inset") ||
    Number(initialActionStyle.fontWeight) < 700 ||
    Number(endgameActionStyle.fontWeight) < 700
  ) {
    throw new Error(
      `Queue markers or pressed actions are not visually distinct: ${JSON.stringify({ initialMarkerColor, endgameMarkerColor, initialActionStyle, endgameActionStyle })}`,
    );
  }
  await page.screenshot({ path: queueTagsScreenshotPath, fullPage: true });
  await finaleRow.getByRole("button", { name: "Play UI verification finale next" }).click();
  if (
    !(await queue.getByRole("listitem").nth(1).innerText()).includes("UI verification finale") ||
    (await finaleRow.evaluate(
      (row) =>
        row.classList.contains("is-queue-tags-revealed") ||
        row.classList.contains("is-next") ||
        row.getAttribute("data-initial-stage") !== "false" ||
        row.getAttribute("data-endgame") !== "true",
    )) ||
    (await finaleRow
      .getByRole("button", { name: "Play UI verification finale next" })
      .getAttribute("aria-pressed")) !== null
  ) {
    throw new Error("Play next must move the row without leaving tray or selected-row state");
  }
  const markInitial = async (title, identifier) => {
    const row = queue.getByRole("listitem").filter({ hasText: title });
    const content = row.locator(".queue-item-content");
    await revealTrackTypes(row, content, identifier);
    await row.getByRole("button", { name: `Mark ${title} for Role giveaway` }).click();
  };
  await markInitial("UI verification track", 12);
  await markInitial("UI verification opening two", 13);
  await queueHandle.click();
  await page.getByRole("button", { name: "Start game" }).click();
  await page.getByRole("heading", { name: "Role giveaway" }).waitFor();
  await queueHandle.click();
  const openingRows = await queue.getByRole("listitem").evaluateAll((rows) =>
    rows.map((row) => ({
      title: row.textContent ?? "",
      initial: row.getAttribute("data-initial-stage") === "true",
      endgame: row.getAttribute("data-endgame") === "true",
    })),
  );
  const openingPlayer = await page.evaluate(() => {
    const player = window.__uiYouTubePlayer;
    return {
      played: player?.played ?? false,
      playlistIndex: player?.playlistIndex ?? null,
      videoIds: player?.videoIds ?? [],
      volumeChanges: player?.volumeChanges ?? [],
    };
  });
  const openingCurrentVideoId = openingRows[0]?.title.includes("opening two")
    ? "ui-track-4"
    : "ui-track-1";
  const openingNextVideoId = openingRows[1]?.title.includes("ordinary two")
    ? "ui-track-5"
    : "ui-track-2";
  if (
    openingRows.length !== 5 ||
    openingRows[0]?.initial !== true ||
    openingRows[1]?.initial !== false ||
    openingRows[1]?.endgame !== false ||
    openingRows.at(-1)?.initial !== true ||
    openingRows.slice(1, -1).some(({ initial }) => initial) ||
    openingPlayer.played !== true ||
    openingPlayer.playlistIndex !== 0 ||
    openingPlayer.videoIds[0] !== openingCurrentVideoId ||
    openingPlayer.videoIds[1] !== openingNextVideoId ||
    openingPlayer.volumeChanges[0] !== 0
  ) {
    throw new Error(
      `Start game did not build and fade the constrained opening queue: ${JSON.stringify({ openingRows, openingPlayer })}`,
    );
  }
  await queueHandle.click();

  for (const { nickname } of selectedPlayers) {
    await page.getByRole("button", { name: `Draw role for ${nickname}`, exact: true }).click();
  }
  await page.getByRole("button", { name: "Begin Mafia planning stage" }).click();
  await page.getByRole("heading", { name: "Mafia planning stage" }).waitFor();
  if (headerOnly) {
    await page.getByRole("button", { name: "Continue to Sheriff wake-up" }).click();
    await page.getByRole("button", { name: "Begin day one" }).click();
    const firstPlayer = selectedPlayers[0]?.nickname;
    const secondPlayer = selectedPlayers[1]?.nickname;
    if (firstPlayer === undefined || secondPlayer === undefined) {
      throw new Error("Phone verification requires the first two selected players");
    }
    if (
      (await page.getByRole("button", { name: `Red card ${firstPlayer}`, exact: true }).count()) !==
      0
    ) {
      throw new Error("Day player cards must not expose a direct red-card button");
    }
    const firstPlayerCard = page.getByRole("button", {
      name: `Seat 1: ${firstPlayer}`,
      exact: true,
    });
    await firstPlayerCard.dispatchEvent("touchstart", {
      touches: [{ clientX: 20, clientY: 50 }],
    });
    await firstPlayerCard.dispatchEvent("touchend", {
      changedTouches: [{ clientX: 82, clientY: 52 }],
    });
    await page.getByRole("button", { name: `Red card ${firstPlayer}`, exact: true }).click();
    await page.getByText(`Current turn: ${secondPlayer}`).waitFor();
    await page.getByRole("button", { name: `Foul ${secondPlayer}`, exact: true }).click();
    await page.getByText("Foul ×1").waitFor();
    const phoneGeometry = await page.evaluate(() => {
      const rect = (element) => {
        const box = element.getBoundingClientRect();
        return {
          label: element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "unknown",
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          width: box.width,
          height: box.height,
        };
      };
      const header = document.querySelector(".game-header");
      if (!(header instanceof HTMLElement)) throw new Error("Game header missing");
      const cards = [...document.querySelectorAll(".table-card")].map(rect);
      const seatActionButtons = [...document.querySelectorAll(".seat-actions button")].map(rect);
      const headerChildren = [...header.children].map(rect);
      const auxiliaryPanels = [
        document.querySelector(".youtube-dock.is-compact"),
        document.querySelector(".game-log-drawer"),
      ]
        .filter((element) => element instanceof HTMLElement)
        .map(rect);
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        cards,
        seatActionButtons,
        headerChildren,
        auxiliaryPanels,
      };
    });
    if (phoneGeometry.documentWidth > phoneGeometry.viewportWidth + 1) {
      throw new Error(`Phone layout clips horizontally: ${JSON.stringify(phoneGeometry)}`);
    }
    for (const element of [...phoneGeometry.headerChildren, ...phoneGeometry.cards]) {
      if (element.left < 0 || element.right > phoneGeometry.viewportWidth) {
        throw new Error(`Phone element is outside the viewport: ${JSON.stringify(element)}`);
      }
    }
    if (phoneGeometry.seatActionButtons.length < 18) {
      throw new Error("Phone fallback must expose foul and nomination controls");
    }
    for (const action of phoneGeometry.seatActionButtons) {
      if (action.width < 38 || action.height < 38) {
        throw new Error(`Phone seat action is too small: ${JSON.stringify(action)}`);
      }
    }
    for (let leftIndex = 0; leftIndex < phoneGeometry.cards.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < phoneGeometry.cards.length;
        rightIndex += 1
      ) {
        const left = phoneGeometry.cards[leftIndex];
        const right = phoneGeometry.cards[rightIndex];
        const overlaps =
          Math.min(left.right, right.right) > Math.max(left.left, right.left) &&
          Math.min(left.bottom, right.bottom) > Math.max(left.top, right.top);
        if (overlaps) throw new Error(`${left.label} overlaps ${right.label} on phone`);
      }
    }
    for (const panel of phoneGeometry.auxiliaryPanels) {
      for (const card of phoneGeometry.cards) {
        const overlaps =
          Math.min(panel.right, card.right) > Math.max(panel.left, card.left) &&
          Math.min(panel.bottom, card.bottom) > Math.max(panel.top, card.top);
        if (overlaps) throw new Error(`${panel.label} obscures ${card.label} on phone`);
      }
    }
    await page.screenshot({ path: tableScreenshotPath, fullPage: true });
    assertNoPageErrors();
    console.log("Responsive phone game verification: PASS");
    await browser.close();
    process.exit(0);
  }
  const enterFullscreen = page.getByRole("button", { name: "Enter fullscreen" });
  if (!(await enterFullscreen.isEnabled())) throw new Error("Fullscreen API is unavailable");
  await enterFullscreen.click();
  await page.waitForFunction(() => document.fullscreenElement !== null);
  await page.getByRole("button", { name: "Exit fullscreen" }).waitFor();
  if ((await page.locator(".player-seat").count()) !== 10) {
    throw new Error("Expected ten player seats on the live table");
  }
  await page.getByRole("group", { name: `Host: ${testNicknames[10]}` }).waitFor();
  const geometry = await page.evaluate(() => {
    const table = document.querySelector(".round-table");
    if (!(table instanceof HTMLElement)) throw new Error("Missing round table");
    const headerTitle = document.querySelector(".game-header > :first-child");
    if (!(headerTitle instanceof HTMLElement)) throw new Error("Missing game header title");
    const headerTitleBox = headerTitle.getBoundingClientRect();
    const cards = [...document.querySelectorAll(".table-card")].map((element) => {
      const box = element.getBoundingClientRect();
      return {
        label: element.getAttribute("aria-label"),
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
        centerX: box.left + box.width / 2,
        centerY: box.top + box.height / 2,
      };
    });
    const phaseBannerBox = document.querySelector(".phase-banner")?.getBoundingClientRect();
    const phaseBannerObstructions =
      phaseBannerBox === undefined
        ? ["missing phase banner"]
        : [...document.querySelectorAll(".seat-actions")].filter((element) => {
            const box = element.getBoundingClientRect();
            return !(
              box.right <= phaseBannerBox.left ||
              box.left >= phaseBannerBox.right ||
              box.bottom <= phaseBannerBox.top ||
              box.top >= phaseBannerBox.bottom
            );
          });
    return {
      cards,
      headerTitle: {
        left: headerTitleBox.left,
        right: headerTitleBox.right,
        top: headerTitleBox.top,
        bottom: headerTitleBox.bottom,
      },
      phaseBannerObstructionCount: phaseBannerObstructions.length,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
    };
  });
  if (geometry.cards.length !== 11) throw new Error("Expected ten player cards and one host card");
  const fullscreenExitSafeArea = { right: 88, bottom: 88 };
  if (
    geometry.headerTitle.left < fullscreenExitSafeArea.right &&
    geometry.headerTitle.right > 0 &&
    geometry.headerTitle.top < fullscreenExitSafeArea.bottom &&
    geometry.headerTitle.bottom > 0
  ) {
    throw new Error(
      `Game header title overlaps the fullscreen exit safe area: ${JSON.stringify(geometry.headerTitle)}`,
    );
  }
  const [referenceCard] = geometry.cards;
  if (referenceCard === undefined) throw new Error("Expected table cards");
  for (const card of geometry.cards) {
    if (Math.abs(card.width - referenceCard.width) > 0.5) {
      throw new Error(`Card width mismatch for ${card.label ?? "unknown"}`);
    }
    if (Math.abs(card.height - referenceCard.height) > 0.5) {
      throw new Error(`Card height mismatch for ${card.label ?? "unknown"}`);
    }
  }

  for (let leftIndex = 0; leftIndex < geometry.cards.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < geometry.cards.length; rightIndex += 1) {
      const left = geometry.cards[leftIndex];
      const right = geometry.cards[rightIndex];
      if (left === undefined || right === undefined) continue;
      const overlaps =
        Math.min(left.right, right.right) > Math.max(left.left, right.left) &&
        Math.min(left.bottom, right.bottom) > Math.max(left.top, right.top);
      if (overlaps) throw new Error(`${left.label ?? "Host"} overlaps ${right.label ?? "Host"}`);
    }
  }
  if (geometry.documentWidth > geometry.viewportWidth) {
    throw new Error("Live layout clips horizontally");
  }
  if (geometry.documentHeight > geometry.viewportHeight + 1) {
    throw new Error(
      `Primary live layout scrolls vertically (${geometry.documentHeight}px > ${geometry.viewportHeight}px)`,
    );
  }
  if (geometry.phaseBannerObstructionCount > 0) {
    throw new Error(
      `Phase banner is obstructed by ${geometry.phaseBannerObstructionCount} seat control group(s)`,
    );
  }
  for (const card of geometry.cards) {
    if (card.top < 0 || card.bottom > geometry.viewportHeight) {
      throw new Error(`${card.label ?? "Table card"} is outside the fixed viewport`);
    }
  }
  const hostCenter = geometry.cards.find(({ label }) => label?.startsWith("Host:"));
  if (hostCenter === undefined) throw new Error("Expected a visible host position");
  const hostVisual = await page.locator(".host-seat").evaluate((element) => {
    const style = getComputedStyle(element);
    return { backgroundImage: style.backgroundImage, boxShadow: style.boxShadow };
  });
  if (hostVisual.backgroundImage === "none") {
    throw new Error("Host card must have a distinct layered visual treatment");
  }
  const seatBoxes = geometry.cards.filter(({ label }) => label?.startsWith("Seat "));
  const closestSeatLeftOfHost = seatBoxes
    .filter((seat) => seat.centerX < hostCenter.centerX)
    .sort(
      (left, right) =>
        Math.hypot(left.centerX - hostCenter.centerX, left.centerY - hostCenter.centerY) -
        Math.hypot(right.centerX - hostCenter.centerX, right.centerY - hostCenter.centerY),
    )[0];
  if (!closestSeatLeftOfHost?.label?.startsWith("Seat 1:")) {
    throw new Error(
      `Expected seat 1 immediately left of host, found ${closestSeatLeftOfHost?.label ?? "none"}`,
    );
  }
  for (const seconds of [60, 30, 10]) {
    await page.getByRole("button", { name: `Start ${seconds} second timer` }).click();
    await page.getByRole("button", { name: "Stop timer" }).click();
  }
  const audioStarts = await page.evaluate(() => window.__mafiaAudioStarts);
  if (
    audioStarts.length !== 3 ||
    audioStarts.some((delay, index) => Math.abs(delay - [50, 20, 0][index]) > 0.001)
  ) {
    throw new Error(`Timer warning chimes were not scheduled at 10 seconds: ${audioStarts}`);
  }
  await page.getByRole("button", { name: "Music fade in" }).waitFor();
  await page.getByRole("button", { name: "Quick music fade out" }).waitFor();
  await page.getByRole("button", { name: "Slow music fade out" }).waitFor();
  if (
    (await page.getByLabel("Choose next YouTube track").count()) !== 0 ||
    (await page.getByRole("button", { name: "Set next track" }).count()) !== 0
  ) {
    throw new Error(
      "YouTube playlist order must not expose an application-level next-track override",
    );
  }
  await page.getByRole("button", { name: "Continue to Sheriff wake-up" }).click();
  await page.getByRole("button", { name: "Begin day one" }).click();
  const dayBannerGeometry = await page.evaluate(() => {
    const phaseBannerBox = document.querySelector(".phase-banner")?.getBoundingClientRect();
    if (phaseBannerBox === undefined) return { banner: null, obstructions: ["missing"] };
    const obstructions = [...document.querySelectorAll(".seat-actions, .table-card")]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return !(
          box.right <= phaseBannerBox.left ||
          box.left >= phaseBannerBox.right ||
          box.bottom <= phaseBannerBox.top ||
          box.top >= phaseBannerBox.bottom
        );
      })
      .map((element) => {
        const box = element.getBoundingClientRect();
        return {
          className: element.className,
          label: element.getAttribute("aria-label"),
          rect: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
        };
      });
    return {
      banner: {
        left: phaseBannerBox.left,
        right: phaseBannerBox.right,
        top: phaseBannerBox.top,
        bottom: phaseBannerBox.bottom,
      },
      obstructions,
    };
  });
  if (dayBannerGeometry.obstructions.length > 0) {
    throw new Error(`Day banner obstruction: ${JSON.stringify(dayBannerGeometry)}`);
  }
  const activeSeat = page.locator('.player-seat[aria-current="step"]');
  await activeSeat.waitFor();
  const activeAnimation = await activeSeat.evaluate((element) => {
    const style = getComputedStyle(element);
    return { animationName: style.animationName, animationDuration: style.animationDuration };
  });
  if (activeAnimation.animationName === "none" || activeAnimation.animationDuration === "0s") {
    throw new Error("Current player card does not have an active-turn animation");
  }
  const animatedNonCurrentSeats = await page
    .locator('.player-seat:not([aria-current="step"])')
    .evaluateAll(
      (elements) =>
        elements.filter((element) => getComputedStyle(element).animationName !== "none").length,
    );
  if (animatedNonCurrentSeats !== 0) {
    throw new Error("Non-current player cards must not run the active-turn animation");
  }
  await page.screenshot({ path: tableScreenshotPath, fullPage: true });
  await page.getByRole("button", { name: "Exit fullscreen" }).click();
  await page.waitForFunction(() => document.fullscreenElement === null);
  assertNoPageErrors();
  console.log(
    `UI browser verification: PASS (${playersScreenshotPath}, ${selectionScreenshotPath}, ${screenshotPath}, ${tableScreenshotPath})`,
  );
} finally {
  await browser.close();
}
