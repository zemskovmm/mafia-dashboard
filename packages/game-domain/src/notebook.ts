import type { Role, Team } from "./types.js";

/** Sparse paper observations, never a canonical replay or current game state. */
export interface NotebookCell {
  readonly seat: number;
  readonly day: number;
  readonly phase: "day" | "night";
  readonly nomination?: number;
  readonly eliminated?: true;
}

export interface NotebookSeatRole {
  readonly seat: number;
  readonly role: Role;
}

export interface NotebookRecord {
  readonly dayCount: number;
  readonly cells: readonly NotebookCell[];
  readonly seatRoles?: readonly NotebookSeatRole[];
  readonly bestMove?: {
    readonly ownerSeat?: number;
    readonly targetSeats: readonly number[];
  };
}

export interface NotebookParticipant {
  readonly playerId: string;
  readonly seat: number;
  readonly role?: Role;
  readonly team?: Team;
  readonly status?: "eliminated";
  readonly bestMoveHits?: number;
}

export interface NotebookGameCreation {
  readonly creationId: string;
  readonly name: string;
  readonly state: { readonly notebook: NotebookRecord };
  readonly results: {
    readonly players: readonly NotebookParticipant[];
    readonly hostPlayerId?: string;
    readonly playedAt?: string;
    readonly outcome?: "red" | "black" | "draw" | "cancelled";
    readonly winner?: "red" | "black" | null;
  };
}

export const MAX_NOTEBOOK_DAYS = 20;
