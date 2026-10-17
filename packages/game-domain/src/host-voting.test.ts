import { describe, expect, it } from "vitest";
import {
  applyGameEvent,
  beginRoleDraw,
  completeRoleDraw,
  createGame,
  createGameLogEntry,
  createInitialGameBaseline,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
  replayGameLog,
  resolveVote,
  tryApplyGameEvent,
  isSecretGameEventType,
} from "./index.js";
import type { CanonicalGameEventDraft, GameLogEntry } from "./index.js";
const ballot = () => {
  let setup = beginRoleDraw(
    createSetup(
      Array.from({ length: 10 }, (_, i) => ({
        id: `host-player-${i + 1}`,
        seat: i + 1,
      })),
    ),
    createSeededRandom(71),
  );
  for (let seat = 1; seat <= 10; seat++) setup = drawRoleForSeat(setup, seat);
  let game = createGame(completeRoleDraw(setup));
  for (const to of ["sheriff-identification", "day"] as const)
    game = applyGameEvent(game, { type: "phase.changed", payload: { to } });
  for (const seat of [1, 2])
    game = applyGameEvent(game, {
      type: "player.nominated",
      payload: { nominatorSeat: seat, candidateSeat: seat },
    });
  return applyGameEvent(game, { type: "phase.changed", payload: { to: "voting" } });
};
const history = (drafts: readonly CanonicalGameEventDraft[]) => {
  let game = ballot();
  const baseline = createInitialGameBaseline(game);
  const entries: GameLogEntry[] = [];
  for (const draft of [{ type: "game.checkpointed", payload: {} } as const, ...drafts]) {
    const accepted = createGameLogEntry({
      gameId: "host",
      id: `e${entries.length}`,
      sequence: entries.length + 1,
      parentEventId: entries.at(-1)?.id ?? null,
      createdAt: "2026-10-14T16:00:00Z",
      before: game,
      draft,
    });
    entries.push(accepted.entry);
    game = accepted.after;
    expect(replayGameLog(baseline, JSON.parse(JSON.stringify(entries))).game).toEqual(game);
  }
  return { baseline, entries, game };
};
describe("host recording", () => {
  it("pins the original ceremonial ballot bytes and hashes", () => {
    const result = history([
      { type: "voting.order-announced", payload: {} },
      { type: "voting.order-announced", payload: {} },
      { type: "voting.candidate-mentioned", payload: { candidateSeat: 1 } },
      { type: "voting.candidate-mentioned", payload: { candidateSeat: 1 } },
      { type: "vote.accepted", payload: { voterSeat: 3, candidateSeat: 1 } },
      { type: "voting.candidate-stopped", payload: { candidateSeat: 1 } },
    ]);
    expect(
      result.entries.map(({ stateHashAfter }) => ({ stateHashBefore: undefined, stateHashAfter })),
    ).toMatchSnapshot();
  });
  it("records, reassigns and clears without ceremonial observations, including after restore", () => {
    const { game, entries } = history([
      { type: "vote.recorded", payload: { voterSeat: 3, candidateSeat: 1 } },
      { type: "voting.candidate-selected", payload: { candidateSeat: 2 } },
      { type: "vote.recorded", payload: { voterSeat: 3, candidateSeat: 2 } },
      { type: "vote.recorded", payload: { voterSeat: 3, candidateSeat: null } },
    ]);
    expect(game.voteAssignments[3]).toBeUndefined();
    expect(game.ballot).toMatchObject({
      orderAnnouncements: 0,
      mention: 0,
      stopped: false,
      acceptedCandidateSeats: [],
      selectedCandidateSeat: 2,
      hostRecording: true,
    });
    expect(
      entries.every((e) => e.type === "game.checkpointed" || isSecretGameEventType(e.type)),
    ).toBe(true);
    expect(resolveVote(game)).toMatchObject({ kind: "winner", seats: [2] });
    const resolved = applyGameEvent(game, {
      type: "voting.resolved",
      payload: {
        voteAssignments: game.voteAssignments as Record<number, number>,
        result: resolveVote(game),
      },
    });
    expect(resolved.phase).not.toBe("voting");
  });
  it("rejects an undecided finish and pauses entry, selection and resolution for review", () => {
    let game = applyGameEvent(ballot(), {
      type: "vote.recorded",
      payload: { voterSeat: 3, candidateSeat: 1 },
    });
    expect(() => resolveVote(game)).toThrow(/conclusively/);
    game = applyGameEvent(game, {
      type: "voting.count-disputed",
      payload: { candidateSeat: 1, reason: "Check count" },
    });
    for (const draft of [
      { type: "vote.recorded", payload: { voterSeat: 3, candidateSeat: null } },
      { type: "voting.candidate-selected", payload: { candidateSeat: 2 } },
    ] as const)
      expect(tryApplyGameEvent(game, draft).ok).toBe(false);
    expect(() => resolveVote(game)).toThrow(/disputed/);
    game = applyGameEvent(game, {
      type: "voting.count-ruled",
      payload: {
        voteAssignments: { 3: 1 },
        reason: "Verified count",
        externalReviewAcknowledged: true,
      },
    });
    expect(
      tryApplyGameEvent(game, {
        type: "voting.count-disputed",
        payload: { candidateSeat: 1, reason: "Again" },
      }).ok,
    ).toBe(false);
    expect(
      tryApplyGameEvent(game, {
        type: "vote.recorded",
        payload: { voterSeat: 3, candidateSeat: 2 },
      }).ok,
    ).toBe(false);
  });
  it("validates candidate and voter and accepts a rule-only removal through replay", () => {
    const initial = ballot();
    for (const payload of [
      { voterSeat: 3, candidateSeat: 9 },
      { voterSeat: 11, candidateSeat: 1 },
    ])
      expect(tryApplyGameEvent(initial, { type: "vote.recorded", payload }).ok).toBe(false);
    const { game } = history([
      {
        type: "discipline.removal-observed",
        payload: {
          seat: 3,
          stage: "open-voting",
          rule: "6.2.4",
          reason: "",
          checkInProgress: false,
        },
      },
    ]);
    expect(game.disciplinaryRemovals?.[0]?.reason).toBe("");
    expect(tryApplyGameEvent(initial, { type: "game.drawn", payload: { reason: "" } }).ok).toBe(
      false,
    );
  });
});
