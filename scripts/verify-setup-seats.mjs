/* global URL, structuredClone, document, innerWidth, innerHeight, getComputedStyle */
/*
 * Focused real-app setup correction regression. Run against an owned local Vite
 * origin (APP_URL defaults to http://127.0.0.1:8080). Mock API is strict and
 * in-memory; this is browser/payload continuity evidence, not PostgreSQL proof.
 * Screenshots remain in the ignored repository .AI/ directory.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, webkit, expect } from "@playwright/test";
import { assertExactOrigin } from "./session-verifier-contracts.mjs";

const baseUrl = process.env.APP_URL ?? "http://127.0.0.1:8080";
const origin = new URL(baseUrl).origin;
assert.match(
  new URL(baseUrl).hostname,
  /^(localhost|127\.0\.0\.1|\[::1\])$/,
  "Use a local Vite origin",
);
const evidence = path.resolve(".AI/setup-seats");
const uuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const players = Array.from({ length: 11 }, (_, index) => ({
  id: uuid(index + 1),
  nickname: `UI Player ${index + 1}`,
  consent: false,
  firstName: null,
  lastName: null,
  email: null,
  consentAt: null,
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
  lastPlayedAt: null,
  statistics: Object.fromEntries(
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
    ].map((key) => [key, 0]),
  ),
}));
const labels = {
  en: {
    setup: "Select 10 players + host",
    select: "Select available players",
    assign: "Assign players",
    start: "Start game",
    back: "Player setup",
    role: "Role giveaway",
    clear: "Clear Seat 3",
    casper: "Include Casper",
  },
  ru: {
    setup: "Выберите 10 игроков и ведущего",
    select: "Выбрать доступных игроков",
    assign: "Рассадить игроков",
    start: "Начать игру",
    back: "Выбор игроков",
    role: "Раздача ролей",
    clear: "Очистить: Место 3",
    casper: "Добавить Каспера",
  },
};
const clone = (value) => structuredClone(value);

function fixture(page, language) {
  const errors = [];
  const writes = [];
  const sessions = new Map();
  let revision = 0;
  const club = {
    id: uuid(101),
    name: "Mafia Malaga",
    city: "Málaga",
    headerLogo: null,
    cardLogo: null,
    language,
    role: "manager",
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  };
  const json = (route, body, status = 200) => {
    assertExactOrigin(route.request().url(), origin);
    return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  };
  const fail = (route) => {
    const request = route.request();
    const label = `${request.method()} ${new URL(request.url()).pathname}${new URL(request.url()).search}`;
    errors.push(label);
    return json(route, { error: `Unexpected fixture request: ${label}` }, 500);
  };
  const save = (id, mutation) => {
    revision += 1;
    const state = clone(mutation.state);
    const session = {
      gameId: id,
      name: mutation.name,
      revision,
      duplicate: false,
      status: mutation.results === null ? "active" : "completed",
      hostPlayerId: state.hostPlayerId,
      hostName: state.hostName,
      phase:
        state.game?.phase ??
        (state.setup?.step === "roles"
          ? "setup-roles"
          : state.setup?.step === "music"
            ? "setup-music"
            : "setup-players"),
      day: state.game?.day ?? 0,
      updatedAt: "2026-08-18T00:00:00.000Z",
      state,
      results: mutation.results,
    };
    sessions.set(id, session);
    writes.push(clone(session));
    return session;
  };
  const routeReady = Promise.all([
    page.route("**/health/**", (route) => {
      const request = route.request();
      assertExactOrigin(request.url(), origin);
      const url = new URL(request.url());
      if (request.method() === "GET" && url.pathname === "/health/ready" && !url.search)
        return json(route, { status: "ready" });
      if (request.method() === "GET" && url.pathname === "/health/version" && !url.search)
        return json(route, { version: "1.0.0", commit: "setup-verifier" });
      return fail(route);
    }),
    page.route(
      (url) => url.pathname.startsWith("/api/"),
      async (route) => {
        const request = route.request();
        assertExactOrigin(request.url(), origin);
        const url = new URL(request.url());
        const { pathname, searchParams } = url;
        const method = request.method();
        if (method === "GET" && pathname === "/api/auth/session" && !url.search)
          return json(route, {
            configured: true,
            user: { id: uuid(1), email: "ui@example.com", name: "UI Verification", picture: null },
          });
        if (method === "GET" && pathname === "/api/clubs" && !url.search)
          return json(route, { clubs: [club] });
        if (method === "PUT" && pathname === `/api/clubs/${club.id}` && !url.search) {
          const update = request.postDataJSON();
          if (!["en", "ru"].includes(update.language)) return fail(route);
          club.language = update.language;
          return json(route, { club });
        }
        if (method === "GET" && pathname === "/api/players" && !url.search)
          return json(route, { players });
        if (method === "GET" && pathname === "/api/music/oauth/status" && !url.search)
          return json(route, { configured: true, connected: false, accountLabel: null });
        if (method === "GET" && pathname === "/api/music/playlists" && !url.search)
          return json(route, { playlists: [] });
        if (
          pathname === "/api/game-sessions" &&
          method === "GET" &&
          (!url.search || (searchParams.size === 1 && searchParams.has("status")))
        ) {
          const status = searchParams.get("status") ?? "active";
          if (!["active", "completed"].includes(status)) return fail(route);
          return json(route, {
            sessions: [...sessions.values()].filter((session) => session.status === status),
          });
        }
        if (pathname === "/api/game-sessions" && method === "POST" && !url.search) {
          const mutation = request.postDataJSON();
          if (
            typeof mutation.name !== "string" ||
            !mutation.state ||
            typeof mutation.creationId !== "string" ||
            !Object.hasOwn(mutation, "results")
          )
            return fail(route);
          return json(route, save(randomUUID(), mutation), 201);
        }
        const gameId = pathname.match(/^\/api\/game-sessions\/([0-9a-f-]{36})$/i)?.[1];
        if (gameId && !url.search) {
          if (method === "GET") {
            const session = sessions.get(gameId);
            return json(route, session ? { session } : {}, session ? 200 : 404);
          }
          if (method === "PUT") {
            const mutation = request.postDataJSON();
            if (
              typeof mutation.name !== "string" ||
              typeof mutation.mutationId !== "string" ||
              !mutation.state ||
              !Object.hasOwn(mutation.state, "game") ||
              !Object.hasOwn(mutation, "results") ||
              !sessions.has(gameId)
            )
              return fail(route);
            return json(route, save(gameId, mutation));
          }
        }
        return fail(route);
      },
    ),
  ]);
  return {
    errors,
    writes,
    sessions,
    routeReady,
    latest: () => writes.at(-1),
    ensureClean: () => assert.deepEqual(errors, [], "Unexpected API route(s)"),
  };
}

const seat = (page, n) => page.locator(`.setup-seat-card[data-setup-seat="${n}"]`);
const handle = (page, n) => seat(page, n).locator(".setup-seat-drag-handle");
const input = (page, n) => page.locator(`#seat-${n}-player`);
const roster = async (page) =>
  Promise.all(Array.from({ length: 10 }, (_, n) => input(page, n + 1).inputValue()));
const center = async (locator) => {
  const box = await locator.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, "Missing drag target geometry");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const onscreen = (page, point, label) => {
  const size = page.viewportSize();
  assert.ok(
    size && point.x >= 0 && point.y >= 0 && point.x < size.width && point.y < size.height,
    `${label} is outside the viewport: ${JSON.stringify(point)}`,
  );
};
const same = (actual, expected, label) => assert.deepEqual(actual, expected, label);
const awaitSave = async (page, state) => {
  await expect(page.locator('.save-indicator[data-status="saved"]')).toBeVisible();
  await expect
    .poll(() => state.latest()?.state.setup?.selectedPlayerIds, { timeout: 15000 })
    .not.toBeUndefined();
  state.ensureClean();
};
const snapshot = (state) => {
  const latest = state.latest();
  assert.ok(latest?.gameId && latest.state.setup, "Missing saved setup snapshot");
  return clone(latest);
};
const unchanged = (state, before, reason) => {
  const now = snapshot(state);
  assert.equal(now.gameId, before.gameId, `${reason}: game identity`);
  same(now.state.setup, before.state.setup, `${reason}: deal/roster changed`);
  for (const write of state.writes.slice(before.writeCount ?? state.writes.length)) {
    same(write.state.setup, before.state.setup, `${reason}: transient fixture write`);
  }
};
const checkpoint = (state) => ({ ...snapshot(state), writeCount: state.writes.length });

async function enterSetup(page) {
  await page
    .locator(".club-playing-card:not(.new-club-card), .players-shell, .player-setup-card")
    .first()
    .waitFor();
  const clubCard = page.locator(".club-card-open");
  if (await clubCard.isVisible()) await clubCard.first().click();
  await page.locator(".players-shell, .player-setup-card").first().waitFor();
  if (await page.locator(".players-shell").isVisible()) {
    await page.locator(".players-screen-header button").click();
  }
  await page.locator(".player-setup-card h1").waitFor();
}

async function dragMouse(page, from, to, final = "target", beforeRelease = async () => {}) {
  await handle(page, from).scrollIntoViewIfNeeded();
  if (to !== null) await seat(page, to).scrollIntoViewIfNeeded();
  const source = await center(handle(page, from));
  const destination =
    final === "target"
      ? await center(seat(page, to))
      : final === "same"
        ? await center(seat(page, from))
        : { x: Math.max(1, (await page.viewportSize()).width - 3), y: 3 };
  onscreen(page, source, "Mouse drag source");
  onscreen(page, destination, "Mouse drag destination");
  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  try {
    await page.mouse.move(destination.x, destination.y, { steps: 12 });
    await beforeRelease();
  } finally {
    await page.mouse.up();
  }
}

async function touch(page, cdp, from, to, cancel = false, beforeRelease = async () => {}) {
  await handle(page, from).scrollIntoViewIfNeeded();
  await seat(page, to).scrollIntoViewIfNeeded();
  const start = await center(handle(page, from));
  const end = await center(seat(page, to));
  onscreen(page, start, "CDP touch source");
  onscreen(page, end, "CDP touch destination");
  const point = (x, y) => [{ x, y, id: 1, radiusX: 1, radiusY: 1, force: 1 }];
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: point(start.x, start.y),
  });
  try {
    for (let step = 1; step <= 8; step += 1) {
      const x = start.x + ((end.x - start.x) * step) / 8;
      const y = start.y + ((end.y - start.y) * step) / 8;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(x, y) });
    }
    await beforeRelease();
  } finally {
    await cdp.send("Input.dispatchTouchEvent", {
      type: cancel ? "touchCancel" : "touchEnd",
      touchPoints: [],
    });
  }
}

async function geometry(page, label, language) {
  const result = await page.evaluate(() => {
    const rect = (el) => {
      if (!el) throw new Error("Missing setup control");
      const { left, top, right, bottom, width, height } = el.getBoundingClientRect();
      return { left, top, right, bottom, width, height };
    };
    const seats = [...document.querySelectorAll(".setup-seat-card[data-setup-seat]")];
    const handles = seats.filter((card) => card.querySelector(".setup-seat-drag-handle"));
    const card = document.querySelector(".player-setup-card");
    const controls = [...document.querySelectorAll(".player-setup-actions button")].filter(
      (button) => !button.disabled,
    );
    return {
      count: seats.length,
      handles: handles.length,
      seatNumbers: seats.map((s) => s.dataset.setupSeat),
      handleLabels: handles.map((s) =>
        s.querySelector(".setup-seat-drag-handle").getAttribute("aria-label"),
      ),
      inputLabels: seats.map((s) =>
        s.querySelector('input[role="combobox"]')?.getAttribute("aria-label"),
      ),
      viewport: { width: innerWidth, height: innerHeight },
      card: rect(card),
      handleRects: handles.map((s) => rect(s.querySelector(".setup-seat-drag-handle"))),
      actions: controls.map(rect),
      scroll: { client: card.clientHeight, content: card.scrollHeight },
      dock: document.querySelector(".live-side-panel")
        ? rect(document.querySelector(".live-side-panel"))
        : null,
      lang: document.documentElement.lang,
    };
  });
  assert.equal(result.lang, language, `${label}: document language`);
  assert.equal(result.count, 10, `${label}: seat cards`);
  same(
    result.seatNumbers,
    Array.from({ length: 10 }, (_, index) => String(index + 1)),
    `${label}: ordered seats`,
  );
  assert.equal(result.handles, 10, `${label}: dedicated handles`);
  for (let n = 1; n <= 10; n += 1) {
    assert.equal(
      result.handleLabels[n - 1],
      language === "en" ? `Move player in seat ${n}` : `Переместить игрока с места ${n}`,
      `${label}: handle ${n} label`,
    );
    assert.equal(
      result.inputLabels[n - 1],
      language === "en" ? `Seat ${n} player` : `Место ${n} игрок`,
      `${label}: picker ${n} label`,
    );
  }
  for (const box of result.handleRects) {
    assert.ok(
      box.width >= 48 && box.height >= 48,
      `${label}: drag handle below 48×48: ${JSON.stringify(box)}`,
    );
  }
  assert.ok(
    result.actions.every((box) => box.width >= 48 && box.height >= 48),
    `${label}: action below 48×48`,
  );
  assert.ok(result.dock && result.dock.width > 0, `${label}: utility pane missing`);
  return result;
}

async function roleHeading(page, language, label) {
  const back = page.locator(".role-draw-heading .role-draw-back");
  const title = page.locator(".role-draw-heading h1");
  await expect(back).toHaveAccessibleName(labels[language].back);
  await expect(title).toHaveText(labels[language].role);
  const b = await back.boundingBox();
  const h = await title.boundingBox();
  const progress = await page.locator(".phase-banner").boundingBox();
  const toolbar = await page.locator(".app-fixed-toolbar").boundingBox();
  assert.ok(
    b && h && progress && b.width >= 48 && b.height >= 48,
    `${label}: back button size/heading/progress`,
  );
  assert.ok(
    b.y + b.height <= h.y + 1 ||
      (b.x + b.width <= h.x + 1 && b.y + b.height > h.y && b.y < h.y + h.height),
    `${label}: back must precede title without overlapping it`,
  );
  assert.ok(
    b.x + b.width <= progress.x ||
      b.y + b.height <= progress.y ||
      b.y >= progress.y + progress.height,
    `${label}: progress obstruction`,
  );
  assert.ok(
    toolbar && progress.x + progress.width <= toolbar.x,
    `${label}: role progress overlaps fixed toolbar`,
  );
  assert.ok(h.x + h.width <= progress.x, `${label}: role title overlaps progress`);
  await expect(
    page.locator(".role-draw-heading .role-draw-back span[aria-hidden='true']"),
  ).toHaveText("←");
  await expect(page.locator(".role-draw-heading .role-draw-back")).toBeVisible();
}

async function scenario(browser, browserName, viewport, language) {
  const tag = `${browserName}-${viewport.width}x${viewport.height}-${language}`;
  const context = await browser.newContext({ viewport, hasTouch: browserName === "chromium" });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => {
    errors.push(`Unexpected ${dialog.type()} dialog`);
    void dialog.dismiss();
  });
  const state = fixture(page, language);
  await state.routeReady;
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    assertExactOrigin(page.url(), origin);
    assert.equal(await page.title(), "La Verdad");
    await enterSetup(page);
    await expect(page.locator(".player-setup-card h1")).toHaveText(labels[language].setup);
    // Real fixture player directory and availability UI, not DOM-injected setup state.
    await page.getByRole("button", { name: labels[language].select }).click();
    const choices = page.locator(".availability-player-card[data-availability-state='unselected']");
    await expect(choices).toHaveCount(11);
    for (let n = 0; n < 11; n += 1) await choices.first().click();
    await page.locator(".availability-close-button").click();
    await page.locator("#host-player").click();
    await page.getByRole("option", { name: "UI Player 11", exact: true }).click();
    await page.getByRole("button", { name: labels[language].assign }).click();
    await expect(page.locator(".setup-seat-card")).toHaveCount(10);
    await expect(input(page, 1)).not.toHaveValue("");
    const initial = await roster(page);
    assert.equal(new Set(initial).size, 10, `${tag}: duplicate seats`);
    assert.ok(!initial.includes("UI Player 11"), `${tag}: host assigned to seat`);
    const layout = await geometry(page, tag, language);
    await page.screenshot({ path: path.join(evidence, `${tag}-setup.png`), fullPage: true });
    await awaitSave(page, state);
    await expect
      .poll(() => state.latest()?.state.setup?.selectedPlayerIds.filter(Boolean).length)
      .toBe(10);
    const initialSnapshot = checkpoint(state);
    same(
      initialSnapshot.state.setup.selectedPlayerIds.map(
        (id) => players.find((p) => p.id === id)?.nickname,
      ),
      initial,
      `${tag}: fixture/player UI disagree`,
    );

    // Search/blur/Escape and same-identity choice are provisional, not edits.
    const picker = input(page, 1);
    const oldName = initial[0];
    await picker.fill("UI Player 999");
    await picker.press("Escape");
    await expect(picker).toHaveValue(oldName);
    await picker.fill("UI Player 999");
    await page.locator(".player-setup-card h1").click();
    await expect(picker).toHaveValue(oldName);
    await picker.click();
    await page.getByRole("option", { name: oldName, exact: true }).click();
    unchanged(state, initialSnapshot, `${tag}: cancelled/same picker`);
    await dragMouse(page, 1, 1, "same");
    unchanged(state, initialSnapshot, `${tag}: same-seat drop`);
    await dragMouse(page, 1, null, "outside");
    unchanged(state, initialSnapshot, `${tag}: outside drop`);

    // Partial-seat move: only the target empties before the drag; this is
    // checked separately from a full swap and never interprets a blank as swap.
    await seat(page, 3).locator(".player-combobox-clear").click();
    await expect(input(page, 3)).toHaveValue("");
    await expect
      .poll(() => state.latest()?.state.setup?.selectedPlayerIds[2], { timeout: 15000 })
      .toBe("");
    const beforeMove = checkpoint(state);
    await dragMouse(page, 3, 1);
    unchanged(state, beforeMove, `${tag}: empty drag source`);
    const beforeMoveNames = await roster(page);
    const first = beforeMoveNames[0];
    await dragMouse(page, 1, 3, "target", async () => {
      same(await roster(page), beforeMoveNames, `${tag}: pointer move committed early`);
      unchanged(state, beforeMove, `${tag}: pointer move persisted early`);
    });
    await expect(input(page, 3)).toHaveValue(first);
    await expect(input(page, 1)).toHaveValue("");
    await expect
      .poll(() => state.latest()?.state.setup?.selectedPlayerIds[2], { timeout: 15000 })
      .toBe(beforeMove.state.setup.selectedPlayerIds[0]);
    const moved = snapshot(state);
    assert.equal(moved.gameId, beforeMove.gameId, `${tag}: empty move changed game ID`);
    assert.equal(moved.state.setup.setup, null, `${tag}: empty move retained a deal`);
    for (const write of state.writes.slice(beforeMove.writeCount)) {
      const ids = write.state.setup?.selectedPlayerIds;
      if (ids)
        assert.ok(
          ids[0] === "" && ids[2] === beforeMove.state.setup.selectedPlayerIds[0],
          `${tag}: transient half-move`,
        );
    }
    await input(page, 1).click();
    await page.getByRole("option", { name: initial[2], exact: true }).click();
    await expect(page.getByRole("button", { name: labels[language].start })).toBeEnabled();

    await page.getByRole("button", { name: labels[language].start }).click();
    await roleHeading(page, language, tag);
    await page.screenshot({ path: path.join(evidence, `${tag}-roles.png`), fullPage: true });
    await page
      .getByRole("button", {
        name: language === "en" ? /^Draw role for / : /^Раздать роль игроку /,
      })
      .first()
      .click();
    await expect
      .poll(() => Object.keys(state.latest()?.state.setup?.setup?.assignments ?? {}).length, {
        timeout: 15000,
      })
      .toBeGreaterThan(0);
    const drawn = checkpoint(state);
    assert.equal(drawn.gameId, initialSnapshot.gameId, `${tag}: draw changed game ID`);
    assert.ok(drawn.state.setup.setup.remainingRoles.length < 10, `${tag}: role not drawn`);
    await page.locator(".role-draw-back").click();
    await expect(page.locator(".player-setup-card h1")).toBeFocused();
    await expect(page.locator(".player-setup-card h1")).toHaveText(labels[language].setup);
    await expect.poll(() => state.latest()?.state.setup?.step).toBe("players");
    const beforeDealNoop = checkpoint(state);
    const seatName = await input(page, 1).inputValue();
    await input(page, 1).fill("UI Player 999");
    await input(page, 1).press("Escape");
    await expect(input(page, 1)).toHaveValue(seatName);
    await dragMouse(page, 1, 1, "same");
    unchanged(state, beforeDealNoop, `${tag}: cancelled picker / no-op retained roles`);
    await page.getByRole("button", { name: labels[language].start }).click();
    await roleHeading(page, language, tag);
    await expect
      .poll(() => state.latest()?.state.setup?.setup?.assignments)
      .toEqual(drawn.state.setup.setup.assignments);
    await page.locator(".role-draw-back").click();
    await expect.poll(() => state.latest()?.state.setup?.step).toBe("players");
    const beforeSwap = checkpoint(state);
    const names = await roster(page);
    await dragMouse(page, 1, 4, "target", async () => {
      same(await roster(page), names, `${tag}: pointer move committed before release`);
      unchanged(state, beforeSwap, `${tag}: pointer move persisted before release`);
    });
    const swapped = [...names];
    [swapped[0], swapped[3]] = [swapped[3], swapped[0]];
    await expect
      .poll(() => roster(page), { message: `${tag}: exact two-seat swap` })
      .toEqual(swapped);
    await expect
      .poll(() => state.latest()?.state.setup?.selectedPlayerIds)
      .toEqual([
        beforeSwap.state.setup.selectedPlayerIds[3],
        beforeSwap.state.setup.selectedPlayerIds[1],
        beforeSwap.state.setup.selectedPlayerIds[2],
        beforeSwap.state.setup.selectedPlayerIds[0],
        ...beforeSwap.state.setup.selectedPlayerIds.slice(4),
      ]);
    const changed = snapshot(state);
    assert.equal(changed.gameId, drawn.gameId, `${tag}: swap allocated a new game`);
    assert.equal(changed.state.setup.setup, null, `${tag}: old deal survived committed swap`);
    for (const write of state.writes.slice(beforeSwap.writeCount)) {
      const setup = write.state.setup;
      if (!setup) continue;
      same(
        setup.selectedPlayerIds,
        changed.state.setup.selectedPlayerIds,
        `${tag}: swap persisted an intermediate roster`,
      );
      assert.equal(setup.setup, null, `${tag}: intermediate snapshot retained old roles`);
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".player-setup-card h1")).toHaveText(labels[language].setup);
    await expect
      .poll(() => roster(page), { message: `${tag}: reload lost seat swap` })
      .toEqual(swapped);
    await expect(page.getByRole("button", { name: labels[language].start })).toBeEnabled();
    assert.equal(snapshot(state).gameId, drawn.gameId, `${tag}: reload changed game ID`);
    await page.getByRole("button", { name: labels[language].start }).click();
    await roleHeading(page, language, tag);
    await expect.poll(() => state.latest()?.state.setup?.step).toBe("roles");
    const fresh = snapshot(state);
    assert.ok(fresh.state.setup.setup, `${tag}: new draw not persisted`);
    assert.equal(
      Object.keys(fresh.state.setup.setup.assignments).length,
      0,
      `${tag}: reload restored old deal`,
    );
    await page.locator(".role-draw-back").click();

    // Casper's virtual seat is neither a drag source nor a valid destination.
    await page.locator(".casper-toggle").click();
    await expect(page.locator(".casper-toggle input")).toBeChecked();
    await expect(page.locator("#casper-player")).toHaveValue("Casper");
    await expect
      .poll(() => state.latest()?.state.setup?.selectedPlayerIds[9])
      .not.toBe(beforeSwap.state.setup.selectedPlayerIds[9]);
    if (await handle(page, 10).count()) {
      assert.ok(
        (await handle(page, 10).isDisabled()) ||
          (await handle(page, 10).getAttribute("aria-disabled")) === "true",
        `${tag}: Casper drag source is active`,
      );
    }
    const locked = checkpoint(state);
    await dragMouse(page, 9, 10);
    unchanged(state, locked, `${tag}: Casper destination`);
    await dragMouse(page, 10, 9);
    unchanged(state, locked, `${tag}: Casper source`);
    assert.equal(await page.locator("#casper-player").inputValue(), "Casper");
    await page.screenshot({ path: path.join(evidence, `${tag}-casper.png`), fullPage: true });
    state.ensureClean();
    same(errors, [], `${tag}: browser exceptions`);
    console.log(
      `PASS ${tag}: mouse move/swap/no-op, cancelled search, role reset, reload, Casper; ${JSON.stringify({ gameId: drawn.gameId, screenshots: 3, viewport: layout.viewport })}`,
    );
  } catch (error) {
    await page.screenshot({ path: path.join(evidence, `${tag}-failure.png`), fullPage: true });
    console.error({
      tag,
      errors,
      routes: state.errors,
      screen: await page.locator("body").innerText(),
    });
    throw error;
  } finally {
    await context.close();
  }
}

async function touchScenario(browser, language) {
  const tag = `chromium-touch-1000x600-${language}`;
  const context = await browser.newContext({
    viewport: { width: 1000, height: 600 },
    hasTouch: true,
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => {
    errors.push(`Unexpected ${dialog.type()} dialog`);
    void dialog.dismiss();
  });
  const state = fixture(page, language);
  await state.routeReady;
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await enterSetup(page);
    await page.getByRole("button", { name: labels[language].select }).click();
    const choices = page.locator(".availability-player-card[data-availability-state='unselected']");
    await expect(choices).toHaveCount(11);
    for (let n = 0; n < 11; n += 1) await choices.first().click();
    await page.locator(".availability-close-button").click();
    await page.locator("#host-player").click();
    await page.getByRole("option", { name: "UI Player 11", exact: true }).click();
    await page.getByRole("button", { name: labels[language].assign }).click();
    await expect(input(page, 2)).not.toHaveValue("");
    await awaitSave(page, state);
    await expect
      .poll(() => state.latest()?.state.setup?.selectedPlayerIds.filter(Boolean).length)
      .toBe(10);
    const original = await roster(page);
    const beforeCancel = checkpoint(state);
    await touch(page, cdp, 1, 2, true);
    same(await roster(page), original, `${tag}: CDP touchCancel changed roster`);
    unchanged(state, beforeCancel, `${tag}: CDP touchCancel`);
    const beforeTouch = checkpoint(state);
    await touch(page, cdp, 1, 2, false, async () => {
      same(await roster(page), original, `${tag}: touch move committed before lift`);
      unchanged(state, beforeTouch, `${tag}: touch move persisted before lift`);
    });
    const swapped = [...original];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    await expect(input(page, 1)).toHaveValue(swapped[0]);
    same(await roster(page), swapped, `${tag}: CDP touch swap failed`);
    await expect
      .poll(() => state.latest()?.state.setup?.selectedPlayerIds.slice(0, 2))
      .toEqual([
        beforeTouch.state.setup.selectedPlayerIds[1],
        beforeTouch.state.setup.selectedPlayerIds[0],
      ]);
    for (const write of state.writes.slice(beforeTouch.writeCount)) {
      const ids = write.state.setup?.selectedPlayerIds;
      if (ids)
        same(
          ids.slice(0, 2),
          state.latest().state.setup.selectedPlayerIds.slice(0, 2),
          `${tag}: touch wrote intermediate roster`,
        );
    }
    // A real touch drag outside the handle must scroll when the setup card overflows.
    const scrollState = await page.locator(".player-setup-card").evaluate((element) => ({
      top: element.scrollTop,
      max: element.scrollHeight - element.clientHeight,
      action: getComputedStyle(element).touchAction,
    }));
    assert.notEqual(scrollState.action, "none", `${tag}: setup disabled normal touch scrolling`);
    if (scrollState.max > 8) {
      await page.locator(".player-setup-card").evaluate((element) => {
        element.scrollTop = 0;
      });
      const heading = await center(page.locator(".player-setup-heading"));
      const point = (y) => [{ x: heading.x, y, id: 2, radiusX: 1, radiusY: 1, force: 1 }];
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: point(heading.y),
      });
      for (let step = 1; step <= 8; step += 1) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: point(heading.y - step * 12),
        });
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect
        .poll(() => page.locator(".player-setup-card").evaluate((el) => el.scrollTop))
        .toBeGreaterThan(0);
    }
    await page.screenshot({ path: path.join(evidence, `${tag}.png`), fullPage: true });
    state.ensureClean();
    same(errors, [], `${tag}: browser exceptions`);
    console.log(`PASS ${tag}: trusted CDP touch swap/cancel, scroll if overflow`);
  } finally {
    await cdp.detach();
    await context.close();
  }
}

await mkdir(evidence, { recursive: true });
const chrome = await chromium.launch({ channel: "chrome", headless: true });
try {
  const safari = await webkit.launch({ headless: true });
  try {
    for (const language of ["en", "ru"]) {
      for (const viewport of [
        { width: 1366, height: 768 },
        { width: 1000, height: 600 },
        { width: 1366, height: 1024 },
      ]) {
        await scenario(chrome, "chromium", viewport, language);
        await scenario(safari, "webkit", viewport, language);
      }
      await touchScenario(chrome, language);
    }
  } finally {
    await safari.close();
  }
} finally {
  await chrome.close();
}
console.log(`Setup seat verifier PASS; screenshots: ${evidence}`);
