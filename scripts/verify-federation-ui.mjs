/* global URL, document, innerWidth, innerHeight, localStorage */
/*
 * Scenario module imported by verify-ui.mjs; reuses its page and API fixtures.
 * Browser save/reload evidence is NOT database/backend qualification.
 * APP_URL=http://127.0.0.1:8187 UI_FEDERATION_ONLY=1 node scripts/verify-ui.mjs
 * Checkpoints establish preconditions only; every tested outcome is a UI action.
 */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import {
  FEDERATION_RULES_EDITION,
  beginNight,
  completeCurrentTurn,
  completeMafiaShots,
  completeNight,
  createGameLogEntry,
  createInitialGameBaseline,
  hashGameState,
  nominate,
  replayGameLog,
  resolveMafiaShots,
  skipDonCheck,
  skipSheriffCheck,
} from "../packages/game-domain/src/index.ts";
import { assertExactOrigin } from "./session-verifier-contracts.mjs";

const key = "mafia-dashboard.game-session.v5";
const clone = (value) => JSON.parse(JSON.stringify(value));
export const legacySetupState = () => ({
  setup: { step: "players", selectedPlayerIds: Array(10).fill(""), setup: null },
  game: null,
  hostPlayerId: null,
  playlistId: "",
  log: [],
  undoHistory: [],
  undoBudget: 0,
  initialGame: null,
  events: [],
  headEventId: null,
  resetReturnEventId: null,
  legacyLog: [],
});
const envelope = (clubId, gameId, state) => ({
  version: 5,
  clubId,
  gameId,
  creationId: null,
  revision: 1,
  current: { name: "Federation UI verification", state, results: null },
  outbox: [],
  failed: false,
  clearFailed: false,
  clearingGameId: null,
  removed: false,
  legacyGameId: null,
});
const sources = [
  "apps/web/src/App.tsx",
  "apps/web/src/features/setup/SetupWizard.tsx",
  "apps/web/src/features/game/GameScreen.tsx",
  "apps/web/src/features/night/NightStage.tsx",
  "apps/web/src/features/game/FederationBestMoveStage.tsx",
  "apps/web/src/features/voting/FederationBallot.tsx",
  "apps/web/src/features/voting/FederationBallotTools.tsx",
  "apps/web/src/features/voting/FederationBallot.css",
  "apps/web/src/features/game/federation-controls.css",
  "apps/web/src/features/setup/SetupWizard.css",
  "apps/web/src/features/table/GameTable.tsx",
  "apps/web/src/styles/app.css",
  "packages/game-domain/src/game-events.ts",
];
const sourceHashes = async () =>
  Object.fromEntries(
    await Promise.all(
      sources.map(async (p) => [
        p,
        createHash("sha256")
          .update(await readFile(p))
          .digest("hex"),
      ]),
    ),
  );
