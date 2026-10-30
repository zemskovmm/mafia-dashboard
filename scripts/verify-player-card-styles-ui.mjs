/**
 * Actual App scenario; imported only by verify-ui.mjs (no second server/mock shell).
 * UI_PLAYER_CARDS_ONLY=1 APP_URL=http://127.0.0.1:5186 node scripts/verify-ui.mjs
 * Freeze source first. Run Chromium 1366x768 / 1000x600, WebKit 1366x1024.
 * Evidence proves local browser + exact-origin mock API, not production persistence.
 */
/* global URL, localStorage, document, getComputedStyle, innerWidth, innerHeight, fetch, Image, MutationObserver, performance, requestAnimationFrame, cancelAnimationFrame, HTMLCanvasElement, DOMMatrix */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { PNG } from "pngjs";
import * as domain from "../packages/game-domain/src/index.ts";
import { getActiveBranch } from "../apps/web/src/features/game/game-history.ts";
import { isCurrentGameSessionState } from "../apps/web/src/session-outbox.ts";
import { PLAYER_CARD_PREFERENCES_KEY } from "../apps/web/src/features/theme/player-card-preferences.ts";

import {
  DEFAULT_PLAYER_EXIT_SETTINGS,
  PLAYER_EXIT_STORAGE_KEY,
  validatePlayerExitSettings,
} from "../apps/web/src/features/effects/player-exit-preferences.ts";
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
    placementLabels: ["Lower on card", "Role band"],
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
    placementLabels: ["Внизу карточки", "Полоса роли"],
    open: "Открыть меню управления",
    close: "Закрыть меню управления",
    hide: "Скрыть личную информацию",
    show: "Показать личную информацию",
    undo: /^Отменить последнее действие/,
    confirmUndo: "Отменить",
    roles: { citizen: "Мирный житель", mafia: "Мафия", don: "Дон", sheriff: "Шериф" },
  },
};

// An exact native night-target action is not the target player's private role.
// Never exempt descendant labels, role metadata or arbitrary host text.
export function playerCardRoleContent(row, allowedHostActions = []) {
  return [
    row.text,
    ...row.attrs
      .filter(
        ([name, value, host]) =>
          !(host && name === "aria-label" && allowedHostActions.includes(value)),
      )
      .map(([, value]) => value),
  ].join("\n");
}

/** Check actual material ancestry, not just the inherited progress variable. */
export function assertPlayerCardDeparturePaint(paint, cause, finalOpacity) {
  const close = (actual, expected, label) =>
    assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= 0.002, label);
  close(paint.fade, finalOpacity, `${cause}: configured persistent material fade`);
  close(paint.opacity, 1, "Public semantic host is not faded");
  assert.equal(paint.cardNames, 0, "Player names never appear inside card faces or fragments");
  assert.equal(paint.identity.length, 1, "One persistent external public identity");
  for (const item of [...paint.identity, ...paint.status]) {
    close(item.opacity, 1, "Public identity/status is not faded by any ancestor");
    assert.equal(item.visible, true, "Public identity/status remains painted");
  }
  assert.ok(paint.material.length > 0, "Inspect the actual paper or optical material");
  for (const item of paint.material)
    close(item.opacity, finalOpacity, "Actual decorative material fades exactly once");
  for (const piece of paint.pieces) {
    close(piece.opacity, finalOpacity, "Each torn fragment owns one fade");
    for (const inner of piece.inner) close(inner, 1, "Inner torn paper is not faded a second time");
  }
  for (const opacity of paint.marks)
    close(opacity, finalOpacity, "Persistent departure marks follow their material fade");
  if (paint.style === "glass")
    close(paint.opticalParentOpacity, 1, "Glass optical parent is not a second fade multiplier");
}

/** DOM ownership is necessary, but never reported as a painted-glow proof. */
export function assertPrintedTurnFrame(frame, { requireLighting = true } = {}) {
  assert.equal(frame.tag, "BUTTON", "Keep the native semantic action host");
  assert.equal(frame.hostTurns, 1, "Exactly the semantic host owns the physical turn");
  assert.equal(frame.innerTurns, 0, "Inner printed material must not perform a second turn");
  assert.ok(
    frame.caption?.visible && frame.caption.upright,
    "The external name remains visible and unmirrored during native turns",
  );
  assert.ok(
    Math.abs(frame.caption.opacity - 1) <= 0.002,
    "Native turns never fade the external name",
  );
  if (requireLighting)
    assert.ok(frame.lights.length > 0, "Use existing dealt/public lighting, not a test halo");
  for (const light of frame.lights) {
    assert.equal(light.contained, true, "Real glow/canvas belongs to the turning native host");
    // Canvas padding and deliberate shadow overhang are NOT card-sized boxes.
    const ratio = light.layoutWidth / frame.layoutWidth;
    assert.ok(
      light.box.width <= frame.box.width * ratio * 1.35 + 6,
      "No upright full-width lighting rectangle remains at an intermediate angle",
    );
  }
}

export function printedGlowSamplePose(phase) {
  const [minimumAngle, maximumAngle] = {
    lift: [5, 35],
    front: [40, 70],
    "near-edge": [75, 105],
    reverse: [120, 155],
  }[phase];
  // Exactly 90deg collapses real attached light to a subpixel line. Whether it
  // paints then depends on viewport alignment, not physical glow ownership.
  const targetAngle = phase === "near-edge" ? 85 : (minimumAngle + maximumAngle) / 2;
  return { minimumAngle, maximumAngle, targetAngle };
}

/** Differential pixels from one frozen native pose, independent of DOM counts. */
export function assertPlayerCardGlowPixels(painted, unlit, frame) {
  assert.equal(painted.width, unlit.width);
  assert.equal(painted.height, unlit.height);
  const paddingX = (40 * frame.box.width) / frame.layoutWidth + 4;
  const paddingY = (40 * frame.box.height) / frame.layoutHeight + 4;
  const boxes = [frame.box, ...frame.lights.map(({ box }) => box)];
  const envelope = {
    left: Math.min(...boxes.map((box) => box.x)) - paddingX,
    right: Math.max(...boxes.map((box) => box.x + box.width)) + paddingX,
    top: Math.min(...boxes.map((box) => box.y)) - paddingY,
    bottom: Math.max(...boxes.map((box) => box.y + box.height)) + paddingY,
  };
  let changed = 0,
    outside = 0;
  // Other live table lights are not our subject. Keep the old upright seat in
  // the observation window so a stationary rectangle cannot escape the oracle.
  const reference = frame.uprightBox ?? frame.box;
  const observation = {
    left: Math.max(0, Math.floor(Math.min(reference.x, envelope.left) - 40)),
    right: Math.min(
      painted.width,
      Math.ceil(Math.max(reference.x + reference.width, envelope.right) + 40),
    ),
    top: Math.max(0, Math.floor(Math.min(reference.y, envelope.top) - 40)),
    bottom: Math.min(
      painted.height,
      Math.ceil(Math.max(reference.y + reference.height, envelope.bottom) + 40),
    ),
  };
  for (let y = observation.top; y < observation.bottom; y++)
    for (let x = observation.left; x < observation.right; x++) {
      const i = (y * painted.width + x) * 4;
      const delta = Math.max(
        ...[0, 1, 2].map((channel) =>
          Math.abs(painted.data[i + channel] - unlit.data[i + channel]),
        ),
      );
      if (delta <= 12) continue;
      changed++;
      if (x < envelope.left || x > envelope.right || y < envelope.top || y > envelope.bottom)
        outside++;
    }
  assert.ok(changed >= 8, "Existing real glow contributes visible pixels at this pose");
  assert.ok(
    outside <= Math.max(12, changed * 0.01),
    "Painted glow follows the moving perimeter, not the old upright seat",
  );
  return { changed, outside, envelope, observation, threshold: 12 };
}

