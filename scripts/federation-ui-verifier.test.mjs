/* global URL, structuredClone */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { tsImport } from "tsx/esm/api";

const { checkpoint, currentSetupState } = await tsImport(
  "./verify-federation-ui.mjs",
  import.meta.url,
);
const domain = await tsImport("../packages/game-domain/src/index.ts", import.meta.url);
const { isCurrentGameSessionState } = await tsImport(
  "../apps/web/src/session-outbox.ts",
  import.meta.url,
);
const id = "00000000-0000-4000-8000-000000000301";
function opening() {
  let setup = domain.beginRoleDraw(
    domain.createSetup(Array.from({ length: 10 }, (_, i) => ({ id: `p${i + 1}`, seat: i + 1 }))),
    domain.createSeededRandom(71),
  );
  for (let seat = 1; seat <= 10; seat++) setup = domain.drawRoleForSeat(setup, seat);
  return domain.createGame(domain.completeRoleDraw(setup));
}

test("current setup draft is admitted without selecting a gameplay engine", () => {
  const state = currentSetupState();
  assert.equal(state.playlistId, "");
  assert.equal(state.setup.rulesEdition, undefined);
  assert.equal(state.initialGame, null);
  assert.equal(state.game, null);
  assert.deepEqual(state.events, []);
  assert.equal(isCurrentGameSessionState(state), true);
  assert.equal(
    domain.createSetup(Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, seat: i + 1 })))
      .rulesEdition,
    undefined,
  );
});

test("browser preconditions are v3 canonical roots with actual domain hashes", () => {
  const game = opening();
  const state = checkpoint(game, { ...currentSetupState(), setup: null }, id);
  assert.equal(state.initialGame.replayVersion, 3);
  assert.equal(Object.hasOwn(state.initialGame, "rulesEdition"), false);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].type, "game.checkpointed");
  assert.equal(state.events[0].parentEventId, null);
  assert.equal(state.events[0].gameId, id);
  assert.equal(state.events[0].stateHashAfter, domain.hashGameState(game));
  assert.equal(isCurrentGameSessionState(state), true);
  assert.equal(
    domain.hashGameState(domain.replayGameLog(state.initialGame, state.events, id).game),
    domain.hashGameState(state.game),
  );
});

test("night checkpoint establishes only a precondition, never a Best Move outcome", () => {
  let game = opening();
  while (game.phase !== "day") game = domain.advanceSetupPhase(game);
  game = domain.beginNight(game);
  const template = {
    ...currentSetupState(),
    setup: {
      step: "roles",
      selectedPlayerIds: game.players.map((p) => p.id),
      setup: null,
    },
  };
  const state = checkpoint(game, template, id);
  assert.equal(state.game.phase, "night-mafia");
  assert.equal(state.game.bestMove, undefined);
  assert.equal(state.game.winner, null);
  assert.deepEqual(state.game.shotAssignments, {});
  assert.equal(isCurrentGameSessionState(state), true);
});

test("corrupted browser root hashes and foreign fields fail closed", () => {
  const state = checkpoint(opening(), { ...currentSetupState(), setup: null }, id);
  assert.throws(() =>
    domain.replayGameLog(
      state.initialGame,
      [{ ...state.events[0], stateHashAfter: `sha256:${"0".repeat(64)}` }],
      id,
    ),
  );
  const invalid = { ...state.game, sheriffChecksPerformed: -1 };
  assert.throws(() => checkpoint(invalid, state, id));
});

