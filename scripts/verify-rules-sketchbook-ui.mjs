/* global URL, document, localStorage, getComputedStyle, requestAnimationFrame, MutationObserver */
/** Opt-in actual-App scenarios; imported by verify-ui.mjs, never a synthetic reader host.
 * APP_URL=http://127.0.0.1:5197 UI_RULES_SKETCHBOOK_ONLY=1 node scripts/verify-ui.mjs
 * API responses are the existing exact-origin fixture, not backend persistence.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import {
  advanceSetupPhase,
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
  hashGameState,
  issueFoul,
} from "../packages/game-domain/src/index.ts";
import { rulesChapters } from "../apps/web/src/features/rules/rules-content.ts";
import {
  adjudicationRules,
  ruleReferenceIds,
} from "../apps/web/src/features/rules/rule-references.ts";
import { removalRules } from "../apps/web/src/i18n/messages/federation-discipline.ts";
import { checkpoint, currentSetupState, openPlayerPenalty } from "./verify-federation-ui.mjs";
import { assertExactOrigin } from "./session-verifier-contracts.mjs";

const key = "mafia-dashboard.game-session.v5";
const labels = {
  en: {
    header: "Rules",
    close: "Close",
    action: "Discipline action",
    rule: "Removal rule",
    stage: "Occurrence timing",
    reason: "Discipline reason (optional)",
    applicable: "Applicable rule",
    judge: "Judge's reason",
    committee: "Required committee agreement obtained",
  },
  ru: {
    header: "Правила",
    close: "Закрыть",
    action: "Дисциплинарное действие",
    rule: "Пункт удаления",
    stage: "Момент нарушения",
    reason: "Причина взыскания (необязательно)",
    applicable: "Пункт правил",
    judge: "Обоснование судьи",
    committee: "Необходимое согласование с СК получено",
  },
};
export function assertRulesCoverage(report) {
  if (report.viewport?.width === 390 && report.viewport?.height === 844) {
    assert.equal(report.keyboardTraversal?.length, 2, "Both narrow keyboard locales executed");
    for (const locale of ["en", "ru"]) {
      const rows = report.keyboardTraversal.find((row) => row.locale === locale)?.rows;
      assert.equal(rows?.length, 56, "All 28 entries observed in both keyboard directions");
      assert.ok(
        rows.every((row) => row.inside),
        "Focused contents entries must be fully inside their scroll viewport",
      );
      assert.deepEqual(
        rows.map((row) => row.index),
        [
          ...Array.from({ length: 28 }, (_, i) => i),
          ...Array.from({ length: 28 }, (_, i) => 27 - i),
        ],
      );
    }
  }
  for (const locale of ["en", "ru"]) {
    const destinations = report.destinations
      .filter((row) => row.locale === locale)
      .map((row) => row.id);
    assert.equal(destinations.length, 28, `${locale}: 28 real destinations`);
    assert.deepEqual([...new Set(destinations)].sort(), rulesChapters.map((c) => c.id).sort());
    const references = report.references
      .filter((row) => row.locale === locale && !row.forced)
      .map((row) => row.id);
    assert.equal(references.length, 19, `${locale}: every effective selector ID`);
    assert.deepEqual([...new Set(references)].sort(), [...ruleReferenceIds].sort());
    assert.ok(report.references.some((row) => row.locale === locale && row.id === "6.2.12"));
    assert.ok(
      report.references.some((row) => row.locale === locale && row.forced && row.id === "6.2.1"),
    );
  }
}
export async function rulesSourceManifest() {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (!/(?:\.(?:test|browser\.test)|-scenarios)\./.test(file)) files.push(file);
    }
  }
  await walk("apps/web/src");
  await walk("apps/web/public");
  await walk("packages/game-domain/src");
  await walk("packages/game-domain/dist");
  files.push(
    "package.json",
    "package-lock.json",
    "apps/web/package.json",
    "packages/game-domain/package.json",
    "apps/web/index.html",
    "apps/web/vite.config.ts",
    "scripts/verify-ui.mjs",
    "scripts/verify-federation-ui.mjs",
    "scripts/verify-rules-sketchbook-ui.mjs",
    "scripts/session-verifier-contracts.mjs",
  );
  return Object.fromEntries(
    await Promise.all(
      files.sort().map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
      ]),
    ),
  );
}

export async function runRulesSketchbookScenarios({
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
    "Owned loopback only",
  );
  const evidence = path.resolve(evidenceDir);
  await mkdir(evidence, { recursive: true });
  // Keep the production SDK-created iframe and its identity, but isolate remote
  // playback/network errors. This gate does not qualify YouTube playback.
  await page.route(/^https:\/\/www\.youtube(?:-nocookie)?\.com\/embed\//, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><title>Isolated media transport</title></html>",
    }),
  );
  const viewport = page.viewportSize();
  const engine = page.context().browser().browserType().name();
  const report = {
    engine,
    browserVersion: page.context().browser().version(),
    viewport,
    origin,
    boundaries:
      "Actual App and table; isolated browser; exact-origin API fixture. Production SDK creates media iframe; embed transport is blank-fixtured, not playback qualification. Not physical iPad or backend persistence.",
    sourceBefore: await rulesSourceManifest(),
    destinations: [],
    references: [],
    scenarios: [],
    screenshots: [],
    failures: [],
  };
  const previousLanguage = club.language;
  const book = page.locator("dialog.rules-sketchbook[open]");
  const paper = book.locator(".rs-book");
  const body = () => book.locator(".rs-spread .rs-body[data-reading-key]");
  const read = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), key);
  const screenshot = async (name) => {
    const file = path.join(evidence, `${name}.png`);
    await page.screenshot({ path: file });
    report.screenshots.push(file);
    return file;
  };
  async function nativeFocus(label) {
    const active = await page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      label: document.activeElement?.getAttribute("aria-label"),
      connected: document.activeElement?.isConnected,
      inert: Boolean(document.activeElement?.closest("[inert]")),
    }));
    assert.ok(active.connected && !active.inert, "Native focus never remains in a suspended layer");
    report.nativeFocus ??= [];
    report.nativeFocus.push({ label, ...active });
    return active;
  }
  async function saved() {
    await expect(page.locator('.save-indicator[data-status="saved"]')).toBeVisible();
    await expect.poll(async () => (await read())?.outbox.length).toBe(0);
    const env = await read();
    assert.deepEqual(api.sessions.get(env.gameId)?.state, env.current.state, "Fixture readback");
    api.clean();
    return env;
  }
  async function unchanged(before) {
    const after = await saved();
    assert.deepEqual(
      after.current.state,
      before.current.state,
      "Reading emits no event or canonical-state change",
    );
    assert.deepEqual(after.current.results, before.current.results);
    assert.equal(hashGameState(after.current.state.game), hashGameState(before.current.state.game));
  }
  let draw = beginRoleDraw(
    createSetup(players.slice(0, 10).map((p, i) => ({ id: p.id, seat: i + 1 }))),
    createSeededRandom(71),
  );
  for (let seat = 1; seat <= 10; seat++) draw = drawRoleForSeat(draw, seat);
  let day = createGame(completeRoleDraw(draw));
  while (day.phase !== "day") day = advanceSetupPhase(day);
  const seat = day.players.find((p) => p.role === "citizen").seat;
  const template = {
    ...currentSetupState(),
    setup: null,
    hostPlayerId: players[10].id,
    playlistId: "test-playlist",
  };
  async function seed(game = day) {
    const id = randomUUID();
    const state = checkpoint(game, template, id);
    api.seed(id, state);
    await page.goto(new URL("/health/ready", origin).href);
    assertExactOrigin(page.url(), origin);
    await page.evaluate(({ k, value }) => localStorage.setItem(k, JSON.stringify(value)), {
      k: key,
      value: {
        version: 5,
        clubId: club.id,
        gameId: id,
        creationId: null,
        revision: 1,
        current: { name: "Federation UI verification", state, results: null },
        outbox: [],
        failed: false,
        clearFailed: false,
        clearingGameId: null,
        removed: false,
        legacyGameId: null,
      },
    });
    // App readiness, not third-party YouTube traffic, determines this read-only gate.
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    assertExactOrigin(page.url(), origin);
    await expect(page.locator(".game-shell.phase-day, .club-card-open").first()).toBeVisible();
    const clubCard = page.locator(".club-card-open").first();
    if (await clubCard.isVisible()) await clubCard.click();
    await expect(page.locator(".game-shell.phase-day")).toBeVisible();
    return saved();
  }
  async function idle() {
    await expect(book).toBeVisible();
    await expect(paper).not.toHaveAttribute("aria-busy", "true");
    await expect(book.locator(".rs-curl")).toHaveCount(0);
  }
  async function closeBook(method = "escape") {
    if (method === "button") await book.locator(".rs-close").click();
    else if (method === "outside") await page.mouse.click(3, 3);
    else await page.keyboard.press("Escape");
    await expect(book).toHaveCount(0);
  }
  async function openHeader(locale) {
    const opener = page.getByRole("button", { name: labels[locale].header, exact: true });
    await opener.click();
    await idle();
    assert.ok(await book.evaluate((d) => d.matches(":modal")), "Native foreground modal");
    return opener;
  }
  async function readable(chapter, locale) {
    await expect(paper).toHaveAttribute("data-chapter", chapter.id);
    const prose = body();
    await expect(prose).toBeVisible();
    await expect(prose.locator("h2")).toContainText(chapter[locale].title[0]);
    if (chapter.reference) {
      await expect(prose.locator(".rs-reference")).toHaveText(chapter.reference);
      // WebKit IntersectionObserver can report ratio 0 for a visible stacked
      // native dialog. Check the painted number's bounds against its scroll clip.
      await expect
        .poll(() =>
          prose.locator(".rs-reference").evaluate((el) => {
            const r = el.getBoundingClientRect();
            const clip = el.closest(".rs-body").getBoundingClientRect();
            return {
              visible:
                r.width > 0 &&
                r.height > 0 &&
                r.top >= clip.top - 1 &&
                r.bottom <= clip.bottom + 1 &&
                r.left >= clip.left - 1 &&
                r.right <= clip.right + 1,
              top: r.top,
              bottom: r.bottom,
              clipTop: clip.top,
              clipBottom: clip.bottom,
            };
          }),
        )
        .toMatchObject({ visible: true });
    }
    const text = await prose.innerText();
    for (const p of chapter[locale].paragraphs ?? [])
      assert.ok(text.includes(p), "Actual reference prose, not a synthetic replacement");
    const geometry = await prose.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        right: r.right,
        bottom: r.bottom,
        width: el.clientWidth,
        scrollWidth: el.scrollWidth,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        fonts: [...el.querySelectorAll(".rs-paragraph,.rs-rule-item p,.rs-cover-summary")].map(
          (p) => parseFloat(getComputedStyle(p).fontSize),
        ),
      };
    });
    assert.ok(
      geometry.x >= 0 &&
        geometry.y >= 0 &&
        geometry.right <= page.viewportSize().width + 1 &&
        geometry.bottom <= page.viewportSize().height + 1,
      `Prose bounded: ${JSON.stringify(geometry)}`,
    );
    assert.ok(geometry.scrollWidth <= geometry.width + 1, "No horizontal prose clipping");
    assert.ok(
      geometry.fonts.every((size) => size >= 20),
      "Unshrunk 20px minimum main prose",
    );
    if (geometry.scrollHeight > geometry.clientHeight + 1) {
      await prose.hover();
      await page.mouse.wheel(0, geometry.scrollHeight + 200);
      await expect
        .poll(() => prose.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2))
        .toBe(true);
      await page.mouse.wheel(0, -geometry.scrollHeight - 200);
      await expect.poll(() => prose.evaluate((el) => el.scrollTop)).toBe(0);
    }
    return geometry;
  }
  async function contents() {
    await book.locator(".rs-bookmark").click();
    await idle();
    await expect(paper).toHaveAttribute("data-chapter", "contents");
    await expect(book.locator(".rs-spread [data-chapter-target]")).toHaveCount(28);
  }
  async function narrowContentsKeyboard(locale) {
    if (viewport.width !== 390 || viewport.height !== 844) return;
    const entries = book.locator(".rs-spread .rs-contents-body [data-chapter-target]");
    const rows = [];
    async function focused(index, direction) {
      const entry = entries.nth(index);
      await expect(entry).toBeFocused();
      const bounds = await entry.evaluate((el) => {
        const clip = el.closest(".rs-contents-body").getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return {
          top: r.top,
          bottom: r.bottom,
          left: r.left,
          right: r.right,
          clip: { top: clip.top, bottom: clip.bottom, left: clip.left, right: clip.right },
        };
      });
      rows.push({
        index,
        direction,
        id: await entry.getAttribute("data-chapter-target"),
        bounds,
        inside:
          bounds.top >= bounds.clip.top - 1 &&
          bounds.bottom <= bounds.clip.bottom + 1 &&
          bounds.left >= bounds.clip.left - 1 &&
          bounds.right <= bounds.clip.right + 1,
      });
    }
    // Only initial focus is explicit. Every subsequent move is a real Tab key;
    // never scroll the entries on the verifier's behalf.
    await entries.first().focus();
    for (let index = 0; index < 28; index++) {
      if (index > 0) await page.keyboard.press("Tab");
      await focused(index, "forward");
    }
    await screenshot(`${locale}-contents-keyboard-last`);
    await focused(27, "reverse");
    for (let index = 26; index >= 0; index--) {
      await page.keyboard.press("Shift+Tab");
      await focused(index, "reverse");
    }
    const clipped = rows.filter((row) => !row.inside);
    report.keyboardTraversal ??= [];
    report.keyboardTraversal.push({ locale, rows, clipped });
    if (clipped.length)
      report.failures.push(
        `Narrow contents ${locale}: ${clipped.length} focused entries clipped; ${JSON.stringify(clipped)}`,
      );
  }
  async function reference(dialog, id, locale, before, forced = false) {
    const opener = dialog.getByRole("button", {
      name: locale === "en" ? `Read rule ${id} in the book` : `Открыть пункт ${id} в книге`,
      exact: true,
    });
    await expect(opener).toBeEnabled();
    const fields = await dialog.locator("input,select,textarea").evaluateAll((els) =>
      els.map((e) => ({
        tag: e.tagName,
        value: e.value,
        checked: e.checked,
        disabled: e.disabled,
      })),
    );
    await opener.click();
    await idle();
    await expect(dialog).toHaveAttribute("inert", "");
    await expect(dialog).toHaveAttribute("aria-hidden", "true");
    if (!report.lowerBlurChecked?.includes(locale)) {
      report.lowerBlurChecked ??= [];
      report.lowerBlurChecked.push(locale);
      try {
        await expect
          .poll(() => dialog.evaluate((d) => getComputedStyle(d).filter))
          .toBe("blur(14px)");
      } catch (error) {
        const actual = await dialog.evaluate((d) => ({
          filter: getComputedStyle(d).filter,
          inline: d.getAttribute("style"),
          bodyClass: document.body.className,
          animations: d
            .getAnimations()
            .map((a) => ({ playState: a.playState, keyframes: a.effect.getKeyframes() })),
        }));
        report.failures.push(
          `Actual lower-dialog blur ${locale}: ${error.message}; ${JSON.stringify(actual)}`,
        );
      }
    }
    assert.ok(await dialog.evaluate((d) => d.open), "Lower native form remains mounted and open");
    const chapter = rulesChapters.find((c) => c.reference === id);
    const geometry = await readable(chapter, locale);
    // Native top-layer focus isolation; the lower submit must not acquire focus.
    await dialog
      .locator("button[type=submit]")
      .first()
      .evaluate((el) => el.focus());
    assert.ok(await dialog.evaluate((d) => !d.contains(document.activeElement)));
    for (let n = 0; n < 8; n++) {
      await page.keyboard.press(n % 2 ? "Shift+Tab" : "Tab");
      assert.ok(
        await page.evaluate(() => {
          const active = document.activeElement;
          return active === document.body || Boolean(active?.closest("dialog.rules-sketchbook"));
        }),
        "Native modal Tab does not enter the lower dialog or background controls",
      );
    }
    if (id === "6.2.12" || id === "6.3.5") await screenshot(`${locale}-reference-${id}`);
    await closeBook(id === "6.3.5" ? "button" : "escape");
    await expect(dialog).not.toHaveAttribute("inert", "");
    const focusAfterClose = await nativeFocus(`${locale} ${id} native close`);
    assert.deepEqual(
      await dialog.locator("input,select,textarea").evaluateAll((els) =>
        els.map((e) => ({
          tag: e.tagName,
          value: e.value,
          checked: e.checked,
          disabled: e.disabled,
        })),
      ),
      fields,
      "Unfinished form preserved",
    );
    await unchanged(before);
    report.references.push({
      locale,
      id,
      forced,
      geometry,
      focusAfterClose,
      unchanged: true,
    });
  }
  try {
    for (const locale of ["en", "ru"]) {
      club.language = locale;
      await page.emulateMedia({ reducedMotion: "reduce" });
      const before = await seed();
      await openHeader(locale);
      assert.ok(
        await book.evaluate((d) => d.contains(document.activeElement)),
        "First lazy-open focus stays in foreground reader",
      );
      await closeBook();
      await nativeFocus(`${locale} immediate first-load native Escape`);
      await unchanged(before);
      await openHeader(locale);
      report.scenarios.push({
        locale,
        name: "first-lazy-load-native-modal-Escape-cleanup-no-authored-return",
      });
      await screenshot(`${locale}-spread`);
      await contents();
      await screenshot(`${locale}-contents`);
      await narrowContentsKeyboard(locale);
      for (const chapter of rulesChapters) {
        await contents();
        await book.locator(`.rs-spread [data-chapter-target="${chapter.id}"]`).click();
        await idle();
        report.destinations.push({
          locale,
          id: chapter.id,
          geometry: await readable(chapter, locale),
        });
      }
      await closeBook("outside");
      await nativeFocus(`${locale} header outside close`);
      await unchanged(before);
      const { dialog } = await openPlayerPenalty(page, seat, {
        locale,
        input: "pointer",
      });
      const l = labels[locale];
      await expect(
        dialog.getByRole("button", {
          name: locale === "en" ? "Choose a rule to read" : "Сначала выберите пункт правил",
          exact: true,
        }),
      ).toBeDisabled();
      await dialog.getByLabel(l.reason, { exact: true }).fill(`unfinished removal ${locale}`);
      const removal = dialog.getByRole("combobox", { name: l.rule, exact: true });
      assert.deepEqual(
        await removal
          .locator("option")
          .evaluateAll((els) => els.map((o) => o.value).filter(Boolean)),
        [...removalRules],
      );
      for (const id of removalRules) {
        await removal.selectOption(id);
        await reference(dialog, id, locale, before);
      }
      await dialog
        .getByRole("combobox", { name: l.action, exact: true })
        .selectOption("opponent-victory");
      const applicable = dialog.getByRole("combobox", { name: l.applicable, exact: true });
      assert.deepEqual(
        await applicable.locator("option").evaluateAll((els) => els.map((o) => o.value)),
        [...adjudicationRules],
      );
      await dialog.getByLabel(l.judge, { exact: true }).fill(`unfinished adjudication ${locale}`);
      for (const id of adjudicationRules) {
        await applicable.selectOption(id);
        if (id === "6.3.5")
          await dialog.getByRole("checkbox", { name: l.committee, exact: true }).check();
        await reference(dialog, id, locale, before);
      }
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      let fouled = day;
      for (let n = 0; n < 3; n++) fouled = issueFoul(fouled, seat);
      const forcedBefore = await seed(fouled);
      const card = page.locator(`.seat-anchor[data-seat="${seat}"] .player-seat`);
      await card.focus();
      for (const retired of ["f", "Shift+F10", "ContextMenu"]) await page.keyboard.press(retired);
      await expect(page.locator("dialog.is-discipline[open]")).toHaveCount(0);
      await unchanged(forcedBefore);
      const bounds = await card.boundingBox();
      const x = bounds.x + bounds.width / 2;
      const y = Math.min(bounds.y + bounds.height / 3, viewport.height - 85);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + 64, { steps: 8 });
      await page.mouse.up();
      const forcedDialog = page.locator("dialog.is-discipline[open]");
      await expect(forcedDialog).toBeVisible();
      await expect(
        forcedDialog.getByRole("combobox", { name: l.rule, exact: true }),
      ).toBeDisabled();
      await expect(forcedDialog.getByRole("combobox", { name: l.rule, exact: true })).toHaveValue(
        "6.2.1",
      );
      await reference(forcedDialog, "6.2.1", locale, forcedBefore, true);
      await page.keyboard.press("Escape");
      report.scenarios.push({
        locale,
        name: "real-content-selector-forms-native-modal-focus-no-events",
        count: 19,
      });
    }
    club.language = "en";
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const before = await seed();
    // Timer and media owners must survive a read-only round trip with exact DOM identity.
    const timerStart = page.getByRole("button", { name: "Start 60 second timer", exact: true });
    await timerStart.focus();
    await page.keyboard.press("Enter");
    const timer = page.locator(".timer-display");
    await expect(timer).toHaveAttribute("aria-label", "Pause timer");
    const timerNode = await timer.elementHandle();
    const mediaNode = await page.locator(".youtube-dock").elementHandle();
    await expect(page.locator("iframe.youtube-player-video")).toHaveCount(1);
    const iframeNode = await page.locator("iframe.youtube-player-video").elementHandle();
    const iframeSource = await page.locator("iframe.youtube-player-video").getAttribute("src");
    const initialTimer = await timer.innerText();
    await openHeader("en");
    await screenshot("blur-after");
    const underlay = await page.locator("#root").evaluate((el) => getComputedStyle(el).filter);
    assert.ok(underlay.includes("blur(14px)"), `Actual App underlay filter: ${underlay}`);
    await book.locator(".rs-bookmark").click();
    await idle();
    await paper.evaluate((el) => {
      const log = { started: Date.now(), ids: [el.getAttribute("data-chapter")] };
      const observer = new MutationObserver(() => {
        const id = el.getAttribute("data-chapter");
        if (log.ids.at(-1) !== id) log.ids.push(id);
      });
      observer.observe(el, { attributes: true, attributeFilter: ["data-chapter"] });
      el.__rulesJourneyLog = log;
      el.__rulesJourneyObserver = observer;
    });
    await book.locator(`.rs-spread [data-chapter-target="${rulesChapters.at(-1).id}"]`).click();
    await expect(book.locator(".rs-curl")).toBeVisible();
    await screenshot("bounded-intermediate-journey-curl");
    await expect(paper).toHaveAttribute("data-chapter", rulesChapters.at(-1).id, { timeout: 5000 });
    await idle();
    const journey = await paper.evaluate((el) => {
      el.__rulesJourneyObserver.disconnect();
      return {
        ids: el.__rulesJourneyLog.ids,
        elapsedMs: Date.now() - el.__rulesJourneyLog.started,
      };
    });
    assert.deepEqual(
      journey.ids,
      ["contents", ...rulesChapters.map((chapter) => chapter.id)],
      "Every real intermediate chapter is visibly traversed",
    );
    assert.ok(journey.elapsedMs < 5000, `Bounded intermediate journey: ${journey.elapsedMs}ms`);
    report.scenarios.push({
      name: "bounded-contents-journey-all-28-intermediate-chapters",
      ...journey,
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await contents();
    await book.locator(`.rs-spread [data-chapter-target="${rulesChapters[0].id}"]`).click();
    await idle();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await contents();
    await book.locator(`.rs-spread [data-chapter-target="${rulesChapters[0].id}"]`).click();
    await expect(book.locator(".rs-curl")).toBeVisible();
    await screenshot("automatic-curl");
    await idle();
    const textPaper = book.locator('.rs-spread .rs-leaf[data-side="text"]');
    const box = await textPaper.boundingBox();
    const x = box.x + box.width * 0.8;
    const y = box.y + box.height * 0.72;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - box.width * 0.45, y, { steps: 12 });
    await expect(book.locator(".rs-curl")).toBeVisible();
    await screenshot("drag-curl");
    await page.mouse.up();
    await idle();
    assert.ok(
      (await paper.getAttribute("data-chapter")) !== rulesChapters[0].id,
      "Actual drag commits a turn",
    );
    // Physical click on paper (not a navigation button), then resize during the next turn.
    const box2 = await paper.boundingBox();
    await page.mouse.click(box2.x + box2.width * 0.92, box2.y + box2.height * 0.68);
    await expect(book.locator(".rs-curl")).toBeVisible();
    await page.setViewportSize({
      width: Math.max(360, viewport.width - 30),
      height: viewport.height - 20,
    });
    await idle();
    await page.setViewportSize(viewport);
    await paper.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await idle();
    // Former reader arrow shortcuts are inert; the real page control starts the turn.
    const retainedChapter = await paper.getAttribute("data-chapter");
    await page.keyboard.press("ArrowRight");
    await expect(paper).toHaveAttribute("data-chapter", retainedChapter);
    await expect(book.locator(".rs-curl")).toHaveCount(0);
    await book.locator(".rs-next").click();
    await expect(book.locator(".rs-curl")).toBeVisible();
    await closeBook();
    await nativeFocus("Native Escape interrupts turn without authored return");
    await screenshot("blur-before");
    assert.equal(await page.locator("#root").evaluate((el) => getComputedStyle(el).filter), "none");
    assert.ok(
      await timerNode.evaluate((el) => el === document.querySelector(".timer-display")),
      "Timer node retained",
    );
    assert.ok(
      await mediaNode.evaluate((el) => el === document.querySelector(".youtube-dock")),
      "Media owner retained",
    );
    assert.ok(
      await iframeNode.evaluate(
        (el) => el === document.querySelector("iframe.youtube-player-video"),
      ),
      "Exact live media iframe retained",
    );
    assert.equal(
      await page.locator("iframe.youtube-player-video").getAttribute("src"),
      iframeSource,
    );
    await expect(timer).toHaveAttribute("aria-label", "Pause timer");
    assert.notEqual(await timer.innerText(), initialTimer, "Timer continues while reading");
    await unchanged(before);
    report.scenarios.push({
      name: "actual-click-drag-painted-curl-resize-interrupted-turn-timer-media-identity",
      underlay,
    });
    if (engine === "chromium") {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await openHeader("en");
      await contents();
      await book.locator('.rs-spread [data-chapter-target="rule-6.3.5"]').click();
      await idle();
      const prose = body();
      const p = await prose.boundingBox();
      const cdp = await page.context().newCDPSession(page);
      const x = p.x + p.width / 2,
        y = p.y + p.height * 0.75;
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y, id: 1 }],
      });
      for (let n = 1; n <= 8; n++)
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x, y: y - n * 14, id: 1 }],
        });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect.poll(() => prose.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      await expect(paper).toHaveAttribute("data-chapter", "rule-6.3.5");
      assert.equal(
        await paper.evaluate((el) => getComputedStyle(el).touchAction),
        "pan-y pinch-zoom",
      );
      await cdp.detach();
      await screenshot("native-touch-scroll");
      // Wait for the real native fling to settle; do not scroll on the reader's behalf.
      const retainedScroll = await prose.evaluate(
        (el) =>
          new Promise((resolve) => {
            let previous = el.scrollTop,
              stable = 0,
              frames = 0;
            const tick = () => {
              stable = Math.abs(el.scrollTop - previous) < 0.1 ? stable + 1 : 0;
              previous = el.scrollTop;
              if (stable >= 6 || frames++ >= 120)
                resolve({ top: el.scrollTop, settled: stable >= 6 });
              else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }),
      );
      assert.ok(retainedScroll.settled, "Native touch inertia settled before persistence check");
      await closeBook();
      await openHeader("en");
      await expect(paper).toHaveAttribute("data-chapter", "rule-6.3.5");
      await expect
        .poll(() =>
          body().evaluate(
            (el, retained) => Math.abs(el.scrollTop - retained) <= 2,
            retainedScroll.top,
          ),
        )
        .toBe(true);
      await closeBook();
      const { dialog } = await openPlayerPenalty(page, seat);
      await dialog
        .getByRole("combobox", { name: "Discipline action", exact: true })
        .selectOption("opponent-victory");
      await dialog
        .getByRole("combobox", { name: "Applicable rule", exact: true })
        .selectOption("6.3.5");
      await dialog
        .getByRole("button", { name: "Read rule 6.3.5 in the book", exact: true })
        .click();
      await idle();
      await expect.poll(() => body().evaluate((el) => el.scrollTop)).toBe(0);
      await closeBook();
      await page.keyboard.press("Escape");
      await unchanged(before);
      report.scenarios.push({
        name: "trusted-CDP-touch-vertical-prose-scroll-no-page-turn-reopen-retains-direct-resets",
        physicalIPad: false,
      });
    }
    assertRulesCoverage(report);
    api.clean();
  } catch (error) {
    report.failures.push(error.stack ?? String(error));
    await screenshot("failure").catch(() => {});
    throw error;
  } finally {
    club.language = previousLanguage;
    report.sourceAfter = await rulesSourceManifest();
    report.changedSources = [
      ...new Set([...Object.keys(report.sourceBefore), ...Object.keys(report.sourceAfter)]),
    ].filter((file) => report.sourceBefore[file] !== report.sourceAfter[file]);
    report.sourceStable = report.changedSources.length === 0;
    report.status = !report.failures.length && report.sourceStable ? "PASS" : "FAIL";
    await writeFile(path.join(evidence, "results.json"), JSON.stringify(report, null, 2));
  }
  if (!report.sourceStable)
    throw new Error(
      `Source changed during evidence capture; rerun: ${report.changedSources.join(", ")}`,
    );
  if (report.failures.length)
    throw new Error(
      `Actual App qualification failures: ${report.failures.length}; see ${evidence}/results.json`,
    );
  console.log(
    `Rules actual App ${engine} ${viewport.width}x${viewport.height}: PASS (${report.destinations.length} destinations; ${report.references.length} references including forced values)`,
  );
  return report;
}
