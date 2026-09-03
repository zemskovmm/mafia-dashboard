export type Role = "sheriff" | "citizen" | "mafia" | "don";

export type Team = "red" | "black";

export type SetupStep = "music" | "role-draw" | "mafia-planning";

export type PlayerStatus = "active" | "eliminated" | "red-carded";

export type GamePhase =
  | "mafia-planning"
  | "sheriff-wake"
  | "day"
  | "voting"
  | "voting-cancelled"
  | "car-crash"
  | "car-crash-decision"
  | "car-crash-result"
  | "car-crash-skipped"
  | "goodbye-speech"
  | "best-move"
  | "night-mafia"
  | "night-mafia-result"
  | "night-don"
  | "night-don-result"
  | "night-sheriff"
  | "night-sheriff-result"
  | "night-resolution"
  | "finished"
  | "draw"
  | "cancelled";

export type Winner = Team | null;

export interface PlayerInput {
  id: string;
  name: string;
  seat: number;
}

export interface SetupState {
  readonly step: SetupStep;
  readonly players: readonly PlayerInput[];
  readonly roleDeck: readonly Role[];
  readonly remainingRoles: readonly Role[];
  readonly assignments: Readonly<Partial<Record<number, Role>>>;
}

export interface PlayerState extends PlayerInput {
  readonly role: Role;
  readonly team: Team;
  readonly status: PlayerStatus;
  readonly fouls: number;
  readonly mutePending: boolean;
}

export interface Nomination {
  readonly nominatorSeat: number;
  readonly candidateSeat: number;
  readonly order: number;
}

export interface ShotAssignment {
  readonly shooterSeat: number;
  readonly targetSeat: number;
  readonly secret: true;
}

export interface GameState {
  readonly phase: GamePhase;
  readonly day: number;
  readonly bestMoveEnabled?: boolean;
  readonly cyclesWithoutElimination?: number;
  readonly eliminationOccurredThisCycle?: boolean;
  readonly dayOpeningSeat?: number;
  readonly players: readonly PlayerState[];
  readonly turnOrder: readonly number[];
  readonly currentTurnIndex: number;
  readonly nominations: readonly Nomination[];
  readonly voteAssignments: Readonly<Partial<Record<number, number>>>;
  readonly votingCancellation?:
    { readonly reason: "red-card" } | { readonly reason: "host-skipped" };
  readonly votingRound?: "initial" | "repeat";
  readonly carCrashSeats?: readonly number[];
  readonly carCrashVotes?: Readonly<Partial<Record<number, boolean>>>;
  readonly carCrashResult?: CarCrashVoteResult;
  readonly goodbyeSeats?: readonly number[];
  readonly goodbyeNext?: "day" | "night";
  readonly shotAssignments: Readonly<Partial<Record<number, number>>>;
  readonly nightCheckEligibility?: {
    readonly don: boolean;
    readonly sheriff: boolean;
  };
  readonly checkResult?: SecretCheckResult;
  readonly nightResult?: NightShotResult;
  readonly dayNotice?: "happy";
  readonly redCardIssuedThisDay?: boolean;
  readonly bestMove?: {
    readonly playerSeat: number;
    readonly selectedSeats: readonly number[];
    readonly mafiaHits?: number;
  };
  readonly winner: Winner;
}

export interface VoteResult {
  readonly kind: "winner" | "car-crash" | "eliminate-both-vote" | "eliminate-all-skipped";
  readonly seats: readonly number[];
  readonly totals: Readonly<Record<number, number>>;
}

export interface CarCrashVoteResult {
  readonly eliminate: boolean;
  readonly seats: readonly number[];
  readonly yesVotes: number;
  readonly eligibleVoters: number;
}

export type NightShotResult =
  | { readonly kind: "kill"; readonly targetSeat: number }
  | { readonly kind: "no-effect"; readonly targetSeat: number }
  | { readonly kind: "miss" };

export interface SecretCheckResult {
  readonly kind: "don-check" | "sheriff-check";
  readonly targetSeat: number;
  readonly match: boolean;
  readonly secret: true;
}
