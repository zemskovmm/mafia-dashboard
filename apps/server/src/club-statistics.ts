import { CASPER_PLAYER_ID, FEDERATION_RULES_EDITION } from "@mafia/game-domain";
import type {
  ClubRatingSummary,
  ClubStatisticsResponse,
  ClubStatisticsSource,
  PlayerStatisticsResponse,
  PlayerStatisticsRow,
  StatisticsFilters,
  StatisticsGame,
  StatisticsHistoryGame,
  StatisticsHistoryPage,
  StatisticsParticipant,
  StatisticsTotals,
} from "@mafia/game-domain";
import { z } from "zod";
import {
  buildClubRatingLedger,
  CLUB_RATING_ALGORITHM,
  compareStatisticsGames,
  latestStatisticsGames,
  ratingEligibility,
} from "./club-rating.js";

export class StatisticsQueryError extends Error {
  readonly code = "invalid_statistics_query";
}
const filterShape = {
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  edition: z.enum(["federation", "legacy"]).optional(),
  team: z.enum(["red", "black"]).optional(),
  role: z.enum(["citizen", "sheriff", "mafia", "don"]).optional(),
  tournamentId: z.union([z.uuid(), z.literal("none")]).optional(),
};
const validRange = (value: { from?: string; to?: string }) =>
  value.from === undefined || value.to === undefined || value.from <= value.to;
export const statisticsFiltersSchema = z
  .object(filterShape)
  .strict()
  .refine(validRange, { path: ["to"], message: "to must not precede from" });
