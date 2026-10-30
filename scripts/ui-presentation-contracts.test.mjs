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

test("player-card mode uses the shared resolver and rejects all competing modes", async () => {
  const { resolveBestMoveUiMode } = await tsImport("./verify-best-move-ui.mjs", import.meta.url);
  assert.equal(resolveUiMode({ UI_PLAYER_CARDS_ONLY: "1" }), "player-cards");
  assert.equal(resolveBestMoveUiMode({ UI_PLAYER_CARDS_ONLY: "1" }), "player-cards");
  for (const other of [
    "HEADER",
    "FEDERATION",
    "FANCY_FEATURES",
    "LAYOUT",
    "MUSIC",
    "RULES_SKETCHBOOK",
    "SIDE_PANEL",
  ]) {
    assert.throws(
      () => resolveBestMoveUiMode({ UI_PLAYER_CARDS_ONLY: "1", [`UI_${other}_ONLY`]: "1" }),
      /[Cc]onflict/,
    );
  }
  assert.throws(
    () => resolveBestMoveUiMode({ UI_PLAYER_CARDS_ONLY: "1", UI_BEST_MOVE_ONLY: "1" }),
    /conflicts/,
  );
  for (const child of ["PRIVACY", "HARDENING"])
    assert.throws(
      () =>
        resolveBestMoveUiMode({
          UI_PLAYER_CARDS_ONLY: "1",
          UI_HEADER_ONLY: "1",
          [`UI_${child}_ONLY`]: "1",
        }),
      /Conflicting/,
    );
  assert.equal(
    resolveBestMoveUiMode({ UI_PLAYER_CARDS_ONLY: "0", UI_BEST_MOVE_ONLY: "1" }),
    "best-move",
  );
  assert.throws(() => resolveUiMode({ UI_PLAYER_CARDS_ONLY: "true" }), /must be 0 or 1/);
  for (const value of ["", "0"])
    assert.equal(resolveUiMode({ UI_PLAYER_CARDS_ONLY: value }), "default");
});

test("player-card fixtures are admitted domain checkpoints with real departure timing", async () => {
  const { playerCardFixture } = await tsImport(
    "./verify-player-card-styles-ui.mjs",
    import.meta.url,
  );
  const domain = await tsImport("../packages/game-domain/src/index.ts", import.meta.url);
  const { getActiveBranch } = await tsImport(
    "../apps/web/src/features/game/game-history.ts",
    import.meta.url,
  );
  const { isCurrentGameSessionState } = await tsImport(
    "../apps/web/src/session-outbox.ts",
    import.meta.url,
  );
  const players = Array.from({ length: 11 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    nickname: `Player ${i + 1}`,
  }));
  for (const stage of [
    "day",
    "pre-vote",
    "night-result",
    "goodbye",
    "departed",
    "roles",
    "sheriff-greeting",
  ]) {
    const fixture = playerCardFixture(players, "00000000-0000-4000-8000-000000000777", stage);
    assert.equal(isCurrentGameSessionState(fixture.state), true, stage);
    assert.equal(fixture.state.hostPlayerId, players[10].id);
    if (stage === "roles") {
      assert.equal(fixture.state.game, null);
      assert.equal(fixture.state.setup.step, "roles");
      assert.equal(Object.keys(fixture.state.setup.setup.assignments).length, 0);
      assert.equal(fixture.state.setup.setup.remainingRoles.length, 10);
      continue;
    }
    assertCanonicalProjection(domain, getActiveBranch, fixture.state);
    assert.equal(fixture.state.game.players.length, 10);
    assert.equal(new Set(fixture.state.game.players.map(({ role }) => role)).size, 4);
    assert.equal(fixture.state.events.length, 1, "No invented pre-fixture gameplay events");
    if (stage === "sheriff-greeting") {
      assert.equal(fixture.state.game.phase, "sheriff-identification");
      assert.equal(domain.advanceOpeningPhase(fixture.state.game).phase, "day");
      assert.ok(fixture.state.game.players.every(({ status }) => status === "active"));
    } else if (stage === "pre-vote") {
      assert.equal(fixture.state.game.phase, "day");
      assert.equal(fixture.state.game.day, 2);
      assert.equal(
        fixture.state.game.players.every(({ status }) => status === "active"),
        true,
      );
      assert.equal(fixture.state.game.currentTurnIndex, fixture.state.game.turnOrder.length - 1);
      assert.deepEqual(
        fixture.state.game.nominations.map(({ candidateSeat }) => candidateSeat),
        [fixture.victimSeat],
      );
      const accepted = domain.completeCurrentTurn(fixture.state.game);
      assert.equal(accepted.phase, "goodbye-speech");
      assert.equal(accepted.goodbyeNext, "night");
      assert.deepEqual(accepted.goodbyeSeats, [fixture.victimSeat]);
      assert.equal(domain.completeGoodbyeSpeech(accepted).phase, "night-mafia");
    } else if (stage !== "day") {
      const victim = fixture.state.game.players.find(({ seat }) => seat === fixture.victimSeat);
      assert.equal(victim.status, "eliminated");
      if (stage === "night-result") assert.equal(fixture.state.game.phase, "night-don");
      if (stage === "goodbye") assert.deepEqual(fixture.state.game.goodbyeSeats, [victim.seat]);
      if (stage === "departed") {
        assert.equal(fixture.state.game.phase, "day");
        assert.equal(fixture.state.game.goodbyeSeats, undefined);
      }
    }
  }
  assert.throws(() => playerCardFixture(players.slice(0, 10), "bad", "day"), /separate host/);
  assert.throws(
    () => playerCardFixture([...players.slice(0, 10), players[0]], "bad", "day"),
    /separate host/,
  );
  assert.throws(() => playerCardFixture(players, "bad", "unknown"), /Unknown player-card fixture/);
});

