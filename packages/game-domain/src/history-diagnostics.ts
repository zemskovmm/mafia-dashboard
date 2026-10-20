// Public diagnostics contain categories and positions, never event contents or identifiers.
export const historyDiagnosticCodes = [
  "history.invalid_baseline",
  "history.invalid_event",
  "history.lifecycle",
  "history.terminal_position",
  "history.duplicate_event",
  "history.cross_game",
  "history.version",
  "history.parent_link",
  "history.sequence",
  "history.before_state",
  "history.after_state",
  "history.hash_mismatch",
  "history.action_failed",
  "history.cycle",
  "history.missing_parent",
  "history.missing_head",
  "history.retained_prefix",
  "history.replay_failed",
] as const;

export type HistoryDiagnosticCode = (typeof historyDiagnosticCodes)[number];
export interface HistoryDiagnostic {
  readonly code: HistoryDiagnosticCode;
  /** Zero-based index in the submitted events array, when known. */
  readonly eventIndex?: number;
  /** Zero-based index in the active replay chain, when known. */
  readonly replayIndex?: number;
}

export const sanitizeHistoryDiagnostic = (value: unknown): HistoryDiagnostic | null => {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (!(historyDiagnosticCodes as readonly unknown[]).includes(candidate.code)) return null;
  const diagnostic: { code: HistoryDiagnosticCode; eventIndex?: number; replayIndex?: number } = {
    code: candidate.code as HistoryDiagnosticCode,
  };
  for (const key of ["eventIndex", "replayIndex"] as const) {
    const index = candidate[key];
    if (index === undefined) continue;
    if (
      typeof index !== "number" ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= Number.MAX_SAFE_INTEGER
    )
      return null;
    diagnostic[key] = index;
  }
  return Object.freeze(diagnostic);
};

export class GameHistoryError extends Error {
  readonly diagnostic: HistoryDiagnostic;

  constructor(message: string, diagnostic: HistoryDiagnostic) {
    super(message);
    this.diagnostic = Object.freeze({ ...diagnostic });
  }
}

export const withHistoryDiagnostic = <T>(diagnostic: HistoryDiagnostic, action: () => T): T => {
  try {
    return action();
  } catch (error) {
    // Retain the original rule-error class/message for existing callers.
    if (error instanceof Error && Object.isExtensible(error)) {
      Object.defineProperty(error, "diagnostic", {
        value: Object.freeze({ ...diagnostic }),
        configurable: true,
      });
      throw error;
    }
    throw new GameHistoryError(
      error instanceof Error ? error.message : "Game history cannot be replayed",
      diagnostic,
    );
  }
};
