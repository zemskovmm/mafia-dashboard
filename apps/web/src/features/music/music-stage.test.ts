import type { GamePhase } from "@mafia/game-domain";
import { describe, expect, it } from "vitest";
import type { MusicStage } from "./music-preferences.js";
import { musicStageForPhase } from "./music-stage.js";

const expectedStageByPhase = {
  "mafia-planning": "night",
  "sheriff-wake": "night",
  day: "day",
  voting: "voting",
  "voting-cancelled": "voting",
  "car-crash": "voting",
  "car-crash-decision": "voting",
  "car-crash-result": "voting",
  "car-crash-skipped": "voting",
  "goodbye-speech": "day",
  "best-move": "day",
  "night-mafia": "night",
  "night-mafia-result": "night",
  "night-don": "night",
  "night-don-result": "night",
  "night-sheriff": "night",
  "night-sheriff-result": "night",
  "night-resolution": "night",
  finished: null,
} satisfies Record<GamePhase, MusicStage | null>;

const phaseExpectations = Object.entries(expectedStageByPhase) as readonly (readonly [
  GamePhase,
  MusicStage | null,
])[];

describe("musicStageForPhase", () => {
  it.each(phaseExpectations)("maps %s to %s", (phase, expectedStage) => {
    expect(musicStageForPhase(phase)).toBe(expectedStage);
  });
});
