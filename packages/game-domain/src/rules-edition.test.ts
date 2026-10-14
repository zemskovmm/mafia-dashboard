import { describe, expect, it } from "vitest";
import * as domain from "./index.js";
import {
  assignRoleForSeat,
  beginRoleDraw,
  completeRoleDraw,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
  rerollRoleForSeat,
} from "./setup.js";
import { advanceSetupPhase, createGame } from "./game.js";
import {
  applyCurrentGameLogEntry,
  createGameLogEntry,
  hashGameState,
  replayGameLog,
  type GameLogEntry,
  type InitialGameBaseline,
  type ReplayVersion,
} from "./game-events.js";
import type { GameState } from "./types.js";

const edition = "mafgame-2026-07-01" as const;
const players = Array.from({ length: 10 }, (_, index) => ({
  id: `player-${index + 1}`,
  seat: index + 1,
}));

const completedSetup = (rulesEdition?: typeof edition) => {
  let state = beginRoleDraw(createSetup(players, { rulesEdition }), createSeededRandom(41));
  for (let seat = 1; seat <= 10; seat += 1) state = drawRoleForSeat(state, seat);
  return completeRoleDraw(state);
};

describe("rules edition capture", () => {
  it("retains an explicitly captured edition through role redraw and game creation", () => {
    const initial = createSetup(players, { rulesEdition: edition });
    expect(initial).toHaveProperty("rulesEdition", edition);
    let drawing = beginRoleDraw(initial, createSeededRandom(41));
    drawing = drawRoleForSeat(drawing, 1);
    drawing = rerollRoleForSeat(drawing, 1, () => 0);
    drawing = assignRoleForSeat(drawing, 1, drawing.remainingRoles[0]!);
    drawing = beginRoleDraw(drawing, createSeededRandom(42));
    for (let seat = 1; seat <= 10; seat += 1) drawing = drawRoleForSeat(drawing, seat);
    const game = createGame(completeRoleDraw(drawing), { bestMoveEnabled: false });
    expect(game).toHaveProperty("rulesEdition", edition);
    expect(advanceSetupPhase(game)).toHaveProperty("rulesEdition", edition);
    expect(game.bestMoveEnabled).toBe(false);
    expect(domain.FEDERATION_RULES_EDITION).toBe(edition);
    expect(domain.isFederationGame(game)).toBe(true);
    expect(domain.isFederationGame(createGame(completedSetup()))).toBe(false);
    expect(createGame(completedSetup())).not.toHaveProperty("rulesEdition");
    expect(createSetup(players)).not.toHaveProperty("rulesEdition");
  });

  it("allows an explicit game-creation edition without relabeling its setup", () => {
    const setup = completedSetup();
    const bytes = JSON.stringify(setup);
    expect(createGame(setup, { rulesEdition: edition })).toHaveProperty("rulesEdition", edition);
    expect(JSON.stringify(setup)).toBe(bytes);
    expect(createGame(completedSetup(edition), { rulesEdition: edition }).rulesEdition).toBe(
      edition,
    );
  });

  it.each(["unknown", "", null, 1, {}])("rejects unsupported setup/game edition %j", (invalid) => {
    const rulesEdition = invalid as typeof edition;
    expect(() => createSetup(players, { rulesEdition })).toThrow(/rules edition/i);
    expect(() => createGame(completedSetup(), { rulesEdition })).toThrow(/rules edition/i);
    const forged = { ...completedSetup(edition), rulesEdition };
    expect(() => createGame(forged, { rulesEdition: edition })).toThrow(/rules edition/i);
    expect(() => completeRoleDraw(forged)).toThrow(/rules edition/i);
  });

  it("derives a v2 replay chain from the captured state edition", () => {
    const game = createGame(completedSetup(edition));
    const beforeBytes = JSON.stringify(game);
    const root = createGameLogEntry({
      gameId: "federation-game",
      id: "root",
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-10-14T10:00:00.000Z",
      before: game,
      draft: { type: "game.started", payload: {} },
    });
    expect(root.entry).toMatchObject({ replayVersion: 2, rulesEdition: edition });
    const next = createGameLogEntry({
      gameId: "federation-game",
      id: "next",
      sequence: 2,
      parentEventId: root.entry.id,
      createdAt: "2026-10-14T10:01:00.000Z",
      before: root.after,
      draft: { type: "phase.changed", payload: { to: "mafia-sleep" } },
    });
    const baseline = domain.createInitialGameBaseline(game);
    expect(baseline).toEqual({ replayVersion: 2, rulesEdition: edition, game });
    const restored = replayGameLog(
      JSON.parse(JSON.stringify(baseline)),
      JSON.parse(JSON.stringify([root.entry, next.entry])),
      "federation-game",
    );
    expect(restored.game).toEqual(next.after);
    expect(restored.frames.map(({ after }) => after.rulesEdition)).toEqual([edition, edition]);
    expect(applyCurrentGameLogEntry(root.after, next.entry)).toEqual(next.after);
    expect(root.entry.stateHashAfter).toBe(hashGameState(game));
    expect(JSON.stringify(game)).toBe(beforeBytes);
    expect(domain.getGameReplayVersion(game)).toBe(2);
    const legacy = createGame(completedSetup());
    expect(domain.getGameReplayVersion(legacy)).toBe(1);
    expect(domain.createInitialGameBaseline(legacy)).toEqual({ replayVersion: 1, game: legacy });
    expect(hashGameState(game)).not.toBe(hashGameState(legacy));
    expect(domain.LEGACY_REPLAY_VERSION).toBe(1);
  });

  it("rejects baseline edition/version disagreement even without events", () => {
    const federation = createGame(completedSetup(edition));
    const legacy = createGame(completedSetup());
    for (const baseline of [
      { replayVersion: 1, game: federation },
      { replayVersion: 2, rulesEdition: edition, game: legacy },
    ]) {
      const bytes = JSON.stringify(baseline);
      expect(() => replayGameLog(baseline as InitialGameBaseline, [])).toThrow(
        /edition.*version|version.*edition/i,
      );
      expect(JSON.stringify(baseline)).toBe(bytes);
    }
  });

  it("leaves existing legacy baseline callers on their original version constant", () => {
    const game = createGame(completedSetup());
    const baseline = { replayVersion: domain.CURRENT_REPLAY_VERSION, game } as InitialGameBaseline;
    expect(replayGameLog(baseline, []).game).toBe(game);
    expect(domain.FEDERATION_REPLAY_VERSION).toBe(2);
  });

  it.each([false, true])(
    "rejects cross-edition application before trusting a matching hash (%s)",
    (federation) => {
      const game = createGame(completedSetup(federation ? edition : undefined));
      const other = createGame(completedSetup(federation ? undefined : edition));
      const { entry } = createGameLogEntry({
        gameId: "cross-edition",
        id: "root",
        sequence: 1,
        parentEventId: null,
        createdAt: "2026-10-14T10:00:00.000Z",
        before: other,
        draft: { type: "game.started", payload: {} },
      });
      const forged = { ...entry, stateHashAfter: hashGameState(game) } as GameLogEntry;
      expect(() => applyCurrentGameLogEntry(game, forged)).toThrow(/edition|version/i);
      expect(() => replayGameLog(domain.createInitialGameBaseline(game), [forged])).toThrow(
        expect.objectContaining({ diagnostic: { code: "history.version", replayIndex: 0 } }),
      );
    },
  );

  it.each(["unknown", "", null, 1, {}, undefined])(
    "refuses actions on a state with unsupported edition %j",
    (rulesEdition) => {
      const game = { ...createGame(completedSetup()), rulesEdition } as GameState;
      const before = structuredClone(game);
      const draft = { type: "game.started", payload: {} } as const;
      expect(() => domain.applyGameEvent(game, draft)).toThrow(/rules edition/i);
      expect(domain.tryApplyGameEvent(game, draft)).toMatchObject({ ok: false });
      expect(() => domain.getGameReplayVersion(game)).toThrow(/rules edition/i);
      expect(() => domain.createInitialGameBaseline(game)).toThrow(/rules edition/i);
      expect(game).toEqual(before);
    },
  );

  it("validates drafts against a supported replay version at the action boundary", () => {
    const draft = { type: "game.started", payload: {} } as const;
    expect(() => domain.assertCanonicalGameEventDraft(draft, 3 as ReplayVersion)).toThrow(
      /replay version/i,
    );
    expect(() => domain.assertCanonicalGameEventDraft(draft, 1)).not.toThrow();
    expect(() => domain.assertCanonicalGameEventDraft(draft, 2)).not.toThrow();
  });

  it("keeps v2 envelopes and states closed to malformed or unknown data", () => {
    const game = createGame(completedSetup(edition));
    const baseline = domain.createInitialGameBaseline(game);
    const { entry } = createGameLogEntry({
      gameId: "strict-v2",
      id: "root",
      sequence: 1,
      parentEventId: null,
      createdAt: "2026-10-14T10:00:00.000Z",
      before: game,
      draft: { type: "game.started", payload: {} },
    });
    const badMetadata = [
      { replayVersion: 0 },
      { replayVersion: 3 },
      { replayVersion: "2" },
      { replayVersion: null },
      { rulesEdition: "unknown" },
      { rulesEdition: undefined },
      { rulesEdition: null },
      { ignored: true },
    ];
    for (const change of badMetadata) {
      const badBaseline = { ...baseline, ...change } as unknown as InitialGameBaseline;
      const badEntry = { ...entry, ...change } as unknown as GameLogEntry;
      const baselineBytes = JSON.stringify(badBaseline);
      const entryBytes = JSON.stringify(badEntry);
      expect(() => replayGameLog(badBaseline, [])).toThrow();
      expect(() => domain.assertGameLogEntry(badEntry)).toThrow();
      expect(() => replayGameLog(baseline, [badEntry])).toThrow(
        expect.objectContaining({ diagnostic: { code: "history.invalid_event", replayIndex: 0 } }),
      );
      expect(JSON.stringify(badBaseline)).toBe(baselineBytes);
      expect(JSON.stringify(badEntry)).toBe(entryBytes);
    }
    const malformedStates = [
      {},
      { ...game, ignored: true },
      { ...game, players: game.players.map((player) => ({ ...player, name: "Copied name" })) },
      {
        ...game,
        players: game.players.map((player) => ({ ...player, role: "citizen", team: "red" })),
      },
      { ...game, day: -1 },
      { ...game, phase: "unsupported" },
    ];
    for (const state of malformedStates) {
      expect(() =>
        replayGameLog({ ...baseline, game: state } as InitialGameBaseline, []),
      ).toThrow();
      expect(() => domain.createInitialGameBaseline(state as GameState)).toThrow();
    }
    expect(() => domain.assertGameLogEntry({ ...entry, payload: { ignored: true } })).toThrow();
    expect(() =>
      domain.assertGameLogEntry({ ...entry, type: "federation.future-action" }),
    ).toThrow();
    const legacy = createGame(completedSetup());
    expect(() =>
      replayGameLog(
        { replayVersion: 1, rulesEdition: edition, game: legacy } as unknown as InitialGameBaseline,
        [],
      ),
    ).toThrow();
  });
});
