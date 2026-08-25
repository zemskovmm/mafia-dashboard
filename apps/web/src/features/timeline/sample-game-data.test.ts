import { describe, expect, it } from "vitest";
import {
  isCanonicalGameEventType,
  isProvisionalInteractionType,
  replayGameLog,
  type GameLogEntry,
} from "@mafia/game-domain";
import { getActiveBranch } from "../game/game-history.js";
import { createSampleGameHistory, SAMPLE_GAME_LABEL } from "./sample-game-data.js";

type EntryOfType<Type extends GameLogEntry["type"]> = Extract<
  GameLogEntry,
  { readonly type: Type }
>;

const isEntryOfType =
  <Type extends GameLogEntry["type"]>(type: Type) =>
  (entry: GameLogEntry): entry is EntryOfType<Type> =>
    entry.type === type;

describe("deterministic sample game history", () => {
  it("starts from one deterministic baseline and reaches day one through canonical replay", () => {
    const first = createSampleGameHistory();
    const second = createSampleGameHistory();

    expect(SAMPLE_GAME_LABEL).toBe("Sample game · not saved");
    expect(first.baseline.game).toMatchObject({ phase: "mafia-planning", day: 0 });
    expect(first.activeEntries.slice(0, 3).map(({ type }) => type)).toEqual([
      "game.started",
      "phase.changed",
      "phase.changed",
    ]);
    expect(first.frames[2]?.after).toMatchObject({ phase: "day", day: 1 });
    expect(replayGameLog(first.baseline, first.activeEntries).frames).toEqual(first.frames);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("replays the first day, vote, Mafia kill, private checks, and transition to day two", () => {
    const history = createSampleGameHistory();
    const entry = (type: (typeof history.activeEntries)[number]["type"]) =>
      history.activeEntries.find((candidate) => candidate.type === type);

    expect(entry("player.nominated")?.payload).toEqual({
      nominatorSeat: 1,
      candidateSeat: 7,
    });
    expect(entry("voting.resolved")?.payload).toMatchObject({
      result: { kind: "winner", seats: [7], totals: { 7: 10 } },
    });
    expect(entry("mafia.shots-resolved")?.payload).toMatchObject({
      result: { kind: "kill", targetSeat: 2 },
    });
    expect(entry("don.checked")?.payload).toEqual({ targetSeat: 1, match: true });
    expect(entry("sheriff.checked")?.payload).toEqual({ targetSeat: 10, match: true });
    expect(history.frames.some(({ after }) => after.day === 2 && after.phase === "day")).toBe(true);
  });

  it("continues through a cancelled second vote, a Mafia miss, red cards, and completion", () => {
    const history = createSampleGameHistory();
    const fouls = history.activeEntries.filter(isEntryOfType("foul.issued"));
    const shotResults = history.activeEntries
      .filter(isEntryOfType("mafia.shots-resolved"))
      .map(({ payload }) => payload.result.kind);

    expect(fouls.map(({ payload }) => payload)).toEqual([
      { seat: 9, foulNumber: 1, redCarded: false },
      { seat: 9, foulNumber: 2, redCarded: false },
      { seat: 9, foulNumber: 3, redCarded: false },
      { seat: 9, foulNumber: 4, redCarded: true },
    ]);
    expect(
      history.frames.some(({ after }) => after.phase === "voting-cancelled" && after.day === 2),
    ).toBe(true);
    expect(shotResults).toEqual(["kill", "miss"]);
    expect(
      history.activeEntries
        .filter(isEntryOfType("player.red-carded"))
        .map(({ payload }) => payload.seat),
    ).toEqual([8, 10]);
    expect(history.activeEntries.at(-1)?.type).toBe("game.completed");
    expect(history.game).toMatchObject({ phase: "finished", winner: "red", day: 2 });
  });

  it("freezes the single baseline deeply", () => {
    const { baseline } = createSampleGameHistory();

    expect(Object.isFrozen(baseline)).toBe(true);
    expect(Object.isFrozen(baseline.game)).toBe(true);
    expect(Object.isFrozen(baseline.game.players)).toBe(true);
    expect(Object.isFrozen(baseline.game.players[0])).toBe(true);
  });

  it("preserves a reset branch while exposing only canonical snapshot-free active entries", () => {
    const history = createSampleGameHistory();
    const activeIds = new Set(history.activeEntries.map(({ id }) => id));
    const inactiveEntries = history.entries.filter(({ id }) => !activeIds.has(id));

    expect(getActiveBranch(history.entries, history.headEventId)).toEqual(history.activeEntries);
    expect(inactiveEntries).toHaveLength(1);
    expect(history.entries.length).toBeGreaterThan(history.activeEntries.length);
    expect(Object.isFrozen(history.baseline)).toBe(true);
    for (const entry of history.entries) {
      expect(isCanonicalGameEventType(entry.type)).toBe(true);
      expect(isProvisionalInteractionType(entry.type)).toBe(false);
      expect(entry).not.toHaveProperty("game");
      expect(entry).not.toHaveProperty("state");
      expect(entry).not.toHaveProperty("before");
      expect(entry).not.toHaveProperty("after");
    }
  });
});
