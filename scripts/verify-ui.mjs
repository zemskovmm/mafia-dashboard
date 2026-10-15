/* global URL, document, getComputedStyle, HTMLElement, HTMLCanvasElement, HTMLInputElement, innerHeight, innerWidth, structuredClone, localStorage, crypto, TextEncoder, ErrorEvent, Event */
import { chromium, webkit } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { assertExactOrigin } from "./session-verifier-contracts.mjs";

const baseUrl = process.env.APP_URL ?? "http://127.0.0.1:8080";
const expectedOrigin = new URL(baseUrl).origin;
let browserAppUrl = baseUrl;
let storageMutationUrl;
const fulfillMock = async (route, response) => {
  assertExactOrigin(route.request().url(), expectedOrigin);
  await route.fulfill(response);
};
const unlockDeveloperMenu = async (page) => {
  const menuButton = page.getByRole("button", { name: "Open developer menu" });
  if (!(await menuButton.isVisible())) {
    const privacy = page.getByRole("button", { name: /^(Hide|Show) private info$/ });
    for (let tap = 0; tap < 5; tap += 1) await privacy.dispatchEvent("click");
  }
  await menuButton.waitFor();
};
const assertSupportedTableLighting = async (page, label) => {
  const read = () =>
    page.locator(".app-shell").evaluate((shell) => {
      const table = document.querySelector(".round-table");
      if (!(table instanceof HTMLElement)) throw new Error("Missing round table");
      const canvas = table.querySelector(".vgpu-table-lighting");
      return {
        requested: shell.getAttribute("data-lighting-renderer-requested"),
        effective: shell.getAttribute("data-lighting-renderer"),
        status: shell.getAttribute("data-vgpu-status"),
        gpuReady: canvas?.getAttribute("data-vgpu-ready"),
        gpuVisibility: canvas === null ? null : getComputedStyle(canvas).visibility,
        cssBackground: getComputedStyle(table, "::before").backgroundImage,
      };
    });
  let evidence = await read();
  if (evidence.effective === "vgpu") {
    await page.locator('.vgpu-table-lighting[data-vgpu-ready="true"]').waitFor();
    evidence = await read();
  }
  const gpuLighting =
    evidence.effective === "vgpu" &&
    evidence.gpuReady === "true" &&
    evidence.gpuVisibility === "visible";
  const cssLighting =
    evidence.effective === "legacy" && evidence.cssBackground.includes("gradient");
  if (!gpuLighting && !cssLighting) {
    throw new Error(`${label} has no supported lighting outcome: ${JSON.stringify(evidence)}`);
  }
  return evidence;
};
const assertSupportedPlayerLighting = async (card, label) => {
  const read = () =>
    card.evaluate((element) => {
      const shell = element.closest(".app-shell");
      if (!(shell instanceof HTMLElement)) throw new Error("Missing application shell");
      const canvas = element.querySelector(".vgpu-player-lighting");
      const style = getComputedStyle(element);
      return {
        effective: shell.getAttribute("data-lighting-renderer"),
        gpuReady: canvas?.getAttribute("data-vgpu-ready"),
        gpuVisibility: canvas === null ? null : getComputedStyle(canvas).visibility,
        cssAnimation: style.animationName,
        cssShadow: style.boxShadow,
      };
    });
  let evidence = await read();
  if (evidence.effective === "vgpu") {
    await card.locator('.vgpu-player-lighting[data-vgpu-ready="true"]').waitFor();
    evidence = await read();
  }
  const gpuLighting =
    evidence.effective === "vgpu" &&
    evidence.gpuReady === "true" &&
    evidence.gpuVisibility === "visible";
  const cssLighting =
    evidence.effective === "legacy" &&
    evidence.cssAnimation !== "none" &&
    evidence.cssShadow !== "none";
  if (!gpuLighting && !cssLighting) {
    throw new Error(`${label} has no supported lighting outcome: ${JSON.stringify(evidence)}`);
  }
  return evidence;
};
const assertVoteCountTypography = async (page) => {
  const evidence = await page.locator(".nomination-panel").evaluate((panel) => {
    const root = document.documentElement;
    const originalSize = root.style.fontSize;
    const originalZoom = root.style.zoom;
    const total = panel.querySelector(".nomination-total");
    const summary = panel.querySelector(".vote-count-summary");
    const copy = panel.querySelector(".nomination-copy span");
    const candidate = panel.querySelector(".nomination-copy button");
    if (
      !(total instanceof HTMLElement) ||
      !(summary instanceof HTMLElement) ||
      !(copy instanceof HTMLElement) ||
      !(candidate instanceof HTMLElement)
    ) {
      throw new Error("Voting count typography requires a visible ballot");
    }
    const read = () => ({
      root: parseFloat(getComputedStyle(root).fontSize),
      total: parseFloat(getComputedStyle(total).fontSize),
      summary: parseFloat(getComputedStyle(summary).fontSize),
      copy: parseFloat(getComputedStyle(copy).fontSize),
      candidate: parseFloat(getComputedStyle(candidate).fontSize),
      zoom: getComputedStyle(root).zoom,
      totalBox: total.getBoundingClientRect().width,
      countFits:
        total.getBoundingClientRect().right <= total.closest("li").getBoundingClientRect().right &&
        candidate.getBoundingClientRect().right <= total.getBoundingClientRect().left &&
        summary.scrollWidth <= summary.clientWidth + 1,
    });
    try {
      const normal = read();
      root.style.fontSize = "20px";
      const scaled = read();
      root.style.zoom = "1.25";
      const zoomed = read();
      const originalTotal = total.textContent;
      total.textContent = "10";
      const multiDigit = read();
      total.textContent = originalTotal;
      return { normal, scaled, zoomed, multiDigit };
    } finally {
      root.style.fontSize = originalSize;
      root.style.zoom = originalZoom;
    }
  });
  const near = (left, right) => Math.abs(left - right) < 0.05;
  for (const sample of Object.values(evidence)) {
    if (
      !near(sample.total, sample.root * 1.44) ||
      !near(sample.summary, sample.root * 1.44) ||
      !near(sample.copy, sample.root * 0.72) ||
      !sample.countFits
    ) {
      throw new Error(`Panel vote count sizing differs from 1.44rem: ${JSON.stringify(evidence)}`);
    }
  }
  if (
    !near(evidence.normal.candidate, evidence.scaled.candidate) ||
    evidence.zoomed.totalBox <= evidence.scaled.totalBox
  ) {
    throw new Error(
      `Unrelated candidate text or zoom behavior changed: ${JSON.stringify(evidence)}`,
    );
  }
  console.log(`Voting count typography: ${JSON.stringify(evidence)}`);
};
const assertRolePresentation = async (page, { masked, roleLighting, phase }) => {
  const evidence = await page.locator(".game-shell").evaluate((shell) => {
    const cards = [...shell.querySelectorAll(".player-seat")];
    const roleCards = cards.filter((card) =>
      card.matches(".is-mafia-shooter, .is-sheriff-highlight, .is-night-check-highlight"),
    );
    return {
      phase: shell.className,
      roles: shell.querySelectorAll(".role-badge").length,
      counts: shell.querySelector(".team-counts")?.getAttribute("aria-label"),
      roleCards: roleCards.length,
      roleCanvas: roleCards.filter((card) => card.querySelector(".vgpu-player-lighting")).length,
      roleCanvasVisible: roleCards.some((card) => {
        const canvas = card.querySelector(".vgpu-player-lighting");
        return canvas !== null && getComputedStyle(canvas).visibility === "visible";
      }),
      roleCss: roleCards.some((card) => {
        const style = getComputedStyle(card);
        return style.animationName !== "none" || style.boxShadow !== "none";
      }),
      speaker: cards.some((card) => card.classList.contains("is-current")),
      renderer: shell.closest(".app-shell")?.getAttribute("data-lighting-renderer"),
    };
  });
  if (
    !evidence.phase.includes(`phase-${phase}`) ||
    evidence.roles !== (masked ? 0 : 10) ||
    (evidence.counts?.includes("hidden") ?? false) !== masked ||
    (masked && evidence.roleCards !== 0) ||
    (roleLighting &&
      (evidence.roleCards === 0 ||
        (evidence.renderer === "vgpu" ? !evidence.roleCanvasVisible : !evidence.roleCss)))
  ) {
    throw new Error(
      `Role presentation leaked or was suppressed in ${phase}: ${JSON.stringify(evidence)}`,
    );
  }
  console.log(`Role presentation ${phase}: ${JSON.stringify(evidence)}`);
};
const evidencePath = (name) => `.AI/mafia-dashboard-${name}.png`;
const screenshotPath = process.env.UI_SCREENSHOT ?? evidencePath("setup");
const verifyFadeFooter = async (state) => {
  const evidence = await page.locator(".live-side-panel").evaluate((panel) => {
    const dock = panel.querySelector(".youtube-dock");
    const controls = dock.querySelector(".live-music-controls");
    const bottomInset = (element) => {
      const style = getComputedStyle(element);
      return parseFloat(style.borderBottomWidth) + parseFloat(style.paddingBottom);
    };
    const panelBounds = panel.getBoundingClientRect();
    const dockBounds = dock.getBoundingClientRect();
    const controlsBounds = controls.getBoundingClientRect();
    return {
      panel: panelBounds.toJSON(),
      dock: dockBounds.toJSON(),
      controls: controlsBounds.toJSON(),
      panelPadding: getComputedStyle(panel).paddingBottom,
      controlPadding: getComputedStyle(controls).paddingBottom,
      gaps: [
        panelBounds.bottom - bottomInset(panel) - dockBounds.bottom,
        dockBounds.bottom - bottomInset(dock) - controlsBounds.bottom,
        ...[...controls.querySelectorAll("button")].map(
          (button) =>
            controlsBounds.bottom - bottomInset(controls) - button.getBoundingClientRect().bottom,
        ),
      ],
      buttons: [...controls.querySelectorAll("button")].map((button) =>
        button.getBoundingClientRect().toJSON(),
      ),
      dockRows: getComputedStyle(dock).gridTemplateRows,
    };
  });
  await page.screenshot({ path: screenshotPath.replace(/\.png$/i, `-fade-${state}.png`) });
  if (
    evidence.gaps.some((gap) => Math.abs(gap) > 1) ||
    parseFloat(evidence.controlPadding) <= 0 ||
    evidence.buttons.length !== 3 ||
    evidence.buttons.some((button) => button.width < 48 || button.height < 48)
  ) {
    throw new Error(
      `Fade controls must stay at the padded card bottom (${state}): ${JSON.stringify(evidence)}`,
    );
  }
  console.log(`Fade footer ${state}: ${JSON.stringify(evidence)}`);
};
const verifyUtilityToggle = async () => {
  const rail = page.locator(".live-side-panel.has-live-utilities");
  const toggle = rail.locator(".utility-panels-toggle");
  const timer = rail.locator(".timer-display");
  const originalTimer = await timer.elementHandle();
  const music = rail.locator(".youtube-dock");
  const originalMusic = await music.elementHandle();
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  const corner = await rail.evaluate((panel) => {
    const bounds = panel.getBoundingClientRect();
    return { x: bounds.left + 2, y: bounds.top + 2, width: 2, height: 2 };
  });
  const cornerBefore = await page.screenshot({ clip: corner });
  const measure = async (state) => {
    await toggle.evaluate(async (button) => {
      await Promise.all(button.getAnimations().map((animation) => animation.finished));
    });
    const evidence = await toggle.evaluate((button) => {
      const panel = button.parentElement;
      const bounds = panel.getBoundingClientRect();
      const rect = button.getBoundingClientRect();
      const outer = getComputedStyle(panel);
      const inner = getComputedStyle(button);
      return {
        edges: [
          rect.left - bounds.left - parseFloat(outer.borderLeftWidth),
          bounds.right - rect.right - parseFloat(outer.borderRightWidth),
          rect.top - bounds.top - parseFloat(outer.borderTopWidth),
        ],
        position: inner.position,
        margins: [inner.marginTop, inner.marginRight, inner.marginBottom, inner.marginLeft],
        radii: [
          inner.borderTopLeftRadius,
          inner.borderTopRightRadius,
          inner.borderBottomLeftRadius,
          inner.borderBottomRightRadius,
        ],
        transform: inner.transform,
        overflow: outer.overflowX,
        parentRadius: outer.borderTopLeftRadius,
        height: rect.height,
        focusVisible: button.matches(":focus-visible"),
        outlineWidth: inner.outlineWidth,
        outlineOffset: inner.outlineOffset,
      };
    });
    await page.screenshot({ path: screenshotPath.replace(/\.png$/i, `-toggle-${state}.png`) });
    // WebKit hit-testing ignores rounded overflow; compare the actual clipped pixels instead.
    const cornerClipped = cornerBefore.equals(await page.screenshot({ clip: corner }));
    if (
      evidence.edges.some((edge) => Math.abs(edge) > 0.1) ||
      evidence.position !== "static" ||
      evidence.transform !== "none" ||
      evidence.margins.some((margin) => parseFloat(margin) !== 0) ||
      evidence.radii.some((radius) => parseFloat(radius) !== 0) ||
      !["hidden", "clip"].includes(evidence.overflow) ||
      parseFloat(evidence.parentRadius) === 0 ||
      !cornerClipped ||
      evidence.height < 48 ||
      (state === "focus" &&
        (!evidence.focusVisible ||
          parseFloat(evidence.outlineWidth) < 2 ||
          parseFloat(evidence.outlineOffset) >= 0))
    )
      throw new Error(
        `Utility toggle must flow flush inside parent clipping (${state}): ${JSON.stringify({ ...evidence, cornerClipped })}`,
      );
    console.log(`Utility toggle ${state}: ${JSON.stringify({ ...evidence, cornerClipped })}`);
    await verifyFadeFooter(state);
  };
  await toggle.hover();
  await measure("expanded-hover");
  await page.getByRole("button", { name: "Start 60 second timer", exact: true }).click();
  await page.getByRole("button", { name: "Pause timer", exact: true }).click();
  const paused = await timer.locator("strong").innerText();
  await toggle.hover();
  await page.mouse.down();
  await measure("pressed");
  await page.mouse.up();
  await page.locator("#game-utility-panels[hidden]").waitFor({ state: "attached" });
  await measure("collapsed-hover");
  await page.keyboard.press("Tab");
  await toggle.focus();
  await measure("focus");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Resume timer", exact: true }).waitFor();
  if (
    !(await timer.evaluate((node, original) => node === original, originalTimer)) ||
    !(await music.evaluate((node, original) => node === original, originalMusic)) ||
    (await timer.locator("strong").innerText()) !== paused ||
    (await toggle.getAttribute("aria-expanded")) !== "true"
  ) {
    throw new Error("Utility toggle remounted or reset the paused timer");
  }
  await page.getByRole("button", { name: "Resume timer", exact: true }).click();
  await page.getByRole("button", { name: "Pause timer", exact: true }).waitFor();
  await toggle.press("Space");
  await page.waitForFunction(
    (before) => Number(document.querySelector(".timer-display strong").textContent) < before,
    Number(paused),
  );
  await toggle.press("Enter");
  await page.getByRole("button", { name: "Pause timer", exact: true }).click();
  const handle = music.locator(".music-panel-handle");
  await handle.click();
  await music.locator(".youtube-session-queue").waitFor();
  await verifyFadeFooter("player-expanded");
  await toggle.click();
  await verifyFadeFooter("player-expanded-utilities-hidden");
  await handle.click();
  await verifyFadeFooter("player-collapsed-utilities-hidden");
  await toggle.click();
  await verifyFadeFooter("player-collapsed");
};
const tableScreenshotPath = process.env.UI_TABLE_SCREENSHOT ?? evidencePath("table");
const sidePanelScreenshotPath = process.env.UI_SIDE_PANEL_SCREENSHOT ?? evidencePath("side-panel");
const queueTagsScreenshotPath = process.env.UI_QUEUE_TAGS_SCREENSHOT ?? evidencePath("queue-tags");
const glassScreenshotPath = process.env.UI_GLASS_SCREENSHOT ?? evidencePath("malagas-glass");
const playersScreenshotPath = process.env.UI_PLAYERS_SCREENSHOT ?? evidencePath("players");
const selectionScreenshotPath =
  process.env.UI_SELECTION_SCREENSHOT ?? evidencePath("player-selection");
const previewScreenshotPath =
  process.env.UI_HISTORY_PREVIEW_SCREENSHOT ?? evidencePath("log-preview-ipad");
const timelineScreenshotPath = process.env.UI_TIMELINE_SCREENSHOT ?? evidencePath("timeline-ipad");
const timelineRightScreenshotPath = timelineScreenshotPath.replace(/\.png$/i, "-right.png");
const carCrashScreenshotPath =
  process.env.UI_CAR_CRASH_SCREENSHOT ?? evidencePath("car-crash-zero-votes-ipad");
const testNicknames = Array.from({ length: 11 }, (_, index) => `UI Player ${index + 1}`);
const emptyStatistics = {
  hostedGames: 0,
  gamesPlayed: 0,
  wins: 0,
  losses: 0,
  redGames: 0,
  redWins: 0,
  blackGames: 0,
  blackWins: 0,
  sheriffGames: 0,
  citizenGames: 0,
  mafiaGames: 0,
  donGames: 0,
  totalFouls: 0,
  eliminations: 0,
  redCards: 0,
};
const testPlayers = testNicknames.map((nickname, index) => ({
  id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  nickname,
  consent: false,
  firstName: null,
  lastName: null,
  email: null,
  consentAt: null,
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
  lastPlayedAt: null,
  statistics: emptyStatistics,
}));
const testClub = {
  id: "00000000-0000-4000-8000-000000000101",
  name: "Mafia Malaga",
  city: "Málaga",
  headerLogo: null,
  cardLogo: null,
  language: "en",
  role: "manager",
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z",
};
const browserName = process.env.UI_BROWSER ?? "chromium";
const viewportWidth = Number(process.env.UI_VIEWPORT_WIDTH ?? "");
const viewportHeight = Number(process.env.UI_VIEWPORT_HEIGHT ?? "");
const headerOnly = process.env.UI_HEADER_ONLY === "1";
const federationOnly = process.env.UI_FEDERATION_ONLY === "1";
const privacyOnly = process.env.UI_PRIVACY_ONLY === "1";
const layoutOnly = process.env.UI_LAYOUT_ONLY === "1";
const musicOnly = process.env.UI_MUSIC_ONLY === "1";
const hardeningOnly = process.env.UI_HARDENING_ONLY === "1";
const verifyVgpuSelection = process.env.UI_VERIFY_VGPU === "1";
const browser =
  browserName === "webkit"
    ? await webkit.launch({ headless: true })
    : await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  hasTouch: headerOnly || layoutOnly || federationOnly,
  isMobile: layoutOnly && browserName === "webkit",
  viewport:
    Number.isFinite(viewportWidth) &&
    viewportWidth > 0 &&
    Number.isFinite(viewportHeight) &&
    viewportHeight > 0
      ? { width: viewportWidth, height: viewportHeight }
      : browserName === "webkit"
        ? { width: 1376, height: 1032 }
        : { width: 1366, height: 1024 },
});
const page = await context.newPage();
const pageErrors = [];
const routeErrors = [];

page.on("console", (message) =>
  console.log(
    `browser console [${message.type()}]${message.type() === "error" ? ` ${message.text()}` : ""}`,
  ),
);
page.on("pageerror", (error) => {
  pageErrors.push(error.message);
  console.error(`browser page error: ${error.message}`);
});
const assertNoPageErrors = () => {
  if (pageErrors.length > 0) {
    throw new Error(`Browser page errors occurred: ${pageErrors.join(" | ")}`);
  }
  if (routeErrors.length > 0) {
    throw new Error(`Unexpected verifier API requests occurred: ${routeErrors.join(" | ")}`);
  }
};

const measureMusic = () =>
  page.locator(".youtube-dock").evaluate((dock) => {
    const box = (element) => {
      if (!(element instanceof HTMLElement)) throw new Error("Missing music layout element");
      const { x, y, width, height, bottom } = element.getBoundingClientRect();
      return { x, y, width, height, bottom };
    };
    const queue = dock.querySelector(".youtube-session-queue");
    return {
      dock: box(dock),
      controls: [
        dock.querySelector(".music-panel-handle"),
        dock.querySelector(".live-music-controls"),
        ...dock.querySelectorAll(".live-music-controls button"),
      ].map(box),
      video: box(dock.querySelector(".youtube-player-video")),
      queue: queue ? box(queue) : null,
      queueContentHeight: queue
        ? [...queue.children].reduce((height, child) => {
            const style = getComputedStyle(child);
            return (
              height +
              child.getBoundingClientRect().height +
              parseFloat(style.marginTop) +
              parseFloat(style.marginBottom)
            );
          }, 0) +
          parseFloat(getComputedStyle(queue).paddingTop) +
          parseFloat(getComputedStyle(queue).paddingBottom) +
          1
        : 0,
      viewportHeight: innerHeight,
    };
  });

const verifyMusicExpansion = async (label, expectedRows = 5) => {
  const handle = page.getByRole("button", { name: "Music player panel handle" });
  const compact = await measureMusic();
  const player = await page.locator(".youtube-player-video").elementHandle();
  await handle.dispatchEvent("touchstart", {
    touches: [{ identifier: 3, clientX: 100, clientY: 100 }],
  });
  await handle.dispatchEvent("touchend", {
    changedTouches: [{ identifier: 3, clientX: 102, clientY: 35 }],
  });
  await page.locator(".youtube-dock.is-expanded").waitFor();
  await page.waitForFunction((count) => {
    const list = document.querySelector(".youtube-session-queue ol");
    return list !== null && list.children.length === count;
  }, expectedRows);
  const picker = page.getByRole("combobox", { name: "YouTube Music playlist" });
  await picker.waitFor();
  const headingGeometry = await page
    .locator(".youtube-session-queue-heading")
    .evaluate((header) => {
      const title = header.querySelector("h2").getBoundingClientRect();
      const select = header.querySelector("select").getBoundingClientRect();
      const bounds = header.getBoundingClientRect();
      return { title: title.toJSON(), select: select.toJSON(), bounds: bounds.toJSON() };
    });
  if (
    headingGeometry.select.left < headingGeometry.title.right ||
    headingGeometry.select.right > headingGeometry.bounds.right + 1 ||
    Math.abs(
      (headingGeometry.title.top + headingGeometry.title.bottom) / 2 -
        (headingGeometry.select.top + headingGeometry.select.bottom) / 2,
    ) > 1
  )
    throw new Error(
      `Playlist picker must fit beside Session queue: ${JSON.stringify(headingGeometry)}`,
    );
  const expanded = await measureMusic();
  await page.screenshot({
    path: screenshotPath.replace(/\.png$/i, `-music-${label}.png`),
    fullPage: true,
  });
  const near = (left, right) => Math.abs(left - right) <= 1;
  if (
    expanded.controls.some(
      (control, index) =>
        !near(control.width, compact.controls[index].width) ||
        !near(control.height, compact.controls[index].height),
    )
  ) {
    throw new Error(
      `Expanded music controls stretched (${label}): ${JSON.stringify({ compact, expanded })}`,
    );
  }
  if (
    !near(compact.dock.width, expanded.dock.width) ||
    !near(compact.dock.bottom, expanded.dock.bottom) ||
    expanded.dock.y < 0 ||
    expanded.dock.bottom > expanded.viewportHeight + 1 ||
    expanded.queue.height > expanded.queueContentHeight + 1 ||
    !near(expanded.controls[0].bottom, expanded.video.y) ||
    !near(expanded.video.bottom, expanded.queue.y) ||
    !near(expanded.queue.bottom, expanded.controls[1].y)
  ) {
    throw new Error(
      `Expanded music is not content-sized and bounded (${label}): ${JSON.stringify({ compact, expanded })}`,
    );
  }
  const queue = page.locator(".youtube-session-queue");
  const scroll = await queue.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return { top: element.scrollTop, height: element.clientHeight, content: element.scrollHeight };
  });
  if (
    expanded.queueContentHeight > expanded.queue.height + 1 &&
    (scroll.top <= 0 || Math.abs(scroll.top + scroll.height - scroll.content) > 1)
  ) {
    throw new Error(
      `Expanded queue cannot scroll to its end (${label}): ${JSON.stringify(scroll)}`,
    );
  }
  await handle.dispatchEvent("touchstart", {
    touches: [{ identifier: 4, clientX: 100, clientY: 35 }],
  });
  await handle.dispatchEvent("touchend", {
    changedTouches: [{ identifier: 4, clientX: 102, clientY: 100 }],
  });
  await page.locator(".youtube-dock:not(.is-expanded)").waitFor();
  await handle.dispatchEvent("click"); // Consume the swipe's compatibility click.
  if (await picker.isVisible()) throw new Error("Collapsed player exposes playlist picker");
  if (
    !(await player.evaluate(
      (element) =>
        element.isConnected && element === document.querySelector(".youtube-player-video"),
    ))
  ) {
    throw new Error("Expansion remounted the music player");
  }
  console.log(`Music geometry PASS (${label}): ${JSON.stringify({ compact, expanded, scroll })}`);
};

