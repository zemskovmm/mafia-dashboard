import type { GameState, ReplayFrame } from "@mafia/game-domain";

/** Presentation facts only: never persisted or passed back to canonical replay. */
export type LedgerFactKind =
  | "nomination"
  | "support"
  | "vote"
  | "voteUnassigned"
  | "collectiveYes"
  | "collectiveNo"
  | "collectiveUnobserved"
  | "ballotClosed"
  | "ballotDisputed"
  | "ballotCancelled"
  | "ballotSkipped"
  | "shot"
  | "shotObserved"
  | "killed"
  | "miss"
  | "noEffect"
  | "donMatch"
  | "donNoMatch"
  | "sheriffMatch"
  | "sheriffNoMatch"
  | "checkSkipped"
  | "checkUnavailable"
  | "bestMove"
  | "bestMoveSkipped"
  | "foul"
  | "eliminated"
  | "removed";

export interface LedgerFact {
  /** Internal React identity; do not emit source IDs into DOM attributes. */
  readonly id: string;
  readonly kind: LedgerFactKind;
  readonly period: "day" | "night";
  readonly values?: Readonly<Record<string, string | number>>;
  readonly provisional?: boolean;
}
export interface LedgerCell {
  readonly day: number;
  readonly state: "unknown" | "pending" | "recorded";
  readonly facts: readonly LedgerFact[];
}
export interface LedgerRow {
  readonly playerId: string;
  readonly seat: number;
  readonly cells: readonly LedgerCell[];
}
export interface LedgerColumn {
  /** Existing internal day: 0 = planning; 1 = zero round. */
  readonly day: number;
  readonly current: boolean;
}
export interface LedgerModel {
  readonly columns: readonly LedgerColumn[];
  readonly rows: readonly LedgerRow[];
  readonly historyAvailable: boolean;
}
export interface LedgerInput {
  /** Undefined is unavailable history; [] is a valid empty admitted prefix. */
  readonly frames: readonly ReplayFrame[] | undefined;
  readonly game: GameState;
  readonly privacyHidden: boolean;
}
