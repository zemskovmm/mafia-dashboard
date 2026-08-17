import { chromium } from "@playwright/test";

const baseUrl = process.env.APP_URL ?? "http://127.0.0.1:8080";
const screenshotPath = process.env.UI_SCREENSHOT ?? "/tmp/mafia-dashboard-setup.png";
const tableScreenshotPath = process.env.UI_TABLE_SCREENSHOT ?? "/tmp/mafia-dashboard-table.png";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("console", (message) =>
  console.log(`browser console [${message.type()}]: ${message.text()}`),
);
page.on("pageerror", (error) => console.error(`browser page error: ${error.message}`));

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  if ((await page.title()) !== "Mafia Dashboard") throw new Error("Unexpected page title");
  await page.getByRole("heading", { name: "Select 10 players" }).waitFor();
  const playerInputs = page.locator(".player-input-grid input");
  if ((await playerInputs.count()) !== 10) throw new Error("Expected ten player inputs");

  for (let index = 0; index < 10; index += 1) {
    await playerInputs.nth(index).fill(`Player ${index + 1}`);
  }
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
  await page.getByLabel("YouTube playlist ID").fill("test-playlist");
  await page.getByText("Ready · paused").waitFor();
  await page.getByRole("button", { name: "Start · fade in" }).click();
  await page.getByText("Playing", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Continue to role draw" }).click();

  for (let seat = 1; seat <= 10; seat += 1) {
    await page.getByRole("button", { name: `Draw role for Player ${seat}`, exact: true }).click();
  }
  await page.getByRole("button", { name: "Begin Mafia negotiation" }).click();
  await page.getByRole("heading", { name: "Mafia negotiation" }).waitFor();
  if ((await page.locator(".player-seat").count()) !== 10) {
    throw new Error("Expected ten player seats on the live table");
  }
  await page.getByText("Host", { exact: true }).waitFor();
  for (const seconds of [60, 30, 10]) {
    await page.getByRole("button", { name: `Start ${seconds} second timer` }).waitFor();
  }
  await page.getByRole("button", { name: "Music fade in" }).waitFor();
  await page.getByRole("button", { name: "Quick music fade out" }).waitFor();
  await page.getByRole("button", { name: "Slow music fade out" }).waitFor();
  await page.screenshot({ path: tableScreenshotPath, fullPage: true });
  console.log(`UI browser verification: PASS (${screenshotPath}, ${tableScreenshotPath})`);
} finally {
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await browser.close();
}