const namedControlRules = [
  "aria-allowed-attr",
  "aria-command-name",
  "aria-dialog-name",
  "aria-hidden-focus",
  "aria-input-field-name",
  "aria-required-attr",
  "aria-required-children",
  "aria-required-parent",
  "aria-roles",
  "aria-toggle-field-name",
  "aria-valid-attr-value",
  "aria-valid-attr",
  "button-name",
  "frame-title",
  "input-button-name",
  "label",
  "link-name",
  "select-name",
];
const assertAccessibleControls = async (label) => {
  const { violations } = await new AxeBuilder({ page }).withRules(namedControlRules).analyze();
  if (violations.length === 0) return;
  throw new Error(
    `${label} has unnamed or invalid controls: ${JSON.stringify(
      violations.map(({ id, nodes }) => ({
        id,
        targets: nodes.flatMap(({ target }) => target),
      })),
    )}`,
  );
};
const coreTargetSelectors = [
  ".app-fixed-toolbar button",
  ".player-seat",
  ".seat-actions button",
  ".table-advance button",
  ".timer-panel button",
  ".nomination-panel button",
  ".panel-swipe-handle",
  ".live-music-controls button",
  ".table-swipe-menu button",
];
const assertCoreTargets = async (label, selectors = coreTargetSelectors) => {
  const undersized = await page.evaluate((selectors) => {
    return [...document.querySelectorAll(selectors.join(","))]
      .filter((element) => element instanceof HTMLElement && element.getClientRects().length > 0)
      .map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          label:
            element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.className,
          width: bounds.width,
          height: bounds.height,
        };
      })
      .filter(({ width, height }) => width < 47.9 || height < 47.9);
  }, selectors);
  if (undersized.length > 0)
    throw new Error(`${label} has core targets below 48px: ${JSON.stringify(undersized)}`);
};
const assertCoreLayout = async (label, selectors = coreTargetSelectors) => {
  const findings = await page.evaluate((selectors) => {
    const elements = [...document.querySelectorAll(selectors.join(","))].filter(
      (element) => element instanceof HTMLElement && element.getClientRects().length > 0,
    );
    const targets = elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      const seat = element.closest(".seat-anchor")?.getAttribute("data-seat");
      const name =
        element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.className;
      return {
        label: seat === null || seat === undefined ? name : `${name} [seat ${seat}]`,
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
      };
    });
    const outside = targets.filter(
      ({ left, right, top, bottom }) =>
        left < -0.1 || right > innerWidth + 0.1 || top < -0.1 || bottom > innerHeight + 0.1,
    );
    const overlaps = [];
    for (let leftIndex = 0; leftIndex < targets.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < targets.length; rightIndex += 1) {
        const left = targets[leftIndex];
        const right = targets[rightIndex];
        if (
          Math.min(left.right, right.right) - Math.max(left.left, right.left) > 0.5 &&
          Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 0.5
        )
          overlaps.push([left, right]);
      }
    }
    return {
      pageOverflow:
        document.documentElement.scrollWidth > innerWidth + 1 ||
        document.documentElement.scrollHeight > innerHeight + 1,
      outside,
      overlaps,
    };
  }, selectors);
  if (findings.pageOverflow || findings.outside.length > 0 || findings.overlaps.length > 0)
    throw new Error(
      `${label} has clipped or overlapping core controls: ${JSON.stringify(findings)}`,
    );
};
const assertVisibleFocus = async (locator, label) => {
  const nextMarker = `focus-${Date.now()}-${Math.random()}`;
  await locator.focus();
  const hasExpectedNext = await locator.evaluate((element, marker) => {
    const focusable = [
      ...document.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
      ),
    ].filter(
      (candidate) =>
        candidate instanceof HTMLElement &&
        candidate.tabIndex >= 0 &&
        candidate.getClientRects().length > 0 &&
        getComputedStyle(candidate).visibility !== "hidden",
    );
    const currentIndex = focusable.indexOf(element);
    const next = currentIndex === -1 ? undefined : focusable[(currentIndex + 1) % focusable.length];
    if (!(next instanceof HTMLElement)) return false;
    next.dataset.verifierFocusMarker = marker;
    return true;
  }, nextMarker);
  if (!hasExpectedNext) throw new Error(`${label} has no expected next focus target`);
  const forwardKey = browserName === "webkit" ? "Alt+Tab" : "Tab";
  const backwardKey = browserName === "webkit" ? "Alt+Shift+Tab" : "Shift+Tab";
  await page.keyboard.press(forwardKey);
  const movedToExpectedNext = await page.evaluate(
    (marker) =>
      document.activeElement instanceof HTMLElement &&
      document.activeElement.dataset.verifierFocusMarker === marker,
    nextMarker,
  );
  if (!movedToExpectedNext) {
    throw new Error(`${label} did not move to the next control with ${forwardKey}`);
  }
  await page.keyboard.press(backwardKey);
  await page.evaluate((marker) => {
    for (const element of document.querySelectorAll("[data-verifier-focus-marker]")) {
      if (element instanceof HTMLElement && element.dataset.verifierFocusMarker === marker)
        delete element.dataset.verifierFocusMarker;
    }
  }, nextMarker);
  if (!(await locator.evaluate((element) => document.activeElement === element))) {
    throw new Error(`${label} is not reachable in the expected focus order`);
  }
  const focus = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  if (focus.outlineStyle === "none" || Number.parseFloat(focus.outlineWidth) < 2)
    throw new Error(`${label} has no visible keyboard focus: ${JSON.stringify(focus)}`);
};

await page.addInitScript(() => {
  window.__mafiaAudioStarts = [];
  class VerifierAudioContext {
    currentTime = 5;
    destination = {};
    createOscillator() {
      return {
        frequency: { value: 0 },
        connect: () => undefined,
        disconnect: () => undefined,
        start: (when = this.currentTime) => window.__mafiaAudioStarts.push(when - this.currentTime),
        stop: () => undefined,
      };
    }
    createGain() {
      return {
        gain: {
          setValueAtTime: () => undefined,
          exponentialRampToValueAtTime: () => undefined,
        },
        connect: () => undefined,
      };
    }
    resume() {
      return Promise.resolve();
    }
  }
  Object.defineProperty(window, "AudioContext", {
    configurable: true,
    value: VerifierAudioContext,
  });
  window.__mafiaVerifierCheckpointEnvelope = async (envelope, game) => {
    const root = envelope.current.state.events.find((entry) => entry.parentEventId === null);
    if (root === undefined) throw new Error("Expected a persisted replay root");
    const canonical = (value) =>
      Array.isArray(value)
        ? value.map(canonical)
        : value === null || typeof value !== "object"
          ? value
          : Object.fromEntries(
              Object.entries(value)
                .filter(([, entry]) => entry !== undefined)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, entry]) => [key, canonical(entry)]),
            );
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(canonical(game))),
    );
    Object.assign(root, {
      sequence: 1,
      parentEventId: null,
      type: "game.checkpointed",
      payload: {},
      phaseBefore: game.phase,
      phaseAfter: game.phase,
      dayBefore: game.day,
      dayAfter: game.day,
      stateHashAfter: `sha256:${Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("")}`,
    });
    envelope.current.state.game = game;
    envelope.current.state.initialGame = { replayVersion: 1, game };
    envelope.current.state.events = [root];
    envelope.current.state.headEventId = root.id;
  };
});

// Same-origin inert document for storage fixture changes; the dev proxy need not run an API.
await page.route("**/health/ready", (route) =>
  fulfillMock(route, { contentType: "text/html", body: "<!doctype html><title>Fixture</title>" }),
);
await page.route("**/api/**", async (route) => {
  const request = route.request();
  assertExactOrigin(request.url(), expectedOrigin);
  const pathname = new URL(request.url()).pathname;
  if (!pathname.startsWith("/api/")) {
    await route.fallback();
    return;
  }
  routeErrors.push(`${request.method()} ${pathname}`);
  await fulfillMock(route, { status: 500, contentType: "application/json", body: "{}" });
});

await page.route("**/api/auth/session", async (route) => {
  await fulfillMock(route, {
    contentType: "application/json",
    body: JSON.stringify({
      configured: true,
      user: {
        id: "00000000-0000-4000-8000-000000000001",
        email: "ui@example.com",
        name: "UI Verification",
        picture: null,
      },
    }),
  });
});
await page.route("**/api/clubs", async (route) => {
  await fulfillMock(route, {
    contentType: "application/json",
    body: JSON.stringify({ clubs: [testClub] }),
  });
});
await page.route("**/api/clubs/*", async (route) => {
  const request = route.request();
  assertExactOrigin(request.url(), expectedOrigin);
  if (
    request.method() !== "PUT" ||
    new URL(request.url()).pathname !== `/api/clubs/${testClub.id}`
  ) {
    routeErrors.push(`${request.method()} ${new URL(request.url()).pathname}`);
    await fulfillMock(route, { status: 400, contentType: "application/json", body: "{}" });
    return;
  }
  const update = request.postDataJSON();
  if (update.language !== "en" && update.language !== "ru") {
    routeErrors.push("Invalid club language update");
    await fulfillMock(route, { status: 400, contentType: "application/json", body: "{}" });
    return;
  }
  Object.assign(testClub, { language: update.language });
  await fulfillMock(route, {
    contentType: "application/json",
    body: JSON.stringify({ club: testClub }),
  });
});
await page.route("**/api/music/oauth/status", async (route) => {
  await fulfillMock(route, {
    contentType: "application/json",
    body: JSON.stringify({ configured: true, connected: true, accountLabel: "ui@example.com" }),
  });
});
await page.route("**/api/music/playlists", async (route) => {
  await fulfillMock(route, {
    contentType: "application/json",
    body: JSON.stringify({
      playlists: [
        { id: "test-playlist", title: "UI Verification", itemCount: 12 },
        ...(musicOnly
          ? [0, 4, 40].map((count) => ({
              id: `test-queue-${count}`,
              title: `Geometry queue ${count}`,
              itemCount: count,
            }))
          : []),
      ],
    }),
  });
});
await page.route("**/api/music/playlists/*/items", async (route) => {
  const geometryQueue = new URL(route.request().url()).pathname.match(
    /test-queue-(0|4|40)\/items$/,
  );
  if (musicOnly && geometryQueue) {
    await fulfillMock(route, {
      contentType: "application/json",
      body: JSON.stringify({
        items: Array.from({ length: Number(geometryQueue[1]) }, (_, index) => ({
          videoId: `geometry-track-${index}`,
          title: `Geometry track ${index + 1}`,
          channelTitle: "UI verification",
          thumbnailUrl: null,
          position: index,
        })),
      }),
    });
    return;
  }
  await fulfillMock(route, {
    contentType: "application/json",
    body: JSON.stringify({
      items: [
        {
          videoId: "ui-track-1",
          title: "UI verification track",
          channelTitle: "UI verification",
          thumbnailUrl: null,
          position: 0,
        },
        {
          videoId: "ui-track-2",
          title: "UI verification middle",
          channelTitle: "UI verification",
          thumbnailUrl: null,
          position: 1,
        },
        {
          videoId: "ui-track-3",
          title: "UI verification finale",
          channelTitle: "UI verification",
          thumbnailUrl: null,
          position: 2,
        },
        {
          videoId: "ui-track-4",
          title: "UI verification opening two",
          channelTitle: "UI verification",
          thumbnailUrl: null,
          position: 3,
        },
        {
          videoId: "ui-track-5",
          title: "UI verification ordinary two",
          channelTitle: "UI verification",
          thumbnailUrl: null,
          position: 4,
        },
      ],
    }),
  });
});
await page.route("**/api/players*", async (route) => {
  if (route.request().method() !== "GET") {
    routeErrors.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    await fulfillMock(route, { status: 400, contentType: "application/json", body: "{}" });
    return;
  }
  await fulfillMock(route, {
    contentType: "application/json",
    body: JSON.stringify({ players: testPlayers }),
  });
});
const mockSessions = new Map();
let snapshotRevision = 0;
const mockSnapshot = (gameId, mutation) => {
  snapshotRevision += 1;
  const session = {
    gameId,
    name: mutation.name,
    revision: snapshotRevision,
    duplicate: false,
    status: mutation.results === null ? "active" : "completed",
    hostName: mutation.state.hostName,
    phase: mutation.state.game?.phase ?? "setup-role-draw",
    day: mutation.state.game?.day ?? 0,
    updatedAt: "2026-08-18T00:00:00.000Z",
    state: mutation.state,
    results: mutation.results,
  };
  mockSessions.set(gameId, session);
  return session;
};
await page.route("**/api/game-sessions", async (route) => {
  if (route.request().method() === "POST") {
    await fulfillMock(route, {
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(mockSnapshot(crypto.randomUUID(), route.request().postDataJSON())),
    });
    return;
  }
  if (route.request().method() !== "GET") {
    routeErrors.push(`${route.request().method()} /api/game-sessions`);
  }
  await fulfillMock(route, {
    contentType: "application/json",
    body: JSON.stringify({
      sessions: [...mockSessions.values()].filter(({ status }) => status === "active"),
    }),
  });
});
await page.route("**/api/game-sessions?*", async (route) => {
  if (route.request().method() !== "GET") {
    routeErrors.push(`${route.request().method()} /api/game-sessions?status`);
  }
  await fulfillMock(route, {
    contentType: "application/json",
    body: JSON.stringify({ sessions: [] }),
  });
});
await page.route("**/api/game-sessions/**", async (route) => {
  const request = route.request();
  const gameId = new URL(request.url()).pathname.split("/").at(-1);
  if (request.method() === "GET") {
    const session = mockSessions.get(gameId);
    await fulfillMock(route, {
      status: session === undefined ? 404 : 200,
      contentType: "application/json",
      body: JSON.stringify(session === undefined ? {} : { session }),
    });
    return;
  }
  if (request.method() === "DELETE") {
    const requestUrl = new URL(request.url());
    const validDelete =
      /^\/api\/game-sessions\/[0-9a-f-]{36}$/i.test(requestUrl.pathname) &&
      requestUrl.search === "";
    if (!validDelete) {
      routeErrors.push(`DELETE ${requestUrl.pathname}`);
      await fulfillMock(route, { status: 400, contentType: "application/json", body: "{}" });
      return;
    }
    mockSessions.delete(gameId);
    await fulfillMock(route, { status: 204, body: "" });
    return;
  }
  if (request.method() !== "PUT") {
    await fulfillMock(route, { status: 404, contentType: "application/json", body: "{}" });
    return;
  }
  const mutation = request.postDataJSON();
  const requestPath = new URL(request.url()).pathname;
  const valid =
    /^\/api\/game-sessions\/[0-9a-f-]{36}$/i.test(requestPath) &&
    typeof mutation.name === "string" &&
    typeof mutation.mutationId === "string" &&
    mutation.state !== null &&
    typeof mutation.state === "object" &&
    Object.hasOwn(mutation.state, "game") &&
    Object.hasOwn(mutation, "results");
  if (!valid) {
    routeErrors.push(`PUT ${requestPath}`);
    await fulfillMock(route, { status: 400, contentType: "application/json", body: "{}" });
    return;
  }
  await fulfillMock(route, {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(mockSnapshot(gameId, mutation)),
  });
});

