import { describe, expect, it } from "vitest";
import { buildClubRatingLedger } from "./club-rating.js";
import { getClubStatistics, getPlayerStatistics, StatisticsQueryError } from "./club-statistics.js";
import {
  playerIds,
  statisticsGame,
  statisticsSource,
  tournamentA,
  tournamentB,
} from "./test-helpers/club-statistics-fixtures.js";

const row = (source: ReturnType<typeof statisticsSource>, id = playerIds[0]!, filters = {}) =>
  getClubStatistics(source, filters).players.find(({ playerId }) => playerId === id)!;

describe("club statistics", () => {
  it("distinguishes factual denominators, hosts, formats, cancellation, incomplete and pending coverage", () => {
    const source = statisticsSource([
      statisticsGame(1),
      statisticsGame(2, { outcome: "draw", rulesEdition: null }),
      statisticsGame(3, { outcome: "black", hasCasper: true }),
      statisticsGame(4, { outcome: "cancelled" }),
      statisticsGame(5, { participants: null }),
      statisticsGame(6, { status: "active", participants: null, outcome: null, playedAt: null }),
    ]);
    const result = getClubStatistics(source);
    expect(result.coverage).toEqual({ completedGames: 5, unavailableGames: 1, pendingGames: 1 });
    const player = row(source);
    expect(player.totals).toMatchObject({ games: 3, wins: 1, draws: 1, losses: 1 });
    expect(player.totals.winRate).toBeCloseTo(100 / 3, 12);
    expect(player.teams.red).toEqual(player.totals);
    expect(player.roles.citizen).toEqual(player.totals);
    expect(player).toMatchObject({
      fouls: 12,
      foulsPerGame: 4,
      redCards: 3,
      eliminations: 0,
      bestMoveResults: 3,
      bestMoveHits: 6,
      bestMoveMean: 2,
      hostedGames: 0,
      recentForm: ["loss", "draw", "win"],
      rating: { value: 1516, ratedGames: 1, status: "provisional", rank: null },
    });
    expect(row(source, playerIds[10]!)).toMatchObject({
      hostedGames: 4,
      lastPlayedAt: null,
      totals: { games: 0, winRate: null },
      rating: { value: null, status: "unranked" },
    });
    const history = getPlayerStatistics(source, playerIds[10]!);
    expect(history.history).toHaveLength(5);
    expect(history.history[0]).toMatchObject({
      statisticsAvailable: false,
      isHost: true,
      participant: null,
      unratedReason: "incomplete-results",
    });
    expect(getPlayerStatistics(source, playerIds[0]!).history[0]).toMatchObject({
      outcome: "cancelled",
      ratingChange: null,
      unratedReason: "cancelled",
    });
  });

  it("selects interleaved tournament ledger entries only, rounds once and never retrains lifetime rank", () => {
    const games = [
      statisticsGame(1, { tournamentId: tournamentA }),
      statisticsGame(2),
      statisticsGame(3, { tournamentId: tournamentB, outcome: "black" }),
      statisticsGame(4, { tournamentId: tournamentA, outcome: "draw" }),
    ];
    const source = statisticsSource(games);
    const ledger = buildClubRatingLedger(games);
    const expected = games
      .filter(({ tournamentId }) => tournamentId === tournamentA)
      .reduce((sum, game) => sum + ledger.games.get(game.gameId)!.get(playerIds[0]!)!.change, 0);
    const scoped = row(source, playerIds[0]!, { tournamentId: tournamentA });
    expect(scoped.scopedRatingChange).toBe(Math.round(expected * 10) / 10);
    expect(scoped.scopedRatedGames).toBe(2);
    expect(scoped.totals.games).toBe(2);
    expect(scoped.rating).toEqual(row(source).rating);
    expect(
      row(source, playerIds[0]!, { tournamentId: tournamentA, from: "2026-01-04" }),
    ).toMatchObject({
      scopedRatedGames: 1,
      totals: { games: 1 },
      rating: scoped.rating,
    });
    expect(
      getClubStatistics(source, { tournamentId: tournamentB, role: "sheriff" }).players.map(
        ({ playerId }) => playerId,
      ),
    ).toEqual([playerIds[6]]);
    const moved = statisticsSource(
      games.map((game, index) => (index === 0 ? { ...game, tournamentId: tournamentB } : game)),
    );
    expect(row(moved).rating).toEqual(row(source).rating);
    expect(row(moved, playerIds[0]!, { tournamentId: tournamentA }).scopedRatedGames).toBe(1);
    const corrected = statisticsSource(
      games.map((game, i) =>
        i === 1 ? { ...game, revision: 2, outcome: "black" as const } : game,
      ),
    );
    expect(
      row(corrected, playerIds[0]!, { tournamentId: tournamentA }).scopedRatingChange,
    ).not.toBe(scoped.scopedRatingChange);
    const deleted = statisticsSource(games.filter((_, i) => i !== 1));
    expect(row(deleted, playerIds[0]!, { tournamentId: tournamentA }).scopedRatingChange).not.toBe(
      scoped.scopedRatingChange,
    );
    expect(getClubStatistics(source, { tournamentId: "none" }).players).toHaveLength(11);
    expect(getClubStatistics(statisticsSource([]), { tournamentId: tournamentA }).players).toEqual(
      [],
    );
    const zero = statisticsSource([
      statisticsGame(1, { outcome: "draw", tournamentId: tournamentA }),
    ]);
    expect(row(zero, playerIds[0]!, { tournamentId: tournamentA })).toMatchObject({
      scopedRatingChange: 0,
      scopedRatedGames: 1,
    });
    const unrated = statisticsSource([
      statisticsGame(1, { rulesEdition: null, tournamentId: tournamentA }),
    ]);
    expect(row(unrated, playerIds[0]!, { tournamentId: tournamentA })).toMatchObject({
      scopedRatingChange: null,
      scopedRatedGames: 0,
    });
  });

  it("sums multiple fractional deltas at full precision before rounding the scope once", () => {
    const games = Array.from({ length: 20 }, (_, i) =>
      statisticsGame(i + 1, {
        outcome: i % 3 === 0 ? "black" : i % 3 === 1 ? "red" : "draw",
        tournamentId: i % 2 === 0 ? tournamentA : null,
      }),
    );
    const ledger = buildClubRatingLedger(games);
    const deltas = games
      .filter(({ tournamentId }) => tournamentId === tournamentA)
      .map(({ gameId }) => ledger.games.get(gameId)!.get(playerIds[0]!)!.change);
    const roundOnce = Math.round(deltas.reduce((sum, value) => sum + value, 0) * 10) / 10;
    const roundEach =
      Math.round(deltas.reduce((sum, value) => sum + Math.round(value * 10) / 10, 0) * 10) / 10;
    expect(roundOnce).toBe(-14.1);
    expect(roundEach).toBe(-14);
    expect(
      row(statisticsSource(games), playerIds[0]!, { tournamentId: tournamentA }).scopedRatingChange,
    ).toBe(roundOnce);
  });

  it("uses dense displayed ranks after ten games and preserves retired identities in the ledger only", () => {
    const games = Array.from({ length: 10 }, (_, i) => statisticsGame(i + 1));
    const nine = statisticsSource(games.slice(0, 9));
    expect(row(nine).rating).toMatchObject({ status: "provisional", rank: null });
    const source = statisticsSource(games);
    expect(row(source).rating).toMatchObject({ status: "established", rank: 1, ratedGames: 10 });
    expect(row(source, playerIds[6]!).rating.rank).toBe(1);
    expect(row(source, playerIds[9]!).rating.rank).toBe(2);
    const retired = { ...source, players: source.players.filter(({ id }) => id !== playerIds[0]) };
    expect(
      getClubStatistics(retired).players.some(({ playerId }) => playerId === playerIds[0]),
    ).toBe(false);
    expect(row(retired, playerIds[1]!).rating).toEqual(row(source, playerIds[1]!).rating);
    expect(getPlayerStatistics(retired, playerIds[0]!).player).toMatchObject({
      nickname: "",
      totals: { games: 10 },
    });
    expect(row(source, playerIds[9]!, { team: "black", from: "2026-01-10" }).rating.rank).toBe(2);
  });

  it("pages a stable complete history with bounded validated cursors and inclusive UTC calendar dates", () => {
    const source = statisticsSource(Array.from({ length: 105 }, (_, i) => statisticsGame(i + 1)));
    const first = getPlayerStatistics(source, playerIds[0]!);
    expect(first.history).toHaveLength(50);
    expect(first.total).toBe(105);
    expect(first.player!.totals.games).toBe(105);
    const second = getPlayerStatistics(
      source,
      playerIds[0]!,
      {},
      { cursor: first.nextCursor!, limit: 100 },
    );
    expect(second.history).toHaveLength(55);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.history, ...second.history].map(({ gameId }) => gameId)).size).toBe(
      105,
    );
    for (const page of [{ limit: 101 }, { limit: 0 }, { limit: 1.5 }, { cursor: "garbage" }]) {
      expect(() => getPlayerStatistics(source, playerIds[0]!, {}, page)).toThrow(
        StatisticsQueryError,
      );
    }
    const offset = statisticsSource([statisticsGame(1, { playedAt: "2026-01-02T00:30:00+01:00" })]);
    expect(row(offset, playerIds[0]!, { from: "2026-01-01", to: "2026-01-01" }).totals.games).toBe(
      1,
    );
    for (const filters of [{ from: "2026-02-30" }, { from: "2026-02-02", to: "2026-02-01" }]) {
      expect(() => getClubStatistics(source, filters)).toThrow(StatisticsQueryError);
    }
    expect(getPlayerStatistics(source, "30000000-0000-4000-8000-000000000001").player).toBeNull();
  });
});
