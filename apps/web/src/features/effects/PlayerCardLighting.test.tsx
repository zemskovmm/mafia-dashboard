import { describe, expect, it } from "vitest";
import { resolvePlayerLightingKind } from "./PlayerCardLighting.js";

describe("PlayerCardLighting", () => {
  it.each([
    [{ current: true }, "speaker"],
    [{ mafiaShooter: true }, "mafia"],
    [{ sheriffHighlight: true }, "sheriff"],
    [{ goodbyeHighlight: true }, "attention"],
    [{ votingHighlight: true }, "attention"],
    [{}, null],
  ] as const)("maps %j to %s", (seat, expected) => {
    expect(resolvePlayerLightingKind(seat)).toBe(expected);
  });
});