const { tsImport } = await import("tsx/esm/api");
const { runFederationScenarios, legacySetupState } = await tsImport(
  "./verify-federation-ui.mjs",
  import.meta.url,
);
const federationApi = {
  sessions: mockSessions,
  clean: assertNoPageErrors,
  seed: (gameId, state) =>
    mockSnapshot(gameId, {
      name: "Federation UI verification",
      state,
      results: null,
    }),
};
const verifyFederationJourney = async () => {
  const size = page.viewportSize();
  await runFederationScenarios({
    page,
    baseUrl,
    club: testClub,
    players: testPlayers,
    api: federationApi,
    evidenceDir:
      process.env.FEDERATION_UI_EVIDENCE_DIR ??
      `.AI/federation-ui/${browserName}-${size.width}x${size.height}`,
  });
};
const restoreLegacySetup = async () => {
  // An actual edition-less unfinished setup, not a fresh-policy override.
  const state = legacySetupState();
  const gameId = crypto.randomUUID();
  federationApi.seed(gameId, state);
  await page.goto(new URL("/health/ready", expectedOrigin).href);
  await page.evaluate(
    ({ clubId, gameId, state }) => {
      localStorage.setItem(
        "mafia-dashboard.game-session.v5",
        JSON.stringify({
          version: 5,
          clubId,
          gameId,
          creationId: null,
          revision: 1,
          current: { name: "Restored legacy regression setup", state, results: null },
          outbox: [],
          failed: false,
          clearFailed: false,
          clearingGameId: null,
          removed: false,
          legacyGameId: null,
        }),
      );
    },
    { clubId: testClub.id, gameId, state },
  );
  await page.goto(browserAppUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Select 10 players + host" }).waitFor();
  await unlockDeveloperMenu(page);
};

try {
  if (federationOnly) {
    await verifyFederationJourney();
    assertNoPageErrors();
    console.log("Federation-only integrated verification: PASS");
    await browser.close();
    process.exit(0);
  }
  await page.goto(browserAppUrl, { waitUntil: "networkidle" });
  assertExactOrigin(page.url(), expectedOrigin);
  browserAppUrl = page.url();
  storageMutationUrl = new URL("/health/ready", browserAppUrl).href;
  if ((await page.title()) !== "La Verdad") throw new Error("Unexpected page title");
  const clubPortal = page.getByRole("heading", { name: "Choose your club" });
  if (await clubPortal.isVisible()) {
    await page.locator(".club-playing-card:not(.new-club-card)").first().click();
    await page.waitForTimeout(950);
  }
  await unlockDeveloperMenu(page);
  const setupHeading = page.getByRole("heading", { name: "Select 10 players + host" });
  if (!(await setupHeading.isVisible())) {
    await page.getByRole("heading", { name: "Players & statistics" }).waitFor();
    await page.getByRole("article", { name: "Player UI Player 1", exact: true }).waitFor();
    await page.screenshot({ path: playersScreenshotPath, fullPage: true });
    await page.getByRole("button", { name: "Open developer menu" }).click();
    await page.getByRole("button", { name: "Game screen" }).click();
  }
  await setupHeading.waitFor();
  await restoreLegacySetup();
  if (process.env.UI_SIDE_PANEL_ONLY === "1") {
    await verifyUtilityToggle();
    await page.getByRole("button", { name: "Select available players" }).click();
    const available = page.getByRole("button", { name: /^Mark UI Player \d+ available$/ });
    for (let index = 0; index < 11; index += 1) await available.first().click();
    await page.getByRole("button", { name: "Close available players" }).click();
    await page.getByRole("combobox", { name: "Host player" }).click();
    await page.getByRole("option", { name: "UI Player 11", exact: true }).click();
    await page.getByRole("button", { name: "Assign players" }).click();
    await page.locator(".player-setup-card").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.getByRole("button", { name: "Start game", exact: true }).click();
    await page.getByRole("heading", { name: "Role giveaway" }).waitFor();
    await verifyFadeFooter("live-collapsed");
    await verifyUtilityToggle();
    const fullscreen = page.getByRole("button", { name: "Enter fullscreen" });
    if (await fullscreen.isVisible()) {
      await fullscreen.click();
      await page.getByRole("button", { name: "Exit fullscreen" }).waitFor();
      await verifyFadeFooter("fullscreen");
      await page.getByRole("button", { name: "Exit fullscreen" }).click();
    }
    for (let index = 0; index < 10; index += 1) {
      await page
        .getByRole("button", { name: /^Draw role for / })
        .first()
        .click();
    }
    await page.getByRole("button", { name: "Begin Mafia planning stage" }).click();
    await page.getByRole("button", { name: "Continue night zero to Sheriff wake-up" }).click();
    await page.getByRole("button", { name: "Begin day one" }).click();
    for (let index = 0; index < 3; index += 1) {
      const current = await page.locator(".player-seat.is-current .seat-name").innerText();
      await page.getByRole("button", { name: `Nominate ${current}`, exact: true }).click();
      await verifyFadeFooter(`nominees-${index + 1}`);
      await page.getByRole("button", { name: "Next player", exact: true }).click();
    }
    const utilities = page.locator("#game-utility-panels");
    const scroll = await utilities.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      const bounds = element.getBoundingClientRect();
      const last = element.querySelector(".nomination-panel li:last-child").getBoundingClientRect();
      return {
        top: element.scrollTop,
        height: element.clientHeight,
        content: element.scrollHeight,
        lastVisible: last.top >= bounds.top && last.bottom <= bounds.bottom + 1,
      };
    });
    if (!scroll.lastVisible || (scroll.content > scroll.height + 1 && scroll.top <= 0)) {
      throw new Error(
        `Last nominee is not reachable above the fade footer: ${JSON.stringify(scroll)}`,
      );
    }
    await verifyFadeFooter("utilities-scrolled");
    await page.getByRole("button", { name: "Open Manage menu" }).click();
    await page.locator("#manage-menu-drawer select").selectOption("ru");
    await page.locator('html[lang="ru"]').waitFor();
    await page.locator(".manage-toolbar-button").click();
    await page.getByRole("button", { name: "Быстрое затухание музыки" }).waitFor();
    await verifyFadeFooter("russian-nominees");
    await page.locator(".music-panel-handle").click();
    await page.locator(".youtube-session-queue").waitFor();
    await verifyFadeFooter("russian-nominees-expanded");
    await page.locator(".music-panel-handle").click();
    if (browserName === "chromium") {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setSafeAreaInsetsOverride", {
        insets: { top: 0, right: 0, bottom: 34, left: 0 },
      });
      // Reload so existing padding is recomputed under the new native environment.
      await page.reload({ waitUntil: "networkidle" });
      await page.locator(".game-shell.phase-day").waitFor();
      const safeArea = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.paddingBottom = "env(safe-area-inset-bottom)";
        document.body.append(probe);
        const inset = parseFloat(getComputedStyle(probe).paddingBottom);
        probe.remove();
        return {
          inset,
          clearance:
            innerHeight -
            document.querySelector(".live-music-controls button").getBoundingClientRect().bottom,
        };
      });
      if (safeArea.inset !== 34 || safeArea.clearance < safeArea.inset) {
        throw new Error(`Fade footer lost safe-area protection: ${JSON.stringify(safeArea)}`);
      }
      await verifyFadeFooter("safe-area-34px");
      await cdp.send("Emulation.setSafeAreaInsetsOverride", {
        insets: { top: 0, right: 0, bottom: 0, left: 0 },
      });
      await page.reload({ waitUntil: "networkidle" });
      await page.locator(".game-shell.phase-day").waitFor();
      await verifyFadeFooter("safe-area-cleared");
      await cdp.detach();
    }
    assertNoPageErrors();
    console.log("Utility toggle verification: PASS");
    await browser.close();
    process.exit(0);
  }
  if (layoutOnly) {
    const { verifyIpadLayout } = await import("./verify-ipad-layout.mjs");
    await verifyIpadLayout(page, { assertVisibleFocus, assertCoreLayout, assertCoreTargets });
    assertNoPageErrors();
    console.log("iPad layout verification: PASS");
    await browser.close();
    process.exit(0);
  }
  await assertAccessibleControls("Player setup");
  const manageButton = page.getByRole("button", { name: "Open Manage menu" });
  await assertVisibleFocus(manageButton, "Manage trigger");
  await page.keyboard.press("Enter");
  const manageHeading = page.getByRole("heading", { name: "Manage", exact: true });
  await manageHeading.waitFor();
  if (!(await manageHeading.evaluate((heading) => document.activeElement === heading))) {
    throw new Error("Manage drawer did not receive focus");
  }
  await assertAccessibleControls("Manage drawer");
  await page.keyboard.press("Escape");
  if (!(await manageButton.evaluate((button) => document.activeElement === button))) {
    throw new Error("Manage trigger did not regain focus");
  }
  const saveButton = page.getByRole("button", {
    name: "Saved to server · tap to check connection",
  });
  await saveButton.waitFor();
  const saveIndicator = await saveButton.evaluate(async (button) => {
    const original = button.dataset.status;
    const colors = {};
    for (const status of ["saved", "saving", "offline"]) {
      button.dataset.status = status;
      await new Promise(window.requestAnimationFrame);
      colors[status] = getComputedStyle(button).color;
    }
    button.dataset.status = original;
    return { tagName: button.tagName, original, colors };
  });
  if (saveIndicator.tagName !== "BUTTON" || saveIndicator.original !== "saved") {
    throw new Error("The Save indicator must be an interactive saved-state button");
  }
  if (new Set(Object.values(saveIndicator.colors)).size !== 3) {
    throw new Error(
      `Saved, retrying, and offline Save colors must be visually distinct: ${JSON.stringify(saveIndicator.colors)}`,
    );
  }
  if (headerOnly) {
    if ((await page.getByText("Development only", { exact: true }).count()) !== 0) {
      throw new Error("Development-only setup tools must be hidden before Dev mode is enabled");
    }
    await page.evaluate(() => {
      console.error(new Error("Verifier console error"));
      window.dispatchEvent(
        new ErrorEvent("error", {
          message: "Verifier window error",
          error: new Error("Verifier window error"),
        }),
      );
      const rejection = new Event("unhandledrejection");
      Object.defineProperty(rejection, "reason", { value: new Error("Verifier promise error") });
      window.dispatchEvent(rejection);
    });
    await page.getByRole("button", { name: "Open developer menu" }).click();
    await page.getByRole("button", { name: "Enable dev mode" }).waitFor();
    if ((await page.getByRole("button", { name: /table center shadow/i }).count()) !== 0) {
      throw new Error("The permanent table-center shadow must not expose a Dev setting");
    }
    await page.getByRole("button", { name: "Console" }).click();
    await page.getByRole("heading", { name: "Console", exact: true }).waitFor();
    for (const message of [
      "Verifier console error",
      "Verifier window error",
      "Verifier promise error",
    ]) {
      await page.getByText(message, { exact: true }).waitFor();
    }
    const consoleGeometry = await page.locator(".error-console-screen").evaluate((screen) => {
      const box = screen.getBoundingClientRect();
      const list = screen.querySelector(".error-console-list");
      return {
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        documentHeight: document.documentElement.scrollHeight,
        listScrollable:
          list instanceof HTMLElement ? list.scrollHeight >= list.clientHeight : false,
      };
    });
    if (
      Math.abs(consoleGeometry.left) > 1 ||
      Math.abs(consoleGeometry.top) > 1 ||
      Math.abs(consoleGeometry.width - consoleGeometry.viewportWidth) > 1 ||
      Math.abs(consoleGeometry.height - consoleGeometry.viewportHeight) > 1 ||
      consoleGeometry.documentHeight > consoleGeometry.viewportHeight + 1
    ) {
      throw new Error(`Console must fill the fixed viewport: ${JSON.stringify(consoleGeometry)}`);
    }
    await page.getByRole("button", { name: "Clear console" }).click();
    await page.getByText("No errors have been captured.").waitFor();
    await page.getByRole("button", { name: "Back" }).click();
    await setupHeading.waitFor();

    await page.getByRole("button", { name: "Select available players" }).click();
    const availablePlayers = page.getByRole("button", { name: /^Mark UI Player \d+ available$/ });
    if ((await availablePlayers.count()) !== 11) {
      throw new Error("Expected eleven players in the availability picker");
    }
    for (let playerIndex = 0; playerIndex < 11; playerIndex += 1) {
      await availablePlayers.first().click();
    }
    await page.getByRole("button", { name: "Close available players" }).click();
    await page.getByRole("combobox", { name: "Host player" }).click();
    await page.getByRole("option", { name: testNicknames[10], exact: true }).click();
    await page.getByRole("button", { name: "Assign players" }).click();
    const startGame = page.getByRole("button", { name: "Start game" });
    await startGame.waitFor();
    await page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Start game" && !button.disabled,
      ),
    );
    if ((await page.getByRole("button", { name: /set up music/i }).count()) !== 0) {
      throw new Error("Music setup must not remain on the game-setup screen");
    }
    const playerSetupActions = page.getByRole("group", { name: "Player setup actions" });
    const actionRowGeometry = await playerSetupActions.getByRole("button").evaluateAll((buttons) =>
      buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return { text: button.textContent?.trim(), top: box.top, left: box.left, right: box.right };
      }),
    );
    if (
      actionRowGeometry.length !== 3 ||
      actionRowGeometry.some(({ top }) => Math.abs(top - actionRowGeometry[0].top) > 1) ||
      actionRowGeometry.some((_, index) =>
        index === 0 ? false : actionRowGeometry[index - 1].right > actionRowGeometry[index].left,
      )
    ) {
      throw new Error(
        `Player setup actions must share one non-overlapping row when labels fit: ${JSON.stringify(actionRowGeometry)}`,
      );
    }
    const wrappedActionGeometry = await playerSetupActions.evaluate((group) => {
      const previousWidth = group.style.width;
      group.style.width = "220px";
      const groupBox = group.getBoundingClientRect();
      const buttons = [...group.querySelectorAll("button")].map((button) => {
        const box = button.getBoundingClientRect();
        return { top: box.top, width: box.width };
      });
      group.style.width = previousWidth;
      return { groupWidth: groupBox.width, buttons };
    });
    const wrappedRows = wrappedActionGeometry.buttons.reduce((rows, button) => {
      const key = Math.round(button.top);
      rows.set(key, [...(rows.get(key) ?? []), button]);
      return rows;
    }, new Map());
    if (
      wrappedRows.size < 2 ||
      [...wrappedRows.values()].some(
        (row) => row.length === 1 && Math.abs(row[0].width - wrappedActionGeometry.groupWidth) > 1,
      )
    ) {
      throw new Error(
        `Wrapped player setup actions must fill singleton rows: ${JSON.stringify(wrappedActionGeometry)}`,
      );
    }
    const firstSeat = page.getByRole("combobox", { name: "Seat 1 player" });
    await page.waitForFunction(
      (input) => input instanceof HTMLInputElement && input.value !== "",
      await firstSeat.elementHandle(),
    );
    const firstSeatName = await firstSeat.inputValue();
    await page.getByRole("button", { name: "Clear Seat 1", exact: true }).click();
    if ((await firstSeat.inputValue()) !== "" || (await startGame.isEnabled())) {
      throw new Error("Clearing Seat 1 must empty the seat and disable Start game");
    }
    await firstSeat.click();
    await page.getByRole("option", { name: firstSeatName, exact: true }).click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Start game" && !button.disabled,
      ),
    );
    const playerControlGeometry = await firstSeat.evaluate((input) => {
      const control = input.closest(".player-combobox-control");
      const clear = control?.querySelector(".player-combobox-clear");
      const chevron = control?.querySelector(".player-combobox-chevron");
      if (
        !(input instanceof HTMLElement) ||
        !(clear instanceof HTMLElement) ||
        !(chevron instanceof HTMLElement)
      ) {
        throw new Error("Expected the player input, Clear button, and down arrow");
      }
      const inputBox = input.getBoundingClientRect();
      const clearBox = clear.getBoundingClientRect();
      const chevronBox = chevron.getBoundingClientRect();
      return {
        inputCenterY: inputBox.top + inputBox.height / 2,
        clearCenterY: clearBox.top + clearBox.height / 2,
        chevronCenterY: chevronBox.top + chevronBox.height / 2,
        clearRight: clearBox.right,
        chevronLeft: chevronBox.left,
      };
    });
    if (
      Math.abs(playerControlGeometry.inputCenterY - playerControlGeometry.clearCenterY) > 1 ||
      Math.abs(playerControlGeometry.inputCenterY - playerControlGeometry.chevronCenterY) > 1 ||
      playerControlGeometry.clearRight >= playerControlGeometry.chevronLeft
    ) {
      throw new Error(
        `Clear must sit left of a vertically centered arrow: ${JSON.stringify(playerControlGeometry)}`,
      );
    }
    const playerControlsScreenshotPath = screenshotPath.replace(/\.png$/i, "-player-controls.png");
    await page.screenshot({ path: playerControlsScreenshotPath, fullPage: true });

    await page.getByRole("button", { name: "Open developer menu" }).click();
    if ((await page.getByRole("button", { name: /Day\/night table indication/i }).count()) !== 0) {
      throw new Error("The static Day/night tint must not expose a Dev setting");
    }
    if ((await page.getByRole("button", { name: "Reload music player" }).count()) !== 0) {
      throw new Error("Reload music player must stay inside the music setup submenu");
    }
    await page.getByRole("button", { name: "Close developer menu" }).click();
    await page.getByRole("button", { name: "Open Manage menu" }).click();
    await page.getByRole("button", { name: "Music player setup" }).click();
    const musicSetup = page.getByRole("region", { name: "Music player setup" });
    await musicSetup.waitFor();
    await musicSetup.getByRole("button", { name: "Reload music player" }).waitFor();
    if (
      (await musicSetup.getByLabel("Low").count()) !== 0 ||
      (await musicSetup.getByLabel("High").count()) !== 0 ||
      (await musicSetup.getByRole("combobox").count()) !== 0
    ) {
      throw new Error("Music setup must expose neither playlist selection nor app volume presets");
    }
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await page.getByRole("button", { name: "Close Manage menu" }).click();
    if (await page.getByRole("button", { name: "Hide private info" }).count())
      await page.getByRole("button", { name: "Hide private info" }).click();
    await startGame.click();
    for (let roleIndex = 0; roleIndex < 10; roleIndex += 1) {
      await page
        .getByRole("button", { name: /^Draw role for / })
        .first()
        .click();
    }
    if (
      (await page.locator(".role-giveaway-table .role-badge").count()) !== 10 &&
      (await page.locator(".role-badge").count()) !== 10
    ) {
      throw new Error(
        "Deliberate role giveaway must retain all drawn role badges under the mask toggle",
      );
    }
    await page.screenshot({
      path: tableScreenshotPath.replace(/\.png$/i, "-role-giveaway.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Begin Mafia planning stage" }).click();
    await page.locator(".game-shell.is-table-cycle-night").waitFor();
    await page.waitForTimeout(620);
    await assertRolePresentation(page, {
      masked: false,
      roleLighting: true,
      phase: "mafia-planning",
    });
    const centerShadowStyle = await page.locator(".table-center").evaluate((center) => {
      const shadow = getComputedStyle(center, "::before");
      return { display: shadow.display, backgroundImage: shadow.backgroundImage };
    });
    if (
      centerShadowStyle.display === "none" ||
      !centerShadowStyle.backgroundImage.includes("radial-gradient")
    ) {
      throw new Error(
        `The permanent table-center shadow is missing: ${JSON.stringify(centerShadowStyle)}`,
      );
    }
    const nightCycleStyle = await assertSupportedTableLighting(page, "Night table lighting");
    const nightCycleScreenshotPath = tableScreenshotPath.replace(/\.png$/i, "-night-cycle.png");
    await page.screenshot({ path: nightCycleScreenshotPath, fullPage: true });
    await page.getByRole("button", { name: "Continue night zero to Sheriff wake-up" }).click();
    await page.getByRole("button", { name: "Begin day one" }).click();
    await page.locator(".game-shell.is-table-cycle-day").waitFor();
    await page.waitForTimeout(620);
    await page.locator('.save-indicator[data-status="saved"]').waitFor();
    const stateBeforePrivacy = await page.evaluate(() =>
      JSON.stringify(
        JSON.parse(localStorage.getItem("mafia-dashboard.game-session.v5")).current.state,
      ),
    );
    await assertRolePresentation(page, { masked: true, roleLighting: false, phase: "day" });
    await page.screenshot({
      path: tableScreenshotPath.replace(/\.png$/i, "-role-day-masked.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Show private info" }).click();
    await assertRolePresentation(page, { masked: false, roleLighting: false, phase: "day" });
    await page.screenshot({
      path: tableScreenshotPath.replace(/\.png$/i, "-role-day-visible.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Hide private info" }).click();
    await assertRolePresentation(page, { masked: true, roleLighting: false, phase: "day" });
    const stateAfterPrivacy = await page.evaluate(() =>
      JSON.stringify(
        JSON.parse(localStorage.getItem("mafia-dashboard.game-session.v5")).current.state,
      ),
    );
    if (stateAfterPrivacy !== stateBeforePrivacy)
      throw new Error("Daytime mask toggles changed canonical state or event hashes");
    const dayCycleStyle = await assertSupportedTableLighting(page, "Day table lighting");
    const dayCycleScreenshotPath = tableScreenshotPath.replace(/\.png$/i, "-day-cycle.png");
    await page.screenshot({ path: dayCycleScreenshotPath, fullPage: true });
    if (verifyVgpuSelection) {
      await page.getByRole("button", { name: "Open developer menu" }).click();
      if (
        (await page.locator(".app-shell").getAttribute("data-lighting-renderer-requested")) !==
        "vgpu"
      ) {
        await page.getByRole("button", { name: "Enable Raytracing" }).click();
      }
      await page.getByRole("button", { name: "Close developer menu" }).click();
      await page.waitForFunction(() => {
        const shell = document.querySelector(".app-shell");
        return (
          document.querySelector(".vgpu-table-lighting")?.getAttribute("data-vgpu-ready") ===
            "true" || shell?.getAttribute("data-vgpu-status") === "fallback"
        );
      });
      const rendererState = await assertSupportedTableLighting(page, "WebKit V-GPU selection");
      let fallbackVisible = false;
      if (rendererState.effective === "legacy") {
        await page.getByRole("button", { name: "Open developer menu" }).click();
        fallbackVisible = await page
          .getByText("V-GPU unavailable — using existing CSS")
          .isVisible();
        await page.getByRole("button", { name: "Close developer menu" }).click();
      }
      if (
        rendererState.requested !== "vgpu" ||
        (rendererState.effective !== "vgpu" &&
          (rendererState.effective !== "legacy" || !fallbackVisible))
      ) {
        throw new Error(
          `WebKit V-GPU selection did not become ready or fall back: ${JSON.stringify({ ...rendererState, fallbackVisible })}`,
        );
      }
    }
    await assertAccessibleControls("live day");
    const keyboardSeat = page.getByRole("button", {
      name: `Seat 1: ${firstSeatName}`,
      exact: true,
    });
    await keyboardSeat.focus();
    await page.keyboard.press("Shift+F10");
    const keyboardRedCard = page.getByRole("button", {
      name: `Red card ${firstSeatName}`,
      exact: true,
    });
    await keyboardRedCard.waitFor();
    if (!(await keyboardRedCard.evaluate((button) => document.activeElement === button))) {
      throw new Error("Keyboard seat actions did not move focus to the first action");
    }
    await assertCoreTargets("open player actions");
    await assertCoreLayout("open player actions");
    await page.keyboard.press("Escape");
    if (!(await keyboardSeat.evaluate((button) => document.activeElement === button))) {
      throw new Error("Closing keyboard seat actions did not restore seat focus");
    }
    await assertCoreTargets("live day");
    await assertCoreLayout("live day");

    const sidePanelGeometry = await page.evaluate(() => {
      const box = (selector) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
        const bounds = element.getBoundingClientRect();
        return {
          left: bounds.left,
          right: bounds.right,
          top: bounds.top,
          bottom: bounds.bottom,
          width: bounds.width,
          height: bounds.height,
        };
      };
      const style = (selector) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
        const computed = getComputedStyle(element);
        return {
          borderTopLeftRadius: Number.parseFloat(computed.borderTopLeftRadius),
          borderTopRightRadius: Number.parseFloat(computed.borderTopRightRadius),
          borderLeftWidth: Number.parseFloat(computed.borderLeftWidth),
          borderRightWidth: Number.parseFloat(computed.borderRightWidth),
          borderTopWidth: Number.parseFloat(computed.borderTopWidth),
          borderBottomWidth: Number.parseFloat(computed.borderBottomWidth),
        };
      };
      const rail = document.querySelector(".live-side-panel.has-live-utilities");
      if (!(rail instanceof HTMLElement)) throw new Error("Missing unified live side panel");
      return {
        main: box(".table-workspace"),
        rail: box(".live-side-panel.has-live-utilities"),
        upperGrip: box(".utility-panels-toggle"),
        timerSection: box('.utility-panel-section[data-panel="timer"]'),
        votingSection: box('.utility-panel-section[data-panel="voting"]'),
        timer: box(".timer-panel"),
        voting: box(".nomination-panel"),
        music: box(".live-side-panel .youtube-dock"),
        railStyle: style(".live-side-panel.has-live-utilities"),
        upperGripStyle: style(".utility-panels-toggle"),
        votingStyle: style('.utility-panel-section[data-panel="voting"]'),
        musicStyle: style(".live-side-panel .youtube-dock"),
        handles: [...rail.querySelectorAll(".panel-swipe-handle")].map((element) => {
          const bounds = element.getBoundingClientRect();
          return { width: bounds.width, height: bounds.height };
        }),
        viewportWidth: innerWidth,
        documentHeight: document.documentElement.scrollHeight,
        viewportHeight: innerHeight,
      };
    });
    const near = (actual, expected, tolerance = 1) => Math.abs(actual - expected) <= tolerance;
    const railContent = {
      left: sidePanelGeometry.rail.left + sidePanelGeometry.railStyle.borderLeftWidth,
      right: sidePanelGeometry.rail.right - sidePanelGeometry.railStyle.borderRightWidth,
      top: sidePanelGeometry.rail.top + sidePanelGeometry.railStyle.borderTopWidth,
      bottom: sidePanelGeometry.rail.bottom - sidePanelGeometry.railStyle.borderBottomWidth,
      width:
        sidePanelGeometry.rail.width -
        sidePanelGeometry.railStyle.borderLeftWidth -
        sidePanelGeometry.railStyle.borderRightWidth,
    };
    const expectedSidePanelGeometry =
      sidePanelGeometry.viewportWidth >= 1160
        ? { edge: 14, mainWidth: 918, gap: 14, railWidth: 406 }
        : { edge: 7, mainWidth: sidePanelGeometry.viewportWidth - 356, gap: 7, railWidth: 335 };
    if (
      !near(sidePanelGeometry.main.left, expectedSidePanelGeometry.edge) ||
      !near(sidePanelGeometry.main.width, expectedSidePanelGeometry.mainWidth) ||
      !near(
        sidePanelGeometry.rail.left - sidePanelGeometry.main.right,
        expectedSidePanelGeometry.gap,
      ) ||
      !near(sidePanelGeometry.rail.width, expectedSidePanelGeometry.railWidth) ||
      !near(
        sidePanelGeometry.viewportWidth - sidePanelGeometry.rail.right,
        expectedSidePanelGeometry.edge,
      )
    ) {
      throw new Error(
        `Unified side-panel geometry violates its approved viewport contract: ${JSON.stringify({
          expectedSidePanelGeometry,
          sidePanelGeometry,
        })}`,
      );
    }
    if (
      !near(sidePanelGeometry.timer.left - sidePanelGeometry.rail.left, 8) ||
      !near(sidePanelGeometry.rail.right - sidePanelGeometry.timer.right, 8) ||
      !near(sidePanelGeometry.voting.left - sidePanelGeometry.rail.left, 8) ||
      !near(sidePanelGeometry.rail.right - sidePanelGeometry.voting.right, 8) ||
      !near(sidePanelGeometry.music.width, railContent.width)
    ) {
      throw new Error(
        `Integrated pane widths violate the utility-inset/music-flush contract: ${JSON.stringify(
          sidePanelGeometry,
        )}`,
      );
    }
    if (
      !near(sidePanelGeometry.upperGrip.left, railContent.left, 0.1) ||
      !near(sidePanelGeometry.upperGrip.right, railContent.right, 0.1) ||
      !near(sidePanelGeometry.upperGrip.top, railContent.top, 0.1) ||
      !near(sidePanelGeometry.music.left, railContent.left, 0.1) ||
      !near(sidePanelGeometry.music.right, railContent.right, 0.1) ||
      !near(sidePanelGeometry.music.bottom, railContent.bottom, 0.1)
    ) {
      throw new Error(
        `Top grip and music must meet the pane edges: ${JSON.stringify(sidePanelGeometry)}`,
      );
    }
    if (
      sidePanelGeometry.upperGripStyle.borderTopLeftRadius !== 0 ||
      sidePanelGeometry.upperGripStyle.borderTopRightRadius !== 0 ||
      sidePanelGeometry.musicStyle.borderLeftWidth !== 0 ||
      sidePanelGeometry.musicStyle.borderRightWidth !== 0 ||
      sidePanelGeometry.musicStyle.borderBottomWidth !== 0
    ) {
      throw new Error(
        `Pane edge radii and music chrome are not integrated: ${JSON.stringify(sidePanelGeometry)}`,
      );
    }
    if (
      sidePanelGeometry.votingStyle.borderTopWidth !== 0 ||
      sidePanelGeometry.votingSection.top - sidePanelGeometry.timerSection.bottom < 28
    ) {
      throw new Error(
        `Voting must be borderless and separated from the timer by 28px: ${JSON.stringify(
          sidePanelGeometry,
        )}`,
      );
    }
    if (
      sidePanelGeometry.handles.length !== 2 ||
      sidePanelGeometry.handles.some(({ width, height }) => width < 44 || height < 44)
    ) {
      throw new Error(
        `Panel swipe handles are not touch-sized: ${JSON.stringify(sidePanelGeometry)}`,
      );
    }
    if (sidePanelGeometry.documentHeight > sidePanelGeometry.viewportHeight + 1) {
      throw new Error(
        `Music is not pinned inside a non-scrolling rail: ${JSON.stringify(sidePanelGeometry)}`,
      );
    }

    await page.getByRole("button", { name: "Hide timer and voting" }).click();
    await page.locator("#game-utility-panels[hidden]").waitFor({ state: "attached" });
    await page.getByRole("button", { name: "Show timer and voting" }).click();
    await page.getByRole("region", { name: "Timer controls" }).waitFor();
    await page.getByRole("region", { name: "Voting order" }).waitFor();

    const musicHandle = page.getByRole("button", { name: "Music player panel handle" });
    const playerNodeId = await page.locator(".youtube-player-video").evaluate((player) => {
      player.dataset.verifierNode = crypto.randomUUID();
      return player.dataset.verifierNode;
    });
    await page.screenshot({ path: sidePanelScreenshotPath, fullPage: true });
    if (hardeningOnly) {
      // The matrix must reach live ballot controls; the rail geometry alone is insufficient.
      const currentName = await page.locator(".player-seat.is-current .seat-name").innerText();
      await page.getByRole("button", { name: `Nominate ${currentName}`, exact: true }).click();
      await page.getByRole("button", { name: "Next player" }).click();
      const otherName = await page.locator(".player-seat.is-current .seat-name").innerText();
      await page.getByRole("button", { name: `Nominate ${otherName}`, exact: true }).click();
      while (await page.getByRole("button", { name: "Next player" }).count()) {
        await page.getByRole("button", { name: "Next player" }).click();
      }
      await page.getByRole("button", { name: "Begin voting" }).click();
      await assertVoteCountTypography(page);
      await assertAccessibleControls("Matrix ballot");
      await assertCoreTargets("Matrix ballot");
      const voteGeometry = await page.locator(".table-vote-center").evaluate((center) => {
        const count = center.querySelector("span:last-child")?.getBoundingClientRect();
        const advance = document.querySelector(".table-advance button")?.getBoundingClientRect();
        const identity = center.querySelector(".voting-candidate-identity");
        const original = identity.textContent;
        try {
          // Exercise the permitted three-line identity, not a randomly short drawn name.
          identity.textContent = "#10 A candidate with a longer display name";
          return {
            countBottom: count?.bottom ?? 0,
            advanceTop: advance?.top ?? 0,
            longNameCountBottom: center.querySelector("span:last-child").getBoundingClientRect()
              .bottom,
          };
        } finally {
          identity.textContent = original;
        }
      });
      if (
        Math.max(voteGeometry.countBottom, voteGeometry.longNameCountBottom) + 4 >
        voteGeometry.advanceTop
      ) {
        await page.screenshot({
          path: tableScreenshotPath.replace(/\.png$/i, "-count-overlap.png"),
        });
        const settledGeometry = await page
          .locator(".table-vote-center")
          .evaluate(async (center) => {
            await document.fonts.ready;
            await Promise.all(
              document
                .getAnimations()
                .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
                .map((animation) => animation.finished.catch(() => undefined)),
            );
            const count = center.querySelector("span:last-child").getBoundingClientRect();
            const advance = document.querySelector(".table-advance button").getBoundingClientRect();
            return {
              countBottom: count.bottom,
              advanceTop: advance.top,
              text: center.textContent,
              transform: getComputedStyle(center).transform,
              rootFont: getComputedStyle(document.documentElement).fontSize,
              zoom: getComputedStyle(document.documentElement).zoom,
            };
          });
        console.log(
          "Count overlap after fonts/transitions settled:",
          JSON.stringify(settledGeometry),
        );
        throw new Error(
          `Voting count is obscured by the next action: ${JSON.stringify(voteGeometry)}`,
        );
      }
      await page.screenshot({
        path: tableScreenshotPath.replace(/\.png$/i, "-ballot-before-layout.png"),
        fullPage: true,
      });
      const ballotSelectors = coreTargetSelectors.filter(
        (selector) => selector !== ".live-music-controls button",
      );
      await assertCoreLayout("Matrix ballot", ballotSelectors);
      if (viewportWidth === 1000) {
        const scroll = await page
          .locator(".live-side-panel.has-live-utilities")
          .evaluate((panel) => {
            panel.scrollTop = panel.scrollHeight;
            return {
              scrolled: panel.scrollTop,
              content: panel.scrollHeight,
              height: panel.clientHeight,
            };
          });
        if (scroll.scrolled <= 0 || scroll.content <= scroll.height) {
          throw new Error(
            `Compact multi-nominee rail cannot scroll to music controls: ${JSON.stringify(scroll)}`,
          );
        }
        await assertCoreLayout("Matrix compact rail music", [".live-music-controls button"]);
        await page.locator(".live-side-panel.has-live-utilities").evaluate((panel) => {
          panel.scrollTop = 0;
        });
      } else {
        await assertCoreLayout("Matrix ballot");
      }
      const order = page.getByRole("region", { name: "Voting order" });
      const candidates = order.getByRole("button");
      if ((await candidates.count()) !== 2) throw new Error("Expected two selectable nominees");
      const first = await candidates.nth(0).innerText();
      const last = await candidates.nth(1).innerText();
      const snapshot = () =>
        page.evaluate(
          () => JSON.parse(localStorage.getItem("mafia-dashboard.game-session.v5")).current.state,
        );
      const beforeNavigation = await snapshot();
      await assertVisibleFocus(candidates.nth(0), "First nominee");
      await page.keyboard.press("Enter");
      if ((await candidates.nth(0).getAttribute("aria-pressed")) !== "true") {
        throw new Error("Keyboard nominee selection did not set a non-color pressed state");
      }
      if (await page.getByRole("button", { name: "Finish voting" }).isEnabled()) {
        throw new Error("Selecting the first nominee must not finish an unassigned ballot");
      }
      if ((await snapshot()).events.length !== beforeNavigation.events.length) {
        throw new Error("Nominee navigation unexpectedly appended a canonical game event");
      }
      const voterSeat = await page
        .locator(".player-seat:not(.is-inactive)")
        .first()
        .evaluate((card) => card.closest("[data-seat]")?.getAttribute("data-seat"));
      if (voterSeat === undefined || voterSeat === null)
        throw new Error("No eligible matrix voter");
      const voter = page.locator(`.seat-anchor[data-seat="${voterSeat}"] .player-seat`);
      const voterName = await voter.locator(".seat-name").innerText();
      await assertVisibleFocus(voter, "Ballot voter");
      await page.keyboard.press("Enter");
      await page
        .getByRole("button", { name: new RegExp(`^${voterName} voted for seat `) })
        .waitFor();
      if (!(await voter.getAttribute("aria-label"))?.includes("voted for seat")) {
        throw new Error(
          `Keyboard ballot selection has no explicit voter status: ${await voter.getAttribute("aria-label")}`,
        );
      }
      await voter.click();
      if (!(await voter.getAttribute("aria-label"))?.startsWith("Vote as ")) {
        throw new Error("Tapping selected voter did not remove the assignment");
      }
      await candidates.nth(1).click();
      const finish = page.getByRole("button", { name: "Finish voting" });
      if (!(await finish.isEnabled()))
        throw new Error("Deliberate last nominee selection did not fill the remainder");
      await voter.click();
      if (await finish.isEnabled())
        throw new Error("Removing automatic remainder must reopen the ballot");
      await page.locator('.save-indicator[data-status="saved"]').waitFor();
      await page.reload();
      await page.getByRole("group", { name: "Voting candidate" }).waitFor();
      if (await finish.isEnabled()) throw new Error("Refresh silently refilled a removed voter");
      const reloadedOrder = page.getByRole("region", { name: "Voting order" });
      await reloadedOrder.getByRole("button", { name: first }).click();
      const ballotVoter = page.getByRole("button", {
        name: new RegExp(`^Vote as ${voterName} for `),
      });
      await ballotVoter.click();
      if (!(await finish.isEnabled()))
        throw new Error("Corrected earlier nominee ballot is incomplete");
      await assertAccessibleControls("Matrix corrected ballot");
      await assertCoreTargets("Matrix corrected ballot");
      await assertCoreLayout(
        "Matrix corrected ballot",
        viewportWidth === 1000 ? ballotSelectors : coreTargetSelectors,
      );
      await page.screenshot({
        path: tableScreenshotPath.replace(/\.png$/i, "-corrected-ballot.png"),
        fullPage: true,
      });
      const beforeFinish = await snapshot();
      if (beforeFinish.game.phase !== "voting")
        throw new Error("Nominee jump implied voting completion");
      await page.getByRole("button", { name: "Open Manage menu" }).click();
      await page.locator("#manage-menu-drawer select").selectOption("ru");
      await page.locator('html[lang="ru"]').waitFor();
      await page.locator(".game-shell.phase-voting").waitFor();
      if (JSON.stringify(await snapshot()) !== JSON.stringify(beforeFinish)) {
        throw new Error("Club language change mutated the canonical ballot");
      }
      await page.locator(".manage-toolbar-button").click();
      await assertCoreTargets("Matrix Russian ballot");
      await assertCoreLayout(
        "Matrix Russian ballot",
        viewportWidth === 1000 ? ballotSelectors : coreTargetSelectors,
      );
      await page.screenshot({
        path: tableScreenshotPath.replace(/\.png$/i, "-russian-ballot.png"),
        fullPage: true,
      });
      await page.locator(".manage-toolbar-button").click();
      await page.locator("#manage-menu-drawer select").selectOption("en");
      await page.locator('html[lang="en"]').waitFor();
      await page.getByRole("button", { name: "Close Manage menu" }).click();
      if (JSON.stringify(await snapshot()) !== JSON.stringify(beforeFinish)) {
        throw new Error("Switching back to English mutated the canonical ballot");
      }
      await page.emulateMedia({ reducedMotion: "reduce" });
      const motion = await page
        .locator(".nomination-panel li.is-voting-highlight")
        .evaluate((item) => ({
          item: getComputedStyle(item).animationName,
          halo: getComputedStyle(item, "::after").animationName,
        }));
      if (motion.item !== "none" || motion.halo !== "none") {
        throw new Error(
          `Reduced motion still animates the selected nominee: ${JSON.stringify(motion)}`,
        );
      }
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await assertVisibleFocus(finish, "Finish voting");
      await page.keyboard.press("Enter");
      if ((await snapshot()).game.phase === "voting")
        throw new Error("Finish voting did not resolve the corrected ballot");
      console.log(
        `Matrix ballot correction: PASS (${browserName} ${viewportWidth}x${viewportHeight}, ${first}, ${last})`,
      );
      if (await page.getByRole("button", { name: "Hide private info" }).count()) {
        await page.getByRole("button", { name: "Hide private info" }).click();
      }
      const previewPhase = (await snapshot()).game.phase;
      await assertRolePresentation(page, {
        masked: true,
        roleLighting: false,
        phase: previewPhase,
      });
      const previewBefore = JSON.stringify(await snapshot());
      await page.getByRole("button", { name: "Open game log" }).click();
      await page.getByRole("button", { name: "Preview state after log #2" }).click();
      await page.getByRole("heading", { name: /preview/i }).waitFor();
      if (
        await page
          .locator(".table-advance button")
          .filter({ hasText: /Finish voting|Finish the game/ })
          .count()
      ) {
        throw new Error("Preview exposed a live Finish action");
      }
      if (await page.getByLabel("Application tools").count()) {
        throw new Error("Preview exposed live host actions");
      }
      await page.locator(".game-shell.is-history-preview.phase-day").waitFor();
      await assertRolePresentation(page, {
        masked: true,
        roleLighting: false,
        phase: "day",
      });
      await page.screenshot({
        path: tableScreenshotPath.replace(/\.png$/i, "-read-only-preview.png"),
        fullPage: true,
      });
      await page.getByRole("button", { name: "Exit preview" }).click();
      if (JSON.stringify(await snapshot()) !== previewBefore)
        throw new Error("Read-only preview changed canonical state");
      console.log(
        `Matrix preview/privacy/reduced motion: PASS (${browserName} ${viewportWidth}x${viewportHeight})`,
      );
      // A rooted near-win is only a precondition: the winning shot, Undo and Finish
      // below must all be real host actions (never a fixture-injected outcome).
      await page.goto(storageMutationUrl, { waitUntil: "domcontentloaded" });
      const targetSeat = await page.evaluate(async () => {
        const key = "mafia-dashboard.game-session.v5";
        const envelope = JSON.parse(localStorage.getItem(key));
        const game = structuredClone(envelope.current.state.initialGame.game);
        const citizens = game.players.filter((player) => player.team === "red");
        if (
          citizens.length !== 7 ||
          game.players.filter((player) => player.team === "black").length !== 3
        ) {
          throw new Error("Near-win fixture needs the ten-player 7:3 draw");
        }
        const victim = citizens.find((player) => player.role === "citizen");
        if (victim === undefined)
          throw new Error("Near-win fixture needs an active citizen target");
        const retained = new Set([
          victim.seat,
          ...citizens
            .filter((player) => player.seat !== victim.seat)
            .slice(0, 3)
            .map((player) => player.seat),
        ]);
        game.players = game.players.map((player) =>
          player.team === "red" && !retained.has(player.seat)
            ? { ...player, status: "eliminated" }
            : player,
        );
        game.phase = "night-mafia";
        game.day = 2;
        game.currentTurnIndex = 0;
        game.winner = null;
        game.shotAssignments = {};
        game.voteAssignments = {};
        game.nominations = [];
        await window.__mafiaVerifierCheckpointEnvelope(envelope, game);
        envelope.current.state.resetReturnEventId = null;
        envelope.current.results = null;
        envelope.outbox = [];
        envelope.failed = false;
        localStorage.setItem(key, JSON.stringify(envelope));
        return victim.seat;
      });
      await page.goto(browserAppUrl, { waitUntil: "networkidle" });
      if ((await page.locator(".club-playing-card:not(.new-club-card)").count()) > 0) {
        await page.locator(".club-playing-card:not(.new-club-card)").first().click();
      }
      await page.locator(".game-shell.phase-night-mafia").waitFor();
      for (const mask of ["Show private info", "Hide private info"]) {
        const toggle = page.getByRole("button", { name: mask });
        if (await toggle.count()) await toggle.click();
        await assertRolePresentation(page, {
          masked: false,
          roleLighting: true,
          phase: "night-mafia",
        });
      }
      const threeShooterEnvelope = await page.evaluate(() =>
        localStorage.getItem("mafia-dashboard.game-session.v5"),
      );
      if (threeShooterEnvelope === null) throw new Error("Missing rooted three-shooter state");
      for (const remaining of [2, 1]) {
        await page.goto(storageMutationUrl, { waitUntil: "domcontentloaded" });
        await page.evaluate(
          async ({ raw, remaining }) => {
            const envelope = JSON.parse(raw);
            const game = structuredClone(envelope.current.state.initialGame.game);
            const shooters = game.players.filter((player) => player.team === "black");
            if (shooters.length !== 3)
              throw new Error("Reduced-shooter fixture needs three original Mafia");
            const eliminated = new Set(shooters.slice(remaining).map((player) => player.seat));
            game.players = game.players.map((player) =>
              eliminated.has(player.seat) ? { ...player, status: "eliminated" } : player,
            );
            await window.__mafiaVerifierCheckpointEnvelope(envelope, game);
            envelope.outbox = [];
            envelope.failed = false;
            localStorage.setItem("mafia-dashboard.game-session.v5", JSON.stringify(envelope));
          },
          { raw: threeShooterEnvelope, remaining },
        );
        await page.goto(browserAppUrl, { waitUntil: "networkidle" });
        if ((await page.locator(".club-playing-card:not(.new-club-card)").count()) > 0)
          await page.locator(".club-playing-card:not(.new-club-card)").first().click();
        await page.locator(".game-shell.phase-night-mafia").waitFor();
        const reducedButtons = page.locator(".seat-actions .shooter-button");
        if ((await reducedButtons.count()) !== remaining * 10)
          throw new Error(`Expected ${remaining} shooter controls per target`);
        await assertCoreTargets(`Matrix ${remaining}-shooter night`);
        await assertCoreLayout(`Matrix ${remaining}-shooter night`);
        await page.screenshot({
          path: tableScreenshotPath.replace(/\.png$/i, `-night-${remaining}-shooters.png`),
          fullPage: true,
        });
        console.log(
          `Matrix ${remaining}-shooter night layout: PASS (${browserName} ${viewportWidth}x${viewportHeight})`,
        );
      }
      await page.goto(storageMutationUrl, { waitUntil: "domcontentloaded" });
      await page.evaluate(
        (raw) => localStorage.setItem("mafia-dashboard.game-session.v5", raw),
        threeShooterEnvelope,
      );
      await page.goto(browserAppUrl, { waitUntil: "networkidle" });
      if ((await page.locator(".club-playing-card:not(.new-club-card)").count()) > 0)
        await page.locator(".club-playing-card:not(.new-club-card)").first().click();
      await page.locator(".game-shell.phase-night-mafia").waitFor();
      await assertAccessibleControls("Matrix deciding night");
      if ((await page.locator(".seat-actions .shooter-button").count()) !== 30)
        throw new Error("Restored deciding night did not expose three shooters per target");
      await page.screenshot({
        path: tableScreenshotPath.replace(/\.png$/i, "-night-shooters.png"),
        fullPage: true,
      });
      await assertCoreTargets("Matrix deciding night action");
      await assertCoreLayout("Matrix deciding night action");
      const individualShot = page
        .locator(`.seat-anchor[data-seat="${targetSeat}"] .shooter-button`)
        .first();
      await individualShot.click();
      if ((await individualShot.getAttribute("aria-pressed")) !== "true")
        throw new Error("Individual shooter target did not indicate selection");
      await individualShot.click();
      if ((await individualShot.getAttribute("aria-pressed")) !== "false")
        throw new Error("Individual shooter target did not clear selection");
      const nearWin = await snapshot();
      const shoot = async () => {
        await page.locator(`.seat-anchor[data-seat="${targetSeat}"] .player-seat`).click();
        await page.getByRole("button", { name: "Evaluate Mafia shots" }).click();
        await page.locator(".game-shell.phase-night-mafia-result").waitFor();
        await page.getByRole("button", { name: "Continue night" }).click();
        await page.locator(".game-shell.phase-finished").waitFor();
        const result = await snapshot();
        if (result.game.winner !== "black" || result.events.length <= nearWin.events.length) {
          throw new Error("The deciding night action did not produce a canonical black win");
        }
        await page.screenshot({
          path: tableScreenshotPath.replace(/\.png$/i, "-night-win.png"),
          fullPage: true,
        });
      };
      await shoot();
      await assertAccessibleControls("Matrix pending outcome");
      await assertCoreTargets("Matrix pending outcome");
      await assertCoreLayout("Matrix pending outcome");
      const undo = page.getByRole("button", { name: /^Undo last action/ });
      if (!(await undo.isEnabled())) throw new Error("Winning action prematurely locked Undo");
      await assertVisibleFocus(undo, "Pending outcome Undo");
      await page.keyboard.press("Enter");
      await page.locator(".game-shell.phase-night-mafia-result").waitFor();
      if ((await snapshot()).game.winner !== null)
        throw new Error("Undo did not retract the night win");
      await page.getByRole("button", { name: "Continue night" }).click();
      await page.locator(".game-shell.phase-finished").waitFor();
      if ((await snapshot()).game.winner !== "black")
        throw new Error("Repeating the decisive Continue did not restore the win");
      console.log(
        "Matrix finish controls",
        JSON.stringify(await page.locator(".table-advance button").allTextContents()),
        JSON.stringify(await page.locator(".save-indicator").getAttribute("data-status")),
      );
      const finishGame = page.getByRole("button", { name: "Finish the game" });
      await assertVisibleFocus(finishGame, "Finish game");
      const completionAttempts = [];
      let completedGameId = null;
      await page.route("**/api/game-sessions/**", async (route) => {
        const request = route.request();
        if (request.method() !== "PUT") return route.fallback();
        const mutation = request.postDataJSON();
        if (mutation.results === null) return route.fallback();
        completedGameId = new URL(request.url()).pathname.split("/").at(-1);
        completionAttempts.push(mutation);
        if (completionAttempts.length !== 1) return route.fallback();
        await fulfillMock(route, {
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: "Verifier rejected first completion snapshot" }),
        });
      });
      await page.keyboard.press("Enter");
      const blockedSave = page.getByRole("button", { name: /^Save blocked ·/ });
      await blockedSave.waitFor();
      if (await undo.isEnabled()) throw new Error("Rejected Finish did not lock Undo");
      if (await page.getByRole("button", { name: "Game upload blocked" }).isEnabled())
        throw new Error("Rejected Finish still permits completion");
      const blockedEnvelope = await page.evaluate(() =>
        JSON.parse(localStorage.getItem("mafia-dashboard.game-session.v5")),
      );
      if (
        blockedEnvelope.current.results?.winner !== "black" ||
        blockedEnvelope.outbox.length !== 1 ||
        blockedEnvelope.current.state.events.filter(({ type }) => type === "game.completed")
          .length !== 1
      )
        throw new Error(
          "Rejected completion did not retain one terminal event and pending snapshot",
        );
      await page.getByRole("button", { name: "Open game log" }).click();
      await page.getByRole("button", { name: "Preview state after log #1" }).click();
      if (await page.getByRole("button", { name: "Reset game to this state" }).isEnabled())
        throw new Error("Rejected Finish permitted a destructive Reset");
      await page.getByRole("button", { name: "Exit preview" }).click();
      await blockedSave.click();
      await page.getByRole("heading", { name: "Select 10 players + host" }).waitFor();
      if (
        completionAttempts.length !== 2 ||
        new Set(completionAttempts.map(({ mutationId }) => mutationId)).size !== 1
      )
        throw new Error("Retry did not reuse exactly one completion mutation");
      const completedSession = mockSessions.get(completedGameId);
      if (
        completedSession?.results?.winner !== "black" ||
        completedSession.state.events.filter(({ type }) => type === "game.completed").length !== 1
      )
        throw new Error("Retry did not persist exactly one completed result and event");
      if (
        (await page.evaluate(() => localStorage.getItem("mafia-dashboard.game-session.v5"))) !==
        null
      )
        throw new Error("Acknowledged completion left local game state behind");
      console.log(
        `Matrix rejected Finish, locked Undo/Reset, retry: PASS (${browserName} ${viewportWidth}x${viewportHeight})`,
      );
      console.log(
        `Matrix night outcome, Undo, repeat, Finish: PASS (${browserName} ${viewportWidth}x${viewportHeight}; target ${targetSeat})`,
      );
      assertNoPageErrors();
      console.log(
        `UI hardening verification: PASS (${viewportWidth}x${viewportHeight}, ${browserName})`,
      );
      await browser.close();
      process.exit(0);
    }
    await musicHandle.dispatchEvent("touchstart", {
      touches: [{ identifier: 4, clientX: 100, clientY: 100 }],
    });
    await musicHandle.dispatchEvent("touchend", {
      changedTouches: [{ identifier: 4, clientX: 102, clientY: 35 }],
    });
    await page.locator(".youtube-dock.is-expanded").waitFor();
    await musicHandle.dispatchEvent("touchstart", {
      touches: [{ identifier: 5, clientX: 100, clientY: 35 }],
    });
    await musicHandle.dispatchEvent("touchend", {
      changedTouches: [{ identifier: 5, clientX: 102, clientY: 100 }],
    });
    await page.locator(".youtube-dock:not(.is-expanded)").waitFor();
    const playerNodeAfterGestures = await page
      .locator(".youtube-player-video")
      .getAttribute("data-verifier-node");
    if (playerNodeAfterGestures !== playerNodeId) {
      throw new Error("Panel gestures remounted the persistent music player");
    }

    await page.waitForFunction(() => {
      const rail = document.querySelector(".live-side-panel.has-live-utilities");
      const surface = rail;
      if (!(rail instanceof HTMLElement) || !(surface instanceof HTMLElement)) return false;
      const style = getComputedStyle(surface);
      const computedFilter = style.backdropFilter || style.webkitBackdropFilter || "";
      return surface.classList.contains("glass-surface") && computedFilter.includes("blur");
    });
    const glassEvidence = await page.evaluate(() => {
      const rail = document.querySelector(".live-side-panel.has-live-utilities");
      const surface = rail;
      if (!(surface instanceof HTMLElement)) throw new Error("Live rail glass surface is missing");
      const style = getComputedStyle(surface);
      const computedFilter = style.backdropFilter || style.webkitBackdropFilter || "";
      const filterReference = computedFilter.match(/url\((?:["']?)([^"')]+)(?:["']?)\)/)?.[1];
      const encodedFilterId = filterReference?.slice(filterReference.lastIndexOf("#") + 1);
      const filterId = encodedFilterId ? decodeURIComponent(encodedFilterId) : null;
      const matchingFilter = filterId === null ? null : document.getElementById(filterId);
      const filterBelongsToRail =
        rail instanceof HTMLElement &&
        matchingFilter?.namespaceURI === "http://www.w3.org/2000/svg" &&
        matchingFilter.localName === "filter" &&
        rail.contains(matchingFilter);
      const railBounds = rail?.getBoundingClientRect();
      const visible = (selector) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) return false;
        const bounds = element.getBoundingClientRect();
        return (
          bounds.width > 0 && bounds.height > 0 && getComputedStyle(element).display !== "none"
        );
      };
      return {
        mode: surface.className,
        computedFilter,
        filterId,
        matchingFilterId: filterBelongsToRail ? matchingFilter.id : null,
        playerNode: document
          .querySelector(".youtube-player-video")
          ?.getAttribute("data-verifier-node"),
        rail: railBounds
          ? {
              left: railBounds.left,
              top: railBounds.top,
              width: railBounds.width,
              height: railBounds.height,
            }
          : null,
        timerVisible: visible(".timer-panel"),
        votingVisible: visible(".nomination-panel"),
        musicVisible: visible(".youtube-dock"),
      };
    });
    if (
      !glassEvidence.mode.includes("glass-surface") ||
      !glassEvidence.computedFilter.includes("blur") ||
      glassEvidence.playerNode !== playerNodeId ||
      glassEvidence.rail === null ||
      !near(glassEvidence.rail.left, sidePanelGeometry.rail.left) ||
      !near(glassEvidence.rail.top, sidePanelGeometry.rail.top) ||
      !near(glassEvidence.rail.width, sidePanelGeometry.rail.width) ||
      !near(glassEvidence.rail.height, sidePanelGeometry.rail.height) ||
      !glassEvidence.timerVisible ||
      !glassEvidence.votingVisible ||
      !glassEvidence.musicVisible
    ) {
      throw new Error(`Live glass rail is invalid: ${JSON.stringify(glassEvidence)}`);
    }
    await page.screenshot({ path: glassScreenshotPath, fullPage: true });

    const durableBeforePreview = await page.evaluate(() =>
      localStorage.getItem("mafia-dashboard.game-session.v5"),
    );
    const persistedCheckpoint = JSON.parse(durableBeforePreview ?? "null");
    const persistedEvents = Array.isArray(persistedCheckpoint?.current?.state.events)
      ? persistedCheckpoint.current.state.events
      : [];
    const intermediateEvents = persistedEvents.filter(
      (event) =>
        event?.type === "turn.completed" ||
        (event?.type === "phase.changed" &&
          ["sheriff-wake", "night-don", "night-sheriff", "best-move"].includes(event?.payload?.to)),
    );
    if (persistedEvents.length !== 2 || intermediateEvents.length !== 0) {
      throw new Error(
        `Initial Night and Day must persist only root + Day checkpoints: ${JSON.stringify(
          persistedEvents.map(({ type, payload }) => ({ type, payload })),
        )}`,
      );
    }
    const rootCheckpoint = persistedEvents[0];
    const dayCheckpoint = persistedEvents[1];
    if (
      rootCheckpoint?.phaseAfter !== "mafia-planning" ||
      rootCheckpoint.dayAfter !== 0 ||
      dayCheckpoint?.phaseAfter !== "day" ||
      dayCheckpoint.dayAfter !== 1
    ) {
      throw new Error(
        "Preview verifier fixtures do not describe the canonical root and Day 1 states",
      );
    }
    await page.getByRole("button", { name: "Open game log" }).click();
    await page.getByRole("button", { name: "Preview state after log #1" }).click();
    await page.getByRole("heading", { name: /preview/i }).waitFor();
    await page.getByRole("heading", { name: "Night zero · Mafia free seating" }).waitFor();
    const previewActions = await page
      .locator("main button:not([disabled]):visible")
      .allTextContents();
    if (
      JSON.stringify(previewActions.map((text) => text.trim())) !==
      JSON.stringify(["Exit preview", "Reset game to this state"])
    ) {
      throw new Error(
        `Preview game surface must expose exactly Exit and Reset: ${JSON.stringify(previewActions)}`,
      );
    }
    await page.getByRole("region", { name: "Timer controls" }).waitFor();
    await page.getByRole("region", { name: "Voting order" }).waitFor();
    if ((await page.getByLabel("Application tools").count()) !== 0) {
      throw new Error("Application toolbar must be unavailable during history preview");
    }
    await page.screenshot({ path: previewScreenshotPath, fullPage: true });
    await page.getByRole("button", { name: "Exit preview" }).click();
    await page.getByRole("heading", { name: "Day 1" }).waitFor();
    const durableAfterPreview = await page.evaluate(() =>
      localStorage.getItem("mafia-dashboard.game-session.v5"),
    );
    if (durableAfterPreview !== durableBeforePreview) {
      throw new Error("Read-only preview changed the durable game head, revision, or outbox");
    }

    await page.getByRole("button", { name: "Open developer menu" }).click();
    await page.getByRole("button", { name: "Enable dev mode" }).click();
    await page.getByRole("button", { name: "Past game timeline" }).click();
    await page.getByRole("heading", { name: "Game timeline" }).waitFor();
    await page.getByText(/Checkpoint #2$/).waitFor();
    if ((await page.locator(".timeline-marker").count()) !== 2) {
      throw new Error("The current Timeline must contain exactly root and Day checkpoints");
    }
    const hiddenLivePanel = page.locator(".live-side-panel[hidden]");
    await hiddenLivePanel.waitFor({ state: "attached" });
    if (await hiddenLivePanel.isVisible()) {
      throw new Error("Hidden live controls must not render over the timeline at any breakpoint");
    }
    await page.getByRole("button", { name: "Phase: day" }).click();
    await page.getByRole("button", { name: "Preview timeline checkpoint" }).click();
    await page.getByRole("heading", { name: /preview/i }).waitFor();
    await page.getByRole("heading", { name: "Day 1" }).waitFor();
    await page.getByRole("button", { name: "Exit preview" }).click();
    await page.getByRole("heading", { name: "Day 1" }).waitFor();

    await page.getByRole("button", { name: "Open developer menu" }).click();
    await page.getByRole("button", { name: "Past game timeline" }).click();
    await page.getByRole("heading", { name: "Game timeline" }).waitFor();
    await page.getByRole("button", { name: "Imported game checkpoint" }).click();
    const resetTarget = rootCheckpoint;
    if (resetTarget === undefined || persistedCheckpoint.headEventId === null) {
      throw new Error("Reset verifier fixture has no canonical target or active head");
    }
    const resetSave = page.waitForResponse((response) => {
      if (response.request().method() !== "PUT") return false;
      const requestPath = new URL(response.url()).pathname;
      const snapshot = response.request().postDataJSON();
      return (
        requestPath === `/api/game-sessions/${persistedCheckpoint.gameId}` &&
        snapshot?.state?.headEventId === resetTarget.id &&
        snapshot?.state?.resetReturnEventId === null &&
        snapshot?.state?.events?.at(-1)?.id === resetTarget.id
      );
    });
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Reset game to timeline checkpoint" }).click();
    await page.getByRole("heading", { name: "Night zero · Mafia free seating" }).waitFor();
    if (!(await resetSave).ok()) throw new Error("Destructive snapshot Reset failed");

    await page.getByRole("button", { name: "Open developer menu" }).click();
    await page.getByRole("button", { name: "Past game timeline" }).click();
    await page.getByRole("heading", { name: "Game timeline" }).waitFor();
    await page.getByRole("button", { name: "Generate sample game data" }).click();
    if (
      (await page.getByRole("button", { name: /show private info|hide private info/i }).count()) !==
        0 ||
      (await page.getByText(/Scroll timeline/i).count()) !== 0 ||
      (await page.getByText("Visibility", { exact: true }).count()) !== 0 ||
      (await page.getByRole("button", { name: "Private event" }).count()) !== 0
    ) {
      throw new Error("Timeline still exposes retired private-view, Scroll, or Visibility chrome");
    }
    if ((await page.getByRole("button", { name: /Don checked/i }).count()) === 0) {
      throw new Error(
        "Timeline must show real host-secret check labels without private-view redaction",
      );
    }
    for (const label of [
      "Initial night",
      "Day 1",
      "Voting 1",
      "Night 1",
      "Day 2",
      "Voting 2",
      "Night 2",
    ]) {
      await page.getByText(label, { exact: true }).waitFor();
    }
    const timelineGeometry = await page.evaluate(() => ({
      documentScroll: document.scrollingElement?.scrollHeight ?? 0,
      viewportHeight: innerHeight,
      markerCount: document.querySelectorAll(".timeline-marker").length,
      regionCount: document.querySelectorAll(".timeline-region").length,
    }));
    if (
      timelineGeometry.documentScroll > timelineGeometry.viewportHeight + 1 ||
      timelineGeometry.markerCount !== 23 ||
      timelineGeometry.regionCount !== 7
    ) {
      throw new Error(
        `Timeline geometry/contents are invalid: ${JSON.stringify(timelineGeometry)}`,
      );
    }
    await page.screenshot({ path: timelineScreenshotPath, fullPage: true });
    await page.locator(".timeline-track-scroll").evaluate((track) => {
      track.scrollLeft = track.scrollWidth;
    });
    await page.screenshot({ path: timelineRightScreenshotPath, fullPage: true });
    await page.getByRole("button", { name: /back/i }).click();
    await page.getByRole("heading", { name: "Night zero · Mafia free seating" }).waitFor();
    await page.getByRole("button", { name: "Continue night zero to Sheriff wake-up" }).click();
    await page.getByRole("button", { name: "Begin day one" }).click();
    await page.getByRole("heading", { name: "Day 1" }).waitFor();

    for (const seconds of [60, 30, 10]) {
      await page.getByRole("button", { name: `Start ${seconds} second timer` }).click();
      await page.getByRole("button", { name: "Pause timer" }).click();
    }
    const timerAudioStarts = await page.evaluate(() => window.__mafiaAudioStarts);
    if (
      timerAudioStarts.length !== 3 ||
      timerAudioStarts.some((delay, index) => Math.abs(delay - [50, 20, 0][index]) > 0.001)
    ) {
      throw new Error(`Timer warning chimes were not scheduled at 10 seconds: ${timerAudioStarts}`);
    }

    if ((await page.getByRole("button", { name: /^Red card / }).count()) !== 0) {
      throw new Error("Day player cards must not expose a direct red-card button");
    }
    if ((await page.locator(".table-center button").count()) !== 0) {
      throw new Error("Day table center must not contain a Start player turn button");
    }
    const actionGeometry = await page
      .locator(".seat-anchor")
      .first()
      .evaluate((anchor) => {
        const card = anchor.querySelector(".player-seat")?.getBoundingClientRect();
        const actions = anchor.querySelector(".seat-actions")?.getBoundingClientRect();
        const buttons = [...anchor.querySelectorAll(".seat-actions button")].map((button) =>
          button.getBoundingClientRect(),
        );
        return {
          cardWidth: card?.width ?? 0,
          actionsWidth: actions?.width ?? 0,
          buttonWidths: buttons.map(({ width }) => width),
          buttonHeights: buttons.map(({ height }) => height),
          column:
            getComputedStyle(anchor.querySelector(".seat-actions")).flexDirection === "column",
          stacked: buttons.length === 2 && buttons[0].bottom <= buttons[1].top + 1,
          bottom: actions?.bottom ?? 0,
          workspaceBottom: document.querySelector(".table-workspace").getBoundingClientRect()
            .bottom,
        };
      });
    if (
      actionGeometry.buttonWidths.length !== 2 ||
      actionGeometry.buttonHeights.some((height) => height < 47.99) ||
      actionGeometry.bottom > actionGeometry.workspaceBottom + 1 ||
      (actionGeometry.column
        ? !actionGeometry.stacked || actionGeometry.buttonWidths.some((width) => width < 47.99)
        : Math.abs(actionGeometry.actionsWidth - actionGeometry.cardWidth) > 1 ||
          actionGeometry.buttonWidths.some(
            (width) => Math.abs(width - actionGeometry.actionsWidth / 2) > 1,
          ))
    ) {
      throw new Error(
        `Foul and Vote must fit as a split row or touch-size compact column: ${JSON.stringify(actionGeometry)}`,
      );
    }

    const firstPlayerCard = page.locator(".player-seat.is-current");
    const firstPlayerLabel = await firstPlayerCard.getAttribute("aria-label");
    const firstPlayerMatch = firstPlayerLabel?.match(/^Seat (\d+): (.+)$/);
    if (firstPlayerMatch === undefined || firstPlayerMatch === null) {
      throw new Error(`Could not identify the first speaker: ${firstPlayerLabel ?? "missing"}`);
    }
    const firstPlayerName = firstPlayerMatch[2];
    await firstPlayerCard.dispatchEvent("touchstart", {
      touches: [{ identifier: 1, clientX: 20, clientY: 50 }],
    });
    await firstPlayerCard.dispatchEvent("touchend", {
      changedTouches: [{ identifier: 1, clientX: 82, clientY: 52 }],
    });
    await page.getByRole("button", { name: `Red card ${firstPlayerName}`, exact: true }).waitFor();
    const swipeMenuGeometry = await page.locator(".table-swipe-menu").evaluate((menu) => {
      const style = getComputedStyle(menu);
      const redCard = menu.querySelector(".table-swipe-red-card");
      if (!(redCard instanceof HTMLElement) || menu.children.length !== 1) {
        throw new Error("Expected only the red-card button in the swipe action");
      }
      const redCardStyle = getComputedStyle(redCard);
      return {
        background: style.backgroundColor,
        borderWidth: style.borderTopWidth,
        paddingLeft: style.paddingLeft,
        backdrop: document.querySelector("body > .table-swipe-backdrop") !== null,
        redCardBorderRadius: redCardStyle.borderRadius,
      };
    });
    if (
      swipeMenuGeometry.background !== "rgba(0, 0, 0, 0)" ||
      swipeMenuGeometry.borderWidth !== "0px" ||
      swipeMenuGeometry.paddingLeft !== "0px" ||
      !swipeMenuGeometry.backdrop ||
      swipeMenuGeometry.redCardBorderRadius !== "10px"
    ) {
      throw new Error(
        `Swipe action must be just the red button above a viewport backdrop: ${JSON.stringify(swipeMenuGeometry)}`,
      );
    }
    const swipeMenuScreenshotPath = tableScreenshotPath.replace(/\.png$/i, "-swipe-menu.png");
    await page.screenshot({ path: swipeMenuScreenshotPath, fullPage: true });
    await page.locator(".table-swipe-backdrop").click({ position: { x: 5, y: 5 } });
    if ((await page.locator(".table-swipe-menu").count()) !== 0) {
      throw new Error("Outside click did not dismiss the red-card action");
    }

    const nominatorCard = page.locator(".player-seat.is-current");
    const nominatorLabel = await nominatorCard.getAttribute("aria-label");
    const nominatorMatch = nominatorLabel?.match(/^Seat (\d+): (.+)$/);
    if (nominatorMatch === undefined || nominatorMatch === null) {
      throw new Error(`Could not identify the next speaker: ${nominatorLabel ?? "missing"}`);
    }
    const nominatorSeat = Number(nominatorMatch[1]);
    const nominatorName = nominatorMatch[2];
    await page.getByRole("button", { name: `Foul ${nominatorName}`, exact: true }).click();
    await page.getByRole("button", { name: `Nominate ${nominatorName}`, exact: true }).click();
    await page
      .getByText(`Initiated by #${nominatorSeat} ${nominatorName}`, { exact: true })
      .waitFor();
    const showPrivateInfo = page.getByRole("button", { name: "Show private info" });
    if ((await showPrivateInfo.count()) > 0) await showPrivateInfo.click();
    const statusLayout = await nominatorCard.evaluate((card) => {
      const name = card.querySelector(".seat-name");
      const badges = card.querySelector(".seat-badges");
      if (!(name instanceof HTMLElement) || !(badges instanceof HTMLElement)) {
        throw new Error("Expected separate nickname and status-pill containers");
      }
      const cardBox = card.getBoundingClientRect();
      const nameBox = name.getBoundingClientRect();
      const badgeBoxes = [...badges.children].map((badge) => badge.getBoundingClientRect());
      return {
        nickname: name.textContent,
        nameHeight: nameBox.height,
        nameInsideCard: nameBox.top >= cardBox.top && nameBox.bottom <= cardBox.bottom,
        badgeCount: badgeBoxes.length,
        badgeRows: new Set(badgeBoxes.map(({ top }) => Math.round(top))).size,
        flexWrap: getComputedStyle(badges).flexWrap,
      };
    });
    if (
      statusLayout.nickname !== nominatorName ||
      statusLayout.nameHeight <= 0 ||
      !statusLayout.nameInsideCard ||
      statusLayout.badgeCount !== 3 ||
      statusLayout.badgeRows >= statusLayout.badgeCount ||
      statusLayout.flexWrap !== "wrap"
    ) {
      throw new Error(
        `Nickname must remain visible while three status pills wrap: ${JSON.stringify(statusLayout)}`,
      );
    }
    await page.screenshot({ path: tableScreenshotPath, fullPage: true });

    const nextPlayer = page.getByRole("button", { name: "Next player" });
    await nextPlayer.click();
    const secondNominatorCard = page.locator(".player-seat.is-current");
    const secondNominatorLabel = await secondNominatorCard.getAttribute("aria-label");
    const secondNominatorMatch = secondNominatorLabel?.match(/^Seat (\d+): (.+)$/);
    if (secondNominatorMatch === undefined || secondNominatorMatch === null) {
      throw new Error(
        `Could not identify the second speaker: ${secondNominatorLabel ?? "missing"}`,
      );
    }
    await page
      .getByRole("button", { name: `Nominate ${secondNominatorMatch[2]}`, exact: true })
      .click();
    while ((await nextPlayer.count()) > 0) await nextPlayer.click();
    await page.getByRole("button", { name: "Begin voting" }).click();
    const votingCandidate = page.getByRole("group", { name: "Voting candidate" });
    await votingCandidate.waitFor();
    await assertVoteCountTypography(page);
    const votingText = await votingCandidate.innerText();
    if (!votingText.includes(`#${nominatorSeat} ${nominatorName}`)) {
      throw new Error(`Voting candidate must include seat and name: ${votingText}`);
    }
    if ((await page.getByRole("button", { name: /^Foul / }).count()) !== 10) {
      throw new Error("Voting must show a Foul button above every active player card");
    }
    const toggleVoterIndex = await page
      .locator(".player-seat")
      .evaluateAll((cards) => cards.findIndex((card) => !card.classList.contains("is-inactive")));
    if (toggleVoterIndex < 0) throw new Error("Expected an unassigned voter card");
    const toggleVoter = page.locator(".player-seat").nth(toggleVoterIndex);
    await toggleVoter.click();
    const selectedAfterFirstTap = await toggleVoter.evaluate((card) =>
      card.classList.contains("is-current"),
    );
    await toggleVoter.click();
    const voteToggleState = {
      selectedAfterFirstTap,
      selectedAfterSecondTap: await toggleVoter.evaluate((card) =>
        card.classList.contains("is-current"),
      ),
      labelAfterSecondTap: await toggleVoter.getAttribute("aria-label"),
      candidateTextAfterSecondTap: await votingCandidate.innerText(),
    };
    if (
      !voteToggleState.selectedAfterFirstTap ||
      voteToggleState.selectedAfterSecondTap ||
      !voteToggleState.labelAfterSecondTap?.startsWith("Vote as ") ||
      !voteToggleState.candidateTextAfterSecondTap.includes("0 votes")
    ) {
      throw new Error(
        `Tapping a voting card twice must remove its vote: ${JSON.stringify(voteToggleState)}`,
      );
    }
    await toggleVoter.click();
    await page.locator(".player-seat:not(.is-inactive)").first().click();
    const votingHighlight = page.locator(".player-seat.is-current");
    if ((await votingHighlight.count()) !== 2) {
      throw new Error("Every voter for the current candidate must remain highlighted");
    }
    await page.waitForTimeout(320);
    const votingHighlightStyle = await assertSupportedPlayerLighting(
      votingHighlight.first(),
      "Selected voting card",
    );
    const votingScreenshotPath = tableScreenshotPath.replace(/\.png$/i, "-voting.png");
    await page.screenshot({ path: votingScreenshotPath, fullPage: true });
    await page.getByRole("button", { name: "Next candidate" }).click();
    const autoVotingHighlight = page.locator(".player-seat.is-current");
    if ((await autoVotingHighlight.count()) !== 8) {
      throw new Error("Every auto-assigned voter for the final candidate must be highlighted");
    }
    const autoVotingScreenshotPath = tableScreenshotPath.replace(/\.png$/i, "-voting-auto.png");
    await page.screenshot({ path: autoVotingScreenshotPath, fullPage: true });
    const finishVoting = page.getByRole("button", { name: "Finish voting" });
    if (!(await finishVoting.isEnabled())) throw new Error("A complete ballot must be finishable");
    const removedVoter = autoVotingHighlight.first();
    const removedVoterName = await removedVoter.locator(".seat-name").innerText();
    const removedSeat = await removedVoter.evaluate((card) =>
      Number(card.closest("[data-seat]")?.getAttribute("data-seat")),
    );
    await removedVoter.click();
    if ((await finishVoting.isEnabled()) || (await autoVotingHighlight.count()) !== 7) {
      throw new Error("Removing an automatic assignment must leave an incomplete ballot");
    }
    await page.waitForFunction((seat) => {
      const snapshot = localStorage.getItem("mafia-dashboard.game-session.v5");
      if (snapshot === null) return false;
      const saved = JSON.parse(snapshot);
      return (
        saved.current?.state?.game?.phase === "voting" &&
        saved.current.state.game.voteAssignments[seat] === undefined
      );
    }, removedSeat);
    await page.reload();
    await page.getByRole("group", { name: "Voting candidate" }).waitFor();
    if (
      (await finishVoting.isEnabled()) ||
      (await page
        .getByRole("button", { name: `Vote as ${removedVoterName} for ${secondNominatorMatch[2]}` })
        .count()) !== 1
    ) {
      throw new Error("Reload must retain a removed vote without refilling it");
    }
    const order = page.getByRole("region", { name: "Voting order" });
    await order.getByRole("button", { name: `#${nominatorSeat} ${nominatorName}` }).click();
    if (await finishVoting.isEnabled())
      throw new Error("Selecting an earlier nominee must not refill votes");
    await order
      .getByRole("button", { name: `#${secondNominatorMatch[1]} ${secondNominatorMatch[2]}` })
      .click();
    if (!(await finishVoting.isEnabled()) || (await autoVotingHighlight.count()) !== 8) {
      throw new Error(
        "Deliberately reselecting the last nominee must refill only the unassigned remainder",
      );
    }
    await page
      .getByRole("button", {
        name: `${removedVoterName} voted for seat ${secondNominatorMatch[1]}`,
      })
      .click();
    await order.getByRole("button", { name: `#${nominatorSeat} ${nominatorName}` }).click();
    if (await finishVoting.isEnabled())
      throw new Error("Removing after reselection must stay unassigned");
    await page
      .getByRole("button", { name: `Vote as ${removedVoterName} for ${nominatorName}` })
      .click();
    if (!(await finishVoting.isEnabled()))
      throw new Error("Correction on an earlier nominee must complete the ballot");
    const corrected = page.getByRole("button", {
      name: `${removedVoterName} voted for seat ${nominatorSeat}`,
    });
    if (
      (await corrected.count()) !== 1 ||
      (await page.locator(".player-seat.is-current").count()) !== 3
    ) {
      throw new Error(
        "Reassigned voter must have one assignment and be highlighted for the selected nominee",
      );
    }
    await order
      .getByRole("button", { name: `#${secondNominatorMatch[1]} ${secondNominatorMatch[2]}` })
      .click();
    // Leave the complete ballot open: a disciplinary red card still cancels voting.
    // Pick an auto-assigned citizen: a randomized Don/Sheriff red card changes the
    // later check stages, which this verifier exercises independently.
    const redCardTargetSeat = await page.evaluate((candidateSeat) => {
      const raw = localStorage.getItem("mafia-dashboard.game-session.v5");
      if (raw === null) throw new Error("Expected a saved ballot");
      const game = JSON.parse(raw).current?.state?.game;
      const citizen = game?.players?.find(
        (player) =>
          player.role === "citizen" &&
          player.status === "active" &&
          player.fouls === 0 &&
          game.voteAssignments[player.seat] === candidateSeat,
      );
      if (citizen === undefined) throw new Error("Expected an auto-assigned active citizen");
      return citizen.seat;
    }, Number(secondNominatorMatch[1]));
    const redCardTarget = page.locator(
      `.seat-anchor[data-seat="${redCardTargetSeat}"] .player-seat.is-current`,
    );
    const redCardTargetName = await redCardTarget.locator(".seat-name").innerText();
    // Auto-assigned voters are inactive for swipe actions; a fourth foul still red-cards
    // an active player and must cancel voting.
    for (let foul = 0; foul < 4; foul += 1) {
      await page.getByRole("button", { name: `Foul ${redCardTargetName}`, exact: true }).click();
    }
    const cancellation = page.getByRole("status", { name: "Voting cancelled" });
    await cancellation.waitFor();
    if (
      !(await cancellation.innerText()).includes(
        "A player received a red card, so voting is cancelled for this day.",
      )
    ) {
      throw new Error("The cancelled voting screen must explain the red-card reason");
    }
    const cancellationScreenshotPath = tableScreenshotPath.replace(
      /\.png$/i,
      "-voting-cancelled.png",
    );
    await page.screenshot({ path: cancellationScreenshotPath, fullPage: true });
    await page.getByRole("button", { name: "Begin night" }).click();
    await page.getByRole("heading", { name: "Mafia shots" }).waitFor();
    await assertRolePresentation(page, { masked: false, roleLighting: true, phase: "night-mafia" });
    await page.screenshot({
      path: tableScreenshotPath.replace(/\.png$/i, "-role-night-visible.png"),
      fullPage: true,
    });
    if (privacyOnly) {
      assertNoPageErrors();
      console.log("Focused voting typography and phase-aware role presentation: PASS");
      await browser.close();
      process.exit(0);
    }
    const shotLogCount = page.locator(".log-toolbar-button .toolbar-count");
    const logCountBeforeShots = Number(await shotLogCount.innerText());
    const firstShot = page.getByRole("button", { name: /^Assign shooter \d+ to target / }).first();
    await firstShot.click();
    const selectedShot = page.locator(".shooter-button.is-selected");
    if ((await selectedShot.count()) !== 1 || !(await selectedShot.isEnabled())) {
      throw new Error("A selected Mafia shot must stay enabled so it can be toggled off");
    }
    const shotToggleScreenshotPath = tableScreenshotPath.replace(
      /\.png$/i,
      "-mafia-shot-toggle.png",
    );
    await page.screenshot({ path: shotToggleScreenshotPath, fullPage: true });
    await selectedShot.click();
    if (
      (await page.locator(".shooter-button.is-selected").count()) !== 0 ||
      Number(await shotLogCount.innerText()) !== logCountBeforeShots
    ) {
      throw new Error("Toggling Mafia shots must not write to the game log");
    }
    const shooterCount = await page
      .locator(".seat-anchor")
      .first()
      .locator(".shooter-button")
      .count();
    const targetCard = page.locator("button.player-seat.status-active:has(.role-citizen)").first();
    await targetCard.click();
    if ((await page.locator(".shooter-button.is-selected").count()) !== shooterCount) {
      throw new Error("Clicking a player card must assign every active Mafia shot");
    }
    await targetCard.click();
    if ((await page.locator(".shooter-button.is-selected").count()) !== 0) {
      throw new Error("Clicking the selected player card again must clear every Mafia shot");
    }
    await targetCard.click();
    if (Number(await shotLogCount.innerText()) !== logCountBeforeShots) {
      throw new Error("Assigning Mafia shots must not write to the game log");
    }
    await page.locator('.save-indicator[data-status="saved"]').waitFor();
    const durableBeforeNightTimeline = await page.evaluate(() =>
      localStorage.getItem("mafia-dashboard.game-session.v5"),
    );
    await page.getByRole("button", { name: "Open developer menu" }).click();
    await page.getByRole("button", { name: "Past game timeline" }).click();
    await page.getByRole("heading", { name: "Game timeline" }).waitFor();
    if ((await page.locator(".timeline-marker").count()) === 0) {
      const diagnostics = await page.locator(".timeline-screen").evaluate((screen) => ({
        currentGame: screen.querySelector('select[aria-label="Completed game"]')?.value,
        text: screen.textContent?.slice(0, 500),
      }));
      await page.getByRole("button", { name: "Back" }).click();
      await page.getByRole("button", { name: "Open developer menu" }).click();
      await page.getByRole("button", { name: "Console" }).click();
      diagnostics.console = (await page.locator(".error-console-screen").innerText()).slice(-1800);
      diagnostics.history = await page.evaluate(() => {
        const raw = localStorage.getItem("mafia-dashboard.game-session.v5");
        if (raw === null) return null;
        const state = JSON.parse(raw).current?.state;
        return {
          baseline: state?.initialGame?.game && {
            phase: state.initialGame.game.phase,
            day: state.initialGame.game.day,
          },
          headEventId: state?.headEventId,
          displayed: state?.game && {
            phase: state.game.phase,
            day: state.game.day,
            currentTurnIndex: state.game.currentTurnIndex,
            voteAssignments: state.game.voteAssignments,
          },
          events: state?.events?.map((entry) => ({
            id: entry.id,
            type: entry.type,
            payload: entry.payload,
            phaseBefore: entry.phaseBefore,
            phaseAfter: entry.phaseAfter,
            dayBefore: entry.dayBefore,
            dayAfter: entry.dayAfter,
            stateHashAfter: entry.stateHashAfter,
          })),
        };
      });
      throw new Error(`Current game timeline has no markers: ${JSON.stringify(diagnostics)}`);
    }
    await page.locator(".timeline-marker").first().click();
    await page.getByRole("button", { name: "Back" }).click();
    await page.getByRole("heading", { name: "Mafia shots" }).waitFor();
    const evaluateShots = page.getByRole("button", { name: "Evaluate Mafia shots" });
    const assignmentSummary = await page.locator(".table-night-center strong").innerText();
    const selectedAfterTimeline = await page.locator(".shooter-button.is-selected").count();
    const evaluateDisabled = await evaluateShots.isDisabled();
    const durableAfterNightTimeline = await page.evaluate(() =>
      localStorage.getItem("mafia-dashboard.game-session.v5"),
    );
    const beforeDraft = JSON.parse(durableBeforeNightTimeline ?? "null");
    const afterDraft = JSON.parse(durableAfterNightTimeline ?? "null");
    const changedEnvelopeFields = Object.keys(afterDraft ?? {}).filter(
      (key) => JSON.stringify(beforeDraft?.[key]) !== JSON.stringify(afterDraft[key]),
    );
    const changedStateFields = Object.keys(afterDraft?.current?.state ?? {}).filter(
      (key) =>
        JSON.stringify(beforeDraft?.current?.state?.[key]) !==
        JSON.stringify(afterDraft.current.state[key]),
    );
    if (
      selectedAfterTimeline !== shooterCount ||
      assignmentSummary !== `${shooterCount} of ${shooterCount} shooters assigned` ||
      evaluateDisabled ||
      changedEnvelopeFields.some((field) => field !== "revision" && field !== "outbox") ||
      changedStateFields.length > 0 ||
      (afterDraft?.outbox?.length ?? 0) > (beforeDraft?.outbox?.length ?? 0)
    ) {
      throw new Error(
        `Timeline browsing stranded the Mafia draft: ${JSON.stringify({ assignmentSummary, shooterCount, selectedAfterTimeline, evaluateDisabled, changedEnvelopeFields, changedStateFields })}`,
      );
    }
    const acceptedShotRequest = page.waitForRequest((request) => {
      if (request.method() !== "PUT") return false;
      if (!/\/api\/game-sessions\/[^/]+$/.test(new URL(request.url()).pathname)) return false;
      return request.postDataJSON().state?.events?.at(-1)?.type === "mafia.shots-resolved";
    });
    await evaluateShots.click();
    const acceptedShotEvent = (await acceptedShotRequest).postDataJSON().state.events.at(-1);
    if (
      acceptedShotEvent?.replayVersion !== 1 ||
      acceptedShotEvent?.type !== "mafia.shots-resolved" ||
      typeof acceptedShotEvent?.parentEventId !== "string" ||
      !Number.isInteger(acceptedShotEvent?.sequence) ||
      acceptedShotEvent.sequence < 2 ||
      !/^sha256:[0-9a-f]{64}$/.test(acceptedShotEvent?.stateHashAfter ?? "") ||
      !Array.isArray(acceptedShotEvent?.payload?.shots) ||
      acceptedShotEvent.payload.shots.length !== shooterCount ||
      acceptedShotEvent.payload.shots.some(
        ({ shooterSeat, targetSeat, secret }) =>
          !Number.isInteger(shooterSeat) || !Number.isInteger(targetSeat) || secret !== true,
      ) ||
      typeof acceptedShotEvent?.payload?.result?.kind !== "string"
    ) {
      throw new Error("Mafia evaluation emitted an invalid canonical private event");
    }
    if ((await page.getByRole("button", { name: "Re-evaluate Mafia shots" }).count()) !== 0) {
      throw new Error("Mafia result must not offer Re-evaluate Mafia shots");
    }
    const logCountAfterEvaluation = Number(await shotLogCount.innerText());
    if (logCountAfterEvaluation - logCountBeforeShots !== 1) {
      throw new Error(
        `Evaluating Mafia shots must log one accepted resolution containing all ${shooterCount} shots: ${logCountBeforeShots} -> ${logCountAfterEvaluation}`,
      );
    }
    const resultGeometry = await page.locator(".table-night-center").evaluate((center) => {
      const resultCard = center.querySelector(".night-miss-card, .deceased-player-card");
      if (!(resultCard instanceof HTMLElement)) throw new Error("Expected the Mafia result card");
      const card = resultCard.getBoundingClientRect();
      return {
        cardLeft: card.left,
        cardWidth: card.width,
        centerLeft: center.getBoundingClientRect().left,
        centerWidth: center.getBoundingClientRect().width,
      };
    });
    const mafiaResultScreenshotPath = tableScreenshotPath.replace(/\.png$/i, "-mafia-result.png");
    await page.screenshot({ path: mafiaResultScreenshotPath, fullPage: true });
    await page.getByRole("button", { name: "Continue night" }).click();
    await page.getByRole("heading", { name: "Don check" }).waitFor();
    if ((await page.getByRole("button", { name: /^Red card / }).count()) !== 0) {
      throw new Error("Don check must use swipe Red without inline Red buttons");
    }
    await page.getByRole("button", { name: "Skip Don check" }).click();
    await page.getByRole("heading", { name: "Sheriff check" }).waitFor();
    if ((await page.getByRole("button", { name: /^Red card / }).count()) !== 0) {
      throw new Error("Sheriff check must use swipe Red without inline Red buttons");
    }
    await page.getByRole("button", { name: "Skip Sheriff check" }).click();
    await page.getByRole("heading", { name: "Night complete" }).waitFor();
    if ((await page.locator(".night-miss-card, .deceased-player-card").count()) !== 1) {
      throw new Error("Night complete must retain the evaluated Mafia result");
    }
    if ((await page.getByRole("button", { name: /^Red card / }).count()) !== 0) {
      throw new Error("Night complete must not show direct red-card buttons above player cards");
    }
    const nightCompleteScreenshotPath = tableScreenshotPath.replace(
      /\.png$/i,
      "-night-complete.png",
    );
    await page.screenshot({ path: nightCompleteScreenshotPath, fullPage: true });
    await page.getByRole("button", { name: /^Begin day \d+$/ }).click();
    await page.getByRole("heading", { name: "Best move" }).waitFor();
    const postNightHighlight = page.locator(".player-seat.is-voting-highlight");
    if ((await postNightHighlight.count()) !== 1) {
      throw new Error("The night victim must stay brightly highlighted during Best move");
    }
    await page.waitForTimeout(320);
    const postNightHighlightStyle = await assertSupportedPlayerLighting(
      postNightHighlight,
      "Post-night victim",
    );
    const bestMoveScreenshotPath = tableScreenshotPath.replace(/\.png$/i, "-best-move.png");
    await page.screenshot({ path: bestMoveScreenshotPath, fullPage: true });
    for (let selection = 0; selection < 3; selection += 1) {
      await page
        .getByRole("button", { name: /^Add .* to Best move$/ })
        .first()
        .click();
    }
    await page.getByRole("button", { name: "Save Best move" }).click();
    await page.getByRole("heading", { name: "Goodbye speech" }).waitFor();
    if ((await page.locator(".player-seat.is-voting-highlight").count()) !== 1) {
      throw new Error("The night victim must stay brightly highlighted during the goodbye speech");
    }
    const goodbyeScreenshotPath = tableScreenshotPath.replace(/\.png$/i, "-goodbye.png");
    await page.screenshot({ path: goodbyeScreenshotPath, fullPage: true });
    await page.getByRole("button", { name: /^Begin day \d+$/ }).click();
    await page.getByRole("heading", { name: /^Day \d+$/ }).waitFor();
    if ((await page.locator(".player-seat.is-voting-highlight").count()) !== 0) {
      throw new Error("The post-night voting-fire highlight must end when the day starts");
    }
    await page.goto(storageMutationUrl, { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      const storageKey = "mafia-dashboard.game-session.v5";
      const raw = window.localStorage.getItem(storageKey);
      if (raw === null) throw new Error("Expected a persisted game session");
      const envelope = JSON.parse(raw);
      const game = structuredClone(envelope.current.state.initialGame?.game);
      if (game === null || game === undefined)
        throw new Error("Expected a persisted replay baseline");
      const activeSeats = game.players
        .filter((player) => player.status === "active")
        .slice(0, 3)
        .map((player) => player.seat);
      game.phase = "car-crash-decision";
      game.day = Math.max(1, game.day);
      game.carCrashSeats = activeSeats;
      game.carCrashVotes = {};
      game.voteAssignments = {};
      game.votingRound = "repeat";
      game.winner = null;
      await window.__mafiaVerifierCheckpointEnvelope(envelope, game);
      envelope.current.state.resetReturnEventId = null;
      envelope.current.results = null;
      envelope.outbox = [];
      envelope.failed = false;
      window.localStorage.setItem(storageKey, JSON.stringify(envelope));
    });
    await page.goto(browserAppUrl, { waitUntil: "networkidle" });
    if ((await page.locator(".club-playing-card:not(.new-club-card)").count()) > 0)
      await page.locator(".club-playing-card:not(.new-club-card)").first().click();
    await page.waitForTimeout(950);
    await page.getByRole("heading", { name: "Car-crash decision" }).waitFor();
    await page.getByText("Eliminate all players voting").waitFor();
    if (
      (await page.getByRole("button", { name: /^Eliminate (all|both) nominees$/ }).count()) !== 0 ||
      (await page.getByRole("button", { name: /^Keep (all|both) nominees$/ }).count()) !== 0
    ) {
      throw new Error("The eliminate-all ballot must not expose separate Eliminate/Keep buttons");
    }
    const zeroVoteResolve = page.getByRole("button", { name: "Resolve car crash" });
    if (!(await zeroVoteResolve.isEnabled())) {
      throw new Error("Zero eliminate-all votes must be immediately resolvable");
    }
    await page.screenshot({ path: carCrashScreenshotPath, fullPage: true });
    await zeroVoteResolve.click();
    await page.getByRole("heading", { name: "Car crash result" }).waitFor();
    await page
      .getByRole("status", { name: "Car-crash result" })
      .getByText("Players stay")
      .waitFor();
    const keptResultActivePlayers = await page.locator(".player-seat.status-active").count();
    if (
      (await page.getByRole("button", { name: /^Foul / }).count()) !== keptResultActivePlayers ||
      (await page.locator(".player-seat.is-provisional-deceased").count()) !== 0
    ) {
      throw new Error(
        "A kept car-crash result must retain every active player's Foul control without provisional deaths",
      );
    }
    await page.getByRole("button", { name: "Continue" }).click();
    await page.locator(".game-shell.phase-night-mafia").waitFor();
    await page.goto(storageMutationUrl, { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      const storageKey = "mafia-dashboard.game-session.v5";
      const raw = window.localStorage.getItem(storageKey);
      if (raw === null) throw new Error("Expected a persisted game session");
      const envelope = JSON.parse(raw);
      const game = structuredClone(envelope.current.state.initialGame?.game);
      if (game === null || game === undefined)
        throw new Error("Expected a persisted replay baseline");
      game.phase = "car-crash-decision";
      game.day = Math.max(1, game.day);
      game.carCrashSeats = game.players
        .filter((player) => player.status === "active")
        .slice(0, 3)
        .map((player) => player.seat);
      game.carCrashVotes = {};
      game.voteAssignments = {};
      game.votingRound = "repeat";
      game.winner = null;
      await window.__mafiaVerifierCheckpointEnvelope(envelope, game);
      envelope.current.state.resetReturnEventId = null;
      envelope.current.results = null;
      envelope.outbox = [];
      envelope.failed = false;
      window.localStorage.setItem(storageKey, JSON.stringify(envelope));
    });
    await page.goto(browserAppUrl, { waitUntil: "networkidle" });
    if ((await page.locator(".club-playing-card:not(.new-club-card)").count()) > 0)
      await page.locator(".club-playing-card:not(.new-club-card)").first().click();
    await page.waitForTimeout(950);
    const eliminateVotes = page.getByRole("button", {
      name: /^Vote as .* to eliminate all car-crash players$/,
    });
    for (let index = 0; index < 6; index += 1) await eliminateVotes.first().click();
    const decisionActivePlayers = await page.locator(".player-seat.status-active").count();
    if ((await page.getByRole("button", { name: /^Foul / }).count()) !== decisionActivePlayers) {
      throw new Error("Car-crash voting must retain every active player's Foul control");
    }
    await page.getByRole("button", { name: "Resolve car crash" }).click();
    await page.getByRole("heading", { name: "Car crash result" }).waitFor();
    await page.getByRole("status", { name: "Car-crash result" }).getByText("Eliminated").waitFor();
    if (
      (await page.locator(".player-seat.is-provisional-deceased").count()) !== 3 ||
      (await page.getByRole("button", { name: /^Foul / }).count()) !== decisionActivePlayers
    ) {
      throw new Error(
        "Every car-crash participant must be provisional while every active Foul control remains available",
      );
    }
    const carCrashResultScreenshotPath = carCrashScreenshotPath.replace(
      /\.png$/i,
      "-eliminated-result.png",
    );
    await page.screenshot({ path: carCrashResultScreenshotPath, fullPage: true });
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("heading", { name: "Goodbye speech" }).waitFor();
    await page.goto(storageMutationUrl, { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      const storageKey = "mafia-dashboard.game-session.v5";
      const raw = window.localStorage.getItem(storageKey);
      if (raw === null) throw new Error("Expected a persisted game session");
      const envelope = JSON.parse(raw);
      const game = structuredClone(envelope.current.state.initialGame?.game);
      if (game === null || game === undefined)
        throw new Error("Expected a persisted replay baseline");
      game.phase = "night-don";
      game.day = Math.max(1, game.day);
      game.players = game.players.map((player) =>
        player.role === "don" || player.role === "sheriff"
          ? { ...player, status: "eliminated" }
          : player,
      );
      // These owners were eliminated during this night; their check rights remain snapshotted.
      game.nightCheckEligibility = { don: true, sheriff: true };
      game.carCrashSeats = undefined;
      game.carCrashVotes = undefined;
      game.carCrashResult = undefined;
      game.votingCancellation = undefined;
      game.goodbyeSeats = undefined;
      game.goodbyeNext = undefined;
      game.bestMove = undefined;
      game.checkResult = undefined;
      game.winner = null;
      await window.__mafiaVerifierCheckpointEnvelope(envelope, game);
      envelope.current.state.resetReturnEventId = null;
      envelope.current.results = null;
      envelope.outbox = [];
      envelope.failed = false;
      window.localStorage.setItem(storageKey, JSON.stringify(envelope));
    });
    await page.goto(browserAppUrl, { waitUntil: "networkidle" });
    if ((await page.locator(".club-playing-card:not(.new-club-card)").count()) > 0)
      await page.locator(".club-playing-card:not(.new-club-card)").first().click();
    await page.waitForTimeout(950);
    const assertDeceasedOwnerCheckActions = async (expected) => {
      const phaseActions = (
        await page.locator(".table-advance button:visible").allTextContents()
      ).map((text) => text.trim());
      if (
        JSON.stringify(phaseActions) !==
          JSON.stringify(["Select a player to continue", expected]) ||
        (await page.getByRole("button", { name: "Select a player to continue" }).isEnabled()) ||
        !(await page.getByRole("button", { name: expected }).isEnabled()) ||
        (await page.locator(".player-seat.status-eliminated.is-night-check-highlight").count()) !==
          1 ||
        (await page.locator(".player-seat.status-active:enabled").count()) === 0 ||
        (await page.locator(".seat-actions button:visible").count()) !== 0 ||
        (await page.locator(".table-center button:visible").count()) !== 0 ||
        (await page.getByRole("button", { name: /^Red card |^Foul / }).count()) !== 0
      ) {
        throw new Error(
          `A same-night deceased check owner must retain a playable check and ${expected} without direct discipline actions: ${JSON.stringify(phaseActions)}`,
        );
      }
    };
    await page.getByRole("heading", { name: "Don check" }).waitFor();
    await assertDeceasedOwnerCheckActions("Skip Don check");
    const deadDonScreenshotPath = tableScreenshotPath.replace(/\.png$/i, "-dead-don-check.png");
    await page.screenshot({ path: deadDonScreenshotPath, fullPage: true });
    await page.getByRole("button", { name: "Skip Don check" }).click();
    await page.getByRole("heading", { name: "Sheriff check" }).waitFor();
    await assertDeceasedOwnerCheckActions("Skip Sheriff check");
    const deadSheriffScreenshotPath = tableScreenshotPath.replace(
      /\.png$/i,
      "-dead-sheriff-check.png",
    );
    await page.screenshot({ path: deadSheriffScreenshotPath, fullPage: true });
    await page.getByRole("button", { name: "Skip Sheriff check" }).click();
    await page.getByRole("heading", { name: "Night complete" }).waitFor();
    await page.goto(storageMutationUrl, { waitUntil: "domcontentloaded" });
    const staleGoodbyeFixture = await page.evaluate(async () => {
      const storageKey = "mafia-dashboard.game-session.v5";
      const raw = window.localStorage.getItem(storageKey);
      if (raw === null) throw new Error("Expected a persisted game session");
      const envelope = JSON.parse(raw);
      const game = structuredClone(envelope.current.state.initialGame?.game);
      if (game === null || game === undefined)
        throw new Error("Expected a persisted replay baseline");
      const earlierSeat = game.players[0]?.seat;
      const speaker = game.players.find(
        (player) => player.status === "active" && player.seat !== earlierSeat,
      );
      if (earlierSeat === undefined || speaker === undefined) {
        throw new Error("Expected an earlier Best move victim and another active player");
      }
      game.phase = "goodbye-speech";
      game.day = Math.max(1, game.day);
      game.players = game.players.map((player) =>
        player.seat === speaker.seat ? { ...player, status: "eliminated" } : player,
      );
      game.bestMove = { playerSeat: earlierSeat, selectedSeats: [], mafiaHits: 0 };
      game.goodbyeSeats = [speaker.seat];
      game.goodbyeNext = "day";
      await window.__mafiaVerifierCheckpointEnvelope(envelope, game);
      envelope.current.state.resetReturnEventId = null;
      envelope.current.results = null;
      envelope.current.state.legacyLog = [];
      envelope.outbox = [];
      envelope.failed = false;
      window.localStorage.setItem(storageKey, JSON.stringify(envelope));
      return { earlierSeat, speakerSeat: speaker.seat, speakerId: speaker.id };
    });
    const speakerDisplayName = testPlayers.find(
      ({ id }) => id === staleGoodbyeFixture.speakerId,
    )?.nickname;
    if (speakerDisplayName === undefined) throw new Error("Expected speaker in display directory");
    await page.goto(browserAppUrl, { waitUntil: "networkidle" });
    if ((await page.locator(".club-playing-card:not(.new-club-card)").count()) > 0)
      await page.locator(".club-playing-card:not(.new-club-card)").first().click();
    await page.waitForTimeout(950);
    await page.getByRole("heading", { name: "Goodbye speech" }).waitFor();
    const staleGoodbyeHighlights = page.locator(".player-seat.is-voting-highlight");
    const staleGoodbyeHighlightState = {
      count: await staleGoodbyeHighlights.count(),
      earlierHighlighted: await page
        .getByRole("button", { name: new RegExp(`^Seat ${staleGoodbyeFixture.earlierSeat}:`) })
        .evaluate((card) => card.classList.contains("is-voting-highlight")),
      speakerHighlighted: await page
        .getByRole("button", {
          name: `Seat ${staleGoodbyeFixture.speakerSeat}: ${speakerDisplayName}`,
        })
        .evaluate((card) => card.classList.contains("is-voting-highlight")),
    };
    if (
      staleGoodbyeHighlightState.count !== 1 ||
      staleGoodbyeHighlightState.earlierHighlighted ||
      !staleGoodbyeHighlightState.speakerHighlighted
    ) {
      throw new Error(
        `Only the current goodbye speaker may be highlighted: ${JSON.stringify(staleGoodbyeHighlightState)}`,
      );
    }
    const goodbyeTransitionStyle = await assertSupportedPlayerLighting(
      staleGoodbyeHighlights,
      "Goodbye card",
    );
    const staleGoodbyeScreenshotPath = tableScreenshotPath.replace(
      /\.png$/i,
      "-goodbye-stale-best-move.png",
    );
    await page.screenshot({ path: staleGoodbyeScreenshotPath, fullPage: true });
    await page.goto(storageMutationUrl, { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      const storageKey = "mafia-dashboard.game-session.v5";
      const raw = window.localStorage.getItem(storageKey);
      if (raw === null) throw new Error("Expected a persisted game session");
      const envelope = JSON.parse(raw);
      const game = structuredClone(envelope.current.state.initialGame?.game);
      if (game === null || game === undefined)
        throw new Error("Expected a persisted replay baseline");
      game.phase = "finished";
      game.day = Math.max(1, game.day);
      game.winner = "red";
      game.goodbyeSeats = undefined;
      game.goodbyeNext = undefined;
      await window.__mafiaVerifierCheckpointEnvelope(envelope, game);
      envelope.current.state.resetReturnEventId = null;
      envelope.current.results = null;
      envelope.current.state.legacyLog = [];
      envelope.outbox = [];
      envelope.failed = false;
      window.localStorage.setItem(storageKey, JSON.stringify(envelope));
    });
    await page.goto(browserAppUrl, { waitUntil: "networkidle" });
    if ((await page.locator(".club-playing-card:not(.new-club-card)").count()) > 0)
      await page.locator(".club-playing-card:not(.new-club-card)").first().click();
    await page.waitForTimeout(950);
    await page.getByRole("heading", { level: 1, name: "Citizens won" }).waitFor();
    await page.locator(".winner-card strong").getByText("Citizens won", { exact: true }).waitFor();
    if ((await page.locator(".game-shell .phase-banner").count()) !== 0) {
      throw new Error("Finished game must not repeat the phase title in a banner");
    }
    const finishScreenshotPath = tableScreenshotPath.replace(/\.png$/i, "-finished.png");
    await page.screenshot({ path: finishScreenshotPath, fullPage: true });
    assertNoPageErrors();
    console.log(
      `Focused iPad gameplay verification: PASS ${JSON.stringify({ consoleGeometry, actionRowGeometry, wrappedActionGeometry, timerAudioStarts, centerShadowStyle, sidePanelGeometry, glassEvidence, playerControlGeometry, actionGeometry, swipeMenuGeometry, statusLayout, voteToggleState, votingHighlightStyle, postNightHighlightStyle, staleGoodbyeHighlightState, goodbyeTransitionStyle, nightCycleStyle, dayCycleStyle, resultGeometry, playerControlsScreenshotPath, sidePanelScreenshotPath, glassScreenshotPath, nightCycleScreenshotPath, dayCycleScreenshotPath, swipeMenuScreenshotPath, tableScreenshotPath, votingScreenshotPath, autoVotingScreenshotPath, cancellationScreenshotPath, shotToggleScreenshotPath, mafiaResultScreenshotPath, nightCompleteScreenshotPath, bestMoveScreenshotPath, goodbyeScreenshotPath, staleGoodbyeScreenshotPath, finishScreenshotPath, previewScreenshotPath, timelineScreenshotPath, timelineRightScreenshotPath, carCrashScreenshotPath, carCrashResultScreenshotPath, deadDonScreenshotPath, deadSheriffScreenshotPath })}`,
    );
    await browser.close();
    process.exit(0);
  }
  await page.getByRole("button", { name: "Select available players" }).click();
  const availablePlayers = page.getByRole("button", { name: /^Mark UI Player \d+ available$/ });
  if ((await availablePlayers.count()) !== 11) {
    throw new Error("Expected eleven players in the availability picker");
  }
  for (let playerIndex = 0; playerIndex < 11; playerIndex += 1) {
    await availablePlayers.first().click();
  }
  await page.getByRole("button", { name: "Close available players" }).click();
  await page.getByRole("combobox", { name: "Host player" }).click();
  await page.getByRole("option", { name: testNicknames[10], exact: true }).click();
  await page.getByRole("button", { name: "Assign players" }).click();
  const playerSelectors = page.getByRole("combobox", { name: /^Seat \d+ player$/ });
  if ((await playerSelectors.count()) !== 10) throw new Error("Expected ten player selectors");
  await page.waitForFunction(() =>
    [...document.querySelectorAll('input[aria-label^="Seat "][aria-label$=" player"]')].every(
      (input) => input instanceof HTMLInputElement && input.value !== "",
    ),
  );
  const selectedPlayerNames = await playerSelectors.evaluateAll((selectors) =>
    selectors.map((selector) => {
      if (!(selector instanceof HTMLInputElement)) throw new Error("Expected player input");
      return selector.value;
    }),
  );
  const selectedPlayers = selectedPlayerNames.flatMap((nickname) => {
    const player = testPlayers.find((candidate) => candidate.nickname === nickname);
    return player === undefined ? [] : [player];
  });
  if (
    selectedPlayers.length !== 10 ||
    new Set(selectedPlayers.map(({ id }) => id)).size !== 10 ||
    selectedPlayers.some(({ id }) => id === testPlayers[10].id)
  ) {
    throw new Error(
      `Assigned seats must contain ten unique non-host players: ${JSON.stringify(selectedPlayerNames)}`,
    );
  }
  await page.screenshot({ path: selectionScreenshotPath, fullPage: true });

  await page.evaluate(() => {
    class FakeYouTubePlayer {
      constructor(_elementId, options) {
        this.options = options;
        this.volume = 65;
        this.volumeChanges = [];
        this.played = false;
        this.state = -1;
        this.videoIds = [];
        this.iframe = document.createElement("iframe");
        window.__uiYouTubePlayer = this;
        setTimeout(() => options.events?.onReady?.({ target: this }), 0);
      }
      playVideo() {
        this.played = true;
        this.state = 1;
        this.options.events?.onStateChange?.({ target: this, data: 1 });
      }
      pauseVideo() {
        this.state = 2;
        this.options.events?.onStateChange?.({ target: this, data: 2 });
      }
      cuePlaylist(videoIds, index = 0) {
        this.videoIds = [...videoIds];
        this.playlistIndex = index;
        this.state = 5;
        this.options.events?.onStateChange?.({ target: this, data: 5 });
      }
      loadPlaylist(videoIds, index = 0) {
        this.videoIds = [...videoIds];
        this.playlistIndex = index;
        this.state = 1;
        this.options.events?.onStateChange?.({ target: this, data: 1 });
      }
      playVideoAt(index) {
        this.playlistIndex = index;
        this.playVideo();
      }
      setVolume(volume) {
        this.volume = volume;
        this.volumeChanges.push(volume);
      }
      getVolume() {
        return this.volume;
      }
      getIframe() {
        return this.iframe;
      }
      getPlaylistIndex() {
        return this.playlistIndex ?? 0;
      }
      getPlaylist() {
        return this.videoIds;
      }
      getCurrentTime() {
        return 0;
      }
      getPlayerState() {
        return this.state;
      }
      destroy() {}
    }
    window.YT = {
      Player: FakeYouTubePlayer,
      PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0, BUFFERING: 3, CUED: 5 },
    };
  });
  await page.getByRole("button", { name: "Open Manage menu" }).click();
  await page.getByRole("button", { name: "Music player setup" }).click();
  const musicSetup = page.getByRole("region", { name: "Music player setup" });
  if ((await musicSetup.getByRole("combobox").count()) !== 0)
    throw new Error("Playlist selection must not remain in Music player setup");
  await musicSetup.getByRole("button", { name: "Disconnect account" }).waitFor();
  await musicSetup.getByRole("button", { name: "Reload music player" }).waitFor();
  await page.getByRole("button", { name: "Close Manage menu" }).click();
  const queueHandle = page.getByRole("button", { name: "Music player panel handle" });
  await queueHandle.click();
  await page
    .getByRole("combobox", { name: "YouTube Music playlist" })
    .selectOption("test-playlist");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await queueHandle.click();
  await verifyMusicExpansion("setup");
  if (musicOnly) {
    await page.getByRole("button", { name: "Start game", exact: true }).click();
    for (let roleIndex = 0; roleIndex < 10; roleIndex += 1) {
      await page
        .getByRole("button", { name: /^Draw role for / })
        .first()
        .click();
    }
    await page.getByRole("button", { name: "Begin Mafia planning stage" }).click();
    await verifyMusicExpansion("live-utilities-visible");
    await page.getByRole("button", { name: "Hide timer and voting" }).click();
    await verifyMusicExpansion("live-utilities-hidden");
    for (const count of [0, 4, 40]) {
      await queueHandle.click();
      await page
        .getByRole("combobox", { name: "YouTube Music playlist" })
        .selectOption(`test-queue-${count}`);
      await queueHandle.click();
      await verifyMusicExpansion(`live-hidden-${count}`, count);
      // Exercise both layout states; portrait's existing utility grip can sit behind the dock.
      await page.getByRole("button", { name: "Show timer and voting" }).dispatchEvent("click");
      await verifyMusicExpansion(`live-visible-${count}`, count);
      await page.getByRole("button", { name: "Hide timer and voting" }).dispatchEvent("click");
    }
    assertNoPageErrors();
    console.log("Focused music geometry verification: PASS");
    await browser.close();
    process.exit(0);
  }
  await queueHandle.click();
  const queue = page.getByRole("region", { name: "Session playlist queue" });
  const finaleRow = queue.getByRole("listitem").filter({ hasText: "UI verification finale" });
  const finaleContent = finaleRow.locator(".queue-item-content");
  const revealTrackTypes = async (row, content, identifier) => {
    await content.dispatchEvent("touchstart", {
      touches: [{ identifier, clientX: 180, clientY: 40 }],
    });
    await content.dispatchEvent("touchend", {
      changedTouches: [{ identifier, clientX: 80, clientY: 42 }],
    });
    if (
      !(await row.evaluate((candidate) => candidate.classList.contains("is-queue-tags-revealed")))
    ) {
      throw new Error("Queue browser fixture did not reveal the track-type tray");
    }
    await content.dispatchEvent("click");
  };
  await revealTrackTypes(finaleRow, finaleContent, 9);
  await finaleRow
    .getByRole("button", { name: "Mark UI verification finale for Role giveaway" })
    .click();
  await page.waitForFunction(() => {
    const row = [...document.querySelectorAll(".youtube-session-queue li")].find((candidate) =>
      candidate.textContent?.includes("UI verification finale"),
    );
    return row?.getAttribute("data-initial-stage") === "true";
  });
  const initialMarkerColor = await finaleRow.evaluate(
    (row) => getComputedStyle(row, "::before").backgroundColor,
  );
  await revealTrackTypes(finaleRow, finaleContent, 10);
  await page.waitForTimeout(180);
  const initialAction = finaleRow.getByRole("button", {
    name: "Unmark UI verification finale for Role giveaway",
  });
  const initialActionStyle = await initialAction.evaluate((button) => {
    const style = getComputedStyle(button);
    return {
      backgroundColor: style.backgroundColor,
      boxShadow: style.boxShadow,
      fontWeight: style.fontWeight,
    };
  });
  await finaleRow
    .getByRole("button", { name: "Mark UI verification finale for Critical endgame" })
    .click();
  await page.waitForFunction(() => {
    const row = [...document.querySelectorAll(".youtube-session-queue li")].find((candidate) =>
      candidate.textContent?.includes("UI verification finale"),
    );
    return (
      row?.getAttribute("data-initial-stage") === "false" &&
      row.getAttribute("data-endgame") === "true"
    );
  });
  const endgameMarkerColor = await finaleRow.evaluate(
    (row) => getComputedStyle(row, "::before").backgroundColor,
  );
  await revealTrackTypes(finaleRow, finaleContent, 11);
  await page.waitForTimeout(180);
  const endgameAction = finaleRow.getByRole("button", {
    name: "Unmark UI verification finale for Critical endgame",
  });
  const endgameActionStyle = await endgameAction.evaluate((button) => {
    const style = getComputedStyle(button);
    return {
      backgroundColor: style.backgroundColor,
      boxShadow: style.boxShadow,
      fontWeight: style.fontWeight,
    };
  });
  if (
    initialMarkerColor !== "rgb(53, 201, 120)" ||
    endgameMarkerColor !== "rgb(228, 75, 85)" ||
    initialActionStyle.backgroundColor !== "rgb(22, 133, 83)" ||
    endgameActionStyle.backgroundColor !== "rgb(167, 43, 53)" ||
    !initialActionStyle.boxShadow.includes("inset") ||
    !endgameActionStyle.boxShadow.includes("inset") ||
    Number(initialActionStyle.fontWeight) < 700 ||
    Number(endgameActionStyle.fontWeight) < 700
  ) {
    throw new Error(
      `Queue markers or pressed actions are not visually distinct: ${JSON.stringify({ initialMarkerColor, endgameMarkerColor, initialActionStyle, endgameActionStyle })}`,
    );
  }
  await page.screenshot({ path: queueTagsScreenshotPath, fullPage: true });
  await finaleRow.getByRole("button", { name: "Play UI verification finale next" }).click();
  if (
    !(await queue.getByRole("listitem").nth(1).innerText()).includes("UI verification finale") ||
    (await finaleRow.evaluate(
      (row) =>
        row.classList.contains("is-queue-tags-revealed") ||
        row.classList.contains("is-next") ||
        row.getAttribute("data-initial-stage") !== "false" ||
        row.getAttribute("data-endgame") !== "true",
    )) ||
    (await finaleRow
      .getByRole("button", { name: "Play UI verification finale next" })
      .getAttribute("aria-pressed")) !== null
  ) {
    throw new Error("Play next must move the row without leaving tray or selected-row state");
  }
  const markInitial = async (title, identifier) => {
    const row = queue.getByRole("listitem").filter({ hasText: title });
    const content = row.locator(".queue-item-content");
    await revealTrackTypes(row, content, identifier);
    await row.getByRole("button", { name: `Mark ${title} for Role giveaway` }).click();
  };
  await markInitial("UI verification track", 12);
  await markInitial("UI verification opening two", 13);
  await queueHandle.click();
  await page.getByRole("button", { name: "Start game" }).click();
  await page.getByRole("heading", { name: "Role giveaway" }).waitFor();
  await assertAccessibleControls("Role giveaway");
  const keyboardRoleCard = page.getByRole("button", { name: /^Draw role for / }).first();
  await assertVisibleFocus(keyboardRoleCard, "Role card");
  await page.keyboard.press("Shift+F10");
  const manualRoleDialog = page.getByRole("dialog", { name: "Choose role" });
  await manualRoleDialog.waitFor();
  const manualRoleButton = manualRoleDialog.getByRole("button").first();
  if (!(await manualRoleButton.evaluate((button) => document.activeElement === button))) {
    throw new Error("Manual role dialog did not focus its first action");
  }
  await page.keyboard.press("Escape");
  if (!(await keyboardRoleCard.evaluate((button) => document.activeElement === button))) {
    throw new Error("Role card did not regain focus after closing manual assignment");
  }
  await queueHandle.click();
  const openingRows = await queue.getByRole("listitem").evaluateAll((rows) =>
    rows.map((row) => ({
      title: row.textContent ?? "",
      initial: row.getAttribute("data-initial-stage") === "true",
      endgame: row.getAttribute("data-endgame") === "true",
    })),
  );
  const openingPlayer = await page.evaluate(() => {
    const player = window.__uiYouTubePlayer;
    return {
      played: player?.played ?? false,
      playlistIndex: player?.playlistIndex ?? null,
      videoIds: player?.videoIds ?? [],
      volumeChanges: player?.volumeChanges ?? [],
    };
  });
  const openingCurrentVideoId = openingRows[0]?.title.includes("opening two")
    ? "ui-track-4"
    : "ui-track-1";
  const openingNextVideoId = openingRows[1]?.title.includes("ordinary two")
    ? "ui-track-5"
    : "ui-track-2";
  if (
    openingRows.length !== 5 ||
    openingRows[0]?.initial !== true ||
    openingRows[1]?.initial !== false ||
    openingRows[1]?.endgame !== false ||
    openingRows.at(-1)?.initial !== true ||
    openingRows.slice(1, -1).some(({ initial }) => initial) ||
    openingPlayer.played !== true ||
    openingPlayer.playlistIndex !== 0 ||
    openingPlayer.videoIds[0] !== openingCurrentVideoId ||
    openingPlayer.videoIds.length !== openingRows.length ||
    openingPlayer.volumeChanges[0] !== 0
  ) {
    throw new Error(
      `Start game did not build and fade the constrained opening queue: ${JSON.stringify({ openingRows, openingPlayer })}`,
    );
  }
  await page.evaluate(() => {
    const player = window.__uiYouTubePlayer;
    player.state = 0;
    player.options.events.onStateChange({ target: player, data: 0 });
    if (player.playlistIndex === 0) {
      player.playlistIndex = 1;
      player.state = 1;
      player.options.events.onStateChange({ target: player, data: 1 });
    }
  });
  await page.waitForFunction((expected) => {
    const player = window.__uiYouTubePlayer;
    return player.videoIds[player.playlistIndex] === expected;
  }, openingNextVideoId);
  await queueHandle.click();

  for (const { nickname } of selectedPlayers) {
    await page.getByRole("button", { name: `Draw role for ${nickname}`, exact: true }).click();
  }
  await page.getByRole("button", { name: "Begin Mafia planning stage" }).click();
  await page.getByRole("heading", { name: "Night zero · Mafia free seating" }).waitFor();
  if (headerOnly) {
    await page.getByRole("button", { name: "Continue night zero to Sheriff wake-up" }).click();
    await page.getByRole("button", { name: "Begin day one" }).click();
    const firstPlayer = selectedPlayers[0]?.nickname;
    const secondPlayer = selectedPlayers[1]?.nickname;
    if (firstPlayer === undefined || secondPlayer === undefined) {
      throw new Error("Phone verification requires the first two selected players");
    }
    if (
      (await page.getByRole("button", { name: `Red card ${firstPlayer}`, exact: true }).count()) !==
      0
    ) {
      throw new Error("Day player cards must not expose a direct red-card button");
    }
    const firstPlayerCard = page.getByRole("button", {
      name: `Seat 1: ${firstPlayer}`,
      exact: true,
    });
    await assertVisibleFocus(firstPlayerCard, "Live player card");
    await page.keyboard.press("Shift+F10");
    const redCardButton = page.getByRole("button", {
      name: `Red card ${firstPlayer}`,
      exact: true,
    });
    await redCardButton.waitFor();
    if (!(await redCardButton.evaluate((button) => document.activeElement === button))) {
      throw new Error("Keyboard-opened player actions did not focus the red-card action");
    }
    await page.keyboard.press("Escape");
    if (!(await firstPlayerCard.evaluate((button) => document.activeElement === button))) {
      throw new Error("Player card did not regain focus after closing its actions");
    }
    await page.keyboard.press("Shift+F10");
    await page.keyboard.press("Enter");
    await page.getByText(`Current turn: ${secondPlayer}`).waitFor();
    await page.getByRole("button", { name: `Foul ${secondPlayer}`, exact: true }).click();
    await page.getByText("Foul ×1").waitFor();
    const phoneGeometry = await page.evaluate(() => {
      const rect = (element) => {
        const box = element.getBoundingClientRect();
        return {
          label: element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "unknown",
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          width: box.width,
          height: box.height,
        };
      };
      const header = document.querySelector(".game-header");
      if (!(header instanceof HTMLElement)) throw new Error("Game header missing");
      const cards = [...document.querySelectorAll(".table-card")].map(rect);
      const seatActionButtons = [...document.querySelectorAll(".seat-actions button")].map(rect);
      const headerChildren = [...header.children].map(rect);
      const auxiliaryPanels = [
        document.querySelector(".youtube-dock.is-compact"),
        document.querySelector(".game-log-drawer"),
      ]
        .filter((element) => element instanceof HTMLElement)
        .map(rect);
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        cards,
        seatActionButtons,
        headerChildren,
        auxiliaryPanels,
      };
    });
    if (phoneGeometry.documentWidth > phoneGeometry.viewportWidth + 1) {
      throw new Error(`Phone layout clips horizontally: ${JSON.stringify(phoneGeometry)}`);
    }
    for (const element of [...phoneGeometry.headerChildren, ...phoneGeometry.cards]) {
      if (element.left < 0 || element.right > phoneGeometry.viewportWidth) {
        throw new Error(`Phone element is outside the viewport: ${JSON.stringify(element)}`);
      }
    }
    if (phoneGeometry.seatActionButtons.length < 18) {
      throw new Error("Phone fallback must expose foul and nomination controls");
    }
    for (const action of phoneGeometry.seatActionButtons) {
      if (action.width < 38 || action.height < 38) {
        throw new Error(`Phone seat action is too small: ${JSON.stringify(action)}`);
      }
    }
    for (let leftIndex = 0; leftIndex < phoneGeometry.cards.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < phoneGeometry.cards.length;
        rightIndex += 1
      ) {
        const left = phoneGeometry.cards[leftIndex];
        const right = phoneGeometry.cards[rightIndex];
        const overlaps =
          Math.min(left.right, right.right) > Math.max(left.left, right.left) &&
          Math.min(left.bottom, right.bottom) > Math.max(left.top, right.top);
        if (overlaps) throw new Error(`${left.label} overlaps ${right.label} on phone`);
      }
    }
    for (const panel of phoneGeometry.auxiliaryPanels) {
      for (const card of phoneGeometry.cards) {
        const overlaps =
          Math.min(panel.right, card.right) > Math.max(panel.left, card.left) &&
          Math.min(panel.bottom, card.bottom) > Math.max(panel.top, card.top);
        if (overlaps) throw new Error(`${panel.label} obscures ${card.label} on phone`);
      }
    }
    await page.screenshot({ path: tableScreenshotPath, fullPage: true });
    await assertAccessibleControls("Responsive live game");
    await assertCoreTargets("Responsive live game");
    await assertCoreLayout("Responsive live game");
    assertNoPageErrors();
    console.log("Responsive phone game verification: PASS");
    await browser.close();
    process.exit(0);
  }
  const enterFullscreen = page.getByRole("button", { name: "Enter fullscreen" });
  if (!(await enterFullscreen.isEnabled())) throw new Error("Fullscreen API is unavailable");
  await enterFullscreen.click();
  await page.waitForFunction(() => document.fullscreenElement !== null);
  await page.getByRole("button", { name: "Exit fullscreen" }).waitFor();
  await assertAccessibleControls("Fullscreen live game");
  await assertCoreTargets("Fullscreen live game");
  await assertCoreLayout("Fullscreen live game");
  if ((await page.locator(".player-seat").count()) !== 10) {
    throw new Error("Expected ten player seats on the live table");
  }
  if ((await page.locator(".host-seat").count()) !== 0) {
    throw new Error("The live table must not render a Host tile");
  }
  const geometry = await page.evaluate(() => {
    const box = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
      const bounds = element.getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        width: bounds.width,
        height: bounds.height,
      };
    };
    const appShell = document.querySelector(".app-shell");
    if (!(appShell instanceof HTMLElement)) throw new Error("Missing application shell");
    const table = document.querySelector(".round-table");
    if (!(table instanceof HTMLElement)) throw new Error("Missing round table");
    const headerTitle = document.querySelector(".game-header > :first-child");
    if (!(headerTitle instanceof HTMLElement)) throw new Error("Missing game header title");
    const headerTitleBox = headerTitle.getBoundingClientRect();
    const cards = [...document.querySelectorAll(".table-card")].map((element) => {
      const box = element.getBoundingClientRect();
      return {
        label: element.getAttribute("aria-label"),
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
        centerX: box.left + box.width / 2,
        centerY: box.top + box.height / 2,
      };
    });
    const seatActions = [...document.querySelectorAll(".seat-actions")].map((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        owner: element
          .closest(".seat-anchor")
          ?.querySelector(".table-card")
          ?.getAttribute("aria-label"),
      };
    });
    const phaseTitleBox = box(".game-shell .game-header h1");
    const phaseTitleObstructions = [...document.querySelectorAll(".seat-actions")].filter(
      (element) => {
        const bounds = element.getBoundingClientRect();
        return !(
          bounds.right <= phaseTitleBox.left ||
          bounds.left >= phaseTitleBox.right ||
          bounds.bottom <= phaseTitleBox.top ||
          bounds.top >= phaseTitleBox.bottom
        );
      },
    );
    return {
      appScroll: { left: appShell.scrollLeft, top: appShell.scrollTop },
      cards,
      seatActions,
      essential: {
        game: box(".game-shell"),
        header: box(".game-header"),
        phaseTitle: phaseTitleBox,
        toolbar: box(".app-fixed-toolbar"),
        table: box(".table-workspace"),
        rail: box(".live-side-panel.has-live-utilities"),
        timer: box(".timer-panel"),
        voting: box(".nomination-panel"),
        music: box(".live-side-panel .youtube-dock"),
      },
      headerTitle: {
        left: headerTitleBox.left,
        right: headerTitleBox.right,
        top: headerTitleBox.top,
        bottom: headerTitleBox.bottom,
      },
      phaseTitleObstructionCount: phaseTitleObstructions.length,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
    };
  });
  if (geometry.cards.length !== 10) throw new Error("Expected ten player cards with no host tile");
  if (geometry.appScroll.left !== 0 || geometry.appScroll.top !== 0) {
    throw new Error(
      `Live application shell retained scrolling: ${JSON.stringify(geometry.appScroll)}`,
    );
  }
  for (const [name, bounds] of Object.entries(geometry.essential)) {
    if (
      bounds.width <= 0 ||
      bounds.height <= 0 ||
      bounds.left < -1 ||
      bounds.top < -1 ||
      bounds.right > geometry.viewportWidth + 1 ||
      bounds.bottom > geometry.viewportHeight + 1
    ) {
      throw new Error(`${name} is outside the fixed viewport: ${JSON.stringify(bounds)}`);
    }
  }
  const fullscreenExitSafeArea = { right: 88, bottom: 88 };
  if (
    geometry.headerTitle.left < fullscreenExitSafeArea.right &&
    geometry.headerTitle.right > 0 &&
    geometry.headerTitle.top < fullscreenExitSafeArea.bottom &&
    geometry.headerTitle.bottom > 0
  ) {
    throw new Error(
      `Game header title overlaps the fullscreen exit safe area: ${JSON.stringify(geometry.headerTitle)}`,
    );
  }
  const [referenceCard] = geometry.cards;
  if (referenceCard === undefined) throw new Error("Expected table cards");
  for (const card of geometry.cards) {
    if (Math.abs(card.width - referenceCard.width) > 0.5) {
      throw new Error(`Card width mismatch for ${card.label ?? "unknown"}`);
    }
    if (Math.abs(card.height - referenceCard.height) > 0.5) {
      throw new Error(`Card height mismatch for ${card.label ?? "unknown"}`);
    }
  }

  for (let leftIndex = 0; leftIndex < geometry.cards.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < geometry.cards.length; rightIndex += 1) {
      const left = geometry.cards[leftIndex];
      const right = geometry.cards[rightIndex];
      if (left === undefined || right === undefined) continue;
      const overlaps =
        Math.min(left.right, right.right) > Math.max(left.left, right.left) &&
        Math.min(left.bottom, right.bottom) > Math.max(left.top, right.top);
      if (overlaps)
        throw new Error(`${left.label ?? "Table card"} overlaps ${right.label ?? "Table card"}`);
    }
  }
  if (geometry.documentWidth > geometry.viewportWidth) {
    throw new Error("Live layout clips horizontally");
  }
  if (geometry.documentHeight > geometry.viewportHeight + 1) {
    throw new Error(
      `Primary live layout scrolls vertically (${geometry.documentHeight}px > ${geometry.viewportHeight}px)`,
    );
  }
  if (geometry.phaseTitleObstructionCount > 0) {
    throw new Error(
      `Phase title is obstructed by ${geometry.phaseTitleObstructionCount} seat control group(s)`,
    );
  }
  for (const card of geometry.cards) {
    if (card.top < 0 || card.bottom > geometry.viewportHeight) {
      throw new Error(`${card.label ?? "Table card"} is outside the fixed viewport`);
    }
  }
  for (const actions of geometry.seatActions) {
    if (
      actions.left < 0 ||
      actions.right > geometry.viewportWidth ||
      actions.top < 0 ||
      actions.bottom > geometry.viewportHeight
    ) {
      throw new Error(`Seat actions are outside the fixed viewport: ${JSON.stringify(actions)}`);
    }
    for (const card of geometry.cards) {
      if (card.label === actions.owner) continue;
      const overlaps =
        Math.min(actions.right, card.right) - Math.max(actions.left, card.left) > 1 &&
        Math.min(actions.bottom, card.bottom) - Math.max(actions.top, card.top) > 1;
      if (overlaps) {
        throw new Error(
          `${actions.owner ?? "Seat"} actions overlap ${card.label ?? "another card"}`,
        );
      }
    }
  }

  for (const seconds of [60, 30, 10]) {
    await page.getByRole("button", { name: `Start ${seconds} second timer` }).click();
    await page.getByRole("button", { name: "Pause timer" }).click();
  }
  const audioStarts = await page.evaluate(() => window.__mafiaAudioStarts);
  if (
    audioStarts.length !== 3 ||
    audioStarts.some((delay, index) => Math.abs(delay - [50, 20, 0][index]) > 0.001)
  ) {
    throw new Error(`Timer warning chimes were not scheduled at 10 seconds: ${audioStarts}`);
  }
  await page.getByRole("button", { name: "Music fade in" }).waitFor();
  await page.getByRole("button", { name: "Quick music fade out" }).waitFor();
  await page.getByRole("button", { name: "Slow music fade out" }).waitFor();
  if (
    (await page.getByLabel("Choose next YouTube track").count()) !== 0 ||
    (await page.getByRole("button", { name: "Set next track" }).count()) !== 0
  ) {
    throw new Error(
      "YouTube playlist order must not expose an application-level next-track override",
    );
  }
  await page.getByRole("button", { name: "Continue night zero to Sheriff wake-up" }).click();
  await page.getByRole("button", { name: "Begin day one" }).click();
  const dayTitleGeometry = await page.evaluate(() => {
    const title = document.querySelector(".game-shell .game-header h1");
    if (!(title instanceof HTMLElement)) throw new Error("Missing day phase title");
    const titleBox = title.getBoundingClientRect();
    const obstructions = [...document.querySelectorAll(".seat-actions, .table-card")]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return !(
          box.right <= titleBox.left ||
          box.left >= titleBox.right ||
          box.bottom <= titleBox.top ||
          box.top >= titleBox.bottom
        );
      })
      .map((element) => {
        const box = element.getBoundingClientRect();
        return {
          className: element.className,
          label: element.getAttribute("aria-label"),
          rect: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
        };
      });
    return {
      title: {
        left: titleBox.left,
        right: titleBox.right,
        top: titleBox.top,
        bottom: titleBox.bottom,
      },
      obstructions,
    };
  });
  if (dayTitleGeometry.obstructions.length > 0) {
    throw new Error(`Day phase title obstruction: ${JSON.stringify(dayTitleGeometry)}`);
  }
  const activeSeat = page.locator('.player-seat[aria-current="step"]');
  await activeSeat.waitFor();
  await assertSupportedPlayerLighting(activeSeat, "Current player card");
  const selectLightingRenderer = async (value) => {
    await page.getByRole("button", { name: "Open developer menu" }).click();
    const requestedRenderer = await page
      .locator(".app-shell")
      .getAttribute("data-lighting-renderer-requested");
    const wantsVgpu = value === "vgpu";
    if ((requestedRenderer === "vgpu") !== wantsVgpu) {
      const raytracing = page.getByRole("button", {
        name: wantsVgpu ? "Enable Raytracing" : "Disable Raytracing",
      });
      if (wantsVgpu) {
        await raytracing.focus();
        await page.keyboard.press("Space");
      } else {
        await raytracing.click();
      }
    }
    await page.getByRole("button", { name: "Close developer menu" }).click();
  };

  await selectLightingRenderer("legacy");
  await page.locator('.app-shell[data-lighting-renderer="legacy"]').waitFor();
  const legacyEvidence = await activeSeat.evaluate((card) => {
    const table = document.querySelector(".round-table");
    return {
      cardAnimation: getComputedStyle(card).animationName,
      tableBackground: table === null ? "" : getComputedStyle(table, "::before").backgroundImage,
    };
  });
  if (
    !legacyEvidence.cardAnimation.includes("active-player-pulse") ||
    !legacyEvidence.tableBackground.includes("gradient")
  ) {
    throw new Error(`Legacy lighting changed: ${JSON.stringify(legacyEvidence)}`);
  }
  const legacyLightingScreenshotPath = tableScreenshotPath.replace(/\.png$/i, "-legacy.png");
  await page.screenshot({ path: legacyLightingScreenshotPath, fullPage: true });

  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedMotionEvidence = await activeSeat.evaluate((card) => {
    const table = document.querySelector(".round-table");
    return {
      player: getComputedStyle(card).animationName,
      tableBackground: table === null ? "" : getComputedStyle(table, "::before").backgroundImage,
    };
  });
  if (
    reducedMotionEvidence.player !== "none" ||
    !reducedMotionEvidence.tableBackground.includes("gradient")
  ) {
    throw new Error(
      `Reduced motion must preserve static CSS lighting: ${JSON.stringify(reducedMotionEvidence)}`,
    );
  }
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await selectLightingRenderer("vgpu");
  await page.locator('.app-shell[data-lighting-renderer-requested="vgpu"]').waitFor();
  await page.waitForFunction(() => {
    const shell = document.querySelector(".app-shell");
    return (
      (document.querySelector(".vgpu-table-lighting")?.getAttribute("data-vgpu-ready") === "true" &&
        document
          .querySelector('.player-seat[aria-current="step"] .vgpu-player-lighting')
          ?.getAttribute("data-vgpu-ready") === "true") ||
      shell?.getAttribute("data-vgpu-status") === "fallback"
    );
  });
  const effectiveVgpuRenderer = await page
    .locator(".app-shell")
    .getAttribute("data-lighting-renderer");
  let fallbackVisible = false;
  if (effectiveVgpuRenderer === "legacy") {
    await page.getByRole("button", { name: "Open developer menu" }).click();
    fallbackVisible = await page.getByText("V-GPU unavailable — using existing CSS").isVisible();
    await page.getByRole("button", { name: "Close developer menu" }).click();
  }
  const vgpuEvidence = await page.evaluate(() => ({
    requested: document
      .querySelector(".app-shell")
      ?.getAttribute("data-lighting-renderer-requested"),
    effective: document.querySelector(".app-shell")?.getAttribute("data-lighting-renderer"),
    tableReady: document.querySelector(".vgpu-table-lighting")?.getAttribute("data-vgpu-ready"),
    playerReady: document
      .querySelector('.player-seat[aria-current="step"] .vgpu-player-lighting')
      ?.getAttribute("data-vgpu-ready"),
    playerCanvas: (() => {
      const canvas = document.querySelector(
        '.player-seat[aria-current="step"] .vgpu-player-lighting',
      );
      if (!(canvas instanceof HTMLCanvasElement)) return null;
      const bounds = canvas.getBoundingClientRect();
      return {
        width: canvas.width,
        height: canvas.height,
        cssWidth: bounds.width,
        cssHeight: bounds.height,
      };
    })(),
  }));
  vgpuEvidence.fallbackVisible = fallbackVisible;
  if (
    vgpuEvidence.requested !== "vgpu" ||
    (vgpuEvidence.effective === "vgpu"
      ? vgpuEvidence.tableReady !== "true" || vgpuEvidence.playerReady !== "true"
      : vgpuEvidence.effective !== "legacy" || !vgpuEvidence.fallbackVisible)
  ) {
    throw new Error(
      `V-GPU renderer neither became ready nor fell back: ${JSON.stringify(vgpuEvidence)}`,
    );
  }
  const vgpuTableLightingEvidence = await assertSupportedTableLighting(
    page,
    "V-GPU table lighting",
  );
  const vgpuPlayerLightingEvidence = await assertSupportedPlayerLighting(
    activeSeat,
    "V-GPU current player card",
  );
  const vgpuLightingScreenshotPath = tableScreenshotPath.replace(/\.png$/i, "-vgpu.png");
  await page.screenshot({ path: vgpuLightingScreenshotPath, fullPage: true });
  let vgpuPlayerLightingScreenshotPath = null;
  let vgpuPlayerCanvasScreenshotPath = null;
  if (vgpuEvidence.effective === "vgpu") {
    vgpuPlayerLightingScreenshotPath = tableScreenshotPath.replace(/\.png$/i, "-vgpu-player.png");
    const vgpuPlayerBox = await activeSeat.boundingBox();
    if (vgpuPlayerBox === null) throw new Error("V-GPU current player card has no layout box");
    await page.screenshot({
      path: vgpuPlayerLightingScreenshotPath,
      clip: {
        x: Math.max(0, vgpuPlayerBox.x - 24),
        y: Math.max(0, vgpuPlayerBox.y - 24),
        width: vgpuPlayerBox.width + 48,
        height: vgpuPlayerBox.height + 48,
      },
    });
    vgpuPlayerCanvasScreenshotPath = tableScreenshotPath.replace(
      /\.png$/i,
      "-vgpu-player-canvas.png",
    );
    const isolationStyle = await page.addStyleTag({
      content: `
        .player-seat[aria-current="step"] {
          background: #000 !important;
          border-color: transparent !important;
          box-shadow: none !important;
        }
        .player-seat[aria-current="step"] > :not(.vgpu-player-lighting) {
          visibility: hidden !important;
        }
      `,
    });
    await activeSeat.locator(".vgpu-player-lighting").screenshot({
      path: vgpuPlayerCanvasScreenshotPath,
    });
    await isolationStyle.evaluate((style) => style.remove());
  }

  await page.getByRole("button", { name: "Open developer menu" }).click();
  if (await page.getByRole("button", { name: /player LEDs/i }).count()) {
    throw new Error("The retired Player LEDs switch must not be offered");
  }
  await page.getByRole("button", { name: "Close developer menu" }).click();
  const alwaysEnabledPlayerLightingEvidence = await assertSupportedPlayerLighting(
    activeSeat,
    "Always-enabled current player card",
  );
  const independentTableLightingEvidence = await assertSupportedTableLighting(
    page,
    "Independent table lighting",
  );
  await page.getByRole("button", { name: "Open developer menu" }).click();
  await page.getByRole("button", { name: "Disable player glow pulse" }).click();
  await page.getByLabel("Player glow pulse speed").fill("2.5");
  await page.getByLabel("Player glow pulse strength").fill("40");
  await page.getByRole("button", { name: "Close developer menu" }).click();
  await page
    .locator(
      '.app-shell[data-player-pulse="disabled"][data-player-pulse-speed="2.5"][data-player-pulse-strength="0.4"]',
    )
    .waitFor();
  const playerPulseEvidence = await page.locator(".app-shell").evaluate((shell) => ({
    enabled: shell.getAttribute("data-player-pulse"),
    speed: shell.getAttribute("data-player-pulse-speed"),
    strength: shell.getAttribute("data-player-pulse-strength"),
  }));
  if (
    playerPulseEvidence.enabled !== "disabled" ||
    playerPulseEvidence.speed !== "2.5" ||
    playerPulseEvidence.strength !== "0.4"
  ) {
    throw new Error(
      `Player pulse controls did not persist live values: ${JSON.stringify(playerPulseEvidence)}`,
    );
  }
  await page.getByRole("button", { name: "Open developer menu" }).click();
  await page.getByRole("button", { name: "Enable player glow pulse" }).click();
  await page.getByLabel("Player glow pulse speed").fill("1");
  await page.getByLabel("Player glow pulse strength").fill("5");
  await page.getByRole("button", { name: "Close developer menu" }).click();
  await page
    .locator(
      '.app-shell[data-player-pulse="enabled"][data-player-pulse-speed="1"][data-player-pulse-strength="0.05"]',
    )
    .waitFor();
  await page.screenshot({ path: tableScreenshotPath, fullPage: true });
  await page.getByRole("button", { name: "Exit fullscreen" }).click();
  await page.waitForFunction(() => document.fullscreenElement === null);
  assertNoPageErrors();
  // Retain every legacy regression first, then qualify the real fresh v2 default.
  console.log("Legacy UI regression journey: PASS (federation journey still required)");
  await page.goto(new URL("/health/ready", expectedOrigin).href);
  await page.evaluate(() => localStorage.clear());
  mockSessions.clear();
  await verifyFederationJourney();
  assertNoPageErrors();
  console.log(
    `UI browser verification: PASS ${JSON.stringify({ playersScreenshotPath, selectionScreenshotPath, screenshotPath, tableScreenshotPath, legacyLightingScreenshotPath, vgpuLightingScreenshotPath, vgpuPlayerLightingScreenshotPath, vgpuPlayerCanvasScreenshotPath, vgpuEvidence, vgpuTableLightingEvidence, vgpuPlayerLightingEvidence, reducedMotionEvidence, alwaysEnabledPlayerLightingEvidence, independentTableLightingEvidence, playerPulseEvidence })}`,
  );
} catch (error) {
  if (!page.isClosed()) {
    await page
      .screenshot({
        path:
          process.env.UI_FAILURE_SCREENSHOT ?? screenshotPath.replace(/\.png$/i, "-failure.png"),
        animations: "disabled",
      })
      .catch(() => {});
  }
  throw error;
} finally {
  await browser.close();
}
