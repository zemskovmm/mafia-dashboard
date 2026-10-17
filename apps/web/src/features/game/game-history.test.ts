import { describe, expect, it } from "vitest";
import { advanceSetupPhase, createGame } from "@mafia/game-domain";
import {
  createGameLogEntry,
  createInitialGameBaseline,
  hashGameState,
  type CanonicalGameEventDraft,
  type GameLogEntry,
  type InitialGameBaseline,
} from "@mafia/game-domain";
import {
  beginRoleDraw,
  completeRoleDraw,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
} from "@mafia/game-domain";
import type { GameState, PlayerInput, SetupState } from "@mafia/game-domain";
import { createFederationSampleGameHistory } from "../timeline/sample-game-data.js";
import {
  getActiveBranch,
  getRemainingUndoBudget,
  getUndoableEvents,
  replayToEvent,
} from "./game-history.js";

const players = (): PlayerInput[] =>
  Array.from({ length: 10 }, (_, index) => ({
    id: `player-${index + 1}`,
    seat: index + 1,
  }));

const completedSetup = (): SetupState => {
  let setup = beginRoleDraw(createSetup(players()), createSeededRandom(12));
  for (let seat = 1; seat <= 10; seat += 1) setup = drawRoleForSeat(setup, seat);
  return completeRoleDraw(setup);
};

