/* global FormData, fetch */
import { Blob } from "node:buffer";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { chromium, webkit } from "@playwright/test";

const baseUrl = process.env.APP_URL;
const sources = [process.env.DJ_TRACK_ONE, process.env.DJ_TRACK_TWO];
if (!baseUrl || sources.some((source) => !source)) {
  throw new Error("APP_URL, DJ_TRACK_ONE, and DJ_TRACK_TWO are required");
}

const uploaded = [];
const forbiddenSessionStateKey =
  /^(musicSource|localDjSession|queueIds|currentStartSeconds|nextStartSeconds|crossfadeSeconds|playedSeconds|activeDeck|musicState|playbackState|isPlaying)$/i;
const forbiddenSessionStateConcept = /(queue|cue|crossfade|playback)/i;
const forbiddenSessionStorageKey =
  /(musicSource|localDjSession|queueIds|currentStartSeconds|nextStartSeconds|crossfadeSeconds|playedSeconds|activeDeck|musicState|playbackState|isPlaying|queue|cue|crossfade|playback)/i;
const findForbiddenStatePaths = (value, path = "state") => {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed === value ? [] : findForbiddenStatePaths(parsed, `${path}<json>`);
    } catch {
      return [];
    }
  }
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findForbiddenStatePaths(item, `${path}[${index}]`));
  }
  return Object.entries(value).flatMap(([key, nested]) => [
    ...(forbiddenSessionStateKey.test(key) || forbiddenSessionStateConcept.test(key)
      ? [`${path}.${key}`]
      : []),
    ...findForbiddenStatePaths(nested, `${path}.${key}`),
  ]);
};
const assertNoDjSessionState = (value, source) => {
  const forbiddenPaths = findForbiddenStatePaths(value);
  if (forbiddenPaths.length > 0) {
    throw new Error(`${source} leaked DJ-only state: ${forbiddenPaths.join(", ")}`);
  }
};
const inspectSessionStorage = (entries) => {
  for (const [key, rawValue] of entries) {
    if (forbiddenSessionStorageKey.test(key)) {
      throw new Error(`sessionStorage key leaked DJ-only state: ${key}`);
    }
    let value = rawValue;
    try {
      value = JSON.parse(rawValue);
    } catch {
      // Non-JSON values have no nested state keys to inspect.
    }
    assertNoDjSessionState(value, `sessionStorage[${JSON.stringify(key)}]`);
  }
};
const getJson = async (url, description) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${description} failed with HTTP ${response.status}`);
  return response.json();
};
const getAuthoritativeAggregate = async (gameId) => {
  const body = await getJson(
    `${baseUrl}/api/game-sessions/${gameId}`,
    "Authoritative session lookup",
  );
  if (body.session?.state === undefined || typeof body.session.revision !== "number") {
    throw new Error("Server authoritative session state or revision is missing");
  }
  return { state: body.session.state, revision: body.session.revision };
};
const upload = async (path, title) => {
  const form = new FormData();
  form.append("title", title);
  form.append("file", new Blob([await readFile(path)], { type: "audio/mpeg" }), basename(path));
  const response = await fetch(`${baseUrl}/api/music/tracks`, { method: "POST", body: form });
  if (!response.ok) throw new Error(`Track upload failed with HTTP ${response.status}`);
  const { track } = await response.json();
  uploaded.push(track);
  if (track.waveform.length !== 720 || track.durationSeconds <= 0) {
    throw new Error("Uploaded track did not receive duration and a 720-point waveform");
  }
  if (Math.max(...track.waveform) <= Math.min(...track.waveform)) {
    throw new Error("Generated waveform is flat");
  }
  return track;
};

let browser;
let verificationGameId = null;
let verificationError = null;
let verificationSummary = null;
try {
  const opening = await upload(sources[0], "Verification Opening");
  const night = await upload(sources[1], "Verification Night");
  const closing = await upload(sources[0], "Verification Closing");
  const range = await fetch(`${baseUrl}${opening.audioUrl}`, {
    headers: { range: "bytes=0-99" },
  });
  if (range.status !== 206 || (await range.arrayBuffer()).byteLength !== 100) {
    throw new Error("Audio byte-range seeking contract failed");
  }
  const suffixRange = await fetch(`${baseUrl}${opening.audioUrl}`, {
    headers: { range: "bytes=-100" },
  });
  if (suffixRange.status !== 206 || (await suffixRange.arrayBuffer()).byteLength !== 100) {
    throw new Error("Audio suffix-range seeking contract failed");
  }

  const browserName = process.env.DJ_BROWSER ?? "chromium";
  browser =
    browserName === "webkit"
      ? await webkit.launch({ headless: true })
      : await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport:
      browserName === "webkit" ? { width: 1024, height: 768 } : { width: 1180, height: 920 },
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const navigationBox = await page.locator(".app-navigation").boundingBox();
  const activeSessionsBox = await page.locator("#active-game-sessions-title").boundingBox();
  if (
    navigationBox === null ||
    activeSessionsBox === null ||
    activeSessionsBox.y < navigationBox.y + navigationBox.height + 12
  ) {
    throw new Error("Application navigation overlaps the active-session panel");
  }
  const hostSelector = page.getByRole("combobox", { name: "Host player" });
  const availablePlayerIds = await hostSelector
    .locator("option:not([value=''])")
    .evaluateAll((options) => options.map((option) => option.value));
  if (availablePlayerIds.length < 11) throw new Error("At least eleven saved players are required");
  await hostSelector.selectOption(availablePlayerIds[10]);
  const playerSelectors = page.locator(".player-input-grid select");
  const playerIds = availablePlayerIds.slice(0, 10);
  for (let index = 0; index < playerIds.length; index += 1) {
    await playerSelectors.nth(index).selectOption(playerIds[index]);
  }
  await page.getByRole("button", { name: "Continue to music" }).click();
  await page.locator('.save-indicator[data-status="saved"]').waitFor();
  verificationGameId = await page.evaluate(() => {
    const raw = window.sessionStorage.getItem("mafia-dashboard.game-session.v3");
    if (raw === null) return null;
    const envelope = JSON.parse(raw);
    return typeof envelope.gameId === "string" ? envelope.gameId : null;
  });
  if (verificationGameId === null) throw new Error("Verification game session was not persisted");
  const authoritativeBeforeDj = await getAuthoritativeAggregate(verificationGameId);
  assertNoDjSessionState(
    authoritativeBeforeDj.state,
    "server authoritative state before DJ operations",
  );
  await page.getByRole("button", { name: "Local waveform DJ" }).click();
  await page.getByRole("heading", { name: `Current · ${opening.title}` }).waitFor();
  await page.getByRole("heading", { name: `Next · ${night.title}` }).waitFor();

  const currentCue = page.getByRole("slider", { name: "Current track start position" });
  const nextCue = page.getByRole("slider", { name: "Next track start position" });
  await currentCue.fill("12.5");
  await nextCue.fill("4.5");
  if ((await currentCue.inputValue()) !== "12.5" || (await nextCue.inputValue()) !== "4.5") {
    throw new Error("Cue-point controls did not retain their positions");
  }

  await page.getByLabel("Crossfade duration").selectOption("3");
  await page.getByRole("button", { name: "Start · fade in" }).click();
  await page.getByText(/^Playing$/).waitFor();
  await page.waitForTimeout(750);
  const deckTimes = await page
    .locator("audio")
    .evaluateAll((decks) =>
      decks.map((deck) => ({ currentTime: deck.currentTime, paused: deck.paused })),
    );
  if (!deckTimes.some(({ currentTime, paused }) => !paused && currentTime >= 12)) {
    throw new Error(`Current cue did not reach the active deck: ${JSON.stringify(deckTimes)}`);
  }
  try {
    await page
      .getByRole("heading", { name: `Current · ${night.title}` })
      .waitFor({ timeout: 8_000 });
  } catch (cause) {
    const diagnostics = await page.locator("audio").evaluateAll((decks) =>
      decks.map((deck) => ({
        currentTime: deck.currentTime,
        duration: deck.duration,
        paused: deck.paused,
        volume: deck.volume,
        error: deck.error?.code ?? null,
      })),
    );
    throw new Error(`Automatic crossfade failed: ${JSON.stringify(diagnostics)}`, { cause });
  }
  await page.getByRole("heading", { name: `Next · ${closing.title}` }).waitFor();
  await page.getByText(/^Playing$/).waitFor();
  const playerError = page.locator(".local-dj-player .queue-error");
  if ((await playerError.count()) > 0 && (await playerError.isVisible())) {
    throw new Error(
      `DJ player reported an error after automatic crossfade: ${await playerError.textContent()}`,
    );
  }

  const playerBox = await page.locator(".local-dj-player").boundingBox();
  const logBox = await page.locator(".game-log-drawer").boundingBox();
  if (playerBox !== null && logBox !== null) {
    const overlapsHorizontally =
      logBox.x < playerBox.x + playerBox.width && logBox.x + logBox.width > playerBox.x;
    const overlapsVertically =
      logBox.y < playerBox.y + playerBox.height && logBox.y + logBox.height > playerBox.y;
    if (overlapsHorizontally && overlapsVertically) {
      throw new Error("Game log overlaps the local DJ player");
    }
  }

  const screenshotPath = process.env.DJ_SCREENSHOT ?? "/tmp/mafia-dj-verification.png";
  await page.screenshot({ path: screenshotPath, fullPage: true });

  await page.getByRole("button", { name: `Crossfade to ${closing.title}` }).click();
  await page
    .getByRole("heading", { name: `Current · ${closing.title}` })
    .waitFor({ timeout: 8_000 });
  await page.getByText(/^Playing$/).waitFor();
  const sessionStorageEntries = await page.evaluate(() =>
    Array.from({ length: window.sessionStorage.length }, (_, index) => {
      const key = window.sessionStorage.key(index);
      return key === null ? null : [key, window.sessionStorage.getItem(key) ?? ""];
    }).filter((entry) => entry !== null),
  );
  inspectSessionStorage(sessionStorageEntries);
  const authoritativeAfterDj = await getAuthoritativeAggregate(verificationGameId);
  assertNoDjSessionState(
    authoritativeAfterDj.state,
    "server authoritative state after DJ operations",
  );
  if (!isDeepStrictEqual(authoritativeAfterDj, authoritativeBeforeDj)) {
    throw new Error(
      `DJ operations changed authoritative state/revision: before=${JSON.stringify(authoritativeBeforeDj)} after=${JSON.stringify(authoritativeAfterDj)}`,
    );
  }
  verificationSummary = `DJ verification: PASS (${uploaded.length} tracks, 720 peaks each, range seek, automatic + manual 3s crossfades, ${browserName}, ${screenshotPath})`;
} catch (error) {
  verificationError = error;
} finally {
  const cleanupErrors = [];
  try {
    await browser?.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  const cleanupUrls = [
    ...uploaded.map((track) => `${baseUrl}/api/music/tracks/${track.id}`),
    ...(verificationGameId === null ? [] : [`${baseUrl}/api/game-sessions/${verificationGameId}`]),
  ];
  await Promise.all(
    cleanupUrls.map(async (url) => {
      try {
        const response = await fetch(url, { method: "DELETE" });
        if (!response.ok) {
          cleanupErrors.push(new Error(`Cleanup ${url} failed with HTTP ${response.status}`));
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }),
  );
  try {
    const [trackList, sessionList] = await Promise.all([
      getJson(`${baseUrl}/api/music/tracks`, "Cleanup track-list readback"),
      getJson(`${baseUrl}/api/game-sessions`, "Cleanup session-list readback"),
    ]);
    if (!Array.isArray(trackList.tracks) || !Array.isArray(sessionList.sessions)) {
      cleanupErrors.push(new Error("Cleanup list readback returned an invalid resource shape"));
    } else {
      const uploadedIds = new Set(uploaded.map((track) => track.id));
      const remainingTrackIds = trackList.tracks
        .map((track) => track.id)
        .filter((id) => uploadedIds.has(id));
      if (remainingTrackIds.length > 0) {
        cleanupErrors.push(
          new Error(`Cleanup left uploaded tracks: ${remainingTrackIds.join(", ")}`),
        );
      }
      if (
        verificationGameId !== null &&
        sessionList.sessions.some((session) => session.gameId === verificationGameId)
      ) {
        cleanupErrors.push(
          new Error(`Cleanup left verification game session: ${verificationGameId}`),
        );
      }
    }
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    verificationError = new AggregateError(
      verificationError === null ? cleanupErrors : [verificationError, ...cleanupErrors],
      verificationError === null
        ? "DJ verification cleanup failed"
        : "DJ verification and cleanup failed",
    );
  }
}

if (verificationError !== null) throw verificationError;
if (verificationSummary === null) throw new Error("DJ verification did not complete");
console.log(verificationSummary);
