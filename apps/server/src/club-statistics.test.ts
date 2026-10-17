import { describe, expect, it } from "vitest";
import { buildClubRatingLedger } from "./club-rating.js";
import {
  getClubStatistics,
  getPlayerStatistics,
  StatisticsQueryError,
  statisticsHistoryQuerySchema,
} from "./club-statistics.js";
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
  it.each(["seat", "role", "team", "status", "fouls", "bestMoveHits"] as const)(
    "isolates a missing %s observation without poisoning another metric or participant",
    (field) => {
      const full = statisticsGame(1);
      const source = statisticsSource([
        {
          ...full,
          participants: full.participants!.map((p, i) => (i === 0 ? { ...p, [field]: null } : p)),
        },
      ]);
      expect(row(source)).toMatchObject({
        totals: { games: 1, outcomeGames: field === "team" ? 0 : 1, losses: 0 },
        teams: { red: { games: field === "team" ? 0 : 1 } },
        roles: { citizen: { games: field === "role" ? 0 : 1 } },
        foulGames: field === "fouls" ? 0 : 1,
        foulsPerGame: field === "fouls" ? null : 4,
        statusGames: field === "status" ? 0 : 1,
        bestMoveResults: field === "bestMoveHits" ? 0 : 1,
      });
      expect(row(source, playerIds[1]!)).toMatchObject({
        totals: { games: 1, outcomeGames: 1, wins: 1, winRate: 100 },
        foulGames: 1,
        foulsPerGame: 0,
        statusGames: 1,
        eliminations: 1,
      });
      expect(getClubStatistics(source).coverage.partialGames).toBe(
        field === "bestMoveHits" ? 0 : 1,
      );
    },
  );

  it("keeps the known participants useful when another participant observation is entirely absent", () => {
    const full = statisticsGame(1);
    const source = statisticsSource([
      { ...full, rosterComplete: false, participants: full.participants!.slice(1) },
    ]);
    expect(row(source).totals.games).toBe(0);
    expect(row(source, playerIds[1]!)).toMatchObject({
      totals: { games: 1, outcomeGames: 1, wins: 1 },
      foulGames: 1,
      statusGames: 1,
      eliminations: 1,
      rating: { ratedGames: 0 },
    });
    expect(getClubStatistics(source).coverage).toMatchObject({
      partialGames: 1,
      unavailableGames: 0,
    });
  });

  it("resolves an independently uppercase current directory against lowercase accepted participant facts", () => {
    const source = statisticsSource([statisticsGame(1)]);
    const mixed = {
      ...source,
      players: source.players.map((p) => ({ ...p, id: p.id.toUpperCase() })),
    };
    for (const id of [playerIds[0]!, playerIds[0]!.toUpperCase()]) {
      const detail = getPlayerStatistics(mixed, id);
      expect(detail.player).toMatchObject({
        playerId: playerIds[0]!.toUpperCase(),
        nickname: "Player 1",
        totals: { games: 1 },
        rating: { ratedGames: 1 },
      });
      expect(detail.history[0]!.participant!.playerId).toBe(playerIds[0]);
    }
  });

  it("counts observation-specific partial appearances without fabricating losses or denominators", () => {
    const full = statisticsGame(1);
    const unknownResult = statisticsGame(2, {
      outcome: null,
      hostPlayerId: null,
      participants: full.participants!.map((participant, i) =>
        i === 0 ? { ...participant, role: null, fouls: null, status: null } : participant,
      ),
    });
    const undatedDraw = statisticsGame(3, {
      playedAt: null,
      outcome: "draw",
      participants: full.participants!.map((participant, i) =>
        i === 0 ? { ...participant, team: null, fouls: 0, bestMoveHits: 0 } : participant,
      ),
    });
    const source = statisticsSource([full, unknownResult, undatedDraw]);
    expect(row(source)).toMatchObject({
      totals: { games: 3, outcomeGames: 2, wins: 1, draws: 1, losses: 0, winRate: 50 },
      teams: { red: { games: 2, outcomeGames: 1, wins: 1, winRate: 100 } },
      roles: { citizen: { games: 2, outcomeGames: 2, wins: 1, draws: 1 } },
      fouls: 4,
      foulGames: 2,
      foulsPerGame: 2,
      statusGames: 2,
      redCards: 2,
      bestMoveResults: 3,
      bestMoveHits: 4,
      recentForm: ["win"],
      lastPlayedAt: unknownResult.playedAt,
    });
    expect(row(source, playerIds[1]!)).toMatchObject({
      totals: { games: 3, outcomeGames: 2, wins: 1, draws: 1, losses: 0 },
      foulGames: 3,
      foulsPerGame: 0,
      statusGames: 3,
    });
    expect(getPlayerStatistics(source, playerIds[0]!).history).toHaveLength(3);
  });
  it("keeps independent role/team observations and distinguishes known zero from missing discipline and Best Move", () => {
    const full = statisticsGame(1);
    const game = statisticsGame(2, {
      hostPlayerId: null,
      rosterComplete: false,
      participants: [
        {
          ...full.participants![0]!,
          team: null,
          seat: null,
          fouls: null,
          status: null,
          bestMoveHits: null,
        },
        { ...full.participants![1]!, role: null, fouls: 0, status: "active", bestMoveHits: 0 },
      ],
    });
    const source = statisticsSource([game]);
    expect(row(source)).toMatchObject({
      totals: { games: 1, outcomeGames: 0, wins: 0, draws: 0, losses: 0, winRate: null },
      teams: { red: { games: 0 }, black: { games: 0 } },
      roles: { citizen: { games: 1, outcomeGames: 0, winRate: null } },
      fouls: 0,
      foulGames: 0,
      foulsPerGame: null,
      statusGames: 0,
      redCards: 0,
      eliminations: 0,
      bestMoveResults: 0,
      bestMoveHits: 0,
      bestMoveMean: null,
      recentForm: [],
      lastPlayedAt: game.playedAt,
    });
    expect(row(source, playerIds[1]!)).toMatchObject({
      totals: { games: 1, outcomeGames: 1, wins: 1, winRate: 100 },
      teams: { red: { games: 1, outcomeGames: 1, wins: 1 } },
      roles: { citizen: { games: 0 } },
      fouls: 0,
      foulGames: 1,
      foulsPerGame: 0,
      statusGames: 1,
      redCards: 0,
      eliminations: 0,
      bestMoveResults: 1,
      bestMoveHits: 0,
      bestMoveMean: 0,
    });
    const detail = getPlayerStatistics(source, playerIds[0]!);
    expect(detail.history[0]).toMatchObject({
      statisticsAvailable: true,
      participant: { team: null, role: "citizen", fouls: null, status: null },
      unratedReason: "incomplete-results",
    });
  });

  it("reports participant coverage independently from optional timeline, Best Move and host-only facts", () => {
    const full = statisticsGame(1);
    const normal = statisticsGame(1, {
      timelineAvailable: false,
      participants: full.participants!.map((participant) => ({
        ...participant,
        bestMoveHits: null,
      })),
    });
    expect(getClubStatistics(statisticsSource([normal])).coverage).toEqual({
      completedGames: 1,
      partialGames: 0,
      unavailableGames: 0,
      pendingGames: 0,
    });
    expect(getPlayerStatistics(statisticsSource([normal]), playerIds[0]!).history[0]).toMatchObject(
      {
        statisticsAvailable: true,
        timelineAvailable: false,
        unratedReason: null,
      },
    );
    const source = statisticsSource([
      normal,
      statisticsGame(2, {
        playedAt: null,
        outcome: null,
        hostPlayerId: null,
        hasCasper: null,
        rosterComplete: null,
        timelineAvailable: false,
        participants: [
          {
            playerId: playerIds[0]!,
            seat: null,
            role: null,
            team: null,
            status: null,
            fouls: null,
            bestMoveHits: null,
          },
        ],
      }),
      statisticsGame(3, { participants: null }),
      statisticsGame(4, { participants: [] }),
      statisticsGame(5, { participants: [{ ...full.participants![0]!, playerId: "casper" }] }),
      statisticsGame(6, {
        participants: [{ ...full.participants![0]!, playerId: playerIds[10]!.toUpperCase() }],
      }),
      statisticsGame(7, { status: "active", participants: null, outcome: null, playedAt: null }),
    ]);
    expect(getClubStatistics(source).coverage).toEqual({
      completedGames: 6,
      partialGames: 1,
      unavailableGames: 4,
      pendingGames: 1,
    });
    expect(row(source)).toMatchObject({
      totals: { games: 2, outcomeGames: 1 },
      rating: { ratedGames: 1 },
    });
    expect(row(source, playerIds[10]!)).toMatchObject({
      hostedGames: 5,
      lastHostedAt: source.games[5]!.playedAt,
      totals: { games: 0 },
    });
    expect(getPlayerStatistics(source, playerIds[0]!).history[1]).toMatchObject({
      playedAt: null,
      outcome: null,
      hasCasper: null,
      timelineAvailable: false,
      statisticsAvailable: true,
    });
    expect(getPlayerStatistics(source, playerIds[10]!).history).toHaveLength(5);
  });

  it("retains undated cancellation history without performance credit and counts independent undated hosting", () => {
    const source = statisticsSource([
      statisticsGame(1, { playedAt: null, outcome: null, participants: null }),
      statisticsGame(2, { playedAt: null, outcome: "cancelled" }),
    ]);
    expect(row(source, playerIds[10]!)).toMatchObject({ hostedGames: 1, lastHostedAt: null });
    expect(row(source)).toMatchObject({
      totals: { games: 0, outcomeGames: 0, winRate: null },
      foulGames: 0,
      statusGames: 0,
      bestMoveResults: 0,
      lastPlayedAt: null,
      recentForm: [],
    });
    expect(getPlayerStatistics(source, playerIds[0]!).history).toMatchObject([
      { playedAt: null, outcome: "cancelled", unratedReason: "cancelled", ratingChange: null },
    ]);
  });

  it("uses only timed known outcomes for recent form while last played includes a timed unknown result", () => {
    const games = Array.from({ length: 7 }, (_, i) =>
      statisticsGame(i + 1, {
        outcome: i % 3 === 0 ? "red" : i % 3 === 1 ? "draw" : "black",
      }),
    );
    const source = statisticsSource([
      statisticsGame(10, { outcome: "cancelled" }),
      statisticsGame(9, { playedAt: null, outcome: "draw" }),
      ...[...games].reverse(),
      statisticsGame(8, { outcome: null }),
    ]);
    expect(row(source)).toMatchObject({
      totals: { games: 9, outcomeGames: 8, wins: 3, draws: 3, losses: 2 },
      lastPlayedAt: source.games.at(-1)!.playedAt,
      recentForm: ["win", "loss", "draw", "win", "loss"],
    });
  });

  it("excludes only observations missing the active date/team/role filter and rejects edition queries", () => {
    const full = statisticsGame(1);
    const source = statisticsSource([
      statisticsGame(1, { playedAt: null }),
      statisticsGame(2, {
        participants: full.participants!.map((p, i) => (i === 0 ? { ...p, team: null } : p)),
      }),
      statisticsGame(3, {
        participants: full.participants!.map((p, i) => (i === 0 ? { ...p, role: null } : p)),
      }),
    ]);
    expect(
      getPlayerStatistics(source, playerIds[0]!, { from: "2026-01-01" }).history.map(
        ({ gameId }) => gameId,
      ),
    ).toEqual([source.games[2]!.gameId, source.games[1]!.gameId]);
    expect(getPlayerStatistics(source, playerIds[0]!, { to: "2026-01-03" }).total).toBe(2);
    expect(row(source, playerIds[0]!, { team: "red" }).totals).toMatchObject({
      games: 2,
      outcomeGames: 2,
    });
    expect(row(source, playerIds[0]!, { role: "citizen" }).totals).toMatchObject({
      games: 2,
      outcomeGames: 1,
    });
    expect(row(source, playerIds[0]!, { team: "red", role: "citizen" }).totals.games).toBe(1);
    expect(getPlayerStatistics(source, playerIds[10]!, { role: "citizen" }).history).toEqual([]);
    expect(() => getClubStatistics(source, { edition: "legacy" } as never)).toThrow(
      StatisticsQueryError,
    );
    expect(statisticsHistoryQuerySchema.safeParse({ edition: "federation" }).success).toBe(false);
    expect(() =>
      getClubStatistics(source, { tournamentId: "abcdef01-0000-4000-8000-000000000099" }),
    ).toThrow(StatisticsQueryError);
  });

  it("pages dated then stable undated identities without duplicates, lost rows or fabricated cursor times", () => {
    const games = [9, 2, 7, 1, 8, 3, 6].map((i) =>
      statisticsGame(i, {
        ...(i > 3 ? { playedAt: null } : {}),
      }),
    );
    const source = statisticsSource(games);
    const ids: string[] = [];
    let cursor: string | undefined;
    let sawNullCursor = false;
    let pages = 0;
    do {
      expect(++pages).toBeLessThanOrEqual(games.length);
      const page = getPlayerStatistics(
        source,
        playerIds[0]!,
        {},
        { limit: 2, ...(cursor === undefined ? {} : { cursor }) },
      );
      ids.push(...page.history.map(({ gameId }) => gameId));
      expect(page.player!.totals.games).toBe(7);
      expect(page.total).toBe(7);
      cursor = page.nextCursor ?? undefined;
      if (cursor !== undefined) {
        const [time, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as [
          string | null,
          string,
        ];
        if (time === null) {
          sawNullCursor = true;
          cursor = Buffer.from(JSON.stringify([null, id.toUpperCase()])).toString("base64url");
        }
      }
    } while (cursor !== undefined);
    expect(ids).toEqual([3, 2, 1, 9, 8, 7, 6].map((i) => statisticsGame(i).gameId));
    expect(new Set(ids).size).toBe(7);
    expect(sawNullCursor).toBe(true);
    expect(
      getPlayerStatistics(statisticsSource([...games].reverse()), playerIds[0]!).history.map(
        ({ gameId }) => gameId,
      ),
    ).toEqual(ids);
    for (const value of [
      [null, 1],
      ["invalid", games[0]!.gameId],
      [null, games[0]!.gameId, 0],
      [null, "missing"],
    ]) {
      expect(() =>
        getPlayerStatistics(
          source,
          playerIds[0]!,
          {},
          {
            cursor: Buffer.from(JSON.stringify(value)).toString("base64url"),
          },
        ),
      ).toThrow(StatisticsQueryError);
    }
    const first = getPlayerStatistics(source, playerIds[0]!, {}, { limit: 1 });
    expect(() =>
      getPlayerStatistics(
        source,
        playerIds[0]!,
        { to: "2026-01-01" },
        { cursor: first.nextCursor! },
      ),
    ).toThrow(StatisticsQueryError);
  });

  it("preserves case-sensitive opaque identities and deeply frozen accepted factual/canonical material", () => {
    const full = statisticsGame(1);
    const participants = full.participants!.map((p, i) =>
      i < 2 ? { ...p, playerId: i === 0 ? "Opaque-ID" : "opaque-id" } : p,
    );
    const first = {
      ...full,
      gameId: "opaque-game",
      playedAt: null,
      participants,
      canonical: { hash: "retained-hash", events: [{ secret: true, raw: "unchanged" }] },
    };
    const source = {
      ...statisticsSource([first, { ...first, gameId: "OPAQUE-game" }]),
      players: [
        { id: "Opaque-ID", nickname: "A" },
        { id: "opaque-id", nickname: "B" },
      ],
    };
    const freeze = (value: unknown): void => {
      if (value !== null && typeof value === "object") {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
      }
    };
    const before = JSON.stringify(source);
    freeze(source);
    expect(getClubStatistics(source).players.map(({ playerId }) => playerId)).toEqual([
      "Opaque-ID",
      "opaque-id",
    ]);
    expect(getPlayerStatistics(source, "OPAQUE-ID").player).toBeNull();
    for (const id of ["Opaque-ID", "opaque-id"]) {
      const firstPage = getPlayerStatistics(source, id, {}, { limit: 1 });
      const secondPage = getPlayerStatistics(source, id, {}, { cursor: firstPage.nextCursor! });
      expect(firstPage.player!.totals.games).toBe(2);
      expect([firstPage.history[0]!.gameId, secondPage.history[0]!.gameId]).toEqual([
        "opaque-game",
        "OPAQUE-game",
      ]);
    }
    buildClubRatingLedger(source.games);
    expect(JSON.stringify(source)).toBe(before);
  });

  it("shares case-equivalent profiles, history cursors and tournament scope without changing source bytes", () => {
    const first = statisticsGame(1, { tournamentId: tournamentA });
    const second = statisticsGame(2, { tournamentId: tournamentA });
    const mixed = {
      ...second,
      gameId: second.gameId.toUpperCase(),
      hostPlayerId: second.hostPlayerId!.toUpperCase(),
      tournamentId: tournamentA.toUpperCase(),
      participants: second.participants!.map((participant) => ({
        ...participant,
        playerId: participant.playerId.toUpperCase(),
      })),
    };
    const source = statisticsSource([first, mixed]);
    const before = JSON.stringify(source);
    const filters = { tournamentId: tournamentA.toUpperCase() };
    expect(getClubStatistics(source, filters)).toEqual(
      getClubStatistics(statisticsSource([first, second]), { tournamentId: tournamentA }),
    );
    const detail = getPlayerStatistics(source, playerIds[0]!.toUpperCase(), filters, { limit: 1 });
    expect(detail.player).toMatchObject({
      nickname: "Player 1",
      totals: { games: 2 },
      rating: { ratedGames: 2 },
    });
    expect(detail.history[0]!.participant!.playerId).toBe(playerIds[0]!.toUpperCase());
    const cursor = Buffer.from(JSON.stringify([second.playedAt, second.gameId])).toString(
      "base64url",
    );
    const next = getPlayerStatistics(source, playerIds[0]!, filters, { cursor });
    expect(next.history.map(({ gameId }) => gameId)).toEqual([first.gameId]);
    expect(next.nextCursor).toBeNull();
    const retired = { ...source, players: source.players.slice(1) };
    expect(getPlayerStatistics(retired, playerIds[0]!.toUpperCase()).player).toMatchObject({
      nickname: "",
      totals: { games: 2 },
      rating: detail.player!.rating,
    });
    expect(JSON.stringify(source)).toBe(before);
  });

  it("separates hosting from participation when a host reference changes UUID case", () => {
    const source = statisticsSource([
      statisticsGame(1, { hostPlayerId: playerIds[0]!.toUpperCase() }),
    ]);
    const detail = getPlayerStatistics(source, playerIds[0]!);
    expect(detail.player).toMatchObject({
      totals: { games: 0 },
      hostedGames: 1,
      rating: { ratedGames: 0 },
    });
    expect(detail.history).toHaveLength(1);
    expect(detail.history[0]).toMatchObject({
      isHost: true,
      participant: null,
      unratedReason: "ineligible-roster",
    });
  });

  it("distinguishes factual denominators, hosts, Casper, cancellation, incomplete and pending coverage", () => {
    const source = statisticsSource([
      statisticsGame(1),
      statisticsGame(2, { outcome: "draw" }),
      statisticsGame(3, { outcome: "black", hasCasper: true }),
      statisticsGame(4, { outcome: "cancelled" }),
      statisticsGame(5, { participants: null }),
      statisticsGame(6, { status: "active", participants: null, outcome: null, playedAt: null }),
    ]);
    const result = getClubStatistics(source);
    expect(result.coverage).toEqual({
      completedGames: 5,
      partialGames: 0,
      unavailableGames: 1,
      pendingGames: 1,
    });
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
      rating: { value: 1515, ratedGames: 2, status: "provisional", rank: null },
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
      statisticsGame(1, { hasCasper: true, tournamentId: tournamentA }),
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
