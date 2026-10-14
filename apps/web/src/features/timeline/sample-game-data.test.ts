import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  isCanonicalGameEventType,
  isProvisionalInteractionType,
  replayGameLog,
  type GameLogEntry,
} from "@mafia/game-domain";
import { getActiveBranch } from "../game/game-history.js";
import {
  createFederationSampleGameHistory,
  createSampleGameHistory,
  SAMPLE_GAME_LABEL,
} from "./sample-game-data.js";

type EntryOfType<Type extends GameLogEntry["type"]> = Extract<
  GameLogEntry,
  { readonly type: Type }
>;

const isEntryOfType =
  <Type extends GameLogEntry["type"]>(type: Type) =>
  (entry: GameLogEntry): entry is EntryOfType<Type> =>
    entry.type === type;

describe("deterministic sample game history", () => {
  it("preserves the pre-federation sample's edition and canonical hashes", () => {
    const history = createSampleGameHistory();
    // Captured from the unmodified HEAD sample, not regenerated expectations from this implementation.
    expect(createHash("sha256").update(JSON.stringify(history)).digest("hex")).toBe(
      "45b62c8c4c07741a9d2771afc49dc6c8d7d011b7fba9d5bc693e5f693114600e",
    );
    expect(history.baseline.replayVersion).toBe(1);
    expect(history.baseline.game).not.toHaveProperty("rulesEdition");
    expect(history.entries.every((entry) => entry.replayVersion === 1)).toBe(true);
    expect(history.entries[0]?.stateHashAfter).toBe(
      "sha256:4f07185020c14b02ab7a667d36a7779c4a7a388d9e9c5703c5eafee4114204af",
    );
    expect(history.entries.at(-1)?.stateHashAfter).toBe(
      "sha256:b3ca218d25db5a85fddc67ef0cd36eddadaff696d531fddd0bb04a73cccce6da",
    );
  });

  it("offers a separate v2 sample with accepted judge decisions and an adjudicated outcome", () => {
    const history = createFederationSampleGameHistory();
    expect(history.label).toBe("Federation sample game · not saved");
    expect(history.baseline).toMatchObject({
      replayVersion: 2,
      rulesEdition: "mafgame-2026-07-01",
      game: { phase: "mafia-planning", rulesEdition: "mafgame-2026-07-01" },
    });
    expect(history.entries.every((entry) => entry.replayVersion === 2)).toBe(true);
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
    expect(
      replayGameLog(
        JSON.parse(JSON.stringify(history.baseline)),
        JSON.parse(JSON.stringify(history.activeEntries)),
      ).game,
    ).toEqual(history.game);
    expect(JSON.stringify(createFederationSampleGameHistory())).toBe(JSON.stringify(history));
    expect(Object.isFrozen(history.baseline.game.players)).toBe(true);
  });
  it("provides a separately requested automatic rule-6.5.6 draw without a synthetic host-draw event", () => {
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
      replayVersion: 2,
    });
    expect(
      history.entries.some(({ type }) => type === "game.drawn" || type === "game.adjudicated"),
    ).toBe(false);
    expect(replayGameLog(history.baseline, history.activeEntries).game).toEqual(history.game);
    expect(JSON.stringify(createFederationSampleGameHistory("rules-draw"))).toBe(
      JSON.stringify(history),
    );
  });

  it("starts from one deterministic baseline and reaches day one through canonical replay", () => {
    const first = createSampleGameHistory();
    const second = createSampleGameHistory();

    expect(SAMPLE_GAME_LABEL).toBe("Sample game · not saved");
    expect(first.baseline.game).toMatchObject({ phase: "mafia-planning", day: 0 });
    expect(first.activeEntries.slice(0, 2).map(({ type }) => type)).toEqual([
      "game.started",
      "phase.changed",
    ]);
    expect(first.frames[1]?.after).toMatchObject({ phase: "day", day: 1 });
    expect(first.activeEntries.some(({ type }) => type === "turn.completed")).toBe(false);
    expect(
      first.activeEntries.some(
        ({ type, payload }) =>
          type === "phase.changed" &&
          "to" in payload &&
          ["sheriff-wake", "night-don", "night-sheriff", "best-move"].includes(String(payload.to)),
      ),
    ).toBe(false);
    expect(replayGameLog(first.baseline, first.activeEntries).frames).toEqual(first.frames);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("replays the first day, vote, Mafia kill, private checks, and transition to day two", () => {
    const history = createSampleGameHistory();
    const entry = (type: (typeof history.activeEntries)[number]["type"]) =>
      history.activeEntries.find((candidate) => candidate.type === type);

    expect(
      history.activeEntries
        .filter(isEntryOfType("player.nominated"))
        .slice(0, 2)
        .map(({ payload }) => payload),
    ).toEqual([
      { nominatorSeat: 1, candidateSeat: 7 },
      { nominatorSeat: 2, candidateSeat: 6 },
    ]);
    expect(entry("voting.resolved")?.payload).toMatchObject({
      result: { kind: "winner", seats: [7], totals: { 7: 10, 6: 0 } },
    });
    expect(entry("mafia.shots-resolved")?.payload).toMatchObject({
      shots: expect.arrayContaining([expect.objectContaining({ secret: true })]),
      result: { kind: "kill", targetSeat: 2 },
    });
    expect(entry("don.checked")?.payload).toEqual({ targetSeat: 1, match: true });
    expect(entry("sheriff.checked")?.payload).toEqual({ targetSeat: 10, match: true });
    expect(history.frames.some(({ after }) => after.day === 2 && after.phase === "day")).toBe(true);
  });

  it("continues through a fourth Foul, a Mafia miss, red cards, and completion", () => {
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
    expect(history.frames.some(({ entry }) => entry.type === "turn.completed")).toBe(false);
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
