export type GameRuleErrorCode =
  | "invalid-phase"
  | "invalid-player"
  | "duplicate-action"
  | "incomplete-action"
  | "terminal-game"
  | "invalid-action";

export type GameRuleErrorDetail = string | number | boolean | null;
export type GameRuleErrorDetails = Readonly<Record<string, GameRuleErrorDetail>>;

const classifyRuleError = (message: string): GameRuleErrorCode => {
  const normalized = message.toLowerCase();
  if (normalized.includes("terminal")) return "terminal-game";
  if (normalized.includes("already") || normalized.includes("duplicate")) {
    return "duplicate-action";
  }
  if (
    normalized.includes("phase") ||
    normalized.includes("during") ||
    normalized.includes("before") ||
    normalized.includes("after") ||
    normalized.includes("cannot advance")
  ) {
    return "invalid-phase";
  }
  if (
    normalized.includes("seat") ||
    normalized.includes("player") ||
    normalized.includes("voter") ||
    normalized.includes("shooter") ||
    normalized.includes("target") ||
    normalized.includes("owner")
  ) {
    return "invalid-player";
  }
  if (
    normalized.includes("must") ||
    normalized.includes("requires") ||
    normalized.includes("complete") ||
    normalized.includes("missing") ||
    normalized.includes("exactly")
  ) {
    return "incomplete-action";
  }
  return "invalid-action";
};

export class GameRuleError extends Error {
  readonly code: GameRuleErrorCode;
  readonly details: GameRuleErrorDetails;

  constructor(code: GameRuleErrorCode, message: string, details: GameRuleErrorDetails = {}) {
    super(message);
    this.name = "GameRuleError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }

  toJSON(): {
    readonly name: "GameRuleError";
    readonly code: GameRuleErrorCode;
    readonly message: string;
    readonly details: GameRuleErrorDetails;
  } {
    return { name: "GameRuleError", code: this.code, message: this.message, details: this.details };
  }
}

export const toGameRuleError = (
  error: unknown,
  details: GameRuleErrorDetails = {},
): GameRuleError => {
  if (error instanceof GameRuleError) return error;
  const message = error instanceof Error ? error.message : "The game action is invalid";
  return new GameRuleError(classifyRuleError(message), message, details);
};
