/* global document, getComputedStyle, HTMLElement, HTMLSelectElement, innerHeight, innerWidth */
import { chromium, webkit } from "@playwright/test";

const baseUrl = process.env.APP_URL ?? "http://127.0.0.1:8080";
const screenshotPath = process.env.UI_SCREENSHOT ?? "/tmp/mafia-dashboard-setup.png";
const tableScreenshotPath = process.env.UI_TABLE_SCREENSHOT ?? "/tmp/mafia-dashboard-table.png";
const playersScreenshotPath =
  process.env.UI_PLAYERS_SCREENSHOT ?? "/tmp/mafia-dashboard-players.png";
const selectionScreenshotPath =
  process.env.UI_SELECTION_SCREENSHOT ?? "/tmp/mafia-dashboard-player-selection.png";
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
const browserName = process.env.UI_BROWSER ?? "chromium";
const viewportWidth = Number(process.env.UI_VIEWPORT_WIDTH ?? "");
const viewportHeight = Number(process.env.UI_VIEWPORT_HEIGHT ?? "");
const headerOnly = process.env.UI_HEADER_ONLY === "1";
const browser =
  browserName === "webkit"
    ? await webkit.launch({ headless: true })
    : await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({
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
page.on("console", (message) =>
  console.log(`browser console [${message.type()}]: ${message.text()}`),
);
page.on("pageerror", (error) => console.error(`browser page error: ${error.message}`));

await page.route("**/api/music/oauth/status", async (route) => {
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ configured: true, connected: true, accountLabel: "ui@example.com" }),
  });
});
await page.route("**/api/music/playlists", async (route) => {
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      playlists: [{ id: "test-playlist", title: "UI Verification", itemCount: 12 }],
    }),
  });
});
await page.route("**/api/players", async (route) => {
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ players: testPlayers }),
  });
});
await page.route("**/api/game-sessions", async (route) => {
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ sessions: [] }),
  });
});
await page.route("**/api/game-sessions/*", async (route) => {
  const request = route.request();
  if (request.method() === "DELETE") {
    await route.fulfill({ status: 204, body: "" });
    return;
  }
  if (request.method() !== "PUT") {
    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    return;
  }
  const mutation = request.postDataJSON();
  const gameId = new globalThis.URL(request.url()).pathname.split("/").at(-1);
  await route.fulfill({
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
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  if ((await page.title()) !== "Mafia Dashboard") throw new Error("Unexpected page title");
  await page.getByRole("button", { name: "Players & statistics" }).click();
  await page.getByRole("heading", { name: "Players & statistics" }).waitFor();
  await page.getByRole("article", { name: "Player UI Player 1", exact: true }).waitFor();
  await page.screenshot({ path: playersScreenshotPath, fullPage: true });
  await page.getByRole("button", { name: "Game setup" }).click();
  await page.getByRole("heading", { name: "Select 10 players + host" }).waitFor();
  await page.getByLabel("Host player").selectOption({ label: testNicknames[10] });
  const playerSelectors = page.locator(".player-input-grid select");
  if ((await playerSelectors.count()) !== 10) throw new Error("Expected ten player selectors");
  await page.getByRole("button", { name: "Randomly fill 10 seats" }).click();
  const selectedPlayers = await playerSelectors.evaluateAll((selectors) =>
    selectors.map((selector) => {
      if (!(selector instanceof HTMLSelectElement)) throw new Error("Expected player selector");
      return {
        id: selector.value,
        nickname: selector.options[selector.selectedIndex]?.textContent ?? "",
      };
    }),
  );
  if (
    new Set(selectedPlayers.map(({ id }) => id)).size !== 10 ||
    selectedPlayers.some(({ id }) => id === testPlayers[10].id)
  ) {
    throw new Error("Random fill must select ten unique non-host players");
  }
  await page.screenshot({ path: selectionScreenshotPath, fullPage: true });
  await page.getByRole("button", { name: "Continue to music" }).click();
  await page.getByRole("heading", { name: "Start table music" }).waitFor();
  if (await page.getByRole("button", { name: "Continue to role draw" }).isEnabled()) {
    throw new Error("Role draw must remain gated while YouTube is not playing");
  }
  await page.screenshot({ path: screenshotPath, fullPage: true });

  await page.evaluate(() => {
    class FakeYouTubePlayer {
      constructor(_elementId, options) {
        this.options = options;
        this.volume = 65;
        setTimeout(() => options.events?.onReady?.({ target: this }), 0);
      }
      playVideo() {
        this.options.events?.onStateChange?.({ target: this, data: 1 });
      }
      pauseVideo() {
        this.options.events?.onStateChange?.({ target: this, data: 2 });
      }
      setVolume(volume) {
        this.volume = volume;
      }
      getVolume() {
        return this.volume;
      }
      destroy() {}
    }
    window.YT = {
      Player: FakeYouTubePlayer,
      PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0, BUFFERING: 3 },
    };
  });
  await page.getByLabel("YouTube Music playlist").selectOption("test-playlist");
  await page.getByText("Ready · paused").waitFor();
  await page.getByRole("button", { name: "Start · fade in" }).click();
  await page.getByText("Playing", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Continue to role draw" }).click();

  for (const { nickname } of selectedPlayers) {
    await page.getByRole("button", { name: `Draw role for ${nickname}`, exact: true }).click();
  }
  await page.getByRole("button", { name: "Begin Mafia negotiation" }).click();
  await page.getByRole("heading", { name: "Mafia negotiation" }).waitFor();
  if (headerOnly) {
    await page.getByRole("button", { name: "Continue to Sheriff wake-up" }).click();
    await page.getByRole("button", { name: "Begin day one" }).click();
    const firstPlayer = selectedPlayers[0]?.nickname;
    const secondPlayer = selectedPlayers[1]?.nickname;
    if (firstPlayer === undefined || secondPlayer === undefined) {
      throw new Error("Phone verification requires the first two selected players");
    }
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
    if (phoneGeometry.seatActionButtons.length < 27) {
      throw new Error("Phone fallback must expose foul, red-card, and nomination controls");
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
    const tableBox = table.getBoundingClientRect();
    const tableCenter = {
      x: tableBox.left + tableBox.width / 2,
      y: tableBox.top + tableBox.height / 2,
    };
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
        radius: Math.hypot(
          box.left + box.width / 2 - tableCenter.x,
          box.top + box.height / 2 - tableCenter.y,
        ),
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
      phaseBannerObstructionCount: phaseBannerObstructions.length,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
    };
  });
  if (geometry.cards.length !== 11) throw new Error("Expected ten player cards and one host card");
  const [referenceCard] = geometry.cards;
  if (referenceCard === undefined) throw new Error("Expected table cards");
  for (const card of geometry.cards) {
    if (Math.abs(card.width - referenceCard.width) > 0.5) {
      throw new Error(`Card width mismatch for ${card.label ?? "unknown"}`);
    }
    if (Math.abs(card.height - referenceCard.height) > 0.5) {
      throw new Error(`Card height mismatch for ${card.label ?? "unknown"}`);
    }
    if (Math.abs(card.radius - referenceCard.radius) > 1) {
      throw new Error(`Card radius mismatch for ${card.label ?? "unknown"}`);
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
    await page.getByRole("button", { name: `Start ${seconds} second timer` }).waitFor();
  }
  await page.getByRole("button", { name: "Stop timer" }).waitFor();
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
  console.log(
    `UI browser verification: PASS (${playersScreenshotPath}, ${selectionScreenshotPath}, ${screenshotPath}, ${tableScreenshotPath})`,
  );
} finally {
  await browser.close();
}