test("rules browser mode is opt-in and leaves existing runner modes reachable", async () => {
  const runner = await readFile(new URL("./verify-ui.mjs", import.meta.url), "utf8");
  assert.match(
    runner,
    /const rulesSketchbookOnly = process\.env\.UI_RULES_SKETCHBOOK_ONLY === "1"/,
  );
  assert.match(
    runner,
    /if \(rulesSketchbookOnly\) \{[\s\S]*?tsImport\([\s\S]*?verify-rules-sketchbook-ui\.mjs/,
  );
  for (const mode of ["federationOnly", "headerOnly", "hardeningOnly", "musicOnly", "layoutOnly"]) {
    assert.ok(runner.includes(`if (${mode})`), `${mode} remains reachable`);
  }
  assert.match(runner, /api: federationApi/);
  assert.match(
    runner,
    /assertNoPageErrors\(\);[\s\S]*?Rules sketchbook integrated verification: PASS/,
  );
});

test("rules coverage gate rejects missing, duplicate or mislabeled real destinations", async () => {
  const { assertRulesCoverage } = await tsImport(
    "./verify-rules-sketchbook-ui.mjs",
    import.meta.url,
  );
  const { rulesChapters } = await tsImport(
    "../apps/web/src/features/rules/rules-content.ts",
    import.meta.url,
  );
  const { ruleReferenceIds } = await tsImport(
    "../apps/web/src/features/rules/rule-references.ts",
    import.meta.url,
  );
  const report = { destinations: [], references: [] };
  for (const locale of ["en", "ru"]) {
    report.destinations.push(...rulesChapters.map(({ id }) => ({ locale, id })));
    report.references.push(...ruleReferenceIds.map((id) => ({ locale, id, forced: false })), {
      locale,
      id: "6.2.1",
      forced: true,
    });
  }
  assert.doesNotThrow(() => assertRulesCoverage(report));
  const missing = structuredClone(report);
  missing.destinations.pop();
  assert.throws(() => assertRulesCoverage(missing));
  const duplicate = structuredClone(report);
  duplicate.destinations[0].id = duplicate.destinations[1].id;
  assert.throws(() => assertRulesCoverage(duplicate));
  const wrongReference = structuredClone(report);
  wrongReference.references.find((r) => r.id === "6.2.12").id = "6.2.11";
  assert.throws(() => assertRulesCoverage(wrongReference));
  const missingForced = structuredClone(report);
  missingForced.references = missingForced.references.filter((r) => !r.forced);
  assert.throws(() => assertRulesCoverage(missingForced));
  const narrow = { ...structuredClone(report), viewport: { width: 390, height: 844 } };
  assert.throws(
    () => assertRulesCoverage(narrow),
    "Narrow coverage cannot silently skip keyboard traversal",
  );
  narrow.keyboardTraversal = ["en", "ru"].map((locale) => ({
    locale,
    rows: [
      ...Array.from({ length: 28 }, (_, i) => i),
      ...Array.from({ length: 28 }, (_, i) => 27 - i),
    ].map((index) => ({ index, inside: true })),
  }));
  assert.doesNotThrow(() => assertRulesCoverage(narrow));
  narrow.keyboardTraversal[1].rows[20].inside = false;
  assert.throws(
    () => assertRulesCoverage(narrow),
    "Focus containment alone does not prove a clipped entry is visible",
  );
});

test("federation gameplay scenarios route penalties through real player input, not header Rules", async () => {
  const source = await readFile(new URL("./verify-federation-ui.mjs", import.meta.url), "utf8");
  assert.ok(!source.includes('name: "Rules", exact: true'), "No old header penalty opener");
  assert.ok(!source.includes("Rule help (unavailable)"));
  assert.match(source, /page\.mouse\.down\(\)/);
  assert.match(source, /Input\.dispatchTouchEvent/);
  assert.match(source, /Shift\+F10/);
  assert.ok(
    !source.includes('input: "keyboard"'),
    "Removed authored keyboard menu route must not be used",
  );
  assert.ok(!source.includes("toBeFocused()"), "No app-owned modal return-focus requirement");
  assert.match(source, /Retired keys emit no event/);
  assert.match(source, /Native dialog Escape cancellation/);
  assert.match(source, /openPlayerPenalty\(page, reviewSeat/);
  assert.doesNotMatch(source, /shortcut: false|table-swipe-menu button/);
  assert.match(source, /Final ruling reason[\s\S]*?toHaveValue/);
  assert.match(source, /I reviewed the external recording[\s\S]*?toBeChecked/);
  assert.match(source, /rule-only-removal-\$\{locale\}/);
  assert.match(source, /post-result-victim-shooter-swipe-save-reload-replay/);
  assert.match(source, /assert\.equal\(row\.scenarios\.length, 12 \+ 3\)/);
});
