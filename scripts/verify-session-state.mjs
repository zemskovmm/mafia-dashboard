import { chromium } from "@playwright/test";

const baseUrl = process.env.APP_URL;
if (!baseUrl) {
  throw new Error("APP_URL is required, for example https://mbp16.tail102fab.ts.net");
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });

try {
  const playlistResponse = await page.request.get(`${baseUrl}/api/music/playlists`);
  if (!playlistResponse.ok()) throw new Error("Playlist endpoint failed");
  const { playlists } = await playlistResponse.json();
  if (!Array.isArray(playlists) || playlists.length === 0) {
    throw new Error("The connected account returned no playlists");
  }

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const playerSelectors = page.locator(".player-input-grid select");
  const playerIds = await playerSelectors
    .first()
    .locator("option:not([value=''])")
    .evaluateAll((options) => options.slice(0, 10).map((option) => option.value));
  if (playerIds.length !== 10) throw new Error("At least ten saved players are required");

  for (let index = 0; index < playerIds.length; index += 1) {
    await playerSelectors.nth(index).selectOption(playerIds[index]);
  }
  await page.getByRole("button", { name: "Continue to music" }).click();
  const playlistSelector = page.getByLabel("YouTube Music playlist");
  await playlistSelector.waitFor();
  await playlistSelector.selectOption(playlists[0].id);

  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Start table music" }).waitFor();
  await page.getByText(/^Connected as /).waitFor();
  const restoredPlaylist = page.getByLabel("YouTube Music playlist");
  await restoredPlaylist.waitFor();
  if ((await restoredPlaylist.inputValue()) !== playlists[0].id) {
    throw new Error("Selected playlist was not restored after reload");
  }
  const restoredSeats = await page
    .locator(".player-input-grid select")
    .evaluateAll((selectors) => selectors.map((selector) => selector.value));
  if (restoredSeats.length !== 0) {
    throw new Error(
      "Player selectors should not be rendered while the restored wizard is on music",
    );
  }

  const screenshotPath = process.env.SESSION_SCREENSHOT ?? "/tmp/mafia-session-restored.png";
  await page.screenshot({ path: screenshotPath, fullPage: true });

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Clear game state" }).click();
  await page.getByRole("heading", { name: "Select 10 players" }).waitFor();
  const stored = await page.evaluate(() =>
    window.sessionStorage.getItem("mafia-dashboard.game-session.v1"),
  );
  if (stored !== null) throw new Error("Session snapshot still exists after clearing game state");

  console.log(`Session-state verification: PASS (${screenshotPath})`);
} finally {
  await browser.close();
}