test("cause fixtures need real accepted history: prefixes, cleanup and completed unknown baseline", async () => {
  const { playerCardFixture } = await tsImport(
    "./verify-player-card-styles-ui.mjs",
    import.meta.url,
  );
  const domain = await tsImport("../packages/game-domain/src/index.ts", import.meta.url);
  const { getActiveBranch } = await tsImport(
    "../apps/web/src/features/game/game-history.ts",
    import.meta.url,
  );
  const { projectPlayerActions } = await tsImport(
    "../apps/web/src/features/game/player-action-presentation.ts",
    import.meta.url,
  );
  const { isCurrentGameSessionState } = await tsImport(
    "../apps/web/src/session-outbox.ts",
    import.meta.url,
  );
  const players = Array.from({ length: 11 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    nickname: `Player ${i + 1}`,
  }));
  const accept = (state, draft) => {
    const event = domain.createGameLogEntry({
      gameId: "00000000-0000-4000-8000-000000000777",
      id: `00000000-0000-4000-8000-${String(800 + state.events.length).padStart(12, "0")}`,
      sequence: state.events.length + 1,
      parentEventId: state.headEventId,
      createdAt: "2026-10-28T10:00:00.000Z",
      before: state.game,
      draft,
    });
    const next = {
      ...state,
      game: event.after,
      events: [...state.events, event.entry],
      headEventId: event.entry.id,
    };
    assert.equal(isCurrentGameSessionState(next), true);
    assertCanonicalProjection(domain, getActiveBranch, next);
    return next;
  };
  for (const [stage, cause] of [
    ["goodbye", "mafia"],
    ["pre-vote", "vote"],
  ]) {
    const fixture = playerCardFixture(players, "00000000-0000-4000-8000-000000000777", stage);
    const before = structuredClone(fixture.state);
    const pending =
      stage === "pre-vote"
        ? accept(before, {
            type: "turn.completed",
            payload: { seat: before.game.turnOrder.at(-1) },
          })
        : before;
    const after = accept(pending, {
      type: "phase.changed",
      payload: { to: cause === "mafia" ? "day" : "night-mafia" },
    });
    const frames = assertCanonicalProjection(domain, getActiveBranch, after);
    assert.equal(projectPlayerActions(frames, after.game).endpoints[fixture.victimSeat], cause);
    assert.equal(
      projectPlayerActions(frames.slice(0, -1), pending.game).endpoints[fixture.victimSeat],
      undefined,
    );
    const serialized = JSON.parse(JSON.stringify(after));
    assert.deepEqual(
      projectPlayerActions(
        assertCanonicalProjection(domain, getActiveBranch, serialized),
        serialized.game,
      ).endpoints,
      { [fixture.victimSeat]: cause },
      "Reload can derive cause from accepted canonical history without saved presentation fields",
    );
    assert.deepEqual(
      projectPlayerActions(assertCanonicalProjection(domain, getActiveBranch, before), before.game)
        .endpoints,
      {},
    );
  }
  const unknown = playerCardFixture(players, "00000000-0000-4000-8000-000000000777", "departed");
  assert.deepEqual(
    projectPlayerActions(
      assertCanonicalProjection(domain, getActiveBranch, unknown.state),
      unknown.state.game,
    ).endpoints,
    { [unknown.victimSeat]: "unknown" },
    "Completed checkpoint status alone cannot invent Mafia or city cause",
  );
  let discipline = playerCardFixture(players, "00000000-0000-4000-8000-000000000777", "day").state;
  const activePlayers = structuredClone(discipline.game.players);
  for (let number = 1; number <= 3; number++) {
    discipline = accept(discipline, {
      type: "foul.issued",
      payload: {
        seat: 5,
        foulNumber: number,
        redCarded: false,
        phase: discipline.game.phase,
        currentTurnIndex: discipline.game.currentTurnIndex,
      },
    });
    const projection = projectPlayerActions(
      assertCanonicalProjection(domain, getActiveBranch, discipline),
      discipline.game,
    );
    assert.deepEqual(projection.action.fouls, { 5: number });
    assert.deepEqual(projection.endpoints, {});
    assert.equal(discipline.game.players.find(({ seat }) => seat === 5).mutePending, number === 3);
    assert.deepEqual(
      discipline.game.players.map(({ status }) => status),
      activePlayers.map(({ status }) => status),
    );
  }
  const thirdFoul = discipline;
  discipline = accept(discipline, {
    type: "discipline.foul-issued",
    payload: {
      seat: 5,
      foulNumber: 4,
      redCarded: true,
      removal: {
        seat: 5,
        stage: "day-discussion",
        rule: "6.2.1",
        reason: "",
        checkInProgress: false,
      },
    },
  });
  const fourth = projectPlayerActions(
    assertCanonicalProjection(domain, getActiveBranch, discipline),
    discipline.game,
  );
  assert.deepEqual(fourth.endpoints, { 5: "discipline" });
  assert.deepEqual(fourth.action.fouls, {}, "Fourth foul is a sanction, not a routine foul pulse");
  assert.deepEqual(
    projectPlayerActions(
      assertCanonicalProjection(domain, getActiveBranch, thirdFoul),
      thirdFoul.game,
    ).endpoints,
    {},
  );
  const day = playerCardFixture(players, "00000000-0000-4000-8000-000000000777", "day").state;
  const ruling = accept(day, {
    type: "game.adjudicated",
    payload: {
      losingTeam: "black",
      offenderSeat: day.game.players.find(({ team }) => team === "black").seat,
      rule: "6.3.5",
      reason: "Accepted fixture ruling",
      committeeApproved: true,
    },
  });
  const outcome = projectPlayerActions(
    assertCanonicalProjection(domain, getActiveBranch, ruling),
    ruling.game,
  );
  assert.equal(outcome.action.adjudication, true);
  assert.deepEqual(outcome.endpoints, {});
  assert.deepEqual(
    ruling.game.players,
    day.game.players,
    "Team ruling never fabricates any player change",
  );
});

