/* global window, document, localStorage, HTMLInputElement, Event, PointerEvent,
   getComputedStyle, requestAnimationFrame, HTMLCanvasElement */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { isSecretGameEventType } from "@mafia/game-domain";

// Keep a pre-build and post-run digest, including the package output actually
// consumed by the existing runner. A moving worktree is not final-tree proof.
export async function capturePlayerCardSources(root) {
  const files = {};
  async function visit(path) {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const full = join(path, item.name);
      if (item.isDirectory()) await visit(full);
      else if (!/\.(test|browser)\./.test(item.name) || /GlassScene\./.test(item.name))
        files[relative(root, full)] = createHash("sha256")
          .update(await readFile(full))
          .digest("hex");
    }
  }
  for (const path of ["apps/web/src", "packages/game-domain/src", "packages/game-domain/dist"])
    await visit(join(root, path));
  for (const path of [
    "package.json",
    "package-lock.json",
    "apps/web/package.json",
    "packages/game-domain/package.json",
  ])
    files[path] = createHash("sha256")
      .update(await readFile(join(root, path)))
      .digest("hex");
  const ordered = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  return {
    digest: createHash("sha256").update(JSON.stringify(ordered)).digest("hex"),
    files: ordered,
  };
}

const storageKey = "mafia-dashboard.game-session.v5";
const cardSelector = (seat) => `.game-shell .seat-anchor[data-seat="${seat}"] > .player-seat`;
const card = (page, seat) => page.locator(cardSelector(seat));
async function state(page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)).current.state, storageKey);
}
async function settle(page) {
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
}
async function changed(page, action) {
  const before = (await state(page)).events.length;
  await action();
  await page.waitForFunction(
    ({ key, before }) => JSON.parse(localStorage.getItem(key)).current.state.events.length > before,
    { key: storageKey, before },
    { timeout: 5000 },
  );
  await settle(page);
  const after = await state(page);
  assert.equal(after.events.length, before + 1, "Exactly one accepted canonical event per action");
  return after;
}
async function unchanged(page, action) {
  const before = await state(page);
  await action();
  await settle(page);
  assert.deepEqual(
    await state(page),
    before,
    "Presentation/cancel/no-op must not mutate canonical state",
  );
}
async function mouseDrag(page, seat, dx, dy) {
  const b = await card(page, seat).boundingBox();
  const x = b.x + b.width / 2,
    y = b.y + b.height * 0.35;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}