export const statisticsHistoryQuerySchema = z
  .object({
    ...filterShape,
    cursor: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict()
  .refine(validRange, { path: ["to"], message: "to must not precede from" });

const roundChange = (value: number) => Math.round(value * 10) / 10 || 0;
const emptyTotals = (): StatisticsTotals => ({
  games: 0,
  wins: 0,
  draws: 0,
  losses: 0,
  winRate: null,
});
const addOutcome = (
  totals: StatisticsTotals,
  outcome: "win" | "draw" | "loss",
): StatisticsTotals => {
  const wins = totals.wins + Number(outcome === "win");
  const games = totals.games + 1;
  return {
    games,
    wins,
    draws: totals.draws + Number(outcome === "draw"),
    losses: totals.losses + Number(outcome === "loss"),
    winRate: (wins / games) * 100,
  };
};
const available = (game: StatisticsGame): boolean =>
  game.participants !== null && game.participants.length > 0;
const completed = (game: StatisticsGame): boolean =>
  game.status === "completed" &&
  game.outcome !== null &&
  game.playedAt !== null &&
  Number.isFinite(Date.parse(game.playedAt));
const participantMatches = (participant: StatisticsParticipant, filters: StatisticsFilters) =>
  (filters.team === undefined || participant.team === filters.team) &&
  (filters.role === undefined || participant.role === filters.role);
const gameMatches = (game: StatisticsGame, filters: StatisticsFilters): boolean => {
  const date =
    game.playedAt === null || !Number.isFinite(Date.parse(game.playedAt))
      ? null
      : new Date(game.playedAt).toISOString().slice(0, 10);
  return (
    (filters.from === undefined || (date !== null && date >= filters.from)) &&
    (filters.to === undefined || (date !== null && date <= filters.to)) &&
    (filters.edition === undefined ||
      (filters.edition === "federation"
        ? game.rulesEdition === FEDERATION_RULES_EDITION
        : game.rulesEdition === null)) &&
    (filters.tournamentId === undefined ||
      (filters.tournamentId === "none"
        ? game.tournamentId === null
        : game.tournamentId === filters.tournamentId))
  );
};
const summary = (
  value?: { value: number; ratedGames: number; lastChange: number },
  rank: number | null = null,
): ClubRatingSummary => ({
  algorithm: CLUB_RATING_ALGORITHM,
  value: value === undefined ? null : Math.round(value.value),
  ratedGames: value?.ratedGames ?? 0,
  status: value === undefined ? "unranked" : value.ratedGames < 10 ? "provisional" : "established",
  rank,
  lastChange: value === undefined ? null : roundChange(value.lastChange),
});
const emptyPlayer = (
  playerId: string,
  nickname: string,
  rating: ClubRatingSummary,
): PlayerStatisticsRow => ({
  playerId,
  nickname,
  totals: emptyTotals(),
  teams: { red: emptyTotals(), black: emptyTotals() },
  roles: {
    citizen: emptyTotals(),
    sheriff: emptyTotals(),
    mafia: emptyTotals(),
    don: emptyTotals(),
  },
  fouls: 0,
  foulsPerGame: null,
  redCards: 0,
  eliminations: 0,
  bestMoveResults: 0,
  bestMoveHits: 0,
  bestMoveMean: null,
  hostedGames: 0,
  lastHostedAt: null,
  lastPlayedAt: null,
  recentForm: [],
  rating,
  scopedRatingChange: null,
  scopedRatedGames: 0,
});

const aggregate = (source: ClubStatisticsSource, inputFilters: StatisticsFilters) => {
  const parsed = statisticsFiltersSchema.safeParse(inputFilters);
  if (!parsed.success) throw new StatisticsQueryError("Invalid statistics filters");
  const filters = parsed.data;
  if (
    filters.tournamentId !== undefined &&
    filters.tournamentId !== "none" &&
    !source.tournaments.some(({ id }) => id === filters.tournamentId)
  ) {
    throw new StatisticsQueryError("Tournament not found in selected club");
  }
  const games = latestStatisticsGames(source.games);
  const ledger = buildClubRatingLedger(games);
  const ratings = new Map(source.players.map(({ id }) => [id, summary(ledger.players.get(id))]));
  const establishedValues = [
    ...new Set(
      [...ratings.values()]
        .filter(({ status }) => status === "established")
        .map(({ value }) => value!),
    ),
  ].sort((a, b) => b - a);
  for (const [id, rating] of ratings)
    if (rating.status === "established")
      ratings.set(id, { ...rating, rank: establishedValues.indexOf(rating.value!) + 1 });
  const players = new Map(
    source.players
      .filter(({ id }) => id !== CASPER_PLAYER_ID)
      .map(({ id, nickname }) => [id, emptyPlayer(id, nickname, ratings.get(id)!)]),
  );
  const ensurePlayer = (id: string): PlayerStatisticsRow => {
    let player = players.get(id);
    if (player === undefined) {
      // Empty display name deliberately delegates the anonymous label to localization.
      player = emptyPlayer(id, "", summary(ledger.players.get(id)));
      players.set(id, player);
    }
    return player;
  };
  // Retained participants/hosts remain queryable, but never re-enter the current leaderboard.
  for (const game of games) {
    if (game.hostPlayerId !== null && game.hostPlayerId !== CASPER_PLAYER_ID)
      ensurePlayer(game.hostPlayerId);
    for (const participant of game.participants ?? [])
      if (participant.playerId !== CASPER_PLAYER_ID) ensurePlayer(participant.playerId);
  }
  const histories = new Map<string, StatisticsHistoryGame[]>();
  const appearances = new Set<string>();
  const scopedChanges = new Map<string, number>();
  let completedGames = 0;
  let unavailableGames = 0;
  let pendingGames = 0;
  for (const game of games
    .filter((game) => gameMatches(game, filters))
    .sort((a, b) => -compareStatisticsGames(a, b))) {
    if (game.status === "active") {
      pendingGames++;
      continue;
    }
    // Missing completion metadata cannot become a fabricated history/result row.
    completedGames++;
    if (!completed(game) || !available(game)) unavailableGames++;
    if (!completed(game)) continue;
    const participants = new Map(
      (game.participants ?? [])
        .filter(
          (participant) =>
            participant.playerId !== CASPER_PLAYER_ID &&
            participant.playerId !== game.hostPlayerId &&
            participantMatches(participant, filters),
        )
        .map((participant) => [participant.playerId, participant]),
    );
    const ids = new Set(participants.keys());
    if (
      game.hostPlayerId !== null &&
      game.hostPlayerId !== CASPER_PLAYER_ID &&
      filters.team === undefined &&
      filters.role === undefined
    )
      ids.add(game.hostPlayerId);
    for (const id of ids) {
      const previous = ensurePlayer(id);
      appearances.add(id);
      const participant = participants.get(id) ?? null;
      const isHost = game.hostPlayerId === id;
      const ratingChange =
        participant === null ? null : (ledger.games.get(game.gameId)?.get(id) ?? null);
      const eligibility = ratingEligibility(game);
      const history: StatisticsHistoryGame = {
        gameId: game.gameId,
        name: game.name,
        playedAt: game.playedAt!,
        rulesEdition: game.rulesEdition,
        hasCasper: game.hasCasper,
        outcome: game.outcome!,
        reason: game.reason,
        ...(game.adjudication === undefined ? {} : { adjudication: game.adjudication }),
        tournamentId: game.tournamentId,
        hostPlayerId: game.hostPlayerId,
        participant,
        isHost,
        statisticsAvailable: available(game),
        unratedReason: eligibility ?? (isHost ? "host" : null),
        ratingChange,
      };
      const historyRows = histories.get(id) ?? [];
      historyRows.push(history);
      histories.set(id, historyRows);
      if (game.outcome === "cancelled") continue;
      if (isHost) {
        players.set(id, {
          ...previous,
          hostedGames: previous.hostedGames + 1,
          lastHostedAt: previous.lastHostedAt ?? game.playedAt,
        });
      } else if (participant !== null && available(game)) {
        const outcome: "win" | "draw" | "loss" =
          game.outcome === "draw" ? "draw" : game.outcome === participant.team ? "win" : "loss";
        const totals = addOutcome(previous.totals, outcome);
        const fouls = previous.fouls + participant.fouls;
        const bestMoveResults =
          previous.bestMoveResults + Number(participant.bestMoveHits !== null);
        const bestMoveHits = previous.bestMoveHits + (participant.bestMoveHits ?? 0);
        if (ratingChange !== null)
          scopedChanges.set(id, (scopedChanges.get(id) ?? 0) + ratingChange.change);
        players.set(id, {
          ...previous,
          totals,
          teams: {
            ...previous.teams,
            [participant.team]: addOutcome(previous.teams[participant.team], outcome),
          },
          roles: {
            ...previous.roles,
            [participant.role]: addOutcome(previous.roles[participant.role], outcome),
          },
          fouls,
          foulsPerGame: fouls / totals.games,
          redCards: previous.redCards + Number(participant.status === "red-carded"),
          eliminations: previous.eliminations + Number(participant.status === "eliminated"),
          bestMoveResults,
          bestMoveHits,
          bestMoveMean: bestMoveResults === 0 ? null : bestMoveHits / bestMoveResults,
          lastPlayedAt: previous.lastPlayedAt ?? game.playedAt,
          recentForm: [...previous.recentForm, outcome].slice(0, 5),
          scopedRatedGames: previous.scopedRatedGames + Number(ratingChange !== null),
        });
      }
    }
  }
  for (const [id, change] of scopedChanges)
    players.set(id, { ...players.get(id)!, scopedRatingChange: roundChange(change) });
  const isScoped = Object.keys(filters).some(
    (key) => filters[key as keyof StatisticsFilters] !== undefined,
  );
  const order = { established: 0, provisional: 1, unranked: 2 };
  const leaderboard = source.players
    .filter(({ id }) => id !== CASPER_PLAYER_ID && (!isScoped || appearances.has(id)))
    .map(({ id }) => players.get(id)!)
    .sort(
      (a, b) =>
        order[a.rating.status] - order[b.rating.status] ||
        (b.rating.value ?? 0) - (a.rating.value ?? 0) ||
        a.nickname.localeCompare(b.nickname, "en") ||
        a.playerId.localeCompare(b.playerId, "en"),
    );
  return {
    players,
    histories,
    response: {
      players: leaderboard,
      tournaments: source.tournaments,
      coverage: { completedGames, unavailableGames, pendingGames },
      algorithm: CLUB_RATING_ALGORITHM,
    } satisfies ClubStatisticsResponse,
  };
};

export const getClubStatistics = (
  source: ClubStatisticsSource,
  filters: StatisticsFilters = {},
): ClubStatisticsResponse => aggregate(source, filters).response;

const cursorSchema = z.tuple([z.iso.datetime({ offset: true }), z.uuid()]);
const encodeCursor = (row: StatisticsHistoryGame) =>
  Buffer.from(JSON.stringify([row.playedAt, row.gameId])).toString("base64url");
export const getPlayerStatistics = (
  source: ClubStatisticsSource,
  playerId: string,
  filters: StatisticsFilters = {},
  page: StatisticsHistoryPage = {},
): PlayerStatisticsResponse => {
  const limit = page.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new StatisticsQueryError("Invalid history limit");
  const data = aggregate(source, filters);
  const player = data.players.get(playerId) ?? null;
  const rows = data.histories.get(playerId) ?? [];
  let start = 0;
  if (page.cursor !== undefined) {
    try {
      if (!/^[A-Za-z0-9_-]{1,512}$/.test(page.cursor)) throw new Error("Invalid cursor encoding");
      const decoded = Buffer.from(page.cursor, "base64url");
      if (decoded.toString("base64url") !== page.cursor) throw new Error("Noncanonical cursor");
      const [playedAt, gameId] = cursorSchema.parse(JSON.parse(decoded.toString("utf8")));
      const index = rows.findIndex((row) => row.playedAt === playedAt && row.gameId === gameId);
      if (index < 0) throw new Error("Cursor not found in selected history");
      start = index + 1;
    } catch {
      throw new StatisticsQueryError("Invalid history cursor");
    }
  }
  const history = rows.slice(start, start + limit);
  return {
    player,
    history,
    total: rows.length,
    nextCursor:
      start + history.length < rows.length ? encodeCursor(history[history.length - 1]!) : null,
  };
};
