import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { expect } from "@playwright/test";

// Uses only the caller's owned local backend, authenticated browser and generated player.
export const verifyCompletedRecords = async ({
  page,
  request,
  player,
  evidenceDirectory,
  pass,
}) => {
  const records = [
    { name: "Minimal recorded game", state: {}, results: {} },
    {
      name: "Partial recorded game",
      state: {
        game: {
          phase: "finished",
          day: 1,
          players: [
            {
              id: player.id,
              seat: 1,
              role: "sheriff",
              team: "red",
              status: "eliminated",
              fouls: 2,
            },
          ],
        },
      },
      results: { outcome: "red", players: [{ playerId: player.id }] },
    },
    {
      name: "Stored Best Move",
      state: {
        game: {
          phase: "draw",
          players: [{ id: player.id, seat: 1 }],
          bestMove: { playerSeat: 1, mafiaHits: 2 },
        },
      },
      results: { outcome: "draw", players: [{ playerId: player.id, seat: 2 }] },
    },
  ];
  const saved = [];
  for (const record of records) {
    const created = await request({
      path: "/api/game-sessions",
      method: "POST",
      payload: { creationId: randomUUID(), ...record },
    });
    assert.equal(created.status, 201, "Completed fixture creation must use the real API");
    const path = `/api/game-sessions/${created.body.gameId}`;
    const read = await request({ path });
    assert.equal(read.status, 200);
    assert.equal(read.body.session.status, "completed");
    assert.deepEqual(read.body.session.state, record.state);
    assert.deepEqual(read.body.session.results, record.results);
    saved.push({ path, session: read.body.session });
  }
  const statistics = await request({ path: "/api/statistics" });
  assert.equal(statistics.status, 200);
  const observed = statistics.body.players.find(({ playerId }) => playerId === player.id);
  assert.ok(observed, "Known completed participant must contribute to statistics");
  assert.equal(observed.totals.games, 2);
  assert.equal(observed.totals.outcomeGames, 2);
  assert.equal(observed.totals.wins, 1);
  assert.equal(observed.totals.draws, 1);
  assert.equal(observed.foulGames, 1);
  assert.equal(observed.fouls, 2);
  assert.equal(observed.statusGames, 1);
  assert.equal(observed.bestMoveResults, 1);
  assert.equal(observed.bestMoveHits, 2);
  assert.equal(observed.lastPlayedAt, null);
  assert.equal(observed.rating.ratedGames, 0);
  const history = await request({ path: "/api/game-sessions?status=completed" });
  assert.equal(history.status, 200);
  for (const { session } of saved) {
    const summary = history.body.sessions.find(({ gameId }) => gameId === session.gameId);
    assert.ok(summary);
    assert.equal(summary.playedAt, null);
    assert.equal(summary.timelineAvailable, false);
  }
  pass("partial-completed-records-http-observations");

  for (let index = 0; index < 5; index += 1) await page.locator(".privacy-button").click();
  const locales = [
    {
      locale: "en",
      statistics: "Statistics",
      statisticsHeading: "Club statistics",
      discipline: "Discipline and recorded results",
      metrics: [
        ["Fouls", "2"],
        ["Final eliminations", "1"],
        ["Best Move hits", "2"],
      ],
      backToGame: "Back to game",
      timeline: "Past game timeline",
      selector: "Completed game",
      facts: "Recorded facts",
      unavailable: "Timeline detail is unavailable for this game.",
      participantsUnavailable: "Participant observations are unavailable.",
      unknown: "Unknown",
      cells: [player.nickname, "1", "Sheriff", "Citizens", "Eliminated", "2", "Unknown"],
      back: "Back",
    },
    {
      locale: "ru",
      statistics: "Статистика",
      statisticsHeading: "Статистика клуба",
      discipline: "Дисциплина и записанные результаты",
      metrics: [
        ["Фолы", "2"],
        ["Итоговые удаления", "1"],
        ["Попадания в «Лучшем ходе»", "2"],
      ],
      backToGame: "Назад к игре",
      timeline: "Хронология прошлых игр",
      selector: "Завершённая игра",
      facts: "Записанные факты",
      unavailable: "Подробная хронология этой игры недоступна.",
      participantsUnavailable: "Данные об участниках недоступны.",
      unknown: "Неизвестно",
      cells: [player.nickname, "1", "Шериф", "Мирные", "Удалены", "2", "Неизвестно"],
      back: "Назад",
    },
  ];
  for (const text of locales) {
    await page.locator(".manage-toolbar-button").click();
    if (text.locale === "ru")
      await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("ru");
    await page.getByRole("button", { name: text.statistics, exact: true }).click();
    const statisticsScreen = page.locator(".statistics-screen");
    await expect(
      statisticsScreen.getByRole("heading", { name: text.statisticsHeading }),
    ).toBeVisible();
    await statisticsScreen.getByRole("button", { name: player.nickname, exact: true }).click();
    await expect(
      statisticsScreen.getByText("Partial recorded game", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: resolve(evidenceDirectory, `partial-statistics-${text.locale}.png`),
    });
    for (const [label, value] of text.metrics) {
      const metric = statisticsScreen
        .locator(".statistics-player > .statistics-metrics > div")
        .filter({
          has: page.getByText(label, { exact: true }),
        });
      await expect(metric.locator("dd")).toHaveText(value);
    }
    await statisticsScreen
      .getByRole("heading", { name: text.discipline, exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: resolve(evidenceDirectory, `partial-metrics-${text.locale}.png`),
    });
    await statisticsScreen.getByRole("button", { name: text.backToGame, exact: true }).click();
    await page.locator(".dev-toolbar-button").click();
    await page.getByRole("button", { name: text.timeline, exact: true }).click();
    const selector = page.getByRole("combobox", { name: text.selector, exact: true });
    await selector.selectOption(saved[1].session.gameId);
    const facts = page.getByRole("region", { name: text.facts, exact: true });
    await expect(page.getByText(text.unavailable, { exact: true })).toBeVisible();
    await expect(facts.locator("tbody tr").locator("th, td")).toHaveText(text.cells);
    await facts.screenshot({
      path: resolve(evidenceDirectory, `partial-facts-${text.locale}.png`),
    });
    await selector.selectOption(saved[2].session.gameId);
    await expect(facts.locator("tbody tr").locator("th, td")).toHaveText([
      player.nickname,
      "2",
      text.unknown,
      text.unknown,
      text.unknown,
      text.unknown,
      "2",
    ]);
    await facts.screenshot({
      path: resolve(evidenceDirectory, `stored-best-move-${text.locale}.png`),
    });
    await selector.selectOption(saved[0].session.gameId);
    await expect(facts.getByText(text.participantsUnavailable, { exact: true })).toBeVisible();
    await expect(facts.getByRole("table")).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.getByRole("button", { name: text.back, exact: true }).click();
    pass(`partial-completed-records-real-app-${text.locale}`);
  }
  for (const { path, session } of saved) {
    const after = await request({ path });
    assert.equal(after.status, 200);
    assert.deepEqual(after.body.session, session, "Browsing must not rewrite completed authority");
  }
};