const dayOne = (): GameState => {
  let game = createGame(completedSetup());
  while (game.phase !== "day") game = advanceSetupPhase(game);
  return game;
};
const gameId = "00000000-0000-4000-8000-000000000991";
const eventId = (sequence: number) =>
  `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;

const append = (
  before: GameState,
  sequence: number,
  parentEventId: string | null,
  draft: CanonicalGameEventDraft,
) =>
  createGameLogEntry({
    gameId,
    id: eventId(sequence),
    sequence,
    parentEventId,
    createdAt: new Date(Date.UTC(2026, 7, 24, 21, sequence)).toISOString(),
    before,
    draft,
  });

const fixture = () => {
  const baseline: InitialGameBaseline = createInitialGameBaseline(dayOne());
  const root = append(baseline.game, 1, null, {
    type: "game.checkpointed",
    payload: {},
  });
  const first = append(root.after, 2, root.entry.id, {
    type: "player.nominated",
    payload: { nominatorSeat: 1, candidateSeat: 4 },
  });
  const second = append(first.after, 3, first.entry.id, {
    type: "turn.completed",
    payload: { seat: 1 },
  });
  const left = append(second.after, 4, second.entry.id, {
    type: "foul.issued",
    payload: { seat: 5, foulNumber: 1, redCarded: false },
  });
  const right = append(second.after, 5, second.entry.id, {
    type: "foul.issued",
    payload: { seat: 6, foulNumber: 1, redCarded: false },
  });
  return { baseline, root, first, second, left, right };
};

describe("active game history", () => {
  it("refuses noncurrent shape and removed engine metadata even on a one-entry branch", () => {
    const entry = fixture().root.entry;
    for (const changes of [
      { replayVersion: 1 },
      { replayVersion: 2 },
      { rulesEdition: "mafgame-2026-07-01" },
    ]) {
      const invalid = { ...entry, ...changes } as unknown as GameLogEntry;
      expect(() => getActiveBranch([invalid], invalid.id)).toThrow();
      expect(() => getRemainingUndoBudget([invalid], invalid.id)).toThrow();
    }
  });

  it("restores accepted federation prefixes and reviewed counts rather than the final screen", () => {
    const history = createFederationSampleGameHistory();
    for (const type of [
      "best-move.number-accepted",
      "best-move.slip-corrected",
      "best-move.finalized",
      "voting.count-disputed",
      "voting.count-ruled",
      "discipline.removal-observed",
      "game.adjudicated",
    ] as const) {
      const checkpoint = history.frames.find(({ entry }) => entry.type === type)!;
      expect(replayToEvent(history.baseline, history.entries, checkpoint.entry.id)).toEqual(
        checkpoint.after,
      );
    }
    const accepted = history.frames.find(
      ({ entry }) => entry.type === "best-move.number-accepted",
    )!;
    expect(
      replayToEvent(history.baseline, history.entries, accepted.entry.id).bestMove?.selectedSeats,
    ).toEqual([8]);
  });

  it("keeps adjudicated outcomes and automatic draws undoable before the parent Finish gate", () => {
    for (const outcome of ["adjudicated", "rules-draw"] as const) {
      const history = createFederationSampleGameHistory(outcome);
      const undoable = getUndoableEvents(history.activeEntries);
      const expectedCount = history.activeEntries.length - (outcome === "adjudicated" ? 2 : 1);
      expect(expectedCount).toBeGreaterThan(3);
      expect(undoable).toHaveLength(expectedCount);
      expect(
        undoable.some(({ type }) => type === "game.started" || type === "game.completed"),
      ).toBe(false);
      expect(undoable.at(-1)?.type).toBe(
        outcome === "adjudicated" ? "game.adjudicated" : "phase.changed",
      );
      expect(getRemainingUndoBudget(history.entries, history.headEventId)).toBe(expectedCount);
      const last = undoable.at(-1)!;
      expect(replayToEvent(history.baseline, history.entries, last.parentEventId!).phase).not.toBe(
        outcome === "adjudicated" ? "finished" : "draw",
      );
    }
  });
  it("follows parent links and excludes inactive sibling branches", () => {
    const { root, first, second, left, right } = fixture();
    const all = [root.entry, first.entry, second.entry, left.entry, right.entry];

    expect(getActiveBranch(all, left.entry.id).map(({ id }) => id)).toEqual([
      root.entry.id,
      first.entry.id,
      second.entry.id,
      left.entry.id,
    ]);
    expect(getActiveBranch(all, right.entry.id).map(({ id }) => id)).toEqual([
      root.entry.id,
      first.entry.id,
      second.entry.id,
      right.entry.id,
    ]);
  });

  it("replays exactly through the selected event", () => {
    const { baseline, root, first, second, left, right } = fixture();
    const all = [root.entry, first.entry, second.entry, left.entry, right.entry];

    expect(replayToEvent(baseline, all, second.entry.id)).toEqual(second.after);
    expect(replayToEvent(baseline, all, right.entry.id)).toEqual(right.after);
  });

  it("offers every retained action from an admitted checkpoint", () => {
    const { baseline, root, first, second, left } = fixture();
    const fourth = append(left.after, 5, left.entry.id, {
      type: "foul.issued",
      payload: { seat: 8, foulNumber: 1, redCarded: false },
    });
    const fifth = append(fourth.after, 6, fourth.entry.id, {
      type: "turn.completed",
      payload: { seat: 2 },
    });
    const accepted = [root, first, second, left, fourth, fifth];
    const entries = accepted.map(({ entry }) => entry);
    const original = JSON.stringify({ baseline, entries });

    expect(getUndoableEvents(entries)).toEqual(entries.slice(1));
    for (let length = entries.length; length > 1; length -= 1) {
      const retained = entries.slice(0, length);
      const oldest = getUndoableEvents(retained)[0]!;
      const latest = getUndoableEvents(retained).at(-1)!;
      expect(oldest.id).toBe(first.entry.id);
      expect(latest.id).toBe(retained.at(-1)!.id);
      expect(replayToEvent(baseline, retained, latest.parentEventId!)).toEqual(
        accepted[length - 2]!.after,
      );
    }
    expect(getUndoableEvents([root.entry])).toEqual([]);
    expect(getUndoableEvents([])).toEqual([]);
    expect(replayToEvent(baseline, entries, root.entry.id)).toEqual(baseline.game);
    expect(baseline.game.phase).toBe("day");
    expect(JSON.stringify({ baseline, entries })).toBe(original);
  });

  it("retains earlier actions across a canonical night-to-day transition", () => {
    const history = createFederationSampleGameHistory("rules-draw");
    const crossingIndex = history.frames.findIndex(
      ({ before, after }) => before.day === 1 && after.day === 2,
    );
    expect(crossingIndex).toBeGreaterThan(0);
    const crossing = history.frames[crossingIndex]!;
    expect(crossing.before.phase).toBe("night-resolution");
    expect(crossing.after.phase).toBe("day");
    const entries = history.activeEntries.slice(0, crossingIndex + 2);
    const original = JSON.stringify({ baseline: history.baseline, entries });

    expect(getUndoableEvents(entries)).toEqual(entries.slice(1));
    expect(getUndoableEvents(entries)).toContain(crossing.entry);
    for (let length = entries.length; length > 1; length -= 1) {
      const retained = entries.slice(0, length);
      const latest = getUndoableEvents(retained).at(-1)!;
      const restored = replayToEvent(history.baseline, retained, latest.parentEventId!);
      expect(restored).toEqual(history.frames[length - 1]!.before);
      expect(hashGameState(restored)).toBe(retained[length - 2]!.stateHashAfter);
    }
    expect(getUndoableEvents(entries.slice(0, 1))).toEqual([]);
    expect(JSON.stringify({ baseline: history.baseline, entries })).toBe(original);
  });

  it("derives availability only from the active prefix, not discarded or sibling sequences", () => {
    const { root, first, second, left, right } = fixture();
    const distantSibling = append(right.after, 9_000, right.entry.id, {
      type: "foul.issued",
      payload: { seat: 8, foulNumber: 1, redCarded: false },
    });
    const all = [
      distantSibling.entry,
      right.entry,
      left.entry,
      second.entry,
      first.entry,
      root.entry,
    ];
    const original = JSON.stringify(all);

    for (const [head, expectedCount] of [
      [distantSibling.entry, 4],
      [right.entry, 3],
      [left.entry, 3],
      [second.entry, 2],
      [first.entry, 1],
      [root.entry, 0],
    ] as const) {
      expect(getRemainingUndoBudget(all, head.id)).toBe(expectedCount);
      expect(getRemainingUndoBudget(getActiveBranch(all, head.id), head.id)).toBe(expectedCount);
      const reloaded = JSON.parse(JSON.stringify(all)) as GameLogEntry[];
      expect(getRemainingUndoBudget(reloaded, head.id)).toBe(expectedCount);
    }
    expect(getRemainingUndoBudget(all, null)).toBe(0);
    expect(getRemainingUndoBudget([], null)).toBe(0);
    expect(JSON.stringify(all)).toBe(original);
  });

  it("rejects replay hash corruption without repairing the retained history", () => {
    const { baseline, root, first } = fixture();
    const entries = [root.entry, { ...first.entry, stateHashAfter: `sha256:${"0".repeat(64)}` }];
    const original = JSON.stringify({ baseline, entries });

    expect(() => replayToEvent(baseline, entries, first.entry.id)).toThrow(/hash/i);
    expect(JSON.stringify({ baseline, entries })).toBe(original);
  });

  it("fails closed for cycles and missing parents", () => {
    const { first, second } = fixture();
    expect(() => getActiveBranch([second.entry], second.entry.id)).toThrow(/missing parent/i);
    expect(() =>
      getActiveBranch(
        [
          { ...first.entry, parentEventId: second.entry.id },
          { ...second.entry, parentEventId: first.entry.id },
        ],
        second.entry.id,
      ),
    ).toThrow(/cycle/i);
  });

  it("fails closed for duplicate IDs and cross-game parents", () => {
    const { first, second } = fixture();
    expect(() =>
      getActiveBranch([first.entry, { ...second.entry, id: first.entry.id }], first.entry.id),
    ).toThrow(/duplicate/i);
    expect(() =>
      getActiveBranch(
        [first.entry, { ...second.entry, gameId: "00000000-0000-4000-8000-000000000992" }],
        second.entry.id,
      ),
    ).toThrow(/game/i);
  });
});
