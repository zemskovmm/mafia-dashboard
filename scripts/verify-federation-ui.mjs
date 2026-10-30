/* global URL, document, navigator, innerWidth, innerHeight, localStorage, getComputedStyle, requestAnimationFrame, performance */
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
export const currentSetupState = () => ({
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
export const envelope = (clubId, gameId, state) => ({
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
  "apps/web/src/features/night/NightShootingObservation.tsx",
  "apps/web/src/i18n/messages/night.ts",
  "apps/web/src/i18n/messages/federation-best-move.ts",
  "apps/web/src/i18n/messages/federation-history.ts",
  "scripts/verify-federation-ui.mjs",
  "apps/web/src/features/game/FederationBestMoveStage.tsx",
  "apps/web/src/features/voting/FederationBallot.tsx",
  "apps/web/src/features/voting/FederationBallotTools.tsx",
  "apps/web/src/features/voting/FederationBallot.css",
  "apps/web/src/features/game/federation-controls.css",
  "apps/web/src/features/setup/SetupWizard.css",
  "apps/web/src/features/table/GameTable.tsx",
  "apps/web/src/styles/app.css",
  "apps/web/src/i18n/messages/game.ts",
  "apps/web/src/i18n/messages/shell.ts",
  "packages/game-domain/src/game.ts",
  "packages/game-domain/src/game-events.ts",
  "packages/game-domain/src/federation-actions.ts",
  "packages/game-domain/src/federation-discipline.ts",
  "packages/game-domain/src/day-actions.ts",
  "packages/game-domain/src/types.ts",
  "apps/web/src/features/game/GameUtilityPanels.tsx",
  "apps/web/src/features/game/FederationDisciplineControls.tsx",
  "apps/web/src/features/game/FederationJudgeDialog.tsx",
  "apps/web/src/i18n/messages/federation-discipline.ts",
  "apps/web/src/features/game/AdjudicationControls.tsx",
  "apps/web/src/features/game/federation-ui-state.ts",
  "apps/web/src/features/voting/VotingStage.tsx",
  "apps/web/src/features/voting/FederationCollectiveBallot.tsx",
  "apps/web/src/features/timer/TimerControls.tsx",
  "apps/web/src/features/music/AccountPlaylistPicker.tsx",
  "packages/game-domain/src/night-actions.ts",
  "scripts/verify-ui.mjs",
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
    assert.equal(e.replayVersion, 3);
    assert.equal(Object.hasOwn(e, "rulesEdition"), false);
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
/** Actual retained upward penalty input using pointer or trusted Chromium touch. */
export async function openPlayerPenalty(page, seat, { locale = "en", input = "pointer" } = {}) {
  const card = page.locator(`.seat-anchor[data-seat="${seat}"] .player-seat`);
  await expect(card).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  const inputTrace = [];
  const traceBinding = `penaltyInput${randomUUID().replaceAll("-", "")}`;
  await page.exposeFunction(traceBinding, (event) => inputTrace.push(event));
  await card.evaluate((el, binding) => {
    for (const type of [
      "pointerdown",
      "pointerup",
      "pointercancel",
      "lostpointercapture",
      "touchstart",
      "touchend",
      "touchcancel",
    ])
      el.addEventListener(type, (event) =>
        globalThis[binding]({
          type,
          trusted: event.isTrusted,
          pointerType: event.pointerType,
          touches: event.touches?.length,
          x: event.changedTouches?.[0]?.clientX ?? event.clientX,
          y: event.changedTouches?.[0]?.clientY ?? event.clientY,
        }),
      );
  }, traceBinding);
  {
    const box = await card.boundingBox();
    assert.ok(box, "Penalty target must be painted");
    const x = box.x + box.width / 2;
    const y = box.y + box.height - 8;
    const to = { x, y: y - 72 };
    if (input === "touch") {
      assert.equal(page.context().browser().browserType().name(), "chromium");
      const cdp = await page.context().newCDPSession(page);
      try {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x, y, id: 1 }],
        });
        for (let step = 1; step <= 8; step++)
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [
              { x: x + ((to.x - x) * step) / 8, y: y + ((to.y - y) * step) / 8, id: 1 },
            ],
          });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } finally {
        await cdp.detach();
      }
    } else {
      assert.equal(input, "pointer");
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 8 });
      await page.mouse.up();
    }
  }
  const dialog = page.locator("dialog.federation-judge-dialog.is-discipline[open]");
  try {
    await expect(dialog).toBeVisible();
  } catch (error) {
    console.error(`Penalty input ${input} seat ${seat} trace: ${JSON.stringify(inputTrace)}`);
    throw error;
  }
  await expect(
    dialog.getByRole("combobox", {
      name: locale === "en" ? "Discipline action" : "Дисциплинарное действие",
      exact: true,
    }),
  ).toHaveValue("removal");
  return { dialog, card };
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
    nativeDialogCases: [],
    horizontalInputs: [],
    scenarios: [],
    screenshots: [],
  };
  const row = report;
  async function horizontalInert(seat, label) {
    const card = page.locator(`.seat-anchor[data-seat="${seat}"] .player-seat`);
    await card.scrollIntoViewIfNeeded();
    const before = (await settled(page, api)).current.state;
    for (const input of page.context().browser().browserType().name() === "chromium"
      ? ["pointer", "touch"]
      : ["pointer"]) {
      const cdp = input === "touch" ? await page.context().newCDPSession(page) : null;
      try {
        for (const dx of [-70, 70]) {
          await card.evaluate((el) => {
            el.dataset.horizontalTrace = "[]";
            if (el.dataset.horizontalTraceInstalled) return;
            el.dataset.horizontalTraceInstalled = "yes";
            for (const type of [
              "pointerdown",
              "pointerup",
              "pointercancel",
              "touchstart",
              "touchend",
              "click",
            ])
              el.addEventListener(type, (event) => {
                const trace = JSON.parse(el.dataset.horizontalTrace);
                trace.push({ type, trusted: event.isTrusted, pointerType: event.pointerType });
                el.dataset.horizontalTrace = JSON.stringify(trace);
              });
          });
          const box = await card.boundingBox();
          assert.ok(box);
          const x = box.x + box.width / 2,
            y = box.y + box.height / 2;
          if (cdp) {
            await cdp.send("Input.dispatchTouchEvent", {
              type: "touchStart",
              touchPoints: [{ x, y, id: 1 }],
            });
            for (let n = 1; n <= 6; n++)
              await cdp.send("Input.dispatchTouchEvent", {
                type: "touchMove",
                touchPoints: [{ x: x + (dx * n) / 6, y, id: 1 }],
              });
            await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          } else {
            await page.mouse.move(x, y);
            await page.mouse.down();
            await page.mouse.move(x + dx, y, { steps: 6 });
            await page.mouse.up();
          }
          await expect(
            page.locator(".table-swipe-menu, .table-swipe-backdrop, dialog[open]"),
          ).toHaveCount(0);
          const after = (await settled(page, api)).current.state;
          assert.equal(
            after.headEventId,
            before.headEventId,
            `${label}: horizontal drag emitted an accepted action`,
          );
          assert.deepEqual(after.game, before.game, `${label}: horizontal drag mutated gameplay`);
          const trace = JSON.parse(await card.getAttribute("data-horizontal-trace"));
          assert.ok(trace.some((e) => e.type === "pointerdown" && e.trusted));
          if (cdp) assert.ok(trace.some((e) => e.type === "touchstart" && e.trusted));
          row.horizontalInputs.push({
            label,
            input,
            dx,
            start: { x, y },
            end: { x: x + dx, y },
            trace,
          });
        }
      } finally {
        await cdp?.detach();
      }
    }
  }
  async function expectReturn(card, label) {
    await expect(page.locator("dialog.federation-judge-dialog[open]")).toHaveCount(0);
    await expect(card).toBeVisible();
    row.nativeDialogCases.push({
      label,
      closed: true,
      connectedTarget: true,
      forcedReturnFocus: "retired",
    });
  }
  const activeTransitions = [];
  report.activeTransitions = activeTransitions;
  const checkActiveTransition = async (trigger, { reverse = false, reduced = false } = {}) => {
    const frames = await trigger.evaluate(
      async (button, { reverse }) => {
        const cards = [...document.querySelectorAll(".table-stage .player-seat")];
        const read = () =>
          cards.map((card) => {
            const style = getComputedStyle(card);
            const light = card.querySelector(".active-player-lighting");
            const anchor = card.closest(".seat-anchor").getBoundingClientRect();
            return {
              seat: card.closest(".seat-anchor").getAttribute("data-seat"),
              active: card.classList.contains("is-current"),
              voted: card.classList.contains("is-voted"),
              scale: style.scale === "none" ? 1 : Number(style.scale),
              light: Number(getComputedStyle(light).opacity),
              center: [anchor.x + anchor.width / 2, anchor.y + anchor.height / 2],
            };
          });
        const frames = [read()];
        button.click();
        const start = performance.now();
        let reversed = false;
        do {
          await new Promise(requestAnimationFrame);
          frames.push(read());
          if (reverse && !reversed && performance.now() - start >= 100) {
            button.click();
            reversed = true;
          }
        } while (performance.now() - start < 550);
        return frames;
      },
      { reverse },
    );
    const first = frames[0],
      last = frames.at(-1);
    const changed = first.flatMap((before, index) => {
      const samples = frames.map((frame) => frame[index]);
      if (!samples.some((sample) => sample.active !== before.active)) return [];
      if (!reduced) {
        assert.ok(
          samples.some((s) => s.scale > 0.88 && s.scale < 1.2 && s.scale !== 1),
          `Seat ${before.seat}: intermediate size, not a snap`,
        );
        assert.ok(
          samples.some((s) => s.light > 0 && s.light < 1),
          `Seat ${before.seat}: intermediate light on entry/exit`,
        );
      } else {
        assert.ok(
          samples.every((s) => s.light === 0 || s.light === 1),
          "Reduced motion is immediate",
        );
      }
      return [
        {
          seat: before.seat,
          from: before.scale,
          to: last[index].scale,
          intermediateLight: samples.some((s) => s.light > 0 && s.light < 1),
        },
      ];
    });
    assert.ok(changed.length > 0, "The real UI action changes active emphasis");
    for (const frame of frames)
      for (const [index, card] of frame.entries())
        assert.deepEqual(
          card.center,
          first[index].center,
          "Seat anchors never move during emphasis",
        );
    for (const card of last) {
      assert.equal(card.scale, card.active ? 1.2 : card.voted ? 0.88 : 1);
      assert.equal(card.light, card.active ? 1 : 0);
    }
    activeTransitions.push({ reverse, reduced, frames: frames.length, changed });
  };
  const cardPresentation = async (card) => {
    await card.evaluate(async (element) => {
      await Promise.all(
        element
          .getAnimations({ subtree: true })
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
    return card.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        scale: style.scale === "none" ? 1 : Number(style.scale),
        opacity: Number(style.opacity),
        transition: style.transitionProperty,
        animation: style.animationName,
        width: element.getBoundingClientRect().width,
      };
    });
  };
  async function enter(page) {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    assertExactOrigin(page.url(), origin);
    const card = page.locator(".club-card-open");
    await expect(page.locator(".club-card-open, .app-shell, .players-shell").first()).toBeVisible();
    if (await card.first().isVisible()) await card.first().click();
  }
  async function freshSetup(page) {
    await enter(page);
    const heading = page.getByRole("heading", { name: "Select players", exact: true });
    await expect(heading.or(page.locator(".players-shell"))).toBeVisible();
    if (!(await heading.isVisible())) {
      await expect(page.locator(".players-shell")).toBeVisible();
      await page.getByRole("button", { name: "Back to game", exact: true }).click();
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
  async function assertTableCorners(page) {
    const corners = await page.locator(".table-stage").evaluate((stage) => {
      const radii = (element) => {
        const style = getComputedStyle(element);
        return [
          style.borderTopLeftRadius,
          style.borderTopRightRadius,
          style.borderBottomRightRadius,
          style.borderBottomLeftRadius,
        ];
      };
      return {
        card: radii(stage.querySelector(".table-card")),
        buttons: [...stage.querySelectorAll("button")]
          .filter((button) => button.getClientRects().length > 0)
          .map((button) => {
            const group = button.parentElement;
            const joined = group.classList.contains("seat-actions") && group.children.length > 1;
            return {
              label: button.getAttribute("aria-label") ?? button.textContent.trim(),
              radii: radii(button),
              joined,
              vertical: joined && getComputedStyle(group).flexDirection === "column",
              first: button === group.firstElementChild,
              last: button === group.lastElementChild,
            };
          }),
      };
    });
    assert.ok(corners.buttons.length > 0, "Table controls must be present");
    assert.equal(new Set(corners.card).size, 1, "Card corners must be uniform");
    for (const button of corners.buttons) {
      const r = corners.card[0];
      const expected = !button.joined
        ? corners.card
        : button.vertical
          ? [
              button.first ? r : "0px",
              button.first ? r : "0px",
              button.last ? r : "0px",
              button.last ? r : "0px",
            ]
          : [
              button.first ? r : "0px",
              button.last ? r : "0px",
              button.last ? r : "0px",
              button.first ? r : "0px",
            ];
      assert.deepEqual(button.radii, expected, `Table corners: ${button.label}`);
    }
  }
  async function draw(page) {
    await page.getByRole("button", { name: "Start game", exact: true }).click();
    await expect(page.locator(".game-header")).not.toContainText("MAFGAME");
    await expect(page.locator(".game-header .phase-banner")).toHaveCount(0);
    await expect(page.locator(".table-center")).toContainText("10 remaining");
    for (let i = 0; i < 10; i++)
      await page
        .getByRole("button", { name: /^Draw role for / })
        .first()
        .click();
    await assertTableCorners(page);
    await expect(page.locator(".table-center")).toContainText("All roles assigned");
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
    await assertTableCorners(page);
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
      label === "fresh-day" ||
      label.startsWith("ballot-") ||
      label.startsWith("current-voters")
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
  async function swipeUp(seat) {
    const { dialog } = await openPlayerPenalty(page, seat, {
      input:
        process.env.UI_FEDERATION_GESTURE_INPUT ??
        (page.context().browser().browserType().name() === "chromium" ? "touch" : "pointer"),
    });
    await expect(
      dialog.getByRole("combobox", { name: "Occurrence timing", exact: true }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "Choose a rule to read", exact: true }),
    ).toBeDisabled();
    const geometry = await dialog.boundingBox();
    assert.ok(
      geometry.x >= 0 &&
        geometry.y >= 0 &&
        geometry.x + geometry.width <= width + 1 &&
        geometry.y + geometry.height <= height + 1,
      "Penalty dialog bounded by viewport",
    );
    return dialog;
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
    assert.equal(Object.hasOwn(selected.current.state.setup, "rulesEdition"), false);
    await draw(page);
    const planning = await settled(page, api);
    assert.equal(planning.current.state.initialGame.replayVersion, 3);
    assert.equal(Object.hasOwn(planning.current.state.game, "rulesEdition"), false);
    await expect(page.locator(".game-header")).not.toContainText("MAFGAME");
    await assertTableCorners(page);
    await page.getByRole("button", { name: "Mafia asleep", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Night one · Sheriff greeting", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".table-center")).toContainText(
      "Give them 10 seconds to look around the table and greet the host",
    );
    await assertTableCorners(page);
    row.screenshots.push(await capture(page, "sheriff-greeting", width, height));
    const greeting = await settled(page, api);
    const sheriff = greeting.current.state.game.players.find((player) => player.role === "sheriff");
    await expect(
      page.locator(`.seat-anchor[data-seat="${sheriff.seat}"] .player-seat`),
    ).toHaveClass(/is-sheriff-highlight/);
    assert.equal(
      await page
        .locator(".is-sheriff-highlight")
        .evaluate((card) => getComputedStyle(card).borderColor),
      "rgb(103, 183, 255)",
    );
    replay(greeting.current.state);
    await page.reload({ waitUntil: "networkidle" });
    assert.equal((await settled(page, api)).current.state.game.phase, "sheriff-identification");
    const openingLanguage = club.language;
    try {
      club.language = "ru";
      await page.reload({ waitUntil: "networkidle" });
      await expect(
        page.getByRole("heading", { name: "Первая ночь · приветствие Шерифа", exact: true }),
      ).toBeVisible();
      await expect(page.locator(".table-center")).toContainText("Дайте ему 10 секунд");
      await expect(page.locator(".game-header")).not.toContainText("MAFGAME");
      row.screenshots.push(await capture(page, "sheriff-greeting-ru", width, height));
    } finally {
      club.language = openingLanguage;
    }
    await page.reload({ waitUntil: "networkidle" });
    await settled(page, api);
    await undo(page);
    assert.equal((await settled(page, api)).current.state.game.phase, "mafia-planning");
    await page.getByRole("button", { name: "Mafia asleep", exact: true }).click();
    await settled(page, api);
    await page.getByRole("button", { name: "Begin round zero", exact: true }).click();
    const fresh = await saveReplay(page, api, "fresh-opening", width, height);
    await expect(page.locator(".is-sheriff-highlight")).toHaveCount(0);
    assert.equal(fresh.env.current.state.game.phase, "day");
    assert.equal(fresh.env.current.state.game.completedGameNights, 1);
    assert.equal(fresh.env.current.state.game.sheriffChecksPerformed, 0);
    assert.deepEqual(
      branch(fresh.env.current.state)
        .slice(1)
        .map((e) => e.payload.to),
      ["sheriff-identification", "day"],
    );
    await assertTableCorners(page);
    row.scenarios.push({ name: "fresh-v2-short-opening-greeting-reload", ...fresh.proof });
    await expect(page.getByRole("region", { name: "Voting order", exact: true })).toHaveCount(0);
    row.screenshots.push(await capture(page, "fresh-day", width, height));
    const speakerStyle = await cardPresentation(page.locator(".player-seat.is-current"));
    await checkActiveTransition(page.getByRole("button", { name: "Next player", exact: true }));
    const template = fresh.env.current.state,
      day = clone(template.game);

    const beforeControls = (await settled(page, api)).current.state.headEventId;
    const timer = page.locator(".timer-display");
    await page.getByRole("button", { name: "Start 60 second timer", exact: true }).tap();
    await timer.tap();
    await expect(timer).toHaveAttribute("aria-label", "Resume timer");
    await page.getByRole("button", { name: "Start 30 second timer", exact: true }).tap();
    await timer.tap();
    await timer.tap();
    await expect(timer.locator("strong")).toHaveText("00");
    await expect(timer).toBeDisabled();
    await page.getByRole("button", { name: "Start 20 second timer", exact: true }).tap();
    await expect(timer).toHaveAttribute("aria-label", "Pause timer");
    await timer.tap();
    const handle = page.locator(".music-panel-handle");
    await handle.click();
    const playlists = page.getByRole("combobox", { name: "YouTube Music playlist", exact: true });
    await expect(playlists.locator("option")).toHaveCount(5);
    const names = await playlists.locator("option").allTextContents();
    assert.ok(names.slice(1).every((name) => name.trim().toLowerCase().startsWith("mafia")));
    await playlists.selectOption("test-playlist");
    await handle.click();
    assert.equal((await settled(page, api)).current.state.headEventId, beforeControls);
    await page.addInitScript(() =>
      Object.defineProperty(navigator, "standalone", {
        configurable: true,
        get: () => window.sessionStorage.getItem("ui-standalone") === "1",
      }),
    );
    await page.evaluate(() => window.sessionStorage.setItem("ui-standalone", "1"));
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: /fullscreen/i })).toHaveCount(0);
    await page.evaluate(() => window.sessionStorage.removeItem("ui-standalone"));
    await page.reload({ waitUntil: "networkidle" });
    await settled(page, api);
    row.scenarios.push({
      name: "timer-touch-reset-mafia-playlists-standalone-simulation",
      names,
      physicalIPad: false,
    });

    const penaltySeat = day.players.find((p) => p.role === "citizen").seat;
    for (const game of [greeting.current.state.game, day]) {
      const id = randomUUID();
      await seed(page, api, checkpoint(game, template, id), id);
      await horizontalInert(penaltySeat, game.phase);
      const before = await settled(page, api);
      const dialog = await swipeUp(penaltySeat);
      assert.equal(
        (await read(page)).current.state.headEventId,
        before.current.state.headEventId,
        "Swipe emits no incidental action",
      );
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      assert.equal(
        (await read(page)).current.state.headEventId,
        before.current.state.headEventId,
        "Dismiss emits no event",
      );
    }
    // Browser-owned cancellation must suppress both canonical actions and trailing clicks.
    const gestureCard = page.locator(`.seat-anchor[data-seat="${penaltySeat}"] .player-seat`);
    const gestureBefore = (await settled(page, api)).current.state;
    await gestureCard.evaluate((card) =>
      card.addEventListener(
        "pointerdown",
        (event) => {
          card.dataset.verifierPointer = String(event.pointerId);
        },
        { once: true },
      ),
    );
    const gestureBox = await gestureCard.boundingBox();
    const gestureX = gestureBox.x + gestureBox.width / 2;
    const gestureY = gestureBox.y + 8;
    await page.mouse.move(gestureX, gestureY);
    await page.mouse.down();
    await page.mouse.move(gestureX, gestureY + 72, { steps: 8 });
    await gestureCard.evaluate((card) => {
      const id = Number(card.dataset.verifierPointer);
      if (card.hasPointerCapture(id)) card.releasePointerCapture(id);
      delete card.dataset.verifierPointer;
    });
    await page.mouse.up();
    assert.equal(
      (await read(page)).current.state.headEventId,
      gestureBefore.headEventId,
      "Lost capture emits no event or compatibility click",
    );
    if (page.context().browser().browserType().name() === "chromium") {
      const cdp = await page.context().newCDPSession(page);
      try {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x: gestureX, y: gestureY, id: 31 }],
        });
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: gestureX, y: gestureY + 72, id: 31 }],
        });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
      } finally {
        await cdp.detach();
      }
      assert.equal(
        (await read(page)).current.state.headEventId,
        gestureBefore.headEventId,
        "Touch cancel emits no event or compatibility click",
      );
    }
    await page.mouse.move(gestureX, gestureY);
    await page.mouse.down();
    await page.mouse.move(gestureX, gestureY + 72, { steps: 8 });
    await page.mouse.up();
    const downward = await saveReplay(page, api, "downward-foul-after-cancel", width, height);
    assert.equal(downward.env.current.state.events.at(-1).type, "foul.issued");
    assert.equal(
      downward.env.current.state.game.players.find((p) => p.seat === penaltySeat).fouls,
      gestureBefore.game.players.find((p) => p.seat === penaltySeat).fouls + 1,
    );
    const afterFoul = downward.env.current.state.headEventId;
    const freshPenalty = await swipeUp(penaltySeat);
    await page.keyboard.press("Escape");
    await expect(freshPenalty).toBeHidden();
    assert.equal(
      (await read(page)).current.state.headEventId,
      afterFoul,
      "Fresh upward menu cancellation emits no incidental event",
    );
    row.nativeGestures = {
      lostCapture: "PASS",
      touchCancel:
        page.context().browser().browserType().name() === "chromium"
          ? "PASS"
          : "not available: Chromium CDP only",
      freshDownwardFoul: "PASS",
      freshUpwardNativeEscape: "PASS",
    };
    row.scenarios.push({
      name: "opening-and-day-swipe-without-incidental-action",
      input:
        (process.env.UI_FEDERATION_GESTURE_INPUT ??
          (page.context().browser().browserType().name() === "chromium" ? "touch" : "pointer")) ===
        "touch"
          ? "trusted CDP touch"
          : "trusted Playwright pointer drag",
    });

    const dayPenaltyId = randomUUID();
    await seed(page, api, checkpoint(day, template, dayPenaltyId), dayPenaltyId);
    const beforeDayPenalty = await settled(page, api);
    const dayPenalty = await swipeUp(penaltySeat);
    await dayPenalty
      .getByRole("combobox", { name: "Removal rule", exact: true })
      .selectOption("6.2.3");
    await dayPenalty.getByRole("button", { name: "Confirm discipline", exact: true }).click();
    const dayRemoved = await saveReplay(page, api, "day-penalty-no-announcement", width, height);
    assert.equal(branch(dayRemoved.env.current.state).at(-1).type, "discipline.removal-observed");
    assert.equal(
      branch(dayRemoved.env.current.state).length,
      branch(beforeDayPenalty.current.state).length + 1,
    );
    await expect(page.getByRole("button", { name: /Announce removal/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Next player", exact: true })).toBeEnabled();
    row.screenshots.push(await capture(page, "day-penalty-no-announcement", width, height));
    await page.reload({ waitUntil: "networkidle" });
    assert.deepEqual(
      (await settled(page, api)).current.state.game,
      dayRemoved.env.current.state.game,
    );
    await page.getByRole("button", { name: "Next player", exact: true }).click();
    const continuedDay = await settled(page, api);
    assert.equal(branch(continuedDay.current.state).at(-1).type, "turn.completed");
    await undo(page);
    assert.deepEqual(
      (await settled(page, api)).current.state.game,
      dayRemoved.env.current.state.game,
    );
    await undo(page);
    const undoneDayPenalty = await settled(page, api);
    assert.equal(
      undoneDayPenalty.current.state.headEventId,
      beforeDayPenalty.current.state.headEventId,
    );
    assert.deepEqual(undoneDayPenalty.current.state.game, beforeDayPenalty.current.state.game);
    replay(undoneDayPenalty.current.state);
    row.scenarios.push({ name: "day-penalty-continue-reload-single-action-undo-no-announcement" });

    for (const subject of ["victim", "shooter"]) {
      const id = randomUUID();
      await seed(page, api, checkpoint(beginNight(day), template, id), id);
      await page
        .getByRole("button", {
          name: `Assign all Mafia shots to ${display(day, penaltySeat)}`,
          exact: true,
        })
        .click();
      await page.getByRole("button", { name: "Evaluate Mafia shots", exact: true }).click();
      const resolved = await settled(page, api);
      const seat =
        subject === "victim" ? penaltySeat : day.players.find((p) => p.role === "don").seat;
      const dialog = await swipeUp(seat);
      await dialog
        .getByRole("combobox", { name: "Removal rule", exact: true })
        .selectOption("6.2.3");
      await dialog.screenshot({
        path: path.join(evidence, `${width}x${height}-penalty-${subject}.png`),
      });
      await dialog.getByRole("button", { name: "Confirm discipline", exact: true }).click();
      const removed = await saveReplay(page, api, `post-result-${subject}`, width, height);
      assert.deepEqual(
        removed.env.current.state.game.nightResult,
        resolved.current.state.game.nightResult,
      );
      assert.deepEqual(
        removed.env.current.state.game.shotAssignments,
        resolved.current.state.game.shotAssignments,
      );
      assert.equal(
        removed.env.current.state.game.disciplinaryRemovals.at(-1).stage,
        "after-shooting-result",
      );
      await expect(page.getByRole("button", { name: "Continue night", exact: true })).toBeEnabled();
      await expect(page.getByRole("button", { name: /Announce removal/ })).toHaveCount(0);
      assert.equal(
        branch(removed.env.current.state).filter((e) => e.type === "discipline.removals-announced")
          .length,
        0,
      );
      await page.reload({ waitUntil: "networkidle" });
      assert.equal(
        (await settled(page, api)).current.state.headEventId,
        removed.env.current.state.headEventId,
      );
      await expect(page.getByRole("button", { name: /Announce removal/ })).toHaveCount(0);
      await page.getByRole("button", { name: "Continue night", exact: true }).click();
      replay((await settled(page, api)).current.state);
      await undo(page);
      const beforeContinuation = await settled(page, api);
      assert.equal(
        beforeContinuation.current.state.headEventId,
        removed.env.current.state.headEventId,
      );
      assert.deepEqual(beforeContinuation.current.state.game, removed.env.current.state.game);
      await undo(page);
      const beforePenalty = await settled(page, api);
      assert.equal(beforePenalty.current.state.headEventId, resolved.current.state.headEventId);
      assert.deepEqual(beforePenalty.current.state.game, resolved.current.state.game);
      replay(beforePenalty.current.state);
    }
    row.scenarios.push({ name: "post-result-victim-shooter-swipe-save-reload-replay" });

    // Resume a current canonical setup; reload retains the selector-free representation.
    await seed(page, api, currentSetupState());
    await freshSetup(page);
    await draw(page);
    const restored = await settled(page, api);
    assert.equal(restored.current.state.initialGame.replayVersion, 3);
    assert.equal(restored.current.state.game.rulesEdition, undefined);
    replay(restored.current.state);
    await page.reload({ waitUntil: "networkidle" });
    const restoredReload = await settled(page, api);
    assert.equal(restoredReload.current.state.initialGame.replayVersion, 3);
    row.scenarios.push({
      name: "current-setup-resume-v3",
      ...replay(restoredReload.current.state),
    });

    let ballot = clone(day);
    ballot = nominate(ballot, ballot.turnOrder[0], 4);
    ballot = completeCurrentTurn(ballot);
    ballot = nominate(ballot, ballot.turnOrder[ballot.currentTurnIndex], 5);
    while (ballot.phase === "day") ballot = completeCurrentTurn(ballot);
    assert.equal(ballot.phase, "voting", "Completed nominated day opens ballot");
    const ballotId = randomUUID();
    await seed(page, api, checkpoint(ballot, template, ballotId), ballotId);
    await expect(page.getByRole("button", { name: /^Vote as / }).first()).toBeEnabled();
    await horizontalInert(1, "current-ballot");
    await expect(
      page.getByRole("button", { name: /Announce full order|Mention candidate|STOP/ }),
    ).toHaveCount(0);
    await expect(page.getByText("Judge-private nomination list.", { exact: false })).toHaveCount(0);
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
    const order = page.getByRole("region", { name: "Voting order", exact: true });
    const voted = page.locator('.seat-anchor[data-seat="1"] .player-seat');
    await expect(voted).toHaveClass(/is-voted/);
    await expect(voted).toHaveClass(/is-current/);
    await expect(voted).not.toHaveAttribute("aria-current");
    const progressStyle = await cardPresentation(voted);
    assert.equal(progressStyle.scale, 1.2, "Current voters grow to 120%");
    assert.equal(progressStyle.opacity, 1, "Current voters do not fade");
    assert.equal(progressStyle.scale, speakerStyle.scale);
    assert.equal(progressStyle.opacity, speakerStyle.opacity);
    assert.equal(progressStyle.animation, speakerStyle.animation);
    assert.ok(
      progressStyle.transition.includes("scale") && progressStyle.transition.includes("opacity"),
    );
    const unvotedStyle = await cardPresentation(
      page.locator('.seat-anchor[data-seat="4"] .player-seat'),
    );
    assert.equal(unvotedStyle.scale, 1);
    assert.equal(unvotedStyle.opacity, 1);
    row.screenshots.push(await capture(page, "current-voters-first", width, height));
    const nextBox = await page
      .getByRole("button", { name: "Next candidate", exact: true })
      .boundingBox();
    const finishBox = await page
      .getByRole("button", { name: "Finish voting", exact: true })
      .boundingBox();
    assert.ok(
      finishBox.y - (nextBox.y + nextBox.height) >= 11,
      "Separate voting actions by at least the card-action gap",
    );
    const lastRow = order.getByRole("button", { name: `#5 ${display(day, 5)}`, exact: true });
    const hitBox = await lastRow.boundingBox();
    const rowBox = await lastRow.locator("..").boundingBox();
    assert.ok(Math.abs(hitBox.width - rowBox.width) < 3, "Whole row is the touch target");
    await page.touchscreen.tap(hitBox.x + hitBox.width - 6, hitBox.y + hitBox.height / 2);
    await expect(voted).not.toHaveClass(/is-current/);
    const priorStyle = await cardPresentation(voted);
    assert.equal(priorStyle.scale, 0.88, "Other candidate voters retain their smaller appearance");
    assert.equal(
      priorStyle.opacity,
      0.55,
      "Other candidate voters retain their subdued appearance",
    );
    const current = page.locator('.seat-anchor[data-seat="4"] .player-seat');
    await expect(current).toHaveClass(/is-current/);
    const currentStyle = await cardPresentation(current);
    assert.equal(currentStyle.scale, 1.2);
    assert.equal(currentStyle.opacity, 1);
    assert.ok(
      currentStyle.width > priorStyle.width,
      "Current voters are visibly larger than prior voters",
    );
    row.screenshots.push(await capture(page, "current-voters-second", width, height));
    const beforeMasking = (await settled(page, api)).current.state.game.voteAssignments;
    await page.getByRole("button", { name: "Hide private info", exact: true }).click();
    await expect(page.locator(".player-seat .role-badge")).toHaveCount(0);
    assert.equal((await cardPresentation(current)).opacity, 1);
    assert.equal((await cardPresentation(voted)).opacity, 0.55);
    const firstRow = order.getByRole("button", { name: `#4 ${display(day, 4)}`, exact: true });
    await checkActiveTransition(firstRow);
    await checkActiveTransition(lastRow);
    await checkActiveTransition(current, { reverse: true });
    await checkActiveTransition(current);
    await checkActiveTransition(current);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await checkActiveTransition(firstRow, { reduced: true });
    await checkActiveTransition(lastRow, { reduced: true });
    assert.equal((await cardPresentation(current)).scale, 1.2);
    assert.equal((await cardPresentation(voted)).scale, 0.88);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.getByRole("button", { name: "Show private info", exact: true }).click();
    assert.deepEqual((await settled(page, api)).current.state.game.voteAssignments, beforeMasking);
    const developerMenu = page.getByRole("button", { name: "Open developer menu", exact: true });
    if (!(await developerMenu.isVisible())) {
      const privacy = page.getByRole("button", { name: /^(Hide|Show) private info$/ });
      for (let tap = 0; tap < 5; tap++) await privacy.dispatchEvent("click");
    }
    await developerMenu.click();
    await page.locator(".dev-glass-controls:not(.player-exit-controls) > summary").click();
    const disableGlass = page.getByRole("button", { name: "Disable enhanced glass", exact: true });
    if (await disableGlass.isVisible()) await disableGlass.click();
    await page.getByRole("button", { name: "Enable enhanced glass", exact: true }).click();
    await expect(page.locator(".app-shell")).toHaveAttribute("data-glass-status", "ready");
    await page.getByRole("button", { name: "Close developer menu", exact: true }).click();
    assert.equal((await cardPresentation(current)).scale, 1.2);
    assert.equal((await cardPresentation(current)).opacity, 1);
    assert.equal((await cardPresentation(voted)).scale, 0.88);
    assert.equal((await cardPresentation(voted)).opacity, 0.55);
    row.screenshots.push(await capture(page, "current-voters-glass", width, height));
    await checkActiveTransition(firstRow);
    await checkActiveTransition(lastRow);
    await developerMenu.click();
    await page.locator(".dev-glass-controls:not(.player-exit-controls) > summary").click();
    await page.getByRole("button", { name: "Disable enhanced glass", exact: true }).click();
    await page.getByRole("button", { name: "Close developer menu", exact: true }).click();
    assert.deepEqual((await settled(page, api)).current.state.game.voteAssignments, beforeMasking);
    const clearVote = page.getByRole("button", {
      name: `${display(day, 10)} voted for seat 5`,
      exact: true,
    });
    if (process.env.UI_FEDERATION_GESTURE_INPUT === "pointer") await clearVote.click();
    else await clearVote.tap();
    const corrected = await settled(page, api);
    assert.equal(corrected.current.state.game.voteAssignments[10], undefined);
    await expect(page.locator('.seat-anchor[data-seat="10"] .player-seat')).not.toHaveClass(
      /is-voted/,
    );
    await page.reload({ waitUntil: "networkidle" });
    const restoredCorrection = await settled(page, api);
    assert.deepEqual(
      restoredCorrection.current.state.game.voteAssignments,
      corrected.current.state.game.voteAssignments,
    );
    replay(restoredCorrection.current.state);
    await order.getByRole("button", { name: `#4 ${display(day, 4)}`, exact: true }).focus();
    await page.keyboard.press("Space");
    assert.equal((await settled(page, api)).current.state.game.ballot.selectedCandidateSeat, 4);
    await expect(voted).toHaveClass(/is-current/);
    assert.equal((await cardPresentation(voted)).scale, 1.2);
    assert.equal((await cardPresentation(voted)).opacity, 1);
    assert.equal((await cardPresentation(current)).scale, 0.88);
    await page.mouse.move(0, 0);
    await page.locator(".table-stage").evaluate(async (stage) => {
      await Promise.all(
        stage
          .getAnimations({ subtree: true })
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
    const stopBeforeTools = await page
      .getByRole("button", { name: "Next candidate", exact: true })
      .boundingBox();
    const reviewSeat = day.players[0].seat;
    const { card: toolsToggle } = await openPlayerPenalty(page, reviewSeat, {});
    await page.keyboard.press("Escape");
    await expectReturn(toolsToggle, "Native dialog Escape cancellation");
    const beforeRetiredKeys = (await read(page)).current.state.headEventId;
    await toolsToggle.focus();
    await page.keyboard.press("f");
    await page.keyboard.press("Shift+F10");
    await page.keyboard.press("ContextMenu");
    await expect(page.locator(".table-swipe-menu")).toHaveCount(0);
    await expect(page.locator("dialog.federation-judge-dialog[open]")).toHaveCount(0);
    assert.equal(
      (await read(page)).current.state.headEventId,
      beforeRetiredKeys,
      "Retired keys emit no event",
    );
    await openPlayerPenalty(page, reviewSeat, { input: "pointer" });
    const nativeSelect = page.getByRole("combobox", { name: "Discipline action", exact: true });
    const selectBefore = await nativeSelect.inputValue();
    // macOS native selects use typeahead; ArrowUp/Home alone do not commit.
    await nativeSelect.press("f");
    await nativeSelect.press("Enter");
    assert.equal(
      await nativeSelect.inputValue(),
      await nativeSelect.evaluate((select) => select.options[0].value),
      "Native select typeahead/Enter activation",
    );
    await nativeSelect.selectOption(selectBefore);
    await page.getByText("Dispute count", { exact: true }).click();
    await page
      .getByLabel("Dispute reason", { exact: true })
      .fill("Judge requests external recording review");
    await page.getByRole("button", { name: "Pause voting for review", exact: true }).click();
    await expect(page.getByRole("button", { name: "Next candidate", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: /^Vote as / }).first()).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Accept final reviewed count", exact: true }),
    ).toBeDisabled();
    row.screenshots.push(await capture(page, "ballot-dispute", width, height));
    const disputed = await settled(page, api);
    const sheet = page.locator("dialog.federation-judge-dialog.is-discipline[open]");
    const sheetBox = await sheet.boundingBox();
    assert.ok(
      sheetBox.x >= 0 && sheetBox.y >= 0 && sheetBox.y + sheetBox.height <= height + 1,
      "Review sheet bounded by viewport",
    );
    await sheet.getByRole("button", { name: "Close", exact: true }).click();
    await expectReturn(toolsToggle, "Disputed ballot full-menu dismissal");
    await expect(page.getByRole("button", { name: "Next candidate", exact: true })).toBeDisabled();
    assert.deepEqual(
      await page.getByRole("button", { name: "Next candidate", exact: true }).boundingBox(),
      stopBeforeTools,
      "Opening/scrolling review never moves the table controls",
    );
    row.screenshots.push(await capture(page, "ballot-dispute-table", width, height));
    await openPlayerPenalty(page, reviewSeat);
    await page
      .getByLabel("Final ruling reason", { exact: true })
      .fill("External recording confirms three accepted hands");
    await page
      .getByRole("checkbox", { name: "I reviewed the external recording", exact: true })
      .check();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expectReturn(toolsToggle, "Disputed ballot upward-menu dismissal");
    await openPlayerPenalty(page, reviewSeat);
    await expect(page.getByLabel("Final ruling reason", { exact: true })).toHaveValue(
      "External recording confirms three accepted hands",
    );
    await expect(
      page.getByRole("checkbox", { name: "I reviewed the external recording", exact: true }),
    ).toBeChecked();
    assert.equal(
      (await settled(page, api)).current.state.headEventId,
      disputed.current.state.headEventId,
    );
    await page.getByRole("button", { name: "Accept final reviewed count", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Accept final reviewed count", exact: true }),
    ).toHaveCount(0);
    await sheet.getByRole("button", { name: "Close", exact: true }).focus();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expectReturn(toolsToggle, "Native dialog Escape after acceptance");
    await page.getByRole("button", { name: "Next candidate", exact: true }).click();
    await expect(page.getByRole("button", { name: "Next candidate", exact: true })).toHaveCount(0);
    const accepted = await settled(page, api);
    replay(accepted.current.state);
    assert.deepEqual(
      accepted.current.state.game.voteAssignments,
      Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i + 1, i < 3 ? 4 : 5])),
    );
    row.screenshots.push(await capture(page, "ballot-ready", width, height));
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
    assert.equal(ballotUndo.current.state.game.ballot.stopped, false);
    assert.equal(ballotUndo.current.state.game.ballot.orderAnnouncements, 0);
    assert.equal(ballotUndo.current.state.game.ballot.hostRecording, true);
    await page.getByRole("button", { name: "Finish voting", exact: true }).click();
    const reruled = await saveReplay(page, api, "ballot-reaccepted", width, height);
    row.scenarios.push({
      name: "tap-correction-row-selection-dispute-auto-last-resolution-undo-reload",
      ...reruled.proof,
    });
    const previousLanguage = club.language;
    try {
      club.language = "ru";
      await seed(page, api, disputed.current.state, disputed.gameId);
      const { card: russianTools } = await openPlayerPenalty(page, reviewSeat, {
        locale: "ru",
      });
      await expect(
        page.getByRole("checkbox", { name: "Я просмотрел внешнюю запись", exact: true }),
      ).toBeVisible();
      row.screenshots.push(await capture(page, "ballot-dispute-ru", width, height));
      await page.getByRole("button", { name: "Закрыть", exact: true }).click();
      await expectReturn(russianTools, "Russian disputed ballot dismissal");
      row.screenshots.push(await capture(page, "ballot-dispute-table-ru", width, height));
    } finally {
      club.language = previousLanguage;
    }
    for (const locale of ["en", "ru"]) {
      try {
        club.language = locale;
        const id = randomUUID();
        await seed(page, api, checkpoint(day, template, id), id);
        const { dialog } = await openPlayerPenalty(page, penaltySeat, {
          locale,
        });
        await dialog
          .getByRole("combobox", {
            name: locale === "en" ? "Discipline action" : "Дисциплинарное действие",
            exact: true,
          })
          .selectOption("removal");
        const rule = dialog.getByRole("combobox", {
          name: locale === "en" ? "Removal rule" : "Пункт удаления",
          exact: true,
        });
        const options = await rule.locator("option").allTextContents();
        assert.equal(options.length, 14);
        for (const option of options.slice(1)) {
          const [number, description] = option.split(" · ");
          assert.match(number, /^6\.2\.(?:[1-9]|1[0-3])$/);
          assert.ok(description.trim().split(/\s+/).length <= 2);
        }
        await rule.selectOption("6.2.2");
        // Upward discipline derives timing from the actual displayed phase.
        await expect(
          dialog.getByRole("combobox", {
            name: locale === "en" ? "Occurrence timing" : "Момент нарушения",
            exact: true,
          }),
        ).toHaveCount(0);
        await page.screenshot({
          path: path.join(evidence, `${width}x${height}-discipline-${locale}.png`),
        });
        await dialog
          .getByRole("button", {
            name: locale === "en" ? "Confirm discipline" : "Подтвердить взыскание",
            exact: true,
          })
          .click();
        const removed = await saveReplay(page, api, `rule-only-removal-${locale}`, width, height);
        assert.equal(removed.env.current.state.game.disciplinaryRemovals[0].reason, "");
        await page.reload({ waitUntil: "networkidle" });
        replay((await settled(page, api)).current.state);
        row.scenarios.push({ name: `rule-only-removal-${locale}`, ...removed.proof });
      } finally {
        club.language = previousLanguage;
      }
    }
    // Untouched zero-support counts are explicitly finished, not fabricated no votes.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const id = randomUUID();
      const count = {
        ...clone(day),
        phase: "car-crash-decision",
        carCrashSeats: [1, 2],
        carCrashVotes: {},
      };
      await seed(page, api, checkpoint(count, template, id), id);
      const finish = page.getByRole("button", { name: "Resolve car crash", exact: true });
      await expect(finish).toBeEnabled();
      await finish.click();
      const completed = await saveReplay(page, api, `zero-support-count-${attempt}`, width, height);
      assert.equal(completed.env.current.state.game.carCrashResult.yesVotes, 0);
      assert.equal(completed.env.current.state.game.carCrashResult.eliminate, false);
      assert.deepEqual(completed.env.current.state.game.carCrashVotes, {});
      assert.equal(branch(completed.env.current.state).at(-1).type, "car-crash.count-completed");
      await page.reload({ waitUntil: "networkidle" });
      replay((await settled(page, api)).current.state);
      row.screenshots.push(await capture(page, `zero-support-count-${attempt}`, width, height));
      row.scenarios.push({ name: `zero-support-count-${attempt}-reload`, ...completed.proof });
    }

    const shotsId = randomUUID();
    await seed(page, api, checkpoint(beginNight(day), template, shotsId), shotsId);
    const target = day.players.find((p) => p.role === "citizen").seat;
    const shooter = day.players.find((p) => p.team === "black").seat;
    await page
      .getByRole("button", {
        name: `Assign all Mafia shots to ${display(day, target)}`,
        exact: true,
      })
      .click();
    const assigned = (await settled(page, api)).current.state.game.shotAssignments;
    const shotButton = (seat) =>
      page
        .locator(`.seat-anchor[data-seat="${seat}"] .shooter-button`)
        .filter({ hasText: new RegExp(`^#${shooter}$`) });
    const appearance = async (button) => {
      await page.mouse.move(0, 0);
      return button.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished));
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return {
          border: style.borderColor,
          shadow: style.boxShadow,
          background: style.backgroundColor,
          size: [bounds.width, bounds.height],
        };
      });
    };
    const observationMode = page.getByRole("button", {
      name: "Observed multiple shooting",
      exact: true,
    });
    const inactiveMode = await appearance(observationMode);
    const primaryShot = await appearance(shotButton(target));
    await expect(shotButton(target)).toHaveClass(/is-selected/);
    await expect(page.locator(".has-additional-shots")).toHaveCount(0);
    await observationMode.click();
    await expect(observationMode).toHaveAttribute("aria-pressed", "true");
    const activeMode = await appearance(observationMode);
    assert.notEqual(activeMode.shadow, inactiveMode.shadow, "Active recording has a visible glow");
    assert.notEqual(activeMode.shadow, "none");
    assert.notEqual(activeMode.border, inactiveMode.border);
    assert.deepEqual(activeMode.size, inactiveMode.size);
    await expect(page.locator(".federation-shooting-observation")).toHaveText(
      "Observed multiple shooting",
    );
    await expect(page.getByRole("dialog")).toHaveCount(0);
    assert.equal((await settled(page, api)).current.state.game.shotObservations, undefined);
    const extra = page.getByRole("button", {
      name: `Record observed shot by #${shooter} at ${display(day, target)}`,
      exact: true,
    });
    for (let i = 0; i < 4; i++) await extra.click();
    await observationMode.click();
    await expect(observationMode).toHaveAttribute("aria-pressed", "false");
    assert.equal((await appearance(observationMode)).shadow, inactiveMode.shadow);
    await expect(shotButton(target)).toHaveClass(/has-additional-shots/);
    await observationMode.click();
    const otherTarget = target === 9 ? 8 : 9;
    const unselectedShot = await appearance(shotButton(otherTarget));
    await page
      .getByRole("button", {
        name: `Record observed shot by #${shooter} at ${display(day, otherTarget)}`,
        exact: true,
      })
      .click();
    const observed = await saveReplay(page, api, "inline-observations", width, height);
    await expect(shotButton(target)).toHaveClass(/is-selected/);
    await expect(shotButton(target)).toHaveClass(/has-additional-shots/);
    await expect(shotButton(otherTarget)).toHaveClass(/has-additional-shots/);
    await expect(shotButton(otherTarget)).not.toHaveClass(/is-selected/);
    await expect(page.locator(".has-additional-shots")).toHaveCount(2);
    const repeatedShot = await appearance(shotButton(target));
    const additionalShot = await appearance(shotButton(otherTarget));
    assert.equal(repeatedShot.background, primaryShot.background, "Original fill is retained");
    assert.notEqual(repeatedShot.border, primaryShot.border, "Repeated original gains gold border");
    assert.equal(additionalShot.border, repeatedShot.border, "Additional pairs use the same gold");
    assert.notEqual(additionalShot.border, unselectedShot.border);
    assert.notEqual(additionalShot.shadow, unselectedShot.shadow);
    assert.deepEqual(repeatedShot.size, primaryShot.size);
    assert.deepEqual(additionalShot.size, unselectedShot.size);
    assert.ok(
      additionalShot.size.every((size) => size >= 48),
      "Shot targets remain touch-sized",
    );
    row.shotFeedback = { inactiveMode, activeMode, primaryShot, repeatedShot, additionalShot };
    assert.deepEqual(observed.env.current.state.game.shotAssignments, assigned);
    assert.equal(observed.env.current.state.game.shotObservations.length, 5);
    assert.deepEqual(
      observed.env.current.state.game.shotObservations.map((shot) => shot.targetSeat),
      [target, target, target, target, otherTarget],
    );
    row.screenshots.push(await capture(page, "inline-observations", width, height));
    await page.reload({ waitUntil: "networkidle" });
    assert.deepEqual(
      (await settled(page, api)).current.state.game.shotObservations,
      observed.env.current.state.game.shotObservations,
    );
    await expect(observationMode).toHaveAttribute("aria-pressed", "false");
    assert.equal((await appearance(observationMode)).shadow, inactiveMode.shadow);
    assert.deepEqual(await appearance(shotButton(target)), repeatedShot);
    assert.deepEqual(await appearance(shotButton(otherTarget)), additionalShot);
    const shootingLanguage = club.language;
    try {
      club.language = "ru";
      await page.reload({ waitUntil: "networkidle" });
      const russianMode = page.getByRole("button", {
        name: "Зафиксирована многократная стрельба",
        exact: true,
      });
      await russianMode.focus();
      await page.keyboard.press("Space");
      await expect(russianMode).toHaveAttribute("aria-pressed", "true");
      assert.equal((await appearance(russianMode)).shadow, activeMode.shadow);
      await expect(page.locator(".federation-shooting-observation")).toHaveText(
        "Зафиксирована многократная стрельба",
      );
      await expect(shotButton(otherTarget)).toHaveAttribute(
        "aria-description",
        "Дополнительных выстрелов: 1",
      );
      row.screenshots.push(await capture(page, "inline-observations-ru", width, height));
    } finally {
      club.language = shootingLanguage;
    }
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Evaluate Mafia shots", exact: true }).click();
    const missed = await saveReplay(page, api, "multiple-shots-miss", width, height);
    assert.equal(missed.env.current.state.game.nightResult.kind, "miss");
    await page.getByRole("button", { name: "Open developer menu", exact: true }).click();
    await expect(page.getByRole("button", { name: "Enable dev mode", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Open Manage menu", exact: true }).click();
    await page.getByRole("button", { name: "Past game timeline", exact: true }).click();
    const shotDetails = page.getByRole("complementary", { name: "Selected event details" });
    await expect(
      shotDetails.getByRole("heading", { name: "Mafia miss", exact: true }),
    ).toBeVisible();
    await expect(shotDetails.getByRole("listitem")).toHaveCount(Object.keys(assigned).length);
    await page
      .getByRole("button", { name: /^1 physical shot observed;/ })
      .last()
      .click();
    await expect(shotDetails.getByRole("listitem")).toHaveCount(1);
    await expect(shotDetails.getByRole("listitem")).toContainText(`#${shooter}`);
    await expect(shotDetails.getByRole("listitem")).toContainText(`#${otherTarget}`);
    const timelineImage = path.join(evidence, `${width}x${height}-shot-timeline.png`);
    await page.screenshot({ path: timelineImage });
    row.screenshots.push(timelineImage);
    await page.reload({ waitUntil: "networkidle" });
    assert.deepEqual((await settled(page, api)).current.state, missed.env.current.state);
    row.scenarios.push({
      name: "inline-repeated-same-and-different-shots-reload-miss",
      ...missed.proof,
    });

    // Domain-produced previous miss is a precondition, not the tested draw outcome.
    let priorMiss = completeMafiaShots(resolveMafiaShots(beginNight(day)).game);
    if (priorMiss.phase === "night-don") priorMiss = skipDonCheck(priorMiss);
    if (priorMiss.phase === "night-sheriff") priorMiss = skipSheriffCheck(priorMiss);
    priorMiss = completeNight(priorMiss);
    assert.equal(priorMiss.completedGameNights, 2);
    assert.equal(priorMiss.phase, "day");
    const drawId = randomUUID();
    await seed(page, api, checkpoint(beginNight(priorMiss), template, drawId), drawId);
    await expect(page.getByRole("region", { name: "Voting order", exact: true })).toHaveCount(0);
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
    await swipeUp(day.players.find((p) => p.team === "black").seat);
    await page
      .getByRole("combobox", { name: "Discipline action", exact: true })
      .selectOption("opponent-victory");
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
      const selections = day.players
        .filter((p) => p.seat !== victim)
        .slice(0, count)
        .map((p) => p.seat);
      await expect(page.locator(".table-advance button")).toHaveText([
        "Record Best Move",
        "Skip Best Move",
      ]);
      await expect(page.locator(".table-stage input, .table-stage select")).toHaveCount(0);
      for (const n of selections) {
        await page
          .getByRole("button", { name: `Select player ${n} for Best Move`, exact: true })
          .click();
        await expect(
          page.getByRole("button", { name: `Deselect player ${n} from Best Move`, exact: true }),
        ).toHaveAttribute("aria-pressed", "true");
      }
      api.clean();
      await expect(
        page.getByRole("button", { name: "Record Best Move", exact: true }),
      ).toBeDisabled();
      const draft = await settled(page, api);
      replay(draft.current.state);
      await page.reload({ waitUntil: "networkidle" });
      assert.deepEqual((await settled(page, api)).current.state, draft.current.state);
      row.screenshots.push(await capture(page, `best-${count}-selected-draft`, width, height));
      await page.getByRole("button", { name: "Skip Best Move", exact: true }).click();
      const finalized = await saveReplay(page, api, `best-${count}-finalized`, width, height);
      assert.equal(finalized.env.current.state.game.phase, "night-resolution");
      assert.equal(finalized.env.current.state.game.day, 1);
      assert.deepEqual(finalized.env.current.state.game.bestMove.selectedSeats, []);
      assert.equal(finalized.env.current.state.game.bestMove.completionReason, "declined");
      assert.equal(Object.hasOwn(finalized.env.current.state.game.bestMove, "mafiaHits"), false);
      assert.equal(
        Object.hasOwn(finalized.env.current.state.game.bestMove, "readbackAcknowledged"),
        false,
      );
      assert.equal(branch(finalized.env.current.state).at(-1).type, "best-move.skipped");
      assert.deepEqual(branch(finalized.env.current.state).at(-1).payload, {});
      await page.reload({ waitUntil: "networkidle" });
      const beforeUndo = await settled(page, api);
      replay(beforeUndo.current.state);
      assert.equal(beforeUndo.current.state.headEventId, finalized.env.current.state.headEventId);
      await undo(page);
      const undone = await settled(page, api);
      replay(undone.current.state);
      assert.equal(undone.current.state.game.phase, "best-move");
      assert.equal(undone.current.state.game.bestMove.completionReason, undefined);
      assert.deepEqual(undone.current.state.game.bestMove.selectedSeats, selections);
      assert.deepEqual(
        branch(undone.current.state),
        branch(draft.current.state),
        "Undo restores the pre-Skip branch",
      );
      assert.equal(undone.current.state.headEventId, draft.current.state.headEventId);
      await page.getByRole("button", { name: "Skip Best Move", exact: true }).click();
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
        name: `first-kill-best-move-${count === 0 ? "empty-skip" : "partial-skip"}-undo-reload-morning`,
        ...morning.proof,
      });
      row.screenshots.push(await capture(page, `best-${count}-morning`, width, height));
    }

    api.clean();
    assert.equal(row.scenarios.length, 12 + 3);
    assert.deepEqual(row.geometryFailures, [], "No primary-control overflow");
    assert.ok(row.nativeDialogCases.length >= 4, "Native Escape/Close dismissal cases retained");
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
