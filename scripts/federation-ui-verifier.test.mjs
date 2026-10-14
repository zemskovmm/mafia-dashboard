import assert from "node:assert/strict";
import { test } from "node:test";
import { tsImport } from "tsx/esm/api";

const { checkpoint, legacySetupState } = await tsImport(
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
    domain.createSetup(
      Array.from({ length: 10 }, (_, i) => ({ id: `p${i + 1}`, seat: i + 1 })),
      { rulesEdition: domain.FEDERATION_RULES_EDITION },
    ),
    domain.createSeededRandom(71),
  );
  for (let seat = 1; seat <= 10; seat++) setup = domain.drawRoleForSeat(setup, seat);
  return domain.createGame(domain.completeRoleDraw(setup));
}

test("restored legacy draft is admitted without changing the fresh rules policy", () => {
  const state = legacySetupState();
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

test("browser preconditions are v2 canonical roots with actual domain hashes", () => {
  const game = opening();
  const state = checkpoint(game, { ...legacySetupState(), setup: null }, id);
  assert.equal(state.initialGame.replayVersion, 2);
  assert.equal(state.initialGame.rulesEdition, domain.FEDERATION_RULES_EDITION);
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
    ...legacySetupState(),
    setup: {
      step: "roles",
      rulesEdition: domain.FEDERATION_RULES_EDITION,
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

test("corrupted browser root hashes and unsupported v2 fields fail closed", () => {
  const state = checkpoint(opening(), { ...legacySetupState(), setup: null }, id);
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