async function touchDrag(page, cdp, seat, options = {}) {
  const b = await card(page, seat).boundingBox();
  const x = b.x + b.width / 2,
    y = b.y + 12;
  const touch = { x, y, id: 1, radiusX: 3, radiusY: 3, force: 1 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touch] });
  if (options.multi)
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [touch, { ...touch, x: x + 9, id: 2 }],
    });
  for (let i = 1; i <= 5; i++)
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ ...touch, y: y + 12 * i }],
    });
  await cdp.send("Input.dispatchTouchEvent", {
    type: options.cancel ? "touchCancel" : "touchEnd",
    touchPoints: [],
  });
}
async function crossCardTouch(page, cdp, firstSeat, secondSeat) {
  const a = await card(page, firstSeat).boundingBox();
  const b = await card(page, secondSeat).boundingBox();
  const first = { x: a.x + a.width / 2, y: a.y + 10, id: 1, radiusX: 3, radiusY: 3, force: 1 };
  const second = { x: b.x + b.width / 2, y: b.y + 10, id: 2, radiusX: 3, radiusY: 3, force: 1 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [first] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [first, second] });
  // The second contact ends first; the remaining contact must not revive a swipe.
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [first] });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ ...first, y: first.y + 60 }],
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
async function setInput(page, label, value) {
  await page.getByLabel(label, { exact: true }).evaluate((input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(
      input,
      String(value),
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  await settle(page);
}
async function openControls(page) {
  await page.getByRole("button", { name: "Open developer menu", exact: true }).click();
  if (!(await page.locator(".dev-glass-controls").getAttribute("open"))) {
    // Boolean attributes are the empty string when open.
    if (!(await page.locator(".dev-glass-controls").evaluate((el) => el.open)))
      await page.locator(".dev-glass-controls > summary").click();
  }
  if (!(await page.locator(".dev-player-card-appearance").evaluate((el) => el.open)))
    await page.locator(".dev-player-card-appearance > summary").click();
}
async function geometry(page) {
  return page.locator(".game-shell .seat-anchor > .player-seat").evaluateAll((nodes) =>
    nodes.map((node) => {
      const outer = node.getBoundingClientRect();
      const scale = outer.width / node.offsetWidth;
      const rounded = (value) => Math.round(value * 100) / 100;
      const local = (el) => {
        const box = el.getBoundingClientRect();
        return {
          x: rounded((box.left - outer.left) / scale),
          y: rounded((box.top - outer.top) / scale),
          width: rounded(box.width / scale),
          height: rounded(box.height / scale),
        };
      };
      return {
        anchor: node.parentElement.getBoundingClientRect().toJSON(),
        card: local(node),
        person: local(node.querySelector(".person-icon")),
        name: local(node.querySelector(".seat-name")),
      };
    }),
  );
}
async function markerGeometry(page) {
  return page.locator(".game-shell .seat-anchor > .player-seat").evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = (el) => el.getBoundingClientRect().toJSON();
      return {
        seat: Number(node.parentElement.dataset.seat),
        scale: rect(node).width / node.offsetWidth,
        card: rect(node),
        person: rect(node.querySelector(".person-icon")),
        name: (() => {
          const range = document.createRange();
          range.selectNodeContents(node.querySelector(".seat-name"));
          return range.getBoundingClientRect().toJSON();
        })(),
        markers: [...node.querySelectorAll(".card-status-slot")].map((el) => {
          const children = [...el.children].map(rect);
          return {
            className: el.className,
            rect: rect(el),
            content: {
              left: Math.min(...children.map((r) => r.left)),
              right: Math.max(...children.map((r) => r.right)),
              top: Math.min(...children.map((r) => r.top)),
              bottom: Math.max(...children.map((r) => r.bottom)),
            },
            opacity: getComputedStyle(el).opacity,
            label: el.getAttribute("aria-label"),
          };
        }),
      };
    }),
  );
}
function assertMarkers(layout) {
  const overlaps = (a, b) =>
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
  for (const seat of layout) {
    assert.ok(seat.card.x >= 0 && seat.card.y >= 0, `Seat ${seat.seat} outside viewport`);
    for (const marker of seat.markers) {
      assert.ok(Math.abs(marker.rect.width / seat.scale - 25) < 0.1, marker.className);
      assert.ok(Number(marker.opacity) > 0, marker.className);
      assert.ok(
        marker.rect.left >= seat.card.left && marker.rect.right <= seat.card.right,
        `Marker outside card ${seat.seat}`,
      );
      assert.equal(
        overlaps(marker.content, seat.person),
        false,
        `Marker/person collision seat ${seat.seat}: ${marker.className}`,
      );
      assert.equal(
        overlaps(marker.content, seat.name),
        false,
        `Marker/name collision seat ${seat.seat}: ${marker.className}`,
      );
    }
    for (let i = 0; i < seat.markers.length; i++)
      for (let j = i + 1; j < seat.markers.length; j++)
        assert.equal(
          overlaps(seat.markers[i].content, seat.markers[j].content),
          false,
          `Marker collision seat ${seat.seat}`,
        );
  }
}

