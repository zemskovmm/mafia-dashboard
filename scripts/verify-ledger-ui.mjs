/** Real App + the shared strict API fixture. Not real-backend or physical-iPad proof. */
/* global localStorage, document, innerWidth, innerHeight, fetch, requestAnimationFrame, getComputedStyle */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { expect } from "@playwright/test";
import * as domain from "../packages/game-domain/src/index.ts";
import { createFederationSampleGameHistory } from "../apps/web/src/features/timeline/sample-game-data.ts";
import { getActiveBranch } from "../apps/web/src/features/game/game-history.ts";
import { isCurrentGameSessionState } from "../apps/web/src/session-outbox.ts";
import { checkpoint, currentSetupState, envelope } from "./verify-federation-ui.mjs";
import { bestMoveNightFixture } from "./verify-best-move-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const storageKey = "mafia-dashboard.game-session.v5";
const preferenceKey = "mafia-dashboard.host-view.v1";

/** Re-execute the real sample's accepted prefix with this fixture's roster and identity. */
export function ledgerHistoryFixture(players, gameId, throughDay = 3) {
  assert.ok([3, 4, 5].includes(throughDay));
  const sample = createFederationSampleGameHistory();
  let setup = domain.beginRoleDraw(
    domain.createSetup(
      players.slice(0, 10).map((player, index) => ({ id: player.id, seat: index + 1 })),
    ),
    domain.createSeededRandom(71),
  );
  for (const player of sample.baseline.game.players)
    setup = domain.assignRoleForSeat(setup, player.seat, player.role);
  let game = domain.createGame(domain.completeRoleDraw(setup));
  const initialGame = domain.createInitialGameBaseline(game);
  const events = [];
  const append = (draft, createdAt) => {
    const next = domain.createGameLogEntry({
      gameId,
      id: randomUUID(),
      sequence: events.length + 1,
      parentEventId: events.at(-1)?.id ?? null,
      createdAt,
      before: game,
      draft,
    });
    events.push(next.entry);
    game = next.after;
  };
  for (const entry of sample.activeEntries) {
    append({ type: entry.type, payload: entry.payload }, entry.createdAt);
    if (game.phase === "day" && game.day === 3) break;
  }
  while (game.day < throughDay) {
    const target = game.players.find(
      ({ role, status }) => role === "citizen" && status === "active",
    );
    const shots = game.players
      .filter(({ role, status }) => domain.getRoleTeam(role) === "black" && status === "active")
      .map(({ seat }) => ({ shooterSeat: seat, targetSeat: target.seat, secret: true }));
    for (const draft of [
      { type: "voting.legally-skipped", payload: { reason: "no-nominees" } },
      {
        type: "mafia.shots-resolved",
        payload: { shots, result: { kind: "kill", targetSeat: target.seat } },
      },
      { type: "phase.changed", payload: { to: "night-don" } },
      { type: "don.check-skipped", payload: {} },
      { type: "sheriff.check-skipped", payload: {} },
      { type: "phase.changed", payload: { to: "goodbye-speech" } },
      { type: "phase.changed", payload: { to: "day" } },
    ])
      append(draft, "2026-11-03T12:00:00.000Z");
  }
  const state = {
    ...currentSetupState(),
    setup: {
      step: "roles",
      selectedPlayerIds: game.players.map((player) => player.id),
      setup: null,
    },
    hostPlayerId: players[10].id,
    game,
    initialGame,
    events,
    headEventId: events.at(-1).id,
  };
  assert.equal(game.phase, "day");
  assert.equal(game.day, throughDay);
  assert.equal(isCurrentGameSessionState(state), true);
  assert.equal(
    domain.hashGameState(domain.replayGameLog(initialGame, events).game),
    domain.hashGameState(game),
  );
  return state;
}

async function sourceManifest() {
  const files = [
    "package.json",
    "package-lock.json",
    "apps/web/vite.config.ts",
    "scripts/verify-ui.mjs",
    "scripts/verify-ledger-ui.mjs",
    "scripts/verify-best-move-ui.mjs",
    "scripts/verify-federation-ui.mjs",
    "scripts/ui-presentation-contracts.mjs",
    "scripts/session-verifier-contracts.mjs",
  ];
  async function walk(directory) {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (!/\.(?:test|spec)\./.test(entry.name)) files.push(file);
    }
  }
  for (const directory of [
    "apps/web/src",
    "apps/web/public",
    "packages/game-domain/src",
    "packages/game-domain/dist",
  ])
    await walk(directory);
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

