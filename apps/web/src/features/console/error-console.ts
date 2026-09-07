import {
  ApiError,
  sanitizeApiValidationIssues,
  type ApiValidationIssue,
} from "../../api/client.js";

export type ErrorConsoleSource =
  "console" | "window" | "promise" | "application" | "api" | "persistence";

export type ErrorConsoleValidationIssue = ApiValidationIssue;

export interface ErrorConsoleApiDiagnostics {
  readonly status: number;
  readonly code: string | null;
  readonly validationIssues: readonly ErrorConsoleValidationIssue[];
}

export interface ErrorConsoleEntry {
  readonly id: string;
  readonly level: "error";
  readonly source: ErrorConsoleSource;
  readonly context: string | null;
  readonly message: string;
  readonly stack: string | null;
  readonly api: ErrorConsoleApiDiagnostics | null;
  readonly createdAt: string;
}

export interface ErrorConsoleReportOptions {
  readonly source?: ErrorConsoleSource;
  readonly context?: string | null;
}

let nextId = 0;
let snapshot: readonly ErrorConsoleEntry[] = Object.freeze([]);
const listeners = new Set<() => void>();
let activeUninstall: (() => void) | null = null;

const createId = (): string => {
  nextId += 1;
  return `error-${Date.now()}-${nextId}`;
};

const redactSecrets = (value: string): string =>
  value
    .replace(
      /((?<!["'])\b(?:authorization|cookie|set-cookie)\b\s*[:=]\s*)[^\r\n]*(?:\r?\n[\t ]+[^\r\n]*)*/gi,
      "$1[REDACTED]",
    )
    .replace(
      /((['"])\b(?:authorization|cookie|set-cookie)\2\s*[:=]\s*)(['"])(?:\\.|(?!\3)[^\\\r\n])*\3/gi,
      (_match, prefix: string, _keyQuote: string, valueQuote: string) =>
        `${prefix}${valueQuote}[REDACTED]${valueQuote}`,
    )
    .replace(/\b(bearer)\s+[^\s,;&]+/gi, "$1 [REDACTED]")
    .replace(
      /(["']?(?:password|passcode|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      "$1[REDACTED]",
    );

const boundText = (value: string, maximumLength: number): string => {
  const redacted = redactSecrets(value);
  return redacted.length <= maximumLength ? redacted : `${redacted.slice(0, maximumLength - 1)}…`;
};

const normalizeMessage = (error: unknown): string => {
  if (error instanceof Error) return boundText(error.message || error.name || "Error", 2_048);
  if (typeof error === "string") return error ? boundText(error, 2_048) : "Unknown error";
  if (
    typeof error === "number" ||
    typeof error === "boolean" ||
    typeof error === "bigint" ||
    typeof error === "symbol"
  ) {
    return boundText(String(error), 2_048);
  }
  if (error !== null && typeof error === "object") return "Non-Error object";
  if (typeof error === "function") return "Non-Error function";
  return "Unknown error";
};

const safeApiDiagnostics = (error: unknown): ErrorConsoleApiDiagnostics | null => {
  if (
    !(error instanceof ApiError) ||
    !Number.isInteger(error.status) ||
    error.status < 100 ||
    error.status > 599
  ) {
    return null;
  }

  const details = error.details;
  const validationIssues = sanitizeApiValidationIssues(
    typeof details === "object" && details !== null && "issues" in details
      ? (details as { issues?: unknown }).issues
      : null,
  );

  return Object.freeze({
    status: error.status,
    code: /^[a-z][a-z0-9_]{0,127}$/.test(error.code ?? "") ? error.code : null,
    validationIssues,
  });
};

export const getErrorConsoleSnapshot = (): readonly ErrorConsoleEntry[] => snapshot;

export const subscribeToErrorConsole = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const clearErrorConsole = (): void => {
  if (snapshot.length === 0) return;
  snapshot = Object.freeze([]);
  listeners.forEach((listener) => listener());
};

export const reportError = (
  error: unknown,
  options: ErrorConsoleReportOptions = {},
): ErrorConsoleEntry => {
  const entry = Object.freeze<ErrorConsoleEntry>({
    id: createId(),
    level: "error",
    source: options.source ?? "application",
    context:
      options.context === undefined || options.context === null
        ? null
        : boundText(options.context, 256),
    message: normalizeMessage(error),
    stack: error instanceof Error && error.stack ? boundText(error.stack, 12_000) : null,
    api: safeApiDiagnostics(error),
    createdAt: new Date().toISOString(),
  });
  snapshot = Object.freeze([entry, ...snapshot].slice(0, 200));
  listeners.forEach((listener) => listener());
  return entry;
};

export const installErrorConsole = (): (() => void) => {
  if (activeUninstall !== null) return activeUninstall;

  const originalError = console.error;
  let capturingConsoleError = false;
  const capturedError = (...arguments_: unknown[]): void => {
    originalError.apply(console, arguments_);
    if (capturingConsoleError) return;

    capturingConsoleError = true;
    try {
      const error = arguments_.find((argument) => argument instanceof Error) ?? arguments_[0];
      reportError(error ?? "console.error called", { source: "console" });
    } finally {
      capturingConsoleError = false;
    }
  };
  const handleWindowError = (event: ErrorEvent): void => {
    reportError(event.error ?? (event.message || "Unhandled window error"), { source: "window" });
  };
  const handleUnhandledRejection = (event: PromiseRejectionEvent): void => {
    reportError(event.reason, { source: "promise" });
  };
  const errorTarget = typeof window === "undefined" ? null : window;

  console.error = capturedError;
  errorTarget?.addEventListener("error", handleWindowError);
  errorTarget?.addEventListener("unhandledrejection", handleUnhandledRejection);
  const uninstall = (): void => {
    if (console.error === capturedError) console.error = originalError;
    errorTarget?.removeEventListener("error", handleWindowError);
    errorTarget?.removeEventListener("unhandledrejection", handleUnhandledRejection);
    if (activeUninstall === uninstall) activeUninstall = null;
  };
  activeUninstall = uninstall;
  return uninstall;
};

export const errorConsole = Object.freeze({
  subscribe: subscribeToErrorConsole,
  get: getErrorConsoleSnapshot,
  getSnapshot: getErrorConsoleSnapshot,
  clear: clearErrorConsole,
  report: reportError,
  install: installErrorConsole,
});
