export type Role = "sheriff" | "citizen" | "mafia" | "don";
export type Team = "red" | "black";
export type SetupStep = "music" | "role-draw" | "mafia-planning";
export type PlayerStatus = "active" | "eliminated" | "red-carded";
export type GamePhase =
  | "mafia-planning"
  | "mafia-sleep"
  | "don-identification"
  | "sheriff-identification"
  | "free-seating"
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
  /** Additional unique supporters only; absent on unobserved historical nominations. */
  readonly supporterSeats?: readonly number[];
}
export interface ShotAssignment {
  readonly shooterSeat: number;
  readonly targetSeat: number;
  readonly secret: true;
}
/** Ordered private physical facts, independent of clerical assignment corrections. */
export interface ShotObservation {
  readonly shooterSeat: number;
  readonly targetSeat: number;
  readonly additional: boolean;
}
export interface GameState {
  readonly completedGameNights: number;
  readonly sheriffChecksPerformed: number;
  readonly firstDayDepartureSeats: readonly number[];
  readonly currentSpeechRestricted: boolean;
  readonly actualMultipleShotSeats?: readonly number[];
  readonly shotObservations?: readonly ShotObservation[];
  readonly ballot?: FederationBallot;
  readonly ballotSkipReason?: LegalVotingSkipReason;
  readonly ballotCancellationDay?: number;
  readonly adjudication?: OpponentVictoryAdjudication;
  readonly rulesDrawReason?: RulesDrawReason;
  readonly disciplinaryRemovals?: readonly DisciplinaryRemoval[];
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
    | {
        readonly reason: "red-card";
      }
    | {
        readonly reason: "host-skipped";
      };
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
    readonly completionReason?: BestMoveCompletionReason;
    readonly readbackAcknowledged?: boolean;
  };
  readonly winner: Winner;
}
export interface VoteResult {
  readonly kind: "winner" | "car-crash" | "eliminate-both-vote" | "eliminate-all-skipped";
  readonly seats: readonly number[];
  readonly totals: Readonly<Record<number, number>>;
  readonly skipReason?: CollectiveLiftSkipReason;
}
export interface CarCrashVoteResult {
  readonly eliminate: boolean;
  readonly seats: readonly number[];
  readonly yesVotes: number;
  readonly eligibleVoters: number;
}
export type NightShotResult =
  | {
      readonly kind: "kill";
      readonly targetSeat: number;
    }
  | {
      readonly kind: "no-effect";
      readonly targetSeat: number;
    }
  | {
      readonly kind: "miss";
    };
export interface SecretCheckResult {
  readonly kind: "don-check" | "sheriff-check";
  readonly targetSeat: number;
  readonly match: boolean;
  readonly secret: true;
}
export type BestMoveCompletionReason =
  "complete-list" | "interrupted" | "time-expired" | "declined" | "finished-early";
export type CollectiveLiftSkipReason = "all-active" | "nine-three-restricted" | "zero-round-five";
export type LegalVotingSkipReason =
  | CollectiveLiftSkipReason
  | "no-nominees"
  | "zero-round-sole-nominee"
  | "disciplinary-cancellation";
export interface FederationBallot {
  /** Enabled only by an explicit recording action; historical call state stays intact. */
  readonly hostRecording?: true;
  readonly orderAnnouncements: 0 | 1 | 2;
  readonly mention: 0 | 1 | 2;
  readonly stopped: boolean;
  readonly selectedCandidateSeat: number;
  readonly acceptedCandidateSeats: readonly number[];
  readonly reviewedCandidateSeats: readonly number[];
  readonly dispute?: {
    readonly candidateSeat: number;
    readonly reason: string;
  };
  readonly finalRuling?: {
    readonly candidateSeat: number;
    readonly reason: string;
    readonly externalReviewAcknowledged: true;
  };
}
export interface OpponentVictoryAdjudication {
  readonly losingTeam: Team;
  readonly offenderSeat?: number;
  readonly rule: string;
  readonly reason: string;
  readonly committeeApproved: boolean;
}
export interface RulesDrawReason {
  readonly rule: "6.5.6";
  readonly completedGameNights: number;
  readonly consecutiveUnchangedNights: 3;
}
export type RemovalOccurrenceStage =
  | "agreement"
  | "before-shooting-count"
  | "shooting-count"
  | "after-shooting-result"
  | "don-check"
  | "sheriff-check"
  | "day-discussion"
  | "open-voting"
  | "after-voting-result"
  | "farewell";
export interface RemovalObservation {
  readonly seat: number;
  readonly stage: RemovalOccurrenceStage;
  readonly rule: string;
  readonly reason: string;
  readonly checkInProgress: boolean;
}
export interface DisciplinaryRemoval extends RemovalObservation {
  readonly occurredPhase: GamePhase;
  readonly day: number;
  readonly effectiveExcluded: true;
  readonly departure: "pending" | "departed";
  readonly announcement: "pending" | "announced";
  readonly shotDeath: boolean;
  readonly checkCompletionPending: boolean;
}
