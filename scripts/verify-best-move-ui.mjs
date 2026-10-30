/**
 * Focused real-App Best Move verification, using verify-ui.mjs's strict API fixture.
 * APP_URL=http://127.0.0.1:5186 UI_BEST_MOVE_ONLY=1 node scripts/verify-ui.mjs
 * Run separately at Chromium 1366x768 / 1000x600 and WebKit 1366x1024.
 * This proves browser/local/mock-API consistency, not real-backend persistence.
 */
/* global URL, localStorage, fetch, document, innerWidth, innerHeight */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import * as domain from "../packages/game-domain/src/index.ts";
import { getActiveBranch } from "../apps/web/src/features/game/game-history.ts";
import { isCurrentGameSessionState } from "../apps/web/src/session-outbox.ts";
import { resolveUiMode } from "./ui-presentation-contracts.mjs";
import {
  checkpoint,
  currentSetupState,
  envelope as federationEnvelope,
} from "./verify-federation-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const storageKey = "mafia-dashboard.game-session.v5";
const locales = ["en", "ru"];
const outcomes = ["skip-0", "skip-1", "skip-2", "skip-3", "record-3"];
const interactions = ["select-retap", "limit-deselect-all", "timer-manual"];
const words = {
  en: {
    heading: "Best move",
    record: "Record Best Move",
    skip: "Skip Best Move",
    select: (seat) => `Select player ${seat} for Best Move`,
    deselect: (seat) => `Deselect player ${seat} from Best Move`,
    shots: (name) => `Assign all Mafia shots to ${name}`,
    evaluate: "Evaluate Mafia shots",
    continue: "Continue night",
    don: "Skip Don check",
    sheriff: "Skip Sheriff check",
    morning: "Announce morning",
    goodbye: "Goodbye speech",
    undo: /^Undo last action/,
    timer: "Start 20 second timer",
    selected: "Selected Best Move players",
  },
  ru: {
    heading: "Лучший ход",
    record: "Записать лучший ход",
    skip: "Пропустить лучший ход",
    select: (seat) => `Выбрать игрока ${seat} для лучшего хода`,
    deselect: (seat) => `Убрать игрока ${seat} из лучшего хода`,
    shots: (name) => `Назначить все выстрелы мафии в игрока ${name}`,
    evaluate: "Определить результат выстрелов мафии",
    continue: "Продолжить ночь",
    don: "Пропустить проверку Дона",
    sheriff: "Пропустить проверку Шерифа",
    morning: "Объявить утро",
    goodbye: "Прощальная речь",
    undo: /^Отменить последнее действие/,
    timer: "Запустить таймер на 20 секунд",
    selected: "Выбранные игроки лучшего хода",
  },
};

export function resolveBestMoveUiMode(env) {
  const { UI_BEST_MOVE_ONLY: flag, ...other } = env;
  assert.ok([undefined, "", "0", "1"].includes(flag), "UI_BEST_MOVE_ONLY must be 0 or 1");
  const mode = resolveUiMode(other);
  if (flag !== "1") return mode;
  assert.equal(mode, "default", "UI_BEST_MOVE_ONLY conflicts with another verifier mode");
  return "best-move";
}

export function bestMoveNightFixture(players, gameId) {
  assert.ok(players.length >= 11, "Ten seated players and a separate host are required");
  let setup = domain.beginRoleDraw(
    domain.createSetup(players.slice(0, 10).map((p, i) => ({ id: p.id, seat: i + 1 }))),
    domain.createSeededRandom(71),
  );
  for (let seat = 1; seat <= 10; seat++) setup = domain.drawRoleForSeat(setup, seat);
  let game = domain.createGame(domain.completeRoleDraw(setup));
  while (game.phase !== "day") game = domain.advanceSetupPhase(game);
  game = domain.beginNight(game);
  const state = checkpoint(
    game,
    {
      ...currentSetupState(),
      hostPlayerId: players[10].id,
      setup: { step: "roles", selectedPlayerIds: game.players.map((p) => p.id), setup: null },
    },
    gameId,
  );
  assert.equal(state.game.phase, "night-mafia");
  assert.equal(state.game.bestMove, undefined);
  assert.equal(isCurrentGameSessionState(state), true);
  return state;
}

