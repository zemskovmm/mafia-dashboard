/* global URL, structuredClone, document, innerWidth, innerHeight, getComputedStyle, fetch, Element, HTMLCanvasElement */
/*
 * Focused real-app setup correction regression. Run against an owned local Vite
 * origin (APP_URL defaults to http://127.0.0.1:8080). Mock API is strict and
 * in-memory; this is browser/payload continuity evidence, not PostgreSQL proof.
 * Screenshots remain in the ignored repository .AI/ directory.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, appendFile } from "node:fs/promises";
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
const evidence = path.resolve(process.env.UI_SETUP_EVIDENCE_DIR ?? ".AI/setup-seats");
const requestedCase = process.env.UI_SETUP_CASE;
const executedCases = [];
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
    setup: "Select players",
    select: "Select available players",
    assign: "Assign players",
    start: "Start game",
    back: "Player setup",
    role: "Role giveaway",
    clear: "Clear Seat 3",
    casper: "Include Casper",
  },
  ru: {
    setup: "Выберите игроков",
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
  const tournaments = [];
  let revision = 0;
  const club = {
    id: uuid(101),
    name: "Mafia Malaga",
    city: "Málaga",
    headerLogo: null,
    cardLogo: null,
    language,
    bestMoveEnabled: language === "en",
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
      tournamentId: sessions.get(id)?.tournamentId ?? mutation.tournamentId ?? null,
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
        if (
          pathname === "/api/tournaments" &&
          !url.search &&
          request.headers()["x-club-id"] === club.id
        ) {
          if (method === "GET") return json(route, { tournaments });
          if (method === "POST") {
            const payload = request.postDataJSON();
            if (
              Object.keys(payload).length !== 1 ||
              typeof payload.name !== "string" ||
              !payload.name.trim()
            )
              return fail(route);
            const tournament = {
              id: uuid(200 + tournaments.length),
              clubId: club.id,
              name: payload.name.trim(),
              createdAt: "2026-10-17T00:00:00.000Z",
              updatedAt: "2026-10-17T00:00:00.000Z",
            };
            tournaments.push(tournament);
            return json(route, { tournament }, 201);
          }
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
        const tournamentGame = pathname.match(
          /^\/api\/game-sessions\/([0-9a-f-]{36})\/tournament$/i,
        )?.[1];
        if (
          tournamentGame &&
          method === "PUT" &&
          !url.search &&
          request.headers()["x-club-id"] === club.id
        ) {
          const payload = request.postDataJSON();
          const session = sessions.get(tournamentGame);
          if (
            !session ||
            Object.keys(payload).length !== 1 ||
            (payload.tournamentId !== null &&
              !tournaments.some(({ id }) => id === payload.tournamentId))
          )
            return fail(route);
          sessions.set(tournamentGame, { ...session, tournamentId: payload.tournamentId });
          return json(route, { tournamentId: payload.tournamentId });
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
  Promise.all(Array.from({ length: 10 }, (_, n) => pickerValue(input(page, n + 1))));
const pickerValue = (picker) => picker.evaluate((element) => element.value);
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
    await page.getByRole("button", { name: "Back to game", exact: true }).click();
  }
  await page.locator(".player-setup-card h1").waitFor();
}

async function assertSwapPreview(page, from, to, source, destination, bounds) {
  const clone = page.locator(".setup-seat-drag-preview");
  await expect(clone).toHaveCount(1);
  await expect(clone).toHaveAttribute("aria-hidden", "true");
  assert.equal(
    await clone.locator("button, input, select, a, [tabindex]").count(),
    0,
    "Drag decoration is inert",
  );
  assert.equal(await clone.evaluate((el) => getComputedStyle(el).pointerEvents), "none");
  await expect
    .poll(
      async () => {
        const box = await clone.boundingBox();
        return (
          box !== null &&
          Math.abs(box.x - (destination.x - source.x + bounds.x)) < 1 &&
          Math.abs(box.y - (destination.y - source.y + bounds.y)) < 1
        );
      },
      { message: "React must consume the final trusted pointer move before preview readback" },
    )
    .toBe(true);
  const actual = await clone.boundingBox();
  assert.ok(
    Math.abs(actual.x - (destination.x - source.x + bounds.x)) < 1,
    `Drag preserves horizontal grab offset: ${JSON.stringify({ actual, destination, source, bounds })}`,
  );
  assert.ok(
    Math.abs(actual.y - (destination.y - source.y + bounds.y)) < 1,
    "Drag follows pointer with vertical grab offset",
  );
  const stable = await seat(page, from).boundingBox();
  same(
    { x: stable.x, width: stable.width, height: stable.height },
    { x: bounds.x, width: bounds.width, height: bounds.height },
    "Source seat hit region changed size or column",
  );
  // Native edge scrolling may change viewport y; the canonical layout box must not translate.
  assert.equal(
    await seat(page, from).evaluate((el) => el.offsetTop),
    bounds.localTop,
    "Source seat layout row moved during preview",
  );
  assert.equal(
    await seat(page, from).evaluate((el) => getComputedStyle(el).transform),
    "none",
    "Seat hit region itself was transformed",
  );
  if (to !== null && to !== from && !(await seat(page, to).locator("#casper-player").count())) {
    await expect(seat(page, to).locator(".setup-seat-content")).toHaveAttribute(
      "data-swap-preview",
      "true",
    );
    const targetBounds = await seat(page, to).boundingBox();
    const transform = await seat(page, to)
      .locator(".setup-seat-content")
      .evaluate((el) => el.style.transform);
    assert.equal(
      transform,
      `translate(${stable.x - targetBounds.x}px, ${stable.y - targetBounds.y}px)`,
      "Exact target preview must go to source, not shift intervening seats",
    );
  }
}

async function popupBrowse(page, language, tag) {
  for (const n of [1, 3, 5, 6, 8, 10]) {
    const opener = input(page, n);
    await opener.scrollIntoViewIfNeeded();
    await opener.click();
    await expect(page.getByRole("listbox")).toHaveCount(1);
    await expect(page.getByRole("searchbox")).not.toBeFocused();
    await expect(page.getByRole("searchbox")).toHaveValue("");
    const last = page.getByRole("option").last();
    await last.scrollIntoViewIfNeeded();
    const popup = await page.locator(".setup-player-popup").boundingBox();
    const view = page.viewportSize();
    assert.ok(
      popup.x >= 0 &&
        popup.y >= 0 &&
        popup.x + popup.width <= view.width + 1 &&
        popup.y + popup.height <= view.height + 1,
      `${tag}: seat ${n} popup clipped by viewport`,
    );
    const point = await center(last);
    assert.ok(
      await last.evaluate((el, p) => el.contains(document.elementFromPoint(p.x, p.y)), point),
      `${tag}: last option is covered`,
    );
    if ([3, 5, 8, 10].includes(n))
      await page.screenshot({
        path: path.join(evidence, `${tag}-popup-seat-${n}.png`),
        fullPage: true,
      });
    await opener.click();
    await expect(page.locator(".setup-player-popup")).toHaveCount(0);
  }
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
  const bounds = await seat(page, from).boundingBox();
  bounds.localTop = await seat(page, from).evaluate((el) => el.offsetTop);
  const draggable = (await handle(page, from).getAttribute("aria-disabled")) !== "true";
  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  try {
    await page.mouse.move(destination.x, destination.y, { steps: 12 });
    if (draggable) {
      await assertSwapPreview(
        page,
        from,
        final === "target" ? to : null,
        source,
        destination,
        bounds,
      );
      if (final === "target" && to !== from)
        await page.screenshot({
          path: path.join(evidence, `${requestedCase ?? "mouse"}-preview-${from}-${to}.png`),
          fullPage: true,
        });
    }
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
  const bounds = await seat(page, from).boundingBox();
  bounds.localTop = await seat(page, from).evaluate((el) => el.offsetTop);
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
    await assertSwapPreview(page, from, to, start, end, bounds);
    await page.screenshot({
      path: path.join(
        evidence,
        `${requestedCase ?? "touch"}-preview-${from}-${to}-${cancel ? "cancel" : "commit"}.png`,
      ),
      fullPage: true,
    });
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
        s.querySelector('button[role="combobox"]')?.getAttribute("aria-label"),
      ),
      viewport: { width: innerWidth, height: innerHeight },
      card: rect(card),
      seatRects: seats.map(rect),
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
  const boxes = result.seatRects;
  if (result.viewport.width >= 700) {
    assert.ok(boxes[5].left > boxes[0].right, `${label}: second column must start at seat 6`);
    for (let i = 0; i < 5; i += 1) {
      assert.ok(Math.abs(boxes[i].left - boxes[0].left) < 1, `${label}: left column seat ${i + 1}`);
      assert.ok(
        Math.abs(boxes[i + 5].left - boxes[5].left) < 1,
        `${label}: right column seat ${i + 6}`,
      );
      assert.ok(
        Math.abs(boxes[i].width - boxes[i + 5].width) < 1,
        `${label}: columns must have equal widths`,
      );
      assert.ok(Math.abs(boxes[i].top - boxes[i + 5].top) < 1, `${label}: paired column row ${i}`);
      if (i > 0)
        assert.ok(boxes[i].top > boxes[i - 1].top, `${label}: column-major vertical order`);
    }
  } else {
    for (let i = 1; i < 10; i += 1) {
      assert.ok(
        Math.abs(boxes[i].left - boxes[0].left) < 1 && boxes[i].top > boxes[i - 1].top,
        `${label}: narrow sequential seats`,
      );
    }
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
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(
      async () => {
        const box = await back.boundingBox();
        return box !== null && box.width >= 48 && box.height >= 48;
      },
      { message: `${label}: native back target must settle at 48×48 or larger` },
    )
    .toBe(true);
  const b = await back.boundingBox();
  const h = await title.boundingBox();
  await expect(page.locator(".phase-banner, .setup-edition-label")).toHaveCount(0);
  const progress = await page.locator(".table-center").boundingBox();
  const toolbar = await page.locator(".app-fixed-toolbar").boundingBox();
  assert.ok(
    b && h && progress && b.width >= 48 && b.height >= 48,
    `${label}: back button size/heading/progress: ${JSON.stringify({ b, h, progress })}`,
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
  assert.ok(
    h.y + h.height <= progress.y ||
      h.x + h.width <= progress.x ||
      h.x >= progress.x + progress.width,
    `${label}: role title overlaps central progress`,
  );
  await expect(
    page.locator(".role-draw-heading .role-draw-back span[aria-hidden='true']"),
  ).toHaveText("←");
  await expect(page.locator(".role-draw-heading .role-draw-back")).toBeVisible();
}

const roleCard = (page, seat) => page.locator(`.seat-anchor[data-seat="${seat}"] .player-seat`);
const noDeviationUI = async (page) => {
  await expect(
    page.locator(".setup-deviations, .setup-reroll-confirm, .federation-rules-notice"),
  ).toHaveCount(0);
  await expect(
    page.getByText(
      /Nonstandard club deviations|Нестандартные клубные отклонения|Nonstandard role reroll|Нестандартная перераздача роли/,
    ),
  ).toHaveCount(0);
};

async function swipeRole(page, cdp, seat, dx, dy = 0, cancel = false) {
  await expect(roleCard(page, seat)).toBeEnabled();
  const start = await center(roleCard(page, seat));
  const policy = await roleCard(page, seat).evaluate((card) => getComputedStyle(card).touchAction);
  assert.equal(policy, "pan-y pinch-zoom", "Role touch must reserve horizontal motion only");
  await roleCard(page, seat).evaluate((card) => {
    const trace = [];
    const collect = (event) => {
      trace.push({
        type: event.type,
        trusted: event.isTrusted,
        pointerType: event.pointerType,
        x: event.changedTouches?.[0]?.clientX ?? event.clientX,
        y: event.changedTouches?.[0]?.clientY ?? event.clientY,
        disabled: card.disabled,
      });
      card.dataset.verifierRoleTrace = JSON.stringify(trace);
    };
    for (const type of [
      "pointerdown",
      "pointerup",
      "pointercancel",
      "lostpointercapture",
      "touchstart",
      "touchend",
      "touchcancel",
      "click",
    ])
      card.addEventListener(type, collect);
  });
  onscreen(page, { x: start.x + dx, y: start.y + dy }, "Role swipe destination");
  const points = (fraction) => [{ x: start.x + dx * fraction, y: start.y + dy * fraction, id: 1 }];
  if (cdp === null) {
    assert.equal(
      cancel,
      false,
      "Pointer role cancellation is tested separately from CDP touchCancel",
    );
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + dx, start.y + dy, { steps: 8 });
    await page.mouse.up();
    return;
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(0) });
  for (let step = 1; step <= 6; step += 1) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: points(step / 6),
    });
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: cancel ? "touchCancel" : "touchEnd",
    touchPoints: [],
  });
  const trace = JSON.parse(await roleCard(page, seat).getAttribute("data-verifier-role-trace"));
  assert.ok(
    trace.some((e) => e.type === "touchstart" && e.trusted),
    "Expected trusted Chromium touch start",
  );
  if (Math.abs(dx) > 44 && Math.abs(dy) < 8 && !cancel) {
    assert.ok(
      trace.some((e) => e.type === "pointerup" && e.trusted),
      "Horizontal role gesture must complete its pointer",
    );
    assert.ok(
      !trace.some((e) => e.type === "pointercancel"),
      "Native horizontal takeover cancelled role gesture",
    );
  }
  const input = {
    seat,
    dx,
    dy,
    cancel,
    policy,
    start,
    end: { x: start.x + dx, y: start.y + dy },
    trace,
  };
  await appendFile(path.join(evidence, "trusted-role-input.jsonl"), JSON.stringify(input) + "\n");
  console.log(`Role input: ${JSON.stringify(input)}`);
}

async function roleCorrections(page, state, language, tag, cdp) {
  assert.ok(
    [undefined, "pointer", "touch"].includes(process.env.UI_SETUP_ROLE_INPUT),
    "Unknown UI_SETUP_ROLE_INPUT",
  );
  const roleCdp = process.env.UI_SETUP_ROLE_INPUT === "pointer" ? null : cdp;
  const menu = page.getByRole("dialog", {
    name: language === "en" ? "Choose role" : "Выберите роль",
    exact: true,
  });
  const clear = page.getByRole("button", {
    name: language === "en" ? "Clear role for seat 1" : "Сбросить роль для места 1",
  });
  const cancel = page.getByRole("button", {
    name: language === "en" ? "Cancel" : "Отмена",
    exact: true,
  });
  const choose = (role) =>
    page.getByRole("button", {
      name:
        language === "en"
          ? `Assign ${role} to seat 1`
          : `Назначить роль «${role === "sheriff" ? "Шериф" : "Дон"}» месту 1`,
    });
  const activate = (locator) => (cdp ? locator.tap() : locator.click());
  const open = async (direction) => {
    const before = checkpoint(state);
    await swipeRole(page, roleCdp, 1, direction * 70);
    await expect(menu).toBeVisible();
    unchanged(state, before, `${tag}: opening chooser accidentally dealt a role`);
    const targets = await menu.locator("button").evaluateAll((buttons) =>
      buttons.map((button) => {
        const { x, y, width, height } = button.getBoundingClientRect();
        const hit = document.elementFromPoint(x + width / 2, y + height / 2);
        return {
          label: button.textContent,
          x,
          y,
          width,
          height,
          reachable: hit === button || button.contains(hit),
        };
      }),
    );
    for (const target of targets) {
      assert.ok(
        target.width >= 48 && target.height >= 48 && target.reachable,
        `${tag}: role menu target is undersized or obstructed: ${JSON.stringify(target)}`,
      );
      onscreen(page, { x: target.x, y: target.y }, "Role menu top-left");
      onscreen(
        page,
        { x: target.x + target.width - 1, y: target.y + target.height - 1 },
        "Role menu bottom-right",
      );
    }
  };
  const original = checkpoint(state);
  await noDeviationUI(page);
  await open(-1);
  await expect(clear).toHaveCount(0);
  await activate(choose("sheriff"));
  await expect.poll(() => state.latest()?.state.setup?.setup?.assignments[1]).toBe("sheriff");
  const assigned = checkpoint(state);
  // A full-pool shuffle may legally keep the same role; force a known rotation
  // here, while the preview cases separately prove unchanged-role flips.
  await page.evaluate(() => {
    window.__setupRoleRandom = Math.random;
    Math.random = () => 0;
  });
  await activate(roleCard(page, 1));
  await activate(roleCard(page, 1));
  unchanged(state, assigned, `${tag}: first two taps rerolled`);
  await activate(roleCard(page, 1));
  await page.evaluate(() => {
    Math.random = window.__setupRoleRandom;
  });
  await expect.poll(() => state.latest()?.state.setup?.setup?.assignments[1]).not.toBe("sheriff");
  await expect(menu).toHaveCount(0);
  await noDeviationUI(page);
  assert.equal(state.latest().state.setup.setup.remainingRoles.length, 9);
  await open(1);
  await page.screenshot({ path: path.join(evidence, `${tag}-role-menu.png`), fullPage: true });
  await activate(clear);
  await expect.poll(() => state.latest()?.state.setup?.setup?.remainingRoles.length).toBe(10);
  const cleared = checkpoint(state);
  if (cdp) {
    await swipeRole(page, cdp, 1, 0, -70);
    await expect(menu).toHaveCount(0);
    await swipeRole(page, cdp, 1, 70, 0, true);
    await expect(menu).toHaveCount(0);
    unchanged(state, cleared, `${tag}: vertical/cancelled swipe mutated roles`);
  }
  await roleCard(page, 1).press("Shift+F10");
  await roleCard(page, 1).press("ContextMenu");
  await expect(menu).toHaveCount(0);
  unchanged(state, cleared, `${tag}: retired role-menu keys mutated roles`);
  await open(1);
  await page.keyboard.press("Escape");
  await expect(menu).toBeVisible();
  await cancel.press("Space");
  await expect(menu).toHaveCount(0);
  unchanged(state, cleared, `${tag}: native Cancel Space mutated roles`);
  await open(-1);
  await activate(cancel);
  unchanged(state, cleared, `${tag}: cancelled chooser mutated roles`);
  await open(1);
  await activate(choose("don"));
  for (let seat = 2; seat <= 10; seat += 1) await activate(roleCard(page, seat));
  await expect.poll(() => state.latest()?.state.setup?.setup?.remainingRoles.length).toBe(0);
  const complete = checkpoint(state);
  await open(-1);
  await activate(clear);
  await expect.poll(() => state.latest()?.state.setup?.setup?.remainingRoles).toEqual(["don"]);
  const clearedFull = checkpoint(state);
  same(
    clearedFull.state.setup.setup.assignments,
    Object.fromEntries(
      Object.entries(complete.state.setup.setup.assignments).filter(([seat]) => seat !== "1"),
    ),
    `${tag}: clearing changed another seat`,
  );
  await expect(page.locator(".table-advance button")).toBeDisabled();
  await page.screenshot({ path: path.join(evidence, `${tag}-role-cleared.png`), fullPage: true });
  await awaitSave(page, state);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(roleCard(page, 1).locator(".role-badge")).toHaveCount(0);
  await expect(page.locator(".table-advance button")).toBeDisabled();
  await noDeviationUI(page);
  unchanged(state, clearedFull, `${tag}: reload lost cleared role`);
  const remote = await page.evaluate(
    async (id) => (await fetch(`/api/game-sessions/${id}`)).json(),
    original.gameId,
  );
  same(remote.session.state.setup, clearedFull.state.setup, `${tag}: fixture readback differs`);
  await open(1);
  await activate(choose("don"));
  await expect.poll(() => state.latest()?.state.setup?.setup).toEqual(complete.state.setup.setup);
  await expect(page.locator(".table-advance button")).toBeEnabled();
  assert.equal(state.latest().gameId, original.gameId, `${tag}: role correction changed identity`);
  assert.equal(state.latest().state.setup.bestMoveEnabled, language === "en");
  assert.equal(state.latest().state.setup.clubDeviationsAcknowledged, undefined);
}

async function rolePreviewScenario(browser, engine, mode) {
  const tag = `role-preview-${engine}-${mode}`;
  if (requestedCase && requestedCase !== tag) return;
  executedCases.push(tag);
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    reducedMotion: mode === "reduced" ? "reduce" : "no-preference",
  });
  await context.addInitScript(
    ({ fallback }) => {
      window.__roleTurns = [];
      window.__originalRandom = Math.random;
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (frames, options) {
        const animation = animate.call(this, frames, options);
        if (
          this.matches(".role-draw-card") &&
          Array.isArray(frames) &&
          frames.some((frame) => frame.rotate)
        ) {
          window.__roleTurns.push(Number(this.closest(".seat-anchor").dataset.seat));
        }
        return animation;
      };
      if (fallback) {
        const getContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
          return /webgl/.test(kind) ? null : getContext.call(this, kind, ...args);
        };
      }
    },
    { fallback: mode === "fallback" },
  );
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const state = fixture(page, "en");
  const card = (number) => roleCard(page, number);
  const preview = (setup) => {
    const roles = { ...setup.assignments };
    setup.players
      .filter(({ seat }) => roles[seat] === undefined)
      .sort((a, b) => a.seat - b.seat)
      .forEach(({ seat }, index) => {
        roles[seat] = setup.remainingRoles[index];
      });
    return roles;
  };
  const shown = () =>
    page
      .locator(".role-draw-card")
      .evaluateAll((cards) =>
        Object.fromEntries(
          cards.map((node) => [
            node.closest(".seat-anchor").dataset.seat,
            node.dataset.roleDrawRole,
          ]),
        ),
      );
  const settle = () => expect(page.locator(".is-role-flipping")).toHaveCount(0);
  const turns = () => page.evaluate(() => window.__roleTurns.length);
  const triple = async (number, value) => {
    const before = await turns();
    await page.evaluate((random) => {
      Math.random = () => random;
    }, value);
    for (let tap = 0; tap < 3; tap++) {
      await card(number).click();
      if (tap < 2) assert.equal(await turns(), before, `${tag}: partial triple flipped`);
    }
    await page.evaluate(() => {
      Math.random = window.__originalRandom;
    });
    assert.equal(
      await turns(),
      before + (mode === "reduced" ? 0 : 1),
      `${tag}: accepted reroll flip`,
    );
    await settle();
  };
  try {
    await state.routeReady;
    await page.goto(baseUrl);
    await enterSetup(page);
    await page.getByRole("button", { name: labels.en.select }).click();
    const choices = page.locator(".availability-player-card[data-availability-state='unselected']");
    await expect(choices).toHaveCount(11);
    for (let n = 0; n < 11; n++) await choices.first().click();
    await page.locator(".availability-close-button").click();
    await page.locator("#host-player").click();
    await page.getByRole("option", { name: "UI Player 11", exact: true }).click();
    await page.getByRole("button", { name: labels.en.assign }).click();
    await awaitSave(page, state);
    await page.getByRole("button", { name: labels.en.start }).click();
    await roleHeading(page, "en", tag);
    await awaitSave(page, state);
    await expect(page.locator(".role-badge")).toHaveCount(0);
    const initial = checkpoint(state);
    for (let tap = 0; tap < 5; tap++)
      await page.getByRole("button", { name: /^(Hide|Show) private info$/ }).click();
    await page.getByRole("button", { name: "Open developer menu" }).click();
    await expect(page.getByRole("button", { name: "Show undealt role preview" })).toBeDisabled();
    await page.getByRole("button", { name: "Enable dev mode" }).click();
    await page.getByRole("button", { name: "Show undealt role preview" }).click();
    await page.getByRole("button", { name: "Close developer menu" }).click();
    await expect(page.locator(".role-draw-preview-indicator")).toBeVisible();
    await expect(page.locator(".role-badge")).toHaveCount(10);
    same(await shown(), preview(initial.state.setup.setup), `${tag}: truthful initial preview`);
    await expect(page.locator(".is-role-dealt")).toHaveCount(0);
    unchanged(state, initial, `${tag}: preview must not deal or save`);
    assert.equal(state.writes.length, initial.writeCount, `${tag}: preview caused a save`);
    const identity = await card(7).elementHandle();
    // WebKit does not focus buttons on pointer click; qualify focus retention
    // with native keyboard activation, then use pointer taps for the rerolls.
    await card(7).focus();
    await card(7).press("Space");
    assert.equal(await turns(), mode === "reduced" ? 0 : 1, `${tag}: first reveal flip`);
    if (mode !== "reduced") {
      const frames = await card(7).evaluate((node) => {
        const animations = node
          .getAnimations({ subtree: true })
          .filter((animation) => animation.id.startsWith("role-draw-"));
        const front = node.querySelector(".role-draw-face--front"),
          back = node.querySelector(".role-draw-face--back");
        const face = animations.find((animation) => animation.effect.target === front);
        const edge = face.effect.getKeyframes()[1].offset;
        const samples = [];
        for (const fraction of [edge / 2, (edge + 1) / 2]) {
          animations.forEach((animation) => {
            animation.pause();
            animation.currentTime = animation.effect.getTiming().duration * fraction;
          });
          samples.push({
            rotate: getComputedStyle(node).rotate,
            front: getComputedStyle(front).visibility,
            back: getComputedStyle(back).visibility,
          });
        }
        return samples;
      });
      assert.deepEqual(
        frames.map(({ front, back }) => [front, back]),
        [
          ["visible", "hidden"],
          ["hidden", "visible"],
        ],
      );
      assert.notEqual(frames[1].rotate, "none");
      await page.screenshot({ path: path.join(evidence, `${tag}-flip.png`) });
      await card(7).evaluate((node) =>
        node.getAnimations({ subtree: true }).forEach((animation) => animation.play()),
      );
      console.log(`${tag} intermediate frames: ${JSON.stringify(frames)}`);
    }
    await settle();
    assert.equal(await card(7).evaluate((node, original) => node === original, identity), true);
    await expect(card(7)).toBeFocused();
    await expect
      .poll(() => state.latest()?.state.setup?.setup?.assignments[7])
      .toBe(preview(initial.state.setup.setup)[7]);
    await card(2).click();
    await settle();
    await expect
      .poll(() => Object.keys(state.latest()?.state.setup?.setup?.assignments ?? {}).length)
      .toBe(2);
    const beforeSame = preview(state.latest().state.setup.setup);
    await triple(7, 0.999999);
    same(await shown(), beforeSame, `${tag}: unchanged-role legal reroll`);
    const beforePool = state.latest().state.setup.setup;
    const eligible = beforePool.players
      .filter(({ seat }) => seat === 7 || beforePool.assignments[seat] === undefined)
      .map(({ seat }) => seat)
      .sort((a, b) => a - b);
    const expected = { ...beforeSame };
    const shuffled = eligible.map((seat) => beforeSame[seat]);
    for (let index = shuffled.length - 1; index > 0; index--)
      [shuffled[index], shuffled[0]] = [shuffled[0], shuffled[index]];
    eligible.forEach((seat, index) => {
      expected[seat] = shuffled[index];
    });
    await triple(7, 0);
    await expect.poll(shown).toEqual(expected);
    await expect.poll(() => preview(state.latest().state.setup.setup)).toEqual(expected);
    assert.equal(state.latest().state.setup.setup.assignments[2], beforePool.assignments[2]);
    const saved = checkpoint(state);
    await page.getByRole("button", { name: "Open developer menu" }).click();
    await page.getByRole("button", { name: "Disable dev mode" }).click();
    await expect(page.locator(".role-badge")).toHaveCount(2);
    await expect(page.locator(".role-draw-preview-indicator")).toHaveCount(0);
    unchanged(state, saved, `${tag}: disabling preview must not save`);
    assert.equal(state.writes.length, saved.writeCount, `${tag}: disabling preview caused a save`);
    await page.getByRole("button", { name: "Enable dev mode" }).click();
    await page.getByRole("button", { name: "Close developer menu" }).click();
    await page.reload();
    await roleHeading(page, "en", tag);
    same(await shown(), expected, `${tag}: preview reload`);
    assert.equal(await turns(), 0, `${tag}: reload replayed a flip`);
    for (const role of ["citizen", "sheriff", "mafia", "don"]) {
      const number = Number(Object.keys(expected).find((seat) => expected[seat] === role));
      if ((await card(number).getAttribute("data-role-dealt")) !== "true") {
        await card(number).click();
        await settle();
      }
      const visual = await card(number).evaluate((node) => ({
        scale: getComputedStyle(node).scale,
        color: getComputedStyle(node).getPropertyValue("--role-draw-rgb").trim(),
        glow: getComputedStyle(node.querySelector(".role-draw-glow")).backgroundImage,
        glyph: node.querySelector("[data-role-glyph]").dataset.roleGlyph,
        rotate: getComputedStyle(node).rotate,
      }));
      assert.equal(visual.scale, "1.04");
      assert.equal(visual.glyph, role);
      assert.equal(
        visual.color,
        role === "citizen" || role === "sheriff" ? "118 205 255" : "255 95 79",
      );
      assert.notEqual(visual.glow, "none");
      assert.equal(visual.rotate, "none");
    }
    if (mode === "enhanced")
      await expect(page.locator(".app-shell")).toHaveAttribute("data-glass-status", "ready");
    if (mode === "fallback")
      await expect(page.locator(".app-shell")).not.toHaveAttribute("data-glass-status", "ready");
    await page.screenshot({ path: path.join(evidence, `${tag}-roles.png`) });
    for (let number = 1; number <= 10; number++) {
      if ((await card(number).getAttribute("data-role-dealt")) !== "true") {
        await card(number).click();
      }
    }
    await settle();
    await expect
      .poll(() => Object.keys(state.latest()?.state.setup?.setup?.assignments ?? {}).length)
      .toBe(10);
    const fullDeal = checkpoint(state);
    const flipsBeforeFullReroll = await turns();
    for (let tap = 0; tap < 3; tap++) await card(7).click();
    assert.equal(await turns(), flipsBeforeFullReroll, `${tag}: fully dealt reroll flipped`);
    unchanged(state, fullDeal, `${tag}: fully dealt reroll changed the deck`);
    assert.equal(state.writes.length, fullDeal.writeCount, `${tag}: fully dealt reroll saved`);
    await page.locator(".table-advance button").click();
    await expect.poll(() => state.latest()?.state.game?.phase).toBe("mafia-planning");
    await expect(
      page.locator(".role-draw-card, .role-draw-preview-indicator, [data-role-glyph]"),
    ).toHaveCount(0);
    const hide = page.getByRole("button", { name: "Hide private info", exact: true });
    if (await hide.isVisible()) await hide.click();
    // Existing phase privacy keeps the opening/night roles visible, but masks
    // daytime roles and counts; Dev preview must not override that boundary.
    await expect(page.locator(".role-badge")).toHaveCount(10);
    await page.getByRole("button", { name: "Mafia asleep" }).click();
    await page.getByRole("button", { name: "Begin round zero" }).click();
    await expect.poll(() => state.latest()?.state.game?.phase).toBe("day");
    await expect(
      page.locator(".role-badge, .role-draw-card, .role-draw-preview-indicator, [data-role-glyph]"),
    ).toHaveCount(0);
    await expect(page.locator(".team-counts")).toHaveAttribute("aria-label", /hidden/);
    await expect(
      page.locator(".is-mafia-shooter, .is-sheriff-highlight, .is-night-check-highlight"),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Show private info", exact: true }).click();
    await expect(page.locator(".role-badge")).toHaveCount(10);
    await hide.click();
    await expect(page.locator(".role-badge")).toHaveCount(0);
    await page.screenshot({ path: path.join(evidence, `${tag}-day-private.png`) });
    state.ensureClean();
    same(errors, [], `${tag}: browser exceptions`);
    console.log(`PASS ${tag}`);
  } catch (error) {
    await page.screenshot({ path: path.join(evidence, `${tag}-failure.png`) }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

async function scenario(browser, browserName, viewport, language) {
  const tag = `${browserName}-${viewport.width}x${viewport.height}-${language}`;
  if (requestedCase && requestedCase !== tag) return;
  executedCases.push(tag);
  const context = await browser.newContext({ viewport, hasTouch: browserName === "chromium" });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const cdp = browserName === "chromium" ? await context.newCDPSession(page) : null;
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
    await expect.poll(() => pickerValue(input(page, 1))).not.toBe("");
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
    await popupBrowse(page, language, tag);
    unchanged(state, initialSnapshot, `${tag}: browse/dismiss preserved roster`);
    same(
      initialSnapshot.state.setup.selectedPlayerIds.map(
        (id) => players.find((p) => p.id === id)?.nickname,
      ),
      initial,
      `${tag}: fixture/player UI disagree`,
    );

    // Native typing is provisional; custom Escape reset is retired. Blur still cancels.
    const picker = input(page, 1);
    const oldName = initial[0];
    await picker.click();
    await expect(picker).toHaveJSProperty("tagName", "BUTTON");
    await expect(picker).toHaveAttribute("aria-expanded", "true");
    const search = page.getByRole("searchbox");
    await expect(search).not.toBeFocused();
    await search.click();
    await search.fill("UI Player 999");
    await search.press("Escape");
    // Chromium clears type=search natively; WebKit may retain the query. Neither
    // engine should invoke the removed app-owned reset to the selected nickname.
    await expect(search).not.toHaveValue(oldName);
    assert.equal(await pickerValue(picker), oldName, `${tag}: query changed committed name`);
    await expect(picker).toHaveAttribute("aria-expanded", "true");
    unchanged(state, initialSnapshot, `${tag}: retired picker Escape`);
    await search.fill("UI Player 999");
    await page.locator(".player-setup-card h1").click();
    await expect.poll(() => pickerValue(picker)).toBe(oldName);
    await picker.click();
    await picker.press("ArrowDown");
    assert.equal(
      await picker.getAttribute("aria-activedescendant"),
      null,
      `${tag}: no authored option navigation`,
    );
    const sameIdentityOption = page.getByRole("option", { name: oldName, exact: true });
    await sameIdentityOption.press("Enter");
    unchanged(state, initialSnapshot, `${tag}: cancelled/same picker`);
    await page.locator("#host-player").click();
    await expect(page.locator("#host-player-suggestions")).toBeVisible();
    // The host popup correctly obscures top-row handles; start on an uncovered seat.
    await dragMouse(page, 4, 4, "same", async () => {
      await expect(page.getByRole("listbox")).toHaveCount(0);
    });
    unchanged(state, initialSnapshot, `${tag}: same-seat drop`);
    await dragMouse(page, 1, null, "outside");
    unchanged(state, initialSnapshot, `${tag}: outside drop`);
    await handle(page, 1).evaluate((element) => {
      element.addEventListener(
        "gotpointercapture",
        (event) => {
          element.dataset.verifierPointerId = String(event.pointerId);
        },
        { once: true },
      );
    });
    await dragMouse(page, 1, 2, "target", async () => {
      await handle(page, 1).evaluate((element) => {
        const pointerId = Number(element.dataset.verifierPointerId);
        if (!element.hasPointerCapture(pointerId)) throw new Error("Expected real handle capture");
        element.addEventListener(
          "lostpointercapture",
          (event) => {
            element.dataset.verifierCaptureLoss = String(event.isTrusted);
          },
          { once: true },
        );
        element.releasePointerCapture(pointerId);
      });
    });
    await expect(handle(page, 1)).toHaveAttribute("data-verifier-capture-loss", "true");
    unchanged(state, initialSnapshot, `${tag}: genuine capture loss`);

    // Partial-seat move: only the target empties before the drag; this is
    // checked separately from a full swap and never interprets a blank as swap.
    await seat(page, 3).locator(".player-combobox-clear").click();
    await expect.poll(() => pickerValue(input(page, 3))).toBe("");
    await expect
      .poll(() => state.latest()?.state.setup?.selectedPlayerIds[2], { timeout: 15000 })
      .toBe("");
    const beforeMove = checkpoint(state);
    await dragMouse(page, 3, 1);
    unchanged(state, beforeMove, `${tag}: empty drag source`);
    const beforeMoveNames = await roster(page);
    const first = beforeMoveNames[0];
    await dragMouse(page, 1, 3, "target", async () => {
      await expect(page.getByRole("listbox")).toHaveCount(0);
      same(await roster(page), beforeMoveNames, `${tag}: pointer move committed early`);
      unchanged(state, beforeMove, `${tag}: pointer move persisted early`);
    });
    const movedIds = [...beforeMove.state.setup.selectedPlayerIds];
    [movedIds[0], movedIds[2]] = [movedIds[2], movedIds[0]];
    await expect
      .poll(() => state.latest()?.state.setup?.selectedPlayerIds, { timeout: 15000 })
      .toEqual(movedIds);
    // WebKit can leave the empty search field focused after the drop. Its
    // provisional query clears on native blur, independently of the saved move.
    await page.locator(".player-setup-card h1").click();
    await expect.poll(() => pickerValue(input(page, 3))).toBe(first);
    await expect.poll(() => pickerValue(input(page, 1))).toBe("");
    const moved = snapshot(state);
    assert.equal(moved.gameId, beforeMove.gameId, `${tag}: empty move changed game ID`);
    assert.equal(
      moved.state.setup.hostPlayerId,
      beforeMove.state.setup.hostPlayerId,
      `${tag}: empty move changed host`,
    );
    assert.equal(moved.state.setup.setup, null, `${tag}: empty move retained a deal`);
    for (const write of state.writes.slice(beforeMove.writeCount)) {
      const ids = write.state.setup?.selectedPlayerIds;
      if (ids) same(ids, movedIds, `${tag}: transient half-move or wrong-seat update`);
    }
    await page.screenshot({ path: path.join(evidence, `${tag}-empty-move.png`), fullPage: true });
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
    await expect(page.locator(".player-setup-card h1")).not.toHaveAttribute("tabindex");
    await expect(page.locator(".player-setup-card h1")).toHaveText(labels[language].setup);
    await expect.poll(() => state.latest()?.state.setup?.step).toBe("players");
    const beforeDealNoop = checkpoint(state);
    const seatName = await pickerValue(input(page, 1));
    await input(page, 1).click();
    await page.getByRole("searchbox").click();
    await page.getByRole("searchbox").fill("UI Player 999");
    await page.getByRole("searchbox").press("Escape");
    await expect(page.getByRole("searchbox")).not.toHaveValue(seatName);
    assert.equal(await pickerValue(input(page, 1)), seatName, `${tag}: dealt query changed name`);
    await page.locator(".player-setup-card h1").click();
    await expect.poll(() => pickerValue(input(page, 1))).toBe(seatName);
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
    await input(page, 2).click();
    await expect(page.locator("#seat-2-player-suggestions")).toBeVisible();
    await dragMouse(page, 1, 4, "target", async () => {
      await expect(page.getByRole("listbox")).toHaveCount(0);
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
    await roleCorrections(page, state, language, tag, cdp);
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
    await noDeviationUI(page);
    await expect(page.getByRole("button", { name: labels[language].start })).toBeEnabled();
    await page.getByRole("button", { name: labels[language].start }).click();
    await expect(roleCard(page, 10)).toBeDisabled();
    for (let seat = 1; seat <= 9; seat += 1) await roleCard(page, seat).click();
    await page.locator(".table-advance button").click();
    await expect.poll(() => state.latest()?.state.game?.phase).toBe("mafia-planning");
    await noDeviationUI(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".game-shell:not(.role-draw-screen) .game-header h1")).toBeVisible();
    await noDeviationUI(page);
    state.ensureClean();
    same(errors, [], `${tag}: browser exceptions`);
    console.log(
      `PASS ${tag}: seat corrections, picker/drag arbitration, genuine capture-loss recovery, triple-tap reroll, ${cdp && process.env.UI_SETUP_ROLE_INPUT !== "pointer" ? "trusted touch left/right swipes" : "trusted pointer left/right swipes"}, clear/select, native Enter/Space, retired keys inert, full-deal reload/readback, Casper/live without deviation prompts; ${JSON.stringify({ gameId: drawn.gameId, viewport: layout.viewport })}`,
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

async function setupControlsScenario(browser, engine, mode, width = 1000) {
  const tag = `setup-controls-${engine}-${mode}-${width}`;
  if (requestedCase && requestedCase !== tag) return;
  executedCases.push(tag);
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    hasTouch: true,
    reducedMotion: mode === "reduced" ? "reduce" : "no-preference",
  });
  if (mode === "fallback")
    await context.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
        return /webgl/.test(kind) ? null : getContext.call(this, kind, ...args);
      };
    });
  const page = await context.newPage();
  const state = fixture(page, "en");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await state.routeReady;
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await enterSetup(page);
    await expect(page.locator(".tournament-picker--compact")).toHaveCount(1);
    const header = page.locator(".player-setup-heading");
    const host = page.locator("#host-player");
    await page.evaluate(() => document.fonts.ready);
    const hostLayout = () =>
      host.evaluate((el) => {
        const card = el.closest(".player-setup-card");
        return {
          top: el.getBoundingClientRect().top + card.scrollTop - card.getBoundingClientRect().top,
          panelHeight: card.getBoundingClientRect().height,
        };
      });
    const offHost = await hostLayout();
    const casper = await header.locator(".casper-toggle").boundingBox();
    const tournamentSwitch = await header.locator(".tournament-picker-toggle").boundingBox();
    if (width >= 700)
      assert.ok(
        casper.x + casper.width <= tournamentSwitch.x &&
          Math.abs(casper.y - tournamentSwitch.y) < 2,
        `${tag}: tournament and Casper switches must be alongside`,
      );
    await page.locator(".tournament-picker-toggle").click();
    await expect(page.getByRole("switch", { name: "Include in tournament" })).toBeChecked();
    await expect(page.getByRole("combobox", { name: "Tournament", exact: true })).toBeVisible();
    // Read rect and scroll atomically: native focus may scroll the internal card.
    const onHost = await hostLayout();
    if (width >= 700) {
      assert.ok(
        Math.abs(onHost.top - offHost.top) < 1,
        `${tag}: tournament toggle must not move host within layout: ${JSON.stringify({ offHost, onHost })}`,
      );
      assert.equal(
        onHost.panelHeight,
        offHost.panelHeight,
        `${tag}: tournament controls expanded outer panel`,
      );
    }
    await page.getByRole("button", { name: "New tournament…", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New tournament…", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveJSProperty("tagName", "DIALOG");
    await page.getByRole("textbox", { name: "Tournament name" }).fill("Cancelled fixture draft");
    await page.getByRole("textbox", { name: "Tournament name" }).press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Tournament", exact: true })).toHaveValue("");
    await page.getByRole("button", { name: "New tournament…", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Tournament name" })).toHaveValue("");
    await page
      .getByRole("textbox", { name: "Tournament name" })
      .fill("Owned local fixture tournament");
    await page.getByRole("button", { name: "Create tournament", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Tournament", exact: true })).toHaveValue(
      uuid(200),
    );
    await expect.poll(() => [...state.sessions.values()].at(-1)?.tournamentId).toBe(uuid(200));
    await header.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(evidence, `${tag}-header.png`), fullPage: true });
    // Return the fixture metadata to its ordinary non-tournament setup before checking the roster.
    await page.locator(".tournament-picker-toggle").click();
    await expect(page.getByRole("switch", { name: "Include in tournament" })).not.toBeChecked();
    await expect.poll(() => [...state.sessions.values()].at(-1)?.tournamentId).toBe(null);
    await page.getByRole("button", { name: labels.en.select }).click();
    const choices = page.locator(".availability-player-card[data-availability-state='unselected']");
    await expect(choices).toHaveCount(11);
    for (let n = 0; n < 11; n += 1) await choices.first().click();
    await page.locator(".availability-close-button").click();
    await host.tap();
    await expect(page.getByRole("searchbox")).not.toBeFocused();
    await expect(page.getByRole("option")).toHaveCount(11);
    await page.getByRole("searchbox").tap();
    await page.getByRole("searchbox").pressSequentially("UI Player 11");
    await expect(page.getByRole("option")).toHaveCount(1);
    await page.getByRole("option").last().scrollIntoViewIfNeeded();
    await page.getByRole("option", { name: "UI Player 11", exact: true }).tap();
    await awaitSave(page, state);
    // WebKit mouse activation blurs a searched input to null before option click.
    // Exercise an empty seat with actual typing and a trusted mouse click, not just touch/browse.
    await input(page, 1).click();
    await page.getByRole("searchbox").click();
    await page.getByRole("searchbox").pressSequentially("UI Player 1");
    await page.getByRole("option", { name: "UI Player 1", exact: true }).click();
    await expect.poll(() => pickerValue(input(page, 1))).toBe("UI Player 1");
    await expect.poll(() => state.latest()?.state.setup?.selectedPlayerIds[0]).toBe(players[0].id);
    await page.getByRole("button", { name: labels.en.assign }).click();
    await geometry(page, tag, "en");
    await popupBrowse(page, "en", tag);
    if (width >= 700)
      await dragMouse(page, 2, 7, "target", async () => {
        if (mode === "reduced")
          assert.equal(
            await seat(page, 7)
              .locator(".setup-seat-content")
              .evaluate((el) => getComputedStyle(el).transitionDuration),
            "0s",
          );
        await page.screenshot({
          path: path.join(evidence, `${tag}-swap-preview.png`),
          fullPage: true,
        });
      });
    await header.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(evidence, `${tag}-populated.png`), fullPage: true });
    state.ensureClean();
    same(errors, [], `${tag}: browser exceptions`);
    console.log(
      `PASS ${tag}: native compact tournament create/cancel, stable header, real geometry, popup clipping and swap preview`,
    );
  } catch (error) {
    await page.screenshot({ path: path.join(evidence, `${tag}-failure.png`), fullPage: true });
    throw error;
  } finally {
    await context.close();
  }
}

async function touchScenario(browser, language) {
  const tag = `chromium-touch-1000x600-${language}`;
  if (requestedCase && requestedCase !== tag) return;
  executedCases.push(tag);
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
    const host = page.locator("#host-player");
    await host.tap();
    await expect(host).toHaveJSProperty("tagName", "BUTTON");
    await expect(page.getByRole("searchbox")).not.toBeFocused();
    await page.getByRole("searchbox").tap();
    await expect(page.getByRole("searchbox")).toBeFocused();
    await page.getByRole("searchbox").fill("UI Player 11");
    await page.getByRole("option", { name: "UI Player 11", exact: true }).tap();
    await page.getByRole("button", { name: labels[language].assign }).click();
    await expect.poll(() => pickerValue(input(page, 2))).not.toBe("");
    await awaitSave(page, state);
    await expect
      .poll(() => state.latest()?.state.setup?.selectedPlayerIds.filter(Boolean).length)
      .toBe(10);
    const original = await roster(page);
    const beforeCancel = checkpoint(state);
    await touch(page, cdp, 1, 2, true);
    same(await roster(page), original, `${tag}: CDP touchCancel changed roster`);
    unchanged(state, beforeCancel, `${tag}: CDP touchCancel`);
    // A second real contact cancels the handle's gesture, including when it
    // lands on a picker rather than another handle. The next single drag works.
    await handle(page, 1).scrollIntoViewIfNeeded();
    const start = await center(handle(page, 1));
    const second = await center(input(page, 2));
    const destination = await center(seat(page, 2));
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ ...start, id: 1 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { ...start, id: 1 },
        { ...second, id: 2 },
      ],
    });
    await expect(page.locator(".setup-seat-card.is-dragging")).toHaveCount(0);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { ...destination, id: 1 },
        { ...second, id: 2 },
      ],
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    same(await roster(page), original, `${tag}: second contact changed roster`);
    unchanged(state, beforeCancel, `${tag}: second contact must cancel`);
    const beforeTouch = checkpoint(state);
    await touch(page, cdp, 1, 2, false, async () => {
      same(await roster(page), original, `${tag}: touch move committed before lift`);
      unchanged(state, beforeTouch, `${tag}: touch move persisted before lift`);
    });
    const swapped = [...original];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    await expect.poll(() => pickerValue(input(page, 1))).toBe(swapped[0]);
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
    console.log(
      `PASS ${tag}: trusted CDP touch swap/cancel, second-contact cancellation and fresh-drag recovery, scroll if overflow`,
    );
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
    for (const mode of ["enhanced", "fallback", "reduced"]) {
      await setupControlsScenario(chrome, "chromium", mode);
      await setupControlsScenario(safari, "webkit", mode);
      await rolePreviewScenario(chrome, "chromium", mode);
      await rolePreviewScenario(safari, "webkit", mode);
    }
    await setupControlsScenario(chrome, "chromium", "enhanced", 650);
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
assert.ok(executedCases.length > 0, `Unknown UI_SETUP_CASE: ${requestedCase}`);
console.log(`Setup cases executed: ${JSON.stringify(executedCases)}`);
console.log(`Setup seat verifier PASS; screenshots: ${evidence}`);
