import { describe, expect, it } from "vitest";
import { cardSuit, CARD_SUITS } from "./card-suit.js";

describe("presentation-only card suits v1", () => {
  it("freezes deterministic opaque-ID vectors including Unicode and framing separators", () => {
    expect(
      ["alice", "bob", "длинный-id", "01", "1", "a:b"].map((id) => cardSuit("game-a", id)),
    ).toEqual(["spade", "diamond", "club", "diamond", "spade", "club"]);
    expect(
      ["alice", "bob", "длинный-id", "01", "1", "a:b"].map((id) => cardSuit("game-b", id)),
    ).toEqual(["spade", "club", "diamond", "club", "heart", "diamond"]);
  });
  it("uses an explicitly neutral pre-game/missing identity", () => {
    expect(cardSuit(null, "player")).toBeNull();
    expect(cardSuit("game")).toBeNull();
    expect(cardSuit("", "player")).toBeNull();
  });
  it("is pure across calls and independent of any role, name, seat or order", () => {
    const pairs = Array.from({ length: 50 }, (_, i) => [`game-${i % 3}`, `player-${i}`] as const);
    const first = new Map(pairs.map(([g, p]) => [p, cardSuit(g, p)]));
    for (const [g, p] of [...pairs].reverse()) {
      expect(cardSuit(g, p)).toBe(first.get(p));
      expect(CARD_SUITS).toContain(cardSuit(g, p));
    }
    expect(new Set(pairs.map(([g, p]) => cardSuit(g, p))).size).toBe(4);
    expect(pairs.some(([, p]) => cardSuit("game-a", p) !== cardSuit("game-b", p))).toBe(true);
  });
});
