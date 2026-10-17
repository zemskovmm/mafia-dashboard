import { describe, expect, expectTypeOf, it } from "vitest";
import * as domain from "./index.js";

const players = Array.from({ length: 10 }, (_, i) => ({ id: `player-${i + 1}`, seat: i + 1 }));
const setup = () => {
  let state = domain.beginRoleDraw(domain.createSetup(players), domain.createSeededRandom(41));
  for (const { seat } of players) state = domain.drawRoleForSeat(state, seat);
  return domain.completeRoleDraw(state);
};

describe("one current canonical representation", () => {
  it("emits shape version 3 and replays JSON without engine metadata", () => {
    const game = domain.createGame(setup());
    const baseline = domain.createInitialGameBaseline(game);
    const accepted = domain.createGameLogEntry({
      gameId: "current-game",
      id: "root",
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-10-16T12:00:00Z",
      before: game,
      draft: { type: "game.started", payload: {} },
    });
    expect(domain.CURRENT_REPLAY_VERSION).toBe(3);
    expect(baseline).toEqual({ replayVersion: 3, game });
    expect(accepted.entry.replayVersion).toBe(3);
    expect(accepted.entry).not.toHaveProperty("rulesEdition");
    const replay = domain.replayGameLog(
      JSON.parse(JSON.stringify(baseline)),
      JSON.parse(JSON.stringify([accepted.entry])),
      "current-game",
    );
    expect(replay.game).toEqual(JSON.parse(JSON.stringify(game)));
    expect(domain.hashGameState(replay.game)).toBe(accepted.entry.stateHashAfter);
    expect(() =>
      domain.assertCanonicalGameEventDraft({
        type: "discipline.removals-announced",
        payload: { seats: [1] },
      }),
    ).not.toThrow();
  });
});

describe("one current gameplay contract", () => {
  it("exposes no engine selection or legacy draw/replay API", () => {
    expectTypeOf<
      Pick<
        domain.GameState,
        | "completedGameNights"
        | "sheriffChecksPerformed"
        | "firstDayDepartureSeats"
        | "currentSpeechRestricted"
      >
    >().toEqualTypeOf<{
      readonly completedGameNights: number;
      readonly sheriffChecksPerformed: number;
      readonly firstDayDepartureSeats: readonly number[];
      readonly currentSpeechRestricted: boolean;
    }>();
    const retired = [
      "FEDERATION_RULES_EDITION",
      "RulesEdition",
      "assertRulesEdition",
      "isFederationGame",
      "LEGACY_REPLAY_VERSION",
      "FEDERATION_REPLAY_VERSION",
      "getGameReplayVersion",
      "shouldSuggestDraw",
      "skipVoting",
    ];
    for (const name of retired) expect(domain).not.toHaveProperty(name);
    // Compile-time boundary: no accepted-but-ignored engine selector remains.
    const assertNoEngineSelector = () => {
      // @ts-expect-error setup has no edition argument
      domain.createSetup(players, { rulesEdition: "mafgame-2026-07-01" });
      // @ts-expect-error game options have no engine selector
      domain.createGame(setup(), { rulesEdition: "mafgame-2026-07-01" });
      // @ts-expect-error canonical validation has no version dispatch argument
      domain.assertCanonicalGameEventDraft({ type: "game.started", payload: {} }, 3);
    };
    expect(assertNoEngineSelector).toBeTypeOf("function");
  });
  it("creates the current opening without an engine selector by default", () => {
    const dealt = setup();
    const game = domain.createGame(dealt, { bestMoveEnabled: false });
    expect(dealt).not.toHaveProperty("rulesEdition");
    expect(game).not.toHaveProperty("rulesEdition");
    expect(game).not.toHaveProperty("skipCasperBestMove");
    expect(domain.isCanonicalGameEventType("voting.skipped")).toBe(false);
    expect(domain.isCanonicalGameEventType("best-move.completed")).toBe(false);
    expect(domain.isCanonicalGameEventType("player.red-carded")).toBe(false);
    expect(game.completedGameNights).toBe(0);
    expect(game.sheriffChecksPerformed).toBe(0);
    expect(game.firstDayDepartureSeats).toEqual([]);
    expect(game.currentSpeechRestricted).toBe(false);
    expect(game.bestMoveEnabled).toBe(false);
    const greeting = domain.advanceOpeningPhase(game);
    expect(greeting.phase).toBe("sheriff-identification");
    const day = domain.advanceOpeningPhase(greeting);
    expect(day.phase).toBe("day");
    expect(day.day).toBe(1);
    expect(day.completedGameNights).toBe(1);
    expect(domain.getCurrentTurnDuration(day)).toBe(60);
  });
});
