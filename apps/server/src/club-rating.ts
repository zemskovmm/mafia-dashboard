import { CASPER_PLAYER_ID, FEDERATION_RULES_EDITION } from "@mafia/game-domain";
import type { ClubRatingChange, Role, StatisticsGame, UnratedReason } from "@mafia/game-domain";

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
    if (!latest.has(game.gameId) || latest.get(game.gameId)!.revision < game.revision) {
      latest.set(game.gameId, game);
    }
  }
  return [...latest.values()];
};

export const compareStatisticsGames = (a: StatisticsGame, b: StatisticsGame): number =>
  Date.parse(a.playedAt!) - Date.parse(b.playedAt!) ||
  (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0);

export const ratingEligibility = (game: StatisticsGame): Exclude<UnratedReason, "host"> | null => {
  if (
    game.status !== "completed" ||
    game.playedAt === null ||
    !Number.isFinite(Date.parse(game.playedAt)) ||
    game.outcome === null
  ) {
    return "incomplete-results";
  }
  if (game.outcome === "cancelled") return "cancelled";
  if (game.rulesEdition !== FEDERATION_RULES_EDITION) return "legacy-edition";
  if (game.hasCasper) return "casper";
  const participants = game.participants;
  if (participants === null || participants.length === 0) return "incomplete-results";
  const counts: Record<Role, number> = { citizen: 0, sheriff: 0, mafia: 0, don: 0 };
  if (
    participants.length !== 10 ||
    new Set(participants.map(({ playerId }) => playerId)).size !== 10 ||
    new Set(participants.map(({ seat }) => seat)).size !== 10
  )
    return "ineligible-roster";
  for (const participant of participants) {
    if (
      !participant.playerId ||
      participant.playerId === CASPER_PLAYER_ID ||
      participant.playerId === game.hostPlayerId ||
      !Number.isInteger(participant.seat) ||
      participant.seat < 1 ||
      participant.seat > 10 ||
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
          (sum, participant) => sum + (players.get(participant.playerId)?.value ?? INITIAL_RATING),
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
      const previous = players.get(participant.playerId);
      const before = previous?.value ?? INITIAL_RATING;
      const expectedScore = participant.team === "red" ? redExpectation : 1 - redExpectation;
      const score = game.outcome === "draw" ? 0.5 : game.outcome === participant.team ? 1 : 0;
      const change = K * (score - expectedScore);
      changes.set(participant.playerId, {
        before,
        after: before + change,
        change,
        redAverage,
        blackAverage,
        expectedScore,
        score,
      });
      players.set(participant.playerId, {
        value: before + change,
        ratedGames: (previous?.ratedGames ?? 0) + 1,
        lastChange: change,
      });
    }
    games.set(game.gameId, changes);
  }
  return { players, games };
};
