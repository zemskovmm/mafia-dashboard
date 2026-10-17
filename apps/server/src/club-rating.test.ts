import { describe, expect, it } from "vitest";
import { buildClubRatingLedger, ratingEligibility } from "./club-rating.js";
import { playerIds, statisticsGame } from "./test-helpers/club-statistics-fixtures.js";
import { statisticsIdentityKey } from "./statistics-identity.js";

describe("club-team-elo-v1", () => {
  it("requires known roster, Casper and separate-host facts rather than treating unknown as eligible", () => {
    const game = statisticsGame(1);
    for (const patch of [
      { hasCasper: null },
      { rosterComplete: null },
      { hostPlayerId: null },
      { outcome: null },
      { playedAt: null },
    ]) {
      expect(ratingEligibility({ ...game, ...patch })).toBe("incomplete-results");
      expect(buildClubRatingLedger([{ ...game, ...patch }]).games.size).toBe(0);
    }
    expect(ratingEligibility({ ...game, rosterComplete: false })).toBe("ineligible-roster");
  });
  it("rates all current full records without engine metadata and ignores unrelated missing observations", () => {
    const games = [statisticsGame(1), statisticsGame(2, { outcome: "draw" })];
    const sparse = games.map((game) => ({
      ...game,
      timelineAvailable: false,
      participants: game.participants!.map((participant) => ({
        ...participant,
        status: null,
        fouls: null,
        bestMoveHits: null,
      })),
    }));
    for (const game of sparse) {
      expect(game).not.toHaveProperty("rulesEdition");
      expect(ratingEligibility(game)).toBeNull();
    }
    expect(buildClubRatingLedger(sparse)).toEqual(buildClubRatingLedger(games));
    expect(buildClubRatingLedger(sparse).players.get(playerIds[0]!)!.ratedGames).toBe(2);
  });

  it("keeps opaque player and game spellings distinct throughout the rating ledger", () => {
    const game = statisticsGame(1, { gameId: "Game-ID", hostPlayerId: "OPAQUE-ID" });
    const first = {
      ...game,
      participants: game.participants!.map((p, i) =>
        i < 2 ? { ...p, playerId: i === 0 ? "Opaque-ID" : "opaque-id" } : p,
      ),
    };
    const second = { ...first, gameId: "game-id", outcome: "draw" as const };
    const ledger = buildClubRatingLedger([second, first]);
    expect(ledger.games.size).toBe(2);
    expect(ledger.players.size).toBe(10);
    expect(ledger.players.get("Opaque-ID")!.ratedGames).toBe(2);
    expect(ledger.players.get("opaque-id")!.ratedGames).toBe(2);
    expect(ledger.players.has("OPAQUE-ID")).toBe(false);
    expect(ratingEligibility(first)).toBeNull();
  });

  it("keeps the saved cancellation reason even when chronology and other rating inputs are absent", () => {
    const game = statisticsGame(1, {
      outcome: "cancelled",
      playedAt: null,
      participants: null,
      hasCasper: null,
      rosterComplete: null,
      hostPlayerId: null,
    });
    expect(ratingEligibility(game)).toBe("cancelled");
    expect(buildClubRatingLedger([game]).games.size).toBe(0);
  });

  it("joins case-equivalent player and game UUIDs without rewriting authoritative inputs", () => {
    const first = statisticsGame(1);
    const second = statisticsGame(2, { outcome: "draw" });
    const mixed = [
      first,
      ...[first, second].map((game) => ({
        ...game,
        gameId: game.gameId.toUpperCase(),
        revision: 2,
        hostPlayerId: game.hostPlayerId!.toUpperCase(),
        participants: game.participants!.map((participant) => ({
          ...participant,
          playerId: participant.playerId.toUpperCase(),
        })),
      })),
    ];
    const before = JSON.stringify(mixed);
    expect(buildClubRatingLedger(mixed)).toEqual(buildClubRatingLedger([first, second]));
    expect(JSON.stringify(mixed)).toBe(before);
  });

  it("does not count a UUID alias as another human or a separate host", () => {
    const game = statisticsGame(1);
    expect(
      ratingEligibility({
        ...game,
        participants: game.participants!.map((participant, index) =>
          index === 0 ? { ...participant, playerId: playerIds[1]!.toUpperCase() } : participant,
        ),
      }),
    ).toBe("ineligible-roster");
    expect(ratingEligibility({ ...game, hostPlayerId: playerIds[0]!.toUpperCase() })).toBe(
      "ineligible-roster",
    );
  });

  it("folds only validated UUID spellings, never arbitrary opaque IDs", () => {
    expect(statisticsIdentityKey(playerIds[0]!.toUpperCase())).toBe(playerIds[0]);
    for (const id of ["Opaque-ID", "CASPER", `${playerIds[0]}X`, ` ${playerIds[0]}`]) {
      expect(statisticsIdentityKey(id)).toBe(id);
    }
  });

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

  it("rejects every ineligible roster without deleting retained opaque identities", () => {
    const game = statisticsGame(1);
    expect(ratingEligibility(game)).toBe(null);

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
      { seat: null },
      { seat: 0 },
      { seat: 11 },
      { seat: 1.5 },
      { role: null },
      { team: null },
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
