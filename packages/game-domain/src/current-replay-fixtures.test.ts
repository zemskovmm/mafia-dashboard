import { describe, expect, it } from "vitest";
import fixture from "./fixtures/current-replays.json";
import {
  createGameLogEntry,
  createInitialGameBaseline,
  hashGameState,
  replayGameLog,
} from "./index.js";
import type { CanonicalGameEventDraft, GameLogEntry, InitialGameBaseline } from "./index.js";

const bytesHash = async (value: unknown): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

describe("current representation replay fixtures", () => {
  it.each(fixture.examples)(
    "pins $name bytes, frames, hashes and exact event regeneration",
    async (example) => {
      const baseline = example.baseline as InitialGameBaseline;
      const events = example.events as GameLogEntry[];
      const original = JSON.stringify(example);
      expect(baseline.replayVersion).toBe(3);
      expect(await bytesHash(baseline)).toBe(example.baselineBytesHash);
      expect(await bytesHash(createInitialGameBaseline(baseline.game))).toBe(
        example.baselineBytesHash,
      );
      expect(await bytesHash(events)).toBe(example.eventBytesHash);
      expect(hashGameState(baseline.game)).toBe(example.initialHash);
      const result = replayGameLog(baseline, events, `current-${example.name}`);
      expect(hashGameState(result.game)).toBe(example.finalHash);
      expect(result.frames.map(({ after }) => hashGameState(after))).toEqual(
        events.map(({ stateHashAfter }) => stateHashAfter),
      );
      for (const { before, entry } of result.frames) {
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
      expect(JSON.stringify(example)).toBe(original);
      expect(original).not.toMatch(/rulesEdition|rulesetId|rulesetVersion|skipCasperBestMove/);
    },
  );
});