export function bestMoveFixtureTargets(state) {
  const victim = state.game.players.find((p) => p.role === "citizen");
  assert.ok(victim, "A non-check-owner victim is required");
  const targets = [
    ...state.game.players.filter((p) => p.team === "black").slice(0, 2),
    state.game.players.find((p) => p.team === "red" && p.seat !== victim.seat),
  ].map((p) => p.seat);
  assert.equal(new Set(targets).size, 3);
  assert.equal(targets.includes(victim.seat), false);
  return { victim, targets };
}

export function assertBestMoveCoverage(report) {
  const keys = report.scenarios.map(({ locale, outcome }) => `${locale}:${outcome}`).sort();
  assert.deepEqual(
    keys,
    locales.flatMap((locale) => outcomes.map((outcome) => `${locale}:${outcome}`)).sort(),
    "Best Move requires all ten distinct EN/RU outcomes",
  );
  assert.deepEqual(
    report.interactions.map(({ locale, name }) => `${locale}:${name}`).sort(),
    locales.flatMap((locale) => interactions.map((name) => `${locale}:${name}`)).sort(),
    "Best Move requires real retap, full deselection and manual timer checks in both languages",
  );
}

async function sourceManifest() {
  const files = [
    "package.json",
    "package-lock.json",
    "apps/web/package.json",
    "apps/web/index.html",
    "apps/web/vite.config.ts",
    "packages/game-domain/package.json",
    "scripts/verify-ui.mjs",
    "scripts/verify-federation-ui.mjs",
    "scripts/verify-best-move-ui.mjs",
    "scripts/session-verifier-contracts.mjs",
    "scripts/ui-presentation-contracts.mjs",
  ];
  async function walk(relative) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(name);
      else if (!/\.(?:test|spec)\./.test(entry.name)) files.push(name);
    }
  }
  for (const dir of [
    "apps/web/src",
    "apps/web/public",
    "packages/game-domain/src",
    "packages/game-domain/dist",
  ])
    await walk(dir);
  return Object.fromEntries(
    await Promise.all(
      [...new Set(files)].sort().map(async (name) => [
        name,
        createHash("sha256")
          .update(await readFile(path.join(root, name)))
          .digest("hex"),
      ]),
    ),
  );
}

const active = (state) => getActiveBranch(state.events, state.headEventId);
function replay(state) {
  assert.equal(isCurrentGameSessionState(state), true, "Saved App state must remain admissible");
  const branch = active(state);
  const result = domain.replayGameLog(state.initialGame, branch);
  assert.equal(domain.hashGameState(result.game), domain.hashGameState(state.game));
  return {
    hash: domain.hashGameState(result.game),
    events: branch.length,
    headEventId: state.headEventId,
  };
}

