export const DEFAULT_CLUB_ID = "00000000-0000-4000-8000-000000000101";
export type ClubLanguage = "en" | "ru";
export type ClubRole = "manager" | "user";

interface ClubDetails {
  readonly name: string;
  readonly city: string;
  readonly headerLogo: string | null;
  readonly cardLogo: string | null;
  readonly language: ClubLanguage;
  readonly bestMoveEnabled: boolean;
}

export interface ClubInput extends Omit<ClubDetails, "bestMoveEnabled"> {
  readonly bestMoveEnabled?: boolean;
  readonly ownerConsent: true;
}

export interface Club extends ClubDetails {
  readonly id: string;
  readonly role: ClubRole;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
