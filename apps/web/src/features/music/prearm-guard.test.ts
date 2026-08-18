import { describe, expect, it } from "vitest";
import { shouldStopPrearmedDeck } from "./prearm-guard.js";

describe("shouldStopPrearmedDeck", () => {
  it("does not pause a deck after a crossfade has started", () => {
    expect(shouldStopPrearmedDeck({ transitioning: true, activeDeck: "a", prearmDeck: "a" })).toBe(
      false,
    );
  });

  it("does not pause a deck after the active deck generation changes", () => {
    expect(shouldStopPrearmedDeck({ transitioning: false, activeDeck: "b", prearmDeck: "a" })).toBe(
      false,
    );
  });

  it("stops the silent pre-arm when playback remains on the original deck", () => {
    expect(shouldStopPrearmedDeck({ transitioning: false, activeDeck: "a", prearmDeck: "a" })).toBe(
      true,
    );
  });
});
