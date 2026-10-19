/* global structuredClone */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import {
  assertBalancedCardPlacement,
  assertCardSizes,
  assertCanonicalProjection,
  assertRailMaterial,
  assertPlayerLighting,
  resolveUiMode,
} from "./ui-presentation-contracts.mjs";
import { tsImport } from "tsx/esm/api";

test("role artwork oracle rejects missing labels, mismatched exit faces and masked leaks", async () => {
  const source = readFileSync(new URL("./verify-ui.mjs", import.meta.url), "utf8");
  const tree = ts.createSourceFile("verify-ui.mjs", source, ts.ScriptTarget.Latest, true);
  const declaration = tree.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((node) => node.name.getText(tree) === "assertRolePresentation");
  assert.ok(declaration);
  const validate = runInContext(
    `(${declaration.initializer.getText(tree)})`,
    createContext({
      console: { log() {} },
    }),
  );
  const verify = (labels, { masked = false, exiting = false } = {}) => {
    const cards = labels.map((roles) => ({
      matches: () => false,
      hasAttribute: (name) => name === "data-player-exit" && exiting,
      classList: { contains: () => false },
      querySelectorAll: (selector) =>
        selector === '.player-role-icon[role="img"]'
          ? roles.map((role) => ({ getAttribute: () => role }))
          : [],
    }));
    const shell = {
      className: "game-shell phase-day",
      querySelectorAll: (selector) =>
        selector === ".player-seat"
          ? cards
          : cards.flatMap((card) => card.querySelectorAll(selector)),
      querySelector: () => ({
        getAttribute: () => (masked ? "Team counts hidden" : "Citizens 7 Mafia 3"),
      }),
      closest: () => ({ getAttribute: () => "legacy" }),
    };
    return validate(
      { locator: () => ({ evaluate: (callback) => callback(shell) }) },
      {
        masked,
        roleLighting: false,
        phase: "day",
      },
    );
  };
  const visible = Array.from({ length: 10 }, () => ["citizen"]);
  await verify(visible);
  await verify(
    Array.from({ length: 10 }, () => []),
    { masked: true },
  );
  await assert.rejects(verify([[], ...visible.slice(1)]), /leaked or was suppressed/);
  await assert.rejects(verify([[""], ...visible.slice(1)]), /leaked or was suppressed/);
  await assert.rejects(verify(visible, { masked: true }), /leaked or was suppressed/);
  await assert.rejects(
    verify([["citizen", "mafia"], ...visible.slice(1)], { exiting: true }),
    /leaked or was suppressed/,
  );
  await verify([["citizen", "citizen"], ...visible.slice(1)], { exiting: true });
});

test("mocked YouTube provider is installed before navigation and survives fresh documents", () => {
  const source = readFileSync(new URL("./verify-ui.mjs", import.meta.url), "utf8");
  const tree = ts.createSourceFile("verify-ui.mjs", source, ts.ScriptTarget.Latest, true);
  const installs = [];
  const navigations = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      if (node.expression.getText(tree) === "page.goto") navigations.push(node.pos);
      const callback = node.arguments[0];
      if (
        callback &&
        ts.isArrowFunction(callback) &&
        callback.getText(tree).includes("class FakeYouTubePlayer")
      )
        installs.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.equal(installs.length, 1, "one shared provider fixture owns every mocked journey");
  const initializers = [];
  let mounted;
  const placeholder = {
    id: "fixture",
    className: "youtube-player-video",
    replaceWith: (iframe) => (mounted = iframe),
  };
  const sandbox = createContext({
    window: {},
    document: {
      getElementById: (id) => (id === placeholder.id ? placeholder : null),
      createElement: () => ({ remove: () => (mounted = null) }),
    },
    setTimeout: (callback) => callback(),
    page: {
      evaluate: (callback) => callback(),
      addInitScript: (callback) => initializers.push(callback),
    },
  });
  runInContext(installs[0].getText(tree), sandbox);
  for (const documentName of ["initial navigation", "reload"]) {
    sandbox.window = {};
    mounted = placeholder;
    for (const initialize of initializers) initialize();
    assert.equal(
      typeof sandbox.window.YT?.Player,
      "function",
      `${documentName} needs the mocked provider`,
    );
    const player = new sandbox.window.YT.Player("fixture", {});
    assert.equal(mounted, player.getIframe(), "provider replaces the actual mount with its iframe");
    assert.equal(mounted.id, placeholder.id);
    assert.equal(mounted.className, placeholder.className);
    assert.equal(mounted.src, "about:blank", "synthetic media never reaches the real provider");
    assert.equal(
      mounted.title,
      "Synthetic YouTube player",
      "mounted frames need an accessible name",
    );
    player.cuePlaylist(["first", "second"], 1);
    assert.equal(player.getPlayerState(), 5);
    assert.equal(player.getPlaylistIndex(), 1);
    player.destroy();
    assert.equal(mounted, null, "destroy removes the owned iframe");
    assert.throws(() => new sandbox.window.YT.Player("missing", {}), /mount/);
  }
  assert.ok(navigations.length > 0);
  assert.ok(installs[0].pos < Math.min(...navigations), "install before the first navigation path");
});

