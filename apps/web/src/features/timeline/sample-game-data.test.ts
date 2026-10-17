import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  createGameLogEntry,
  isCanonicalGameEventType,
  isProvisionalInteractionType,
  replayGameLog,
  type CanonicalGameEventDraft,
} from "@mafia/game-domain";
import { getActiveBranch } from "../game/game-history.js";
import {
  createFederationSampleGameHistory,
  createSampleGameHistory,
  SAMPLE_GAME_LABEL,
} from "./sample-game-data.js";

describe("deterministic current sample game history", () => {
  it.each([
    [
      "completed",
      createSampleGameHistory,
      "7b7960d1a728db3169153277b71b578e6f28bf345a846f246b5ed97a0ad57f07",
    ],
    [
      "adjudicated",
      createFederationSampleGameHistory,
      "9c84cce26c7765e55dba710e606609a09b7d0ddec59aea795fcde7e8bff1184a",
    ],
    [
      "automatic draw",
      () => createFederationSampleGameHistory("rules-draw"),
      "b4f0997ba7131e2e6b2c2118baee41ea30c889cadb49b94a65992bf89daef71c",
    ],
  ] as const)(
    "pins current %s bytes and exactly regenerates canonical v3 actions and hashes",
    (_, create, expected) => {
      const history = create();
      const bytes = JSON.stringify(history);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected);
      expect(history.baseline.replayVersion).toBe(3);
      expect(history.entries.every(({ replayVersion }) => replayVersion === 3)).toBe(true);
      expect(bytes).not.toMatch(/rulesEdition|rulesetId|rulesetVersion|skipCasperBestMove/);
      const replayed = replayGameLog(
        JSON.parse(JSON.stringify(history.baseline)),
        JSON.parse(JSON.stringify(history.activeEntries)),
      );
      expect(replayed.game).toEqual(history.game);
      expect(replayed.frames).toEqual(history.frames);
      for (const { before, entry } of history.frames) {
        const regenerated = createGameLogEntry({
          before,
          gameId: entry.gameId,
          id: entry.id,
          sequence: entry.sequence,
          parentEventId: entry.parentEventId,
          createdAt: entry.createdAt,
          draft: { type: entry.type, payload: entry.payload } as CanonicalGameEventDraft,
        });
        expect(JSON.stringify(regenerated.entry)).toBe(JSON.stringify(entry));
      }
      expect(JSON.stringify(create())).toBe(bytes);
    },
  );

  it("retains accepted judge decisions and a distinct adjudicated result", () => {
    const history = createFederationSampleGameHistory();
    expect(history.label).toBe(SAMPLE_GAME_LABEL);
    expect(history.entries.map(({ type }) => type)).toEqual(
      expect.arrayContaining([
        "voting.order-announced",
        "voting.candidate-mentioned",
        "voting.candidate-inspected",
        "voting.candidate-stopped",
        "voting.live-advanced",
        "vote.accepted",
        "vote.corrected",
        "voting.count-disputed",
        "voting.count-ruled",
        "best-move.number-accepted",
        "best-move.slip-corrected",
        "best-move.finalized",
        "discipline.removal-observed",
        "discipline.removals-announced",
        "mafia.multiple-shot-observed",
        "game.adjudicated",
      ]),
    );
    expect(history.game).toMatchObject({
      phase: "finished",
      winner: "red",
      bestMove: {
        selectedSeats: [8, 9],
        completionReason: "finished-early",
        readbackAcknowledged: true,
      },
      adjudication: {
        losingTeam: "black",
        offenderSeat: 10,
        rule: "6.3.5",
        committeeApproved: true,
      },
    });
    expect(history.game.players.find(({ seat }) => seat === 10)?.status).toBe("active");
  });

  it("reaches a rule-6.5.6 automatic draw without a synthetic host-draw event", () => {
    const history = createFederationSampleGameHistory("rules-draw");
    expect(history.game).toMatchObject({
      phase: "draw",
      winner: null,
      completedGameNights: 3,
      rulesDrawReason: { rule: "6.5.6", completedGameNights: 3, consecutiveUnchangedNights: 3 },
    });
    expect(history.entries.at(-1)).toMatchObject({
      type: "phase.changed",
      payload: { to: "draw" },
      replayVersion: 3,
    });
    expect(
      history.entries.some(({ type }) => type === "game.drawn" || type === "game.adjudicated"),
    ).toBe(false);
  });

  it("starts from one real deterministic baseline and retains every current opening phase", () => {
    const history = createSampleGameHistory();
    expect(SAMPLE_GAME_LABEL).toBe("Sample game · not saved");
    expect(history.baseline.game).toMatchObject({ phase: "mafia-planning", day: 0 });
    expect(history.frames.slice(0, 6).map(({ after }) => after.phase)).toEqual([
      "mafia-planning",
      "mafia-sleep",
      "don-identification",
      "sheriff-identification",
      "free-seating",
      "day",
    ]);
    expect(history.frames[5]?.after).toMatchObject({ phase: "day", day: 1 });
    expect(history.activeEntries.some(({ type }) => type === "turn.completed")).toBe(false);
  });

  it("replays nominations, accepted voting, Mafia kill, private checks and morning", () => {
    const history = createSampleGameHistory();
    expect(
      history.entries
        .filter(({ type }) => type === "player.nominated")
        .map(({ payload }) => payload),
    ).toEqual([
      { nominatorSeat: 1, candidateSeat: 7 },
      { nominatorSeat: 2, candidateSeat: 6 },
    ]);
    expect(history.entries.find(({ type }) => type === "voting.resolved")?.payload).toMatchObject({
      result: { kind: "winner", seats: [7], totals: { 7: 6, 6: 4 } },
    });
    expect(
      history.entries.find(({ type }) => type === "mafia.shots-resolved")?.payload,
    ).toMatchObject({ result: { kind: "kill", targetSeat: 2 } });
    expect(history.entries.find(({ type }) => type === "don.checked")?.payload).toEqual({
      targetSeat: 1,
      match: true,
    });
    expect(history.entries.find(({ type }) => type === "sheriff.checked")?.payload).toEqual({
      targetSeat: 10,
      match: true,
    });
    expect(history.frames.some(({ after }) => after.day === 2 && after.phase === "day")).toBe(true);
  });

  it("retains a reasoned fourth foul, announcement, legal skip, miss and current removals before ordinary completion", () => {
    const history = createSampleGameHistory();
    expect(
      history.entries.filter(({ type }) => type === "foul.issued").map(({ payload }) => payload),
    ).toEqual([1, 2, 3].map((foulNumber) => ({ seat: 9, foulNumber, redCarded: false })));
    expect(
      history.entries.find(({ type }) => type === "discipline.foul-issued")?.payload,
    ).toMatchObject({
      seat: 9,
      foulNumber: 4,
      redCarded: true,
      removal: { rule: "6.2.1", reason: "Fourth observed speech violation" },
    });
    expect(
      history.entries.flatMap((entry) =>
        entry.type === "mafia.shots-resolved" ? [entry.payload.result.kind] : [],
      ),
    ).toEqual(["kill", "miss"]);
    expect(
      history.entries
        .filter(({ type }) => type === "discipline.removal-observed")
        .map(({ payload }) => "seat" in payload && payload.seat),
    ).toEqual([8, 10]);
    expect(history.entries.find(({ type }) => type === "voting.legally-skipped")?.payload).toEqual({
      reason: "disciplinary-cancellation",
    });
    expect(history.game).toMatchObject({ phase: "finished", winner: "red", day: 3 });
    expect(history.game.adjudication).toBeUndefined();
  });

  it("freezes its baseline deeply and exposes a single snapshot-free canonical chain", () => {
    const history = createSampleGameHistory();
    for (const value of [
      history.baseline,
      history.baseline.game,
      history.baseline.game.players,
      history.baseline.game.players[0],
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(getActiveBranch(history.entries, history.headEventId)).toEqual(history.activeEntries);
    expect(history.entries).toEqual(history.activeEntries);
    for (const entry of history.entries) {
      expect(isCanonicalGameEventType(entry.type)).toBe(true);
      expect(isProvisionalInteractionType(entry.type)).toBe(false);
      for (const key of ["game", "state", "before", "after"]) expect(entry).not.toHaveProperty(key);
    }
  });
});