test("accepted feedback observer retains short requests, newly mounted results and a finite lifetime", () => {
  const source = readFileSync(
    new URL("./verify-player-card-styles-ui.mjs", import.meta.url),
    "utf8",
  );
  const tree = ts.createSourceFile("verifier.mjs", source, ts.ScriptTarget.Latest, true);
  let observerFactory;
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(tree) === "page.evaluateHandle" &&
      node.arguments[0].getText(tree).includes('attributeFilter: ["data-player-feedback"]')
    )
      observerFactory = node.arguments[0].getText(tree);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(observerFactory, "Exercise the actual scenario observer, not a parallel approximation");
  let callback, timeout, timeoutMs, observed;
  const body = {};
  const factory = runInContext(
    `(${observerFactory})`,
    createContext({
      document: { body },
      MutationObserver: class {
        constructor(handler) {
          callback = handler;
        }
        observe(target, options) {
          observed = { target, options };
        }
        disconnect() {
          this.disconnected = true;
        }
      },
      setTimeout(handler, ms) {
        timeout = handler;
        timeoutMs = ms;
        return 1;
      },
    }),
  );
  const probe = factory(".winner-card");
  const element = (value) => ({
    nodeType: 1,
    matches: (selector) => selector === ".winner-card",
    querySelectorAll: () => [],
    getAttribute: () => value,
    hasAttribute: () => value !== null,
  });
  callback([
    { type: "attributes", target: element(null), oldValue: "7", addedNodes: [] },
    { type: "childList", target: body, addedNodes: [element("8")] },
  ]);
  assert.deepEqual(
    [...probe.ids],
    ["7", "8"],
    "Removal batching and pre-insertion attributes cannot erase accepted cues",
  );
  assert.equal(observed.target, body);
  assert.equal(observed.options.attributeOldValue, true);
  assert.equal(observed.options.childList, true);
  assert.equal(observed.options.subtree, true);
  assert.ok(timeoutMs > 0 && timeoutMs <= 6000);
  timeout();
  assert.equal(probe.observer.disconnected, true);
});