test("reload guards reject a refilled vote or changed history even after names resolve", () => {
  const source = readFileSync(new URL("./verify-ui.mjs", import.meta.url), "utf8");
  const tree = ts.createSourceFile("verify-ui.mjs", source, ts.ScriptTarget.Latest, true);
  const guards = [];
  const visit = (node) => {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression;
      if (
        ["assert.equal", "assert.deepEqual"].includes(call.expression.getText(tree)) &&
        call.arguments[0]?.getText(tree).startsWith("afterVoteReload")
      )
        guards.push(node.getText(tree));
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.equal(
    guards.length,
    2,
    "both actual persisted-state guards remain in the browser journey",
  );
  const beforeVoteReload = {
    game: { voteAssignments: { 1: 1, 2: 1, 4: 2 } },
    headEventId: "removed-vote",
  };
  const verify = (afterVoteReload) =>
    runInContext(
      guards.join("\n"),
      createContext({ assert, beforeVoteReload, afterVoteReload, removedSeat: 3 }),
    );
  verify(structuredClone(beforeVoteReload));
  const refilled = structuredClone(beforeVoteReload);
  refilled.game.voteAssignments[3] = 2;
  assert.throws(() => verify(refilled), /Reload refilled the removed vote/);
  const changed = structuredClone(beforeVoteReload);
  changed.headEventId = "unexpected-event";
  assert.throws(() => verify(changed), /Reload changed the persisted canonical state/);
});

test("layout centering separates card placement from rendered speaker enlargement", () => {
  const workspace = { top: 0, bottom: 200 };
  const cards = [
    { top: 10, bottom: 90, scale: 1 },
    { top: 150 - 40 * 1.2, bottom: 150 + 40 * 1.2, scale: 1.2 },
  ];
  assert.doesNotThrow(() => assertBalancedCardPlacement(workspace, cards));
  assert.throws(
    () =>
      assertBalancedCardPlacement(workspace, [
        cards[0],
        {
          ...cards[1],
          top: cards[1].top + 3,
          bottom: cards[1].bottom + 3,
        },
      ]),
    /unequal top\/bottom clearance/,
  );
  assert.throws(
    () => assertBalancedCardPlacement(workspace, [{ top: 10, bottom: 190, scale: 0 }]),
    /scale/,
  );
});

test("candidate lift is explicit and does not mask an unbalanced orbit", () => {
  const workspace = { top: 0, bottom: 200 };
  const cards = [
    { top: 6, bottom: 86, scale: 1, votingCandidate: true, translateY: -4 },
    { top: 110, bottom: 190, scale: 1 },
  ];
  assert.doesNotThrow(() => assertBalancedCardPlacement(workspace, cards));
  assert.throws(
    () => assertBalancedCardPlacement(workspace, [{ ...cards[0], translateY: -12 }, cards[1]]),
    /unexpected candidate translation/,
  );
  assert.throws(
    () => assertBalancedCardPlacement(workspace, [{ ...cards[0], top: -1, bottom: 79 }, cards[1]]),
    /clearance/,
  );
});

test("compact centering accounts only for the fixed action-clearance offsets", () => {
  const workspace = { top: 0, bottom: 200 };
  const cards = [
    { seat: "5", top: 10, bottom: 90, scale: 1 },
    { seat: "1", top: 110 - 14, bottom: 190 - 14, scale: 1 },
  ];
  const compact = { compactLandscape: true, phase: "voting" };
  assert.doesNotThrow(() => assertBalancedCardPlacement(workspace, cards, "compact", compact));
  assert.throws(() => assertBalancedCardPlacement(workspace, cards), /clearance/);
  assert.throws(
    () =>
      assertBalancedCardPlacement(
        workspace,
        [cards[0], { ...cards[1], top: cards[1].top - 3, bottom: cards[1].bottom - 3 }],
        "compact",
        compact,
      ),
    /clearance/,
  );
  assert.doesNotThrow(() =>
    assertBalancedCardPlacement(
      workspace,
      [{ ...cards[0], top: cards[0].top + 2, bottom: cards[0].bottom + 2 }, cards[1]],
      "compact day",
      { ...compact, phase: "day" },
    ),
  );
});

test("canonical presentation checkpoints reject hash corruption, divergent state and lifecycle drift", async () => {
  const domain = await tsImport("../packages/game-domain/src/index.ts", import.meta.url);
  const { getActiveBranch } = await tsImport(
    "../apps/web/src/features/game/game-history.ts",
    import.meta.url,
  );
  const { checkpoint, currentSetupState } = await tsImport(
    "./verify-federation-ui.mjs",
    import.meta.url,
  );
  let setup = domain.beginRoleDraw(
    domain.createSetup(Array.from({ length: 10 }, (_, i) => ({ id: `p${i + 1}`, seat: i + 1 }))),
    domain.createSeededRandom(71),
  );
  for (let seat = 1; seat <= 10; seat++) setup = domain.drawRoleForSeat(setup, seat);
  const game = domain.createGame(domain.completeRoleDraw(setup));
  const state = checkpoint(
    game,
    { ...currentSetupState(), setup: null },
    "00000000-0000-4000-8000-000000000301",
  );
  assert.equal(assertCanonicalProjection(domain, getActiveBranch, state).length, 1);
  const corrupted = structuredClone(state);
  corrupted.events[0].stateHashAfter = `sha256:${"0".repeat(64)}`;
  assert.throws(() => assertCanonicalProjection(domain, getActiveBranch, corrupted));
  const divergent = structuredClone(state);
  divergent.game.players[0].fouls = 1;
  assert.throws(
    () => assertCanonicalProjection(domain, getActiveBranch, divergent),
    /canonical replay/,
  );
  const lifecycle = structuredClone(state);
  lifecycle.initialGame.game.day = 2;
  lifecycle.initialGame.game.phase = "night-mafia";
  lifecycle.game = lifecycle.initialGame.game;
  assert.throws(() => assertCanonicalProjection(domain, getActiveBranch, lifecycle));
});

test("mode selection retains each named journey and requires the gameplay parent", () => {
  assert.equal(resolveUiMode({}), "default");
  assert.equal(resolveUiMode({ UI_HEADER_ONLY: "1" }), "header");
  for (const mode of ["PRIVACY", "HARDENING"]) {
    assert.equal(
      resolveUiMode({ UI_HEADER_ONLY: "1", [`UI_${mode}_ONLY`]: "1" }),
      mode.toLowerCase(),
    );
    assert.throws(() => resolveUiMode({ [`UI_${mode}_ONLY`]: "1" }), /requires UI_HEADER_ONLY/);
  }
  for (const mode of ["SIDE_PANEL", "MUSIC", "LAYOUT", "RULES_SKETCHBOOK", "FEDERATION"]) {
    assert.equal(
      resolveUiMode({ [`UI_${mode}_ONLY`]: "1" }),
      mode.toLowerCase().replaceAll("_", "-"),
    );
  }
});

test("contradictory and malformed mode switches cannot silently pass another journey", () => {
  for (const env of [
    { UI_HEADER_ONLY: "1", UI_MUSIC_ONLY: "1" },
    { UI_HEADER_ONLY: "1", UI_PRIVACY_ONLY: "1", UI_HARDENING_ONLY: "1" },
    { UI_FEDERATION_ONLY: "1", UI_RULES_SKETCHBOOK_ONLY: "1" },
    { UI_SIDE_PANEL_ONLY: "1", UI_LAYOUT_ONLY: "1" },
  ])
    assert.throws(() => resolveUiMode(env), /Conflicting/);
  assert.throws(() => resolveUiMode({ UI_PRIVACY_ONLY: "true" }), /must be 0 or 1/);
  assert.throws(() => resolveUiMode({ UI_UNKNOWN_ONLY: "1" }), /Unknown/);
  assert.equal(resolveUiMode({ UI_PRIVACY_ONLY: "0" }), "default");
});

test("card sizing separates layout from explicit speaker/voter transforms without accepting collapsed cards", () => {
  const normal = {
    layoutWidth: 100,
    layoutHeight: 80,
    width: 100,
    height: 80,
    scale: 1,
    emphasized: false,
    voted: false,
  };
  const active = { ...normal, width: 120, height: 96, scale: 1.2, emphasized: true };
  const voted = { ...normal, width: 88, height: 70.4, scale: 0.88, voted: true };
  assert.doesNotThrow(() => assertCardSizes([normal, active, voted]));
  for (const invalid of [
    { ...normal, layoutWidth: 99 },
    { ...normal, width: 0, scale: 0 },
    { ...normal, width: 120, height: 96, scale: 1.2 },
    { ...active, width: 121 },
  ])
    assert.throws(() => assertCardSizes([normal, invalid]), /Card/);
});

test("glass rail admits painted scene or deliberate opaque fallback, never invisible blur-free failure", () => {
  const painted = {
    status: "ready",
    sceneVisible: true,
    sceneWidth: 100,
    sceneHeight: 80,
    painted: true,
    reducedTransparency: false,
    backdrop: "none",
    background: "rgba(0, 0, 0, 0)",
  };
  assert.doesNotThrow(() => assertRailMaterial(painted));
  assert.doesNotThrow(() =>
    assertRailMaterial({
      ...painted,
      status: "reduced-transparency",
      sceneVisible: false,
      painted: false,
      reducedTransparency: true,
      background: "rgb(22, 24, 25)",
    }),
  );
  assert.doesNotThrow(() =>
    assertRailMaterial({ ...painted, status: "unavailable", backdrop: "blur(12px)" }),
  );
  for (const invalid of [
    { ...painted, sceneVisible: false },
    { ...painted, sceneWidth: 0 },
    { ...painted, painted: false },
    { ...painted, status: "unavailable" },
    { ...painted, reducedTransparency: true },
  ])
    assert.throws(() => assertRailMaterial(invalid), /Rail material/);
});

test("persistent public light supports reduced motion but rejects hidden, inactive and unready layers", () => {
  const css = {
    effective: "legacy",
    active: true,
    opacity: 1,
    visibility: "visible",
    animation: "liquid-state-pulse",
    shadow: "0 0 15px gold",
    content: '""',
    reducedMotion: false,
  };
  assert.doesNotThrow(() => assertPlayerLighting(css));
  assert.doesNotThrow(() =>
    assertPlayerLighting({ ...css, reducedMotion: true, animation: "none" }),
  );
  const gpu = { ...css, effective: "vgpu", ready: "true", canvasOpacity: 1 };
  assert.doesNotThrow(() => assertPlayerLighting(gpu));
  for (const invalid of [
    { ...css, active: false },
    { ...css, opacity: 0 },
    { ...css, shadow: "none" },
    { ...css, animation: "none" },
    { ...gpu, ready: "false" },
    { ...gpu, visibility: "hidden" },
    { ...gpu, canvasOpacity: 0 },
  ])
    assert.throws(() => assertPlayerLighting(invalid), /Player lighting/);
});
