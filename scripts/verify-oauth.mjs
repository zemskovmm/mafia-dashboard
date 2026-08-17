import { chromium } from "@playwright/test";

const baseUrl = process.env.APP_URL;
if (!baseUrl) {
  throw new Error("APP_URL is required, for example https://mbp16.tail102fab.ts.net");
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

try {
  const statusResponse = await page.request.get(`${baseUrl}/api/music/oauth/status`);
  if (!statusResponse.ok()) throw new Error("OAuth status endpoint failed");
  const status = await statusResponse.json();
  if (!status.configured || !status.connected || !status.accountLabel) {
    throw new Error("YouTube Music account is not connected");
  }

  const playlistResponse = await page.request.get(`${baseUrl}/api/music/playlists`);
  if (!playlistResponse.ok()) throw new Error("Playlist endpoint failed");
  const { playlists } = await playlistResponse.json();
  if (!Array.isArray(playlists) || playlists.length === 0) {
    throw new Error("The connected account returned no playlists");
  }

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const playerSelectors = page.locator(".player-input-grid select");
  if ((await playerSelectors.count()) !== 10) throw new Error("Expected ten player selectors");

  const playerIds = await playerSelectors
    .first()
    .locator("option:not([value=''])")
    .evaluateAll((options) => options.slice(0, 10).map((option) => option.value));
  if (playerIds.length !== 10) throw new Error("At least ten saved players are required");

  for (let index = 0; index < playerIds.length; index += 1) {
    await playerSelectors.nth(index).selectOption(playerIds[index]);
  }

  await page.getByRole("button", { name: "Continue to music" }).click();
  await page.getByRole("heading", { name: "Start table music" }).waitFor();
  await page.getByText(/^Connected as /).waitFor();

  const playlistSelector = page.getByLabel("YouTube Music playlist");
  await playlistSelector.waitFor();
  if ((await playlistSelector.locator("option:not([value=''])").count()) !== playlists.length) {
    throw new Error("Playlist picker does not match the account playlist response");
  }
  await playlistSelector.selectOption(playlists[0].id);
  if ((await playlistSelector.inputValue()) !== playlists[0].id) {
    throw new Error("Playlist selection did not persist in the setup form");
  }
  await page.getByText("Ready · paused").waitFor({ timeout: 20_000 });

  const screenshotPath = process.env.OAUTH_SCREENSHOT ?? "/tmp/mafia-dashboard-oauth.png";
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`OAuth verification: PASS (${playlists.length} playlists, ${screenshotPath})`);
} finally {
  await browser.close();
}