test("reload observer ignores static causes but retains pre-settlement departure and feedback requests", () => {
  const source = readFileSync(
    new URL("./verify-player-card-styles-ui.mjs", import.meta.url),
    "utf8",
  );
  const tree = ts.createSourceFile("verifier.mjs", source, ts.ScriptTarget.Latest, true);
  let factory;
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(tree) === "page.addInitScript" &&
      node.arguments[0]
        .getText(tree)
        .includes('const attributes = ["data-player-feedback", "data-player-exit"]')
    )
      factory = node.arguments[0].getText(tree);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(factory);
  let callback, expiry;
  const sandbox = createContext({
    document: {},
    MutationObserver: class {
      constructor(handler) {
        callback = handler;
      }
      observe() {}
      disconnect() {}
    },
    setTimeout(handler, ms) {
      expiry = ms;
      return 1;
    },
  });
  runInContext(`(${factory})`, sandbox)("probe");
  const element = (attributes) => ({
    nodeType: 1,
    getAttribute: (key) => attributes[key] ?? null,
    querySelectorAll: () => [],
  });
  const staticEndpoint = element({ "data-departure-cause": "mafia" });
  callback([{ type: "childList", addedNodes: [staticEndpoint] }]);
  assert.equal(
    sandbox.probe.ids.length,
    0,
    "Reloaded persistent endpoints are not action requests",
  );
  callback([
    {
      type: "attributes",
      attributeName: "data-player-feedback",
      oldValue: "7",
      target: staticEndpoint,
      addedNodes: [],
    },
    { type: "childList", addedNodes: [element({ "data-player-exit": "8" })] },
  ]);
  assert.deepEqual([...sandbox.probe.ids], ["data-player-feedback:7", "data-player-exit:8"]);
  assert.ok(expiry > 0 && expiry <= 6000);
});

