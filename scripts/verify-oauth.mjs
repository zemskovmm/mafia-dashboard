/* global URL */
import { chromium } from "@playwright/test";
import {
  assertExactOrigin,
  assertVerifierTarget,
  classifyReadOnlyVerifierRequest,
  isExactPlaylistSelectionRequest,
  parseVerifierAuthCookie,
  parseVerifierClubId,
} from "./session-verifier-contracts.mjs";

const configuredUrl = process.env.APP_URL;
if (!configuredUrl) throw new Error("APP_URL is required");
const targetUrl = new URL(configuredUrl);
const expectedOrigin = process.env.SESSION_VERIFY_EXPECTED_ORIGIN?.trim();
assertVerifierTarget({
  configuredUrl,
  browserUrl: configuredUrl,
  remoteAllowed: process.env.SESSION_VERIFY_ALLOW_REMOTE === "1",
  expectedOrigin,
});
const authCookie = parseVerifierAuthCookie(process.env.SESSION_AUTH_COOKIE, { required: true });
const clubId = parseVerifierClubId(process.env.SESSION_CLUB_ID);
const apiHeaders = { "x-club-id": clubId };

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  locale: "en-US",
});
await context.addCookies([
  {
    ...authCookie,
    url: targetUrl.origin,
    httpOnly: true,
    secure: targetUrl.protocol === "https:",
    sameSite: "Lax",
  },
]);
const page = await context.newPage();
const requestErrors = [];
await context.route("**/*", async (route) => {
  try {
    const request = route.request();
    const classification = classifyReadOnlyVerifierRequest({
      method: request.method(),
      url: request.url(),
      expectedOrigin: targetUrl.origin,
    });
    await route.continue(
      classification.kind === "same-origin-api"
        ? { headers: { ...request.headers(), ...apiHeaders } }
        : undefined,
    );
  } catch (error) {
    requestErrors.push(error instanceof Error ? error : new Error(String(error)));
    await route.abort("blockedbyclient");
  }
});

const apiGet = async (pathname, label) => {
  const url = new URL(pathname, targetUrl.origin);
  assertExactOrigin(url, targetUrl.origin);
  const response = await context.request.get(url.href, {
    headers: apiHeaders,
    maxRedirects: 0,
  });
  if (!response.ok()) throw new Error(`${label} failed with HTTP ${response.status()}`);
  return response.json();
};

try {
  const auth = await apiGet("/api/auth/session", "Authentication preflight");
  if (auth.user == null) throw new Error("SESSION_AUTH_COOKIE is not authenticated");

  const { clubs } = await apiGet("/api/clubs", "Club preflight");
  const selectedClub = clubs?.find(({ id }) => id.toLowerCase() === clubId);
  if (selectedClub === undefined) throw new Error("SESSION_CLUB_ID is not accessible to this user");
  if (selectedClub.role !== "manager") {
    throw new Error("OAuth verification requires club manager access");
  }

  const { players } = await apiGet("/api/players", "Player preflight");
  const playerIds = players?.slice(0, 10).map(({ id }) => id);
  if (!Array.isArray(playerIds) || playerIds.length !== 10) {
    throw new Error("OAuth verification requires at least ten saved club players");
  }

  const status = await apiGet("/api/music/oauth/status", "OAuth status preflight");
  if (!status.configured || !status.connected || !status.accountLabel) {
    throw new Error("YouTube Music account is not connected");
  }
  const { playlists } = await apiGet("/api/music/playlists", "Playlist preflight");
  if (!Array.isArray(playlists) || playlists.length === 0 || !playlists[0]?.id) {
    throw new Error("The connected account returned no playlists");
  }
  const { items } = await apiGet(
    `/api/music/playlists/${encodeURIComponent(playlists[0].id)}/items`,
    "Playlist-item preflight",
  );
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("The selected account playlist returned no playable items");
  }

  await page.goto(targetUrl.href, { waitUntil: "networkidle" });
  assertExactOrigin(page.url(), targetUrl.origin);
  const clubPortal = page.getByRole("heading", { name: "Choose your club" });
  await clubPortal.waitFor();
  await page
    .getByRole("button", {
      name: `Open ${selectedClub.name} in ${selectedClub.city}`,
      exact: true,
    })
    .click();
  const labels =
    selectedClub.language === "ru"
      ? {
          openManageMenu: "Открыть меню управления",
          musicPlayerSetup: "Настройка музыкального плеера",
          connectedAccount: /^Подключено: /,
          playlist: "Плейлист YouTube Music",
          playlistRequired: "Нужен плейлист",
        }
      : {
          openManageMenu: "Open Manage menu",
          musicPlayerSetup: "Music player setup",
          connectedAccount: /^Connected as /,
          playlist: "YouTube Music playlist",
          playlistRequired: "Playlist required",
        };
  await page.getByRole("button", { name: labels.openManageMenu, exact: true }).click();
  await page.getByRole("button", { name: labels.musicPlayerSetup, exact: true }).click();
  await page.getByText(labels.connectedAccount).waitFor();
  const playlistSelector = page.getByLabel(labels.playlist);
  await playlistSelector.waitFor();
  if ((await playlistSelector.locator("option:not([value=''])").count()) !== playlists.length) {
    throw new Error("Playlist picker does not match the account playlist response");
  }
  if ((await playlistSelector.inputValue()) === playlists[0].id) {
    await playlistSelector.selectOption("");
  }
  await page.getByText(labels.playlistRequired, { exact: true }).waitFor();
  const expectedItemsPath = `/api/music/playlists/${encodeURIComponent(playlists[0].id)}/items`;
  const itemsRequestPromise = page.waitForRequest(async (request) =>
    isExactPlaylistSelectionRequest({
      method: request.method(),
      url: request.url(),
      expectedOrigin: targetUrl.origin,
      expectedPath: expectedItemsPath,
      selectedPlaylistId: await playlistSelector.inputValue(),
      expectedPlaylistId: playlists[0].id,
    }),
  );
  await playlistSelector.selectOption(playlists[0].id);
  const itemsRequest = await itemsRequestPromise;
  const itemsResponse = await itemsRequest.response();
  if (itemsResponse === null || !itemsResponse.ok()) {
    throw new Error("Playlist UI item request failed");
  }
  if ((await itemsResponse.finished()) !== null) {
    throw new Error("Playlist UI item response did not finish");
  }
  if ((await playlistSelector.inputValue()) !== playlists[0].id) {
    throw new Error("Playlist selection did not persist in the setup form");
  }
  await page.waitForLoadState("networkidle");
  if (requestErrors.length > 0) throw new AggregateError(requestErrors, "Unsafe request blocked");

  console.log(
    `OAuth verification: PASS (${playlists.length} playlists, ${items.length} selected items)`,
  );
} finally {
  await context.close();
  await browser.close();
}