export function ledgerPhaseFixtures(players, gameId) {
  const history = ledgerHistoryFixture(players, gameId);
  const frames = domain.replayGameLog(history.initialGame, history.events).frames;
  const games = [history.initialGame.game, ...frames.map(({ after }) => after)];
  const first = (phase) => {
    const game = games.find((game) => game.phase === phase);
    assert.ok(game, `Sample reaches ${phase}`);
    return game;
  };
  const tie = (initial) => {
    let game = domain.applyGameEvent(initial, {
      type: "voting.candidate-selected",
      payload: { candidateSeat: 2 },
    });
    for (let voterSeat = 1; voterSeat <= 5; voterSeat++)
      game = domain.applyGameEvent(game, {
        type: "vote.recorded",
        payload: { voterSeat, candidateSeat: 2 },
      });
    game = domain.applyGameEvent(game, {
      type: "voting.candidate-selected",
      payload: { candidateSeat: 3 },
    });
    return domain.applyGameEvent(game, {
      type: "voting.resolved",
      payload: { voteAssignments: game.voteAssignments, result: domain.resolveVote(game) },
    });
  };
  let collective = tie(
    domain.startVoting(
      domain.nominate(domain.completeCurrentTurn(domain.nominate(first("day"), 1, 2)), 2, 3),
    ),
  );
  while (collective.phase === "car-crash") collective = domain.completeCurrentTurn(collective);
  collective = tie(collective);
  assert.equal(collective.phase, "car-crash-decision");
  const finished = domain.applyGameEvent(first("goodbye-speech"), {
    type: "game.adjudicated",
    payload: {
      losingTeam: "black",
      offenderSeat: first("goodbye-speech").players.find(({ role }) => role === "don").seat,
      rule: "6.3.5",
      reason: "Synthetic sidebar fixture",
      committeeApproved: true,
    },
  });
  return [
    first("mafia-planning"),
    first("voting"),
    collective,
    first("best-move"),
    first("night-don"),
    first("night-sheriff"),
    first("goodbye-speech"),
    finished,
  ].map((game) => checkpoint(game, history, gameId));
}