/** Every non-setup seed is a real domain transition chain + existing checkpoint. */
export function playerCardFixture(players, gameId, stage = "day") {
  assert.ok(players.length >= 11, "Ten seated players and a separate host are required");
  assert.equal(
    new Set(players.slice(0, 11).map(({ id }) => id)).size,
    11,
    "Ten distinct seated identities and a separate host are required",
  );
  assert.ok(
    [
      "day",
      "roles",
      "pre-vote",
      "night-result",
      "goodbye",
      "departed",
      "sheriff-greeting",
      "draw",
      "cancelled",
    ].includes(stage),
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
  const openingTarget = stage === "sheriff-greeting" ? "sheriff-identification" : "day";
  while (game.phase !== openingTarget) game = domain.advanceSetupPhase(game);
  const victimSeat = game.players.find(({ role }) => role === "citizen").seat;
  if (stage === "draw" || stage === "cancelled") {
    game = (stage === "draw" ? domain.confirmDraw : domain.cancelGame)(game, "Verifier ruling");
  } else if (stage === "pre-vote") {
    // A legal later sole nominee lets the actual last-speaker button accept the
    // city result. Never checkpoint an already-dead player and guess its cause.
    game = domain.completeMafiaShots(domain.resolveMafiaShots(domain.beginNight(game)).game);
    if (game.phase === "night-don") game = domain.skipDonCheck(game);
    if (game.phase === "night-sheriff") game = domain.skipSheriffCheck(game);
    game = domain.completeNight(game);
    game = domain.nominate(game, game.turnOrder[game.currentTurnIndex], victimSeat);
    while (game.currentTurnIndex < game.turnOrder.length - 1)
      game = domain.completeCurrentTurn(game);
  } else if (stage !== "day" && stage !== "sheriff-greeting") {
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
    "scripts/ui-presentation-contracts.test.mjs",
    "scripts/verify-federation-ui.mjs",
    "scripts/session-verifier-contracts.mjs",
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
  const originalNames = players.slice(0, 6).map(({ nickname }) => nickname);
  players[0].nickname = "Alexandria de la Verdad — exceptionally long player name";
  players[1].nickname = "Александра-Екатерина ОченьДлинноеИмя Игрока";
  if (process.env.PLAYER_CARDS_UI_SMOKE === "player-captions") {
    players[4].nickname = "Alexandria — long lower-seat caption with ellipsis";
    players[5].nickname = "Александра-Екатерина — длинная подпись нижнего места";
  }
  let locale = "en";
  const card = (seat) => page.locator(`.seat-anchor[data-seat="${seat}"] .player-seat`);
  const caption = (seat) =>
    page.locator(`.seat-anchor[data-seat="${seat}"] > .player-seat-caption`);
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
    await expect(
      page.locator(
        ".player-seat[data-player-exit],.player-seat [data-player-feedback],.winner-card[data-player-feedback]",
      ),
    ).toHaveCount(0);
  }
  async function seed(
    stage,
    { reset = false, invalidPreferences = false, exitSettings = DEFAULT_PLAYER_EXIT_SETTINGS } = {},
  ) {
    const id = randomUUID();
    const fixture = playerCardFixture(players, id, stage);
    api.sessions.clear();
    api.seed(id, fixture.state);
    await page.goto(new URL("/health/ready", origin).href);
    assertExactOrigin(page.url(), origin);
    await page.evaluate(
      ({ key, value, reset, invalidPreferences, preferenceKey, exitKey, exitSettings }) => {
        if (reset) localStorage.clear();
        localStorage.setItem(key, JSON.stringify(value));
        localStorage.setItem(exitKey, JSON.stringify(exitSettings));
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
        exitKey: PLAYER_EXIT_STORAGE_KEY,
        exitSettings: validatePlayerExitSettings(exitSettings),
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
      assert.deepEqual(
        (await placementSelect.locator("option").allTextContents()).slice(0, 2),
        words[locale].placementLabels,
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
  async function captions() {
    const rows = await page.locator(".game-shell .seat-anchor").evaluateAll((anchors) =>
      anchors.map((anchor) => {
        const host = anchor.querySelector(":scope > .player-seat");
        const names = [...anchor.querySelectorAll(":scope > .player-seat-caption")];
        const name = names[0];
        if (!name) return { seat: Number(anchor.dataset.seat), count: 0 };
        const rect = (node) => node.getBoundingClientRect().toJSON();
        const bounds = rect(name);
        let opacity = 1,
          upright = true,
          clipped = false;
        // The caption is a sibling, so its actual chain never reaches host.
        for (let node = name; node; node = node.parentElement) {
          const css = getComputedStyle(node),
            box = rect(node);
          opacity *= Number(css.opacity);
          const matrix = new DOMMatrix(css.transform === "none" ? undefined : css.transform);
          upright &&=
            matrix.m11 > 0 &&
            matrix.m22 > 0 &&
            Math.abs(matrix.m12) < 0.001 &&
            Math.abs(matrix.m21) < 0.001 &&
            (css.rotate === "none" || /(?:^| )0deg$/.test(css.rotate)) &&
            (css.scale === "none" || css.scale.split(" ").every((value) => Number(value) > 0));
          if (node !== name) {
            if (css.overflowX !== "visible")
              clipped ||= bounds.left < box.left - 1 || bounds.right > box.right + 1;
            if (css.overflowY !== "visible")
              clipped ||= bounds.top < box.top - 1 || bounds.bottom > box.bottom + 1;
          }
        }
        const css = getComputedStyle(name);
        return {
          seat: Number(anchor.dataset.seat),
          count: names.length,
          tag: name.tagName,
          text: name.textContent,
          title: name.title,
          hidden: name.getAttribute("aria-hidden"),
          sibling: host.nextElementSibling === name,
          visible: name.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
          opacity,
          upright,
          clipped,
          bounds,
          card: rect(host),
          anchor: rect(anchor),
          workspace: rect(anchor.closest(".table-workspace")),
          longLabelBounded:
            css.whiteSpace === "nowrap" &&
            (name.scrollWidth <= name.clientWidth ||
              (["hidden", "clip"].includes(css.overflowX) && css.textOverflow === "ellipsis")),
          cardNames: host.querySelectorAll(
            ".seat-name,.printed-player-card__name,.printed-player-card__caption",
          ).length,
          cardText: host.textContent,
          actions: [...anchor.querySelectorAll(".seat-actions button")]
            .filter((node) => node.getClientRects().length)
            .map(rect),
        };
      }),
    );
    assert.equal(rows.length, 10);
    const overlap = (a, b) =>
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    const controls = await page
      .locator(".table-advance button,.table-center button")
      .evaluateAll((nodes) =>
        nodes
          .filter((node) => node.getClientRects().length)
          .map((node) => node.getBoundingClientRect().toJSON()),
      );
    const viewport = page.viewportSize();
    for (const row of rows) {
      const label = `Caption seat ${row.seat}`;
      assert.equal(row.count, 1, label);
      assert.equal(row.tag, "SPAN", label);
      assert.equal(row.hidden, "true", "Accessible identity stays on the native host");
      assert.equal(row.sibling, true, label);
      assert.equal(row.text, players[row.seat - 1].nickname, label);
      assert.equal(row.title, row.text, "Full long name survives visual ellipsis");
      assert.equal(row.cardNames, 0, "No name nodes on either face or torn artwork");
      assert.equal(row.cardText.includes(row.text), false, "No player-name text inside the card");
      assert.equal(
        row.visible && row.upright && !row.clipped && row.longLabelBounded,
        true,
        `${label}: ${JSON.stringify({ visible: row.visible, upright: row.upright, clipped: row.clipped, bounded: row.longLabelBounded, bounds: row.bounds, card: row.card, workspace: row.workspace })}`,
      );
      assert.ok(Math.abs(row.opacity - 1) <= 0.002, `${label}: no ancestor fade`);
      const b = row.bounds;
      assert.ok(
        b.width > 0 && b.height > 0 && b.top >= row.card.bottom - 1,
        `${label}: below artwork`,
      );
      assert.ok(
        Math.abs((b.left + b.right - row.anchor.left - row.anchor.right) / 2) <= 1,
        `${label}: centred on unchanged orbit anchor`,
      );
      assert.ok(
        b.left >= 0 && b.right <= viewport.width && b.top >= 0 && b.bottom <= viewport.height,
        `${label}: viewport clearance`,
      );
      assert.ok(
        b.left >= row.workspace.left - 1 &&
          b.right <= row.workspace.right + 1 &&
          b.top >= row.workspace.top - 1 &&
          b.bottom <= row.workspace.bottom + 1,
        `${label}: workspace clearance`,
      );
      for (const other of rows) {
        assert.equal(overlap(b, other.card), false, `${label}: artwork clearance ${other.seat}`);
        if (row !== other)
          assert.equal(
            overlap(b, other.bounds),
            false,
            `${label}: caption clearance ${other.seat}`,
          );
      }
      for (const action of [...rows.flatMap((other) => other.actions), ...controls])
        assert.equal(overlap(b, action), false, `${label}: native action clearance`);
      if ([5, 6].includes(row.seat))
        for (const action of row.actions)
          assert.ok(action.top >= b.bottom - 1, `${label}: lower actions stay below the caption`);
    }
    return rows;
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
            cause: el.getAttribute("data-departure-cause"),
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
            roleBands: el.querySelectorAll(".printed-player-card__role-band").length,
            placement: el
              .querySelector(".printed-player-card")
              ?.getAttribute("data-role-placement"),
            emptyRails: [
              ...el.querySelectorAll(".card-nomination-status,.card-discipline-status"),
            ].filter(
              (node) => node.childElementCount === 0 && getComputedStyle(node).display !== "none",
            ).length,
            text: el.textContent,
            attrs: [el, ...el.querySelectorAll("*")].flatMap((node) =>
              [...node.attributes]
                .filter((a) => /^(aria-label|title|alt|data-.*role.*|data-.*glyph.*)$/.test(a.name))
                .map((a) => [a.name, a.value, node === el]),
            ),
            decoded,
          };
        }),
      );
    });
    assert.equal(rows.length, 10);
    await captions();
    const mafiaTargets = await page.locator(".game-shell.phase-night-mafia").count();
    for (const row of rows) {
      const name = players[row.seat - 1].nickname;
      const actions = !mafiaTargets
        ? []
        : locale === "en"
          ? [`Assign all Mafia shots to ${name}`, `Remove all Mafia shots from ${name}`]
          : [
              `Назначить все выстрелы мафии в игрока ${name}`,
              `Снять все выстрелы мафии с игрока ${name}`,
            ];
      const roleContent = playerCardRoleContent(row, actions);
      assert.equal(row.style, style);
      assert.ok(
        row.tag === "BUTTON" || row.role === "group",
        "Preserved native action/read-only host",
      );
      if (style === "glass") {
        assert.equal(row.glass, true, "Glass retains its existing material host");
        if (row.cause && row.cause !== "unknown") {
          assert.equal(row.text.includes(name), false, "Glass reverse has no player name");
          assert.equal(
            row.icons,
            0,
            "Known Glass departures have a neutral reverse, not a person/role glyph",
          );
          assert.equal(row.crosses, 0, "Known Glass departures replace the old cross");
          assert.equal(row.roleBadges, 0, "Known Glass reverse has no role badge");
          assert.doesNotMatch(
            roleContent,
            /citizen|sheriff|\bmafia\b|\bdon\b|мирн|мафи|шериф|\bдон\b/i,
          );
        }
        continue;
      }
      assert.equal(row.glass, false, "Printed paper has no optical Glass layer");
      assert.equal(row.icons, 0, "Printed art cannot inherit custom role glyphs");
      assert.equal(row.crosses, 0, "Printed departures use a neutral back, never a cross");
      assert.equal(row.emptyRails, 0, "Empty status rails must not paint blank paper patches");
      assert.equal(
        row.roleBands,
        row.placement === "ribbon" && row.roleBadges > 0 ? 1 : 0,
        "Role band mounts only for a present role at ribbon placement",
      );
      const back = allBacks || backs.includes(row.seat);
      assert.equal(row.face, back ? "back" : "front", `Seat ${row.seat} expected face`);
      assert.equal(
        row.decoded.length,
        1,
        "One decoded external illustration (the same reverse on both torn pieces)",
      );
      assert.equal(
        /\/back[.-]/.test(row.decoded[0].url),
        back,
        "Only the actual neutral reverse is mounted on a face-down card",
      );
      for (const image of row.decoded) {
        assertExactOrigin(image.url, origin);
        assert.ok(!image.url.startsWith("data:"));
      }
      if (back) {
        assert.equal(row.text.includes(name), false, "Printed reverse has no player name");
        assert.equal(row.roleBadges, 0, "No role badges on the reverse, even aria-hidden ones");
        assert.doesNotMatch(
          roleContent,
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
  async function noDeparture(seat) {
    assert.equal(await card(seat).getAttribute("data-departure-cause"), null);
    await expect(
      card(seat).locator(".player-bullet-hole,.player-torn-fragment,.player-disciplinary-ribbon"),
    ).toHaveCount(0);
    assert.equal(
      await card(seat).evaluate((el) =>
        Number(getComputedStyle(el).getPropertyValue("--player-exit-fade")),
      ),
      1,
      "Active/private/pending-goodbye/restored player has no departure fade",
    );
    const opacity = await card(seat).evaluate((host) =>
      [
        ...host.querySelectorAll(
          ".printed-player-card__current.printed-player-card__surface,.liquid-card-glass__backdrop",
        ),
      ].map((node) => {
        let value = 1;
        for (let current = node; current; current = current.parentElement) {
          value *= Number(getComputedStyle(current).opacity);
          if (current === host) break;
        }
        return value;
      }),
    );
    assert.ok(opacity.length > 0, "Restored endpoint has actual material");
    assert.ok(
      opacity.every((value) => Math.abs(value - 1) <= 0.002),
      "Restored/active material is fully unfaded, not merely a reset variable",
    );
  }
  async function departure(seat, cause) {
    await settled();
    await expect(card(seat)).toHaveAttribute("data-departure-cause", cause);
    await expect(card(seat).locator(".player-bullet-hole")).toHaveCount(cause === "mafia" ? 3 : 0);
    await expect(card(seat).locator(".player-torn-fragment")).toHaveCount(cause === "vote" ? 2 : 0);
    await expect(card(seat).locator(".player-disciplinary-ribbon")).toHaveCount(
      cause === "discipline" ? 1 : 0,
    );
    const painted = await card(seat).evaluate((el) => {
      const effectiveOpacity = (node) => {
        let value = 1;
        for (let current = node; current; current = current.parentElement) {
          value *= Number(getComputedStyle(current).opacity);
          if (current === el) return value;
        }
        throw new Error("Paint owner must belong to the semantic host");
      };
      const publicPaint = (selector) =>
        [...el.querySelectorAll(selector)]
          .filter(
            (node) => node.getClientRects().length && getComputedStyle(node).display !== "none",
          )
          .map((node) => ({
            opacity: effectiveOpacity(node),
            visible: getComputedStyle(node).visibility === "visible",
          }));
      const style = el.getAttribute("data-card-style");
      const cause = el.getAttribute("data-departure-cause");
      const material =
        style === "glass"
          ? [...el.querySelectorAll(".liquid-card-glass__backdrop")]
          : [
              ...el.querySelectorAll(
                ".printed-player-card__current.printed-player-card__surface,.player-torn-fragment > .printed-player-card__surface",
              ),
            ];
      return {
        style,
        material: material.map((node) => ({ opacity: effectiveOpacity(node) })),
        opticalParentOpacity:
          style === "glass" ? effectiveOpacity(el.querySelector(".liquid-card-glass")) : null,
        cardNames: el.querySelectorAll(
          ".seat-name,.printed-player-card__name,.printed-player-card__caption",
        ).length,
        identity: [...el.parentElement.querySelectorAll(":scope > .player-seat-caption")].map(
          (node) => {
            let opacity = 1;
            for (let ancestor = node; ancestor; ancestor = ancestor.parentElement)
              opacity *= Number(getComputedStyle(ancestor).opacity);
            return {
              opacity,
              visible: node.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
            };
          },
        ),
        status: publicPaint(
          ".printed-player-card__status,.card-nomination-status,.card-discipline-status",
        ),
        marks: [...el.querySelectorAll(".player-bullet-hole,.player-disciplinary-ribbon")].map(
          effectiveOpacity,
        ),
        fade: Number(getComputedStyle(el).getPropertyValue("--player-exit-fade")),
        decoration:
          cause !== "vote"
            ? [...el.querySelectorAll(".player-exit-decoration,.deceased-cross")].map(
                effectiveOpacity,
              )
            : [],
        holes: [...el.querySelectorAll(".player-bullet-hole")].map((node) =>
          Number(getComputedStyle(node).opacity),
        ),
        pieces: [...el.querySelectorAll(".player-torn-fragment")].map((node) => ({
          opacity: Number(getComputedStyle(node).opacity),
          clip: getComputedStyle(node).clipPath,
          transform: getComputedStyle(node).transform,
          inner: [...node.querySelectorAll(".printed-player-card__surface")].map((paper) =>
            Number(getComputedStyle(paper).opacity),
          ),
        })),
        tear: Number(getComputedStyle(el).getPropertyValue("--player-exit-tear")),
        opacity: Number(getComputedStyle(el).opacity),
      };
    });
    const settings = validatePlayerExitSettings(
      await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), PLAYER_EXIT_STORAGE_KEY),
    );
    const finalOpacity = settings.finalOpacity / 100;
    assertPlayerCardDeparturePaint(painted, cause, finalOpacity);
    for (const opacity of painted.decoration)
      assert.ok(
        Math.abs(opacity - finalOpacity) <= 0.002,
        "Neutral Glass decoration follows the material fade once",
      );
    if (cause === "mafia")
      assert.deepEqual(painted.holes, [1, 1, 1], "Three settled, painted impacts");
    if (cause === "vote") {
      assert.equal(painted.tear, 1, "Tear reaches its persistent endpoint");
      assert.equal(
        new Set(painted.pieces.map((piece) => piece.clip)).size,
        2,
        "Two complementary real surfaces",
      );
      for (const piece of painted.pieces) {
        assert.equal(piece.opacity, finalOpacity);
        assert.notEqual(piece.clip, "none");
        assert.notEqual(piece.transform, "none", "The persistent pieces retain a physical gap");
      }
    }
    {
      assert.equal(painted.opacity, 1, "Public identity is not faded with decorative material");
      const identity = caption(seat);
      await expect(identity).toBeVisible();
      const state = (await read()).current.state;
      const player = state.game.players.find((player) => player.seat === seat);
      await expect(identity).toHaveText(players.find((p) => p.id === player.id).nickname);
    }
    return painted;
  }
  async function departureStyles(seat, cause) {
    const before = await saved();
    const endpoints = [];
    for (const style of styles) {
      await choose(style);
      await inventory(style, { backs: [seat] });
      endpoints.push({ style, ...(await departure(seat, cause)) });
      assert.deepEqual(
        await reloadWithoutFeedback(),
        before,
        "Each deck restores the exact accepted history",
      );
      assert.deepEqual(
        await departure(seat, cause),
        endpoints.at(-1),
        "Reload restores the same painted endpoint without new motion",
      );
      await capture(`${locale}-${style}-${cause}-settled`);
    }
    assert.deepEqual(await saved(), before, "All-style endpoint inspection is a canonical no-op");
    return endpoints;
  }
  async function restoredStyles(seat) {
    const before = await saved();
    const previous = await card(seat).getAttribute("data-card-style");
    for (const style of styles) {
      await choose(style);
      await inventory(style);
      await noDeparture(seat);
    }
    await choose(previous);
    assert.deepEqual(
      await saved(),
      before,
      "All-style restored material inspection preserves exact history",
    );
  }
  async function prefix(sequence, inspect) {
    const live = await saved();
    const open = page.getByRole("button", { name: "Open game log", exact: true });
    if (await open.isVisible()) await open.click();
    await page
      .getByRole("button", { name: `Preview state after log #${sequence}`, exact: true })
      .click();
    await expect(page.locator(".game-shell.is-history-preview")).toBeVisible();
    await expect(page.locator("button.player-seat")).toHaveCount(0);
    await expect(page.locator('.player-seat[role="group"]')).toHaveCount(10);
    await settled();
    await inspect();
    assert.deepEqual(await saved(), live, "History prefixes cannot mutate the complete live save");
    await page.getByRole("button", { name: "Exit preview", exact: true }).click();
    await settled();
    assert.deepEqual(
      await saved(),
      live,
      "Exiting a prefix preserves exact HTTP/canonical equality",
    );
  }
  async function restoredPrefixStyles(sequence, seat) {
    const before = await saved();
    const previous = await card(seat).getAttribute("data-card-style");
    for (const style of styles) {
      // Manage belongs to live mode; every style enters the same accepted prefix.
      await choose(style);
      await prefix(sequence, async () => {
        await inventory(style);
        await noDeparture(seat);
      });
    }
    await choose(previous);
    assert.deepEqual(await saved(), before, "All-style prefixes preserve exact live history");
  }
  // Observe only presentation attributes; all actions and persistence remain real.
  // A bounded observer retains short requests even when a save exceeds cue duration.
  async function feedback(selector, action, expected = 1) {
    const probe = await page.evaluateHandle((selector) => {
      const ids = new Set();
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === "attributes" && record.target.matches(selector)) {
            for (const value of [
              record.oldValue,
              record.target.getAttribute("data-player-feedback"),
            ])
              if (value) ids.add(value);
          }
          for (const node of record.addedNodes)
            if (node.nodeType === 1) {
              for (const element of [node, ...node.querySelectorAll(selector)])
                if (element.matches(selector) && element.hasAttribute("data-player-feedback"))
                  ids.add(element.getAttribute("data-player-feedback"));
            }
        }
      });
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeOldValue: true,
        attributeFilter: ["data-player-feedback"],
      });
      const timer = setTimeout(() => observer.disconnect(), 6000);
      return { ids, observer, timer };
    }, selector);
    try {
      const result = await action();
      const state = await saved();
      await expect.poll(() => probe.evaluate(({ ids }) => ids.size)).toBe(expected);
      await settled();
      const ids = await probe.evaluate(({ ids }) => [...ids]);
      assert.equal(ids.length, expected, "Only accepted action feedback requests are published");
      for (const id of ids) assert.match(id, /^\d+$/);
      return { state, ids, result };
    } finally {
      await probe.evaluate(({ observer, timer }) => {
        observer.disconnect();
        globalThis.clearTimeout(timer);
      });
      await probe.dispose();
    }
  }
  let reloadProbeKey;
  async function reloadWithoutFeedback() {
    if (!reloadProbeKey) {
      reloadProbeKey = `playerCardReload${randomUUID().replaceAll("-", "")}`;
      // Install before React runs in the new document, not after networkidle.
      // Only observe; never change media, animation, App state or event handlers.
      await page.addInitScript((key) => {
        const ids = [];
        const attributes = ["data-player-feedback", "data-player-exit"];
        const selector = attributes.map((attribute) => `[${attribute}]`).join(",");
        const collect = (element) => {
          for (const attribute of attributes) {
            const value = element.getAttribute(attribute);
            if (value) ids.push(`${attribute}:${value}`);
          }
        };
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            if (record.type === "attributes") {
              if (record.oldValue) ids.push(`${record.attributeName}:${record.oldValue}`);
              collect(record.target);
            }
            for (const node of record.addedNodes)
              if (node.nodeType === 1) {
                collect(node);
                for (const element of node.querySelectorAll(selector)) collect(element);
              }
          }
        });
        observer.observe(document, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeOldValue: true,
          attributeFilter: attributes,
        });
        const timer = setTimeout(() => observer.disconnect(), 6000);
        globalThis[key] = { ids, observer, timer };
      }, reloadProbeKey);
    }
    try {
      await page.reload({ waitUntil: "networkidle" });
      await settled();
      assert.deepEqual(
        await page.evaluate((key) => globalThis[key].ids, reloadProbeKey),
        [],
        "Restoration cannot replay accepted feedback or departure requests, even before settlement",
      );
      return await saved();
    } finally {
      await page.evaluate((key) => {
        const probe = globalThis[key];
        if (probe) {
          probe.observer.disconnect();
          globalThis.clearTimeout(probe.timer);
          delete globalThis[key];
        }
      }, reloadProbeKey);
    }
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
          name: el.parentElement.querySelector(":scope > .player-seat-caption")?.textContent,
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
        const name = el.parentElement.querySelector(":scope > .player-seat-caption");
        const band = current.querySelector(".printed-player-card__role-band");
        const rect = (node) => {
          const b = node.getBoundingClientRect();
          return { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
        };
        return {
          placement: paper.getAttribute("data-role-placement"),
          role: rect(role),
          name: rect(name),
          band: band ? rect(band) : null,
          card: rect(el),
          inBand: band?.contains(role) ?? false,
          roleLines: (() => {
            const range = document.createRange();
            range.selectNodeContents(role);
            return new Set(
              [...range.getClientRects()]
                .filter((r) => r.width && r.height)
                .map((r) => Math.round(r.top * 100)),
            ).size;
          })(),
          nameText: name.textContent,
          fullLabel: el.getAttribute("aria-label"),
        };
      }),
    );
    for (const row of rows) {
      assert.equal(row.placement, placement);
      assert.equal(row.inBand, placement === "ribbon");
      if (placement === "ribbon") assert.equal(row.roleLines, 1, "Role band is a single text line");
      assert.ok(
        row.role.left >= row.card.left - 1 &&
          row.role.right <= row.card.right + 1 &&
          row.role.top >= row.card.top - 1 &&
          row.role.bottom <= row.card.bottom + 1,
        "Role remains within its native card",
      );
      assert.equal(
        row.band !== null,
        placement === "ribbon",
        "Only a role-bearing ribbon mounts a role band",
      );
      assert.ok(
        row.name.top >= row.card.bottom - 1,
        "Public name stays below the artwork in every placement",
      );
      if (placement === "top")
        assert.ok(
          row.role.bottom <= (row.card.top + row.card.bottom) / 2,
          "Top role stays near the top",
        );
      else if (placement === "below")
        assert.ok(
          row.role.top >= (row.card.top + row.card.bottom) / 2,
          "Lower role stays on the lower card",
        );
      assert.ok(
        row.fullLabel.includes(row.nameText),
        "Full long name remains in the action's accessible label",
      );
    }
    return rows;
  }
  async function printedTurnProbe(seat) {
    return card(seat).evaluateHandle((host) => {
      const rows = [];
      let stopped = false,
        raf,
        firstActive;
      const started = performance.now();
      const box = (node) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x, y, width, height };
      };
      const captionFrame = () => {
        const name = host.parentElement.querySelector(":scope > .player-seat-caption");
        if (!name) return null;
        let opacity = 1,
          upright = true;
        for (let node = name; node; node = node.parentElement) {
          const css = getComputedStyle(node);
          opacity *= Number(css.opacity);
          const matrix = new DOMMatrix(css.transform === "none" ? undefined : css.transform);
          upright &&=
            matrix.m11 > 0 &&
            matrix.m22 > 0 &&
            Math.abs(matrix.m12) < 0.001 &&
            Math.abs(matrix.m21) < 0.001 &&
            (css.rotate === "none" || /(?:^| )0deg$/.test(css.rotate)) &&
            (css.scale === "none" || css.scale.split(" ").every((value) => Number(value) > 0));
        }
        return {
          box: box(name),
          text: name.textContent,
          opacity,
          upright,
          visible: name.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
        };
      };
      const sample = () => {
        const turns = host
          .getAnimations({ subtree: true })
          .filter((animation) =>
            animation.effect?.getKeyframes().some((keyframe) => keyframe.rotate),
          );
        const angle = Math.abs(
          parseFloat(getComputedStyle(host).rotate.match(/(-?[\d.]+)deg/)?.[1] ?? "0"),
        );
        const lightNodes = [
          ...host.querySelectorAll(
            ".role-draw-glow,.active-player-lighting[data-active='true'],.vgpu-player-lighting",
          ),
        ];
        const material = host.querySelector(":scope > .liquid-card-glass");
        const facing = (node) =>
          Math.cos((angle * Math.PI) / 180) * (parseFloat(getComputedStyle(node).scale) || 1);
        return {
          now: performance.now(),
          timeOrigin: performance.timeOrigin,
          tag: host.tagName,
          caption: captionFrame(),
          angle,
          optics: material
            ? {
                shared: host.dataset.glassPainted === "true",
                blending: host.dataset.glassBlending === "true",
                weight: parseFloat(host.style.getPropertyValue("--glass-local-weight")),
                visibility: getComputedStyle(material).visibility,
                materialFacing: facing(material),
                glowFacing: [...host.querySelectorAll(":scope > .role-draw-glow")].map(facing),
              }
            : null,
          box: box(host),
          layoutWidth: host.offsetWidth,
          layoutHeight: host.offsetHeight,
          hostTurns: turns.filter((animation) => animation.effect.target === host).length,
          innerTurns: turns.filter((animation) =>
            animation.effect.target.classList.contains("printed-player-card__motion"),
          ).length,
          pending: turns.some((animation) => animation.pending),
          privateCues: host.matches(
            ".is-mafia-shooter,.is-sheriff-highlight,.is-night-check-highlight",
          ),
          privateNodes: host.querySelectorAll(".printed-player-card__role,[data-role-glyph]")
            .length,
          privateGlows: host.querySelectorAll(".role-draw-glow").length,
          privateCanvases: host.querySelectorAll(":scope > .vgpu-player-lighting").length,
          lights: lightNodes.map((node) => ({
            className: node.className,
            contained: host.contains(node),
            layoutWidth: node.offsetWidth,
            box: box(node),
            ready: node.getAttribute("data-vgpu-ready"),
            opacity: Number(getComputedStyle(node).opacity),
            visibility: getComputedStyle(node).visibility,
          })),
          requests: turns.map((animation) => ({
            id: animation.id,
            time: animation.currentTime,
            start: animation.startTime,
            pending: animation.pending,
          })),
        };
      };
      const tick = () => {
        if (stopped) return;
        const row = sample();
        rows.push(row);
        if (row.hostTurns && firstActive === undefined) firstActive = row.now;
        if (
          rows.length >= 450 ||
          row.now - (firstActive ?? started) > (firstActive === undefined ? 4000 : 1400)
        ) {
          stopped = true;
          return;
        }
        // The shared Glass draw owns its painted markers in its own rAF.
        // Observe after all frame callbacks, as the departure recorder does,
        // rather than reading last frame's markers with this frame's pose.
        raf = requestAnimationFrame(() => setTimeout(tick, 0));
      };
      raf = requestAnimationFrame(() => setTimeout(tick, 0));
      return {
        rows,
        sample,
        stop: () => {
          stopped = true;
          cancelAnimationFrame(raf);
        },
      };
    });
  }
  async function naturalPrintedTurn(
    style,
    seat,
    kind,
    action,
    { interrupt = false, openingBoundary = false } = {},
  ) {
    const before = await saved();
    const probe = await printedTurnProbe(seat);
    const initial = await probe.evaluate(({ sample }) => sample());
    const label = `en-${style}-${kind}-natural`;
    const traceFile = path.join(evidence, `${label}.zip`);
    await page.context().tracing.start({ screenshots: true, snapshots: true, sources: false });
    try {
      if (openingBoundary) {
        assert.equal(
          initial.privateCues,
          true,
          "A real private Sheriff light exists before the daytime boundary",
        );
        await page.screenshot({
          path: path.join(evidence, `${label}-private-before.png`),
          animations: "allow",
        });
      }
      await action();
      await expect
        .poll(() => probe.evaluate(({ rows }) => rows.some((row) => row.hostTurns > 0)))
        .toBe(true);
      if (interrupt || openingBoundary) {
        // Interrupt the first privacy turn through the actual toolbar again.
        if (interrupt) {
          await page.getByRole("button", { name: words.en.show, exact: true }).click();
          await page.getByRole("button", { name: words.en.hide, exact: true }).click();
        }
        const immediate = await probe.evaluate(({ sample }) => sample());
        assert.equal(
          immediate.privateNodes,
          0,
          "Privacy interruption strips role markup before settlement",
        );
        assert.equal(
          immediate.privateCues,
          false,
          "No private role lighting survives effective privacy",
        );
        assert.equal(
          immediate.privateGlows,
          0,
          "No dealt-role glow lingers through effective privacy",
        );
        assert.equal(
          immediate.privateCanvases,
          0,
          "No private-role GPU canvas lingers through effective privacy",
        );
      }
      await settled();
      if (style === "glass")
        await expect(card(seat)).not.toHaveAttribute("data-glass-blending", "true");
      await page.screenshot({
        path: path.join(evidence, `${label}-settled.png`),
        animations: "allow",
      });
      const rows = await probe.evaluate(({ rows }) => rows);
      const active = rows.filter((row) => row.hostTurns > 0 && !row.pending);
      assert.ok(active.length > 0, "Natural native-clock turn was observed");
      if (style === "glass") {
        for (const row of rows) {
          assert.ok(row.optics, "Inspect the real Glass material");
          for (const facing of [row.optics.materialFacing, ...row.optics.glowFacing])
            if (Math.abs(facing) > 0.2)
              assert.ok(
                facing > 0,
                "Reflection and dealt-glow gradients never reverse at settlement",
              );
          if (row.angle > 1 && row.angle < 179) {
            assert.equal(
              row.optics.shared,
              false,
              "Only local Glass follows the turning perimeter",
            );
            assert.equal(row.optics.visibility, "visible");
          }
          if (row.optics.shared && !row.optics.blending)
            assert.equal(row.optics.visibility, "hidden", "No duplicate local/shared paint");
        }
        if (initial.optics.shared) {
          const blend = rows.filter((row) => row.optics.blending);
          assert.ok(
            blend.some((row) => row.optics.weight > 0 && row.optics.weight < 1),
            "Real intermediate optical weights survive the role-reveal commit",
          );
          for (let index = 1; index < blend.length; index++)
            assert.ok(
              blend[index].optics.weight <= blend[index - 1].optics.weight,
              "The optical handoff never reverses",
            );
          assert.equal(rows.at(-1).optics.shared, true, "Enhanced Glass returns after the turn");
        }
      }
      // At the positive private-light boundary, the required outcome is removal,
      // not retaining a halo. All dealt/public follow cases still require light.
      for (const row of active) assertPrintedTurnFrame(row, { requireLighting: !openingBoundary });
      if (openingBoundary)
        for (const row of active) {
          assert.equal(
            row.privateCues,
            false,
            "Private lighting is gone throughout the daytime turn",
          );
          assert.equal(row.privateNodes, 0, "Private role DOM is gone throughout the daytime turn");
          assert.equal(
            row.privateCanvases,
            0,
            "Private GPU lighting cannot fade out after privacy applies",
          );
        }
      for (const [phase, match] of [
        ["lift", (row) => row.angle > 0 && row.angle < 40],
        ["front", (row) => row.angle >= 40 && row.angle < 75],
        ["near-edge", (row) => row.angle >= 75 && row.angle <= 105],
        ["reverse", (row) => row.angle > 105 && row.angle < 180],
      ])
        assert.ok(active.some(match), `${label}: natural playback includes ${phase}`);
      const state = await saved();
      if (openingBoundary) {
        assert.equal(
          domain.hashGameState(state.game),
          domain.hashGameState(domain.advanceOpeningPhase(before.game)),
        );
        assert.deepEqual(state.events.slice(0, before.events.length), before.events);
        assert.equal(
          state.events.length,
          before.events.length + 1,
          "Only the accepted opening advance changes canonical history",
        );
      } else if (kind.startsWith("privacy"))
        assert.deepEqual(state, before, "Privacy/interruptions are canonical no-ops");
      else {
        assert.deepEqual(
          state.events,
          before.events,
          "Accepted setup draw/reroll does not invent canonical events",
        );
        assert.deepEqual(state.legacyLog, before.legacyLog);
      }
      report.cases.push({
        kind: style === "glass" ? "glass-natural-reflection" : "printed-natural-glow-follow",
        style,
        action: kind,
        seat,
        trace: path.relative(root, traceFile),
        frames: rows.length,
        privateLightCoverage: kind.startsWith("privacy")
          ? initial.privateCues || initial.privateGlows > 0
            ? "present-to-redacted"
            : "absence-only: this admitted daytime fixture has no private role light before privacy"
          : "not a privacy case",
        pixelReview:
          "Review natural trace screencast at lift/front/edge/reverse; DOM ownership is not a pixel verdict",
      });
    } finally {
      await probe.evaluate(({ stop }) => stop());
      const rows = await probe.evaluate(({ rows }) => rows);
      await writeFile(
        path.join(evidence, `${label}.json`),
        `${JSON.stringify({ rows, source: "passive native-rAF observation; no seek/pause/finish", trace: path.relative(root, traceFile) }, null, 2)}\n`,
      );
      await probe.dispose();
      await page.context().tracing.stop({ path: traceFile });
    }
  }
  async function sampledPrintedGlow(style, seat, kind, phase, action) {
    // A separate accepted reroll supplies a deterministic paired exposure.
    // Never pause/seek the natural recording above or call this natural video.
    const probe = await printedTurnProbe(seat);
    const before = await saved();
    const uprightBox = await card(seat).boundingBox();
    const { minimumAngle, maximumAngle, targetAngle } = printedGlowSamplePose(phase);
    let frozen, pendingPose;
    try {
      // Capture a fresh request early, then seek its real keyframes only in this
      // deterministic lane. Waiting naturally for reverse leaves too little of
      // the unchanged expiry guard for two screenshots and can invalidate them.
      pendingPose = await card(seat).evaluateHandle(
        (host, targetAngle) => ({
          pose: new Promise((resolve, reject) => {
            const deadline = performance.now() + 3000;
            const tick = () => {
              const animations = document
                .getAnimations()
                .filter((animation) => animation.playState === "running");
              const turn = animations.find(
                (animation) =>
                  animation.effect?.target === host &&
                  /^printed-card-/.test(animation.id) &&
                  animation.effect.getKeyframes().some((frame) => "rotate" in frame),
              );
              if (turn) {
                animations.forEach((animation) => animation.pause());
                Promise.all(
                  animations.map((animation) =>
                    animation.ready.catch((error) => {
                      // Save/toolbar feedback can be replaced while the trusted
                      // action commits. A cancelled unrelated CSS transition no
                      // longer paints; subject or live-track failures still fail.
                      if (
                        error.name === "AbortError" &&
                        animation.id !== turn.id &&
                        animation.constructor.name === "CSSTransition" &&
                        animation.playState === "idle" &&
                        animation.currentTime === null
                      ) {
                        return;
                      }
                      throw new Error(
                        `Cannot freeze native animation: ${JSON.stringify({
                          error: error.name,
                          id: animation.id,
                          type: animation.constructor.name,
                          property: animation.transitionProperty,
                          target: animation.effect?.target?.tagName,
                          classes: animation.effect?.target?.getAttribute("class"),
                          state: animation.playState,
                          time: animation.currentTime,
                          subject: animation.id === turn.id,
                        })}`,
                      );
                    }),
                  ),
                )
                  .then(() => {
                    const subject = animations.filter((animation) => animation.id === turn.id);
                    let low = 0;
                    let high = Number(turn.effect.getTiming().duration);
                    // Invert the browser's actual eased rotation, not a second
                    // copy of the production timing/curve implementation.
                    for (let index = 0; index < 16; index++) {
                      const time = (low + high) / 2;
                      subject.forEach((animation) => {
                        animation.currentTime = time;
                      });
                      const angle = Math.abs(
                        parseFloat(
                          getComputedStyle(host).rotate.match(/(-?[\d.]+)deg/)?.[1] ?? "0",
                        ),
                      );
                      if (angle < targetAngle) low = time;
                      else high = time;
                    }
                    return animations;
                  })
                  .then(resolve, reject);
              } else if (performance.now() > deadline)
                reject(new Error("Missed the real intermediate glow pose"));
              else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }),
        }),
        targetAngle,
      );
      await action();
      frozen = await pendingPose.evaluateHandle(({ pose }) => pose);
      const frame = await probe.evaluate(({ sample }) => sample());
      frame.uprightBox = uprightBox;
      const label = `en-${style}-${kind}-${phase}-glow`;
      await writeFile(
        path.join(evidence, `${label}-pose.json`),
        `${JSON.stringify({ phase, targetAngle, frame }, null, 2)}\n`,
      );
      assertPrintedTurnFrame(frame);
      assert.ok(
        frame.angle >= minimumAngle && frame.angle <= maximumAngle + 10,
        "Sample the real intermediate pose, never a settled substitute",
      );
      const paintedBytes = await page.screenshot({
        path: path.join(evidence, `${label}-painted.png`),
        animations: "allow",
      });
      const original = await card(seat).evaluate((host) => {
        const nodes = [
          host,
          ...host.querySelectorAll(".role-draw-glow,.active-player-lighting,.vgpu-player-lighting"),
        ];
        const styles = nodes.map((node) => node.getAttribute("style"));
        host.style.setProperty("box-shadow", "none", "important");
        nodes
          .slice(1)
          .forEach((node) => node.style.setProperty("visibility", "hidden", "important"));
        return styles;
      });
      let unlitBytes;
      try {
        unlitBytes = await page.screenshot({
          path: path.join(evidence, `${label}-unlit.png`),
          animations: "allow",
        });
      } finally {
        await card(seat).evaluate((host, styles) => {
          const nodes = [
            host,
            ...host.querySelectorAll(
              ".role-draw-glow,.active-player-lighting,.vgpu-player-lighting",
            ),
          ];
          nodes.forEach((node, index) =>
            styles[index] === null
              ? node.removeAttribute("style")
              : node.setAttribute("style", styles[index]),
          );
        }, original);
      }
      const after = await probe.evaluate(({ sample }) => sample());
      assert.equal(
        after.hostTurns,
        frame.hostTurns,
        "No wall-clock cleanup crossed the paired exposures",
      );
      assert.ok(
        Math.abs(frame.angle - after.angle) < 0.01,
        "Both exposures use exactly the same native pose",
      );
      // Decode only after the guarded exposures; PNG CPU work is not observation.
      const painted = PNG.sync.read(paintedBytes);
      const unlit = PNG.sync.read(unlitBytes);
      const pixels = assertPlayerCardGlowPixels(painted, unlit, frame);
      report.cases.push({
        kind: "printed-sampled-glow-pixels",
        source:
          "fresh accepted request; real native keyframes sought and paused; unchanged expiry guard",
        action: kind,
        phase,
        style,
        seat,
        frame,
        pixels,
      });
    } finally {
      await pendingPose?.dispose();
      if (frozen) {
        await frozen.evaluate((animations) =>
          animations.forEach((animation) => {
            if (animation.playState === "paused") animation.play();
          }),
        );
        await frozen.dispose();
      }
      await probe.evaluate(({ stop }) => stop());
      await probe.dispose();
    }
    await settled();
    const after = await saved();
    if (kind === "privacy")
      assert.deepEqual(after, before, "Sampled privacy poses are canonical no-ops");
    else {
      assert.deepEqual(
        after.events,
        before.events,
        "Sampled accepted rerolls never invent canonical events",
      );
      assert.deepEqual(after.legacyLog, before.legacyLog);
    }
  }

  async function eventCount(count) {
    await expect.poll(async () => (await read()).current.state.events.length).toBe(count);
  }

  async function completedCards(style, game) {
    const rows = await inventory(style);
    const paint = await allCards().evaluateAll((cards) =>
      cards.map((el) => {
        const css = getComputedStyle(el);
        return {
          seat: Number(el.closest(".seat-anchor").dataset.seat),
          face: el.dataset.cardFace,
          winner: el.dataset.winnerTeam ?? null,
          opacity: Number(css.opacity),
          filter: css.filter,
          colour: css.getPropertyValue("--winner-rgb").trim(),
          shadow: css.boxShadow,
          names: [...el.parentElement.querySelectorAll(":scope > .player-seat-caption")].map(
            (node) => ({
              text: node.textContent,
              visible: node.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
            }),
          ),
          roles: [
            ...el.querySelectorAll('.player-role-icon[role="img"],.printed-player-card__role'),
          ].map((node) => node.getAttribute("aria-label") ?? node.textContent),
          marks: el.querySelectorAll(
            ".deceased-cross,.player-torn-fragment,.player-bullet-hole,.player-disciplinary-ribbon,[data-player-exit]",
          ).length,
        };
      }),
    );
    for (const row of paint) {
      const player = game.players.find(({ seat }) => seat === row.seat);
      const expected = game.winner && player.team === game.winner ? game.winner : null;
      assert.equal(row.face, "front");
      assert.equal(row.winner, expected);
      assert.equal(row.opacity, 1);
      assert.equal(row.filter, "none");
      assert.equal(row.marks, 0);
      assert.deepEqual(row.names, [
        { text: players.find(({ id }) => id === player.id).nickname, visible: true },
      ]);
      assert.deepEqual(row.roles, [words[locale].roles[player.role]]);
      if (expected) {
        assert.equal(row.colour, expected === "red" ? "118 205 255" : "255 95 79");
        assert.notEqual(row.shadow, "none");
      }
    }
    return { rows, paint };
  }

  async function playerCaptionScenarios() {
    const stages = [
      "roles-undealt",
      "roles-partial",
      "day-front",
      "day-hidden",
      "readonly-hidden",
      "day-restored",
      "night-private",
      "goodbye-pending",
      "unknown-departure",
      "mafia-departure",
      "vote-pending",
      "vote-departure",
      "discipline-departure",
    ];
    const expected = stages.flatMap((stage) => styles.map((style) => `${stage}:${style}`)).sort();
    const record = async (stage, style, options = {}) => {
      await inventory(style, options);
      const names = await captions();
      assertGeometry(await geometry());
      if (stage === "vote-departure")
        assert.ok(
          names.filter(({ seat }) => [5, 6].includes(seat)).flatMap(({ actions }) => actions)
            .length > 0,
          "Night shooting actions actually exercise lower-seat caption clearance",
        );
      await capture(`captions-${stage}-${style}`);
      report.cases.push({ kind: "player-captions", stage, style, names });
      return names;
    };
    const sweep = async (stage, options = {}, cause) => {
      for (const style of styles) {
        await choose(style);
        if (cause) await departure(options.backs[0], cause);
        await record(stage, style, options);
      }
    };
    const turn = async (seat, action) => {
      const probe = await printedTurnProbe(seat);
      const before = await probe.evaluate(({ sample }) => sample());
      try {
        await action();
        await settled();
        const rows = await probe.evaluate(({ rows, sample }) => [...rows, sample()]);
        assert.ok(
          rows.some((row) => row.hostTurns > 0),
          "The native card turn was observed",
        );
        for (const row of rows) {
          assert.ok(
            row.caption?.visible && row.caption.upright,
            "Caption stays upright throughout the turn",
          );
          assert.ok(
            Math.abs(row.caption.opacity - 1) <= 0.002,
            "Caption never fades during a turn",
          );
          assert.equal(row.caption.text, before.caption.text);
          for (const key of ["x", "y", "width", "height"])
            assert.ok(
              Math.abs(row.caption.box[key] - before.caption.box[key]) <= 1,
              `Native turn leaves caption ${key} fixed`,
            );
        }
      } finally {
        await probe.evaluate(({ stop }) => stop());
        await probe.dispose();
      }
    };
    for (const style of styles) {
      await seed("roles", { reset: true });
      await choose(style);
      const before = await record("roles-undealt", style, { allBacks: true });
      const baseline = await geometry();
      await turn(1, () => card(1).click());
      const after = await record("roles-partial", style, { backs: [2, 3, 4, 5, 6, 7, 8, 9, 10] });
      // A dealt card intentionally scales to 1.04; its orbit and layout must not move.
      assert.deepEqual(
        after.map(({ anchor }) => anchor),
        before.map(({ anchor }) => anchor),
      );
      for (const row of (await geometry()).cards) {
        const original = baseline.cards.find(({ seat }) => seat === row.seat);
        assert.equal(row.layoutWidth, original.layoutWidth);
        assert.equal(row.layoutHeight, original.layoutHeight);
      }
    }
    await seed("day", { reset: true });
    const dayGeometry = await geometry();
    for (const style of styles) {
      await choose(style);
      if (style !== "glass")
        for (const placement of placements) {
          await choose(style, placement);
          await roleLayout(placement);
          await captions();
        }
      await record("day-front", style);
      assertGeometry(await geometry(), dayGeometry);
      if (style === "glass") await privacy(true);
      else await turn(1, () => privacy(true));
      await record("day-hidden", style, { allBacks: true });
      const current = await saved();
      await prefix(current.events.at(-1).sequence, () =>
        record("readonly-hidden", style, { allBacks: true }),
      );
      await privacy(false);
      await record("day-restored", style);
    }
    for (const [fixture, stage] of [
      ["night-result", "night-private"],
      ["goodbye", "goodbye-pending"],
    ]) {
      await seed(fixture, { reset: true });
      if (fixture === "night-result") await privacy(true); // Preserve the real private-night exemption.
      await sweep(stage);
    }
    const unknown = await seed("departed", { reset: true });
    await sweep("unknown-departure", { backs: [unknown.victimSeat] }, "unknown");
    const goodbye = await seed("goodbye", { reset: true });
    await page
      .getByRole("button", { name: `Begin day ${goodbye.state.game.day - 1}`, exact: true })
      .click();
    await eventCount(goodbye.state.events.length + 1);
    await sweep("mafia-departure", { backs: [goodbye.victimSeat] }, "mafia");
    const city = await seed("pre-vote", { reset: true });
    await page.getByRole("button", { name: "Accept sole nominee departure", exact: true }).click();
    await eventCount(city.state.events.length + 1);
    await sweep("vote-pending");
    const pending = await saved();
    await page.getByRole("button", { name: "Begin night", exact: true }).click();
    await eventCount(pending.events.length + 1);
    await sweep("vote-departure", { backs: [city.victimSeat] }, "vote");
    const day = await seed("day", { reset: true });
    const { dialog } = await openPlayerPenalty(page, 5);
    await dialog.getByRole("combobox", { name: "Removal rule", exact: true }).selectOption("6.2.3");
    await dialog.getByRole("button", { name: "Confirm discipline", exact: true }).click();
    await eventCount(day.state.events.length + 1);
    await sweep("discipline-departure", { backs: [5] }, "discipline");
    // Existing bounded completion lane retains winner pixels, both parties,
    // draw/cancel, reload, history and Undo; inventory now checks external captions too.
    await completionScenarios();
    const actual = report.cases
      .filter(({ kind }) => kind === "player-captions")
      .map(({ stage, style }) => `${stage}:${style}`)
      .sort();
    assert.deepEqual(actual, expected, "Every declared caption case executes exactly once");
    assert.equal(report.cases.filter(({ kind }) => kind === "completed-party").length, 8);
    assert.equal(report.cases.filter(({ kind }) => kind === "completed-without-winner").length, 8);
  }

  async function glassReflectionScenarios() {
    for (const enhanced of [true, false]) {
      const giveaway = await seed("roles", { reset: true });
      if (!enhanced) {
        // A real unavailable shared renderer, not Glass/Fancy OFF. Keep the
        // local optical fallback and unrelated lighting contexts operational.
        await page.addInitScript(() => {
          const original = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function (type, ...options) {
            if (this.classList.contains("glass-scene-canvas") && type.startsWith("webgl"))
              return null;
            return original.call(this, type, ...options);
          };
        });
        await page.reload({ waitUntil: "networkidle" });
        await settled();
        await expect(page.locator(".app-shell")).toHaveAttribute(
          "data-glass-status",
          "unavailable",
        );
      } else await expect(page.locator(".app-shell")).toHaveAttribute("data-glass-status", "ready");
      let blueprint = giveaway.state.setup.setup;
      const colours = new Set();
      let firstSeat;
      const mode = enhanced ? "enhanced" : "fallback";
      for (let seat = 1; seat <= 10 && colours.size < 2; seat++) {
        blueprint = domain.drawRoleForSeat(blueprint, seat);
        const role = blueprint.assignments[seat];
        const colour = role === "mafia" || role === "don" ? "red" : "light-blue";
        if (!colours.has(colour)) {
          firstSeat ??= seat;
          await naturalPrintedTurn("glass", seat, `${mode}-deal-${colour}`, () =>
            card(seat).click(),
          );
          colours.add(colour);
        } else {
          await card(seat).click();
          await settled();
        }
        assert.deepEqual((await saved()).setup.setup, blueprint);
      }
      assert.equal(colours.size, 2, "Both real dealt-party colours are exercised");
      await naturalPrintedTurn("glass", firstSeat, `${mode}-reroll`, () =>
        card(firstSeat).click({ clickCount: 3, delay: 80 }),
      );
    }
  }
  async function completionScenarios() {
    for (const stage of ["roles", "day"]) {
      await seed(stage, { reset: true });
      if (stage === "day") await privacy(true);
      for (const style of styles.slice(1)) {
        await choose(style);
        await inventory(style, { allBacks: true });
        report.cases.push({ kind: "nameless-reverse", stage, style });
      }
    }
    for (const winner of ["red", "black"]) {
      const goodbye = await seed("goodbye", { reset: true });
      await page
        .getByRole("button", {
          name: `Begin day ${goodbye.state.game.day - 1}`,
          exact: true,
        })
        .click();
      await eventCount(goodbye.state.events.length + 1);
      const initial = await saved();
      const removedSeat = initial.game.players.find(({ team }) => team === "black").seat;
      const removal = (await openPlayerPenalty(page, removedSeat)).dialog;
      await removal
        .getByRole("combobox", { name: "Removal rule", exact: true })
        .selectOption("6.2.3");
      await removal.getByRole("button", { name: "Confirm discipline", exact: true }).click();
      await eventCount(initial.events.length + 1);
      const active = await saved();
      for (const style of styles) {
        await choose(style);
        await departure(goodbye.victimSeat, "mafia");
        await departure(removedSeat, "discipline");
      }
      await privacy(true);
      const offender = active.game.players.find(
        (player) => player.team !== winner && player.status === "active",
      ).seat;
      const ruling = (await openPlayerPenalty(page, offender)).dialog;
      await ruling
        .getByRole("combobox", { name: "Discipline action", exact: true })
        .selectOption("opponent-victory");
      await ruling.getByRole("combobox", { name: /^Applicable rule/ }).selectOption("6.3.1");
      await ruling
        .getByLabel("Judge's reason", { exact: true })
        .fill("Completion presentation fixture");
      await ruling
        .getByRole("button", { name: "Award victory to opposing team", exact: true })
        .click();
      await eventCount(active.events.length + 1);
      const finished = await saved();
      assert.equal(finished.game.phase, "finished");
      assert.equal(finished.game.winner, winner);
      assert.deepEqual(finished.game.players, active.game.players);
      for (const style of styles) {
        await choose(style);
        const result = await completedCards(style, finished.game);
        const winnerSeat = finished.game.players.find(({ team }) => team === winner).seat;
        const target = card(winnerSeat);
        const frame = await target.evaluate((el) => ({
          box: el.getBoundingClientRect().toJSON(),
          layoutWidth: el.offsetWidth,
          layoutHeight: el.offsetHeight,
          lights: [],
        }));
        const painted = await page.screenshot({
          path: path.join(evidence, `winner-${winner}-${style}-painted.png`),
        });
        let unlit;
        try {
          await target.evaluate((el) => el.removeAttribute("data-winner-team"));
          await settled();
          unlit = await page.screenshot({
            path: path.join(evidence, `winner-${winner}-${style}-unlit.png`),
          });
        } finally {
          await target.evaluate((el, team) => el.setAttribute("data-winner-team", team), winner);
          await settled();
        }
        result.glowPixels = assertPlayerCardGlowPixels(
          PNG.sync.read(painted),
          PNG.sync.read(unlit),
          frame,
        );
        await capture(`completed-${winner}-${style}`);
        await reloadWithoutFeedback();
        await completedCards(style, finished.game);
        // Privacy is session-local App state, not a persisted preference. Reload
        // resets it; turn it on again before testing history and Undo retention.
        await privacy(true);
        await prefix(finished.events.at(-1).sequence, () => completedCards(style, finished.game));
        await prefix(active.events.at(-1).sequence, async () => {
          await expect(page.locator("[data-winner-team],.is-game-complete")).toHaveCount(0);
          await inventory(style, { allBacks: style !== "glass" });
        });
        report.cases.push({ kind: "completed-party", winner, style, ...result });
      }
      const restored = await undo();
      assert.equal(domain.hashGameState(restored.game), domain.hashGameState(active.game));
      await expect(page.locator("[data-winner-team],.is-game-complete")).toHaveCount(0);
      await inventory("noir", { allBacks: true });
    }
    for (const stage of ["draw", "cancelled"]) {
      const fixture = await seed(stage, { reset: true });
      for (const style of styles) {
        await choose(style);
        await completedCards(style, fixture.state.game);
        report.cases.push({ kind: "completed-without-winner", stage, style });
      }
    }
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
    if (process.env.PLAYER_CARDS_UI_SMOKE === "player-captions") {
      await playerCaptionScenarios();
      api.clean();
      assert.deepEqual(transportErrors, []);
      report.status = "passed";
      return;
    }
    if (process.env.PLAYER_CARDS_UI_SMOKE === "glass-reflection") {
      await glassReflectionScenarios();
      api.clean();
      assert.deepEqual(transportErrors, []);
      report.status = "passed";
      return;
    }
    await completionScenarios();
    if (process.env.PLAYER_CARDS_UI_SMOKE === "reverse-completion") {
      api.clean();
      assert.deepEqual(transportErrors, []);
      report.status = "passed";
      console.log(`Player-card completion verification: ${report.cases.length} cases PASS`);
      return;
    }
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
      await noDeparture(night.victimSeat);
      await privacy(true);
      await inventory("classic");
      await privacy(false);
      report.cases.push({ locale, kind: "private-night-exemption", victim: night.victimSeat });
      const goodbye = await seed("goodbye", {
        exitSettings: { ...DEFAULT_PLAYER_EXIT_SETTINGS, finalOpacity: locale === "en" ? 60 : 45 },
      });
      await inventory("classic"); // pending goodbye remains a visible face
      await noDeparture(goodbye.victimSeat);
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
      await departure(goodbye.victimSeat, "mafia");
      if (locale === "en") {
        const endpoints = await departureStyles(goodbye.victimSeat, "mafia");
        await choose("classic");
        await restoredPrefixStyles(beforeGoodbye.events.at(-1).sequence, goodbye.victimSeat);
        await prefix(afterGoodbye.events.at(-1).sequence, () =>
          departure(goodbye.victimSeat, "mafia"),
        );
        report.cases.push({ kind: "mafia-history-prefixes-all-styles", endpoints });
      }
      await reloadWithoutFeedback();
      await departure(goodbye.victimSeat, "mafia");
      assert.deepEqual(
        await saved(),
        afterGoodbye,
        "Reload retains the exact accepted Mafia history",
      );
      const restored = await undo();
      assert.equal(domain.hashGameState(restored.game), domain.hashGameState(beforeGoodbye.game));
      await noDeparture(goodbye.victimSeat);
      await inventory("classic");
      await restoredStyles(goodbye.victimSeat);
      report.cases.push({ locale, kind: "accepted-goodbye-and-undo", victim: goodbye.victimSeat });
    }

    // Actions use English once, not every style × locale × gesture combination.
    locale = "en";
    const unknown = await seed("departed", {
      reset: true,
      exitSettings: { ...DEFAULT_PLAYER_EXIT_SETTINGS, finalOpacity: 65 },
    });
    const unknownState = await saved();
    const unknownEndpoints = await departureStyles(unknown.victimSeat, "unknown");
    await reloadWithoutFeedback();
    await departure(unknown.victimSeat, "unknown");
    assert.deepEqual(
      await saved(),
      unknownState,
      "Completed baseline does not acquire invented cause history",
    );
    report.cases.push({ kind: "unknown-completed-baseline-neutral", endpoints: unknownEndpoints });

    const city = await seed("pre-vote", { reset: true });
    await choose("classic");
    const beforeVote = await saved();
    await noDeparture(city.victimSeat);
    await page.getByRole("button", { name: "Accept sole nominee departure", exact: true }).click();
    await eventCount(beforeVote.events.length + 1);
    const pendingVote = await saved();
    assert.equal(pendingVote.events.at(-1).type, "turn.completed");
    assert.equal(
      domain.hashGameState(pendingVote.game),
      domain.hashGameState(domain.completeCurrentTurn(beforeVote.game)),
    );
    assert.equal(pendingVote.game.phase, "goodbye-speech");
    assert.deepEqual(pendingVote.game.goodbyeSeats, [city.victimSeat]);
    assert.equal(pendingVote.game.goodbyeNext, "night");
    await noDeparture(city.victimSeat);
    await inventory("classic");
    await page.getByRole("button", { name: "Begin night", exact: true }).click();
    await eventCount(pendingVote.events.length + 1);
    const afterVote = await saved();
    assert.equal(afterVote.events.at(-1).type, "phase.changed");
    assert.equal(
      domain.hashGameState(afterVote.game),
      domain.hashGameState(domain.completeGoodbyeSpeech(pendingVote.game)),
    );
    assert.equal(afterVote.game.goodbyeSeats, undefined);
    const cityEndpoints = await departureStyles(city.victimSeat, "vote");
    await choose("classic");
    await restoredPrefixStyles(beforeVote.events.at(-1).sequence, city.victimSeat);
    await restoredPrefixStyles(pendingVote.events.at(-1).sequence, city.victimSeat);
    await prefix(afterVote.events.at(-1).sequence, () => departure(city.victimSeat, "vote"));
    await reloadWithoutFeedback();
    await departure(city.victimSeat, "vote");
    assert.deepEqual(
      await saved(),
      afterVote,
      "City endpoint is reconstructed from the real accepted branch on reload",
    );
    const pendingAgain = await undo();
    assert.equal(domain.hashGameState(pendingAgain.game), domain.hashGameState(pendingVote.game));
    await noDeparture(city.victimSeat);
    await restoredStyles(city.victimSeat);
    const preVoteAgain = await undo();
    assert.equal(domain.hashGameState(preVoteAgain.game), domain.hashGameState(beforeVote.game));
    assert.equal(
      preVoteAgain.game.players.every(({ status }) => status === "active"),
      true,
    );
    await noDeparture(city.victimSeat);
    await inventory("classic");
    await restoredStyles(city.victimSeat);
    report.cases.push({
      kind: "accepted-city-goodbye-prefixes-reload-undo",
      endpoints: cityEndpoints,
    });

    await seed("day", {
      reset: true,
      exitSettings: { ...DEFAULT_PLAYER_EXIT_SETTINGS, finalOpacity: 35 },
    });
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
    const foulSelector = '.seat-anchor[data-seat="5"] .card-discipline-status';
    const foulActions = [];
    for (let number = 1; number <= 3; number++) {
      const previous = await saved();
      // GameTable requires >44px and vertical/horizontal dominance >1.2.
      const accepted = await feedback(foulSelector, async () => {
        const trace = await gesture(5, 72);
        await eventCount(previous.events.length + 1);
        return trace;
      });
      const player = accepted.state.game.players.find(({ seat }) => seat === 5);
      assert.equal(accepted.state.events.at(-1).type, "foul.issued");
      assert.equal(accepted.state.events.length, previous.events.length + 1);
      assert.equal(player.fouls, number);
      assert.equal(player.status, "active", "Fouls one through three do not fabricate departures");
      assert.equal(player.mutePending, number === 3);
      assert.equal(
        domain.hashGameState(accepted.state.game),
        domain.hashGameState(domain.issueFoul(previous.game, 5)),
      );
      await expect(card(5).locator(".foul-dot")).toHaveCount(number);
      await expect(card(5).getByRole("img", { name: "Muted turn", exact: true })).toHaveCount(
        number === 3 ? 1 : 0,
      );
      await noDeparture(5);
      foulActions.push(accepted);
    }
    const trace = foulActions[0].result;
    assert.equal(
      new Set(foulActions.flatMap(({ ids }) => ids)).size,
      3,
      "Three distinct accepted foul cues",
    );
    const thirdFoul = foulActions.at(-1).state;
    await feedback(
      foulSelector,
      () =>
        prefix(beforeFoul.events[0].sequence, async () => {
          await expect(card(5).locator(".foul-dot,.card-mute")).toHaveCount(0);
          await noDeparture(5);
        }),
      0,
    );
    await feedback(
      foulSelector,
      () =>
        prefix(thirdFoul.events.at(-1).sequence, async () => {
          await expect(card(5).locator(".foul-dot")).toHaveCount(3);
          await expect(card(5).getByRole("img", { name: "Muted turn", exact: true })).toBeVisible();
          await noDeparture(5);
        }),
      0,
    );
    assert.deepEqual(
      await reloadWithoutFeedback(),
      thirdFoul,
      "Reload restores accepted fouls without replaying feedback",
    );
    await expect(card(5).locator(".foul-dot")).toHaveCount(3);
    await expect(card(5).getByRole("img", { name: "Muted turn", exact: true })).toBeVisible();
    await gesture(5, 72);
    const fourthDialog = page.locator("dialog.federation-judge-dialog.is-discipline[open]");
    await expect(fourthDialog).toBeVisible();
    assert.deepEqual(
      await saved(),
      thirdFoul,
      "Opening fourth-foul confirmation is not acceptance",
    );
    await expect(
      fourthDialog.getByRole("button", { name: "Confirm discipline", exact: true }),
    ).toBeDisabled();
    await fourthDialog
      .getByRole("combobox", { name: "Occurrence timing", exact: true })
      .selectOption("day-discussion");
    await fourthDialog.getByRole("button", { name: "Confirm discipline", exact: true }).click();
    await eventCount(thirdFoul.events.length + 1);
    const fourthFoul = await saved();
    assert.equal(fourthFoul.events.at(-1).type, "discipline.foul-issued");
    assert.equal(fourthFoul.game.players.find(({ seat }) => seat === 5).fouls, 4);
    assert.equal(fourthFoul.game.players.find(({ seat }) => seat === 5).status, "red-carded");
    await departure(5, "discipline");
    const fourthUndo = await feedback(foulSelector, () => undo(), 0);
    assert.equal(domain.hashGameState(fourthUndo.state.game), domain.hashGameState(thirdFoul.game));
    await noDeparture(5);
    await restoredStyles(5);
    for (let remaining = 2; remaining >= 0; remaining--) {
      const reverted = await feedback(foulSelector, () => undo(), 0);
      assert.equal(reverted.state.game.players.find(({ seat }) => seat === 5).fouls, remaining);
      await expect(card(5).locator(".foul-dot")).toHaveCount(remaining);
      await expect(card(5).locator(".card-mute")).toHaveCount(0);
    }
    assert.equal(domain.hashGameState((await saved()).game), domain.hashGameState(beforeFoul.game));
    report.cases.push({
      kind: "accepted-fouls-mute-fourth-prefixes-reload-undo",
      feedbackIds: foulActions.flatMap(({ ids }) => ids),
    });
    const beforeRemoval = await saved();
    await feedback(
      ".card-discipline-status",
      async () => {
        const cancelled = await openPlayerPenalty(page, 5);
        await cancelled.dialog
          .getByRole("combobox", { name: "Removal rule", exact: true })
          .selectOption("6.2.3");
        assert.deepEqual(
          await saved(),
          beforeRemoval,
          "Unconfirmed discipline has no canonical effect",
        );
        await cancelled.dialog.getByRole("button", { name: "Close", exact: true }).click();
      },
      0,
    );
    assert.deepEqual(
      await saved(),
      beforeRemoval,
      "Cancelled discipline preserves the complete acknowledged state",
    );
    await noDeparture(5);
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
    const disciplineEndpoints = await departureStyles(5, "discipline");
    await choose("heritage");
    await prefix(beforeRemoval.events[0].sequence, () => noDeparture(5));
    await prefix(removed.events.at(-1).sequence, () => departure(5, "discipline"));
    await reloadWithoutFeedback();
    await departure(5, "discipline");
    assert.deepEqual(await saved(), removed, "Disciplinary endpoint survives canonical reload");
    await privacy(true);
    const hiddenRestore = await undo();
    assert.equal(
      domain.hashGameState(hiddenRestore.game),
      domain.hashGameState(beforeRemoval.game),
    );
    await inventory("heritage", { allBacks: true });
    await privacy(false);
    await inventory("heritage");
    await noDeparture(5);
    await restoredStyles(5);
    report.cases.push({
      kind: "trusted-selection-foul-removal-undo",
      trace,
      disciplineEndpoints,
      penaltyInput: report.browser === "chromium" ? "touch" : "pointer",
    });

    // The existing team-result card receives the accepted ruling; no player dies.
    const beforeRuling = await saved();
    const offenderSeat = beforeRuling.game.players.find(({ team }) => team === "black").seat;
    const rulingDialog = (await openPlayerPenalty(page, offenderSeat)).dialog;
    await rulingDialog
      .getByRole("combobox", { name: "Discipline action", exact: true })
      .selectOption("opponent-victory");
    await rulingDialog.getByRole("combobox", { name: /^Applicable rule/ }).selectOption("6.3.5");
    await rulingDialog
      .getByLabel("Judge's reason", { exact: true })
      .fill("Verifier accepted ruling with committee agreement");
    const award = rulingDialog.getByRole("button", {
      name: "Award victory to opposing team",
      exact: true,
    });
    await expect(award).toBeDisabled();
    assert.deepEqual(await saved(), beforeRuling, "Incomplete ruling cannot mutate the game");
    await rulingDialog
      .getByRole("checkbox", { name: "Required committee agreement obtained", exact: true })
      .check();
    const ruling = await feedback(".winner-card", async () => {
      await award.click();
      await eventCount(beforeRuling.events.length + 1);
    });
    assert.equal(ruling.state.events.at(-1).type, "game.adjudicated");
    assert.equal(ruling.state.game.winner, "red");
    assert.deepEqual(
      ruling.state.game.players,
      beforeRuling.game.players,
      "Team ruling cannot mutate any player status or discipline",
    );
    await expect(page.locator(".winner-card")).toBeVisible();
    await expect(
      page.locator(
        ".player-seat[data-departure-cause],.player-bullet-hole,.player-torn-fragment,.player-disciplinary-ribbon",
      ),
    ).toHaveCount(0);
    await prefix(ruling.state.events.at(-1).sequence, async () => {
      // Read-only history deliberately replaces the live result center with
      // preview navigation; its terminal phase, not a live cue, is the contract.
      await expect(page.locator(".game-shell.is-history-preview.phase-finished")).toBeVisible();
      await expect(page.locator(".preview-state-center")).toBeVisible();
      await expect(page.locator("[data-player-feedback],[data-player-exit]")).toHaveCount(0);
    });
    await expect(page.locator(".winner-card.winner-red")).toBeVisible();
    assert.deepEqual(
      await reloadWithoutFeedback(),
      ruling.state,
      "Team result survives exact canonical reload without a replayed pulse",
    );
    await expect(page.locator(".winner-card")).toBeVisible();
    const unruled = await undo();
    assert.equal(domain.hashGameState(unruled.game), domain.hashGameState(beforeRuling.game));
    await expect(page.locator(".winner-card")).toHaveCount(0);
    report.cases.push({
      kind: "accepted-team-ruling-result-feedback-reload-undo",
      feedbackIds: ruling.ids,
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
          const clip = await card(1).evaluate((host) => {
            const a = host.getBoundingClientRect(),
              b = host.parentElement
                .querySelector(":scope > .player-seat-caption")
                .getBoundingClientRect();
            return {
              x: Math.min(a.x, b.x),
              y: Math.min(a.y, b.y),
              width: Math.max(a.right, b.right) - Math.min(a.x, b.x),
              height: Math.max(a.bottom, b.bottom) - Math.min(a.y, b.y),
            };
          });
          const painted = await page.screenshot({ clip, animations: "disabled" });
          for (const selector of [
            ".printed-player-card__art",
            ".player-seat-caption",
            ".printed-player-card__role",
          ]) {
            const part =
              selector === ".player-seat-caption" ? caption(1) : card(1).locator(selector);
            await part.evaluate((el) => {
              el.style.visibility = "hidden";
            });
            const without = await page.screenshot({ clip, animations: "disabled" });
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

    // H3 stays in the actual-App journey. Reuse admitted setup/day fixtures,
    // native accepted draws/rerolls and the real public speaker lighting.
    for (const style of styles.filter((value) => value !== "glass")) {
      const giveaway = await seed("roles", { reset: true });
      await choose(style);
      let blueprint = giveaway.state.setup.setup;
      const colours = new Set();
      let firstSeat;
      for (let seat = 1; seat <= 10 && colours.size < 2; seat++) {
        blueprint = domain.drawRoleForSeat(blueprint, seat);
        const role = blueprint.assignments[seat];
        const colour = role === "mafia" || role === "don" ? "red" : "light-blue";
        if (!colours.has(colour)) {
          firstSeat ??= seat;
          await naturalPrintedTurn(style, seat, `deal-${colour}`, () => card(seat).click());
          colours.add(colour);
        } else {
          await card(seat).click();
          await settled();
        }
        assert.deepEqual(
          (await saved()).setup.setup,
          blueprint,
          "Real seeded dealing supplies the expected glow colour",
        );
      }
      assert.equal(colours.size, 2, "Exercise real red and light-blue dealt glows");
      const reroll = () => card(firstSeat).click({ clickCount: 3, delay: 80 });
      await naturalPrintedTurn(style, firstSeat, "reroll", reroll);
      for (const phase of ["lift", "front", "near-edge", "reverse"])
        await sampledPrintedGlow(style, firstSeat, "reroll", phase, reroll);
      await seed("day", { reset: true });
      await choose(style);
      const live = await saved();
      const speaker = live.game.turnOrder[live.game.currentTurnIndex];
      await expect(
        card(speaker).locator('.active-player-lighting[data-active="true"]'),
      ).toHaveCount(1);
      await naturalPrintedTurn(
        style,
        speaker,
        "privacy-interruption",
        () => page.getByRole("button", { name: words.en.hide, exact: true }).click(),
        { interrupt: true },
      );
      await inventory(style, { allBacks: true });
      assert.deepEqual(
        await saved(),
        live,
        "Privacy interruption preserves the complete acknowledged game",
      );
      await privacy(false);
      await noDeparture(speaker);
      for (const phase of ["lift", "front", "near-edge", "reverse"]) {
        await sampledPrintedGlow(style, speaker, "privacy", phase, () =>
          page.getByRole("button", { name: words.en.hide, exact: true }).click(),
        );
        await privacy(false);
      }
      const greeting = await seed("sheriff-greeting", { reset: true });
      await choose(style);
      await privacy(true); // The real opening-night exemption deliberately keeps the private cue.
      const sheriff = greeting.state.game.players.find(({ role }) => role === "sheriff").seat;
      await expect(card(sheriff)).toHaveClass(/is-sheriff-highlight/);
      await naturalPrintedTurn(
        style,
        sheriff,
        "privacy-opening-boundary",
        () => page.getByRole("button", { name: "Begin round zero", exact: true }).click(),
        { openingBoundary: true },
      );
      await inventory(style, { allBacks: true });
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
    report.failure = { url: page.url(), screenshot: path.join(evidence, "failed.png") };
    await page.screenshot({ path: report.failure.screenshot }).catch((captureError) => {
      report.failure.captureError = String(captureError);
    });
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
