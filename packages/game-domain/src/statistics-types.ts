import type { PlayerStatus, Role, Team } from "./types.js";

/** Club metadata, deliberately outside canonical gameplay/replay state. */
export interface ClubTournament {
  readonly id: string;
  readonly name: string;
}

export type StatisticsOutcome = Team | "draw" | "cancelled";
export interface StatisticsParticipant {
  readonly playerId: string;
  readonly seat: number | null;
  readonly role: Role | null;
  readonly team: Team | null;
  readonly status: PlayerStatus | null;
  readonly fouls: number | null;
  readonly bestMoveHits: number | null;
}

export interface StatisticsAdjudication {
  readonly losingTeam: Team;
  readonly offenderSeat?: number;
  readonly rule: string;
  readonly reason: string;
  readonly committeeApproved: boolean;
}

/** One coherent provider read; active records never carry participant secrets. */
export interface StatisticsGame {
  readonly gameId: string;
  readonly name: string;
  readonly revision: number;
  readonly status: "active" | "completed";
  readonly hasCasper: boolean | null;
  readonly rosterComplete: boolean | null;
  readonly timelineAvailable: boolean;
  readonly playedAt: string | null;
  readonly hostPlayerId: string | null;
  readonly outcome: StatisticsOutcome | null;
  readonly reason: string | null;
  readonly adjudication?: StatisticsAdjudication;
  readonly tournamentId: string | null;
  readonly participants: readonly StatisticsParticipant[] | null;
}

export interface ClubStatisticsSource {
  readonly players: readonly { readonly id: string; readonly nickname: string }[];
  readonly games: readonly StatisticsGame[];
  readonly tournaments: readonly ClubTournament[];
}

export interface StatisticsFilters {
  readonly from?: string;
  readonly to?: string;

  readonly team?: Team;
  readonly role?: Role;
  /** Omitted = all games, "none" = unassigned, otherwise a club tournament UUID. */
  readonly tournamentId?: string;
}

export interface StatisticsTotals {
  /** Known non-cancelled appearances, including those without an observed result. */
  readonly games: number;
  readonly outcomeGames: number;
  readonly wins: number;
  readonly draws: number;
  readonly losses: number;
  /** Percentage in [0, 100], or null when there are no observations. */
  readonly winRate: number | null;
}

export interface ClubRatingSummary {
  readonly algorithm: "club-team-elo-v1";
  readonly value: number | null;
  readonly ratedGames: number;
  readonly status: "unranked" | "provisional" | "established";
  readonly rank: number | null;
  readonly lastChange: number | null;
}

export interface ClubRatingChange {
  readonly before: number;
  readonly after: number;
  readonly change: number;
  readonly redAverage: number;
  readonly blackAverage: number;
  readonly expectedScore: number;
  readonly score: number;
}

export type UnratedReason =
  "casper" | "cancelled" | "incomplete-results" | "ineligible-roster" | "host";

export interface PlayerStatisticsRow {
  readonly playerId: string;
  readonly nickname: string;
  readonly totals: StatisticsTotals;
  readonly teams: Readonly<Record<Team, StatisticsTotals>>;
  readonly roles: Readonly<Record<Role, StatisticsTotals>>;
  readonly fouls: number;
  readonly foulGames: number;
  readonly foulsPerGame: number | null;
  readonly statusGames: number;
  readonly redCards: number;
  readonly eliminations: number;
  readonly bestMoveResults: number;
  readonly bestMoveHits: number;
  readonly bestMoveMean: number | null;
  readonly hostedGames: number;
  readonly lastHostedAt: string | null;
  readonly lastPlayedAt: string | null;
  readonly recentForm: readonly ("win" | "draw" | "loss")[];
  readonly rating: ClubRatingSummary;
  readonly scopedRatingChange: number | null;
  readonly scopedRatedGames: number;
}

export interface StatisticsHistoryGame {
  readonly gameId: string;
  readonly name: string;
  readonly playedAt: string | null;
  readonly hasCasper: boolean | null;
  readonly outcome: StatisticsOutcome | null;
  readonly reason: string | null;
  readonly adjudication?: StatisticsAdjudication;
  readonly tournamentId: string | null;
  readonly hostPlayerId: string | null;
  readonly participant: StatisticsParticipant | null;
  readonly isHost: boolean;
  readonly statisticsAvailable: boolean;
  readonly timelineAvailable: boolean;
  readonly unratedReason: UnratedReason | null;
  readonly ratingChange: ClubRatingChange | null;
}

export interface ClubStatisticsResponse {
  readonly players: readonly PlayerStatisticsRow[];
  readonly tournaments: readonly ClubTournament[];
  readonly coverage: {
    readonly completedGames: number;
    readonly partialGames: number;
    readonly unavailableGames: number;
    readonly pendingGames: number;
  };
  readonly algorithm: "club-team-elo-v1";
}

export interface PlayerStatisticsResponse {
  readonly player: PlayerStatisticsRow | null;
  readonly history: readonly StatisticsHistoryGame[];
  readonly nextCursor: string | null;
  readonly total: number;
}

export interface StatisticsHistoryPage {
  readonly cursor?: string;
  readonly limit?: number;
}
