import { CASPER_PLAYER_ID } from "@mafia/game-domain";
import type { ClubRatingChange, Role, StatisticsGame, UnratedReason } from "@mafia/game-domain";
import { statisticsIdentityKey as identityKey } from "./statistics-identity.js";

export const CLUB_RATING_ALGORITHM = "club-team-elo-v1" as const;
const INITIAL_RATING = 1500;
const K = 32;

export interface RatingStanding {
  readonly value: number;
  readonly ratedGames: number;
  readonly lastChange: number;
}
export interface ClubRatingLedger {
  readonly players: ReadonlyMap<string, RatingStanding>;
  /** Full-precision simultaneous changes, before any scope filtering. */
  readonly games: ReadonlyMap<string, ReadonlyMap<string, ClubRatingChange>>;
}

/** The source normally contains one accepted revision; never count repeated saves. */
export const latestStatisticsGames = (games: readonly StatisticsGame[]): StatisticsGame[] => {
  const latest = new Map<string, StatisticsGame>();
  for (const game of games) {
    const key = identityKey(game.gameId);
    if (!latest.has(key) || latest.get(key)!.revision < game.revision) {
      latest.set(key, game);
    }
  }
  return [...latest.values()];
};

export const compareStatisticsGames = (a: StatisticsGame, b: StatisticsGame): number => {
  const aId = identityKey(a.gameId);
  const bId = identityKey(b.gameId);
  const aTime = a.playedAt === null ? NaN : Date.parse(a.playedAt);
  const bTime = b.playedAt === null ? NaN : Date.parse(b.playedAt);
  // Ascending chronology puts unknown times first; reversed history puts them last.
  const timeOrder =
    Number.isFinite(aTime) && Number.isFinite(bTime)
      ? aTime - bTime
      : Number.isFinite(aTime)
        ? 1
        : Number.isFinite(bTime)
          ? -1
          : 0;
  return timeOrder || (aId < bId ? -1 : aId > bId ? 1 : 0);
};

export const ratingEligibility = (game: StatisticsGame): Exclude<UnratedReason, "host"> | null => {
  if (game.status !== "completed") return "incomplete-results";
  if (game.outcome === "cancelled") return "cancelled";
  if (
    game.playedAt === null ||
    !Number.isFinite(Date.parse(game.playedAt)) ||
    game.outcome === null
  ) {
    return "incomplete-results";
  }
  if (game.hasCasper === true) return "casper";
  if (game.hasCasper === null || game.rosterComplete === null || game.hostPlayerId === null)
    return "incomplete-results";
  if (!game.rosterComplete) return "ineligible-roster";
  const participants = game.participants;
  if (participants === null || participants.length === 0) return "incomplete-results";
  const counts: Record<Role, number> = { citizen: 0, sheriff: 0, mafia: 0, don: 0 };
  if (
    participants.length !== 10 ||
    new Set(participants.map(({ playerId }) => identityKey(playerId))).size !== 10 ||
    new Set(participants.map(({ seat }) => seat)).size !== 10
  )
    return "ineligible-roster";
  for (const participant of participants) {
    if (
      !participant.playerId ||
      participant.playerId === CASPER_PLAYER_ID ||
      identityKey(participant.playerId) === identityKey(game.hostPlayerId ?? "") ||
      participant.seat === null ||
      !Number.isInteger(participant.seat) ||
      participant.seat < 1 ||
      participant.seat > 10 ||
      participant.role === null ||
      !(participant.role in counts) ||
      participant.team !==
        (participant.role === "mafia" || participant.role === "don" ? "black" : "red")
    ) {
      return "ineligible-roster";
    }
    counts[participant.role]++;
  }
  return counts.citizen === 6 && counts.sheriff === 1 && counts.mafia === 2 && counts.don === 1
    ? null
    : "ineligible-roster";
};

export const buildClubRatingLedger = (inputs: readonly StatisticsGame[]): ClubRatingLedger => {
  const players = new Map<string, RatingStanding>();
  const games = new Map<string, ReadonlyMap<string, ClubRatingChange>>();
  for (const game of latestStatisticsGames(inputs)
    .filter((game) => ratingEligibility(game) === null)
    .sort(compareStatisticsGames)) {
    const participants = game.participants!;
    const mean = (team: "red" | "black") => {
      const side = participants.filter((participant) => participant.team === team);
      return (
        side.reduce(
          (sum, participant) =>
            sum + (players.get(identityKey(participant.playerId))?.value ?? INITIAL_RATING),
          0,
        ) / side.length
      );
    };
    // Both means and expectations precede every individual update.
    const redAverage = mean("red");
    const blackAverage = mean("black");
    const redExpectation = 1 / (1 + 10 ** ((blackAverage - redAverage) / 400));
    const changes = new Map<string, ClubRatingChange>();
    for (const participant of participants) {
      const id = identityKey(participant.playerId);
      const previous = players.get(id);
      const before = previous?.value ?? INITIAL_RATING;
      const expectedScore = participant.team === "red" ? redExpectation : 1 - redExpectation;
      const score = game.outcome === "draw" ? 0.5 : game.outcome === participant.team ? 1 : 0;
      const change = K * (score - expectedScore);
      changes.set(id, {
        before,
        after: before + change,
        change,
        redAverage,
        blackAverage,
        expectedScore,
        score,
      });
      players.set(id, {
        value: before + change,
        ratedGames: (previous?.ratedGames ?? 0) + 1,
        lastChange: change,
      });
    }
    games.set(identityKey(game.gameId), changes);
  }
  return { players, games };
};
