import { chromium } from "@playwright/test";

const baseUrl = process.env.APP_URL ?? "http://127.0.0.1:8080";
const screenshotPath = process.env.UI_SCREENSHOT ?? "/tmp/mafia-dashboard-setup.png";
const tableScreenshotPath = process.env.UI_TABLE_SCREENSHOT ?? "/tmp/mafia-dashboard-table.png";
const playersScreenshotPath =
  process.env.UI_PLAYERS_SCREENSHOT ?? "/tmp/mafia-dashboard-players.png";
const selectionScreenshotPath =
  process.env.UI_SELECTION_SCREENSHOT ?? "/tmp/mafia-dashboard-player-selection.png";
const testNicknames = Array.from({ length: 10 }, (_, index) => `UI Player ${index + 1}`);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
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

try {
  const existingResponse = await page.request.get(`${baseUrl}/api/players`);
  if (!existingResponse.ok()) throw new Error("Unable to load player profiles for UI verification");
  const existingPlayers = (await existingResponse.json()).players;
  const existingNicknames = new Set(existingPlayers.map(({ nickname }) => nickname));
  for (const nickname of testNicknames) {
    if (existingNicknames.has(nickname)) continue;
    const created = await page.request.post(`${baseUrl}/api/players`, {
      data: {
        nickname,
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
      },
    });
    if (!created.ok()) throw new Error(`Unable to create UI profile ${nickname}`);
  }

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  if ((await page.title()) !== "Mafia Dashboard") throw new Error("Unexpected page title");
  await page.getByRole("button", { name: "Players & statistics" }).click();
  await page.getByRole("heading", { name: "Players & statistics" }).waitFor();
  await page.getByRole("article", { name: "Player UI Player 1", exact: true }).waitFor();
  await page.screenshot({ path: playersScreenshotPath, fullPage: true });
  await page.getByRole("button", { name: "Game setup" }).click();
  await page.getByRole("heading", { name: "Select 10 players" }).waitFor();
  const playerSelectors = page.locator(".player-input-grid select");
  if ((await playerSelectors.count()) !== 10) throw new Error("Expected ten player selectors");

  for (let index = 0; index < 10; index += 1) {
    await playerSelectors.nth(index).selectOption({ label: testNicknames[index] });
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
      cuePlaylist() {}
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

  for (let seat = 1; seat <= 10; seat += 1) {
    await page
      .getByRole("button", { name: `Draw role for ${testNicknames[seat - 1]}`, exact: true })
      .click();
  }
  await page.getByRole("button", { name: "Begin Mafia negotiation" }).click();
  await page.getByRole("heading", { name: "Mafia negotiation" }).waitFor();
  if ((await page.locator(".player-seat").count()) !== 10) {
    throw new Error("Expected ten player seats on the live table");
  }
  await page.getByText("Host", { exact: true }).waitFor();
  const hostBox = await page.locator(".host-seat").boundingBox();
  const seatBoxes = await page.locator(".player-seat").evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return {
        label: element.getAttribute("aria-label"),
        centerX: box.left + box.width / 2,
        centerY: box.top + box.height / 2,
      };
    }),
  );
  if (hostBox === null) throw new Error("Expected a visible host position");
  const hostCenter = {
    x: hostBox.x + hostBox.width / 2,
    y: hostBox.y + hostBox.height / 2,
  };
  const closestSeatLeftOfHost = seatBoxes
    .filter((seat) => seat.centerX < hostCenter.x)
    .sort(
      (left, right) =>
        Math.hypot(left.centerX - hostCenter.x, left.centerY - hostCenter.y) -
        Math.hypot(right.centerX - hostCenter.x, right.centerY - hostCenter.y),
    )[0];
  if (!closestSeatLeftOfHost?.label?.startsWith("Seat 1:")) {
    throw new Error(
      `Expected seat 1 immediately left of host, found ${closestSeatLeftOfHost?.label ?? "none"}`,
    );
  }
  for (const seconds of [60, 30, 10]) {
    await page.getByRole("button", { name: `Start ${seconds} second timer` }).waitFor();
  }
  await page.getByRole("button", { name: "Music fade in" }).waitFor();
  await page.getByRole("button", { name: "Quick music fade out" }).waitFor();
  await page.getByRole("button", { name: "Slow music fade out" }).waitFor();
  await page.screenshot({ path: tableScreenshotPath, fullPage: true });
  console.log(
    `UI browser verification: PASS (${playersScreenshotPath}, ${selectionScreenshotPath}, ${screenshotPath}, ${tableScreenshotPath})`,
  );
} finally {
  await browser.close();
}
