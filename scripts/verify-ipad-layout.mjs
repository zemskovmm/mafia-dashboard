/* global document, getComputedStyle, matchMedia */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { assertBalancedCardPlacement, assertCardSizes } from "./ui-presentation-contracts.mjs";

// Run through verify-ui.mjs with UI_LAYOUT_ONLY=1 to reuse its isolated API fixtures.
export async function verifyIpadLayout(
  page,
  { assertNativeControl, assertCoreLayout, assertCoreTargets, longNickname },
) {
  const output = process.env.UI_LAYOUT_OUTPUT ?? ".AI/ipad-layout";
  await mkdir(output, { recursive: true });
  const trigger = page.getByRole("button", { name: "Open Manage menu" });
  for (const input of ["touch", "keyboard"]) {
    if (input === "touch") await trigger.tap();
    else {
      await assertNativeControl(trigger, "Manage trigger");
      await page.keyboard.press("Enter");
    }
    const heading = page.getByRole("heading", { name: "Manage", exact: true });
    await heading.waitFor();
    const focus = await heading.evaluate((element) => ({
      focused: document.activeElement === element,
      outline: getComputedStyle(element).outlineStyle,
    }));
    await page.screenshot({ path: `${output}/manage-${input}.png` });
    assert.equal(focus.focused, false, "Manage must not force focus onto its heading");
    assert.equal(focus.outline, "none", "Static Manage title must not have an input-like outline");
    await assertNativeControl(
      page.getByRole("button", { name: "Start new game" }),
      "Manage action",
    );
    await page.keyboard.press("Escape");
    assert.equal(await heading.isVisible(), true, "Custom drawer Escape is retired");
    await page.getByRole("button", { name: "Close Manage menu" }).click();
  }

  await page.getByRole("button", { name: "Select available players" }).click();
  const available = page
    .locator(".availability-player-grid")
    .getByRole("button", { name: /^Mark .+ available$/ });
  assert.equal(await available.count(), 11);
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
  const checkTable = async (label) => {
    await page.locator(".table-stage").evaluate(async (stage) => {
      await Promise.all(
        stage
          .getAnimations({ subtree: true })
          .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => undefined)),
      );
    });
    await page.screenshot({ path: `${output}/${label}.png` });
    const geometry = await page.evaluate(() => {
      const box = (element) => {
        const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
        return { left, right, top, bottom, width, height };
      };
      const workspace = box(document.querySelector(".table-workspace"));
      const cards = [...document.querySelectorAll(".seat-anchor .table-card")].map((element) => {
        const style = getComputedStyle(element);
        const scale = style.scale;
        return {
          seat: element.closest(".seat-anchor").dataset.seat,
          layoutWidth: Number.parseFloat(style.width),
          layoutHeight: Number.parseFloat(style.height),
          emphasized: element.matches(".has-active-emphasis .is-current"),
          voted: element.matches(".is-voted:not(.is-current)"),
          votingCandidate: element.classList.contains("is-voting-candidate"),
          translateY:
            style.translate === "none" ? 0 : Number.parseFloat(style.translate.split(" ").at(-1)),
          scale: scale === "none" ? 1 : Number.parseFloat(scale),
          ...box(element),
        };
      });
      const top = Math.min(...cards.map((card) => card.top)) - workspace.top;
      const bottom = workspace.bottom - Math.max(...cards.map((card) => card.bottom));
      const controls = [...document.querySelectorAll(".seat-actions button, .table-advance button")]
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => ({
          label: element.getAttribute("aria-label") ?? element.textContent,
          ...box(element),
        }));
      const placement = {
        compactLandscape: matchMedia(
          "(min-width: 900px) and (max-width: 1159px) and (orientation: landscape)",
        ).matches,
        phase: [...document.querySelector(".game-shell").classList]
          .find((name) => name.startsWith("phase-"))
          ?.slice(6),
      };
      return { workspace, cards, controls, top, bottom, placement };
    });
    console.log(`${label}: ${JSON.stringify(geometry)}`);
    assert.equal(geometry.cards.length, 10);
    assertCardSizes(geometry.cards);
    for (const card of geometry.cards) {
      assert.ok(
        card.left >= geometry.workspace.left && card.right <= geometry.workspace.right,
        `${label}: seat ${card.seat} clipped horizontally`,
      );
      assert.ok(
        card.top >= geometry.workspace.top && card.bottom <= geometry.workspace.bottom,
        `${label}: seat ${card.seat} clipped vertically`,
      );
    }
    assertBalancedCardPlacement(geometry.workspace, geometry.cards, label, geometry.placement);
    if (label.startsWith("voting-")) {
      for (const [index, card] of geometry.cards.entries()) {
        for (const other of [...geometry.cards.slice(index + 1), ...geometry.controls]) {
          assert.ok(
            card.right <= other.left ||
              other.right <= card.left ||
              card.bottom <= other.top ||
              other.bottom <= card.top,
            `${label}: rendered seat ${card.seat} overlaps ${other.seat ?? other.label}`,
          );
        }
      }
    }
    // Portrait keeps the existing scrollable utilities and smaller action targets.
    const viewport = page.viewportSize();
    assert.ok(geometry.cards.every((card) => card.top >= 0 && card.bottom <= viewport.height));
    if (viewport.width > viewport.height) {
      await assertCoreTargets(label);
      await assertCoreLayout(label);
    }
  };
  await checkTable("role-draw");
  for (let index = 0; index < 10; index += 1) {
    await page
      .getByRole("button", { name: /^Draw role for / })
      .first()
      .click();
  }
  await page.getByRole("button", { name: "Begin Mafia planning stage" }).click();
  await page.getByRole("button", { name: "Mafia asleep", exact: true }).click();
  await page.getByRole("button", { name: "Begin round zero", exact: true }).click();
  for (const viewport of [
    { width: 1376, height: 900 },
    { width: 1376, height: 1032 },
    { width: 1032, height: 1244 },
    { width: 1194, height: 834 },
    { width: 1366, height: 768 },
    { width: 1376, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await checkTable(`day-${viewport.width}x${viewport.height}`);
  }
  const fullscreen = page.getByRole("button", { name: "Enter fullscreen" });
  if ((await fullscreen.count()) && (await fullscreen.isEnabled())) {
    await fullscreen.click();
    await page.getByRole("button", { name: "Exit fullscreen" }).waitFor();
    await page.setViewportSize({ width: 1376, height: 1032 });
    await checkTable("day-fullscreen");
    await page.getByRole("button", { name: "Exit fullscreen" }).click();
    await page.setViewportSize({ width: 1376, height: 900 });
    await checkTable("day-exit-fullscreen");
  } else {
    console.log(
      "Native fullscreen unavailable in mobile WebKit; fullscreen-sized viewport verified.",
    );
  }

  const ordinaryNickname = (await page.locator(".player-seat .seat-name").allTextContents()).find(
    (name) => name !== longNickname,
  );
  for (const nickname of [longNickname, ordinaryNickname]) {
    await page.getByRole("button", { name: `Nominate ${nickname}`, exact: true }).click();
    await page.getByRole("button", { name: "Next player", exact: true }).click();
  }
  const next = page.getByRole("button", { name: "Next player", exact: true });
  while (await next.count()) await next.click();
  await page.getByRole("button", { name: "Begin voting" }).click();
  const identity = page
    .getByRole("status", { name: "Voting candidate", exact: true })
    .locator(".voting-candidate-identity");
  await identity.waitFor();
  assert.ok((await identity.innerText()).includes(longNickname));
  const anchors = () =>
    page.locator(".seat-anchor").evaluateAll((nodes) =>
      nodes.map((node) => ({
        seat: node.dataset.seat,
        ...node.getBoundingClientRect().toJSON(),
      })),
    );
  const beforeVotes = await anchors();
  for (let seat = 1; seat <= 10; seat += 1) {
    await page.locator(`.seat-anchor[data-seat="${seat}"] .player-seat`).click();
  }
  await page.waitForFunction(
    () => document.querySelectorAll(".player-seat.is-current").length === 10,
  );
  assert.deepEqual(await anchors(), beforeVotes, "Voter emphasis must not move seat anchors");
  for (const nickname of [longNickname, ordinaryNickname]) {
    assert.ok((await identity.innerText()).includes(nickname));
    for (const viewport of [
      { width: 1366, height: 768 },
      { width: 1376, height: 819 },
      { width: 1194, height: 834 },
      { width: 1376, height: 900 },
      { width: 1376, height: 1032 },
      { width: 1024, height: 768 },
      { width: 1032, height: 1244 },
    ]) {
      await page.setViewportSize(viewport);
      const typography = await identity.evaluate((element) => {
        const originalClass = element.className;
        const size = Number.parseFloat(getComputedStyle(element).fontSize);
        element.className = "";
        const baseline = Number.parseFloat(getComputedStyle(element).fontSize);
        element.className = originalClass;
        return { size, baseline };
      });
      assert.ok(
        Math.abs(typography.size - typography.baseline * 2) < 0.01,
        `Candidate font must be 2x at ${viewport.width}: ${JSON.stringify(typography)}`,
      );
      const bounds = await identity.evaluate((element) => {
        const group = element.parentElement.getBoundingClientRect();
        const advance = document.querySelector(".table-advance").getBoundingClientRect();
        return {
          bottom: group.bottom,
          advanceTop: advance.top,
          overflow: element.scrollWidth > element.clientWidth,
        };
      });
      assert.ok(
        bounds.bottom + 6 <= bounds.advanceTop && !bounds.overflow,
        `Voting text overlaps controls at ${viewport.width}: ${JSON.stringify(bounds)}`,
      );
      await checkTable(
        `voting-${nickname === longNickname ? "emphasized" : "voted"}-${viewport.width}x${viewport.height}`,
      );
    }
    if (nickname === longNickname) {
      const beforeCandidate = await anchors();
      await page.getByRole("button", { name: "Next candidate", exact: true }).click();
      assert.deepEqual(await anchors(), beforeCandidate, "Candidate changes must not move anchors");
    }
  }

  await page.setViewportSize({ width: 1376, height: 900 });
  await page.getByRole("button", { name: "Open developer menu" }).click();
  assert.equal(await page.getByRole("button", { name: "Enable dev mode" }).count(), 0);
  await page.getByRole("button", { name: "Open Manage menu" }).click();
  await page.getByRole("button", { name: "Past game timeline" }).click();
  await page.getByRole("heading", { name: "Game timeline" }).waitFor();
  // The real directory nickname also stresses the native filter's intrinsic sizing.
  assert.equal(
    await page
      .getByLabel("Player", { exact: true })
      .getByRole("option", { name: longNickname, exact: true })
      .count(),
    1,
  );
  for (const viewport of [
    { width: 1376, height: 900 },
    { width: 1376, height: 1032 },
    { width: 1032, height: 1244 },
    { width: 600, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    for (const state of ["blank", "filled", "cleared"]) {
      if (state === "filled") {
        await page.getByLabel("From date", { exact: true }).fill("2026-09-01");
        await page.getByLabel("To date", { exact: true }).fill("2026-09-07");
        await page.getByLabel("Player", { exact: true }).selectOption({ label: "UI Player 1" });
        await page.getByLabel("Result", { exact: true }).selectOption("red");
      }
      if (state === "cleared") await page.getByRole("button", { name: "Clear filters" }).click();
      if (state !== "filled") {
        assert.equal(await page.getByLabel("From date", { exact: true }).inputValue(), "");
        assert.equal(await page.getByLabel("To date", { exact: true }).inputValue(), "");
        assert.equal(await page.getByLabel("Player", { exact: true }).inputValue(), "");
        assert.equal(await page.getByLabel("Result", { exact: true }).inputValue(), "");
      }
      const geometry = await page.locator(".timeline-filters").evaluate((filters) => {
        return [...filters.querySelectorAll("input, select, button")].map((element) => {
          const { left, right, top, bottom, height } = element.getBoundingClientRect();
          const cell = element.closest("label") ?? element;
          const bounds = cell.getBoundingClientRect();
          return {
            left,
            right,
            top,
            bottom,
            height,
            cellLeft: bounds.left,
            cellRight: bounds.right,
          };
        });
      });
      console.log(`timeline-${viewport.width}-${state}: ${JSON.stringify(geometry)}`);
      await page.screenshot({ path: `${output}/timeline-${viewport.width}-${state}.png` });
      assert.equal(geometry.length, 5);
      for (const control of geometry) {
        assert.ok(
          control.left >= control.cellLeft - 0.5 && control.right <= control.cellRight + 0.5,
          "Timeline control extends outside its grid cell",
        );
        assert.ok(
          Math.abs(control.height - geometry[0].height) < 1,
          "Timeline control heights differ",
        );
      }
      for (let index = 1; index < geometry.length; index += 1) {
        const previous = geometry[index - 1];
        const current = geometry[index];
        if (current.top < previous.bottom) {
          assert.ok(previous.right + 1 < current.left, "Timeline columns overlap");
          assert.ok(Math.abs(previous.top - current.top) < 1, "Timeline row is misaligned");
        }
      }
    }
  }
  await page.setViewportSize({ width: 1376, height: 900 });
  await page.locator(".timeline-marker").last().click();
  await page.getByRole("button", { name: "Preview timeline checkpoint" }).click();
  await page.getByRole("button", { name: "Exit preview" }).waitFor();
  await checkTable("history-preview");
  await page.getByRole("button", { name: "Exit preview" }).click();
}
