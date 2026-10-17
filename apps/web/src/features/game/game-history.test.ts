import { describe, expect, it } from "vitest";
import { advanceSetupPhase, createGame } from "@mafia/game-domain";
import {
  createGameLogEntry,
  createInitialGameBaseline,
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
      const expectedBudget = outcome === "adjudicated" ? 1 : 3;
      expect(undoable).toHaveLength(expectedBudget);
      expect(undoable.at(-1)?.type).toBe(
        outcome === "adjudicated" ? "game.adjudicated" : "phase.changed",
      );
      expect(getRemainingUndoBudget(history.entries, history.headEventId)).toBe(expectedBudget);
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

  it("offers at most three undoable events after the latest new-day checkpoint", () => {
    const { first, second, left } = fixture();
    const syntheticDay: GameLogEntry = {
      ...left.entry,
      id: eventId(5),
      sequence: 5,
      parentEventId: left.entry.id,
      dayBefore: 1,
      dayAfter: 2,
      phaseBefore: "night-resolution",
      phaseAfter: "day",
    };
    const afterDay = {
      ...first.entry,
      id: eventId(6),
      sequence: 6,
      parentEventId: syntheticDay.id,
    };

    expect(getUndoableEvents([first.entry, second.entry, left.entry])).toHaveLength(3);
    expect(
      getUndoableEvents([first.entry, second.entry, left.entry, syntheticDay, afterDay]),
    ).toEqual([afterDay]);
  });

  it("does not replenish consumed undo capacity after reload", () => {
    const { root, first, second, left, right } = fixture();
    const all = [root.entry, first.entry, second.entry, left.entry, right.entry];

    expect(getRemainingUndoBudget(all, right.entry.id)).toBe(3);
    expect(getRemainingUndoBudget(all, left.entry.id)).toBe(2);
    expect(getRemainingUndoBudget(all, second.entry.id)).toBe(1);
    expect(getRemainingUndoBudget(all, first.entry.id)).toBe(0);
    expect(getRemainingUndoBudget(all, null)).toBe(0);
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
