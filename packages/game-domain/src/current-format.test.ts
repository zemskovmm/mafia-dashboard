import { describe, expect, it } from "vitest";
import * as domain from "./index.js";
import type { GameLogEntry, GameState, InitialGameBaseline } from "./index.js";

const initial = (): GameState => {
  const players = Array.from({ length: 10 }, (_, index) => ({
    id: `p${index + 1}`,
    seat: index + 1,
  }));
  let setup = domain.beginRoleDraw(domain.createSetup(players), domain.createSeededRandom(71));
  for (const { seat } of players) setup = domain.drawRoleForSeat(setup, seat);
  return domain.createGame(domain.completeRoleDraw(setup));
};
const history = () => {
  const game = initial();
  const baseline = domain.createInitialGameBaseline(game);
  const root = domain.createGameLogEntry({
    gameId: "current-game",
    id: "root",
    sequence: 1,
    parentEventId: null,
    createdAt: "2026-10-16T12:00:00Z",
    before: game,
    draft: { type: "game.started", payload: {} },
  });
  const next = domain.createGameLogEntry({
    gameId: "current-game",
    id: "next",
    sequence: 2,
    parentEventId: "root",
    createdAt: "2026-10-16T12:01:00Z",
    before: root.after,
    draft: { type: "phase.changed", payload: { to: "sheriff-identification" } },
  });
  return { game, baseline, root: root.entry, next: next.entry };
};

describe("closed current canonical shape and integrity", () => {
  it.each([1, 2, 4, 0, "3", null, undefined])(
    "rejects unsupported serialization version %j without mutation",
    (replayVersion) => {
      const { baseline, root } = history();
      const badBaseline = { ...baseline, replayVersion } as unknown as InitialGameBaseline;
      const badEntry = { ...root, replayVersion } as unknown as GameLogEntry;
      const bytes = JSON.stringify([badBaseline, badEntry]);
      expect(() => domain.replayGameLog(badBaseline, [])).toThrow(/version/i);
      expect(() => domain.assertGameLogEntry(badEntry)).toThrow(/version/i);
      expect(() => domain.replayGameLog(baseline, [badEntry])).toThrow(
        expect.objectContaining({ diagnostic: { code: "history.invalid_event", replayIndex: 0 } }),
      );
      expect(JSON.stringify([badBaseline, badEntry])).toBe(bytes);
    },
  );
  it.each(["rulesEdition", "rulesetId", "rulesetVersion", "ignored"])(
    "rejects removed or foreign field %s at every persisted boundary",
    (field) => {
      const { game, baseline, root } = history();
      for (const value of [undefined, null, "mafgame-2026-07-01"]) {
        expect(() =>
          domain.replayGameLog({ ...baseline, [field]: value } as InitialGameBaseline, []),
        ).toThrow();
        expect(() => domain.assertGameLogEntry({ ...root, [field]: value })).toThrow();
        const state = { ...game, [field]: value };
        expect(() => domain.createInitialGameBaseline(state)).toThrow();
        expect(
          domain.tryApplyGameEvent(state, { type: "game.started", payload: {} }),
        ).toMatchObject({ ok: false });
      }
    },
  );
  it.each([
    { completedGameNights: undefined },
    { sheriffChecksPerformed: -1 },
    { firstDayDepartureSeats: [1, 1] },
    { currentSpeechRestricted: "yes" },
    { skipCasperBestMove: true },
    { phase: "sheriff-wake" },
    { day: -1 },
    { winner: "red" },
  ])("rejects malformed current state %j without filling defaults", (change) => {
    const { game, baseline } = history();
    const bad = { ...game, ...change } as unknown as GameState;
    expect(() => domain.createInitialGameBaseline(bad)).toThrow();
    expect(() => domain.replayGameLog({ ...baseline, game: bad }, [])).toThrow();
  });
  it("rejects profile names, role-deck corruption, foreign payload fields and unknown types", () => {
    const { game, baseline, root } = history();
    const named = { ...game, players: game.players.map((p) => ({ ...p, name: "Copied name" })) };
    const wrongDeck = {
      ...game,
      players: game.players.map((p) => ({ ...p, role: "citizen", team: "red" })),
    } as GameState;
    for (const state of [named, wrongDeck])
      expect(() => domain.createInitialGameBaseline(state)).toThrow();
    expect(() => domain.assertGameLogEntry({ ...root, payload: { ignored: true } })).toThrow();
    expect(() => domain.assertGameLogEntry({ ...root, type: "future-action" })).toThrow();
    expect(() => domain.replayGameLog({ ...baseline, game: named }, [])).toThrow(/unexpected name/);
  });
  it.each([
    { sequence: 1 },
    { parentEventId: "foreign" },
    { gameId: "foreign" },
    { phaseBefore: "day" },
    { dayBefore: 1 },
    { phaseAfter: "day" },
    { dayAfter: 1 },
    { stateHashAfter: `sha256:${"0".repeat(64)}` },
  ])("rejects a forged chain link %j", (change) => {
    const { baseline, root, next } = history();
    expect(() =>
      domain.replayGameLog(
        baseline,
        [root, { ...next, ...change } as GameLogEntry],
        "current-game",
      ),
    ).toThrow();
  });
  it("enforces duplicate identity, lifecycle root and root parent", () => {
    const { game, baseline, root } = history();
    expect(() => domain.replayGameLog(baseline, [root, root])).toThrow(/lifecycle|duplicate/i);
    expect(() => domain.replayGameLog(baseline, [{ ...root, parentEventId: "foreign" }])).toThrow(
      /parent/i,
    );
    expect(() =>
      domain.replayGameLog(baseline, [
        { ...root, type: "phase.changed", payload: { to: "sheriff-identification" } },
      ]),
    ).toThrow();
    expect(domain.replayGameLog(baseline, []).game).toBe(game);
  });
  it.each(["voting", "car-crash"] as const)(
    "rejects a %s checkpoint whose speaker order contradicts its candidates",
    (phase) => {
      const game = domain.advanceOpeningPhase(domain.advanceOpeningPhase(initial()));
      const malformed: GameState = {
        ...game,
        phase,
        nominations: [
          { nominatorSeat: 1, candidateSeat: 4, order: 1 },
          { nominatorSeat: 2, candidateSeat: 6, order: 2 },
        ],
        turnOrder: [4, 8],
        currentTurnIndex: 0,
        ballot: domain.createFederationBallot(4),
        votingRound: phase === "voting" ? "initial" : "repeat",
        ...(phase === "car-crash" ? { carCrashSeats: [4, 6] } : {}),
      };
      expect(() => domain.createInitialGameBaseline(malformed)).toThrow(
        /order|voting phase fields/i,
      );
      expect(
        domain.tryApplyGameEvent(malformed, {
          type: "foul.issued",
          payload: { seat: 1, foulNumber: 1, redCarded: false },
        }),
      ).toMatchObject({ ok: false });
    },
  );
  it("matches an independent SHA-256 implementation on canonical JSON and ignores key insertion order", async () => {
    const game = initial();
    const canonical = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(canonical)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .filter(([, item]) => item !== undefined)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([key, item]) => [key, canonical(item)]),
            )
          : value;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(canonical(game))),
    );
    const expected = `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    expect(domain.hashGameState(game)).toBe(expected);
    expect(
      domain.hashGameState(
        Object.fromEntries(Object.entries(game).reverse()) as unknown as GameState,
      ),
    ).toBe(expected);
    expect(domain.hashGameState(JSON.parse(JSON.stringify(game)))).toBe(expected);
  });
});