export async function runLedgerScenarios({ page, baseUrl, club, players, api, evidenceDir }) {
  assert.match(new URL(baseUrl).hostname, /^(localhost|127\.0\.0\.1)$/);
  const evidence = path.resolve(evidenceDir);
  await mkdir(evidence, { recursive: true });
  const report = {
    status: "running",
    browser: page.context().browser().browserType().name(),
    viewport: page.viewportSize(),
    fixture: "real App, strict mocked API; synthetic media continuity only",
    cases: [],
    screenshots: [],
    geometry: [],
  };
  const originalLanguage = club.language;
  const button = (name) => page.getByRole("button", { name, exact: true });
  const row = (seat) => page.locator(`[data-ledger-seat="${seat}"]`);
  const read = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);
  async function settled({ draft = false } = {}) {
    await expect
      .poll(async () => {
        const value = await read();
        return (
          value?.current &&
          !value.failed &&
          value.outbox.length === 0 &&
          JSON.stringify(api.sessions.get(value.gameId)?.state) ===
            JSON.stringify(value.current.state)
        );
      })
      .toBe(true);
    const value = await read();
    const remote = await page.evaluate(async (id) => {
      const response = await fetch(`/api/game-sessions/${id}`);
      if (!response.ok) throw new Error(`Readback HTTP ${response.status}`);
      return response.json();
    }, value.gameId);
    assert.deepEqual(remote.session.state, value.current.state);
    const state = value.current.state;
    assert.equal(isCurrentGameSessionState(state), true);
    const replay = domain.replayGameLog(
      state.initialGame,
      getActiveBranch(state.events, state.headEventId),
    );
    if (!draft) assert.equal(domain.hashGameState(replay.game), domain.hashGameState(state.game));
    api.clean();
    return value;
  }
  async function seed(state, gameId, view) {
    api.seed(gameId, state);
    await page.goto(new URL("/health/ready", baseUrl).href);
    await page.evaluate(
      ({ key, value, preference, view }) => {
        localStorage.setItem(key, JSON.stringify(value));
        if (view) localStorage.setItem(preference, view);
        else localStorage.removeItem(preference);
      },
      { key: storageKey, value: envelope(club.id, gameId, state), preference: preferenceKey, view },
    );
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    const clubCard = page.locator(".club-card-open").first();
    await expect(page.locator(".club-card-open, .app-shell").first()).toBeVisible();
    if (await clubCard.isVisible()) await clubCard.click();
    await expect(page.locator(".game-shell")).toBeVisible();
    await settled();
  }
  async function capture(tag, allRows = false) {
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const file = path.join(evidence, `${tag}.png`);
    await page.screenshot({ path: file, animations: "disabled" });
    report.screenshots.push(file);
    const geometry = await page.evaluate(() => {
      const rect = (element) => {
        const r = element.getBoundingClientRect();
        return {
          x: r.x,
          y: r.y,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
        };
      };
      const grid = document.querySelector(".ledger-scroll");
      const headingBottom = document
        .querySelector(".ledger-table thead th")
        .getBoundingClientRect().bottom;
      const controls = [
        ...document.querySelectorAll(
          ".host-view-switch button, .timer-advance button, .ledger-advance button, .ledger-row-controls button",
        ),
      ].filter((element) => {
        const box = element.getBoundingClientRect();
        return (
          box.top >= 0 &&
          box.bottom <= innerHeight &&
          box.left >= 0 &&
          box.right <= innerWidth &&
          (!element.closest(".ledger-scroll") ||
            (box.top >= headingBottom && box.bottom <= grid.getBoundingClientRect().bottom))
        );
      });
      return {
        documentWidth: document.documentElement.scrollWidth,
        width: innerWidth,
        height: innerHeight,
        grid: {
          ...rect(grid),
          client: grid.clientHeight,
          scroll: grid.scrollHeight,
          clientWidth: grid.clientWidth,
          scrollWidth: grid.scrollWidth,
        },
        workspace: rect(document.querySelector(".table-workspace")),
        phaseBar: !!document.querySelector(".game-ledger .ledger-phase-bar"),
        footer: !!document.querySelector(".ledger-footnote"),
        rows: document.querySelectorAll(".ledger-table tbody tr").length,
        historyHeadings: [...document.querySelectorAll(".ledger-table thead th")]
          .slice(2)
          .map((cell) => cell.textContent),
        periodHeadings: [
          ...document.querySelectorAll(".ledger-table thead th[data-ledger-period]"),
        ].map((cell) => ({
          day: cell.dataset.ledgerDay,
          period: cell.dataset.ledgerPeriod,
          label: cell.querySelector("strong").textContent,
          current: cell.classList.contains("ledger-current-day"),
          ...rect(cell),
        })),
        periodCells: [
          ...document.querySelectorAll(".ledger-table tbody td[data-ledger-period]"),
        ].map((cell) => ({
          day: cell.dataset.ledgerDay,
          period: cell.dataset.ledgerPeriod,
          facts: [...cell.querySelectorAll(".ledger-fact")].map((fact) => fact.textContent),
        })),
        headerCount: document.querySelectorAll(".ledger-table thead th").length,
        columnCount: document.querySelectorAll(".ledger-table col").length,
        emptyCellText: [...document.querySelectorAll(".ledger-table tbody td:not(.ledger-actions)")]
          .filter((cell) => !cell.querySelector(".ledger-fact"))
          .map((cell) => cell.textContent),
        rowMetrics: [...document.querySelectorAll(".ledger-table tbody tr")].map((row) => ({
          height: rect(row).height,
          cells: [...row.children].map((cell) => ({
            text: cell.textContent.slice(0, 60),
            contentHeight: cell.firstElementChild?.getBoundingClientRect().height,
            padding: getComputedStyle(cell).padding,
          })),
        })),
        controls: controls.map((element) => {
          const r = rect(element);
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return {
            name: element.getAttribute("aria-label") ?? element.textContent,
            ...r,
            hit: element.contains(hit),
          };
        }),
        switch: rect(document.querySelector(".host-view-switch")),
        toolbar: rect(document.querySelector(".app-fixed-toolbar")),
        rail: rect(document.querySelector(".live-side-panel")),
        timerControls: [...document.querySelectorAll(".timer-panel button")].map(rect),
      };
    });
    report.geometry.push({ tag, ...geometry });
    assert.equal(geometry.rows, 10);
    assert.equal(geometry.columnCount, geometry.headerCount, `${tag}: column/header alignment`);
    assert.equal(
      geometry.periodHeadings.length,
      geometry.headerCount - 2,
      `${tag}: separate period headings`,
    );
    assert.equal(geometry.periodHeadings.length % 2, 0, `${tag}: day/night pairs`);
    assert.ok(geometry.periodHeadings.length >= 8, `${tag}: four initial day/night pairs`);
    assert.ok(
      geometry.periodHeadings.filter(({ current }) => current).length <= 1,
      `${tag}: only the active period is current`,
    );
    if (geometry.width >= 1366 && geometry.periodHeadings.length === 8) {
      assert.ok(
        geometry.grid.scrollWidth <= geometry.grid.clientWidth + 1,
        `${tag}: first four pairs fit without horizontal scrolling`,
      );
    }
    for (let i = 0; i < geometry.periodHeadings.length; i += 2) {
      const [day, night] = geometry.periodHeadings.slice(i, i + 2);
      assert.equal(day.period, "day");
      assert.equal(night.period, "night");
      assert.equal(day.day, night.day);
      assert.doesNotMatch(day.label, /Night|Ночь/);
      assert.match(night.label, /^(Night|Ночь) /);
    }
    assert.equal(
      geometry.periodCells.length,
      geometry.periodHeadings.length * geometry.rows,
      `${tag}: separate period cells`,
    );
    for (let i = 0; i < geometry.periodCells.length; i++) {
      const cell = geometry.periodCells[i];
      const heading = geometry.periodHeadings[i % geometry.periodHeadings.length];
      assert.equal(cell.day, heading.day);
      assert.equal(cell.period, heading.period);
      for (const fact of cell.facts) {
        assert.doesNotMatch(
          fact,
          /Ballot \d+: (skipped|closed|cancelled|count disputed)|Голосование \d+: (пропущено|завершено|отменено|подсчёт оспорен)/,
          `${tag}: no repeated ballot-wide notices`,
        );
        assert.doesNotMatch(
          fact,
          cell.period === "day"
            ? /Shooting result|Primary target|Don checked|Sheriff checked|Результат стрельбы|Основная цель|Проверка (Дона|шерифа)/
            : /Nominated seat|voted for seat|collective removal|Выставил игрока|голос за|общий подъём/,
          `${tag}: fact stays in its own period`,
        );
      }
    }
    assert.ok(
      geometry.rowMetrics.every(({ cells }) => cells.length === geometry.headerCount),
      `${tag}: row/header alignment`,
    );
    assert.ok(
      geometry.emptyCellText.every((text) => text === ""),
      `${tag}: unfilled cells stay blank`,
    );
    if (geometry.historyHeadings.length) {
      assert.match(
        geometry.historyHeadings[0],
        /^(Zero round|Нулевой круг)/,
        `${tag}: history starts at zero round`,
      );
    }
    assert.ok(
      geometry.historyHeadings.every((text) => !/Planning|Договорка|Night 1\b|Ночь 1\b/.test(text)),
      `${tag}: opening night omitted`,
    );
    assert.equal(geometry.footer, false, `${tag}: no scrolling-instruction footer`);
    assert.equal(geometry.phaseBar, false, `${tag}: no phase controls above the grid`);
    for (const edge of ["x", "y", "right", "bottom"])
      assert.ok(
        Math.abs(geometry.grid[edge] - geometry.workspace[edge]) <= 2,
        `${tag}: Ledger fills board at ${edge}`,
      );
    assert.ok(geometry.documentWidth <= geometry.width + 1, `${tag}: document overflow`);
    assert.ok(
      geometry.grid.height > 100 &&
        geometry.grid.bottom <= geometry.height + 1 &&
        geometry.grid.x >= -1 &&
        geometry.grid.right <= geometry.width + 1,
      `${tag}: bounded grid`,
    );
    if (allRows && geometry.width >= 1160 && geometry.height >= 768)
      assert.ok(
        geometry.grid.scroll <= geometry.grid.client + 2,
        `${tag}: all ten rows visible on primary iPad layout`,
      );
    const overlaps = (a, b) =>
      Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 &&
      Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1;
    assert.ok(!overlaps(geometry.switch, geometry.toolbar), `${tag}: selector / toolbar overlap`);
    for (const item of geometry.timerControls) {
      assert.ok(item.width >= 48 && item.height >= 48, `${tag}: small timer target`);
      assert.ok(
        item.x >= geometry.rail.x && item.right <= geometry.rail.right,
        `${tag}: timer target clipped by sidebar`,
      );
    }
    for (const item of geometry.controls) {
      assert.ok(
        item.width >= 48 && item.height >= 48,
        `${tag}: small target ${item.name}: ${item.width}x${item.height}`,
      );
      assert.ok(item.hit, `${tag}: occluded action ${item.name}`);
    }
  }
  async function verifyDayAdvance(locale, words) {
    const timer = await page.locator(".timer-panel").elementHandle();
    for (const view of [words.table, words.ledger]) {
      await button(view).click();
      const before = await settled();
      const advance = button(words.next);
      await expect(advance).toHaveCount(1);
      await expect(page.locator(".timer-advance button")).toHaveCount(1);
      await expect(
        page.locator(".game-shell .table-advance button, .game-shell .ledger-advance button"),
      ).toHaveCount(0);
      const geometry = await advance.evaluate((node) => {
        const box = (element) => element.getBoundingClientRect().toJSON();
        const action = box(node);
        return {
          action,
          timer: box(document.querySelector(".timer-panel")),
          speaker: box(document.querySelector(".day-center-stack")),
          speakerInTimer: !!document.querySelector(".timer-advance .day-center-stack"),
          header: box(document.querySelector(".game-header")),
          heading: box(document.querySelector(".game-tutorial-heading")),
          counts: box(document.querySelector(".team-counts")),
          countsInHeader: !!document.querySelector(".game-header > .team-counts"),
          switch: box(document.querySelector(".host-view-switch")),
          rail: box(document.querySelector(".live-side-panel")),
          utility: box(document.querySelector("#game-utility-panels")),
          viewportHeight: innerHeight,
          hit: node.contains(
            document.elementFromPoint(action.x + action.width / 2, action.y + action.height / 2),
          ),
        };
      });
      report.geometry.push({ tag: `${locale}-${view}-day-advance`, ...geometry });
      const { action, rail, utility } = geometry;
      assert.ok(action.width >= 48 && action.height >= 48, "Day advance retains touch size");
      assert.ok(action.top >= geometry.timer.bottom, "Day advance is below the clock");
      assert.ok(geometry.speakerInTimer, "Speaker is in the shared timer area");
      assert.ok(
        geometry.speaker.top >= geometry.timer.bottom && geometry.speaker.bottom <= action.top,
        "Speaker is between clock and Next player",
      );
      assert.ok(geometry.countsInHeader, "Team counts are in the top header");
      assert.ok(
        geometry.counts.left >= geometry.heading.right - 1 &&
          geometry.counts.right <= geometry.switch.left + 1 &&
          geometry.counts.top >= geometry.header.top - 1 &&
          geometry.counts.bottom <= geometry.header.bottom + 1,
        "Team counts fit between the heading and view switch",
      );
      assert.ok(action.left >= rail.left && action.right <= rail.right, "Day advance fits rail");
      assert.ok(
        action.bottom <= utility.bottom && action.bottom <= geometry.viewportHeight,
        "Day advance is not clipped",
      );
      assert.ok(geometry.hit, "Day advance is unobstructed");
      const screenshot = path.join(evidence, `${locale}-${view}-day-advance.png`);
      await page.screenshot({ path: screenshot, animations: "disabled" });
      report.screenshots.push(screenshot);
      if (view === words.table) await advance.tap();
      else {
        const tab = report.browser === "webkit" ? "Alt+Tab" : "Tab";
        for (let i = 0; i < 120; i++) {
          if (await advance.evaluate((node) => node === document.activeElement)) break;
          await page.keyboard.press(tab);
        }
        await expect(advance).toBeFocused();
        await page.keyboard.press("Enter");
      }
      const after = await settled();
      assert.deepEqual(
        after.current.state.game,
        domain.completeCurrentTurn(before.current.state.game),
      );
      const entry = after.current.state.events.at(-1);
      assert.equal(entry.type, "turn.completed");
      assert.deepEqual(entry.payload, {
        seat: before.current.state.game.turnOrder[before.current.state.game.currentTurnIndex],
      });
      await page.getByRole("button", { name: words.undo }).click();
      if (await button(words.confirm).isVisible()) await button(words.confirm).click();
      assert.deepEqual((await settled()).current.state.game, before.current.state.game);
      assert.equal(
        await page.evaluate((node) => node === document.querySelector(".timer-panel"), timer),
        true,
      );
    }
    report.cases.push(`${locale}:day-advance-both-views`);
  }
  async function expectCurrentPeriod(day, period, initiallyVisible = false) {
    const current = page.locator(".ledger-table thead .ledger-current-day");
    await expect(current).toHaveCount(1);
    await expect(current).toHaveAttribute("data-ledger-day", String(day));
    await expect(current).toHaveAttribute("data-ledger-period", period);
    if (initiallyVisible) {
      const heading = await current.boundingBox();
      const actions = await page.locator(".ledger-table thead th").nth(1).boundingBox();
      const grid = await page.locator(".ledger-scroll").boundingBox();
      assert.ok(
        heading.x >= actions.x + actions.width - 1 &&
          heading.x + heading.width <= grid.x + grid.width + 1,
        "Initial scroll reveals the current period, not future pairs",
      );
    }
  }
  async function verifyFourPairs(locale, words) {
    const gameId = randomUUID();
    const extended = ledgerHistoryFixture(players, gameId, 5);
    const events = extended.events.slice(0, -2);
    const beforeFifth = {
      ...extended,
      game: domain.replayGameLog(extended.initialGame, events).game,
      events,
      headEventId: events.at(-1).id,
    };
    assert.equal(beforeFifth.game.day, 4);
    assert.equal(beforeFifth.game.phase, "night-resolution");
    await seed(beforeFifth, gameId, "ledger");
    const headings = page.locator(".ledger-table thead th[data-ledger-period]");
    const widths = () =>
      headings.evaluateAll((cells) => cells.map((cell) => cell.getBoundingClientRect().width));
    await expect(headings).toHaveCount(8);
    await capture(`${locale}-four-pairs`, true);
    await expectCurrentPeriod(4, "night", true);
    const beforeWidths = await widths();
    const before = await settled();
    await page.locator(".ledger-advance button:not(:disabled)").first().tap();
    const after = await settled();
    assert.equal(after.current.state.game.day, 5);
    assert.equal(after.current.state.events.length, events.length + 1);
    await expect(headings).toHaveCount(10);
    await expectCurrentPeriod(5, "day");
    (await widths()).forEach((width) =>
      assert.ok(Math.abs(width - beforeWidths[0]) <= 1, "Later pairs do not compress columns"),
    );
    const scroll = page.locator(".ledger-scroll");
    const range = await scroll.evaluate((node) => node.scrollWidth - node.clientWidth);
    assert.ok(range > 0, "Fifth pair adds horizontal overflow");
    await scroll.hover();
    await page.mouse.wheel(range + 100, 0);
    await expect.poll(() => scroll.evaluate((node) => node.scrollLeft)).toBe(range);
    await expect(headings.last()).toBeInViewport();
    const sticky = await page.locator(".ledger-table tbody tr").first().locator("th").boundingBox();
    const grid = await scroll.boundingBox();
    assert.ok(Math.abs(sticky.x - grid.x) <= 2, "Player identity remains pinned");
    await capture(`${locale}-fifth-pair`, true);
    assert.deepEqual(
      (await settled()).current,
      after.current,
      "Native history scrolling does not save a game action",
    );
    await button(words.table).click();
    await button(words.ledger).click();
    await expect.poll(() => scroll.evaluate((node) => node.scrollLeft)).toBe(range);
    assert.deepEqual((await settled()).current, after.current);
    await button(locale === "en" ? "Open game log" : "Открыть журнал игры").click();
    await button(
      locale === "en"
        ? `Preview state after log #${events.length}`
        : `Просмотреть состояние после записи журнала №${events.length}`,
    ).click();
    await expect(headings).toHaveCount(8);
    await capture(`${locale}-four-pairs-preview`);
    await expectCurrentPeriod(4, "night");
    assert.deepEqual((await read()).current, after.current);
    await button(locale === "en" ? "Exit preview" : "Выйти из просмотра").click();
    await expect(headings).toHaveCount(10);
    await button(words.undo).click();
    const undone = await settled();
    assert.deepEqual(undone.current.state.game, before.current.state.game);
    assert.equal(undone.current.state.headEventId, before.current.state.headEventId);
    await expect(headings).toHaveCount(8);
    await expect(page.locator('.ledger-table [data-ledger-day="5"]')).toHaveCount(0);
    await capture(`${locale}-four-pairs-undo`);
    report.cases.push(`${locale}:four-pairs-expand-scroll-preview-undo`);
  }
  async function verifySidebar(tag) {
    await expect(page.locator(".live-side-panel .ledger-phase-bar")).toHaveCount(1);
    await expect(page.locator(".game-ledger .ledger-phase-bar")).toHaveCount(0);
    const controls = page.locator(
      ".ledger-phase-bar button, .ledger-phase-bar select, .ledger-phase-bar summary",
    );
    for (const control of await controls.all()) {
      if (!(await control.isVisible())) continue;
      await control.scrollIntoViewIfNeeded();
      const geometry = await control.evaluate((node) => {
        const box = (element) => element.getBoundingClientRect().toJSON();
        const action = box(node);
        return {
          action,
          name: node.textContent,
          rail: box(document.querySelector(".live-side-panel")),
          utility: box(document.querySelector("#game-utility-panels")),
          hit: node.contains(
            document.elementFromPoint(action.x + action.width / 2, action.y + action.height / 2),
          ),
        };
      });
      report.geometry.push({ tag, ...geometry });
      const { action, rail, utility } = geometry;
      assert.ok(action.width >= 48 && action.height >= 48, `${tag}: touch size ${geometry.name}`);
      assert.ok(
        action.left >= rail.left && action.right <= rail.right,
        `${tag}: sidebar containment`,
      );
      assert.ok(
        action.top >= utility.top - 1 && action.bottom <= utility.bottom + 1,
        `${tag}: scroll reachability`,
      );
      assert.ok(geometry.hit, `${tag}: unobstructed ${geometry.name}`);
    }
  }
  try {
    report.sourcesBefore = await sourceManifest();
    for (const locale of ["en", "ru"]) {
      club.language = locale;
      const words =
        locale === "en"
          ? {
              table: "Table",
              ledger: "Ledger",
              timer: "Start 20 second timer",
              pause: "Pause timer",
              next: "Next player",
              undo: /^Undo last action/,
              confirm: "Undo",
            }
          : {
              table: "Стол",
              ledger: "Журнал",
              timer: "Запустить таймер на 20 секунд",
              pause: "Приостановить таймер",
              next: "Следующий игрок",
              undo: /^Отменить последнее действие/,
              confirm: "Отменить",
            };
      const id = randomUUID();
      const viewport = page.viewportSize();
      const compactPortrait = viewport.width < 1160 && viewport.height >= viewport.width;
      await seed(ledgerHistoryFixture(players, id), id, compactPortrait ? "ledger" : null);
      await expect(page.locator(compactPortrait ? ".ledger-table" : ".round-table")).toBeVisible();
      await verifyDayAdvance(locale, words);
      const initial = await settled();
      const timerNode = await page.locator(".timer-panel").elementHandle();
      const railNode = await page.locator(".live-side-panel").elementHandle();
      await button(words.timer).click();
      await button(words.ledger).click();
      await expect(page.locator(".ledger-table tbody tr")).toHaveCount(10);
      assert.deepEqual((await settled()).current, initial.current, "Mode is not a game edit");
      await expect(button(words.pause)).toBeVisible();
      assert.equal(
        await page.evaluate(
          (node) => node === document.querySelector(".live-side-panel"),
          railNode,
        ),
        true,
      );
      if (timerNode)
        assert.equal(
          await page.evaluate((node) => node === document.querySelector(".timer-panel"), timerNode),
          true,
        );
      await capture(`${locale}-ledger`, true);
      const scroll = page.locator(".ledger-scroll");
      const verticalRange = await scroll.evaluate((node) => node.scrollHeight - node.clientHeight);
      if (verticalRange > 2) {
        await scroll.hover();
        await page.mouse.wheel(0, verticalRange + 100);
        await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBe(verticalRange);
        await capture(`${locale}-last-row`);
        await expect(row(10).locator(".ledger-player-action")).toBeInViewport();
        await page.mouse.wheel(0, -verticalRange - 100);
        await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBe(0);
      }
      const initialOffset = await scroll.evaluate((node) => node.scrollLeft);
      const horizontalRange = await scroll.evaluate((node) => node.scrollWidth - node.clientWidth);
      await scroll.hover();
      await page.mouse.wheel(initialOffset > 0 ? -200 : 200, 80);
      if (horizontalRange > 1)
        await expect.poll(() => scroll.evaluate((node) => node.scrollLeft)).not.toBe(initialOffset);
      else await expect.poll(() => scroll.evaluate((node) => node.scrollLeft)).toBe(0);
      const offset = await scroll.evaluate((node) => ({
        left: node.scrollLeft,
        top: node.scrollTop,
      }));
      assert.deepEqual(
        (await settled()).current,
        initial.current,
        "Native scrolling does not mutate gameplay",
      );
      await button(words.table).click();
      await button(words.ledger).click();
      assert.deepEqual(
        await scroll.evaluate((node) => ({ left: node.scrollLeft, top: node.scrollTop })),
        offset,
        "Ledger scroll position survives switching",
      );
      report.cases.push(`${locale}:same-game-timer-scroll`);
      if (locale === "en") {
        const before = await settled();
        const tabKey = report.browser === "webkit" ? "Alt+Tab" : "Tab";
        for (let index = 0; index < 120; index++) {
          if (await button(words.table).evaluate((element) => element === document.activeElement))
            break;
          await page.keyboard.press(tabKey);
        }
        await expect(button(words.table)).toBeFocused();
        await page.keyboard.press("Enter");
        await page.keyboard.press(tabKey);
        await expect(button(words.ledger)).toBeFocused();
        await page.keyboard.press("Space");
        await button(words.table).tap();
        await button(words.ledger).tap();
        assert.deepEqual((await settled()).current, before.current);
        await button("Ledger help").click();
        await expect(page.getByRole("dialog", { name: "Using the Ledger" })).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await row(3).locator(".ledger-penalty-button").click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await assert.rejects(() => button(words.table).click({ timeout: 500 }), /Timeout/);
        await assert.rejects(
          () => page.locator(".timer-advance button").click({ timeout: 500 }),
          /Timeout/,
        );
        await page.keyboard.press("Escape");
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.evaluate(() =>
          localStorage.setItem(
            "mafia-dashboard.fancy-stuff.v1",
            JSON.stringify({ version: 2, enabled: false }),
          ),
        );
        await page.reload({ waitUntil: "networkidle" });
        await expect(page.locator('.app-shell[data-fancy-features="off"]')).toBeVisible();
        assert.equal(
          await page
            .locator(".game-ledger")
            .evaluate((node) => getComputedStyle(node).animationName),
          "none",
        );
        assert.deepEqual((await settled()).current, before.current);
        report.cases.push("en:keyboard-touch-tutorial-modal-motion-fancy-off");
      }
      await page.locator(".privacy-button").click();
      await expect(page.locator(".ledger-role[class*='role-']")).toHaveCount(0);
      assert.equal(
        await page
          .locator(".ledger-fact")
          .filter({ hasText: /Don|Sheriff|Дон|Шериф/i })
          .count(),
        0,
        "Private history is absent, not just visually concealed",
      );
      await capture(`${locale}-masked`);
      await page.locator(".privacy-button").click();
      await scroll.evaluate((node) => {
        node.scrollLeft = 0;
        node.scrollTop = 0;
      });
      const beforeFoul = await settled();
      await row(3).locator(".ledger-foul-button").click();
      await expect
        .poll(async () => (await read()).current.state.game.players[2].fouls)
        .toBe(beforeFoul.current.state.game.players[2].fouls + 1);
      const afterFoul = await settled();
      assert.notEqual(afterFoul.current.state.headEventId, beforeFoul.current.state.headEventId);
      await page.getByRole("button", { name: words.undo }).click();
      const confirmation = button(words.confirm);
      if (await confirmation.isVisible()) await confirmation.click();
      await expect
        .poll(async () => (await read()).current.state.headEventId)
        .toBe(beforeFoul.current.state.headEventId);
      assert.deepEqual((await settled()).current.state.game, beforeFoul.current.state.game);
      await page.reload({ waitUntil: "networkidle" });
      await expect(page.locator(".ledger-table")).toBeVisible();
      assert.deepEqual((await settled()).current.state.game, beforeFoul.current.state.game);
      report.cases.push(`${locale}:privacy-foul-undo-reload`);
      if (locale === "en") {
        const live = await settled();
        await button("Open game log").click();
        await page.getByRole("button", { name: "Preview state after log #1", exact: true }).click();
        await expect(button("Exit preview")).toBeVisible();
        await expect(page.locator(".ledger-row-controls button")).toHaveCount(0);
        await expect(button(words.next)).toHaveCount(0);
        await verifySidebar("en-preview");
        await capture("en-preview");
        await button(words.table).click();
        await button(words.ledger).click();
        assert.deepEqual((await read()).current.state, live.current.state);
        await button("Exit preview").click();
        assert.deepEqual((await settled()).current.state.game, live.current.state.game);
        report.cases.push("en:preview-prefix-readonly");
      }
      const nightId = randomUUID();
      const night = bestMoveNightFixture(players, nightId);
      await seed(night, nightId, "ledger");
      await expectCurrentPeriod(1, "night", true);
      await verifySidebar(`${locale}-night-controls`);
      const observe = page.locator(".federation-shooting-observation button");
      await observe.click();
      await button(words.table).click();
      await expect(page.locator(".timer-advance button")).toHaveCount(0);
      await button(words.ledger).click();
      await expect(observe).toHaveAttribute("aria-pressed", "true");
      await observe.click();
      await expect(row(2).locator(".ledger-player-action")).toBeVisible();
      await row(2).locator(".ledger-player-action").click();
      const draft = await settled({ draft: true });
      assert.ok(
        Object.values(draft.current.state.game.shotAssignments).every((seat) => seat === 2),
      );
      assert.deepEqual(draft.current.state.events, night.events);
      await button(words.table).click();
      await button(words.ledger).click();
      assert.deepEqual((await settled({ draft: true })).current.state, draft.current.state);
      await page.reload({ waitUntil: "networkidle" });
      await expect(row(2).locator('.shooter-button[aria-pressed="true"]')).toHaveCount(3);
      assert.deepEqual((await settled({ draft: true })).current.state, draft.current.state);
      await capture(`${locale}-night`);
      await page.locator(".ledger-advance button").first().click();
      await expect
        .poll(async () => (await read()).current.state.game.phase)
        .toBe("night-mafia-result");
      await settled();
      await capture(`${locale}-night-result`);
      report.cases.push(`${locale}:night-draft-reload-accept`);
      const phasesId = randomUUID();
      await verifyFourPairs(locale, words);
      for (const state of ledgerPhaseFixtures(players, phasesId)) {
        const phase = state.game.phase;
        const tag = `${locale}-sidebar-${phase}`;
        await seed(state, phasesId, "ledger");
        const before = await settled();
        await verifySidebar(tag);
        await capture(tag);
        await button(words.table).click();
        await expect(page.locator(".timer-advance button, .ledger-phase-bar")).toHaveCount(0);
        await expect(page.locator(".table-stage .table-advance button").first()).toBeVisible();
        await button(words.ledger).click();
        assert.deepEqual((await settled()).current.state, before.current.state);
        if (phase === "car-crash-decision") {
          await page.locator(".federation-ballot-tools summary").click();
          const corrections = page.locator(".federation-ballot-tools select");
          await expect(corrections).toHaveCount(10);
          await corrections.first().selectOption("yes");
          await corrections.nth(1).selectOption("no");
          const draft = await settled({ draft: true });
          await verifySidebar(`${tag}-expanded`);
          await button(words.table).click();
          await button(words.ledger).click();
          assert.deepEqual((await settled({ draft: true })).current.state, draft.current.state);
          await page.locator(".federation-ballot-tools summary").click();
          const scroller = page.locator("#game-utility-panels > .panel-reveal-content");
          await scroller.hover();
          await page.mouse.wheel(0, 3000);
          await expect(corrections.last()).toBeInViewport();
          await corrections.last().selectOption("yes");
          await settled({ draft: true });
          await capture(`${tag}-correction`);
        }
        if (phase !== "finished") {
          const beforeAction = await read();
          await page.locator(".ledger-advance button:not(:disabled)").first().tap();
          const afterAction = await settled();
          assert.equal(
            afterAction.current.state.events.length,
            beforeAction.current.state.events.length + 1,
          );
        }
        report.cases.push(`${locale}:sidebar-${phase}`);
      }
    }
    assert.equal(report.cases.length, 28, "All declared browser cases executed");
    assert.equal(new Set(report.cases).size, report.cases.length, "Distinct browser cases");
    report.sourcesAfter = await sourceManifest();
    assert.deepEqual(report.sourcesAfter, report.sourcesBefore, "Frozen source inputs");
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = String(error.stack ?? error);
    await page.screenshot({ path: path.join(evidence, "failure.png") }).catch(() => undefined);
    throw error;
  } finally {
    club.language = originalLanguage;
    await writeFile(path.join(evidence, "report.json"), JSON.stringify(report, null, 2));
  }
  console.log(`Ledger UI: ${report.cases.length} cases passed (${report.browser})`);
}
