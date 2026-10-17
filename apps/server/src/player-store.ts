export class ManagerLockedError extends Error {
  public readonly code = "manager_locked";

  public constructor() {
    super("The club creator manager cannot be demoted");
    this.name = "ManagerLockedError";
  }
}

export class OwnerProfileForbiddenError extends Error {
  public readonly code = "owner_profile_forbidden";

  public constructor() {
    super("Only the linked club creator can mutate the locked Owner profile");
    this.name = "OwnerProfileForbiddenError";
  }
}

export class ClubAccessConsentRequiredError extends Error {
  public readonly code = "club_access_consent_required";

  public constructor() {
    super("Club access requires consent unless this is the linked club creator");
    this.name = "ClubAccessConsentRequiredError";
  }
}

export type PlayerClubAccess = "none" | "user" | "manager";

export interface PlayerProfileInput {
  readonly nickname: string;
  readonly consent: boolean;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly email: string | null;
  readonly clubAccess?: PlayerClubAccess;
}

interface PlayerStatistics {
  readonly hostedGames: number;
  readonly gamesPlayed: number;
  readonly wins: number;
  readonly losses: number;
  readonly redGames: number;
  readonly redWins: number;
  readonly blackGames: number;
  readonly blackWins: number;
  readonly sheriffGames: number;
  readonly citizenGames: number;
  readonly mafiaGames: number;
  readonly donGames: number;
  readonly totalFouls: number;
  readonly eliminations: number;
  readonly redCards: number;
  readonly bestMoves: number;
  readonly bestMoveMafiaHits: number;
}

export interface PlayerProfile extends Omit<PlayerProfileInput, "clubAccess"> {
  readonly id: string;
  readonly clubAccess: PlayerClubAccess;
  readonly managerLocked: boolean;
  readonly consentAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastPlayedAt: Date | null;
  readonly statistics: PlayerStatistics;
}
