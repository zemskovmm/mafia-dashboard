import { CASPER_PLAYER_ID } from "@mafia/game-domain";
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
import { statisticsIdentityKey as identityKey } from "./statistics-identity.js";
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
  outcomeGames: 0,
  wins: 0,
  draws: 0,
  losses: 0,
  winRate: null,
});
const addAppearance = (
  totals: StatisticsTotals,
  outcome: "win" | "draw" | "loss" | null,
): StatisticsTotals => {
  const wins = totals.wins + Number(outcome === "win");
  const games = totals.games + 1;
  const outcomeGames = totals.outcomeGames + Number(outcome !== null);
  return {
    games,
    outcomeGames,
    wins,
    draws: totals.draws + Number(outcome === "draw"),
    losses: totals.losses + Number(outcome === "loss"),
    winRate: outcomeGames === 0 ? null : (wins / outcomeGames) * 100,
  };
};
const playedTime = (game: StatisticsGame): string | null =>
  game.playedAt !== null && Number.isFinite(Date.parse(game.playedAt)) ? game.playedAt : null;
const humanParticipants = (game: StatisticsGame) =>
  (game.participants ?? []).filter(
    ({ playerId }) =>
      playerId !== CASPER_PLAYER_ID &&
      (game.hostPlayerId === null || identityKey(playerId) !== identityKey(game.hostPlayerId)),
  );
