import test from "node:test";
import assert from "node:assert/strict";
import { tsImport } from "tsx/esm/api";
import { resolveUiMode } from "./ui-presentation-contracts.mjs";
const { ledgerHistoryFixture, ledgerPhaseFixtures } = await tsImport(
  "./verify-ledger-ui.mjs",
  import.meta.url,
);

test("ledger browser fixture replays its real multi-day prefix with supplied identities", () => {
  const players = Array.from({ length: 11 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
  }));
  const state = ledgerHistoryFixture(players, "00000000-0000-4000-8000-000000000909");
  assert.equal(state.game.day, 3);
  assert.equal(state.game.phase, "day");
  assert.deepEqual(
    state.game.players.map((player) => player.id),
    players.slice(0, 10).map((player) => player.id),
  );
  assert.ok(state.events.some((entry) => entry.type === "don.checked"));
  assert.ok(state.events.some((entry) => entry.type === "voting.resolved"));
  assert.equal(state.events.at(-1).id, state.headEventId);
});

test("ledger long-game fixture reaches the fifth pair through replayable accepted rounds", () => {
  const players = Array.from({ length: 11 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
  }));
  const state = ledgerHistoryFixture(players, "00000000-0000-4000-8000-000000000909", 5);
  assert.equal(state.game.day, 5);
  assert.equal(state.game.phase, "day");
  assert.equal(state.events.at(-1).type, "phase.changed");
  assert.equal(state.events.at(-1).payload.to, "day");
  assert.equal(state.events.at(-1).id, state.headEventId);
  assert.ok(state.events.slice(-12).every(({ type }) => type !== "game.checkpointed"));
  assert.ok(state.game.players.some(({ status }) => status === "active"));
});

test("ledger browser mode is explicit and conflicting selectors fail closed", () => {
  assert.equal(resolveUiMode({ UI_LEDGER_ONLY: "1" }), "ledger");
  assert.equal(resolveUiMode({ UI_LEDGER_ONLY: "0" }), "default");
  assert.throws(() => resolveUiMode({ UI_LEDGER_ONLY: "yes" }), /must be 0 or 1/);
  assert.throws(() => resolveUiMode({ UI_LEDGER_ONLY: "1", UI_HEADER_ONLY: "1" }), /Conflicting/);
});

test("ledger sidebar fixtures cover real phase states including collective correction and outcomes", () => {
  const players = Array.from({ length: 11 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
  }));
  const fixtures = ledgerPhaseFixtures(players, "00000000-0000-4000-8000-000000000909");
  assert.deepEqual(
    fixtures.map(({ game }) => game.phase),
    [
      "mafia-planning",
      "voting",
      "car-crash-decision",
      "best-move",
      "night-don",
      "night-sheriff",
      "goodbye-speech",
      "finished",
    ],
  );
  for (const state of fixtures) {
    assert.equal(state.events.length, 1);
    assert.equal(state.events[0].type, "game.checkpointed");
    assert.equal(state.events[0].id, state.headEventId);
  }
});
