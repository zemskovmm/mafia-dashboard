/* global document, getComputedStyle */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

// Run through verify-ui.mjs with UI_LAYOUT_ONLY=1 to reuse its isolated API fixtures.
export async function verifyIpadLayout(
  page,
  { assertVisibleFocus, assertCoreLayout, assertCoreTargets },
) {
  const output = process.env.UI_LAYOUT_OUTPUT ?? ".AI/ipad-layout";
  await mkdir(output, { recursive: true });
  const trigger = page.getByRole("button", { name: "Open Manage menu" });
  for (const input of ["touch", "keyboard"]) {
    if (input === "touch") await trigger.tap();
    else {
      await assertVisibleFocus(trigger, "Manage trigger");
      await page.keyboard.press("Enter");
    }
    const heading = page.getByRole("heading", { name: "Manage", exact: true });
    await heading.waitFor();
    const focus = await heading.evaluate((element) => ({
      focused: document.activeElement === element,
      outline: getComputedStyle(element).outlineStyle,
    }));
    await page.screenshot({ path: `${output}/manage-${input}.png` });
    assert.equal(focus.focused, true, "Manage must retain accessible heading focus");
    assert.equal(focus.outline, "none", "Static Manage title must not have an input-like outline");
    await assertVisibleFocus(page.getByRole("button", { name: "Start new game" }), "Manage action");
    await page.keyboard.press("Escape");
    assert.equal(await trigger.evaluate((element) => document.activeElement === element), true);
  }

  await page.getByRole("button", { name: "Select available players" }).click();
  const available = page.getByRole("button", { name: /^Mark UI Player \d+ available$/ });
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
    await page.screenshot({ path: `${output}/${label}.png` });
    const geometry = await page.evaluate(() => {
      const box = (element) => {
        const { left, right, top, bottom } = element.getBoundingClientRect();
        return { left, right, top, bottom };
      };
      const workspace = box(document.querySelector(".table-workspace"));
      const cards = [...document.querySelectorAll(".seat-anchor .table-card")].map((element) => ({
        seat: element.closest(".seat-anchor").dataset.seat,
        ...box(element),
      }));
      const top = Math.min(...cards.map((card) => card.top)) - workspace.top;
      const bottom = workspace.bottom - Math.max(...cards.map((card) => card.bottom));
      return { workspace, cards, top, bottom };
    });
    console.log(`${label}: ${JSON.stringify(geometry)}`);
    assert.equal(geometry.cards.length, 10);
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
    assert.ok(
      Math.abs(geometry.top - geometry.bottom) <= 2,
      `${label}: unequal top/bottom clearance`,
    );
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
  await page.getByRole("button", { name: "Continue night zero to Sheriff wake-up" }).click();
  await page.getByRole("button", { name: "Begin day one" }).click();
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

  for (let index = 0; index < 2; index += 1) {
    const current = await page.locator(".player-seat.is-current .seat-name").innerText();
    await page.getByRole("button", { name: `Nominate ${current}`, exact: true }).click();
    await page.getByRole("button", { name: "Next player", exact: true }).click();
  }
  const next = page.getByRole("button", { name: "Next player", exact: true });
  while (await next.count()) await next.click();
  await page.getByRole("button", { name: "Begin voting" }).click();
  const identity = page.getByRole("group", { name: "Voting candidate" }).locator("strong");
  await identity.waitFor();
  for (const viewport of [
    { width: 1376, height: 900 },
    { width: 1376, height: 1032 },
    { width: 1024, height: 768 },
    { width: 1366, height: 768 },
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
    const originalName = await identity.textContent();
    for (const name of [originalName, `#10 ${"Александра".repeat(8)}`]) {
      await identity.evaluate((element, text) => {
        element.textContent = text;
      }, name);
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
    }
    await identity.evaluate((element, text) => {
      element.textContent = text;
    }, originalName);
    await checkTable(`voting-${viewport.width}x${viewport.height}`);
  }

  await page.setViewportSize({ width: 1376, height: 900 });
  await page.getByRole("button", { name: "Open developer menu" }).click();
  await page.getByRole("button", { name: "Enable dev mode" }).click();
  await page.getByRole("button", { name: "Past game timeline" }).click();
  await page.getByRole("heading", { name: "Game timeline" }).waitFor();
  // Stress native controls' intrinsic sizing with a supported long nickname.
  await page
    .getByLabel("Player", { exact: true })
    .locator("option")
    .last()
    .evaluate((option) => {
      option.textContent = "Александра".repeat(8);
    });
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