function branch(state) {
  const byId = new Map(state.events.map((e) => [e.id, e]));
  const chain = [];
  let head = state.headEventId;
  const seen = new Set();
  while (head !== null) {
    assert.ok(!seen.has(head), "History cycle");
    seen.add(head);
    const e = byId.get(head);
    assert.ok(e, `Missing event ${head}`);
    chain.unshift(e);
    head = e.parentEventId;
  }
  return chain;
}
function replay(state) {
  const chain = branch(state);
  const result = replayGameLog(state.initialGame, chain).game;
  assert.equal(hashGameState(result), hashGameState(state.game), "Live/replay hash equality");
  for (const e of chain) {
    assert.equal(e.replayVersion, state.initialGame.replayVersion);
    assert.equal(e.rulesEdition, state.initialGame.rulesEdition);
  }
  return {
    head: state.headEventId,
    hash: hashGameState(result),
    count: chain.length,
    types: chain.map((e) => e.type),
  };
}
export function checkpoint(game, template, gameId) {
  const root = createGameLogEntry({
    gameId,
    id: randomUUID(),
    sequence: 1,
    parentEventId: null,
    createdAt: "2026-10-14T08:00:00.000Z",
    before: game,
    draft: { type: "game.checkpointed", payload: {} },
  });
  const state = {
    ...clone(template),
    game: clone(root.after),
    initialGame: createInitialGameBaseline(root.after),
    events: [root.entry],
    headEventId: root.entry.id,
    resetReturnEventId: null,
    undoHistory: [],
    undoBudget: 0,
    log: [],
    legacyLog: [],
  };
  replay(state);
  return state;
}
export async function runFederationScenarios({ page, baseUrl, club, players, api, evidenceDir }) {
  const origin = new URL(baseUrl).origin;
  assert.match(new URL(baseUrl).hostname, /^(localhost|127\.0\.0\.1|\[::1\])$/, "Local Vite only");
  const evidence = path.resolve(evidenceDir);
  await mkdir(evidence, { recursive: true });
  const { width, height } = page.viewportSize();
  const bestMoveOrder = process.env.UI_FEDERATION_BEST_MOVE_ORDER ?? "skip-first";
  assert.ok(["skip-first", "partial-first"].includes(bestMoveOrder), "Unknown Best Move order");
  const display = (game, seat) =>
    players.find((p) => p.id === game.players.find((p) => p.seat === seat).id).nickname;
  const sourceBefore = await sourceHashes();
  const report = {
    origin,
    api: "existing strict in-memory mock; not real storage",
    sourceBefore,
    width,
    height,
    geometryFailures: [],
    scenarios: [],
    screenshots: [],
  };
  const row = report;
  async function enter(page) {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    assertExactOrigin(page.url(), origin);
    const card = page.locator(".club-card-open");
    await expect(page.locator(".club-card-open, .app-shell, .players-shell").first()).toBeVisible();
    if (await card.first().isVisible()) await card.first().click();
  }
  async function freshSetup(page) {
    await enter(page);
    await expect(page.locator(".players-shell, .player-setup-card h1").first()).toBeVisible();
    const heading = page.getByRole("heading", { name: "Select 10 players + host" });
    if (!(await heading.isVisible())) {
      await expect(page.locator(".players-shell")).toBeVisible();
      await page.locator(".players-screen-header button").click();
    }
    await expect(heading).toBeVisible();
    await page.getByRole("button", { name: "Select available players" }).click();
    const available = page.getByRole("button", { name: /^Mark UI Player \d+ available$/ });
    await expect(page.getByRole("button", { name: "Close available players" })).toBeVisible();
    const pendingAvailability = await available.count();
    assert.ok(
      pendingAvailability === 11 || pendingAvailability === 0,
      "Availability fixture unexpectedly partial",
    );
    for (let i = 0; i < pendingAvailability; i++) await available.first().click();
    await page.getByRole("button", { name: "Close available players" }).click();
    await page.getByRole("combobox", { name: "Host player" }).click();
    await page.getByRole("option", { name: players[10].nickname, exact: true }).click();
    await page.getByRole("button", { name: "Assign players" }).click();
    await expect(page.getByRole("button", { name: "Start game", exact: true })).toBeEnabled();
  }
  async function draw(page) {
    await page.getByRole("button", { name: "Start game", exact: true }).click();
    for (let i = 0; i < 10; i++)
      await page
        .getByRole("button", { name: /^Draw role for / })
        .first()
        .click();
    await page.getByRole("button", { name: "Begin Mafia planning stage", exact: true }).click();
  }
  const read = async (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), key);
  async function settled(page, api) {
    await expect(page.locator('.save-indicator[data-status="saved"]')).toBeVisible();
    await expect.poll(async () => (await read(page))?.outbox.length).toBe(0);
    const env = await read(page);
    assert.ok(env?.current);
    await expect
      .poll(() => hashGameState(api.sessions.get(env.gameId)?.state.game ?? env.current.state.game))
      .toBe(hashGameState(env.current.state.game));
    assert.deepEqual(
      api.sessions.get(env.gameId).state,
      env.current.state,
      "Mock API readback matches local state",
    );
    api.clean();
    return env;
  }
  async function seed(page, api, state, gameId = randomUUID()) {
    await page.goto(new URL("/health/ready", origin).href);
    api.seed(gameId, state);
    await page.evaluate(({ k, value }) => localStorage.setItem(k, JSON.stringify(value)), {
      k: key,
      value: envelope(club.id, gameId, state),
    });
    await enter(page);
    return gameId;
  }
  async function saveReplay(page, api, label, width, height) {
    const env = await settled(page, api);
    const proof = replay(env.current.state);
    await writeFile(
      path.join(evidence, `${width}x${height}-${label}-state.json`),
      JSON.stringify(env, null, 2),
    );
    return { env, proof };
  }
  async function capture(page, label, width, height) {
    const file = path.join(evidence, `${width}x${height}-${label}.png`);
    await page.screenshot({ path: file, animations: "disabled" });
    const geometry = await page.locator(".game-shell").evaluate((shell) => {
      const title = shell.querySelector(".game-header h1").getBoundingClientRect();
      const controls = [...shell.querySelectorAll(".table-advance button")].map((b) => {
        const r = b.getBoundingClientRect();
        return {
          label: b.textContent.trim(),
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          bottom: r.bottom,
          right: r.right,
        };
      });
      return {
        viewport: [innerWidth, innerHeight],
        workspaceScroll: {
          left: shell.querySelector(".table-workspace").scrollLeft,
          top: shell.querySelector(".table-workspace").scrollTop,
        },
        documentWidth: document.documentElement.scrollWidth,
        title: { x: title.x, y: title.y, right: title.right, bottom: title.bottom },
        controls,
        overlappingSeatTargets: [
          ...shell.querySelectorAll(".seat-actions button, .federation-ballot-tools-toggle"),
        ].flatMap((button, index, buttons) => {
          const a = button.getBoundingClientRect();
          const others = [...shell.querySelectorAll(".player-seat"), ...buttons.slice(index + 1)];
          return others.flatMap((other) => {
            const b = other.getBoundingClientRect();
            const overlapWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            return overlapWidth > 0.5 && overlapHeight > 0.5
              ? [
                  {
                    target: button.getAttribute("aria-label") ?? button.textContent.trim(),
                    other: other.getAttribute("aria-label") ?? other.textContent.trim(),
                    overlapWidth,
                    overlapHeight,
                  },
                ]
              : [];
          });
        }),
        clippedTableControls: [
          ...shell.querySelectorAll(".player-seat, .seat-actions button"),
        ].flatMap((b) => {
          const workspace = shell.querySelector(".table-workspace").getBoundingClientRect();
          const r = b.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return [];
          return r.left < workspace.left - 1 ||
            r.top < workspace.top - 1 ||
            r.right > workspace.right + 1 ||
            r.bottom > workspace.bottom + 1
            ? [
                {
                  label: b.getAttribute("aria-label") ?? b.textContent.trim(),
                  x: r.x,
                  y: r.y,
                  right: r.right,
                  bottom: r.bottom,
                  workspaceBottom: workspace.bottom,
                },
              ]
            : [];
        }),
      };
    });
    if (geometry.documentWidth > width + 1)
      row.geometryFailures.push(`Horizontal overflow ${label}`);
    if (geometry.workspaceScroll.left !== 0 || geometry.workspaceScroll.top !== 0)
      row.geometryFailures.push(
        `${label}: Fixed table scrolled: ${JSON.stringify(geometry.workspaceScroll)}`,
      );
    if (
      width === 1000 &&
      height === 600 &&
      (label === "fresh-day" || label.startsWith("ballot-"))
    ) {
      for (const overlap of geometry.overlappingSeatTargets)
        row.geometryFailures.push(`${label}: Seat targets overlap: ${JSON.stringify(overlap)}`);
    }
    for (const b of geometry.controls)
      if (!(b.x >= 0 && b.y >= 0 && b.right <= width + 1 && b.bottom <= height + 1))
        row.geometryFailures.push(`${label}: Primary action offscreen: ${JSON.stringify(b)}`);
    for (const b of geometry.clippedTableControls)
      row.geometryFailures.push(
        `${label}: Table control clipped by workspace: ${JSON.stringify(b)}`,
      );
    return { file, geometry };
  }
  async function undo(page) {
    await page.getByRole("button", { name: /^Undo last action/ }).click();
    const confirm = page.getByRole("button", { name: "Undo", exact: true });
    if (await confirm.isVisible()) await confirm.click();
  }
  async function finishOutcome(gameId, label) {
    await page.getByRole("button", { name: "Finish the game", exact: true }).click();
    await expect.poll(() => api.sessions.get(gameId)?.status).toBe("completed");
    const saved = clone(api.sessions.get(gameId));
    assert.ok(saved.results);
    const proof = replay(saved.state);
    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), key)).toBe(null);
    await writeFile(
      path.join(evidence, `${width}x${height}-${label}-completed.json`),
      JSON.stringify(saved, null, 2),
    );
    api.clean();
    return { saved, proof };
  }

  try {
    await freshSetup(page);
    const selected = await read(page);
    assert.equal(
      selected.current.state.setup.rulesEdition,
      FEDERATION_RULES_EDITION,
      "Fresh player setup captures edition before role draw",
    );
    await draw(page);
    const planning = await settled(page, api);
    assert.equal(planning.current.state.initialGame.replayVersion, 2);
    assert.equal(planning.current.state.game.rulesEdition, FEDERATION_RULES_EDITION);
    for (const name of [
      "Mafia asleep",
      "Confirm masked Don identification",
      "Confirm masked Sheriff identification",
      "Begin free seating",
      "Begin zero round",
    ])
      await page.getByRole("button", { name, exact: true }).click();
    const fresh = await saveReplay(page, api, "fresh-opening", width, height);
    assert.equal(fresh.env.current.state.game.phase, "day");
    assert.equal(fresh.env.current.state.game.completedGameNights, 1);
    assert.equal(fresh.env.current.state.game.sheriffChecksPerformed, 0);
    assert.deepEqual(
      branch(fresh.env.current.state)
        .slice(1)
        .map((e) => e.payload.to),
      ["mafia-sleep", "don-identification", "sheriff-identification", "free-seating", "day"],
    );
    row.scenarios.push({ name: "fresh-v2-five-step-opening", ...fresh.proof });
    row.screenshots.push(await capture(page, "fresh-day", width, height));
    const template = fresh.env.current.state,
      day = clone(template.game);

    // Resume an explicitly legacy saved setup; never override fresh app policy.
    await seed(page, api, legacySetupState());
    await freshSetup(page);
    await draw(page);
    const legacy = await settled(page, api);
    assert.equal(legacy.current.state.initialGame.replayVersion, 1);
    assert.equal(legacy.current.state.game.rulesEdition, undefined);
    replay(legacy.current.state);
    await page.reload({ waitUntil: "networkidle" });
    const legacyReload = await settled(page, api);
    assert.equal(legacyReload.current.state.initialGame.replayVersion, 1);
    row.scenarios.push({
      name: "explicit-legacy-resume-v1",
      ...replay(legacyReload.current.state),
    });

    let ballot = clone(day);
    ballot = nominate(ballot, ballot.turnOrder[0], 4);
    ballot = completeCurrentTurn(ballot);
    ballot = nominate(ballot, ballot.turnOrder[ballot.currentTurnIndex], 5);
    while (ballot.phase === "day") ballot = completeCurrentTurn(ballot);
    assert.equal(ballot.phase, "voting", "Completed nominated day opens ballot");
    const ballotId = randomUUID();
    await seed(page, api, checkpoint(ballot, template, ballotId), ballotId);
    await expect(page.getByRole("button", { name: /^Vote as / }).first()).toBeDisabled();
    for (const n of [1, 2])
      await page.getByRole("button", { name: `Announce full order (${n}/2)`, exact: true }).click();
    await page.getByRole("button", { name: "Mention candidate #4 (1/2)", exact: true }).click();
    await expect(page.getByRole("button", { name: /^Vote as / }).first()).toBeDisabled();
    await page.getByRole("button", { name: "Mention candidate #4 (2/2)", exact: true }).click();
    for (let s = 1; s <= 3; s++)
      await page
        .getByRole("button", {
          name: `Vote as ${display(day, s)} for ${display(day, 4)}`,
          exact: true,
        })
        .click();
    await page.locator(".table-stage").evaluate(async (stage) => {
      await Promise.all(
        stage
          .getAnimations({ subtree: true })
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
    const stopBeforeTools = await page
      .getByRole("button", { name: "STOP — accept count", exact: true })
      .boundingBox();
    const toolsToggle = page.getByRole("button", { name: "Ballot rules & review", exact: true });
    await toolsToggle.focus();
    await page.keyboard.press("Enter");
    await expect(toolsToggle).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.getByText("Federation ballots cannot be skipped by host choice.", { exact: false }),
    ).toBeVisible();
    await page.getByText("Dispute count", { exact: true }).click();
    await page
      .getByLabel("Dispute reason", { exact: true })
      .fill("Judge requests external recording review");
    await page.getByRole("button", { name: "Pause voting for review", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "STOP — accept count", exact: true }),
    ).toBeDisabled();
    await expect(page.getByRole("button", { name: /^Vote as / }).first()).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Accept final reviewed count", exact: true }),
    ).toBeDisabled();
    row.screenshots.push(await capture(page, "ballot-dispute", width, height));
    const disputed = await settled(page, api);
    const sheet = page.locator(".federation-ballot-sheet");
    const sheetBox = await sheet.boundingBox();
    assert.ok(
      sheetBox.x >= 0 && sheetBox.y >= 0 && sheetBox.y + sheetBox.height <= height + 1,
      "Review sheet bounded by viewport",
    );
    await page.getByRole("button", { name: "Close ballot tools", exact: true }).click();
    await expect(toolsToggle).toBeFocused();
    await expect(
      page.getByRole("button", { name: "STOP — accept count", exact: true }),
    ).toBeDisabled();
    assert.deepEqual(
      await page.getByRole("button", { name: "STOP — accept count", exact: true }).boundingBox(),
      stopBeforeTools,
      "Opening/scrolling review never moves STOP",
    );
    row.screenshots.push(await capture(page, "ballot-dispute-table", width, height));
    await page.keyboard.press("Enter");
    await page
      .getByLabel("Final ruling reason", { exact: true })
      .fill("External recording confirms three accepted hands");
    await page
      .getByRole("checkbox", { name: "I reviewed the external recording", exact: true })
      .check();
    await page.getByRole("button", { name: "Accept final reviewed count", exact: true }).click();
    await sheet.focus();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(toolsToggle).toBeFocused();
    await page.getByRole("button", { name: "STOP — accept count", exact: true }).click();
    await page.getByRole("button", { name: "Next candidate", exact: true }).click();
    await page.getByRole("button", { name: "Mention candidate #5 (1/2)", exact: true }).click();
    await page.getByRole("button", { name: "Mention candidate #5 (2/2)", exact: true }).click();
    const accepted = await settled(page, api);
    replay(accepted.current.state);
    assert.deepEqual(
      accepted.current.state.game.voteAssignments,
      Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i + 1, i < 3 ? 4 : 5])),
    );
    await page.getByRole("button", { name: "STOP — accept count", exact: true }).click();
    row.screenshots.push(await capture(page, "ballot-stop", width, height));
    await page.getByRole("button", { name: "Finish voting", exact: true }).click();
    const resolved = await saveReplay(page, api, "ballot-resolved", width, height);
    assert.equal(branch(resolved.env.current.state).at(-1).type, "voting.resolved");
    await page.reload({ waitUntil: "networkidle" });
    const ballotReload = await settled(page, api);
    replay(ballotReload.current.state);
    assert.equal(ballotReload.current.state.headEventId, resolved.env.current.state.headEventId);
    await undo(page);
    const ballotUndo = await settled(page, api);
    replay(ballotUndo.current.state);
    assert.equal(ballotUndo.current.state.game.phase, "voting");
    assert.equal(ballotUndo.current.state.game.ballot.stopped, true);
    await page.getByRole("button", { name: "Finish voting", exact: true }).click();
    const reruled = await saveReplay(page, api, "ballot-reaccepted", width, height);
    row.scenarios.push({
      name: "ordered-ballot-dispute-reviewed-stop-auto-last-resolution-undo-reload",
      ...reruled.proof,
    });
    const previousLanguage = club.language;
    try {
      club.language = "ru";
      await seed(page, api, disputed.current.state, disputed.gameId);
      const russianTools = page.getByRole("button", {
        name: "Правила и проверка голосования",
        exact: true,
      });
      await expect(russianTools).toHaveAttribute("aria-expanded", "true");
      await expect(
        page.getByRole("checkbox", { name: "Я просмотрел внешнюю запись", exact: true }),
      ).toBeVisible();
      row.screenshots.push(await capture(page, "ballot-dispute-ru", width, height));
      await page
        .getByRole("button", { name: "Закрыть инструменты голосования", exact: true })
        .click();
      await expect(russianTools).toBeFocused();
      row.screenshots.push(await capture(page, "ballot-dispute-table-ru", width, height));
    } finally {
      club.language = previousLanguage;
    }
    // Domain-produced previous miss is a precondition, not the tested draw outcome.
    let priorMiss = completeMafiaShots(resolveMafiaShots(beginNight(day)).game);
    if (priorMiss.phase === "night-don") priorMiss = skipDonCheck(priorMiss);
    if (priorMiss.phase === "night-sheriff") priorMiss = skipSheriffCheck(priorMiss);
    priorMiss = completeNight(priorMiss);
    assert.equal(priorMiss.completedGameNights, 2);
    assert.equal(priorMiss.phase, "day");
    const drawId = randomUUID();
    await seed(page, api, checkpoint(beginNight(priorMiss), template, drawId), drawId);
    for (const name of [
      "Evaluate Mafia shots",
      "Continue night",
      "Skip Don check",
      "Skip Sheriff check",
      "Announce morning",
    ])
      await page.getByRole("button", { name, exact: true }).click();
    const drawn = await saveReplay(page, api, "automatic-draw", width, height);
    assert.equal(drawn.env.current.state.game.phase, "draw");
    assert.deepEqual(drawn.env.current.state.game.rulesDrawReason, {
      rule: "6.5.6",
      completedGameNights: 3,
      consecutiveUnchangedNights: 3,
    });
    assert.ok(
      !drawn.proof.types.includes("game.drawn"),
      "Rules draw needs no invented host draw event",
    );
    row.screenshots.push(await capture(page, "automatic-draw", width, height));
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(
      (await settled(page, api)).current.state.headEventId,
      drawn.env.current.state.headEventId,
    );
    const completedDraw = await finishOutcome(drawId, "automatic-draw");
    assert.equal(completedDraw.saved.results.outcome, "draw");
    assert.equal(
      completedDraw.saved.results.reason,
      "MAFGAME 6.5.6: three consecutive game nights without a departure",
    );
    row.scenarios.push({ name: "automatic-rule-draw-reload-finish", ...completedDraw.proof });

    const adjudicatedId = randomUUID();
    await seed(page, api, checkpoint(day, template, adjudicatedId), adjudicatedId);
    await page.getByRole("button", { name: "Open Manage menu", exact: true }).click();
    await page.getByText("Referee-awarded victory", { exact: true }).click();
    await page.getByRole("combobox", { name: /^Losing team/ }).selectOption("black");
    await page.getByRole("combobox", { name: /^Applicable rule/ }).selectOption("6.3.5");
    await page
      .getByLabel("Judge's reason", { exact: true })
      .fill("Referee ruling with required committee agreement");
    await expect(
      page.getByRole("button", { name: "Award victory to opposing team", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("checkbox", { name: "Required committee agreement obtained", exact: true })
      .check();
    await page.getByRole("button", { name: "Award victory to opposing team", exact: true }).click();
    const awarded = await saveReplay(page, api, "adjudication", width, height);
    assert.equal(awarded.env.current.state.game.winner, "red");
    assert.deepEqual(
      awarded.env.current.state.game.players.map((p) => p.status),
      day.players.map((p) => p.status),
    );
    assert.equal(branch(awarded.env.current.state).at(-1).type, "game.adjudicated");
    row.screenshots.push(await capture(page, "adjudication", width, height));
    await page.reload({ waitUntil: "networkidle" });
    replay((await settled(page, api)).current.state);
    const completedRuling = await finishOutcome(adjudicatedId, "adjudication");
    assert.deepEqual(
      completedRuling.saved.results.adjudication,
      awarded.env.current.state.game.adjudication,
    );
    row.scenarios.push({
      name: "reasoned-committee-adjudication-reload-finish",
      ...completedRuling.proof,
    });

    for (const count of bestMoveOrder === "partial-first" ? [2, 0] : [0, 2]) {
      const id = randomUUID();
      const night = beginNight(day);
      await seed(page, api, checkpoint(night, template, id), id);
      const victim = day.players.find((p) => p.role === "citizen").seat;
      await page
        .getByRole("button", {
          name: `Assign all Mafia shots to ${display(day, victim)}`,
          exact: true,
        })
        .click();
      await page.getByRole("button", { name: "Evaluate Mafia shots", exact: true }).click();
      await page.getByRole("button", { name: "Continue night", exact: true }).click();
      const sheriff = day.players.find((p) => p.role === "sheriff").seat;
      const black = day.players.find((p) => p.role === "mafia").seat;
      // Keep one edge-seat check deterministic: transformed focus must not scroll the table.
      const donTarget = count === 2 ? 2 : sheriff;
      await page
        .getByRole("button", { name: `Don check ${display(day, donTarget)}`, exact: true })
        .click();
      await expect(
        page.getByText(`Read back #${donTarget}, then show the result.`, { exact: true }),
      ).toBeVisible();
      row.screenshots.push(await capture(page, `best-${count}-don-readback`, width, height));
      await page.getByRole("button", { name: "Proceed to Sheriff check", exact: true }).click();
      const checkSeat = count === 0 ? victim : black;
      await page
        .getByRole("button", { name: `Sheriff check ${display(day, checkSeat)}`, exact: true })
        .click();
      await expect(
        page.getByText(
          `Read back #${checkSeat}. ${count === 0 ? "Red — thumb up." : "Black — thumb down."}`,
          { exact: true },
        ),
      ).toBeVisible();
      row.screenshots.push(await capture(page, `best-${count}-sheriff-readback`, width, height));
      await page.getByRole("button", { name: "Continue night", exact: true }).click();
      await page.getByRole("button", { name: "Record Best Move", exact: true }).click();
      for (const n of [7, 7].slice(0, count))
        await page.getByRole("button", { name: `Accept number ${n}`, exact: true }).click();
      api.clean();
      const finishName = count === 0 ? "Skip Best Move" : "Finish early";
      await expect(page.getByRole("button", { name: finishName, exact: true })).toBeDisabled();
      await page
        .getByRole("checkbox", {
          name: "Numbers read back and accepted; player sleeps",
          exact: true,
        })
        .check();
      row.screenshots.push(await capture(page, `best-${count}-accepted-prefix`, width, height));
      await page.getByRole("button", { name: finishName, exact: true }).click();
      const finalized = await saveReplay(page, api, `best-${count}-finalized`, width, height);
      assert.equal(finalized.env.current.state.game.phase, "night-resolution");
      assert.equal(finalized.env.current.state.game.day, 1);
      assert.deepEqual(
        finalized.env.current.state.game.bestMove.selectedSeats,
        [7, 7].slice(0, count),
      );
      assert.equal(
        finalized.env.current.state.game.bestMove.completionReason,
        count === 0 ? "declined" : "finished-early",
      );
      await page.reload({ waitUntil: "networkidle" });
      const beforeUndo = await settled(page, api);
      replay(beforeUndo.current.state);
      assert.equal(beforeUndo.current.state.headEventId, finalized.env.current.state.headEventId);
      await undo(page);
      const undone = await settled(page, api);
      replay(undone.current.state);
      assert.equal(undone.current.state.game.phase, "best-move");
      assert.equal(undone.current.state.game.bestMove.completionReason, undefined);
      assert.deepEqual(undone.current.state.game.bestMove.selectedSeats, [7, 7].slice(0, count));
      await page
        .getByRole("checkbox", {
          name: "Numbers read back and accepted; player sleeps",
          exact: true,
        })
        .check();
      await page.getByRole("button", { name: finishName, exact: true }).click();
      await page.getByRole("button", { name: "Announce morning", exact: true }).click();
      const morning = await saveReplay(page, api, `best-${count}-morning`, width, height);
      assert.equal(morning.env.current.state.game.phase, "goodbye-speech");
      assert.equal(morning.env.current.state.game.day, 2);
      assert.equal(morning.env.current.state.game.completedGameNights, 2);
      assert.equal(morning.env.current.state.game.sheriffChecksPerformed, 1);
      await page.reload({ waitUntil: "networkidle" });
      const restored = await settled(page, api);
      assert.equal(restored.current.state.headEventId, morning.env.current.state.headEventId);
      assert.equal(hashGameState(restored.current.state.game), morning.proof.hash);
      replay(restored.current.state);
      row.scenarios.push({
        name: `first-kill-best-move-${count === 0 ? "skip" : "partial-finish"}-undo-reload-morning`,
        ...morning.proof,
      });
      row.screenshots.push(await capture(page, `best-${count}-morning`, width, height));
    }

    api.clean();
    assert.equal(row.scenarios.length, 7);
    assert.deepEqual(row.geometryFailures, [], "No primary-control overflow");
    console.log(
      `Federation integrated UI ${width}x${height}: PASS (${row.scenarios.length} scenarios)`,
    );
    report.sourceAfter = await sourceHashes();
    report.sourceStable =
      JSON.stringify(report.sourceBefore) === JSON.stringify(report.sourceAfter);
    assert.equal(
      report.sourceStable,
      true,
      "Production sources changed during browser qualification; rerun against a stable candidate",
    );
    report.status = "PASS";
  } catch (error) {
    report.status = "FAIL";
    report.error = error.stack;
    report.failureEnvelope = await read(page).catch(() => null);
    report.sourceAfter = await sourceHashes();
    if (!page.isClosed()) {
      await page
        .screenshot({ path: path.join(evidence, "failure.png"), animations: "disabled" })
        .catch(() => {});
      report.failureBody = await page
        .locator("body")
        .innerText()
        .catch(() => "");
    }
    throw error;
  } finally {
    await writeFile(path.join(evidence, "results.json"), JSON.stringify(report, null, 2));
  }
}
