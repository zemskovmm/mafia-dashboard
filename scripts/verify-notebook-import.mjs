/* global localStorage, document, innerWidth, URL */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { expect } from "@playwright/test";

// Run only inside verify-local-backend's owned fixture. No API interception.
export const verifyNotebookImport = async ({ page, request, player, evidenceDirectory, pass }) => {
  const active = await request({
    path: "/api/game-sessions",
    method: "POST",
    payload: {
      creationId: randomUUID(),
      name: "Active record retained during import",
      state: { hostPlayerId: player.id },
      results: null,
    },
  });
  assert.equal(active.status, 201);
  const activePath = `/api/game-sessions/${active.body.gameId}`;
  const original = await request({ path: activePath });
  const beforeStatistics = await request({ path: "/api/statistics" });
  const before = beforeStatistics.body.players.find(({ playerId }) => playerId === player.id);
  const locales = [
    {
      locale: "en",
      statistics: "Statistics",
      import: "Import paper game",
      label: "Game label",
      player: "Player at seat 1",
      role: "Role at seat 1",
      anonymousRole: "Role at seat 2",
      don: "Д Don",
      day: "Seat 1, day 1",
      night: "Seat 3, night 1",
      owner: "Best Move owner seat",
      target: "Best Move target",
      review: "Review import",
      save: "Import game",
      success: "Game imported and verified",
      back: "Back",
      backToGame: "Back to game",
      timeline: "Past game timeline",
      selector: "Completed game",
      table: "Recorded notebook",
      nightError: "Night accepts X only; move nominations to a day cell.",
    },
    {
      locale: "ru",
      statistics: "Статистика",
      import: "Импорт игры из тетради",
      label: "Название игры",
      player: "Игрок на месте 1",
      role: "Роль на месте 1",
      anonymousRole: "Роль на месте 2",
      don: "Д Дон",
      day: "Место 1, день 1",
      night: "Место 3, ночь 1",
      owner: "Место автора лучшего хода",
      target: "Номер",
      review: "Проверить импорт",
      save: "Импортировать игру",
      success: "Игра импортирована и проверена",
      back: "Назад",
      backToGame: "Назад к игре",
      timeline: "Хронология прошлых игр",
      selector: "Завершённая игра",
      table: "Записи из тетради",
      nightError: "Ночью допустим только X; перенесите выставление в дневную ячейку.",
    },
  ];
  for (const text of locales) {
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.locator(".manage-toolbar-button").click();
    await page.getByRole("combobox", { name: /^(Language|Язык)$/u }).selectOption(text.locale);
    await page.getByRole("button", { name: text.statistics, exact: true }).click();
    const browserRecovery = await page.evaluate(() =>
      Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.includes("session"))),
    );
    await page.getByRole("button", { name: text.import, exact: true }).click();
    const main = page.getByRole("main", { name: text.import, exact: true });
    await main.getByLabel(text.label, { exact: true }).fill(`Notebook ${text.locale}`);
    await main.getByLabel(text.player, { exact: true }).selectOption(player.id);
    await main.getByLabel(text.role, { exact: true }).selectOption("sheriff");
    await main.getByLabel(text.anonymousRole, { exact: true }).selectOption("don");
    await main.getByLabel(text.day, { exact: true }).fill("4 х");
    await main.getByLabel(text.night, { exact: true }).fill("2");
    await main.getByRole("button", { name: text.review, exact: true }).click();
    await expect(main.getByText(text.nightError, { exact: true })).toBeVisible();
    await main.getByLabel(text.night, { exact: true }).fill("X");
    await main.getByRole("combobox", { name: text.owner, exact: true }).selectOption("1");
    if (text.locale === "en") {
      for (const [index, value] of ["5", "6", "8"].entries())
        await main
          .getByRole("combobox", { name: `${text.target} ${index + 1}`, exact: true })
          .selectOption(value);
    }
    await main.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({
      path: resolve(evidenceDirectory, `notebook-${text.locale}-entry.png`),
    });
    if (text.locale === "ru") {
      await page.setViewportSize({ width: 390, height: 844 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      const scroller = main.locator(".notebook-table-scroll");
      await scroller.evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
      });
      await expect
        .poll(() => scroller.evaluate((element) => element.scrollLeft))
        .toBeGreaterThan(0);
      await page.screenshot({ path: resolve(evidenceDirectory, "notebook-ru-mobile.png") });
    }
    await main.getByRole("button", { name: text.review, exact: true }).click();
    await expect(
      main.getByRole("table", { name: text.table }).getByText("4 X", { exact: true }),
    ).toBeVisible();
    const posted = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/game-sessions" &&
        response.request().method() === "POST",
    );
    await main.getByRole("button", { name: text.save, exact: true }).click();
    const response = await posted;
    assert.equal(response.status(), 201);
    const payload = response.request().postDataJSON();
    const created = await response.json();
    await expect(main.getByRole("status")).toHaveText(text.success);
    const saved = await request({ path: `/api/game-sessions/${created.gameId}` });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.session.state, payload.state);
    assert.deepEqual(saved.body.session.results, payload.results);
    assert.equal(saved.body.session.status, "completed");
    assert.deepEqual(payload.state.notebook.cells, [
      { seat: 1, day: 1, phase: "day", nomination: 4, eliminated: true },
      { seat: 3, day: 1, phase: "night", eliminated: true },
    ]);
    assert.deepEqual(payload.state.notebook.bestMove, {
      ownerSeat: 1,
      targetSeats: text.locale === "en" ? [5, 6, 8] : [],
    });
    assert.deepEqual(payload.state.notebook.seatRoles, [
      { seat: 1, role: "sheriff" },
      { seat: 2, role: "don" },
    ]);
    assert.deepEqual(payload.results, {
      players: [
        { playerId: player.id, seat: 1, role: "sheriff", team: "red", status: "eliminated" },
      ],
    });
    const duplicate = await request({ path: "/api/game-sessions", method: "POST", payload });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.gameId, created.gameId);
    assert.equal(duplicate.body.duplicate, true);
    const listed = await request({ path: "/api/game-sessions?status=completed" });
    const matches = listed.body.sessions.filter(({ gameId }) => gameId === created.gameId);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].timelineAvailable, false);
    assert.equal(matches[0].eventCount, 0);
    assert.equal(matches[0].playedAt, null);
    assert.equal(matches[0].outcome, null);
    assert.deepEqual((await request({ path: activePath })).body, original.body);
    assert.deepEqual(
      await page.evaluate(() =>
        Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.includes("session"))),
      ),
      browserRecovery,
    );
    await main.getByRole("button", { name: text.back, exact: true }).click();
    await page.getByRole("button", { name: text.backToGame, exact: true }).click();
    await page.locator(".manage-toolbar-button").click();
    await page.getByRole("button", { name: text.timeline, exact: true }).click();
    await page
      .getByRole("combobox", { name: text.selector, exact: true })
      .selectOption(created.gameId);
    await expect(
      page.getByRole("table", { name: text.table }).getByText("4 X", { exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(
      page.getByRole("table", { name: text.table }).getByText(text.don, { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: resolve(evidenceDirectory, `notebook-${text.locale}-reopened.png`),
    });
    await page.getByRole("button", { name: text.back, exact: true }).click();
    pass(`notebook-import-real-ui-${text.locale}`, {
      duplicateRetried: true,
      activeRecordUnchanged: true,
    });
  }
  const statistics = await request({ path: "/api/statistics" });
  const after = statistics.body.players.find(({ playerId }) => playerId === player.id);
  assert.equal(after.totals.games, before.totals.games + locales.length);
  assert.equal(after.totals.outcomeGames, before.totals.outcomeGames);
  assert.equal(after.foulGames, before.foulGames);
  assert.equal(after.bestMoveResults, before.bestMoveResults);
  pass("notebook-import-sparse-statistics-no-fabricated-metrics");
};