test("player-card dispatch reuses the strict App fixture without replacing provider/error guards", async () => {
  const runner = readFileSync(new URL("./verify-ui.mjs", import.meta.url), "utf8");
  const scenario = readFileSync(
    new URL("./verify-player-card-styles-ui.mjs", import.meta.url),
    "utf8",
  );
  const dispatch = runner.indexOf('if (verificationMode === "player-cards")');
  assert.ok(dispatch > runner.indexOf("const federationApi ="));
  assert.ok(dispatch < runner.indexOf("if (bestMoveOnly)"));
  const branch = runner.slice(dispatch, runner.indexOf("if (bestMoveOnly)"));
  assert.match(branch, /tsImport\([\s\S]*verify-player-card-styles-ui\.mjs/);
  assert.match(branch, /api: federationApi/);
  assert.match(branch, /assertNoPageErrors\(\)/);
  assert.match(runner, /assertExactOrigin\(request\.url\(\), expectedOrigin\)/);
  assert.match(runner, /if \(!pathname\.startsWith\("\/api\/"\)\) \{\s+await route\.fallback\(\)/);
  assert.match(runner, /Real provider requested by mocked journey/);
  assert.match(runner, /Unexpected verifier API requests occurred/);
  assert.match(runner, /window\.YT =/);
  assert.doesNotMatch(
    scenario,
    /\.route\(|\.setContent\(|\.launch\(|force:\s*true/,
    "Scenario cannot replace the App, duplicate API routes or bypass native hit testing",
  );
  const tree = ts.createSourceFile("scenario.mjs", scenario, ts.ScriptTarget.Latest, true);
  let helper;
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "restoredPrefixStyles")
      helper = node.getText(tree);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(helper, "Inspect all history styles by choosing before entering the exact prefix");
  let preview = false;
  const calls = [];
  const inspect = runInContext(
    `(${helper})`,
    createContext({
      assert,
      styles: ["glass", "classic", "heritage", "noir"],
      saved: async () => ({ headEventId: "unchanged-live-head" }),
      card: () => ({ getAttribute: async () => "classic" }),
      choose: async (style) => {
        assert.equal(preview, false, "Manage is unavailable in history preview");
        calls.push(style);
      },
      prefix: async (sequence, callback) => {
        assert.equal(sequence, 17, "Every style inspects the same accepted prefix");
        preview = true;
        await callback();
        preview = false;
      },
      inventory: async (style) => assert.equal(style, calls.at(-1)),
      noDeparture: async (seat) => {
        assert.equal(preview, true);
        assert.equal(seat, 5);
      },
    }),
  );
  await inspect(17, 5);
  assert.deepEqual(calls, ["glass", "classic", "heritage", "noir", "classic"]);
});

test("departure paint oracle requires external names and rejects face names, unfaded material, double fades and dimmed public status", async () => {
  const { assertPlayerCardDeparturePaint } = await tsImport(
    "./verify-player-card-styles-ui.mjs",
    import.meta.url,
  );
  // Deliberate oracle inputs, NOT claimed actual-App/browser observations.
  for (const style of ["glass", "classic", "heritage", "noir"]) {
    for (const [cause, opacity] of [
      ["vote", 0.45],
      ["mafia", 0.6],
      ["discipline", 0.35],
      ["unknown", 0.65],
    ]) {
      const paint = {
        style,
        fade: opacity,
        opacity: 1,
        cardNames: 0,
        identity: [{ opacity: 1, visible: true }],
        status: [{ opacity: 1, visible: true }],
        material: [{ opacity }],
        opticalParentOpacity: 1,
        marks:
          cause === "mafia" ? [opacity, opacity, opacity] : cause === "discipline" ? [opacity] : [],
        pieces:
          cause === "vote"
            ? [
                { opacity, inner: [1] },
                { opacity, inner: [1] },
              ]
            : [],
      };
      assert.doesNotThrow(() => assertPlayerCardDeparturePaint(paint, cause, opacity));
      const reject = (mutate, message) => {
        const damaged = structuredClone(paint);
        mutate(damaged);
        assert.throws(() => assertPlayerCardDeparturePaint(damaged, cause, opacity), message);
      };
      reject((value) => {
        value.material[0].opacity = 1;
      }, /actual decorative material/i);
      reject((value) => {
        value.material[0].opacity = opacity * opacity;
      }, /exactly once/);
      reject((value) => {
        value.status[0].opacity = opacity;
      }, /identity\/status/);
      reject((value) => {
        value.status[0].visible = false;
      }, /remains painted/);
      reject((value) => {
        value.identity = [];
      }, /external public identity/i);
      reject((value) => {
        value.identity.push({ opacity: 1, visible: true });
      }, /external public identity/i);
      reject((value) => {
        value.cardNames = 1;
      }, /inside card faces/i);
      reject((value) => {
        value.identity[0].opacity = opacity;
      }, /identity\/status/i);
      reject((value) => {
        value.material = [];
      }, /actual paper or optical material/);
      reject((value) => {
        value.fade = 1;
      }, /persistent material fade/);
      if (style === "glass")
        reject((value) => {
          value.opticalParentOpacity = opacity;
        }, /second fade/);
      if (cause === "vote")
        reject((value) => {
          value.pieces[1].inner[0] = opacity;
        }, /second time/);
      if (paint.marks.length)
        reject((value) => {
          value.marks[0] = 1;
        }, /departure marks/);
    }
  }
});

test("printed host ownership oracle preserves real lighting overhang but rejects a stationary halo or second turn", async () => {
  const { assertPrintedTurnFrame } = await tsImport(
    "./verify-player-card-styles-ui.mjs",
    import.meta.url,
  );
  const frame = {
    tag: "BUTTON",
    hostTurns: 1,
    innerTurns: 0,
    caption: { visible: true, upright: true, opacity: 1 },
    layoutWidth: 100,
    box: { x: 150, y: 50, width: 10, height: 150 },
    lights: [
      { contained: true, layoutWidth: 100, box: { x: 150, y: 50, width: 10, height: 150 } },
      { contained: true, layoutWidth: 300, box: { x: 140, y: 10, width: 30, height: 230 } },
    ],
  };
  assert.doesNotThrow(() => assertPrintedTurnFrame(frame));
  for (const caption of [
    null,
    { visible: false, upright: true, opacity: 1 },
    { visible: true, upright: false, opacity: 1 },
    { visible: true, upright: true, opacity: 0.45 },
  ])
    assert.throws(() => assertPrintedTurnFrame({ ...frame, caption }), /external name/);
  assert.throws(() => assertPrintedTurnFrame({ ...frame, hostTurns: 0 }), /semantic host/);
  assert.throws(() => assertPrintedTurnFrame({ ...frame, innerTurns: 1 }), /second turn/);
  assert.throws(
    () => assertPrintedTurnFrame({ ...frame, lights: [] }),
    /existing dealt\/public lighting/,
  );
  assert.doesNotThrow(() =>
    assertPrintedTurnFrame({ ...frame, lights: [] }, { requireLighting: false }),
  );
  assert.throws(
    () =>
      assertPrintedTurnFrame({ ...frame, lights: [], innerTurns: 1 }, { requireLighting: false }),
    /second turn/,
  );
  assert.throws(
    () => assertPrintedTurnFrame({ ...frame, lights: [{ ...frame.lights[1], contained: false }] }),
    /turning native host/,
  );
  assert.throws(
    () =>
      assertPrintedTurnFrame({
        ...frame,
        lights: [{ ...frame.lights[1], box: { ...frame.lights[1].box, width: 300 } }],
      }),
    /upright full-width/,
  );
});

test("glow pixel sampling stays within each phase without the zero-width edge-on singularity", async () => {
  const { printedGlowSamplePose } = await tsImport(
    "./verify-player-card-styles-ui.mjs",
    import.meta.url,
  );
  for (const phase of ["lift", "front", "near-edge", "reverse"]) {
    const { minimumAngle, maximumAngle, targetAngle } = printedGlowSamplePose(phase);
    assert.ok(targetAngle > minimumAngle && targetAngle < maximumAngle);
    assert.ok(
      Math.abs(targetAngle - 90) >= 2,
      "A positive glow-pixel sample must not collapse the card to zero projected width",
    );
  }
});

test("glow pixel oracle needs visible differential paint and rejects an old-seat footprint without clipping overhang", async () => {
  const { assertPlayerCardGlowPixels } = await tsImport(
    "./verify-player-card-styles-ui.mjs",
    import.meta.url,
  );
  const image = () => ({ width: 300, height: 240, data: new Uint8Array(300 * 240 * 4) });
  const blank = image(),
    painted = image();
  const square = (target, left, top, width, height) => {
    for (let y = top; y < top + height; y++)
      for (let x = left; x < left + width; x++) target.data[(y * target.width + x) * 4 + 2] = 180;
  };
  const frame = {
    box: { x: 150, y: 70, width: 10, height: 150 },
    layoutWidth: 100,
    layoutHeight: 150,
    lights: [{ box: { x: 140, y: 50, width: 30, height: 190 } }],
  };
  square(painted, 143, 80, 5, 20); // Legitimate overhang beyond the card itself.
  assert.equal(assertPlayerCardGlowPixels(painted, blank, frame).outside, 0);
  assert.throws(() => assertPlayerCardGlowPixels(blank, blank, frame), /visible pixels/);
  square(painted, 80, 80, 20, 20);
  assert.throws(() => assertPlayerCardGlowPixels(painted, blank, frame), /old upright seat/);
});

test("real printed-turn probe observes native host/light geometry and immediate redaction without advancing any animation", () => {
  const source = readFileSync(
    new URL("./verify-player-card-styles-ui.mjs", import.meta.url),
    "utf8",
  );
  const tree = ts.createSourceFile("verifier.mjs", source, ts.ScriptTarget.Latest, true);
  let factory;
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "printedTurnProbe") {
      const find = (child) => {
        if (
          ts.isCallExpression(child) &&
          child.expression.getText(tree).endsWith(".evaluateHandle")
        )
          factory = child.arguments[0].getText(tree);
        ts.forEachChild(child, find);
      };
      find(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(factory, "Run the actual browser callback, not a second observer");
  let now = 0,
    queued,
    postFrame,
    cancelled = false,
    privateVisible = true;
  const rectangle = { x: 100, y: 50, width: 40, height: 150 };
  const glow = {
    className: "role-draw-glow",
    offsetWidth: 100,
    getBoundingClientRect: () => rectangle,
    getAttribute: () => null,
  };
  let moves = 0,
    captionAncestorOpacity = 1;
  const captionRoot = {};
  const captionNode = {
    textContent: "Player 1",
    parentElement: captionRoot,
    getBoundingClientRect: () => rectangle,
    checkVisibility: () => true,
  };
  const host = {
    parentElement: { querySelector: () => captionNode },
    tagName: "BUTTON",
    offsetWidth: 100,
    offsetHeight: 150,
    getBoundingClientRect: () => rectangle,
    contains: (node) => node === glow,
    matches: () => privateVisible,
    classList: { contains: () => false },
    querySelector: () => null,
    querySelectorAll: (selector) =>
      selector === ".printed-player-card__role,[data-role-glyph]"
        ? privateVisible
          ? [{}]
          : []
        : privateVisible
          ? [glow]
          : [],
    getAnimations: () => [
      {
        id: "printed-card-draw-7",
        startTime: 0,
        currentTime: 100,
        pending: false,
        pause: () => moves++,
        finish: () => moves++,
        effect: {
          target: host,
          getKeyframes: () => [{ rotate: "y 0deg" }, { rotate: "y 180deg" }],
        },
      },
    ],
  };
  const callback = runInContext(
    `(${factory})`,
    createContext({
      performance: { now: () => now, timeOrigin: 1000 },
      setTimeout: (next) => {
        postFrame = next;
        return 2;
      },
      requestAnimationFrame: (next) => {
        queued = next;
        return 1;
      },
      cancelAnimationFrame: () => {
        cancelled = true;
      },
      DOMMatrix: class {
        m11 = 1;
        m22 = 1;
        m12 = 0;
        m21 = 0;
      },
      getComputedStyle: (node) => ({
        transform: "none",
        scale: "none",
        rotate: "none",
        opacity: node === captionRoot ? String(captionAncestorOpacity) : "1",
        visibility: "visible",
        ...(node === host ? { rotate: "y 65deg" } : {}),
      }),
    }),
  );
  const probe = callback(host);
  queued();
  assert.equal(probe.rows.length, 0, "Do not sample before the shared renderer's frame callback");
  postFrame();
  assert.equal(probe.rows[0].hostTurns, 1);
  assert.equal(probe.rows[0].innerTurns, 0);
  assert.equal(probe.rows[0].lights[0].box.width, 40);
  assert.equal(probe.rows[0].privateGlows, 1);
  assert.equal(probe.rows[0].privateCanvases, 1);
  assert.equal(probe.rows[0].caption.upright, true, "A sibling does not inherit the host turn");
  assert.equal(probe.rows[0].caption.opacity, 1);
  captionAncestorOpacity = 0.5;
  assert.equal(
    probe.sample().caption.opacity,
    0.5,
    "Follow actual caption ancestors beyond the card",
  );
  captionAncestorOpacity = 1;
  privateVisible = false;
  const immediate = probe.sample();
  assert.equal(immediate.privateNodes, 0);
  assert.equal(immediate.privateCues, false);
  assert.equal(immediate.privateGlows, 0);
  assert.equal(immediate.privateCanvases, 0);
  assert.equal(moves, 0, "Probe does not pause, finish or seek the native action");
  now = 1501;
  queued();
  postFrame();
  const count = probe.rows.length;
  queued();
  postFrame();
  assert.equal(probe.rows.length, count, "Natural observation has a finite lifetime");
  probe.stop();
  assert.equal(cancelled, true);
});

test("paired freeze ignores only already-cancelled unrelated CSS transitions", () => {
  const source = readFileSync(
    new URL("./verify-player-card-styles-ui.mjs", import.meta.url),
    "utf8",
  );
  const tree = ts.createSourceFile("verifier.mjs", source, ts.ScriptTarget.Latest, true);
  let callback;
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "animation.ready.catch") {
      callback = node.arguments[0].getText(tree);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(callback, "Exercise the actual browser readiness handler");
  const cancelled = {
    id: "",
    constructor: { name: "CSSTransition" },
    transitionProperty: "color",
    effect: { target: { tagName: "BUTTON", getAttribute: () => "save-indicator" } },
    playState: "idle",
    currentTime: null,
  };
  const reject = (overrides = {}, error = "AbortError") =>
    runInContext(
      `(${callback})`,
      createContext({
        animation: { ...cancelled, ...overrides },
        turn: { id: "printed-card-draw-1" },
      }),
    )({ name: error });
  assert.doesNotThrow(() => reject());
  for (const overrides of [
    { id: "printed-card-draw-1" },
    { constructor: { name: "Animation" } },
    { playState: "paused" },
    { currentTime: 20 },
  ]) {
    assert.throws(() => reject(overrides), /Cannot freeze native animation/);
  }
  assert.throws(() => reject({}, "TypeError"), /Cannot freeze native animation/);
});

test("H3 keeps passive natural traces separate from paired pixels and uses all printed styles with accepted real draws", () => {
  const source = readFileSync(
    new URL("./verify-player-card-styles-ui.mjs", import.meta.url),
    "utf8",
  );
  const tree = ts.createSourceFile(
    "player-card-verifier.mjs",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const functions = new Map();
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name)
      functions.set(node.name.text, node.getText(tree));
    ts.forEachChild(node, visit);
  }
  visit(tree);
  const natural = functions.get("naturalPrintedTurn");
  const sampled = functions.get("sampledPrintedGlow");
  assert.match(natural, /tracing\.start\(\{\s*screenshots: true,\s*snapshots: true/);
  assert.match(natural, /\["lift"/);
  for (const phase of ["front", "near-edge", "reverse"]) assert.ok(natural.includes(`"${phase}"`));
  assert.doesNotMatch(natural, /\.pause\(|\.finish\(|currentTime\s*=/);
  assert.match(natural, /immediate\.privateNodes,\s*0/);
  assert.match(natural, /immediate\.privateCues,\s*false/);
  assert.match(natural, /immediate\.privateGlows,\s*0/);
  assert.match(natural, /immediate\.privateCanvases,\s*0/);
  assert.match(natural, /initial\.privateCues,\s*true/);
  assert.match(source, /"privacy-opening-boundary"/);
  assert.match(natural, /domain\.advanceOpeningPhase\(before\.game\)/);
  assert.match(sampled, /animation\.pause\(\)/);
  assert.match(sampled, /animation\.currentTime = time/);
  assert.match(sampled, /turn\.effect\.getTiming\(\)\.duration/);
  assert.doesNotMatch(sampled, /clearTimeout\(|setTimeout\s*=|performance\.now\s*=/);
  assert.ok(sampled.indexOf("pendingPose = await") < sampled.indexOf("await action()"));
  assert.ok(
    sampled.indexOf("await action()") < sampled.indexOf("await pendingPose.evaluateHandle"),
  );
  assert.ok(
    natural.indexOf("await writeFile(") > natural.indexOf("} finally {"),
    "Retain failed natural rows too",
  );
  assert.match(sampled, /assertPlayerCardGlowPixels\(painted, unlit, frame\)/);
  assert.match(sampled, /Math\.abs\(frame\.angle - after\.angle\)/);
  assert.match(source, /for \(const style of styles\.filter\(\(value\) => value !== "glass"\)\)/);
  assert.match(source, /blueprint = domain\.drawRoleForSeat\(blueprint, seat\)/);
  assert.match(source, /naturalPrintedTurn\(\s*style,\s*seat,\s*`deal-\$\{colour\}`/);
  assert.match(source, /naturalPrintedTurn\(\s*style,\s*firstSeat,\s*"reroll"/);
  assert.match(source, /naturalPrintedTurn\(\s*style,\s*speaker,\s*"privacy-interruption"/);
  assert.match(
    source,
    /reloadWithoutFeedback\(\),\s*before,\s*"Each deck restores the exact accepted history"/,
  );
});

test("player-card source manifest includes App, presentation preferences and all replaceable deck assets", async () => {
  const { playerCardSourceManifest } = await tsImport(
    "./verify-player-card-styles-ui.mjs",
    import.meta.url,
  );
  const manifest = await playerCardSourceManifest();
  for (const file of [
    "apps/web/src/App.tsx",
    "scripts/verify-player-card-styles-ui.mjs",
    "scripts/ui-presentation-contracts.mjs",
    "scripts/ui-presentation-contracts.test.mjs",
    "scripts/verify-federation-ui.mjs",
    "scripts/session-verifier-contracts.mjs",
    "apps/web/src/features/table/GameTable.tsx",
    "apps/web/src/features/game/PlayerExitProvider.tsx",
    "apps/web/src/features/game/player-action-presentation.ts",
    "apps/web/src/features/effects/player-exit-preferences.ts",
    "apps/web/src/features/effects/player-departure-timeline.ts",
    "apps/web/src/features/effects/player-tear-geometry.ts",
    "apps/web/src/features/effects/lighting-preferences.ts",
    "apps/web/src/features/effects/vgpu/VgpuLightingCanvas.tsx",
    "apps/web/src/features/theme/GlassScene.tsx",
    "apps/web/src/features/theme/glass-renderer.ts",
    "apps/web/src/features/theme/LiquidCardGlass.css",
    "apps/web/src/features/table/PrintedPlayerCard.tsx",
    "apps/web/src/features/table/PrintedPlayerCard.css",
    "apps/web/src/features/table/PlayerDepartureEffects.tsx",
    "apps/web/src/features/table/PlayerDepartureEffects.css",
    "apps/web/src/features/table/RoleDrawPresentation.tsx",
    "apps/web/src/features/table/RoleDrawPresentation.css",
    "apps/web/src/features/theme/player-card-preferences.ts",
    "apps/web/src/features/table/card-decks.ts",
  ])
    assert.match(manifest[file], /^[a-f\d]{64}$/);
  const assets = Object.keys(manifest).filter(
    (file) => file.startsWith("apps/web/src/assets/player-cards/") && file.endsWith(".svg"),
  );
  assert.equal(assets.length, 33);
  for (const style of ["classic", "heritage", "noir"]) {
    const faces = assets.filter((file) => file.includes(`/${style}/face-`));
    assert.equal(faces.length, 10);
    assert.equal(
      new Set(faces.map((file) => manifest[file])).size,
      10,
      "Distinct replaceable face bytes",
    );
    assert.equal(assets.filter((file) => file.endsWith(`/${style}/back.svg`)).length, 1);
  }
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
  for (const mode of [
    "SIDE_PANEL",
    "MUSIC",
    "LAYOUT",
    "RULES_SKETCHBOOK",
    "FEDERATION",
    "FANCY_FEATURES",
  ]) {
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

test("card privacy oracle exempts only exact host night-target actions, never role leaks", async () => {
  const { playerCardRoleContent } = await tsImport(
    "./verify-player-card-styles-ui.mjs",
    import.meta.url,
  );
  const action = "Assign all Mafia shots to Player 2";
  const row = { text: "Player 2", attrs: [["aria-label", action, true]] };
  assert.equal(playerCardRoleContent(row, [action]), "Player 2");
  assert.match(playerCardRoleContent(row), /Mafia/);
  for (const attrs of [
    [["aria-label", action, false]],
    [["aria-label", "mafia", true]],
    [["data-role", action, true]],
    [["aria-label", `${action} — mafia`, true]],
  ])
    assert.match(playerCardRoleContent({ ...row, attrs }, [action]), /mafia/i);
  assert.match(playerCardRoleContent({ ...row, text: "Player 2 mafia" }, [action]), /mafia/);
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
