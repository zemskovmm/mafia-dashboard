import { describe, expect, it } from "vitest";
import fixture from "./fixtures/accepted-v1-replays.json";
import { selectVotingCandidate, toggleVote } from "./day-actions.js";
import { createGame } from "./game.js";
import {
  createGameLogEntry,
  createInitialGameBaseline,
  hashGameState,
  replayGameLog,
  type CanonicalGameEventDraft,
  type GameLogEntry,
  type InitialGameBaseline,
} from "./game-events.js";
import {
  beginRoleDraw,
  completeRoleDraw,
  createSeededRandom,
  createSetup,
  drawRoleForSeat,
} from "./setup.js";
import type { GameState } from "./types.js";

const bytesHash = async (value: unknown): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

describe("accepted pre-federation replay preservation", () => {
  it("keeps fresh legacy setup and planning shapes byte-for-byte", async () => {
    const initial = createSetup(fixture.initialSetup.players);
    expect(initial).toEqual(fixture.initialSetup);
    expect(await bytesHash(initial)).toBe(fixture.initialSetupBytesHash);
    let setup = beginRoleDraw(initial, createSeededRandom(41));
    for (let seat = 1; seat <= 10; seat += 1) setup = drawRoleForSeat(setup, seat);
    expect(createGame(completeRoleDraw(setup))).toEqual(fixture.cases[0]!.baseline.game);
  });

  it.each(fixture.cases)(
    "preserves $name bytes, replay frames and state hashes",
    async (example) => {
      const baseline = example.baseline as InitialGameBaseline;
      const events = example.events as GameLogEntry[];
      const bytes = JSON.stringify(example);
      expect(await bytesHash(baseline)).toBe(example.baselineBytesHash);
      expect(await bytesHash(createInitialGameBaseline(baseline.game))).toBe(
        example.baselineBytesHash,
      );
      expect(await bytesHash(events)).toBe(example.eventBytesHash);
      expect(hashGameState(baseline.game)).toBe(example.initialHash);
      const result = replayGameLog(baseline, events, "v1-characterization");
      expect(hashGameState(result.game)).toBe(example.finalHash);
      expect(result.frames.map(({ after }) => hashGameState(after))).toEqual(
        events.map(({ stateHashAfter }) => stateHashAfter),
      );
      for (const { before, entry } of result.frames) {
        const regenerated = createGameLogEntry({
          gameId: entry.gameId,
          id: entry.id,
          sequence: entry.sequence,
          parentEventId: entry.parentEventId,
          createdAt: entry.createdAt,
          before,
          draft: { type: entry.type, payload: entry.payload } as CanonicalGameEventDraft,
        });
        expect(JSON.stringify(regenerated.entry)).toBe(JSON.stringify(entry));
      }
      expect(JSON.stringify(example)).toBe(bytes);
      expect(result.game).not.toHaveProperty("rulesEdition");
    },
  );

  it("retains legacy nominee inspection, reassignment and deliberate remainder filling", () => {
    const game = fixture.cases.find(({ name }) => name === "open-ballot")!.baseline
      .game as GameState;
    const inspected = selectVotingCandidate(game, 6);
    expect(inspected.voteAssignments[2]).toBe(6);
    const reassigned = toggleVote(inspected, 1, 6);
    expect(reassigned.voteAssignments[1]).toBe(6);
    const removed = toggleVote(reassigned, 2, 6);
    expect(removed.voteAssignments[2]).toBeUndefined();
    const earlier = selectVotingCandidate(removed, 4);
    expect(earlier.voteAssignments[2]).toBeUndefined();
    expect(selectVotingCandidate(earlier, 6).voteAssignments[2]).toBe(6);
  });
});
