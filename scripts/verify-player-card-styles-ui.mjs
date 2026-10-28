/**
 * Actual App scenario; imported only by verify-ui.mjs (no second server/mock shell).
 * UI_PLAYER_CARDS_ONLY=1 APP_URL=http://127.0.0.1:5186 node scripts/verify-ui.mjs
 * Freeze source first. Run Chromium 1366x768 / 1000x600, WebKit 1366x1024.
 * Evidence proves local browser + exact-origin mock API, not production persistence.
 */
/* global URL, localStorage, document, getComputedStyle, innerWidth, innerHeight, fetch, Image */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import * as domain from "../packages/game-domain/src/index.ts";
import { getActiveBranch } from "../apps/web/src/features/game/game-history.ts";
import { isCurrentGameSessionState } from "../apps/web/src/session-outbox.ts";
import { PLAYER_CARD_PREFERENCES_KEY } from "../apps/web/src/features/theme/player-card-preferences.ts";
import { assertCanonicalProjection } from "./ui-presentation-contracts.mjs";
import { assertExactOrigin } from "./session-verifier-contracts.mjs";
import {
  checkpoint,
  currentSetupState,
  envelope,
  openPlayerPenalty,
} from "./verify-federation-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const sessionKey = "mafia-dashboard.game-session.v5";
const styles = ["glass", "classic", "heritage", "noir"];
const placements = ["below", "ribbon", "top"];
const words = {
  en: {
    style: "Player card style",
    placement: "Role placement",
    open: "Open Manage menu",
    close: "Close Manage menu",
    hide: "Hide private info",
    show: "Show private info",
    undo: /^Undo last action/,
    confirmUndo: "Undo",
    roles: { citizen: "citizen", mafia: "mafia", don: "don", sheriff: "sheriff" },
  },
  ru: {
    style: "Стиль карточек игроков",
    placement: "Расположение роли",
    open: "Открыть меню управления",
    close: "Закрыть меню управления",
    hide: "Скрыть личную информацию",
    show: "Показать личную информацию",
    undo: /^Отменить последнее действие/,
    confirmUndo: "Отменить",
    roles: { citizen: "Мирный житель", mafia: "Мафия", don: "Дон", sheriff: "Шериф" },
  },
};

/** Every non-setup seed is a real domain transition chain + existing checkpoint. */
export function playerCardFixture(players, gameId, stage = "day") {
  assert.ok(players.length >= 11, "Ten seated players and a separate host are required");
  assert.equal(
    new Set(players.slice(0, 11).map(({ id }) => id)).size,
    11,
    "Ten distinct seated identities and a separate host are required",
  );
  assert.ok(
    ["day", "roles", "night-result", "goodbye", "departed"].includes(stage),
    `Unknown player-card fixture ${stage}`,
  );
  let draw = domain.beginRoleDraw(
    domain.createSetup(
      players.slice(0, 10).map((p, i) => ({
        id: p.id,
        seat: i + 1,
      })),
    ),
    domain.createSeededRandom(71),
  );
  const template = { ...currentSetupState(), hostPlayerId: players[10].id };
  if (stage === "roles") {
    const state = {
      ...template,
      setup: {
        step: "roles",
        hostPlayerId: players[10].id,
        selectedPlayerIds: players.slice(0, 10).map(({ id }) => id),
        setup: draw,
      },
    };
    assert.equal(isCurrentGameSessionState(state), true);
    return { state, victimSeat: null };
  }
  for (let seat = 1; seat <= 10; seat++) draw = domain.drawRoleForSeat(draw, seat);
  let game = domain.createGame(domain.completeRoleDraw(draw), { bestMoveEnabled: false });
  while (game.phase !== "day") game = domain.advanceSetupPhase(game);
  const victimSeat = game.players.find(({ role }) => role === "citizen").seat;
  if (stage !== "day") {
    game = domain.beginNight(game);
    for (const shooter of game.players.filter(({ team }) => team === "black"))
      game = domain.recordMafiaShot(game, shooter.seat, victimSeat);
    game = domain.resolveMafiaShots(game).game;
    game = domain.completeMafiaShots(game);
    if (stage !== "night-result") {
      game = domain.skipDonCheck(game);
      game = domain.skipSheriffCheck(game);
      game = domain.completeNight(game);
      if (stage === "departed") game = domain.completeGoodbyeSpeech(game);
    }
  }
  const state = checkpoint(game, { ...template, setup: null }, gameId);
  assert.equal(isCurrentGameSessionState(state), true);
  assertCanonicalProjection(domain, getActiveBranch, state);
  return { state, victimSeat };
}

// Hash all owning App/table/theme/localization/artwork and domain sources, including
// newly added files. A changed/added/deleted source invalidates the entire receipt.
export async function playerCardSourceManifest() {
  const files = [];
  async function walk(relative) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(name);
      else files.push(name);
    }
  }
  await walk("apps/web/src");
  await walk("packages/game-domain/src");
  files.push(
    "scripts/verify-ui.mjs",
    "scripts/verify-player-card-styles-ui.mjs",
    "scripts/ui-presentation-contracts.mjs",
  );
  return Object.fromEntries(
    await Promise.all(
      files.sort().map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(path.join(root, file)))
          .digest("hex"),
      ]),
    ),
  );
}