export async function verifyPlayerCards({ browser, config, url, evidence, results }) {
  // Each independent case survives another case failing; final runner still exits
  // nonzero on any failed case. Never turn a failed requirement into a skip.
  for (const kind of [
    "touch",
    ...(config.name.startsWith("chrome") ? ["touch-foul", "touch-cancellation"] : []),
    "integrated",
    "fallback",
    "legacy",
    "russian",
    "voting",
  ]) {
    const page = await browser.newPage({
      viewport: config.viewport,
      deviceScaleFactor: 2,
      hasTouch: true,
      reducedMotion: "reduce",
    });
    page.setDefaultTimeout(6000);
    const blockedRequests = [];
    const errors = [],
      checks = [],
      consoleMessages = [];
    const result = {
      engine: config.name,
      version: browser.version(),
      scenario: `player-cards-${kind}`,
      checks,
      status: "running",
    };
    results.push(result);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning")
        consoleMessages.push(message.text());
    });
    await page.addInitScript(() => {
      window.cardInputTrace = [];
      for (const type of [
        "pointerdown",
        "pointerup",
        "pointercancel",
        "gotpointercapture",
        "lostpointercapture",
        "touchstart",
        "touchend",
        "touchcancel",
        "click",
      ])
        document.addEventListener(
          type,
          (event) => {
            if (event.target.closest?.(".player-seat"))
              window.cardInputTrace.push({
                type,
                seat: event.target.closest(".seat-anchor")?.dataset.seat,
                target: event.target.tagName,
                pointerType: event.pointerType,
                defaultPrevented: event.defaultPrevented,
              });
          },
          true,
        );
    });
    await page.route("**/*", (route) => {
      if (
        route
          .request()
          .url()
          .startsWith(url + "/")
      )
        return route.continue();
      blockedRequests.push({
        url: route.request().url(),
        reason: "Expected exact-origin fixture isolation; not a product request failure",
      });
      return route.abort();
    });
    const check = async (name, fn) => {
      result.activeCheck = name;
      await fn();
      checks.push(name);
    };
    try {
      if (kind === "fallback")
        await page.addInitScript(() => {
          const get = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
            return kind === "webgl" ? null : get.call(this, kind, ...args);
          };
        });
      await page.goto(
        `${url}/?${kind === "voting" ? "" : "phase=player-cards"}${kind === "fallback" ? "&glass" : ""}${kind === "legacy" || kind === "touch-cancellation" ? "&edition=legacy" : ""}${kind === "russian" ? "&locale=ru" : ""}`,
      );
      await card(page, 1).waitFor();
      await page.waitForFunction(
        () =>
          document.querySelector('.game-shell .seat-anchor[data-seat="1"] .seat-name')
            ?.textContent === "Player 1",
      );
      await page.evaluate(() => document.fonts.ready);
      await check("ten real workspace cards; no old visible foul buttons", async () => {
        assert.equal(await page.locator(".game-shell .seat-anchor > .player-seat").count(), 10);
        assert.equal(await page.locator(".game-shell .seat-actions button").count(), 0);
      });
      if (kind === "touch") {
        await check(
          "trusted touch tap and retap create then remove exactly one relation",
          async () => {
            await changed(page, () => card(page, 2).tap());
            assert.equal(await card(page, 2).getAttribute("aria-pressed"), "true");
            await changed(page, () => card(page, 2).tap());
            assert.equal((await state(page)).game.nominations.length, 0);
          },
        );
      } else if (kind === "touch-foul") {
        await check("trusted Chrome downward touch after rejected nomination", async () => {
          const cdp = await page.context().newCDPSession(page);
          await changed(page, () => card(page, 2).click());
          await unchanged(page, () => card(page, 3).click());
          const next = await changed(page, () => touchDrag(page, cdp, 4));
          assert.equal(next.events.at(-1).type, "foul.issued");
          assert.equal(next.game.players.find((p) => p.seat === 4).fouls, 1);
          await unchanged(page, () => touchDrag(page, cdp, 7, { cancel: true }));
          await unchanged(page, () => touchDrag(page, cdp, 7, { multi: true }));
          await changed(page, () => card(page, 2).tap());
          await cdp.detach();
        });
      } else if (kind === "touch-cancellation") {
        const cdp = await page.context().newCDPSession(page);
        await check("trusted touchCancel emits no foul or nomination", () =>
          unchanged(page, () => touchDrag(page, cdp, 7, { cancel: true })),
        );
        await check("trusted multitouch emits no foul or nomination", () =>
          unchanged(page, () => touchDrag(page, cdp, 7, { multi: true })),
        );
        await check("cross-card second contact releases first without reviving swipe", () =>
          unchanged(page, () => crossCardTouch(page, cdp, 1, 2)),
        );
        await check("cross-card red-carded second contact also cancels shared swipe", async () => {
          for (let foul = 1; foul <= 4; foul++)
            await changed(page, async () => {
              await card(page, 2).focus();
              await page.keyboard.press("f");
            });
          assert.equal(
            (await state(page)).game.players.find((p) => p.seat === 2).status,
            "red-carded",
          );
          await unchanged(page, () => crossCardTouch(page, cdp, 1, 2));
        });
        await check("next intentional touch works after cancellation", () =>
          changed(page, () => card(page, 3).tap()),
        );
        await cdp.detach();
      } else if (kind === "russian") {
        await check("Russian action and marker accessibility", async () => {
          await changed(page, () =>
            page.getByRole("button", { name: "Выдвинуть игрока Player 2", exact: true }).click(),
          );
          assert.equal(
            await card(page, 2).getByRole("img", { name: "Выдвинут", exact: true }).count(),
            1,
          );
          assert.equal(
            await card(page, 2)
              .getByRole("img", { name: "Выбран текущим выступающим", exact: true })
              .count(),
            1,
          );
          assert.equal(await card(page, 4).getAttribute("aria-keyshortcuts"), "F");
          assert.match(await card(page, 4).getAttribute("title"), /Смахните вниз/);
          await changed(page, async () => {
            await card(page, 4).focus();
            await page.keyboard.press("f");
          });
          assert.equal(
            await card(page, 4).getByRole("img", { name: "Фол ×1", exact: true }).count(),
            1,
          );
        });
      } else if (kind === "voting") {
        await check("real ballot tap and retap remain votes, never supports", async () => {
          const before = await state(page);
          const next = await changed(page, () => card(page, 1).click());
          assert.equal(next.events.at(-1).type, "vote.recorded");
          assert.equal(next.game.voteAssignments[1], 2);
          assert.deepEqual(next.game.nominations, before.game.nominations);
          assert.equal(await card(page, 1).locator(".card-support").count(), 0);
          const last = await changed(page, () => card(page, 1).click());
          assert.equal(last.events.at(-1).type, "vote.recorded");
          assert.equal(last.game.voteAssignments[1], undefined);
        });
      } else if (kind === "legacy") {
        await check("legacy edition real tap and F shortcut", async () => {
          await changed(page, () => card(page, 2).click());
          for (let n = 1; n <= 3; n++) {
            await changed(page, async () => {
              await card(page, 7).focus();
              await page.keyboard.press("f");
            });
            assert.equal(await card(page, 7).locator(".foul-dot").count(), n);
          }
          assert.equal(await card(page, 7).locator(".lucide-message-circle-off").count(), 1);
        });
        await check("legacy fourth foul follows existing removal", async () => {
          const next = await changed(page, async () => {
            await card(page, 7).focus();
            await page.keyboard.press("f");
          });
          assert.equal(next.game.players.find((p) => p.seat === 7).fouls, 4);
          assert.equal(next.game.players.find((p) => p.seat === 7).status, "red-carded");
          assert.equal(await card(page, 7).locator(".foul-dot").count(), 3);
        });
      } else if (kind === "fallback") {
        await check("allocation failure retains real nomination/support glyphs", async () => {
          await page.waitForFunction(
            () => document.querySelector(".app-shell").dataset.glassStatus === "unavailable",
          );
          await changed(page, () => card(page, 2).click());
          await changed(page, () =>
            page.getByRole("button", { name: "Next player", exact: true }).click(),
          );
          await changed(page, () => card(page, 2).click());
          await openControls(page);
          await setInput(page, "Nomination tint", 0);
          await page.getByLabel("Nomination treatment", { exact: true }).selectOption("tint");
          await page.getByRole("button", { name: "Close developer menu", exact: true }).click();
          assert.equal(await card(page, 2).locator(".card-nomination-symbol svg").count(), 1);
          assert.equal(await card(page, 2).locator(".card-support").innerText(), "+1");
          assert.equal(await card(page, 2).locator(".card-selection svg").count(), 1);
          assertMarkers(await markerGeometry(page));
        });
      } else {
        const baselineGeometry = await geometry(page);
        const cdp = config.name.startsWith("chrome")
          ? await page.context().newCDPSession(page)
          : null;
        await check("whole-card nomination and exact secret canonical payload", async () => {
          const next = await changed(page, () => card(page, 2).click());
          assert.equal(next.events.at(-1).type, "nomination.selection-set");
          assert.deepEqual(next.events.at(-1).payload, {
            nominatorSeat: 1,
            candidateSeat: 2,
            selected: true,
          });
          assert.equal(isSecretGameEventType(next.events.at(-1).type), true);
          assert.equal(await card(page, 2).getAttribute("aria-pressed"), "true");
          assert.equal(
            await card(page, 2).getByRole("img", { name: "Nominated", exact: true }).count(),
            1,
          );
          assert.equal(await card(page, 2).locator(".card-support").count(), 0);
        });
        await check("second new nominee ignored without accepted event", () =>
          unchanged(page, () => card(page, 3).click()),
        );
        await check("trusted downward mouse after rejected nomination", async () => {
          const next = await changed(page, () => mouseDrag(page, 4, 0, 60));
          assert.equal(next.events.at(-1).type, "foul.issued");
          assert.equal(next.game.players.find((p) => p.seat === 4).fouls, 1);
          assert.equal(await card(page, 4).locator(".foul-dot").count(), 1);
        });
        await check(
          "retap original removes relation, restores allowance, keeps intervening foul",
          async () => {
            const next = await changed(page, () => card(page, 2).click());
            assert.equal(next.game.nominations.length, 0);
            assert.equal(next.game.players.find((p) => p.seat === 4).fouls, 1);
            await changed(page, () => card(page, 2).click());
          },
        );
        await check("next speaker clears only mint check, keeps round nomination", async () => {
          await changed(page, () =>
            page.getByRole("button", { name: "Next player", exact: true }).click(),
          );
          assert.equal(await card(page, 2).locator(".card-selection").count(), 0);
          assert.equal(await card(page, 2).locator(".card-nomination-symbol").count(), 1);
        });
        await check("one original plus independent unique supports across speakers", async () => {
          await changed(page, () => card(page, 2).click());
          assert.equal(await card(page, 2).locator(".card-support").innerText(), "+1");
          await changed(page, () => card(page, 2).click());
          assert.equal(await card(page, 2).locator(".card-support").count(), 0);
          await changed(page, () => card(page, 2).click());
          await changed(page, () => card(page, 3).click());
          await unchanged(page, () => card(page, 4).click());
          await changed(page, () =>
            page.getByRole("button", { name: "Next player", exact: true }).click(),
          );
          for (const target of [2, 3, 4]) await changed(page, () => card(page, target).click());
          await changed(page, () =>
            page.getByRole("button", { name: "Next player", exact: true }).click(),
          );
          for (const target of [2, 3, 4, 5]) await changed(page, () => card(page, target).click());
          const now = await state(page);
          assert.equal(now.game.nominations.length, 4);
          for (const [seat, supporters] of [
            [2, [2, 3, 4]],
            [3, [3, 4]],
            [4, [4]],
          ]) {
            const relation = now.game.nominations.find((n) => n.candidateSeat === seat);
            assert.deepEqual(relation.supporterSeats, supporters);
            assert.equal(
              await card(page, seat).locator(".card-support").innerText(),
              `+${supporters.length}`,
            );
          }
          assert.deepEqual(now.game.voteAssignments, {});
        });
        await check("mouse down and keyboard F yield three dots and fixed mute", async () => {
          await changed(page, () => mouseDrag(page, 6, 0, 60));
          for (let n = 2; n <= 3; n++) {
            await changed(page, async () => {
              await card(page, 6).focus();
              await page.keyboard.press("f");
            });
            assert.equal(await card(page, 6).locator(".foul-dot").count(), n);
          }
          assert.equal(
            await card(page, 6).getByRole("img", { name: "Muted turn", exact: true }).count(),
            1,
          );
          assert.equal(await card(page, 6).locator(".lucide-message-circle-off").count(), 1);
          assert.equal(await card(page, 6).locator(".lucide-mic-off").count(), 0);
        });
        await check("short, diagonal and modified F cancel without selection", async () => {
          await unchanged(page, () => mouseDrag(page, 7, 0, 20));
          await unchanged(page, () => mouseDrag(page, 7, 50, 50));
          await unchanged(page, async () => {
            await card(page, 7).focus();
            await page.keyboard.press("Control+f");
          });
          await unchanged(page, async () => {
            const b = await card(page, 7).boundingBox();
            await page.mouse.move(b.x + 30, b.y + 15);
            await page.mouse.down();
            await card(page, 7).evaluate((el) =>
              el.dispatchEvent(
                new PointerEvent("pointercancel", {
                  bubbles: true,
                  pointerId: 1,
                  pointerType: "mouse",
                }),
              ),
            );
            await page.mouse.move(b.x + 30, b.y + 75);
            await page.mouse.up();
          });

          await changed(page, () => card(page, 3).click());
          await changed(page, () => card(page, 3).click());
        });
        if (cdp)
          await check("trusted Chrome pen downward gesture", async () => {
            const b = await card(page, 7).boundingBox();
            await changed(page, async () => {
              for (const [type, y, button, buttons] of [
                ["mousePressed", b.y + 10, "left", 1],
                ["mouseMoved", b.y + 70, "none", 1],
                ["mouseReleased", b.y + 70, "left", 0],
              ])
                await cdp.send("Input.dispatchMouseEvent", {
                  type,
                  x: b.x + b.width / 2,
                  y,
                  button,
                  buttons,
                  pointerType: "pen",
                  clickCount: 1,
                });
            });
            assert.equal((await state(page)).game.players.find((p) => p.seat === 7).fouls, 1);
          });
        await page.screenshot({ path: join(evidence, `${config.name}-compact-default.png`) });
        result.markerGeometry = await markerGeometry(page);
        await check("default marker/person/name spacing and unchanged table geometry", async () => {
          assertMarkers(result.markerGeometry);
          assert.deepEqual(await geometry(page), baselineGeometry);
        });
        await check(
          "fourth foul requests existing discipline; cancellation preserves state",
          async () => {
            await unchanged(page, async () => {
              await card(page, 6).focus();
              await page.keyboard.press("f");
              await page.getByRole("dialog").waitFor();
              assert.equal(
                await page
                  .getByRole("combobox", { name: "Discipline action", exact: true })
                  .inputValue(),
                "foul",
              );
              await page.getByRole("button", { name: "Close", exact: true }).click();
            });
          },
        );
        await check("upward penalty and sideways context retain their actions", async () => {
          await unchanged(page, async () => {
            await mouseDrag(page, 7, 0, -60);
            await page.getByRole("dialog").waitFor();
            await page.getByRole("button", { name: "Close", exact: true }).click();
            await mouseDrag(page, 7, 60, 0);
            await page.getByRole("dialog", { name: "Player actions", exact: true }).waitFor();
            await page.locator(".table-swipe-backdrop").click({ position: { x: 4, y: 4 } });
          });
        });

        const canonicalBeforeAppearance = await state(page);
        await check(
          "six live developer settings at zero tint preserve essential glyphs",
          async () => {
            await openControls(page);
            await setInput(page, "Nomination tint", 0);
            await page.getByLabel("Nomination treatment", { exact: true }).selectOption("tint");
            await page.getByRole("button", { name: "Blue nomination tint", exact: true }).click();
            await page.getByLabel("Nomination icon", { exact: true }).selectOption("flag");
            await page.getByLabel("Support icon", { exact: true }).selectOption("thumbs-up");
            await page.getByLabel("This speaker’s choice", { exact: true }).selectOption("check");
            assert.equal(await card(page, 2).locator(".lucide-flag").count(), 1);
            assert.equal(await card(page, 2).locator(".lucide-thumbs-up").count(), 1);
            assert.equal(await card(page, 2).locator(".card-selection").count(), 1);
            assert.equal(
              (await card(page, 2).getAttribute("class")).includes(
                "has-nomination-selection-outline",
              ),
              false,
            );
            assert.equal(await card(page, 2).locator(".card-support").innerText(), "+3");
            assert.deepEqual(await state(page), canonicalBeforeAppearance);
            await page.getByRole("button", { name: "Close developer menu", exact: true }).click();
            assertMarkers(await markerGeometry(page));
            await page.screenshot({ path: join(evidence, `${config.name}-zero-tint.png`) });
          },
        );
        await check(
          "shared glass, maximum tint and all presets preserve canonical events",
          async () => {
            await openControls(page);
            await setInput(page, "Nomination tint", 50);
            await page.getByLabel("Nomination treatment", { exact: true }).selectOption("icons");
            assert.equal(
              await page
                .locator(".app-shell")
                .evaluate((el) =>
                  getComputedStyle(el).getPropertyValue("--card-nomination-tint").trim(),
                ),
              "0",
            );
            assert.equal(await card(page, 2).locator(".lucide-flag").count(), 1);
            assert.equal(await card(page, 2).locator(".card-support").innerText(), "+3");
            await page.getByRole("button", { name: "Enable enhanced glass", exact: true }).click();
            await page.waitForFunction(
              () => document.querySelector(".app-shell").dataset.glassStatus === "ready",
            );
            await setInput(page, "Nomination tint", 50);
            await page.getByLabel("Nomination treatment", { exact: true }).selectOption("hybrid");
            for (const color of ["Amber", "Lilac", "Green", "Blue"])
              await page
                .getByRole("button", { name: `${color} nomination tint`, exact: true })
                .click();
            await setInput(page, "Nomination color", "#bda5ec");
            assert.equal(
              await card(page, 2).evaluate(
                (el) => getComputedStyle(el.querySelector(".card-nomination-status")).color,
              ),
              "rgb(189, 165, 236)",
            );
            await page.getByRole("button", { name: "Close developer menu", exact: true }).click();
            await settle(page);
            assert.deepEqual(await state(page), canonicalBeforeAppearance);
            assert.deepEqual(await geometry(page), baselineGeometry);
            assertMarkers(await markerGeometry(page));
            await page.screenshot({ path: join(evidence, `${config.name}-shared-max-tint.png`) });
          },
        );
        await check("reload retains appearance plus exact canonical relations/fouls", async () => {
          await page.reload();
          await card(page, 2).waitFor();
          await page.waitForFunction(
            () => document.querySelector(".app-shell").dataset.glassStatus === "ready",
          );
          assert.deepEqual(await state(page), canonicalBeforeAppearance);
          assert.equal(await card(page, 2).locator(".card-support").innerText(), "+3");
          assert.equal(await card(page, 2).locator(".lucide-flag").count(), 1);
          assert.equal(await card(page, 6).locator(".foul-dot").count(), 3);
          await openControls(page);
          for (const [label, value] of [
            ["Nomination tint", "50"],
            ["Nomination color", "#bda5ec"],
            ["Nomination treatment", "hybrid"],
            ["Nomination icon", "flag"],
            ["Support icon", "thumbs-up"],
            ["This speaker’s choice", "check"],
          ])
            assert.equal(await page.getByLabel(label, { exact: true }).inputValue(), value);
          await page.getByRole("button", { name: "Reset glass settings", exact: true }).click();
          assert.equal(
            await page.getByLabel("Nomination color", { exact: true }).inputValue(),
            "#e6bc7e",
          );
          assert.equal(
            await page.getByLabel("Nomination treatment", { exact: true }).inputValue(),
            "hybrid",
          );
          assert.equal(
            await page.getByLabel("Nomination tint", { exact: true }).inputValue(),
            "18",
          );
          assert.equal(
            await page.getByLabel("Nomination icon", { exact: true }).inputValue(),
            "vote",
          );
          assert.equal(await page.getByLabel("Support icon", { exact: true }).inputValue(), "hand");
          assert.equal(
            await page.getByLabel("This speaker’s choice", { exact: true }).inputValue(),
            "check-outline",
          );
          await page.getByRole("button", { name: "Close developer menu", exact: true }).click();
          assert.deepEqual(await state(page), canonicalBeforeAppearance);
        });
        await check(
          "mute consumption keeps three dots; unique support reaches +9 excluding original",
          async () => {
            for (let speaker = 5; speaker <= 10; speaker++) {
              await changed(page, () =>
                page.getByRole("button", { name: "Next player", exact: true }).click(),
              );
              if (speaker === 7) {
                assert.equal(await card(page, 6).locator(".card-mute").count(), 0);
                assert.equal(await card(page, 6).locator(".foul-dot").count(), 3);
              }
              await changed(page, () => card(page, 2).click());
            }
            const final = await state(page);
            assert.deepEqual(
              final.game.nominations.find((n) => n.candidateSeat === 2).supporterSeats,
              [2, 3, 4, 5, 6, 7, 8, 9, 10],
            );
            assert.equal(await card(page, 2).locator(".card-support").innerText(), "+9");
            assert.deepEqual(final.game.voteAssignments, {});
            assertMarkers(await markerGeometry(page));
            await page.screenshot({ path: join(evidence, `${config.name}-support-nine.png`) });
          },
        );
        await check(
          "Developer toggle keeps secret roles hidden and game bytes unchanged",
          async () => {
            await unchanged(page, async () => {
              await page.getByRole("button", { name: "Hide private info", exact: true }).click();
              assert.equal(await page.locator(".game-shell .role-badge").count(), 0);
              await openControls(page);
              await page.getByRole("button", { name: "Close developer menu", exact: true }).click();
              assert.equal(await page.locator(".game-shell .role-badge").count(), 0);
            });
          },
        );
        await cdp?.detach();
      }
      await check("no browser page errors", async () => assert.deepEqual(errors, []));
      result.status = "passed";
      delete result.activeCheck;
    } catch (error) {
      result.status = "failed";
      result.error = error.stack;
      await page
        .screenshot({ path: join(evidence, `${config.name}-${kind}-failure.png`) })
        .catch(() => {});
    } finally {
      result.errors = errors;
      result.blockedRequests = blockedRequests;
      result.consoleMessages = consoleMessages;
      result.inputTrace = await page.evaluate(() => window.cardInputTrace).catch(() => []);
      result.assertionGroups = checks.length;
      result.canonical = await state(page).catch(() => null);
      await writeFile(
        join(evidence, `${config.name}-${kind}.json`),
        JSON.stringify(result, null, 2),
      );
      await page.screenshot({ path: join(evidence, `${config.name}-${kind}.png`) }).catch(() => {});
      // Keep full canonical JSON in the per-case artifact, not console output.
      delete result.canonical;
      delete result.inputTrace;
      await page.close();
    }
  }
}
