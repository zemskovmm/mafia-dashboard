/* global document, getComputedStyle, requestAnimationFrame, window, Response, URL, performance */
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { menu, statisticsFixture, wheelToEnd } from "./GlassScene.host-ui-scenarios.mjs";

// Reuses the actual ClubWorkspace bundle and its disposable canonical fixtures.
export async function verifyTabletUi({ browser, config, url, evidence, results }) {
  const checks = [];
  for (const enhanced of [false, true]) {
    for (const phase of ["setup", "night", "voting", "role"]) {
      const page = await browser.newPage({ viewport: config.viewport, hasTouch: true });
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/*", (route) =>
        new URL(route.request().url()).origin === url ? route.continue() : route.abort(),
      );
      const label = `${config.name}-${phase}-${enhanced ? "glass" : "fallback"}`;
      const check = async (name, run) => {
        try {
          checks.push({ label, name, result: await run() });
        } catch (error) {
          checks.push({ label, name, failure: error.message });
        }
        await page.screenshot({ path: join(evidence, `${label}-${name}.png`) });
      };
      try {
        await page.goto(
          `${url}/?phase=${phase === "role" ? "setup" : phase}${enhanced ? "&glass" : ""}`,
        );
        await page
          .locator(["setup", "role"].includes(phase) ? ".player-setup-card" : ".game-shell")
          .waitFor();
        if (enhanced)
          await page.waitForFunction(
            () => document.querySelector(".app-shell").dataset.glassStatus === "ready",
          );
        if (phase === "role") {
          await page.getByRole("button", { name: "Select available players", exact: true }).click();
          await page.locator(".availability-player-card").first().waitFor();
          for (const player of await page.locator(".availability-player-card").all())
            if ((await player.getAttribute("aria-pressed")) !== "true") await player.click();
          await page.locator(".availability-close-button").click();
          await page.getByRole("button", { name: "Start game", exact: true }).click();
          const card = page.locator('.role-draw-screen .seat-anchor[data-seat="1"] > .player-seat');
          await check("reveal-frames", async () => {
            // Sample the real, uninterrupted animation. Pausing WAAPI would race
            // its intentional wall-clock safety timeout and test an impossible UI.
            const sampling = card.evaluate(
              (node) =>
                new Promise((resolve) => {
                  const deadline = performance.now() + 5000;
                  const frames = [];
                  let current;
                  let started;
                  const sample = () => {
                    const moving = node.classList.contains("is-role-flipping");
                    if (moving) {
                      started ??= performance.now();
                      current ??= node.querySelector(".role-draw-face--back");
                      frames.push({
                        elapsed: performance.now() - started,
                        painted: node.dataset.glassPainted,
                        rotate: getComputedStyle(node).rotate,
                        front: getComputedStyle(node.querySelector(".role-draw-face--front"))
                          .visibility,
                        back: getComputedStyle(current).visibility,
                      });
                    }
                    if (started !== undefined && !moving)
                      resolve({
                        frames,
                        retained: current.isConnected,
                        visible: getComputedStyle(current).visibility,
                      });
                    else if (performance.now() >= deadline) resolve({ frames, timeout: true });
                    else requestAnimationFrame(sample);
                  };
                  requestAnimationFrame(sample);
                }),
            );
            await card.click();
            await page.screenshot({ path: join(evidence, `${label}-flip-start.png`) });
            await page.waitForTimeout(180);
            await page.screenshot({ path: join(evidence, `${label}-flip-middle.png`) });
            const sampled = await sampling;
            assert.ok(
              sampled.frames.length >= 2 && !sampled.timeout,
              "Actual reveal animation sampled",
            );
            assert.ok(
              sampled.frames
                .filter((frame) => frame.elapsed > 50)
                .every((frame) => frame.painted !== "true"),
              "No screen-space second perimeter while rotating",
            );
            assert.equal(sampled.retained, true, "Settled icon face is not remounted");
            assert.equal(sampled.visible, "visible");
            return sampled;
          });
        } else if (phase === "setup") {
          await check("bounds-heading", async () => {
            const geometry = await page.evaluate(() => {
              const rect = (selector) =>
                document.querySelector(selector).getBoundingClientRect().toJSON();
              return {
                main: rect(".player-setup-card"),
                side: rect(".live-side-panel"),
                title: rect(".player-setup-heading h1"),
                controls: rect(".player-setup-controls"),
                host: rect("#host-player"),
              };
            });
            assert.ok(geometry.main.bottom <= config.viewport.height, JSON.stringify(geometry));
            assert.ok(Math.abs(geometry.main.bottom - geometry.side.bottom) <= 2);
            assert.ok(
              geometry.host.top - geometry.controls.bottom < 75,
              "No reserved empty block above Host",
            );
            if (config.viewport.width >= 1160)
              assert.ok(
                geometry.controls.top < geometry.title.bottom,
                "Switches share heading row",
              );
            return geometry;
          });
          await check("tournament-inline", async () => {
            await page.evaluate(() => {
              const fetch = window.fetch;
              window.fetch = (url, options) =>
                new URL(url, window.location.origin).pathname === "/api/tournaments"
                  ? Promise.resolve(
                      new Response(
                        JSON.stringify({
                          tournaments: [{ id: "fixture-cup", name: "Autumn cup" }],
                        }),
                        { headers: { "Content-Type": "application/json" } },
                      ),
                    )
                  : fetch(url, options);
            });
            await page.locator(".tournament-picker--compact > label").click();
            const dropdown = page.getByRole("combobox", { name: "Tournament", exact: true });
            await dropdown.selectOption("fixture-cup");
            const bounds = await dropdown.boundingBox();
            const toggle = await page.locator(".tournament-picker--compact > label").boundingBox();
            assert.ok(
              bounds.x >= toggle.x + toggle.width,
              "Dropdown on right of switch when space permits",
            );
            assert.equal(
              await page.locator(".tournament-picker--compact p").count(),
              0,
              "No redundant compact guidance",
            );
            await page.locator(".tournament-picker--compact > label").click();
            return { bounds, toggle };
          });
          await menu(page, "Players screen");
          await page.locator(".player-card-grid > article").last().waitFor();
          await check("players-touch", () =>
            wheelToEnd(page, ".players-shell", ".player-card-grid > article"),
          );
          await page.getByRole("button", { name: "Back to game", exact: true }).click();
          await statisticsFixture(page);
          await menu(page, "Statistics");
          await page.getByRole("button", { name: "Statistics fixture 36", exact: true }).waitFor();
          await check("statistics-touch", () =>
            wheelToEnd(
              page,
              ".statistics-screen",
              ".statistics-table tbody tr:not(.statistics-group)",
            ),
          );
        } else if (phase === "night") {
          await check("advance-clearance", async () => {
            const bounds = await page
              .locator(".table-advance button")
              .first()
              .evaluate((button) => {
                const a = button.getBoundingClientRect();
                const conflicts = [
                  ...document.querySelectorAll(".seat-actions button, .table-night-center"),
                ].filter((el) => {
                  const b = el.getBoundingClientRect();
                  return (
                    Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
                    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
                  );
                });
                return { rect: a.toJSON(), conflicts: conflicts.length };
              });
            assert.equal(bounds.conflicts, 0, JSON.stringify(bounds));
            return bounds;
          });
          await page.locator('.seat-anchor[data-seat="7"] > .player-seat').click();
          await page
            .getByRole("button", { name: "Observed multiple shooting", exact: true })
            .click();
          await page.locator('.seat-anchor[data-seat="6"] .shooter-button').first().click();
          await check("shot-count", async () => {
            assert.equal(
              await page
                .locator('.seat-anchor[data-seat="6"] .additional-shot-count')
                .textContent(),
              "+1",
            );
          });
          await page.locator(".table-advance button").click();
          await page.locator(".phase-night-mafia-result").waitFor();
          await page.locator(".table-advance button").click();
          for (const role of ["don", "sheriff"]) {
            await page.locator(`.phase-night-${role}`).waitFor();
            for (const result of [false, true]) {
              if (result) {
                await page.locator(".player-seat:enabled").first().click();
                await page.locator(`.phase-night-${role}-result`).waitFor();
                await page.waitForTimeout(300);
              }
              await check(`${role}-${result ? "result" : "check"}-clearance`, async () => {
                const targets = await page.locator(".table-advance button").evaluateAll((buttons) =>
                  buttons.map((button) => {
                    const r = button.getBoundingClientRect();
                    return {
                      label: button.textContent,
                      hit: [
                        // Edge midpoints are inside the rounded hit shape;
                        // bounding-box corners intentionally are not.
                        [r.left + 3, r.y + r.height / 2],
                        [r.right - 3, r.y + r.height / 2],
                        [r.x + r.width / 2, r.top + 3],
                        [r.x + r.width / 2, r.bottom - 3],
                        [r.x + r.width / 2, r.y + r.height / 2],
                      ].every(([x, y]) => button.contains(document.elementFromPoint(x, y))),
                    };
                  }),
                );
                assert.ok(
                  targets.length > 0 && targets.every((target) => target.hit),
                  JSON.stringify(targets),
                );
                return targets;
              });
            }
            await page.locator(".table-advance button").click();
          }
        } else {
          await check("candidate-markers", async () => {
            assert.equal(await page.locator(".card-nomination-symbol").count(), 2);
            assert.equal(
              await page.locator('.seat-anchor[data-seat="2"] > .is-voting-candidate').count(),
              1,
            );
          });
          await check("sharp-row", async () => {
            const material = await page
              .locator(".nomination-panel .is-voting-highlight .nomination-row-target")
              .evaluate((node) => ({
                backdrop: getComputedStyle(node).backdropFilter,
                background: getComputedStyle(node).backgroundColor,
              }));
            assert.equal(material.backdrop, "none", "Row hit target must not blur text beneath it");
            return material;
          });
          await check("timer-roll", async () => {
            const panel = page.locator("#game-utility-panels");
            const sample = () =>
              panel.locator(".timer-panel").evaluate(
                (node) =>
                  new Promise((resolve) => {
                    const start = performance.now();
                    const frames = [];
                    const tick = () => {
                      frames.push({
                        y: node.getBoundingClientRect().top,
                        opacity: getComputedStyle(node.closest(".panel-reveal-content")).opacity,
                      });
                      if (performance.now() - start >= 420) resolve(frames);
                      else requestAnimationFrame(tick);
                    };
                    requestAnimationFrame(tick);
                  }),
              );
            const hiding = sample();
            await page.locator('.panel-swipe-handle[aria-controls="game-utility-panels"]').click();
            const hide = await hiding;
            assert.ok(
              hide.every((frame) => frame.opacity === "1"),
              "Timer rolls instead of fading",
            );
            assert.ok(
              hide.at(-1).y < hide[0].y - 20,
              "Controls finish above their expanded position",
            );
            assert.ok(
              hide.every((frame, index) => index === 0 || frame.y <= hide[index - 1].y + 1),
              "Concealment never reverses downward",
            );
            assert.equal(await panel.getAttribute("inert"), "");
            const revealing = sample();
            await page.locator('.panel-swipe-handle[aria-controls="game-utility-panels"]').click();
            const reveal = await revealing;
            assert.ok(
              reveal.every((frame, index) => index === 0 || frame.y >= reveal[index - 1].y - 1),
              "Reveal never reverses upward",
            );
            return { hide, reveal };
          });
        }
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
        await writeFile(
          join(evidence, `${config.name}-tablet-ui.json`),
          JSON.stringify(checks, null, 2),
        );
      }
    }
  }
  results.push({ tabletUi: config.name, checks });
  assert.deepEqual(
    checks.filter((check) => check.failure),
    [],
    "Tablet UI regressions",
  );
}