// Identity alone is a usable appearance. Host-only records have no participant coverage.
const available = (game: StatisticsGame): boolean => humanParticipants(game).length > 0;
// Optional timeline and Best Move observations do not establish missing factual opportunities.
const partial = (game: StatisticsGame): boolean =>
  playedTime(game) === null ||
  game.outcome === null ||
  game.hostPlayerId === null ||
  game.hasCasper === null ||
  game.rosterComplete !== true ||
  humanParticipants(game).some(
    ({ seat, role, team, fouls, status }) =>
      seat === null || role === null || team === null || fouls === null || status === null,
  );
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
    (filters.tournamentId === undefined ||
      (filters.tournamentId === "none"
        ? game.tournamentId === null
        : game.tournamentId !== null &&
          identityKey(game.tournamentId) === identityKey(filters.tournamentId)))
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
  foulGames: 0,
  foulsPerGame: null,
  statusGames: 0,
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
    !source.tournaments.some(({ id }) => identityKey(id) === identityKey(filters.tournamentId!))
  ) {
    throw new StatisticsQueryError("Tournament not found in selected club");
  }
  const games = latestStatisticsGames(source.games);
  const ledger = buildClubRatingLedger(games);
  const ratings = new Map(
    source.players.map(({ id }) => [identityKey(id), summary(ledger.players.get(identityKey(id)))]),
  );
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
      .map(({ id, nickname }) => [
        identityKey(id),
        emptyPlayer(id, nickname, ratings.get(identityKey(id))!),
      ]),
  );
  const ensurePlayer = (id: string): PlayerStatisticsRow => {
    const key = identityKey(id);
    let player = players.get(key);
    if (player === undefined) {
      // Empty display name deliberately delegates the anonymous label to localization.
      player = emptyPlayer(id, "", summary(ledger.players.get(key)));
      players.set(key, player);
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
  let partialGames = 0;
  let unavailableGames = 0;
  let pendingGames = 0;
  for (const game of games
    .filter((game) => gameMatches(game, filters))
    .sort((a, b) => -compareStatisticsGames(a, b))) {
    if (game.status === "active") {
      pendingGames++;
      continue;
    }
    completedGames++;
    const statisticsAvailable = available(game);
    if (!statisticsAvailable) unavailableGames++;
    else if (partial(game)) partialGames++;
    const playedAt = playedTime(game);
    const hostId = game.hostPlayerId === null ? null : identityKey(game.hostPlayerId);
    const eligibility = ratingEligibility(game);
    const participants = new Map(
      humanParticipants(game)
        .filter((participant) => participantMatches(participant, filters))
        .map((participant) => [identityKey(participant.playerId), participant]),
    );
    const ids = new Set(participants.keys());
    if (
      hostId !== null &&
      hostId !== CASPER_PLAYER_ID &&
      filters.team === undefined &&
      filters.role === undefined
    )
      ids.add(hostId);
    for (const id of ids) {
      const previous = ensurePlayer(id);
      appearances.add(id);
      const participant = participants.get(id) ?? null;
      const isHost = hostId === id;
      const ratingChange =
        participant === null ? null : (ledger.games.get(identityKey(game.gameId))?.get(id) ?? null);
      const history: StatisticsHistoryGame = {
        gameId: game.gameId,
        name: game.name,
        playedAt,
        hasCasper: game.hasCasper,
        outcome: game.outcome,
        reason: game.reason,
        ...(game.adjudication === undefined ? {} : { adjudication: game.adjudication }),
        tournamentId: game.tournamentId,
        hostPlayerId: game.hostPlayerId,
        participant,
        isHost,
        statisticsAvailable,
        timelineAvailable: game.timelineAvailable,
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
          lastHostedAt: previous.lastHostedAt ?? playedAt,
        });
      } else if (participant !== null) {
        const outcome: "win" | "draw" | "loss" | null =
          game.outcome === "draw"
            ? "draw"
            : game.outcome === null || participant.team === null
              ? null
              : game.outcome === participant.team
                ? "win"
                : "loss";
        const totals = addAppearance(previous.totals, outcome);
        const fouls = previous.fouls + (participant.fouls ?? 0);
        const foulGames = previous.foulGames + Number(participant.fouls !== null);
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
            ...(participant.team === null
              ? {}
              : {
                  [participant.team]: addAppearance(previous.teams[participant.team], outcome),
                }),
          },
          roles: {
            ...previous.roles,
            ...(participant.role === null
              ? {}
              : {
                  [participant.role]: addAppearance(previous.roles[participant.role], outcome),
                }),
          },
          fouls,
          foulGames,
          foulsPerGame: foulGames === 0 ? null : fouls / foulGames,
          statusGames: previous.statusGames + Number(participant.status !== null),
          redCards: previous.redCards + Number(participant.status === "red-carded"),
          eliminations: previous.eliminations + Number(participant.status === "eliminated"),
          bestMoveResults,
          bestMoveHits,
          bestMoveMean: bestMoveResults === 0 ? null : bestMoveHits / bestMoveResults,
          lastPlayedAt: previous.lastPlayedAt ?? playedAt,
          recentForm:
            outcome === null || playedAt === null
              ? previous.recentForm
              : [...previous.recentForm, outcome].slice(0, 5),
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
  const leaderboard = [...new Set(source.players.map(({ id }) => identityKey(id)))]
    .filter((id) => id !== CASPER_PLAYER_ID && (!isScoped || appearances.has(id)))
    .map((id) => players.get(id)!)
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
      coverage: { completedGames, partialGames, unavailableGames, pendingGames },
      algorithm: CLUB_RATING_ALGORITHM,
    } satisfies ClubStatisticsResponse,
  };
};

export const getClubStatistics = (
  source: ClubStatisticsSource,
  filters: StatisticsFilters = {},
): ClubStatisticsResponse => aggregate(source, filters).response;

// Null has its own stable identity-ordered tail; no invented timestamp sentinel.
const cursorSchema = z.tuple([
  z.iso.datetime({ offset: true }).nullable(),
  z.string().min(1).max(256),
]);
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
  const key = identityKey(playerId);
  const player = data.players.get(key) ?? null;
  const rows = data.histories.get(key) ?? [];
  let start = 0;
  if (page.cursor !== undefined) {
    try {
      if (!/^[A-Za-z0-9_-]{1,512}$/.test(page.cursor)) throw new Error("Invalid cursor encoding");
      const decoded = Buffer.from(page.cursor, "base64url");
      if (decoded.toString("base64url") !== page.cursor) throw new Error("Noncanonical cursor");
      const [playedAt, gameId] = cursorSchema.parse(JSON.parse(decoded.toString("utf8")));
      const index = rows.findIndex(
        (row) => row.playedAt === playedAt && identityKey(row.gameId) === identityKey(gameId),
      );
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
