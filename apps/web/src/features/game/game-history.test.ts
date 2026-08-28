import { describe, expect, it } from "vitest";
import { advanceSetupPhase, createGame } from "@mafia/game-domain";
import {
  createGameLogEntry,
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
import {
  getActiveBranch,
  getRemainingUndoBudget,
  getUndoableEvents,
  replayToEvent,
} from "./game-history.js";

const players = (): PlayerInput[] =>
  Array.from({ length: 10 }, (_, index) => ({
    id: `player-${index + 1}`,
    name: `Player ${index + 1}`,
    seat: index + 1,
  }));

const completedSetup = (): SetupState => {
  let setup = beginRoleDraw(createSetup(players()), createSeededRandom(12));
  for (let seat = 1; seat <= 10; seat += 1) setup = drawRoleForSeat(setup, seat);
  return completeRoleDraw(setup);
};

const dayOne = (): GameState => advanceSetupPhase(advanceSetupPhase(createGame(completedSetup())));
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
  const baseline: InitialGameBaseline = { replayVersion: 1, game: dayOne() };
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
