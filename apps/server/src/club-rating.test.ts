import { describe, expect, it } from "vitest";
import { buildClubRatingLedger, ratingEligibility } from "./club-rating.js";
import { playerIds, statisticsGame } from "./test-helpers/club-statistics-fixtures.js";

describe("club-team-elo-v1", () => {
  it("uses simultaneous arithmetic team means, saved wins and unequal-team draw expectations", () => {
    const first = statisticsGame(1);
    const draw = statisticsGame(2, { outcome: "draw" });
    const ledger = buildClubRatingLedger([draw, first]);
    const initial = ledger.games.get(first.gameId)!.get(playerIds[0]!)!;
    expect(initial).toEqual({
      before: 1500,
      after: 1516,
      change: 16,
      redAverage: 1500,
      blackAverage: 1500,
      expectedScore: 0.5,
      score: 1,
    });
    expect(ledger.games.get(first.gameId)!.get(playerIds[9]!)!.change).toBe(-16);
    const next = ledger.games.get(draw.gameId)!.get(playerIds[0]!)!;
    const expected = 1 / (1 + 10 ** ((1484 - 1516) / 400));
    expect(next.expectedScore).toBeCloseTo(expected, 14);
    expect(next.change).toBeCloseTo(32 * (0.5 - expected), 14);
    expect(next.change).toBeLessThan(0);
    expect(ledger.players.get(playerIds[0]!)!.value).toBeCloseTo(1516 + next.change, 14);
    expect(ledger.players.has(playerIds[10]!)).toBe(false);
    // Seven red and three black players: equal side changes are not globally zero-sum.
    expect(
      [...ledger.games.get(first.gameId)!.values()].reduce((sum, row) => sum + row.change, 0),
    ).toBe(64);
  });

  it("rejects every ineligible roster/format without deleting retained opaque identities", () => {
    const game = statisticsGame(1);
    expect(ratingEligibility(game)).toBe(null);
    expect(ratingEligibility({ ...game, rulesEdition: null })).toBe("legacy-edition");
    expect(ratingEligibility({ ...game, hasCasper: true })).toBe("casper");
    expect(ratingEligibility({ ...game, outcome: "cancelled" })).toBe("cancelled");
    expect(ratingEligibility({ ...game, participants: null })).toBe("incomplete-results");
    expect(ratingEligibility({ ...game, playedAt: null })).toBe("incomplete-results");
    expect(ratingEligibility({ ...game, participants: game.participants!.slice(1) })).toBe(
      "ineligible-roster",
    );
    for (const patch of [
      { playerId: playerIds[1]! },
      { seat: 2 },
      { role: "sheriff" as const },
      { team: "black" as const },
      { playerId: "casper" },
      { playerId: game.hostPlayerId! },
    ]) {
      expect(
        ratingEligibility({
          ...game,
          participants: game.participants!.map((row, i) => (i === 0 ? { ...row, ...patch } : row)),
        }),
      ).toBe("ineligible-roster");
    }
    expect(buildClubRatingLedger([game]).players.size).toBe(10);
  });

  it("rebuilds corrections/deletions, selects latest revision and sorts tied times by identity", () => {
    const first = statisticsGame(1);
    const second = statisticsGame(2, { playedAt: first.playedAt, outcome: "black" });
    const corrected = { ...first, revision: 2, outcome: "black" as const };
    const original = buildClubRatingLedger([second, first]);
    expect(buildClubRatingLedger([first, second])).toEqual(original);
    expect(buildClubRatingLedger([first, second, corrected])).toEqual(
      buildClubRatingLedger([corrected, second]),
    );
    expect(buildClubRatingLedger([corrected, second]).games.get(second.gameId)).not.toEqual(
      original.games.get(second.gameId),
    );
    expect(
      buildClubRatingLedger([second]).games.get(second.gameId)!.get(playerIds[0]!)!.change,
    ).toBe(-16);
    const adjudicated = statisticsGame(3, {
      outcome: "black",
      adjudication: {
        losingTeam: "red",
        rule: "opponent-victory",
        reason: "Referee",
        committeeApproved: true,
      },
    });
    expect(buildClubRatingLedger([adjudicated]).players.get(playerIds[0]!)!.value).toBe(1484);
  });
});
