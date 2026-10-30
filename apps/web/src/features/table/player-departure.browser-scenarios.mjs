/* global document, window, getComputedStyle, Element, Event, requestAnimationFrame, performance, setTimeout, DOMMatrix */
// Extra scenarios share the existing real GameScreen fixture, never a replacement renderer.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";

const cardSelector = (seat) => `.seat-anchor[data-seat="${seat}"] > .player-seat`;
const activeSelector = ".seat-anchor [data-player-exit]";
const close = (actual, expected, label, tolerance = 0.02) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} / ${expected}`);
const pause = async (page, milliseconds) => {
  const tracks = await page.evaluate((time) => {
    const animations = document
      .getAnimations()
      .filter((a) => /^(player-exit-|printed-card-exit-)/.test(a.id));
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = time;
    }
    return animations.map((a) => ({
      id: a.id,
      duration: a.effect.getTiming().duration,
      host: a.effect.target.matches(".player-seat"),
      target: a.effect.target.className,
      properties: Object.keys(a.effect.getKeyframes()[0]),
    }));
  }, milliseconds);
  assert.ok(tracks.length >= 4, "A real renderer must supply the departure tracks");
  assert.equal(
    new Set(tracks.map((track) => track.duration)).size,
    1,
    "All tracks share the captured complete cause clock",
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)),
      ),
  );
  // Deterministic pixel sampling waits for the bounded optical handoff while
  // keeping the requested native pose. Natural playback never uses this helper.
  await page.waitForFunction(
    () => !document.querySelector(".seat-anchor [data-glass-blending]"),
    undefined,
    { timeout: 1000 },
  );
  return tracks;
};
const finish = async (page) => {
  await page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => /^(player-exit-|printed-card-exit-)/.test(a.id))
      .forEach((a) => a.finish()),
  );
  await page.waitForFunction(
    () =>
      !document.querySelector(
        ".seat-anchor [data-player-exit],.player-exit-preview [data-player-exit]",
      ),
  );
  assert.equal(
    await page.evaluate(
      () =>
        document.getAnimations().filter((a) => /^(player-exit-|printed-card-exit-)/.test(a.id))
          .length,
    ),
    0,
    "No departure animation survives settlement",
  );
};
const property = (card, name) =>
  card.evaluate((host, key) => Number(getComputedStyle(host).getPropertyValue(key)), name);
const pose = (card, style) =>
  card.evaluate((host, printed) => {
    const moving = host;
    return {
      rotate: parseFloat(getComputedStyle(moving).rotate.split(" ").at(-1)) || 0,
      transform: getComputedStyle(moving).transform,
      front: getComputedStyle(
        host.querySelector(printed ? ".printed-player-card__outgoing" : ".player-exit-front"),
      ).visibility,
      back: getComputedStyle(
        host.querySelector(printed ? ".printed-player-card__incoming" : ".player-exit-back"),
      ).visibility,
    };
  }, style !== "glass");
const privacy = async (card) => {
  const state = await card.evaluate((host) => ({
    roles: host.querySelectorAll(".player-role-icon[role=img],.printed-player-card__role").length,
    labels: [...host.querySelectorAll("[aria-label],[title],img[alt]")]
      .map((node) =>
        [node.getAttribute("aria-label"), node.getAttribute("title"), node.getAttribute("alt")]
          .filter(Boolean)
          .join(" "),
      )
      .join(" "),
    text: host.textContent,
    artInPieces: host.querySelectorAll(
      ".player-torn-fragment .printed-player-card__art,.player-torn-fragment .player-role-icon,.player-torn-fragment .seat-name",
    ).length,
  }));
  assert.equal(state.roles, 0, "Masked DOM must not retain role graphics or role text");
  assert.doesNotMatch(
    state.labels + state.text,
    /Citizen|Sheriff|Don|Mafia|civilian/i,
    "No secret role in text or accessible metadata",
  );
  assert.equal(
    state.artInPieces,
    0,
    "Torn neutral pieces must not carry a person/role face or identity rail",
  );
};

async function setup(page, style) {
  await page.setViewportSize({ width: 1366, height: 1024 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const generation = await page.evaluate((selected) => {
    if (window.originalAnimate) {
      Element.prototype.animate = window.originalAnimate;
      delete window.originalAnimate;
    }
    delete document.hidden;
    document.body.dataset.departureScenarios = "true";
    const fixture = window.exitFixture;
    fixture.setBackground("grey-66");
    fixture.setLongNames(false);
    fixture.setStyle(selected);
    fixture.setFancy(true);
    fixture.setPrivacy(true);
    fixture.setProjected(true);
    fixture.setGlass(selected === "glass");
    fixture.setSettings((s) => ({
      ...s,
      enabled: true,
      liftMs: 700,
      landingMs: 1400,
      impactMs: 900,
      tearMs: 800,
      fadeMs: 900,
      disciplineMs: 1000,
      gap: 12,
      finalOpacity: 45,
      overlap: 100,
      flip: { easing: "out", strength: 100 },
    }));
    fixture.load("day");
    return fixture.generation + 1;
  }, style);
  await page.waitForFunction(
    ({ selected, generation }) =>
      window.exitFixture.generation === generation &&
      window.exitFixture.style === selected &&
      window.exitFixture.game.phase === "day",
    { selected: style, generation },
  );
  if (style === "glass")
    await page.waitForFunction(
      () => document.querySelector(".app-shell").dataset.glassStatus === "ready",
    );
}
async function loadSnapshot(page, kind) {
  const generation = await page.evaluate((kind) => {
    const fixture = window.exitFixture;
    fixture.load(kind);
    return fixture.generation + 1;
  }, kind);
  // A reset and a new action must be separate committed renders; otherwise the
  // provider correctly sees an already-departed snapshot at its fresh mount.
  await page.waitForFunction(
    (generation) => window.exitFixture.generation === generation,
    generation,
  );
}
async function correctSnapshot(page) {
  const generation = await page.evaluate(() => {
    const fixture = window.exitFixture;
    fixture.correction();
    return fixture.generation + 1;
  });
  // Correction replaces GameScreen. Wait for the replacement DOM, not a stale
  // detached host whose computed custom properties are empty in WebKit.
  await page.waitForFunction((generation) => {
    const cards = [...document.querySelectorAll(".seat-anchor > .player-seat")];
    return (
      window.exitFixture.generation === generation &&
      cards.length === 10 &&
      cards.every((card) => card.classList.contains("status-active"))
    );
  }, generation);
}
async function beginVote(page, animated = true) {
  await loadSnapshot(page, "goodbye");
  const victim = await page.evaluate(() => window.exitFixture.victim);
  assert.equal(
    await page.locator(activeSelector).count(),
    0,
    "Goodbye must retain intact, unmarked victims",
  );
  close(
    await property(page.locator(cardSelector(victim)), "--player-exit-fade"),
    1,
    "Awaiting goodbye has no departed-material fade",
  );
  assert.equal(
    await page
      .locator(
        `${cardSelector(victim)} [class*=player-bullet],${cardSelector(victim)} .player-torn-fragment`,
      )
      .count(),
    0,
  );
  await page.getByRole("button", { name: "Begin night", exact: true }).click();
  await page.locator(`${cardSelector(victim)}[data-departure-cause="vote"]`).waitFor();
  if (animated) await page.locator(`${cardSelector(victim)}[data-player-exit]`).waitFor();
  assert.equal(
    await page.locator(activeSelector).count(),
    animated ? 2 : 0,
    "Both publicly released victims join the same transition",
  );
  assert.equal(
    await page.locator(cardSelector(victim)).getAttribute("data-departure-cause"),
    "vote",
  );
  return victim;
}
async function beginMafia(page, animated = true) {
  await loadSnapshot(page, "night");
  const victim = await page.evaluate(() => window.exitFixture.victim);
  await page.evaluate(() => window.exitFixture.resolveShot());
  for (let count = 0; count < 6; count++) {
    assert.equal(
      await page
        .locator(
          `${cardSelector(victim)}[data-departure-cause],${cardSelector(victim)} .player-bullet-hole`,
        )
        .count(),
      0,
      "Private shooting/checks/pending goodbye cannot publish wounds",
    );
    close(
      await property(page.locator(cardSelector(victim)), "--player-exit-fade"),
      1,
      "Private/provisional/awaiting-goodbye shooting has no public endpoint fade",
    );
    assert.equal(await page.locator(activeSelector).count(), 0);
    const phase = await page.evaluate(() => window.exitFixture.game.phase);
    await page.evaluate(() => window.exitFixture.advance());
    if (phase === "goodbye-speech") break;
  }
  await page.locator(`${cardSelector(victim)}[data-departure-cause="mafia"]`).waitFor();
  if (animated) await page.locator(`${cardSelector(victim)}[data-player-exit]`).waitFor();
  assert.equal(
    await page.locator(cardSelector(victim)).getAttribute("data-departure-cause"),
    "mafia",
  );
  return victim;
}
async function beginDiscipline(page, animated = true) {
  await loadSnapshot(page, "day");
  const victim = await page.evaluate(() => window.exitFixture.victim);
  await page.evaluate(() => window.exitFixture.exclude());
  await page.locator(`${cardSelector(victim)}[data-departure-cause="discipline"]`).waitFor();
  if (animated) await page.locator(`${cardSelector(victim)}[data-player-exit]`).waitFor();
  assert.equal(
    await page.locator(cardSelector(victim)).getAttribute("data-departure-cause"),
    "discipline",
  );
  return victim;
}
async function beginUnknownPreview(page, style, animated = true) {
  const before = await page.evaluate(() =>
    JSON.stringify({ game: window.exitFixture.game, frames: window.exitFixture.frames }),
  );
  // Real developer controls own unknown previews, not an invented canonical event.
  await page.evaluate(() => delete document.body.dataset.departureScenarios);
  const controls = page.locator(".player-exit-controls");
  if ((await controls.getAttribute("open")) === null)
    await controls.locator(":scope > summary").click();
  await page.getByLabel("Preview card style", { exact: true }).selectOption(style);
  await page.getByLabel("Preview action", { exact: true }).selectOption("unknown");
  await page.getByRole("button", { name: "Preview exit", exact: true }).click();
  const card = page.locator('.player-exit-preview > .player-seat[data-departure-cause="unknown"]');
  await card.waitFor();
  if (animated)
    await page.locator(".player-exit-preview > .player-seat[data-player-exit]").waitFor();
  await card.scrollIntoViewIfNeeded();
  assert.equal(
    await page.evaluate(() =>
      JSON.stringify({ game: window.exitFixture.game, frames: window.exitFixture.frames }),
    ),
    before,
    "Unknown preview never invents a canonical transition",
  );
  return card;
}

// Observe the real native clock in a post-frame task, after shared Glass's RAF.
// This handle is fixture-local, not a production global. Never pause/seek/finish
// departure tracks here: independently correct sampled frames miss handoff bugs.
async function traceNaturalDeparture(page, start, duration) {
  const observer = await page.evaluateHandle((milliseconds) => {
    const rows = [];
    const began = performance.now();
    let firstActiveAt = null;
    const done = new Promise((resolve) => {
      const sample = () => {
        const now = performance.now();
        const hosts = [...document.querySelectorAll(".seat-anchor > .player-seat")];
        for (const host of hosts) {
          if (!host.hasAttribute("data-player-exit") && !host.dataset.departureCause) continue;
          if (firstActiveAt === null && host.hasAttribute("data-player-exit")) firstActiveAt = now;
          const printed = host.dataset.cardStyle !== "glass";
          const front = host.querySelector(
            printed ? ".printed-player-card__outgoing" : ".player-exit-front",
          );
          const back = host.querySelector(
            printed ? ".printed-player-card__incoming" : ".player-exit-back",
          );
          const inner = host.querySelector(".printed-player-card__motion");
          const material = host.querySelector(":scope > .liquid-card-glass");
          const style = getComputedStyle(host);
          const angle = (value) =>
            value === "none" ? 0 : Number.parseFloat(value.split(/\s+/).at(-1));
          const tracks = document.getAnimations().filter((animation) => {
            const target = animation.effect?.target;
            return (
              target &&
              (target === host || host.contains(target)) &&
              /^(player-exit-|printed-card-exit-)/.test(animation.id)
            );
          });
          const publicContent = (selector, root = host) =>
            [...root.querySelectorAll(selector)]
              .filter((node) => getComputedStyle(node).visibility === "visible")
              .map((node) => {
                let effectiveOpacity = 1;
                for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
                  effectiveOpacity *= Number(getComputedStyle(ancestor).opacity);
                  if (ancestor === host) break;
                }
                return {
                  text: node.textContent,
                  visible: node.checkVisibility({
                    opacityProperty: true,
                    visibilityProperty: true,
                  }),
                  opacity: Number(getComputedStyle(node).opacity),
                  effectiveOpacity,
                  rect: node.getBoundingClientRect().toJSON(),
                  upright:
                    root === host
                      ? null
                      : (() => {
                          for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
                            const css = getComputedStyle(ancestor);
                            const m = new DOMMatrix(
                              css.transform === "none" ? undefined : css.transform,
                            );
                            if (
                              m.m11 <= 0 ||
                              m.m22 <= 0 ||
                              Math.abs(m.m12) > 0.001 ||
                              Math.abs(m.m21) > 0.001 ||
                              !(css.rotate === "none" || /(?:^| )0deg$/.test(css.rotate)) ||
                              (css.scale !== "none" &&
                                !css.scale.split(" ").every((value) => Number(value) > 0))
                            )
                              return false;
                          }
                          return true;
                        })(),
                };
              });
          rows.push({
            time: now - began,
            elapsed: firstActiveAt === null ? null : now - firstActiveAt,
            seat: Number(host.parentElement.dataset.seat),
            cause: host.dataset.departureCause,
            request: host.dataset.playerExit ?? null,
            active: host.hasAttribute("data-player-exit"),
            angle: angle(style.rotate),
            materialFacing: material
              ? Math.cos((angle(style.rotate) * Math.PI) / 180) *
                (Number.parseFloat(getComputedStyle(material).scale) || 1)
              : null,
            innerAngle: inner ? angle(getComputedStyle(inner).rotate) : 0,
            front: front ? getComputedStyle(front).visibility : null,
            back: back ? getComputedStyle(back).visibility : null,
            frontIsReverse:
              printed && Boolean(front?.querySelector(".printed-player-card__back-art")),
            fade: Number(style.getPropertyValue("--player-exit-fade")),
            tear: Number(style.getPropertyValue("--player-exit-tear")),
            painted: host.dataset.glassPainted === "true",
            blending: host.dataset.glassBlending === "true",
            localWeight: Number(style.getPropertyValue("--glass-local-weight")),
            localVisibility: host.querySelector(".liquid-card-glass")
              ? getComputedStyle(host.querySelector(".liquid-card-glass")).visibility
              : null,
            localOpacity: host.querySelector(".liquid-card-glass__backdrop")
              ? Number(getComputedStyle(host.querySelector(".liquid-card-glass__backdrop")).opacity)
              : null,
            tracks: tracks.map((animation) => ({
              id: animation.id,
              target: animation.effect.target.className,
              start: animation.startTime,
              time: animation.currentTime,
              state: animation.playState,
              pending: animation.pending,
            })),
            rect: host.getBoundingClientRect().toJSON(),
            neighbors: Object.fromEntries(
              hosts
                .filter(
                  (neighbor) =>
                    !neighbor.hasAttribute("data-player-exit") && !neighbor.dataset.departureCause,
                )
                .map((neighbor) => [
                  neighbor.parentElement.dataset.seat,
                  {
                    host: neighbor.getBoundingClientRect().toJSON(),
                    anchor: neighbor.parentElement.getBoundingClientRect().toJSON(),
                    emphasized:
                      neighbor.classList.contains("is-current") ||
                      neighbor.classList.contains("is-goodbye-highlight"),
                  },
                ]),
            ),
            cardNames: host.querySelectorAll(
              ".seat-name,.printed-player-card__name,.printed-player-card__caption",
            ).length,
            identity: publicContent(":scope > .player-seat-caption", host.parentElement),
            status: publicContent(".card-discipline-status,.card-nomination-status,.seat-badges"),
            roles: host.querySelectorAll(".player-role-icon[role=img],.printed-player-card__role")
              .length,
          });
        }
        if (
          (firstActiveAt !== null && now - firstActiveAt >= milliseconds) ||
          now - began >= milliseconds + 5000
        ) {
          resolve(rows);
        } else requestAnimationFrame(() => setTimeout(sample, 0));
      };
      requestAnimationFrame(() => setTimeout(sample, 0));
    });
    return { done };
  }, duration);
  try {
    const seat = await start();
    const rows = await observer.evaluate(async (state) => await state.done);
    return { seat, duration, rows: rows.filter((row) => row.seat === seat) };
  } finally {
    await observer.dispose();
  }
}

async function assertNaturalContinuity(page, style, cause, recording, prefix, clock) {
  const failures = new Map();
  const check = (label, action) => {
    try {
      action();
    } catch (error) {
      if (!failures.has(label)) failures.set(label, error.message);
    }
  };
  const first = recording.rows.findIndex((row) => row.active);
  check("activation", () => assert.ok(first >= 0, "The recorder saw the actual departure request"));
  const rows = first >= 0 ? recording.rows.slice(first) : [];
  const active = rows.filter((row) => row.active);
  // Near-180deg serialization is not a completed turn: 179.994deg can still
  // be nonplanar and correctly excluded by Glass. Use this request's captured
  // native clock and production timeline, not an arbitrary angular deadband.
  const turnFinished = (row) =>
    row.tracks.length > 0 &&
    row.tracks.every((track) => typeof track.time === "number" && track.time >= clock.tearStart);
  let resolvedClockSeen = false;
  check("front-side", () =>
    assert.ok(
      active.some((row) => row.angle < 80),
      "Front-side host motion was recorded",
    ),
  );
  check("reverse-side", () =>
    assert.ok(
      active.some((row) => row.angle > 100),
      "Reverse-side host motion was recorded; the semantic host must own the turn",
    ),
  );
  for (const row of active) {
    check("faces", () =>
      assert.notEqual(
        row.front === "visible",
        row.back === "visible",
        "Exactly one logical face paints",
      ),
    );
    check("tracks", () =>
      assert.ok(row.tracks.length > 0, "The active request has real native tracks"),
    );
    const starts = row.tracks
      .map((track) => track.start)
      .filter((value) => typeof value === "number");
    // Native play() has a pending-start interval. Keep those raw rows and every
    // visual check, but compare actual resolved origins, never an empty set
    // (-Infinity) or manufactured currentTime equality.
    if (!row.tracks.some((track) => track.pending)) {
      check("resolved-clock", () =>
        assert.equal(
          starts.length,
          row.tracks.length,
          "Every nonpending native start time is resolved",
        ),
      );
      if (starts.length > 0)
        check("shared-clock", () =>
          close(Math.max(...starts) - Math.min(...starts), 0, "One request clock", 0.1),
        );
      resolvedClockSeen ||= starts.length === row.tracks.length && starts.length > 0;
    } else if (resolvedClockSeen) {
      check("clock-restart", () =>
        assert.fail("Native tracks must not reenter pending-start after the clock resolves"),
      );
    }
    check("no-inner-turn", () =>
      close(row.innerAngle, 0, "No independent paper turn inside the semantic host", 0.1),
    );
    if (style === "glass" && row.angle > 1 && row.angle < 179)
      check("nonplanar-material", () =>
        assert.equal(row.painted, false, "No axis-aligned shared lens during a 3D turn"),
      );
    if (style === "glass" && row.angle > 1 && row.angle < 179)
      check("attached-local-material", () =>
        assert.equal(row.localVisibility, "visible", "The moving local Glass material paints"),
      );
    if (
      style === "glass" &&
      row.localVisibility === "visible" &&
      Math.abs(row.materialFacing) > 0.2
    )
      check("reflection-orientation", () =>
        assert.ok(
          row.materialFacing > 0,
          "Directional Glass reflections retain their resting orientation on both visible faces",
        ),
      );
    if (style === "glass" && turnFinished(row)) {
      check("planar-pose", () =>
        close(row.angle, 180, "The completed native turn is physically planar", 0.001),
      );
      check("planar-material", () =>
        assert.equal(
          row.painted,
          true,
          "Planar reverse reacquires enhanced Glass in the sampled frame",
        ),
      );
    }
  }
  check("completed-turn-observed", () =>
    assert.ok(
      active.some(turnFinished),
      "The recorder saw the completed native turn before settlement",
    ),
  );
  check("resolved-clock-observed", () =>
    assert.ok(resolvedClockSeen, "The recorder saw the resolved native clock"),
  );
  if (style === "glass") {
    const blending = active.filter((row) => row.blending);
    check("optical-handoff", () =>
      assert.ok(
        blending.some((row) => row.localWeight > 0 && row.localWeight < 1),
        "Planar reacquisition has real intermediate optical weights, not a binary material switch",
      ),
    );
    for (const [index, row] of blending.entries()) {
      check("optical-handoff-material", () => {
        assert.equal(row.painted, true, "Shared optics participate during the planar handoff");
        assert.equal(row.localVisibility, "visible", "Complementary local optics remain visible");
        close(
          row.localOpacity,
          row.fade * row.localWeight,
          "Local optical weight applies once",
          0.01,
        );
        if (index > 0)
          assert.ok(
            row.localWeight <= blending[index - 1].localWeight,
            "Optical weights progress monotonically",
          );
      });
    }
  }
  const settled = rows.findIndex((row) => !row.active);
  check("settlement", () => assert.ok(settled >= 0, "The request settles on its natural clock"));
  for (const row of settled >= 0 ? rows.slice(settled) : []) {
    check("no-replay", () => assert.equal(row.active, false, "No replay after settlement"));
    check("endpoint-fade", () => close(row.fade, 0.45, "No endpoint opacity flash", 0.01));
    check("settled-optics", () =>
      assert.equal(row.blending, false, "No optical handoff survives settlement"),
    );
    check("settled-tracks", () =>
      assert.equal(row.tracks.length, 0, "No departure tracks remain after settlement"),
    );
    if (style === "glass")
      check("settled-material", () =>
        assert.equal(row.painted, true, "Settled Glass retains shared paint"),
      );
  }
  const fading = active.filter((row) => row.fade < 0.99);
  check("intermediate-fade", () =>
    assert.ok(fading.length > 1, "Real intermediate fade frames were recorded"),
  );
  for (let index = 1; index < fading.length; index += 1)
    check("monotone-fade", () =>
      assert.ok(fading[index].fade <= fading[index - 1].fade + 0.002, "Fade does not reverse"),
    );
  for (const row of rows) {
    check("privacy", () =>
      assert.equal(row.roles, 0, "No secret role artwork or label survives natural playback"),
    );
    check("public-identity", () => {
      assert.equal(row.cardNames, 0, "No names inside either face or fragment artwork");
      assert.equal(
        row.identity.length,
        1,
        "Exactly one external caption throughout departure playback",
      );
      for (const node of row.identity) {
        assert.ok(
          node.text.includes(`Player ${recording.seat}`),
          "Public caption retains identity",
        );
        assert.ok(
          node.visible && node.rect.width > 0 && node.rect.height > 0,
          "Caption is actually painted during natural playback",
        );
        assert.equal(node.upright, true, "The caption never mirrors or follows the physical turn");
        close(node.opacity, 1, "The caption remains unfaded", 0.01);
        close(node.effectiveOpacity, 1, "No actual caption ancestor fades it", 0.01);
        // Speaker/goodbye emphasis can legitimately change the caption's overhang.
        // It must remain readable and upright, not inherit the physical card turn.
      }
    });
    check("public-status", () => {
      assert.ok(row.status.length > 0, "Public status remains visible on either face");
      for (const node of row.status)
        close(node.effectiveOpacity, 1, "Public status remains unfaded", 0.01);
    });
    if (active[0])
      for (const [seat, neighbor] of Object.entries(active[0].neighbors))
        for (const key of ["x", "y", "width", "height"]) {
          const current = row.neighbors[seat];
          check(`neighbor-anchor-${seat}-${key}`, () =>
            close(
              current?.anchor[key],
              neighbor.anchor[key],
              `Nondeparted seat anchor ${seat} ${key}`,
              0.7,
            ),
          );
          // Morning promotes the next speaker with an authored host-scale
          // transition. Its orbit stays fixed; unaffected neighbors also
          // promise identical host rectangles throughout playback.
          if (!neighbor.emphasized && !current?.emphasized)
            check(`neighbor-host-${seat}-${key}`, () =>
              close(
                current?.host[key],
                neighbor.host[key],
                `Unaffected neighbor ${seat} ${key}`,
                0.7,
              ),
            );
        }
  }
  const remaining = await page.locator(activeSelector).count();
  check("no-active-requests", () => assert.equal(remaining, 0));
  const mark =
    cause === "vote"
      ? ".player-torn-fragment"
      : cause === "mafia"
        ? ".player-bullet-hole"
        : ".player-disciplinary-ribbon";
  const marks = await page.locator(`${cardSelector(recording.seat)} ${mark}`).count();
  check("permanent-marks", () =>
    assert.equal(marks, cause === "vote" ? 2 : cause === "mafia" ? 3 : 1),
  );
  // Preserve the existing full text/accessible-metadata privacy oracle too.
  try {
    await privacy(page.locator(cardSelector(recording.seat)));
  } catch (error) {
    failures.set("settled-privacy", error.message);
  }
  const checks = {
    samples: rows.length,
    activeSamples: active.length,
    settledSamples: settled >= 0 ? rows.length - settled : 0,
    failures: Object.fromEntries(failures),
  };
  await writeFile(`${prefix}-continuity.json`, JSON.stringify(checks, null, 2));
  assert.deepEqual(checks.failures, {}, `${cause}: natural playback continuity`);
}

const timeline = (page, cause) =>
  page.evaluate((value) => window.exitFixture.timeline(value), cause);

// Check the actual paint owner AND every public ancestor: a correct custom
// property alone misses host dimming, an opaque backing and squared fragment alpha.
async function materialOpacity(card, style, expected, path) {
  const state = await card.evaluate((host) => {
    const describe = (node) => ({
      target: node.className,
      opacity: Number(getComputedStyle(node).opacity),
      visibility: getComputedStyle(node).visibility,
      visible: node.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
      fade: getComputedStyle(node).getPropertyValue("--player-exit-fade"),
      transition: getComputedStyle(node).transition,
      text: node.textContent,
      effectiveOpacity: (() => {
        let opacity = 1;
        for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
          opacity *= Number(getComputedStyle(ancestor).opacity);
          if (ancestor === host) break;
        }
        return opacity;
      })(),
    });
    const visible = (node) => getComputedStyle(node).visibility === "visible";
    const reverse = host.querySelector(".player-exit-back");
    return {
      cause: host.dataset.departureCause ?? null,
      faceDown: host.querySelector(".printed-player-card")?.dataset.down === "true",
      reverseVisible: reverse !== null && visible(reverse),
      host: describe(host),
      fade: Number(getComputedStyle(host).getPropertyValue("--player-exit-fade")),
      painted: host.dataset.glassPainted === "true",
      opacityTransitions: host
        .getAnimations({ subtree: true })
        .filter((animation) => animation.transitionProperty === "opacity")
        .map((animation) => ({
          target: animation.effect.target.className,
          time: animation.currentTime,
          state: animation.playState,
        })),
      material: [
        ...host.querySelectorAll(
          ".printed-player-card__current.printed-player-card__surface,.liquid-card-glass__backdrop",
        ),
      ].map(describe),
      fragments: [...host.querySelectorAll(".player-torn-fragment")].map(describe),
      paper: [
        ...host.querySelectorAll(".player-torn-fragment > .printed-player-card__surface"),
      ].map(describe),
      glassParents: [...host.querySelectorAll(":scope > .liquid-card-glass")].map(describe),
      cardNames: host.querySelectorAll(
        ".seat-name,.printed-player-card__name,.printed-player-card__caption",
      ).length,
      identity: [...host.parentElement.querySelectorAll(":scope > .player-seat-caption")]
        .filter(visible)
        .map(describe),
      status: [
        ...host.querySelectorAll(".card-discipline-status,.card-nomination-status,.seat-badges"),
      ]
        .filter(visible)
        .map(describe),
    };
  });
  if (path) await writeFile(`${path}-opacity.json`, JSON.stringify(state, null, 2));
  close(state.fade, expected, "Resolved material fade", 0.01);
  close(state.host.opacity, 1, "The semantic host never fades public content", 0.01);
  assert.equal(state.host.visibility, "visible", "The departed host is actually visible");
  assert.equal(state.cardNames, 0, "No names inside either card face or fragments");
  assert.equal(state.identity.length, 1, "One public external caption for every departure cause");
  assert.ok(state.status.length > 0, "The real public status rails survive the departure");
  for (const node of [...state.identity, ...state.status])
    close(node.effectiveOpacity, 1, `Unfaded public content: ${node.target}`, 0.01);
  assert.ok(
    state.identity.every((node) => node.visible),
    "The external caption is actually visible",
  );
  assert.equal(state.material.length, state.cause === "vote" && style !== "glass" ? 0 : 1);
  for (const node of state.material)
    close(node.opacity, expected, `Painted material: ${node.target}`, 0.01);
  if (style !== "glass")
    for (const node of [...state.material, ...state.fragments, ...state.paper])
      assert.equal(node.visibility, "visible", "Printed material is visible, not merely mounted");
  if (style === "glass") {
    assert.equal(state.glassParents.length, 1);
    close(state.glassParents[0].opacity, 1, "Glass optics have no extra parent fade", 0.01);
  }
  if (state.cause === "vote") {
    assert.equal(state.fragments.length, 2, "Both fragments independently own their fade");
    for (const node of state.fragments) {
      close(node.opacity, expected, "Fragment fade applied once", 0.01);
      close(node.effectiveOpacity, expected, "No second fade above either fragment", 0.01);
    }
    if (style !== "glass") {
      assert.equal(state.paper.length, 2);
      for (const node of state.paper) {
        close(node.opacity, 1, "Inner paper must not multiply the fragment fade", 0.01);
        close(node.effectiveOpacity, expected, "Effective paper alpha is not squared", 0.01);
      }
    }
  } else if (style !== "glass") {
    close(
      state.material[0].effectiveOpacity,
      expected,
      "Printed material fades exactly once",
      0.01,
    );
  }
  return state;
}

// Deterministic lane only. The subject uses its real native keyframes (and its
// real expiry guard); scenery stays at ONE sampled time across all three frames.
// Never use this helper in the separate natural-clock continuity cases.
async function intactFadePixels(page, card, style, clock, path, enhanced = style === "glass") {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(async () => {
    // Let finite non-subject UI feedback settle before freezing the scenery.
    // WebKit can otherwise cancel a paused Next-player button transition during
    // screenshot layout, even though the actual card pose remains unchanged.
    const feedback = document
      .getAnimations()
      .filter(
        (animation) =>
          animation.playState === "running" &&
          !/^(player-exit-|printed-card-exit-)/.test(animation.id) &&
          Number.isFinite(animation.effect?.getComputedTiming().endTime),
      );
    await Promise.all(feedback.map((animation) => animation.finished.catch(() => {})));
  });
  const scenery = await page.evaluateHandle(async () => {
    const animations = document
      .getAnimations()
      .filter(
        (animation) =>
          animation.playState === "running" &&
          !/^(player-exit-|printed-card-exit-)/.test(animation.id),
      );
    animations.forEach((animation) => animation.pause());
    await Promise.all(animations.map((animation) => animation.ready));
    return animations;
  });
  const sceneAnimations = await scenery.evaluate((animations) =>
    animations.map((animation) => ({
      id: animation.id,
      property: animation.transitionProperty,
      time: animation.currentTime,
      target: animation.effect?.target?.className,
      tag: animation.effect?.target?.tagName,
      markup: animation.effect?.target?.outerHTML?.slice(0, 250),
      rect: animation.effect?.target?.getBoundingClientRect?.().toJSON(),
    })),
  );
  await writeFile(`${path}-scenery.json`, JSON.stringify(sceneAnimations, null, 2));
  const controlProperty = style === "glass" ? "opacity" : "visibility";
  const request = await card.getAttribute("data-player-exit");
  const previousControl = await card.evaluate(
    (host, property) => ({
      value: host.style.getPropertyValue(property),
      priority: host.style.getPropertyPriority(property),
    }),
    controlProperty,
  );
  try {
    const sampleAt = async (time) => {
      const change = () => pause(page, time);
      if (enhanced) await redrawAfter(page, change);
      else await change();
      if (style === "glass")
        assert.equal(
          (await card.getAttribute("data-glass-painted")) === "true",
          enhanced,
          "Intact fade pixels use the requested real shared/fallback renderer",
        );
      close((await pose(card, style)).rotate, 180, "Fade samples retain the physical reverse");
    };
    await sampleAt(clock.fadeStart);
    const startState = await materialOpacity(card, style, 1, `${path}-fade-start`);
    const box = await card.boundingBox();
    assert.ok(box && box.width > 40 && box.height > 60, "Intact material has real viewport bounds");
    const clip = {
      x: Math.floor(box.x),
      y: Math.floor(box.y),
      width: Math.ceil(box.x + box.width) - Math.floor(box.x),
      height: Math.ceil(box.y + box.height) - Math.floor(box.y),
    };
    const obstructions = await card.evaluate((host) =>
      [
        ...host.querySelectorAll(
          ".seat-name,.printed-player-card__caption,.card-index,.card-discipline-status,.card-nomination-status,.seat-badges,.player-bullet-hole,.player-disciplinary-card,.player-disciplinary-ribbon,.player-exit-neutral-pattern",
        ),
      ]
        .filter(
          (node) =>
            getComputedStyle(node).visibility === "visible" &&
            Number(getComputedStyle(node).opacity) > 0,
        )
        .map((node) => ({ target: node.className, rect: node.getBoundingClientRect().toJSON() })),
    );
    // Choose by rendered geometry, not a shared percentage that can land on
    // Glass's mid-card name/status rail. Keep the original substantial area.
    const candidates = [0.43, 0.62, 0.18].flatMap((y) =>
      [0.14, 0.77].map((x) => ({
        x: box.x + box.width * x,
        y: box.y + box.height * y,
        width: box.width * 0.09,
        height: box.height * 0.13,
      })),
    );
    const patch = candidates.find((candidate) =>
      obstructions.every(
        ({ rect }) =>
          rect.width === 0 ||
          rect.height === 0 ||
          rect.x >= candidate.x + candidate.width + 2 ||
          rect.x + rect.width <= candidate.x - 2 ||
          rect.y >= candidate.y + candidate.height + 2 ||
          rect.y + rect.height <= candidate.y - 2,
      ),
    );
    assert.ok(patch, "A real text/marks-free material patch must exist");
    assert.deepEqual(
      obstructions.filter(
        ({ rect }) =>
          rect.width > 0 &&
          rect.height > 0 &&
          rect.x < patch.x + patch.width &&
          rect.x + rect.width > patch.x &&
          rect.y < patch.y + patch.height &&
          rect.y + rect.height > patch.y,
      ),
      [],
      "Fade contrast patch contains material, not text or cause marks",
    );
    const capture = async (suffix) => {
      const frame = PNG.sync.read(
        await page.screenshot({ path: `${path}-${suffix}-viewport.png` }),
      );
      assert.equal(
        await card.getAttribute("data-player-exit"),
        request,
        "The sampled request survives the real expiry guard across captures",
      );
      sameGeometry(
        { subject: box },
        { subject: await card.boundingBox() },
        "One physical fade pose",
      );
      const times = await scenery.evaluate((animations) =>
        animations.map((animation) => animation.currentTime),
      );
      times.forEach((time, index) =>
        close(
          time,
          sceneAnimations[index].time,
          `Frozen scenery clock ${JSON.stringify(sceneAnimations[index])}`,
          0.1,
        ),
      );
      assert.ok(
        clip.x >= 0 &&
          clip.y >= 0 &&
          clip.x + clip.width <= frame.width &&
          clip.y + clip.height <= frame.height,
        "Unchanged viewport contains the full material crop",
      );
      const crop = new PNG({ width: clip.width, height: clip.height });
      PNG.bitblt(frame, crop, clip.x, clip.y, clip.width, clip.height, 0, 0);
      await writeFile(`${path}-${suffix}.png`, PNG.sync.write(crop));
      return frame;
    };
    const start = await capture("fade-start");
    // Avoid finish() here: retain native end-of-fade material for the paired
    // comparison, then let the caller verify the committed static endpoint.
    await sampleAt(clock.duration - 1);
    const endState = await materialOpacity(card, style, 0.45, `${path}-fade-end`);
    const end = await capture("fade-end");
    const hide = async () => {
      await card.evaluate(
        (host, property) =>
          host.style.setProperty(property, property === "opacity" ? "0" : "hidden", "important"),
        controlProperty,
      );
      if (controlProperty === "visibility")
        await card.evaluate((host) => host.setAttribute("data-pixel-hidden", "true"));
      await page.waitForFunction(
        ({ host, property }) =>
          getComputedStyle(host)[property] === (property === "opacity" ? "0" : "hidden") &&
          (property === "opacity" ||
            [...host.querySelectorAll("*")].every(
              (node) => getComputedStyle(node).visibility === "hidden",
            )),
        { host: await card.elementHandle(), property: controlProperty },
        { timeout: 5000 },
      );
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
    };
    if (enhanced) await redrawAfter(page, hide);
    else await hide();
    const empty = await capture("hidden-host");
    assert.deepEqual(
      [start.width, start.height, end.width, end.height],
      [empty.width, empty.height, empty.width, empty.height],
    );
    const contrast = (frame) => {
      let sum = 0,
        max = 0,
        painted = 0,
        pixels = 0;
      for (let y = Math.ceil(patch.y); y + 0.5 < patch.y + patch.height; y++)
        for (let x = Math.ceil(patch.x); x + 0.5 < patch.x + patch.width; x++) {
          const index = (y * frame.width + x) * 4;
          const channels = [0, 1, 2].map((channel) =>
            Math.abs(frame.data[index + channel] - empty.data[index + channel]),
          );
          const delta = Math.max(...channels);
          max = Math.max(max, delta);
          sum += channels.reduce((total, value) => total + value, 0) / 3;
          if (delta > 2) painted++;
          pixels++;
        }
      return { mean: sum / pixels, max, painted, pixels };
    };
    const result = {
      box,
      clip,
      patch,
      obstructions,
      sceneAnimations,
      startState,
      endState,
      enhanced,
      start: contrast(start),
      end: contrast(end),
    };
    await writeFile(`${path}-fade-pixels.json`, JSON.stringify(result, null, 2));
    for (const [phase, measurement] of [
      ["start", result.start],
      ["end", result.end],
    ])
      assert.ok(
        measurement.pixels > 15 && measurement.max > 3 && measurement.painted > 5,
        `${phase}: the intact material must positively paint against the empty-host control: ${JSON.stringify(result)}`,
      );
    assert.ok(
      result.end.mean < result.start.mean,
      `Actual end material contrast must be lower than start: ${JSON.stringify(result)}`,
    );
    return result;
  } finally {
    const restore = async () => {
      await card.evaluate(
        (host, { property, previous }) => {
          host.removeAttribute("data-pixel-hidden");
          if (previous.value) host.style.setProperty(property, previous.value, previous.priority);
          else host.style.removeProperty(property);
        },
        { property: controlProperty, previous: previousControl },
      );
      await page.waitForFunction(
        ({ host, property }) =>
          getComputedStyle(host)[property] === (property === "opacity" ? "1" : "visible"),
        { host: await card.elementHandle(), property: controlProperty },
      );
    };
    try {
      if (enhanced) await redrawAfter(page, restore);
      else await restore();
    } finally {
      await scenery.evaluate((animations) => animations.forEach((animation) => animation.play()));
      await scenery.dispose();
    }
  }
}

const geometry = async (page, excluding) => {
  const result = {};
  for (const seat of await page
    .locator(".seat-anchor")
    .evaluateAll((nodes) => nodes.map((node) => Number(node.dataset.seat)))) {
    if (!excluding.includes(seat))
      result[seat] = await page.locator(cardSelector(seat)).boundingBox();
  }
  return result;
};
function sameGeometry(before, after, label) {
  assert.deepEqual(Object.keys(after), Object.keys(before));
  for (const seat of Object.keys(before))
    for (const key of ["x", "y", "width", "height"])
      close(after[seat][key], before[seat][key], `${label} seat ${seat} ${key}`, 0.7);
}
async function redrawAfter(page, change) {
  const before = await page.locator(".glass-scene-canvas").getAttribute("data-glass-draws");
  await change();
  await page.waitForFunction(
    (previous) =>
      Number(document.querySelector(".glass-scene-canvas").dataset.glassDraws) > Number(previous),
    before,
    { timeout: 5000 },
  );
  return Number(await page.locator(".glass-scene-canvas").getAttribute("data-glass-draws"));
}

// Compare exactly the same scene clip with the ENTIRE host hidden. In shared Glass
// hiding the DOM child alone is a false positive: its material lives on the shared GPU canvas.
async function tornPixels(page, card, style, path) {
  await page.evaluate(() => document.fonts.ready);
  // These are two exposures of ONE sampled frame. In particular, the table's
  // day→night border/shadow transition must not advance between the painted
  // card and hidden-host control. Pause (do not disable or finish) other live
  // tracks at their current times, record them, and resume after the pair.
  const scenery = await page.evaluateHandle(async () => {
    const animations = document
      .getAnimations()
      .filter(
        (animation) =>
          animation.playState === "running" &&
          !/^(player-exit-|printed-card-exit-)/.test(animation.id),
      );
    animations.forEach((animation) => animation.pause());
    await Promise.all(animations.map((animation) => animation.ready));
    return animations;
  });
  const sceneAnimations = await scenery.evaluate((animations) =>
    animations.map((animation) => ({
      id: animation.id,
      property: animation.transitionProperty,
      name: animation.animationName,
      time: animation.currentTime,
      target: animation.effect?.target?.className,
    })),
  );
  const box = await card.boundingBox();
  const request = await card.getAttribute("data-player-exit");
  assert.ok(
    box.width > 40 && box.height > 60,
    `Real responsive card bounds: ${JSON.stringify(box)}`,
  );
  const clip = {
    x: Math.floor(box.x) - 6,
    y: Math.floor(box.y) - 6,
    width: Math.ceil(box.x + box.width) - Math.floor(box.x) + 12,
    height: Math.ceil(box.y + box.height) - Math.floor(box.y) + 12,
  };
  const capture = async (suffix) => {
    // Retain the full frame as well as the crop so an external pixel difference
    // can be attributed to actual scene objects, not guessed from a narrow strip.
    const frame = PNG.sync.read(await page.screenshot({ path: `${path}-${suffix}-viewport.png` }));
    assert.equal(
      await card.getAttribute("data-player-exit"),
      request,
      "The sampled request survives the real expiry guard across captures",
    );
    sameGeometry({ subject: box }, { subject: await card.boundingBox() }, "One physical tear pose");
    const times = await scenery.evaluate((animations) =>
      animations.map((animation) => animation.currentTime),
    );
    times.forEach((time, index) =>
      close(time, sceneAnimations[index].time, "Frozen scenery clock", 0.1),
    );
    assert.ok(
      clip.x >= 0 &&
        clip.y >= 0 &&
        clip.x + clip.width <= frame.width &&
        clip.y + clip.height <= frame.height,
      "Pixel crop fits the unchanged viewport",
    );
    const crop = new PNG({ width: clip.width, height: clip.height });
    PNG.bitblt(frame, crop, clip.x, clip.y, clip.width, clip.height, 0, 0);
    const bytes = PNG.sync.write(crop);
    await writeFile(`${path}-${suffix}.png`, bytes);
    return bytes;
  };
  const seam = await page.evaluate(() => window.exitFixture.seam);
  const fragments = await card.locator(".player-torn-fragment").evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }),
  );
  assert.equal(fragments.length, 2, "Pixel oracle uses both real transformed fragment rectangles");
  for (const fragment of fragments) {
    assert.ok(
      fragment.x >= box.x - 0.1 && fragment.x + fragment.width <= box.x + box.width + 0.1,
      "Both pieces stay within the original horizontal footprint",
    );
    assert.ok(
      fragment.y >= box.y - 0.1 && fragment.y + fragment.height <= box.y + box.height + 0.1,
      "Both pieces stay within the original vertical footprint",
    );
  }
  let draws;
  if (style === "glass") {
    const selector = await card.evaluate(
      (host) => `.seat-anchor[data-seat="${host.parentElement.dataset.seat}"] > .player-seat`,
    );
    await page.waitForFunction(
      (target) => document.querySelector(target).dataset.glassPainted === "true",
      selector,
    );
    // A freshly restored provider can become ready before its status classes
    // and fallback suppression have reached the compositor. Bind BOTH halves
    // of the pixel comparison to newer shared draws, not just the empty half.
    await redrawAfter(page, () =>
      card.evaluate((host) => host.style.setProperty("visibility", "hidden", "important")),
    );
    await redrawAfter(page, () => card.evaluate((host) => host.style.removeProperty("visibility")));
    draws = Number(await page.locator(".glass-scene-canvas").getAttribute("data-glass-draws"));
  }
  if (style.startsWith("glass")) {
    await capture("foreground");
    // Public identity deliberately stays outside/floats across fragments. Keep
    // its normal screenshot, then isolate MATERIAL for the exact backing oracle.
    await page.addStyleTag({
      content:
        "[data-pixel-isolate] :is(.seat-name,.card-index,.card-nomination-status,.card-discipline-status,.seat-badges,.player-exit-neutral-pattern){visibility:hidden!important}",
    });
    await card.evaluate((host) => host.setAttribute("data-pixel-isolate", "true"));
  }
  const painted = await capture("painted");
  // Preserve the renderer's compositing topology for the empty-host control:
  // Glass keeps its active 3D host but zeroes its collected GPU/DOM alpha;
  // settled printed paper needs only visibility, not a new opacity layer.
  const controlProperty = style.startsWith("glass") ? "opacity" : "visibility";
  const previousControl = await card.evaluate(
    (host, property) => ({
      value: host.style.getPropertyValue(property),
      priority: host.style.getPropertyPriority(property),
    }),
    controlProperty,
  );
  const controlValue = controlProperty === "opacity" ? "0" : "hidden";
  const hide = async () => {
    await card.evaluate(
      (host, { property, value }) => host.style.setProperty(property, value, "important"),
      { property: controlProperty, value: controlValue },
    );
    // CSS transitions outrank even !important declarations. A first changed
    // GPU draw can still contain a nearly opaque lens, especially in WebKit.
    await page.waitForFunction(
      ({ host, property, value }) => getComputedStyle(host)[property] === value,
      { host: await card.elementHandle(), property: controlProperty, value: controlValue },
      { timeout: 5000 },
    );
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  };
  if (style === "glass") draws = await redrawAfter(page, hide);
  else await hide();
  const empty = await capture("hidden-host");
  const a = PNG.sync.read(painted),
    b = PNG.sync.read(empty);
  const delta = (x, y) => {
    const index = (y * a.width + x) * 4;
    return Math.max(
      ...[0, 1, 2].map((channel) => Math.abs(a.data[index + channel] - b.data[index + channel])),
    );
  };
  const result = {
    gapMax: 0,
    gapPixels: 0,
    leftMax: 0,
    rightMax: 0,
    leftPainted: 0,
    rightPainted: 0,
    draws,
    box,
    clip,
    fragments,
    outsideMax: 0,
    sceneAnimations,
    controlOpacity: await card.evaluate((host) => getComputedStyle(host).opacity),
    controlVisibility: await card.evaluate((host) => getComputedStyle(host).visibility),
  };
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++) {
      const worldX = clip.x + x + 0.5,
        worldY = clip.y + y + 0.5;
      if (
        worldX < box.x - 2 ||
        worldX > box.x + box.width + 2 ||
        worldY < box.y - 2 ||
        worldY > box.y + box.height + 2
      )
        result.outsideMax = Math.max(result.outsideMax, delta(x, y));
    }
  const seamAt = (y) => {
    const index = seam.findIndex((point) => point[1] >= y);
    const p = seam[Math.max(0, index - 1)],
      q = seam[index];
    return p[0] + ((q[0] - p[0]) * (y - p[1])) / (q[1] - p[1]);
  };
  // The bottom identity band and perimeter antialiasing are intentionally excluded;
  // the seam and BOTH material interiors still cover most of the actual card height.
  for (let y = Math.ceil(box.height * 0.18); y < box.height * 0.72; y++) {
    const py = Math.round(box.y - clip.y + y);
    const worldY = clip.y + py + 0.5;
    const left =
      fragments[0].x -
      clip.x +
      seamAt((worldY - fragments[0].y) / fragments[0].height) * fragments[0].width;
    const right =
      fragments[1].x -
      clip.x +
      seamAt((worldY - fragments[1].y) / fragments[1].height) * fragments[1].width;
    // Sample pixel centers in screenshot coordinates, at least two CSS pixels
    // inside both clip edges. Mixing host-local rounded X with screenshot X
    // accidentally samples the antialiased material perimeter on narrow cards.
    for (let px = Math.ceil(left + 2); px + 0.5 < right - 2; px++) {
      result.gapMax = Math.max(result.gapMax, delta(px, py));
      result.gapPixels++;
    }
    for (const [side, start, end] of [
      ["left", 0.005, 0.38],
      ["right", 0.62, 0.995],
    ]) {
      for (let x = Math.ceil(box.width * start); x < box.width * end; x++) {
        const d = delta(Math.round(box.x - clip.x + x), py);
        result[`${side}Max`] = Math.max(result[`${side}Max`], d);
        if (d > 2) result[`${side}Painted`]++;
      }
    }
  }
  const show = async () => {
    await card.evaluate(
      (host, { property, previous }) => {
        if (previous.value) host.style.setProperty(property, previous.value, previous.priority);
        else host.style.removeProperty(property);
      },
      { property: controlProperty, previous: previousControl },
    );
    await page.waitForFunction(
      ({ host, property }) =>
        getComputedStyle(host)[property] === (property === "opacity" ? "1" : "visible"),
      { host: await card.elementHandle(), property: controlProperty },
    );
  };
  if (style === "glass") await redrawAfter(page, show);
  else await show();
  await card.evaluate((host) => host.removeAttribute("data-pixel-isolate"));
  await scenery.evaluate((animations) => animations.forEach((animation) => animation.play()));
  await scenery.dispose();
  await writeFile(`${path}-pixels.json`, JSON.stringify(result, null, 2));
  assert.ok(result.gapPixels > 15, "Gap comparison samples real scene pixels");
  assert.ok(
    result.outsideMax <= 1,
    `No material/fragment bleeds outside the original host into neighboring scene: ${JSON.stringify(result)}`,
  );
  assert.ok(
    result.gapMax <= 1,
    `No intact backing in the real ${style} gap: ${JSON.stringify(result)}`,
  );
  assert.ok(
    result.leftMax > 3 && result.rightMax > 3 && result.leftPainted > 5 && result.rightPainted > 5,
    `Both faded fragments really paint: ${JSON.stringify(result)}`,
  );
  return result;
}

export function runDepartureScenarios({ test, engines, install, output }) {
  for (const [engine, launcher] of engines)
    for (const style of ["glass", "classic", "heritage", "noir"]) {
      test(
        `${engine}/${style}: cause phases, persistent pixels, restoration and interruptions`,
        { timeout: 180000 },
        async (t) => {
          const browser = await launcher();
          const page = await browser.newPage({
            viewport: { width: 1366, height: 1024 },
            screen: { width: 1366, height: 1024 },
            hasTouch: engine === "webkit",
            recordVideo: { dir: output, size: { width: 1366, height: 1024 } },
          });
          const video = page.video();
          const errors = [];
          const cases = [];
          page.on("pageerror", (error) => errors.push(error.message));
          const run = async (name, action) =>
            t.test(name, async () => {
              const prefix = join(
                output,
                `${engine}-${style}-${name.replaceAll(/[^a-z0-9-]/gi, "-")}`,
              );
              try {
                await setup(page, style);
                await action(prefix);
                cases.push({ name, status: "passed" });
              } catch (error) {
                await page
                  .screenshot({ path: `${prefix}-FAIL.png`, fullPage: true })
                  .catch(() => {});
                const state = await page
                  .evaluate(() => ({
                    phase: window.exitFixture.game.phase,
                    game: window.exitFixture.game,
                    frames: window.exitFixture.frames,
                    hosts: [...document.querySelectorAll(".seat-anchor > .player-seat")].map(
                      (host) => ({
                        seat: host.parentElement.dataset.seat,
                        cause: host.dataset.departureCause,
                        request: host.dataset.playerExit,
                        style: host.getAttribute("style"),
                        html: host.outerHTML,
                      }),
                    ),
                    animations: document.getAnimations().map((a) => ({
                      id: a.id,
                      state: a.playState,
                      time: a.currentTime,
                      duration: a.effect.getTiming().duration,
                    })),
                  }))
                  .catch(() => null);
                await writeFile(
                  `${prefix}-FAIL.json`,
                  JSON.stringify({ error: error.stack, state }, null, 2),
                );
                cases.push({ name, status: "failed", error: error.message });
                throw error;
              }
            });
          try {
            await install(page);
            // A vote failure must not prevent Mafia/discipline baseline recording.
            for (const [cause, begin] of [
              ["vote", beginVote],
              ["mafia", beginMafia],
              ["discipline", beginDiscipline],
            ]) {
              for (const defaults of [false, true])
                await run(
                  `natural-${defaults ? "default-" : ""}playback-continuity-${cause}`,
                  async (prefix) => {
                    if (defaults) {
                      await page.evaluate(() =>
                        window.exitFixture.setSettings(window.exitFixture.defaultSettings),
                      );
                      await page.waitForFunction(
                        () =>
                          JSON.stringify(window.exitFixture.settings) ===
                          JSON.stringify(window.exitFixture.defaultSettings),
                        null,
                        { timeout: 5000 },
                      );
                    }
                    const settings = await page.evaluate(() => window.exitFixture.settings);
                    const clock = await timeline(page, cause);
                    const recording = await traceNaturalDeparture(
                      page,
                      () => begin(page),
                      clock.duration + 500,
                    );
                    await writeFile(
                      `${prefix}-natural.json`,
                      JSON.stringify({ settings, clock, ...recording }, null, 2),
                    );
                    await page.screenshot({ path: `${prefix}-settled.png` });
                    await assertNaturalContinuity(page, style, cause, recording, prefix, clock);
                  },
                );
            }
            await run("vote-order-and-persistent-wide-pixels", async (prefix) => {
              const victim = await beginVote(page),
                card = page.locator(cardSelector(victim));
              const seats = await page.evaluate(() =>
                window.exitFixture.game.players
                  .filter((p) => p.status === "eliminated")
                  .map((p) => p.seat),
              );
              const neighbors = await geometry(page, seats);
              const clock = await timeline(page, "vote");
              const tracks = await pause(page, clock.tearStart * 0.8);
              assert.equal(
                tracks.length,
                14,
                "Each victim has four face/pose tracks, two cause tracks and one Glass reflection or printed public inverse",
              );
              assert.equal(
                tracks.filter((track) => track.host && track.properties.includes("rotate")).length,
                2,
                "Both semantic hosts own a real native turn",
              );
              if (style === "glass") {
                assert.equal(
                  tracks.filter(
                    (track) =>
                      track.target.includes("liquid-card-glass") &&
                      track.properties.includes("scale"),
                  ).length,
                  2,
                  "Each victim's direct Glass material has its own synchronized reflection track",
                );
              } else {
                assert.equal(
                  tracks.filter((track) => track.id.startsWith("printed-card-exit-")).length,
                  10,
                  "Both printed cards retain all five native pose/face/public tracks",
                );
                assert.equal(
                  tracks.filter(
                    (track) =>
                      track.target.includes("printed-player-card__public") &&
                      track.properties.includes("rotate"),
                  ).length,
                  2,
                  "Each printed public overlay has its inverse turn",
                );
                assert.equal(
                  tracks.filter((track) => track.target.includes("printed-player-card__motion"))
                    .length,
                  0,
                  "No second inner-paper turn",
                );
              }
              close(
                await property(card, "--player-exit-tear"),
                0,
                "No tear before intact turn completion",
              );
              close(await property(card, "--player-exit-fade"), 1, "No early fade");
              await privacy(card);
              await page.screenshot({ path: `${prefix}-intact-turn.png` });
              await pause(page, clock.tearStart + 2);
              close((await pose(card, style)).rotate, 180, "Intact turn completes before tear");
              await pause(page, (clock.tearStart + clock.fadeStart) / 2);
              assert.ok(
                (await property(card, "--player-exit-tear")) > 0.2,
                "Separation becomes visible in tear phase",
              );
              close(
                await property(card, "--player-exit-fade"),
                1,
                "Fade waits for fully separated pieces",
              );
              await page.screenshot({ path: `${prefix}-tear.png` });
              await pause(page, (clock.fadeStart + clock.duration) / 2);
              close(await property(card, "--player-exit-tear"), 1, "Fade retains complete tear");
              assert.ok(
                (await property(card, "--player-exit-fade")) < 0.9 &&
                  (await property(card, "--player-exit-fade")) > 0.45,
                "Only now do pieces fade",
              );
              await materialOpacity(card, style, (1 + 0.45) / 2, `${prefix}-midpoint`);
              const request = await card.getAttribute("data-player-exit");
              await page.evaluate(() =>
                window.exitFixture.setSettings((s) => ({ ...s, landingMs: 200 })),
              );
              assert.equal(
                await card.getAttribute("data-player-exit"),
                request,
                "Tuning never restarts a captured action",
              );
              await finish(page);
              close(
                await property(card, "--player-exit-fade"),
                0.45,
                "Persistent endpoint opacity",
              );
              assert.equal(await card.locator(".player-torn-fragment").count(), 2);
              await privacy(card);
              await materialOpacity(card, style, 0.45, prefix);
              sameGeometry(neighbors, await geometry(page, seats), "Stable neighbors");
              const landed = await card.boundingBox();
              await page.waitForTimeout(180);
              sameGeometry(
                { victim: landed },
                { victim: await card.boundingBox() },
                "Stable endpoint",
              );
              await tornPixels(page, card, style, prefix);
              await page.evaluate(() => window.exitFixture.save());
              await page.reload();
              await page.waitForFunction(() => !!window.exitFixture);
              await page.evaluate(() => {
                document.body.dataset.departureScenarios = "true";
              });
              if (style === "glass")
                await page.waitForFunction(
                  () => document.querySelector(".app-shell").dataset.glassStatus === "ready",
                );
              assert.equal(
                await page.locator(activeSelector).count(),
                0,
                "Actual document refresh never replays completed actions",
              );
              assert.equal(
                await page.locator(cardSelector(victim)).getAttribute("data-departure-cause"),
                "vote",
                "Admitted history retains cause across refresh",
              );
              await tornPixels(page, page.locator(cardSelector(victim)), style, `${prefix}-reload`);
              await materialOpacity(
                page.locator(cardSelector(victim)),
                style,
                0.45,
                `${prefix}-reload`,
              );
            });
            await run("compact-maximum-gap-pixels", async (prefix) => {
              await page.setViewportSize({ width: 820, height: 1180 });
              await page.evaluate(() => window.exitFixture.setLongNames(true));
              const victim = await beginVote(page);
              await finish(page);
              await page.screenshot({ path: `${prefix}-table.png`, fullPage: true });
              await tornPixels(page, page.locator(cardSelector(victim)), style, prefix);
              assert.equal(
                await page.evaluate(
                  () => document.documentElement.scrollWidth <= window.innerWidth,
                ),
                true,
                "No horizontal overflow at compact maximum gap",
              );
              await page.setViewportSize({ width: 1366, height: 1024 });
            });
            if (style === "glass")
              for (const enhanced of [true, false])
                for (const phase of ["tear", "fade"]) {
                  await run(
                    `glass-${enhanced ? "shared" : "fallback"}-${phase}-gap-alignment`,
                    async (prefix) => {
                      await page.evaluate(
                        (enabled) => window.exitFixture.setGlass(enabled),
                        enhanced,
                      );
                      const victim = await beginVote(page),
                        card = page.locator(cardSelector(victim));
                      const clock = await timeline(page, "vote");
                      await pause(
                        page,
                        phase === "tear"
                          ? (clock.tearStart + clock.fadeStart) / 2
                          : (clock.fadeStart + clock.duration) / 2,
                      );
                      close(
                        (await pose(card, style)).rotate,
                        180,
                        "Semantic host is at reverse rotation during tear/fade",
                      );
                      await page.screenshot({ path: `${prefix}-table.png`, fullPage: true });
                      await tornPixels(page, card, enhanced ? "glass" : "glass-fallback", prefix);
                      await finish(page);
                    },
                  );
                }
            await run("mafia-staggered-holes-public-boundary", async (prefix) => {
              const victim = await beginMafia(page),
                card = page.locator(cardSelector(victim));
              const clock = await timeline(page, "mafia");
              for (const [fraction, expected] of [
                [0.02, 0],
                [0.2, 1],
                [0.55, 2],
                [0.9, 3],
              ]) {
                await pause(page, clock.turnStart * fraction);
                const state = await pose(card, style);
                close(state.rotate, 0, "Punctures precede the base turn");
                const visible = await card.evaluate(
                  (host) =>
                    [...host.querySelectorAll(".player-bullet-holes")]
                      .filter(
                        (marks) => getComputedStyle(marks.parentElement).visibility === "visible",
                      )
                      .flatMap((marks) => [...marks.children])
                      .filter((hole) => Number(getComputedStyle(hole).opacity) > 0.9).length,
                );
                assert.equal(
                  visible,
                  expected,
                  "Exactly three punctures arrive one at a time, not an instant triple mark",
                );
                await privacy(card);
                await page.screenshot({ path: `${prefix}-${expected}-holes.png` });
              }
              await pause(page, (clock.fadeStart + clock.duration) / 2);
              await materialOpacity(card, style, (1 + 0.45) / 2, `${prefix}-midpoint`);
              await intactFadePixels(page, card, style, clock, prefix);
              await finish(page);
              await materialOpacity(card, style, 0.45, `${prefix}-settled`);
              assert.equal(await card.locator(".player-bullet-hole").count(), 3);
              assert.equal(
                await card.locator(".player-torn-fragment,.player-disciplinary-ribbon").count(),
                0,
              );
              await page.evaluate(() => window.exitFixture.restore());
              assert.equal(await page.locator(activeSelector).count(), 0);
              assert.equal(
                await card.locator(".player-bullet-hole").count(),
                3,
                "Restoration retains the permanent three holes",
              );
              await materialOpacity(card, style, 0.45, `${prefix}-restored`);
            });
            await run("discipline-immediate-cue-not-vote-or-shot", async (prefix) => {
              const victim = await beginDiscipline(page),
                card = page.locator(cardSelector(victim));
              const clock = await timeline(page, "discipline");
              await pause(page, clock.turnStart * 0.3);
              close((await pose(card, style)).rotate, 0, "Red-card cue occurs before turn");
              const anchors = await card.evaluate((host) => {
                const front = host.querySelector(
                  ".printed-player-card__outgoing,.player-exit-front",
                );
                const edge = front.getBoundingClientRect();
                return [".player-disciplinary-card", ".player-disciplinary-ribbon"].map(
                  (selector) => {
                    const marker = front.querySelector(selector).getBoundingClientRect();
                    return {
                      selector,
                      top: marker.top - edge.top,
                      right: edge.right - marker.right,
                      face: edge.toJSON(),
                      marker: marker.toJSON(),
                    };
                  },
                );
              });
              await writeFile(`${prefix}-anchors.json`, JSON.stringify(anchors, null, 2));
              await page.screenshot({ path: `${prefix}-cue.png` });
              for (const anchor of anchors) {
                close(anchor.top, 0, `${anchor.selector} touches the top material edge`, 1);
                close(anchor.right, 0, `${anchor.selector} touches the right material edge`, 1);
              }
              assert.ok((await property(card, "--player-exit-sanction")) > 0.9);
              assert.equal(
                await card.locator(".player-bullet-hole,.player-torn-fragment").count(),
                0,
              );
              await privacy(card);
              await page.screenshot({ path: `${prefix}-cue.png` });
              await pause(page, (clock.fadeStart + clock.duration) / 2);
              await materialOpacity(card, style, (1 + 0.45) / 2, `${prefix}-midpoint`);
              await intactFadePixels(page, card, style, clock, prefix);
              await finish(page);
              await materialOpacity(card, style, 0.45, `${prefix}-settled`);
              assert.equal(await card.locator(".player-disciplinary-ribbon").count(), 1);
              await page.evaluate(() => window.exitFixture.restore());
              assert.equal(
                await page.locator(activeSelector).count(),
                0,
                "Restored exclusion does not replay",
              );
              await materialOpacity(card, style, 0.45, `${prefix}-restored`);
              await page.evaluate(() => window.exitFixture.announce());
              assert.equal(
                await page.locator(activeSelector).count(),
                0,
                "Later announcement must not replay exclusion",
              );
              await correctSnapshot(page);
              close(
                await property(card, "--player-exit-fade"),
                1,
                "Correction clears the departure fade",
              );
              await materialOpacity(card, style, 1, `${prefix}-active-restored`);
              assert.equal(
                await card
                  .locator(".player-disciplinary-ribbon,.player-bullet-hole,.player-torn-fragment")
                  .count(),
                0,
                "Restoring the active player clears all endpoints",
              );
            });
            if (style === "glass")
              for (const [cause, begin] of [
                ["mafia", beginMafia],
                ["discipline", beginDiscipline],
              ])
                await run(`glass-fallback-${cause}-fade-pixels`, async (prefix) => {
                  await page.evaluate(() => window.exitFixture.setGlass(false));
                  await page.waitForFunction(
                    () => document.querySelector(".app-shell").dataset.glassStatus === "off",
                  );
                  const victim = await begin(page),
                    card = page.locator(cardSelector(victim));
                  const clock = await timeline(page, cause);
                  await pause(page, (clock.fadeStart + clock.duration) / 2);
                  await materialOpacity(card, style, (1 + 0.45) / 2, `${prefix}-midpoint`);
                  await intactFadePixels(page, card, style, clock, prefix, false);
                  await finish(page);
                  await materialOpacity(card, style, 0.45, `${prefix}-settled`);
                });
            await run("unknown-real-preview-fade-and-style-restoration", async (prefix) => {
              const card = await beginUnknownPreview(page, style);
              const clock = await timeline(page, "unknown");
              await pause(page, (clock.fadeStart + clock.duration) / 2);
              assert.equal(
                await card.locator(".player-exit-back .seat-name").count(),
                0,
                "The unknown Glass turn also uses a nameless reverse",
              );
              await materialOpacity(card, style, (1 + 0.45) / 2, `${prefix}-midpoint`);
              await finish(page);
              await page.waitForFunction(
                () => !document.querySelector(".player-exit-preview [data-player-exit]"),
              );
              await materialOpacity(card, style, 0.45, `${prefix}-settled`);
              assert.equal(
                await card.locator(".deceased-cross").count(),
                style === "glass" ? 1 : 0,
                "Unknown Glass retains its intact deceased front, not a neutral reverse",
              );
              assert.equal(
                await card.locator(".player-role-icon").count(),
                style === "glass" ? 1 : 0,
                "The unknown Glass front retains its neutral person artwork",
              );
              assert.equal(
                await card.locator(".printed-player-card__back-art").count(),
                style === "glass" ? 0 : 1,
                "Unknown printed departures still use their nameless deck reverse",
              );
              assert.equal(
                await card
                  .locator(".player-torn-fragment,.player-bullet-hole,.player-disciplinary-ribbon")
                  .count(),
                0,
                "Unknown never invents known-cause marks",
              );
              // Swapping the real preview renderer restores its endpoint without
              // a request; returning to this style cannot replay the animation.
              await page
                .getByLabel("Preview card style", { exact: true })
                .selectOption(style === "glass" ? "classic" : "glass");
              await page.getByLabel("Preview card style", { exact: true }).selectOption(style);
              assert.equal(await card.getAttribute("data-player-exit"), null);
              await materialOpacity(card, style, 0.45, `${prefix}-style-restored`);
              await page.screenshot({ path: `${prefix}-restored.png` });
            });
            await run("unknown-baseline-reload-history-and-active-restoration", async (prefix) => {
              await loadSnapshot(page, "unknown");
              assert.equal(
                await page.evaluate(() => window.exitFixture.game.phase),
                "day",
                "Unknown departure endpoints belong to active play, not the completed-game front reveal",
              );
              const victim = await page.evaluate(() => window.exitFixture.victim);
              const card = page.locator(cardSelector(victim));
              await page
                .locator(`${cardSelector(victim)}[data-departure-cause="unknown"]`)
                .waitFor();
              assert.equal(
                await page.evaluate(() => window.exitFixture.frames.length),
                0,
                "An active-play baseline has no admitted cause history to invent",
              );
              assert.equal(await page.locator(activeSelector).count(), 0);
              await materialOpacity(card, style, 0.45, `${prefix}-baseline`);
              await privacy(card);
              await page.evaluate(() => window.exitFixture.save());
              await page.reload();
              await page.waitForFunction(() => !!window.exitFixture);
              await page.evaluate(() => {
                document.body.dataset.departureScenarios = "true";
              });
              if (style === "glass")
                await page.waitForFunction(
                  () => document.querySelector(".app-shell").dataset.glassStatus === "ready",
                );
              assert.equal(
                await page.locator(activeSelector).count(),
                0,
                "Unknown reload never replays",
              );
              assert.equal(await card.getAttribute("data-departure-cause"), "unknown");
              await materialOpacity(card, style, 0.45, `${prefix}-reload`);
              await page.evaluate(() => window.exitFixture.setMode("preview"));
              assert.equal(
                await page.locator(activeSelector).count(),
                0,
                "History is a static endpoint",
              );
              await materialOpacity(card, style, 0.45, `${prefix}-history`);
              await privacy(card);
              await correctSnapshot(page);
              assert.equal(await card.getAttribute("data-departure-cause"), null);
              close(
                await property(card, "--player-exit-fade"),
                1,
                "Restoring active clears unknown fade",
              );
              await materialOpacity(card, style, 1, `${prefix}-active-restored`);
              await page.screenshot({ path: `${prefix}-active-restored.png` });
            });
            for (const [cause, phase, mechanism] of [
              ["mafia", "impact", "hidden"],
              ["mafia", "turn", "correction"],
              ["vote", "turn", "reduced"],
              ["vote", "tear", "disabled"],
              ["vote", "fade", "fancy"],
              ["discipline", "cue", "style"],
              ["discipline", "turn", "cancel-track"],
            ]) {
              await run(`interrupt-${cause}-${phase}-${mechanism}`, async () => {
                const victim = await (cause === "mafia"
                  ? beginMafia(page)
                  : cause === "vote"
                    ? beginVote(page)
                    : beginDiscipline(page));
                const card = page.locator(cardSelector(victim)),
                  clock = await timeline(page, cause);
                const at =
                  phase === "impact" || phase === "cue"
                    ? clock.turnStart / 2
                    : phase === "tear"
                      ? (clock.tearStart + clock.fadeStart) / 2
                      : phase === "fade"
                        ? (clock.fadeStart + clock.duration) / 2
                        : clock.turnStart + 500;
                await pause(page, at);
                if (mechanism === "hidden")
                  await page.evaluate(() => {
                    Object.defineProperty(document, "hidden", { configurable: true, value: true });
                    document.dispatchEvent(new Event("visibilitychange"));
                  });
                if (mechanism === "correction") await correctSnapshot(page);
                if (mechanism === "reduced") await page.emulateMedia({ reducedMotion: "reduce" });
                if (mechanism === "disabled")
                  await page.evaluate(() =>
                    window.exitFixture.setSettings((s) => ({ ...s, enabled: false })),
                  );
                if (mechanism === "fancy")
                  await page.evaluate(() => window.exitFixture.setFancy(false));
                if (mechanism === "style")
                  await page.evaluate(
                    (selected) =>
                      window.exitFixture.setStyle(selected === "glass" ? "classic" : "glass"),
                    style,
                  );
                if (mechanism === "cancel-track")
                  await page.evaluate(() =>
                    document
                      .getAnimations()
                      .find((a) => /^(player-exit-|printed-card-exit-)/.test(a.id))
                      ?.cancel(),
                  );
                await page.evaluate(
                  () =>
                    new Promise((resolve) =>
                      window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)),
                    ),
                );
                assert.equal(
                  await page.locator(activeSelector).count(),
                  0,
                  "Interruption settles immediately, not after the rest of the captured clock or a replacement renderer replay",
                );
                assert.equal(
                  await page.evaluate(
                    () =>
                      document
                        .getAnimations()
                        .filter((a) => /^(player-exit-|printed-card-exit-)/.test(a.id)).length,
                  ),
                  0,
                  "Interruption removes all tracks, including printed tracks",
                );
                assert.equal(
                  await card.getAttribute("data-departure-cause"),
                  mechanism === "correction" ? null : cause,
                );
                if (cause === "vote")
                  assert.equal(
                    await card.locator(".player-torn-fragment").count(),
                    2,
                    "Interrupted vote settles to both persistent fragments",
                  );
                await privacy(card);
                await page.evaluate(() => {
                  delete document.hidden;
                  document.dispatchEvent(new Event("visibilitychange"));
                  window.exitFixture.setFancy(true);
                  window.exitFixture.setSettings((s) => ({ ...s, enabled: true }));
                });
                await page.emulateMedia({ reducedMotion: "no-preference" });
                assert.equal(
                  await page.locator(activeSelector).count(),
                  0,
                  "Re-enabling never replays settled motion",
                );
              });
            }
            for (const cause of ["vote", "mafia", "discipline", "unknown"])
              for (const mechanism of [
                "reduced",
                "disabled",
                "fancy",
                "missing-waapi",
                "throwing-waapi",
              ])
                await run(`static-${cause}-${mechanism}`, async (prefix) => {
                  if (mechanism === "reduced") await page.emulateMedia({ reducedMotion: "reduce" });
                  if (mechanism === "disabled")
                    await page.evaluate(() =>
                      window.exitFixture.setSettings((s) => ({ ...s, enabled: false })),
                    );
                  if (mechanism === "fancy")
                    await page.evaluate(() => window.exitFixture.setFancy(false));
                  if (mechanism.includes("waapi"))
                    await page.evaluate((throws) => {
                      window.originalAnimate = Element.prototype.animate;
                      Element.prototype.animate = throws
                        ? () => {
                            throw new Error("Fixture WAAPI failure");
                          }
                        : undefined;
                    }, mechanism === "throwing-waapi");
                  let card;
                  if (cause === "unknown") card = await beginUnknownPreview(page, style, false);
                  else {
                    const begin =
                      cause === "vote"
                        ? beginVote
                        : cause === "mafia"
                          ? beginMafia
                          : beginDiscipline;
                    const victim = await begin(page, false);
                    card = page.locator(cardSelector(victim));
                  }
                  await page.waitForFunction(
                    () =>
                      !document.querySelector(
                        ".seat-anchor [data-player-exit],.player-exit-preview [data-player-exit]",
                      ),
                  );
                  assert.equal(await card.getAttribute("data-departure-cause"), cause);
                  assert.equal(
                    await card.locator(".player-torn-fragment").count(),
                    cause === "vote" ? 2 : 0,
                  );
                  assert.equal(
                    await card.locator(".player-bullet-hole").count(),
                    cause === "mafia" ? 3 : 0,
                  );
                  assert.equal(
                    await card.locator(".player-disciplinary-ribbon").count(),
                    cause === "discipline" ? 1 : 0,
                  );
                  close(
                    await property(card, "--player-exit-tear"),
                    cause === "vote" ? 1 : 0,
                    "Static endpoint retains its actual cause-specific material",
                  );
                  await materialOpacity(card, style, 0.45, prefix);
                  await privacy(card);
                  await page.screenshot({ path: `${prefix}.png` });
                  await page.evaluate(() => {
                    if (window.originalAnimate) {
                      Element.prototype.animate = window.originalAnimate;
                      delete window.originalAnimate;
                    }
                  });
                });
            assert.deepEqual(errors, [], "No browser runtime errors");
          } finally {
            await writeFile(
              join(output, `${engine}-${style}-results.json`),
              JSON.stringify(
                {
                  engine,
                  version: browser.version(),
                  style,
                  touch: engine === "webkit",
                  cases,
                  errors,
                },
                null,
                2,
              ),
            );
            await page.context().close();
            if (video) await video.saveAs(join(output, `${engine}-${style}-natural-playback.webm`));
            await browser.close();
          }
        },
      );
    }
}
