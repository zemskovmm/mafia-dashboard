export type Role = "sheriff" | "citizen" | "mafia" | "don";

export type Team = "red" | "black";

export type SetupStep = "music" | "role-draw" | "mafia-negotiation";

export type PlayerStatus = "active" | "eliminated" | "red-carded";

export type GamePhase =
  | "mafia-negotiation"
  | "sheriff-wake"
  | "day"
  | "voting"
  | "night-mafia"
  | "night-don"
  | "night-sheriff"
  | "night-resolution"
  | "finished";

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
  readonly players: readonly PlayerState[];
  readonly turnOrder: readonly number[];
  readonly currentTurnIndex: number;
  readonly nominations: readonly Nomination[];
  readonly voteAssignments: Readonly<Partial<Record<number, number>>>;
  readonly shotAssignments: Readonly<Partial<Record<number, number>>>;
  readonly winner: Winner;
}

export interface VoteResult {
  readonly kind: "winner" | "tie";
  readonly seats: readonly number[];
  readonly totals: Readonly<Record<number, number>>;
}

export type NightShotResult =
  { readonly kind: "kill"; readonly targetSeat: number } | { readonly kind: "miss" };

export interface SecretCheckResult {
  readonly kind: "don-check" | "sheriff-check";
  readonly targetSeat: number;
  readonly match: boolean;
  readonly secret: true;
}