export async function runBestMoveScenarios({ page, baseUrl, club, players, api, evidenceDir }) {
  assert.match(
    new URL(baseUrl).hostname,
    /^(localhost|127\.0\.0\.1|\[::1\])$/,
    "Owned loopback only",
  );
  const evidence = path.resolve(evidenceDir);
  await mkdir(evidence, { recursive: true });
  const viewport = page.viewportSize();
  assert.ok(viewport?.width > 0 && viewport?.height > 0, "A nonempty viewport is required");
  const report = {
    status: "running",
    browser: page.context().browser().browserType().name(),
    viewport,
    fixture: "real App with verify-ui strict mocked API; not real-backend proof",
    scenarios: [],
    interactions: [],
    screenshots: [],
    geometry: [],
    toggles: [],
  };
  const originalLanguage = club.language;
  const button = (name) => page.getByRole("button", { name, exact: true });
  const card = (seat) => page.locator(`.seat-anchor[data-seat="${seat}"] .player-seat`);
  async function read() {
    return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), storageKey);
  }
  async function settled() {
    await expect(page.locator('.save-indicator[data-status="saved"]')).toBeVisible();
    await expect
      .poll(
        async () => {
          const env = await read();
          return (
            !!env?.current &&
            !env.failed &&
            env.outbox.length === 0 &&
            JSON.stringify(api.sessions.get(env.gameId)?.state) ===
              JSON.stringify(env.current.state)
          );
        },
        { message: "Local state and strict API fixture must settle exactly" },
      )
      .toBe(true);
    const env = await read();
    const remote = await page.evaluate(async (gameId) => {
      const response = await fetch(`/api/game-sessions/${gameId}`);
      if (!response.ok) throw new Error(`Best Move fixture readback: HTTP ${response.status}`);
      return response.json();
    }, env.gameId);
    assert.deepEqual(
      remote.session.state,
      env.current.state,
      "Browser GET readback matches local canonical state",
    );
    assert.deepEqual(api.sessions.get(env.gameId).state, env.current.state);
    api.clean();
    replay(env.current.state);
    return env;
  }
  async function reload(expected) {
    await page.reload({ waitUntil: "networkidle" });
    const actual = await settled();
    assert.deepEqual(
      actual.current.state,
      expected.current.state,
      "Reload preserves exact canonical state and head",
    );
    return actual;
  }
  async function undo(expected, w) {
    await page.getByRole("button", { name: w.undo }).click();
    const confirm = page.getByRole("button", { name: /^(Undo|Отменить)$/ });
    if (await confirm.isVisible()) await confirm.click();
    await expect
      .poll(async () => (await read())?.current.state.headEventId)
      .toBe(expected.current.state.headEventId);
    const restored = await settled();
    assert.equal(
      restored.current.state.headEventId,
      expected.current.state.headEventId,
      "Undo restores the exact prior head",
    );
    assert.deepEqual(
      restored.current.state.game,
      expected.current.state.game,
      "Undo restores exact selections/result",
    );
    assert.deepEqual(
      active(restored.current.state),
      active(expected.current.state),
      "Undo restores the active replay branch",
    );
    return restored;
  }
  async function noRetiredControls() {
    await expect(page.locator(".table-stage input, .table-stage select")).toHaveCount(0);
    await expect(page.locator('.table-stage [role="checkbox"]')).toHaveCount(0);
    await expect(
      page.locator(".table-stage button").filter({
        hasText:
          /Accept number|Accept Best Move|Finish early|Correct spoken slip|Time expired|Read back|Принять номер|Завершить раньше|Исправить оговорку|Время вышло|Прочитано/,
      }),
    ).toHaveCount(0);
  }
  async function selectionUi(state, w) {
    const { playerSeat, selectedSeats } = state.game.bestMove;
    await expect(page.getByRole("heading", { name: w.heading, exact: true })).toBeVisible();
    await expect(page.locator(".table-advance button")).toHaveText([w.record, w.skip]);
    assert.equal(await button(w.record).isEnabled(), selectedSeats.length === 3);
    await expect(button(w.skip)).toBeEnabled();
    await noRetiredControls();
    for (const player of state.game.players) {
      const selected = selectedSeats.includes(player.seat);
      await expect(card(player.seat)).toHaveAttribute(
        "aria-label",
        selected ? w.deselect(player.seat) : w.select(player.seat),
      );
      await expect(card(player.seat)).toHaveAttribute("aria-pressed", String(selected));
      assert.equal(
        await card(player.seat).isDisabled(),
        player.seat === playerSeat || (selectedSeats.length === 3 && !selected),
      );
      if (selected || player.seat === playerSeat)
        await expect(card(player.seat)).toHaveClass(/is-voting-highlight/);
      else await expect(card(player.seat)).not.toHaveClass(/is-voting-highlight/);
    }
    assert.equal(Object.hasOwn(state.game.bestMove, "mafiaHits"), false);
    assert.equal(Object.hasOwn(state.game.bestMove, "readbackAcknowledged"), false);
    await expect(page.getByRole("list", { name: w.selected }).locator("li")).toHaveText(
      selectedSeats.map((seat) => `#${seat}`),
    );
  }
  async function toggle(seat, w, tag) {
    const before = await settled();
    const oldSeats = before.current.state.game.bestMove.selectedSeats;
    const expected = oldSeats.includes(seat)
      ? oldSeats.filter((old) => old !== seat)
      : [...oldSeats, seat];
    await button(oldSeats.includes(seat) ? w.deselect(seat) : w.select(seat)).click();
    await expect
      .poll(async () => (await read())?.current.state.game.bestMove.selectedSeats)
      .toEqual(expected);
    const after = await settled();
    const event = active(after.current.state).at(-1);
    assert.equal(event.type, "best-move.selection-toggled");
    assert.deepEqual(event.payload, { seat });
    assert.equal(event.parentEventId, before.current.state.headEventId);
    assert.equal(active(after.current.state).length, active(before.current.state).length + 1);
    assert.equal(domain.isSecretGameEventType(event.type), true);
    await selectionUi(after.current.state, w);
    report.toggles.push({ tag, seat, selectedSeats: expected, ...replay(after.current.state) });
    return { before, after };
  }
  async function capture(tag) {
    const file = path.join(evidence, `${tag}.png`);
    await page.screenshot({ path: file, fullPage: true });
    report.screenshots.push(file);
    const geometry = await page.evaluate(() => {
      const rect = (el) => {
        const r = el.getBoundingClientRect();
        return {
          x: r.x,
          y: r.y,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
        };
      };
      const workspace = document.querySelector(".table-workspace");
      const cards = [...document.querySelectorAll(".player-seat")].map((el) => {
        const box = rect(el);
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return {
          seat: Number(el.closest(".seat-anchor").dataset.seat),
          ...box,
          hit: hit === el || el.contains(hit),
        };
      });
      return {
        width: innerWidth,
        height: innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        workspace: {
          ...rect(workspace),
          scrollTop: workspace.scrollTop,
          scrollLeft: workspace.scrollLeft,
        },
        cards,
        // The fixed 240px center is a transparent positioning/shadow box, not content.
        center: rect(document.querySelector(".table-center > div")),
        actions: [...document.querySelectorAll(".table-advance button")].map((el) => ({
          name: el.textContent.trim(),
          ...rect(el),
        })),
      };
    });
    report.geometry.push({ tag, ...geometry });
    const inside = (r, outer) =>
      r.x >= outer.x - 1 &&
      r.y >= outer.y - 1 &&
      r.right <= outer.right + 1 &&
      r.bottom <= outer.bottom + 1;
    const overlaps = (a, b) =>
      Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 &&
      Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1;
    const screen = { x: 0, y: 0, right: viewport.width, bottom: viewport.height };
    assert.ok(geometry.documentWidth <= viewport.width + 1, `${tag}: document overflow`);
    assert.equal(geometry.workspace.scrollTop, 0, `${tag}: fixed table scrolled vertically`);
    assert.equal(geometry.workspace.scrollLeft, 0, `${tag}: fixed table scrolled horizontally`);
    assert.equal(geometry.cards.length, 10, `${tag}: ten cards`);
    for (const [index, item] of geometry.cards.entries()) {
      assert.ok(
        inside(item, screen) && inside(item, geometry.workspace),
        `${tag}: card ${item.seat} clipped`,
      );
      assert.ok(
        item.width >= 48 && item.height >= 48,
        `${tag}: card ${item.seat} below touch target`,
      );
      assert.ok(item.hit, `${tag}: card ${item.seat} center occluded`);
      assert.ok(!overlaps(item, geometry.center), `${tag}: card ${item.seat} overlaps center`);
      for (const other of geometry.cards.slice(index + 1))
        assert.ok(!overlaps(item, other), `${tag}: cards ${item.seat}/${other.seat} overlap`);
    }
    for (const [index, action] of geometry.actions.entries()) {
      assert.ok(
        inside(action, screen) && inside(action, geometry.workspace),
        `${tag}: action clipped: ${action.name}`,
      );
      assert.ok(
        action.width >= 48 && action.height >= 48,
        `${tag}: action below touch target: ${action.name}`,
      );
      assert.ok(
        !overlaps(action, geometry.center),
        `${tag}: action overlaps center: ${action.name}`,
      );
      for (const item of geometry.cards)
        assert.ok(!overlaps(action, item), `${tag}: action overlaps card ${item.seat}`);
      for (const other of geometry.actions.slice(index + 1))
        assert.ok(!overlaps(action, other), `${tag}: actions overlap`);
    }
    assert.ok(
      inside(geometry.center, screen) && inside(geometry.center, geometry.workspace),
      `${tag}: center clipped`,
    );
  }
  async function snapshot(tag, env) {
    await writeFile(
      path.join(evidence, `${tag}.json`),
      JSON.stringify({ ...env, proof: replay(env.current.state) }, null, 2),
    );
  }
  try {
    report.sourcesBefore = await sourceManifest();
    await page.goto(new URL("/health/ready", baseUrl).href);
    await page.clock.install();
    for (const locale of locales) {
      club.language = locale;
      const w = words[locale];
      for (const outcome of outcomes) {
        const tag = `${locale}-${outcome}`;
        const gameId = randomUUID();
        const fixture = bestMoveNightFixture(players, gameId);
        const { victim, targets } = bestMoveFixtureTargets(fixture);
        api.seed(gameId, fixture);
        await page.goto(new URL("/health/ready", baseUrl).href);
        await page.evaluate(
          ({ value, key }) => {
            localStorage.setItem(key, JSON.stringify(value));
          },
          { value: federationEnvelope(club.id, gameId, fixture), key: storageKey },
        );
        await page.goto(baseUrl, { waitUntil: "networkidle" });
        const clubCard = page.locator(".club-card-open");
        await expect(page.locator(".club-card-open, .app-shell").first()).toBeVisible();
        if (await clubCard.first().isVisible()) await clubCard.first().click();
        await settled();
        const victimName = players.find((p) => p.id === victim.id).nickname;
        await button(w.shots(victimName)).click();
        await button(w.evaluate).click();
        await button(w.continue).click();
        await button(w.don).click();
        await button(w.sheriff).click();
        await button(w.record).click();
        await expect.poll(async () => (await read())?.current.state.game.phase).toBe("best-move");
        const empty = await settled();
        assert.equal(empty.current.state.game.bestMove.playerSeat, victim.seat);
        assert.deepEqual(empty.current.state.game.bestMove.selectedSeats, []);
        await selectionUi(empty.current.state, w);
        await expect(page.locator(".timer-display")).toBeDisabled();
        await expect(page.locator(".timer-display strong")).toHaveText("00");

        if (outcome === "record-3") {
          const selected = await toggle(targets[0], w, `${tag}-select`);
          await reload(selected.after);
          const retapped = await toggle(targets[0], w, `${tag}-retap`);
          assert.deepEqual(retapped.after.current.state.game.bestMove.selectedSeats, []);
          await undo(retapped.before, w);
          await selectionUi(retapped.before.current.state, w);
          const deselected = await toggle(targets[0], w, `${tag}-deselect-again`);
          await reload(deselected.after);
          report.interactions.push({ locale, name: "select-retap" });
          for (const seat of targets) await toggle(seat, w, `${tag}-limit-fill`);
          await capture(`${tag}-limit`);
          for (const seat of [...targets].reverse()) await toggle(seat, w, `${tag}-limit-remove`);
          const cleared = await settled();
          assert.deepEqual(cleared.current.state.game.bestMove.selectedSeats, []);
          await reload(cleared);
          report.interactions.push({ locale, name: "limit-deselect-all" });
          const beforeTimer = await settled();
          await button(w.timer).click();
          await expect(page.locator(".timer-display strong")).toHaveText("20");
          await page.clock.fastForward(21_000);
          await expect(page.locator(".timer-display strong")).toHaveText("00");
          const afterTimer = await settled();
          assert.deepEqual(
            afterTimer.current.state,
            beforeTimer.current.state,
            "20s timer expiry does not select or finalize Best Move",
          );
          await selectionUi(afterTimer.current.state, w);
          report.interactions.push({ locale, name: "timer-manual" });
        }
        const count = Number(outcome.at(-1));
        for (const seat of targets.slice(0, count)) await toggle(seat, w, tag);
        const draft = await settled();
        await reload(draft);
        await selectionUi(draft.current.state, w);
        await snapshot(`${tag}-draft`, draft);
        await capture(`${tag}-draft`);
        const recorded = outcome === "record-3";
        const finishName = recorded ? w.record : w.skip;
        async function finish() {
          await button(finishName).click();
          await expect
            .poll(async () => (await read())?.current.state.game.phase)
            .toBe("night-resolution");
          const result = await settled();
          const state = result.current.state;
          assert.equal(state.game.phase, "night-resolution");
          assert.deepEqual(
            state.game.bestMove,
            recorded
              ? {
                  playerSeat: victim.seat,
                  selectedSeats: targets,
                  completionReason: "complete-list",
                  mafiaHits: 2,
                }
              : { playerSeat: victim.seat, selectedSeats: [], completionReason: "declined" },
          );
          assert.equal(Object.hasOwn(state.game.bestMove, "readbackAcknowledged"), false);
          const event = active(state).at(-1);
          assert.equal(event.type, recorded ? "best-move.recorded" : "best-move.skipped");
          assert.deepEqual(event.payload, {});
          assert.equal(domain.isSecretGameEventType(event.type), true);
          assert.equal(
            active(state).filter((e) => /^best-move\.(recorded|skipped)$/.test(e.type)).length,
            1,
          );
          await expect(page.locator(".table-advance button")).toHaveText([w.morning]);
          await noRetiredControls();
          await expect(page.locator(".federation-transcript")).toHaveCount(0);
          return result;
        }
        const final = await finish();
        await snapshot(`${tag}-finished`, final);
        await capture(`${tag}-finished`);
        await reload(final);
        await expect(page.locator(".federation-transcript")).toHaveCount(0);
        const undone = await undo(draft, w);
        await selectionUi(undone.current.state, w);
        await reload(undone);
        await selectionUi(undone.current.state, w);
        await snapshot(`${tag}-undone`, undone);
        await finish();
        await button(w.morning).click();
        await expect
          .poll(async () => (await read())?.current.state.game.phase)
          .toBe("goodbye-speech");
        const morning = await settled();
        assert.equal(morning.current.state.game.phase, "goodbye-speech");
        assert.deepEqual(morning.current.state.game.goodbyeSeats, [victim.seat]);
        assert.equal(morning.current.state.game.day, final.current.state.game.day + 1);
        assert.equal(
          morning.current.state.game.completedGameNights,
          final.current.state.game.completedGameNights + 1,
        );
        assert.deepEqual(morning.current.state.game.bestMove, final.current.state.game.bestMove);
        await expect(page.locator(".federation-transcript")).toHaveCount(0);
        await expect(page.getByRole("heading", { name: w.goodbye, exact: true })).toBeVisible();
        await expect(page.locator(".player-seat.is-voting-highlight")).toHaveCount(1);
        await expect(card(victim.seat)).toHaveClass(/is-voting-highlight/);
        await reload(morning);
        await snapshot(`${tag}-morning`, morning);
        report.scenarios.push({
          locale,
          outcome,
          gameId,
          selectedSeats: draft.current.state.game.bestMove.selectedSeats,
          draft: replay(draft.current.state),
          finished: replay(final.current.state),
          morning: replay(morning.current.state),
        });
        api.clean();
      }
    }
    assertBestMoveCoverage(report);
    report.sourcesAfter = await sourceManifest();
    assert.deepEqual(
      report.sourcesAfter,
      report.sourcesBefore,
      "Source changed during browser verification; freeze and rerun",
    );
    api.clean();
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error.stack ?? String(error);
    const file = path.join(evidence, "failure.png");
    await page.screenshot({ path: file, fullPage: true }).catch(() => {});
    report.screenshots.push(file);
    throw error;
  } finally {
    club.language = originalLanguage;
    await writeFile(path.join(evidence, "report.json"), JSON.stringify(report, null, 2));
  }
  console.log(
    `Best Move ${report.browser} ${viewport.width}x${viewport.height}: ${report.scenarios.length} EN/RU outcomes passed`,
  );
  return report;
}
