import { chromium } from "@playwright/test";

const baseUrl = process.env.APP_URL;
if (!baseUrl) {
  throw new Error("APP_URL is required, for example https://mbp16.tail102fab.ts.net");
}

const playlist = {
  id: "session-verification-playlist",
  title: "Session verification",
  itemCount: 2,
  thumbnailUrl: null,
};
const playerNames = Array.from(
  { length: 11 },
  (_, index) => `Session Player ${String(index + 1).padStart(2, "0")}`,
);
const screenshotPath = process.env.SESSION_SCREENSHOT ?? "/tmp/mafia-session-restored.png";
const browser = await chromium.launch({ channel: "chrome", headless: true });

const createContext = async () => {
  const context = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  await context.addInitScript(() => {
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
  await context.route("**/api/music/oauth/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        configured: true,
        connected: true,
        accountLabel: "session-verification@example.test",
      }),
    });
  });
  await context.route("**/api/music/playlists", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ playlists: [playlist] }),
    });
  });
  return context;
};

try {
  const firstContext = await createContext();
  const players = [];
  for (const nickname of playerNames) {
    const response = await firstContext.request.post(`${baseUrl}/api/players`, {
      data: {
        nickname,
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
      },
    });
    if (!response.ok()) throw new Error(`Unable to create ${nickname}`);
    const { player } = await response.json();
    players.push(player);
  }

  const firstPage = await firstContext.newPage();
  await firstPage.goto(baseUrl, { waitUntil: "networkidle" });
  await firstPage.getByLabel("Host player").selectOption(players[10].id);
  const playerSelectors = firstPage.locator(".player-input-grid select");
  for (let index = 0; index < 10; index += 1) {
    await playerSelectors.nth(index).selectOption(players[index].id);
  }
  await firstPage.getByRole("button", { name: "Continue to music" }).click();
  await firstPage.getByLabel("YouTube Music playlist").selectOption(playlist.id);
  await firstPage.getByText("Ready · paused").waitFor();
  await firstPage.getByRole("button", { name: "Start · fade in" }).click();
  await firstPage.getByText("Playing", { exact: true }).waitFor();
  await firstPage.getByRole("button", { name: "Continue to role draw" }).click();
  for (const player of players.slice(0, 10)) {
    await firstPage
      .getByRole("button", { name: `Draw role for ${player.nickname}`, exact: true })
      .click();
  }
  await firstPage.getByRole("button", { name: "Begin Mafia negotiation" }).click();
  await firstPage.getByRole("button", { name: "Continue to Sheriff wake-up" }).click();
  await firstPage.getByRole("button", { name: "Begin day one" }).click();
  await firstPage.getByText("Saved", { exact: true }).waitFor();
  const turnSave = firstPage.waitForResponse((response) => {
    if (
      response.request().method() !== "PUT" ||
      !new globalThis.URL(response.url()).pathname.startsWith("/api/game-sessions/")
    ) {
      return false;
    }
    const request = response.request().postDataJSON();
    return request.state?.log?.at(-1)?.type === "turn.completed";
  });
  await firstPage.getByRole("button", { name: "Next player" }).click();
  if (!(await turnSave).ok()) throw new Error("The state-changing turn was not persisted");
  await firstPage.getByText("Saved", { exact: true }).waitFor();

  const activeResponse = await firstContext.request.get(`${baseUrl}/api/game-sessions`);
  if (!activeResponse.ok()) throw new Error("Active session listing failed");
  const { sessions } = await activeResponse.json();
  if (!Array.isArray(sessions) || sessions.length !== 1) {
    throw new Error("Expected exactly one active server session before restart");
  }
  const gameId = sessions[0].gameId;
  const storedResponse = await firstContext.request.get(`${baseUrl}/api/game-sessions/${gameId}`);
  const { session: storedSession } = await storedResponse.json();
  if (
    storedSession.state.hostPlayerId !== players[10].id ||
    storedSession.state.hostName !== players[10].nickname ||
    storedSession.state.playlistId !== playlist.id ||
    storedSession.state.game?.phase !== "day" ||
    storedSession.state.game?.currentTurnIndex !== 1 ||
    storedSession.state.undoHistory.length !== 1 ||
    !storedSession.state.log.some(({ type }) => type === "turn.completed")
  ) {
    throw new Error("The authoritative server session is not fully restorable");
  }
  await firstContext.close();

  const restartedContext = await createContext();
  const restartedPage = await restartedContext.newPage();
  await restartedPage.goto(baseUrl, { waitUntil: "networkidle" });
  await restartedPage.getByRole("button", { name: "Resume Mafia table" }).click();
  await restartedPage.getByRole("heading", { name: "Day 1" }).waitFor();
  await restartedPage.getByRole("group", { name: `Host: ${players[10].nickname}` }).waitFor();
  await restartedPage.getByRole("button", { name: /undo last action.*1 available/i }).waitFor();
  await restartedPage.locator(".game-log-drawer summary").click();
  await restartedPage.getByText("turn.completed", { exact: true }).waitFor();
  const restoredEnvelope = await restartedPage.evaluate(() => {
    const raw = window.sessionStorage.getItem("mafia-dashboard.game-session.v3");
    return raw === null ? null : JSON.parse(raw);
  });
  if (
    restoredEnvelope?.gameId !== gameId ||
    restoredEnvelope?.revision !== storedSession.revision ||
    restoredEnvelope?.outbox?.length !== 0
  ) {
    throw new Error("Resume did not reset durable client metadata to the server revision");
  }
  await restartedPage.screenshot({ path: screenshotPath, fullPage: true });

  restartedPage.once("dialog", (dialog) => dialog.accept());
  await restartedPage.getByRole("button", { name: "Clear game state" }).click();
  await restartedPage.getByRole("heading", { name: "Select 10 players + host" }).waitFor();
  const afterClear = await restartedContext.request.get(`${baseUrl}/api/game-sessions`);
  const clearedSessions = (await afterClear.json()).sessions;
  if (!Array.isArray(clearedSessions) || clearedSessions.length !== 0) {
    throw new Error("Cleared session remains active on the server");
  }
  const tombstoned = await restartedContext.request.get(`${baseUrl}/api/game-sessions/${gameId}`);
  if (tombstoned.status() !== 404) throw new Error("Cleared session remains server-restorable");
  const remainingEnvelope = await restartedPage.evaluate(() =>
    window.sessionStorage.getItem("mafia-dashboard.game-session.v3"),
  );
  if (remainingEnvelope !== null) throw new Error("Cleared session remains in the client outbox");
  await restartedContext.close();

  console.log(`Authoritative session restart verification: PASS (${screenshotPath})`);
} finally {
  await browser.close();
}