export async function runPlayerCardStyleScenarios({
  page,
  baseUrl,
  club,
  players,
  api,
  evidenceDir,
}) {
  const origin = new URL(baseUrl).origin;
  assert.match(
    new URL(baseUrl).hostname,
    /^(localhost|127\.0\.0\.1|\[::1\])$/,
    "Local App fixture only",
  );
  const evidence = path.resolve(root, evidenceDir);
  await mkdir(evidence, { recursive: true });
  const report = {
    origin,
    browser: page.context().browser().browserType().name(),
    viewport: page.viewportSize(),
    provenance: "actual App; shared exact-origin API fixture; synthetic YouTube",
    sourceBefore: await playerCardSourceManifest(),
    cases: [],
    screenshots: [],
    status: "running",
  };
  const originalLanguage = club.language;
  const transportErrors = [];
  const onResponse = (response) => {
    if (response.status() >= 400)
      transportErrors.push(`HTTP ${response.status()} ${response.url()}`);
  };
  page.on("response", onResponse);
  const originalNames = players.slice(0, 2).map(({ nickname }) => nickname);
  players[0].nickname = "Alexandria de la Verdad — exceptionally long player name";
  players[1].nickname = "Александра-Екатерина ОченьДлинноеИмя Игрока";
  let locale = "en";
  const card = (seat) => page.locator(`.seat-anchor[data-seat="${seat}"] .player-seat`);
  const allCards = () => page.locator(".player-seat");
  const read = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), sessionKey);
  async function saved() {
    await expect(page.locator('.save-indicator[data-status="saved"]')).toBeVisible();
    await expect
      .poll(
        async () => {
          const current = await read();
          return (
            !!current?.current &&
            current.outbox.length === 0 &&
            !current.failed &&
            JSON.stringify(api.sessions.get(current.gameId)?.state) ===
              JSON.stringify(current.current.state)
          );
        },
        { message: "Browser state and shared API fixture settle exactly" },
      )
      .toBe(true);
    const value = await read();
    assert.ok(value?.current?.state, "Persisted current App envelope required");
    assert.equal(value.outbox.length, 0);
    assert.equal(value.failed, false);
    assert.equal(isCurrentGameSessionState(value.current.state), true);
    if (value.current.state.game)
      assertCanonicalProjection(domain, getActiveBranch, value.current.state);
    const remote = await page.evaluate(async (id) => {
      const response = await fetch(`/api/game-sessions/${id}`, { credentials: "include" });
      if (!response.ok) throw new Error(`Readback HTTP ${response.status}`);
      return response.json();
    }, value.gameId);
    assert.deepEqual(remote.session.state, value.current.state, "Exact HTTP fixture readback");
    assert.deepEqual(
      api.sessions.get(value.gameId)?.state,
      value.current.state,
      "Shared mock readback",
    );
    api.clean();
    return value.current.state;
  }
  async function settled() {
    await allCards().first().waitFor();
    await expect(allCards()).toHaveCount(10);
    await page.locator(".table-stage").evaluate(async (table) => {
      await document.fonts.ready;
      await Promise.all(
        table
          .getAnimations({ subtree: true })
          .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => {})),
      );
    });
    await expect(page.locator(".printed-player-card__outgoing")).toHaveCount(0);
  }
  async function seed(stage, { reset = false, invalidPreferences = false } = {}) {
    const id = randomUUID();
    const fixture = playerCardFixture(players, id, stage);
    api.sessions.clear();
    api.seed(id, fixture.state);
    await page.goto(new URL("/health/ready", origin).href);
    assertExactOrigin(page.url(), origin);
    await page.evaluate(
      ({ key, value, reset, invalidPreferences, preferenceKey }) => {
        if (reset) localStorage.clear();
        localStorage.setItem(key, JSON.stringify(value));
        if (invalidPreferences)
          localStorage.setItem(
            preferenceKey,
            JSON.stringify({ style: "not-a-deck", rolePlacement: "elsewhere" }),
          );
      },
      {
        key: sessionKey,
        value: envelope(club.id, id, fixture.state),
        reset,
        invalidPreferences,
        preferenceKey: PLAYER_CARD_PREFERENCES_KEY,
      },
    );
    club.language = locale;
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    assertExactOrigin(page.url(), origin);
    await expect(page.locator(".club-card-open, .app-shell").first()).toBeVisible();
    const clubCard = page.locator(".club-card-open");
    if (await clubCard.first().isVisible()) await clubCard.first().click();
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await settled();
    const restored = await saved();
    assert.deepEqual(
      restored.events,
      fixture.state.events,
      "Restoration does not invent canonical events",
    );
    assert.equal(restored.headEventId, fixture.state.headEventId);
    if (fixture.state.game)
      assert.equal(domain.hashGameState(restored.game), domain.hashGameState(fixture.state.game));
    else
      assert.deepEqual(
        restored.setup.setup,
        fixture.state.setup.setup,
        "Undealt assignments remain undecided after restoration",
      );
    return fixture;
  }
  async function manage(open) {
    await page
      .getByRole("button", { name: words[locale][open ? "open" : "close"], exact: true })
      .click();
    if (open)
      await expect(
        page.getByRole("combobox", { name: words[locale].style, exact: true }),
      ).toBeVisible();
  }
  async function choose(style, placement = "below") {
    const before = await saved();
    await manage(true);
    const select = page.getByRole("combobox", { name: words[locale].style, exact: true });
    assert.equal(await select.evaluate((el) => el.tagName), "SELECT", "Native style select");
    assert.deepEqual(
      await select.locator("option").evaluateAll((els) => els.map((el) => el.value)),
      styles,
    );
    await select.selectOption(style);
    if (style !== "glass") {
      const placementSelect = page.getByRole("combobox", {
        name: words[locale].placement,
        exact: true,
      });
      assert.equal(await placementSelect.evaluate((el) => el.tagName), "SELECT");
      assert.deepEqual(
        await placementSelect.locator("option").evaluateAll((els) => els.map((el) => el.value)),
        placements,
      );
      await placementSelect.selectOption(placement);
    }
    await manage(false);
    await settled();
    assert.deepEqual(
      await saved(),
      before,
      "Style/placement never mutate canonical or setup state",
    );
    assert.deepEqual(
      await page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)),
        PLAYER_CARD_PREFERENCES_KEY,
      ),
      { style, rolePlacement: placement },
    );
  }
  async function privacy(hide) {
    const before = await saved();
    await page
      .getByRole("button", { name: words[locale][hide ? "hide" : "show"], exact: true })
      .click();
    if (hide) {
      // Sample before waiting for the turn to finish. Privacy must sanitize even
      // outgoing aria-hidden faces; giveaway/private-night exemptions yield no backs.
      const earlyLeaks = await page
        .locator('.player-seat[data-card-face="back"]')
        .evaluateAll((cards) =>
          cards.flatMap((el) =>
            [
              ...el.querySelectorAll(
                ".printed-player-card__role,.player-role-icon,[data-role-glyph]",
              ),
            ].map((node) => node.outerHTML),
          ),
        );
      assert.deepEqual(
        earlyLeaks,
        [],
        "Privacy strips role-bearing DOM before animation completes",
      );
    }
    await settled();
    assert.deepEqual(await saved(), before, "Privacy never mutates canonical or setup state");
  }
  async function inventory(style, { backs = [], allBacks = false } = {}) {
    await settled();
    const rows = await allCards().evaluateAll(async (cards) => {
      return Promise.all(
        cards.map(async (el) => {
          const urls = [...el.querySelectorAll("img")].map((img) => img.currentSrc || img.src);
          for (const node of [el, ...el.querySelectorAll("*")]) {
            const bg = getComputedStyle(node).backgroundImage;
            for (const match of bg.matchAll(/url\(["']?(.*?)["']?\)/g)) urls.push(match[1]);
          }
          const artwork = [
            ...new Set(urls.filter((url) => /player-cards|face-\d|back[.-]/.test(url))),
          ];
          const decoded = await Promise.all(
            artwork.map(async (src) => {
              const image = new Image();
              image.src = src;
              await image.decode();
              if (!image.naturalWidth || !image.naturalHeight)
                throw new Error(`Undecoded card ${src}`);
              return { url: src, width: image.naturalWidth, height: image.naturalHeight };
            }),
          );
          return {
            seat: Number(el.closest(".seat-anchor").getAttribute("data-seat")),
            style: el.getAttribute("data-card-style"),
            face: el.getAttribute("data-card-face"),
            tag: el.tagName,
            role: el.getAttribute("role"),
            glass:
              el.hasAttribute("data-player-glass") ||
              !!el.querySelector("[data-player-glass],.liquid-card-glass"),
            icons: el.querySelectorAll(".player-role-icon,[data-role-glyph]").length,
            crosses: el.querySelectorAll(
              ".deceased-cross,.player-deceased-cross,[data-deceased-cross]",
            ).length,
            roleBadges: el.querySelectorAll(".role-badge,.printed-player-card__role").length,
            emptyRails: [
              ...el.querySelectorAll(".card-nomination-status,.card-discipline-status"),
            ].filter(
              (node) => node.childElementCount === 0 && getComputedStyle(node).display !== "none",
            ).length,
            text: el.textContent,
            attrs: [el, ...el.querySelectorAll("*")].flatMap((node) =>
              [...node.attributes]
                .filter((a) => /^(aria-label|title|alt|data-.*role.*|data-.*glyph.*)$/.test(a.name))
                .map((a) => [a.name, a.value]),
            ),
            decoded,
          };
        }),
      );
    });
    assert.equal(rows.length, 10);
    for (const row of rows) {
      assert.equal(row.style, style);
      assert.ok(
        row.tag === "BUTTON" || row.role === "group",
        "Preserved native action/read-only host",
      );
      if (style === "glass") {
        assert.equal(row.glass, true, "Glass retains its existing material host");
        continue;
      }
      assert.equal(row.glass, false, "Printed paper has no optical Glass layer");
      assert.equal(row.icons, 0, "Printed art cannot inherit custom role glyphs");
      assert.equal(row.crosses, 0, "Printed departures use a neutral back, never a cross");
      assert.equal(row.emptyRails, 0, "Empty status rails must not paint blank paper patches");
      const back = allBacks || backs.includes(row.seat);
      assert.equal(row.face, back ? "back" : "front", `Seat ${row.seat} expected face`);
      assert.ok(row.decoded.length > 0, "Printed artwork must be a decoded Vite URL asset");
      for (const image of row.decoded) {
        assertExactOrigin(image.url, origin);
        assert.ok(!image.url.startsWith("data:"));
      }
      if (back) {
        assert.equal(row.roleBadges, 0, "No role badges on the reverse, even aria-hidden ones");
        const leaks = [row.text, ...row.attrs.map(([, value]) => value)].join("\n");
        assert.doesNotMatch(
          leaks,
          /citizen|sheriff|\bmafia\b|\bdon\b|мирн|мафи|шериф|\bдон\b/i,
          `Seat ${row.seat} reverse leaks a role`,
        );
      }
    }
    if (style !== "glass") {
      // Compare the actually displayed side, not a preloaded opposite animation face.
      const fronts = rows
        .filter((row) => row.face === "front")
        .map((row) => row.decoded.map(({ url }) => url).filter((url) => !/\/back[.-]/.test(url)));
      if (fronts.length === 10)
        assert.equal(new Set(fronts.flat()).size, 10, "Ten distinct public-seat illustrations");
      const reverseUrls = rows
        .filter((row) => row.face === "back")
        .flatMap((row) => row.decoded.map(({ url }) => url));
      if (allBacks)
        assert.equal(new Set(reverseUrls).size, 1, "All reverse URLs identical within one deck");
    }
    return rows;
  }
  async function geometry() {
    return page.locator(".game-shell").evaluate((shell) => {
      const box = (el) => {
        const b = el.getBoundingClientRect();
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      };
      const cards = [...shell.querySelectorAll(".player-seat")].map((el) => {
        const b = box(el),
          x = b.x + b.width / 2,
          y = b.y + b.height / 2;
        return {
          ...b,
          seat: el.closest(".seat-anchor").getAttribute("data-seat"),
          layoutWidth: el.offsetWidth,
          layoutHeight: el.offsetHeight,
          hit: el.contains(document.elementFromPoint(x, y)),
          name: el.querySelector(
            ".printed-player-card__name,.player-name,.card-player-name,.card-name",
          )?.textContent,
        };
      });
      const actions = [
        ...shell.querySelectorAll(
          ".table-advance button,.seat-actions button,.table-center button",
        ),
      ]
        .filter((el) => el.getClientRects().length)
        .map((el) => {
          const b = box(el);
          return {
            ...b,
            label: el.getAttribute("aria-label") || el.textContent,
            hit: el.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)),
          };
        });
      return { shell: box(shell), cards, actions, width: innerWidth, height: innerHeight };
    });
  }
  function assertGeometry(value, baseline) {
    for (const row of value.cards) {
      assert.ok(
        row.width >= 44 && row.height >= 44 && row.hit,
        `Native card hit target ${row.seat}`,
      );
      assert.ok(
        row.x >= -1 &&
          row.y >= -1 &&
          row.x + row.width <= value.width + 1 &&
          row.y + row.height <= value.height + 1,
        `Card ${row.seat} must fit viewport`,
      );
      if (baseline) {
        const original = baseline.cards.find(({ seat }) => seat === row.seat);
        for (const prop of ["x", "y", "layoutWidth", "layoutHeight"])
          assert.ok(
            Math.abs(row[prop] - original[prop]) <= 1,
            `${prop}: style moved seat ${row.seat}`,
          );
      }
    }
    for (const b of value.actions)
      assert.ok(
        b.width >= 44 &&
          b.height >= 44 &&
          b.hit &&
          b.x >= -1 &&
          b.y >= -1 &&
          b.x + b.width <= value.width + 1 &&
          b.y + b.height <= value.height + 1,
        `Actual table action clipped: ${JSON.stringify(b)}`,
      );
    if (baseline) {
      assert.equal(
        value.actions.length,
        baseline.actions.length,
        "Style cannot add/remove native table actions",
      );
      for (const [index, action] of value.actions.entries()) {
        assert.equal(action.label, baseline.actions[index].label);
        for (const prop of ["x", "y", "width", "height"])
          assert.ok(
            Math.abs(action[prop] - baseline.actions[index][prop]) <= 1,
            `Style moved action ${action.label}`,
          );
      }
    }
  }
  async function capture(label, manageOpen = false) {
    const target = page.locator(manageOpen ? "#manage-menu-drawer" : ".game-shell");
    const file = path.join(evidence, `${label}.png`);
    await target.screenshot({ path: file, animations: "allow" });
    report.screenshots.push(path.relative(root, file));
  }
  async function roleLayout(placement) {
    const rows = await allCards().evaluateAll((cards) =>
      cards.map((el) => {
        const paper = el.querySelector(".printed-player-card");
        const current = paper.querySelector(".printed-player-card__current");
        const role = current.querySelector(".printed-player-card__role");
        const name = current.querySelector(".printed-player-card__name");
        const band = current.querySelector(".printed-player-card__name-band");
        const rect = (node) => {
          const b = node.getBoundingClientRect();
          return { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
        };
        return {
          placement: paper.getAttribute("data-role-placement"),
          role: rect(role),
          name: rect(name),
          band: rect(band),
          card: rect(el),
          inBand: band.contains(role),
          nameText: name.textContent,
          fullLabel: el.getAttribute("aria-label"),
        };
      }),
    );
    for (const row of rows) {
      assert.equal(row.placement, placement);
      assert.equal(row.inBand, placement === "ribbon");
      assert.ok(
        row.role.left >= row.card.left - 1 &&
          row.role.right <= row.card.right + 1 &&
          row.role.top >= row.card.top - 1 &&
          row.role.bottom <= row.card.bottom + 1,
        "Role remains within its native card",
      );
      if (placement === "top")
        assert.ok(row.role.bottom <= row.name.top + 1, "Top role precedes the name");
      else
        assert.ok(
          row.role.top >= row.name.bottom - 1,
          "Name and role remain separate readable lines",
        );
      assert.ok(
        row.fullLabel.includes(row.nameText),
        "Full long name remains in the action's accessible label",
      );
    }
    return rows;
  }
  async function eventCount(count) {
    await expect.poll(async () => (await read()).current.state.events.length).toBe(count);
  }

  async function undo() {
    const previousHead = (await read()).current.state.headEventId;
    await page.getByRole("button", { name: words[locale].undo }).click();
    const confirm = page.getByRole("button", { name: words[locale].confirmUndo, exact: true });
    if (await confirm.isVisible()) await confirm.click();
    await expect.poll(async () => (await read()).current.state.headEventId).not.toBe(previousHead);
    await settled();
    return saved();
  }
  async function gesture(seat, dy, dx = 0) {
    const target = card(seat);
    const b = await target.boundingBox();
    assert.ok(b);
    const x = b.x + b.width / 2,
      y = b.y + (dy > 0 ? 8 : b.height - 8);
    assert.ok(
      y + dy > 0 &&
        y + dy < page.viewportSize().height &&
        x + dx > 0 &&
        x + dx < page.viewportSize().width,
      "Gesture endpoint must fit viewport",
    );
    await target.evaluate((el) => {
      el.dataset.cardGestureTrace = "[]";
      for (const type of ["pointerdown", "pointerup", "touchstart", "touchend"])
        el.addEventListener(
          type,
          (event) => {
            const trace = JSON.parse(el.dataset.cardGestureTrace);
            trace.push({ type, trusted: event.isTrusted });
            el.dataset.cardGestureTrace = JSON.stringify(trace);
          },
          { once: true },
        );
    });
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 8 });
    await page.mouse.up();
    const trace = await target.evaluate((el) => JSON.parse(el.dataset.cardGestureTrace));
    assert.ok(
      trace.some((event) => event.type === "pointerup") && trace.every((event) => event.trusted),
      "Trusted native pointer gesture",
    );
    return trace;
  }
  try {
    for (locale of ["en", "ru"]) {
      await seed("day", { reset: true });
      const baseline = await geometry();
      assertGeometry(baseline);
      const glassBaseline = await inventory("glass");
      const pristine = await saved();
      for (const style of styles) {
        if (style !== "glass") await choose(style);
        else await expect(allCards().first()).toHaveAttribute("data-card-style", "glass");
        const faces = await inventory(style);
        const layout = await geometry();
        assertGeometry(layout, baseline);
        await capture(`${locale}-${style}-table`);
        await manage(true);
        await expect(
          page.getByRole("combobox", { name: words[locale].style, exact: true }),
        ).toHaveValue(style);
        await capture(`${locale}-${style}-manage`, true);
        await manage(false);
        if (style !== "glass") {
          const roleLayouts = [];
          for (const placement of placements) {
            await choose(style, placement);
            // Actual role labels are localized and remain associated with their seat.
            const state = await saved();
            for (const player of state.game.players) {
              await expect(
                card(player.seat).getByText(words[locale].roles[player.role], { exact: true }),
              ).toBeVisible();
            }
            roleLayouts.push({ placement, cards: await roleLayout(placement) });
            await capture(`${locale}-${style}-${placement}`);
          }
          report.cases.push({ locale, style, kind: "role-placement", layouts: roleLayouts });
          await privacy(true);
          const backs = await inventory(style, { allBacks: true });
          await capture(`${locale}-${style}-privacy`);
          await privacy(false);
          assert.deepEqual(
            (await inventory(style)).map(({ decoded }) => decoded),
            faces.map(({ decoded }) => decoded),
            "Privacy retains seat-keyed face URLs",
          );
          assert.equal(
            new Set(backs.flatMap(({ decoded }) => decoded.map(({ url }) => url))).size,
            1,
          );
        }
        await page.reload({ waitUntil: "networkidle" });
        await settled();
        await expect(allCards().first()).toHaveAttribute("data-card-style", style);
        await manage(true);
        await expect(
          page.getByRole("combobox", { name: words[locale].style, exact: true }),
        ).toHaveValue(style);
        if (style !== "glass")
          await expect(
            page.getByRole("combobox", { name: words[locale].placement, exact: true }),
          ).toHaveValue("top");
        await manage(false);
        assert.deepEqual(
          await saved(),
          pristine,
          "Gallery, privacy, placements and reload are canonical no-ops",
        );
        report.cases.push({
          locale,
          style,
          kind: "gallery",
          faces,
          geometry: layout,
          reload: true,
          placements: style === "glass" ? [] : placements,
          privacy: style !== "glass",
        });
      }
      await choose("glass", "top");
      const glassReturn = await inventory("glass");
      const roleIdentity = (rows) => rows.map(({ seat, icons, attrs }) => ({ seat, icons, attrs }));
      assert.deepEqual(
        roleIdentity(glassReturn),
        roleIdentity(glassBaseline),
        "Returning to Glass preserves its role glyphs and native labels",
      );
      assertGeometry(await geometry(), baseline);
      report.cases.push({ locale, kind: "return-to-glass" });

      await choose("classic");
      const night = await seed("night-result");
      await inventory("classic"); // private night victim is deliberately not public-deceased
      await privacy(true);
      await inventory("classic");
      await privacy(false);
      report.cases.push({ locale, kind: "private-night-exemption", victim: night.victimSeat });
      const goodbye = await seed("goodbye");
      await inventory("classic"); // pending goodbye remains a visible face
      const beforeGoodbye = await saved();
      const next = page.getByRole("button", {
        name:
          locale === "en"
            ? `Begin day ${beforeGoodbye.game.day - 1}`
            : `Начать день ${beforeGoodbye.game.day - 1}`,
        exact: true,
      });
      await expect(next).toHaveCount(1);
      await next.click();
      await eventCount(beforeGoodbye.events.length + 1);
      await settled();
      const afterGoodbye = await saved();
      assert.equal(afterGoodbye.game.phase, "day");
      assert.equal(
        afterGoodbye.events.length,
        beforeGoodbye.events.length + 1,
        "Goodbye accepted once",
      );
      await inventory("classic", { backs: [goodbye.victimSeat] });
      await privacy(true);
      await inventory("classic", { allBacks: true });
      await privacy(false);
      await inventory("classic", { backs: [goodbye.victimSeat] });
      const restored = await undo();
      assert.equal(domain.hashGameState(restored.game), domain.hashGameState(beforeGoodbye.game));
      await inventory("classic");
      report.cases.push({ locale, kind: "accepted-goodbye-and-undo", victim: goodbye.victimSeat });
    }

    // Actions use English once, not every style × locale × gesture combination.
    locale = "en";
    await seed("day", { reset: true });
    await choose("heritage");
    const day = await saved();
    const targetSeat = day.game.players.find(
      ({ seat }) => seat !== day.game.turnOrder[day.game.currentTurnIndex],
    ).seat;
    const target = card(targetSeat);
    const box = await target.boundingBox();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await eventCount(day.events.length + 1);
    const selected = await saved();
    assert.equal(
      selected.game.nominations.at(-1).candidateSeat,
      targetSeat,
      "Trusted tap preserves nomination selection",
    );
    await expect(target).toHaveClass(/is-nominated|is-nomination-selected/);
    await expect(target).toHaveAttribute("aria-pressed", "true");
    await privacy(true);
    const beforePreview = await saved();
    await page.getByRole("button", { name: "Open game log", exact: true }).click();
    await page
      .getByRole("button", {
        name: `Preview state after log #${selected.events.at(-1).sequence}`,
        exact: true,
      })
      .click();
    await expect(page.locator(".game-shell.is-history-preview")).toBeVisible();
    await expect(page.locator("button.player-seat")).toHaveCount(0);
    await expect(page.locator('.player-seat[role="group"]')).toHaveCount(10);
    await inventory("heritage", { allBacks: true });
    await capture("en-heritage-readonly-preview");
    await page.getByRole("button", { name: "Exit preview", exact: true }).click();
    assert.deepEqual(
      await saved(),
      beforePreview,
      "Read-only preview must not change the live game",
    );
    await privacy(false);
    report.cases.push({ kind: "read-only-preview" });
    await undo();
    const beforeFoul = await saved();
    const trace = await gesture(5, 72); // GameTable requires >44px and vertical/horizontal dominance >1.2.
    await eventCount(beforeFoul.events.length + 1);
    const fouled = await saved();
    assert.equal(fouled.events.length, beforeFoul.events.length + 1);
    assert.equal(fouled.events.at(-1).type, "foul.issued");
    assert.equal(fouled.game.players.find(({ seat }) => seat === 5).fouls, 1);
    await undo();
    const beforeRemoval = await saved();
    const { dialog } = await openPlayerPenalty(page, 5, {
      input: report.browser === "chromium" ? "touch" : "pointer",
    });
    await dialog.getByRole("combobox", { name: "Removal rule", exact: true }).selectOption("6.2.3");
    await dialog.getByRole("button", { name: "Confirm discipline", exact: true }).click();
    await eventCount(beforeRemoval.events.length + 1);
    const removed = await saved();
    assert.equal(removed.events.length, beforeRemoval.events.length + 1);
    assert.equal(removed.game.players.find(({ seat }) => seat === 5).status, "red-carded");
    await inventory("heritage", { backs: [5] });
    await privacy(true);
    const hiddenRestore = await undo();
    assert.equal(
      domain.hashGameState(hiddenRestore.game),
      domain.hashGameState(beforeRemoval.game),
    );
    await inventory("heritage", { allBacks: true });
    await privacy(false);
    await inventory("heritage");
    report.cases.push({
      kind: "trusted-selection-foul-removal-undo",
      trace,
      penaltyInput: report.browser === "chromium" ? "touch" : "pointer",
    });

    await seed("roles");
    await choose("noir");
    await inventory("noir", { allBacks: true });
    const beforeDraw = await saved();
    // Setup notifications are deliberately excluded from both event logs by
    // App.isAuxiliaryEvent. Observe real presentation requests without replacing
    // random dealing or handlers: a legitimate reroll may return the same role.
    const drawProbe = await card(1).evaluateHandle((el) => {
      const ids = new Set();
      const observer = new window.MutationObserver((records) => {
        for (const record of records) {
          if (record.oldValue !== null) ids.add(record.oldValue);
          const id = el.getAttribute("data-role-draw-flip");
          if (id !== null) ids.add(id);
        }
      });
      observer.observe(el, {
        attributes: true,
        attributeOldValue: true,
        attributeFilter: ["data-role-draw-flip"],
      });
      return { ids, observer };
    });
    await card(1).click();
    await expect.poll(() => drawProbe.evaluate(({ ids }) => ids.size)).toBe(1);
    await expect
      .poll(async () => Object.keys((await read()).current.state.setup.setup.assignments).length)
      .toBe(1);
    const drawn = await saved();
    assert.deepEqual(drawn.setup.setup, domain.drawRoleForSeat(beforeDraw.setup.setup, 1));
    assert.deepEqual(drawn.events, beforeDraw.events, "Setup precedes the canonical game log");
    assert.deepEqual(
      drawn.legacyLog,
      beforeDraw.legacyLog,
      "Auxiliary setup notifications are not persisted events",
    );
    await inventory("noir", { backs: [2, 3, 4, 5, 6, 7, 8, 9, 10] });
    const drawnUrl = (await inventory("noir", { backs: [2, 3, 4, 5, 6, 7, 8, 9, 10] }))[0].decoded;
    await card(1).click({ clickCount: 3, delay: 80 });
    await expect.poll(() => drawProbe.evaluate(({ ids }) => ids.size)).toBe(2);
    await settled();
    const drawRequests = await drawProbe.evaluate(({ ids, observer }) => {
      observer.disconnect();
      return [...ids];
    });
    await drawProbe.dispose();
    assert.equal(
      drawRequests.length,
      2,
      "One initial reveal and exactly one reroll after three accepted taps",
    );
    const rerolled = await saved();
    assert.deepEqual(Object.keys(rerolled.setup.setup.assignments), ["1"]);
    assert.deepEqual(
      [
        ...Object.values(rerolled.setup.setup.assignments),
        ...rerolled.setup.setup.remainingRoles,
      ].sort(),
      [...beforeDraw.setup.setup.remainingRoles].sort(),
      "Reroll preserves the complete role pool and every undealt seat",
    );
    assert.deepEqual(rerolled.legacyLog, drawn.legacyLog);
    assert.deepEqual(rerolled.events, drawn.events);
    assert.deepEqual(
      (await inventory("noir", { backs: [2, 3, 4, 5, 6, 7, 8, 9, 10] }))[0].decoded,
      drawnUrl,
      "Role reroll does not change the seat illustration",
    );
    // Reroll can legitimately return the same role. Force a different accepted
    // assignment through the actual horizontal correction menu, not random retries.
    const alternateRole = rerolled.setup.setup.remainingRoles.find(
      (role) => role !== rerolled.setup.setup.assignments[1],
    );
    assert.ok(alternateRole);
    await gesture(1, 0, 72);
    await page
      .getByRole("dialog", { name: "Choose role", exact: true })
      .getByRole("button", { name: `Assign ${alternateRole} to seat 1`, exact: true })
      .click();
    await expect
      .poll(async () => (await read()).current.state.setup.setup.assignments[1])
      .toBe(alternateRole);
    const correctedRole = await saved();
    assert.deepEqual(
      correctedRole.setup.setup,
      domain.assignRoleForSeat(rerolled.setup.setup, 1, alternateRole),
    );
    assert.deepEqual(correctedRole.legacyLog, rerolled.legacyLog);
    assert.deepEqual(correctedRole.events, rerolled.events);
    assert.equal(correctedRole.setup.setup.assignments[1], alternateRole);
    assert.notEqual(correctedRole.setup.setup.assignments[1], rerolled.setup.setup.assignments[1]);
    assert.deepEqual(
      (await inventory("noir", { backs: [2, 3, 4, 5, 6, 7, 8, 9, 10] }))[0].decoded,
      drawnUrl,
      "A confirmed role swap keeps the illustration seat-keyed",
    );
    await privacy(true);
    await inventory("noir", { backs: [2, 3, 4, 5, 6, 7, 8, 9, 10] }); // giveaway deliberately exempts role privacy
    await privacy(false);
    await capture("en-noir-partial-giveaway");
    report.cases.push({
      kind: "giveaway-reveal-reroll-seat-artwork",
      drawRequests,
      roleBefore: drawn.setup.setup.assignments[1],
      roleAfter: rerolled.setup.setup.assignments[1],
      correctedRole: alternateRole,
    });

    // Playwright has no cross-engine reduced-transparency option. Chromium's
    // native media emulation exercises the actual CSS (not a matchMedia stub).
    if (report.browser === "chromium") {
      const cdp = await page.context().newCDPSession(page);
      try {
        await cdp.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
        });
        assert.equal(
          await page.evaluate(
            () => globalThis.matchMedia("(prefers-reduced-transparency: reduce)").matches,
          ),
          true,
        );
        for (const style of styles.filter((value) => value !== "glass")) {
          await choose(style);
          await inventory(style, { backs: [2, 3, 4, 5, 6, 7, 8, 9, 10] });
          const glow = await card(1)
            .locator(":scope > .role-draw-glow")
            .evaluate((el) => ({
              color: getComputedStyle(el).backgroundColor,
              image: getComputedStyle(el).backgroundImage,
            }));
          assert.deepEqual(
            glow,
            { color: "rgba(0, 0, 0, 0)", image: "none" },
            "Opaque paper must not receive a foreground accessibility wash",
          );
          const painted = await card(1).screenshot({ animations: "disabled" });
          for (const selector of [
            ".printed-player-card__art",
            ".printed-player-card__name",
            ".printed-player-card__role",
          ]) {
            const part = card(1).locator(selector);
            await part.evaluate((el) => {
              el.style.visibility = "hidden";
            });
            const without = await card(1).screenshot({ animations: "disabled" });
            await part.evaluate((el) => {
              el.style.visibility = "";
            });
            assert.equal(
              painted.equals(without),
              false,
              `${style} ${selector} positively contributes visible pixels under reduced transparency`,
            );
          }
          await capture(`en-${style}-reduced-transparency-giveaway`);
        }
        report.cases.push({
          kind: "native-reduced-transparency-giveaway",
          styles: styles.slice(1),
        });
      } finally {
        await cdp.send("Emulation.setEmulatedMedia", { features: [] });
        await cdp.detach();
      }
    }

    await seed("day", { reset: true, invalidPreferences: true });
    await inventory("glass");
    await manage(true);
    await expect(page.getByRole("combobox", { name: words.en.style, exact: true })).toHaveValue(
      "glass",
    );
    await manage(false);
    report.cases.push({ kind: "invalid-preference-default" });
    // Only this presentation key is denied. Canonical outbox/API storage remains real.
    await page.addInitScript((key) => {
      const prototype = Object.getPrototypeOf(localStorage);
      const original = prototype.setItem;
      prototype.setItem = function (name, value) {
        if (name === key) {
          window.__playerCardDeniedWrites = (window.__playerCardDeniedWrites ?? 0) + 1;
          throw new Error("Player-card preference storage deliberately unavailable");
        }
        return original.call(this, name, value);
      };
    }, PLAYER_CARD_PREFERENCES_KEY);
    await page.reload({ waitUntil: "networkidle" });
    const beforeDeniedWrite = await saved();
    await manage(true);
    await page.getByRole("combobox", { name: words.en.style, exact: true }).selectOption("noir");
    await page.getByRole("combobox", { name: words.en.placement, exact: true }).selectOption("top");
    await manage(false);
    await inventory("noir");
    assert.ok(
      await page.evaluate(() => window.__playerCardDeniedWrites > 0),
      "Actual App attempted the denied preference write",
    );
    assert.deepEqual(await saved(), beforeDeniedWrite);
    report.cases.push({ kind: "denied-preference-storage-current-session" });
    assert.equal(report.cases.filter(({ kind }) => kind === "gallery").length, 8);
    api.clean();
    assert.deepEqual(transportErrors, [], "No hidden HTTP errors in the focused App journey");
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error.stack ?? String(error);
    throw error;
  } finally {
    page.off("response", onResponse);
    report.transportErrors = transportErrors;
    club.language = originalLanguage;
    for (let i = 0; i < originalNames.length; i++) players[i].nickname = originalNames[i];
    report.sourceAfter = await playerCardSourceManifest();
    report.caseCount = report.cases.length;
    report.sourcesUnchanged =
      JSON.stringify(report.sourceBefore) === JSON.stringify(report.sourceAfter);
    if (!report.sourcesUnchanged) report.status = "invalid-moving-source";
    await writeFile(path.join(evidence, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    assert.deepEqual(
      report.sourceAfter,
      report.sourceBefore,
      "Source changed during player-card browser run; discard all evidence",
    );
  }
  console.log(
    `Player-card actual-App verification: ${report.caseCount} cases PASS; ${path.join(evidence, "report.json")}`,
  );
}
