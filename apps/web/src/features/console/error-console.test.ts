import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client.js";
import {
  clearErrorConsole,
  errorConsole,
  getErrorConsoleSnapshot,
  installErrorConsole,
  reportError,
  subscribeToErrorConsole,
} from "./error-console.js";

afterEach(clearErrorConsole);

describe("error console store", () => {
  it("reports an Error through an immutable snapshot", () => {
    const reported = reportError(new Error("Database unavailable"));
    const snapshot = getErrorConsoleSnapshot();

    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toBe(reported);
    expect(reported).toMatchObject({
      id: expect.any(String),
      level: "error",
      source: "application",
      context: null,
      message: "Database unavailable",
      stack: expect.stringContaining("Database unavailable"),
      createdAt: expect.any(String),
    });
    expect(Object.isFrozen(reported)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("clears all reported entries", () => {
    reportError(new Error("Clear me"));
    expect(getErrorConsoleSnapshot()).toHaveLength(1);

    clearErrorConsole();

    expect(getErrorConsoleSnapshot()).toEqual([]);
    expect(Object.isFrozen(getErrorConsoleSnapshot())).toBe(true);
  });

  it("notifies active subscribers when an error is reported", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToErrorConsole(listener);

    reportError(new Error("Observed"));
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    reportError(new Error("Ignored"));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("notifies subscribers when a non-empty console is cleared", () => {
    reportError(new Error("Clear me"));
    const listener = vi.fn();
    const unsubscribe = subscribeToErrorConsole(listener);

    clearErrorConsole();

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("keeps only the newest 200 entries in newest-first order", () => {
    const reported = Array.from({ length: 201 }, (_, index) =>
      reportError(new Error(`Failure ${index}`)),
    );

    const current = getErrorConsoleSnapshot();
    expect(current).toHaveLength(200);
    expect(current[0]).toBe(reported[200]);
    expect(current.at(-1)).toBe(reported[1]);
    expect(current).not.toContain(reported[0]);
  });

  it("records an explicit source and context", () => {
    const entry = reportError("Request failed", {
      source: "api",
      context: "Loading players",
    });

    expect(entry).toMatchObject({
      source: "api",
      context: "Loading players",
      message: "Request failed",
      stack: null,
    });
  });

  it("does not dump properties from arbitrary rejected objects", () => {
    const entry = reportError({
      message: "Leaky response",
      token: "top-secret-token",
      body: { password: "private-body" },
    });

    expect(entry.message).toBe("Non-Error object");
    expect(entry.stack).toBeNull();
    expect(JSON.stringify(entry)).not.toContain("top-secret-token");
    expect(JSON.stringify(entry)).not.toContain("private-body");
  });

  it("retains only bounded static diagnostics from genuine API errors", () => {
    const privateSentinel = "must-not-leak-private-validation-value";
    const entry = reportError(
      new ApiError("Unable to save the game session operation", 400, "validation_failed", {
        issues: [
          { path: ["results", "hostPlayerId"], message: privateSentinel },
          { path: ["state", "undoHistory", privateSentinel], message: privateSentinel },
          {
            path: ["state", "game", "players", 3, "role"],
            message: privateSentinel,
          },
          { path: ["results", "players", 3, "role"], message: privateSentinel },
          {
            path: "state.game.voteAssignments",
            message: "The final voting candidate must receive every remaining active vote",
          },
          {
            path: ["state", "events", 0, "payload"],
            message: privateSentinel,
          },
        ],
        request: { state: { events: [{ payload: privateSentinel }] } },
        headers: { authorization: `Bearer ${privateSentinel}` },
        credentials: { token: privateSentinel },
      }),
      { source: "persistence", context: "game-session.save" },
    );

    expect(entry.api).toEqual({
      status: 400,
      code: "validation_failed",
      validationIssues: [
        { path: "results.hostPlayerId", message: "Invalid value" },
        { path: "state.undoHistory", message: "Invalid value" },
        { path: "state.game", message: "Invalid value" },
        { path: "results", message: "Invalid value" },
        {
          path: "state.game.voteAssignments",
          message: "The final voting candidate must receive every remaining active vote",
        },
        { path: "state.events", message: "Invalid value" },
      ],
    });
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain(privateSentinel);
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("credentials");
  });

  it("redacts credential-like values from retained text", () => {
    const error = new Error("Authorization: Bearer console-token password=hunter2");
    error.stack = "Error at /players?access_token=query-token";

    const entry = reportError(error, {
      source: "api",
      context: "GET /players?api_key=context-key",
    });
    const serialized = JSON.stringify(entry);

    expect(serialized).not.toContain("console-token");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("query-token");
    expect(serialized).not.toContain("context-key");
    expect(serialized).toContain("[REDACTED]");
  });

  it("redacts complete Authorization values across common header formats", () => {
    const cases = [
      ["Authorization: Basic dXNlcjpwYXNz", "Authorization: [REDACTED]"],
      [
        'Authorization: Digest username="admin", realm="private", nonce="digest-secret"',
        "Authorization: [REDACTED]",
      ],
      ['Authorization: "Bearer quoted-token"', "Authorization: [REDACTED]"],
      [
        '{"Authorization":"Basic anNvbl91c2VyOmpzb25fcGFzcw==","accept":"application/json"}',
        '{"Authorization":"[REDACTED]","accept":"application/json"}',
      ],
      ["aUtHoRiZaTiOn=Bearer mixed-case-token", "aUtHoRiZaTiOn=[REDACTED]"],
    ] as const;

    for (const [input, expected] of cases) {
      expect(reportError(input).message).toBe(expected);
    }
  });

  it("redacts semicolon parameters and folded Authorization continuations", () => {
    const entry = reportError(
      'Authorization: Digest username="user;AUTH_SUFFIX_A", response="AUTH_SUFFIX_B"\r\n\tnonce="AUTH_SUFFIX_C"\r\nContent-Type: application/json',
    );

    expect(entry.message).toContain("Authorization: [REDACTED]");
    expect(entry.message).toContain("Content-Type: application/json");
    expect(entry.message).not.toMatch(/AUTH_SUFFIX_[ABC]/);
  });

  it("redacts quote-prefixed physical header values through folded suffixes", () => {
    const entry = reportError(
      'Authorization: "AUTH_QUOTED_A"; response="AUTH_QUOTED_B"\r\n\tnonce="AUTH_QUOTED_C"\r\nCookie: "COOKIE_QUOTED_A"; csrf=COOKIE_QUOTED_B\r\nNext: keep',
    );

    expect(entry.message).toContain("Authorization: [REDACTED]");
    expect(entry.message).toContain("Cookie: [REDACTED]");
    expect(entry.message).toContain("Next: keep");
    expect(entry.message).not.toMatch(/(?:AUTH|COOKIE)_QUOTED_[ABC]/);
  });

  it("redacts complete Cookie and Set-Cookie header values", () => {
    const cases = [
      ["Cookie: session=cookie-secret; csrf=csrf-secret; theme=dark", "Cookie: [REDACTED]"],
      [
        "Set-Cookie: session=set-cookie-secret; Path=/; HttpOnly, csrf=csrf-secret; Path=/",
        "Set-Cookie: [REDACTED]",
      ],
      [
        "Set-Cookie: session=line-one-secret; Path=/; HttpOnly\nSet-Cookie: csrf=line-two-secret; Path=/; SameSite=Lax\nContent-Type: application/json",
        "Set-Cookie: [REDACTED]\nSet-Cookie: [REDACTED]\nContent-Type: application/json",
      ],
      [
        "Set-Cookie: session=folded-secret;\n  Path=/; csrf=continuation-secret\nContent-Type: application/json",
        "Set-Cookie: [REDACTED]\nContent-Type: application/json",
      ],
      [
        '{"cOoKiE":"session=json-cookie-secret; csrf=json-csrf-secret","sEt-CoOkIe":"session=json-set-cookie-secret; Path=/","accept":"application/json"}',
        '{"cOoKiE":"[REDACTED]","sEt-CoOkIe":"[REDACTED]","accept":"application/json"}',
      ],
    ] as const;

    for (const [input, expected] of cases) {
      expect(reportError(input).message).toBe(expected);
    }
  });

  it("bounds retained text so a single report cannot grow memory without limit", () => {
    const error = new Error("m".repeat(10_000));
    error.stack = "s".repeat(30_000);

    const entry = reportError(error, { context: "c".repeat(1_000) });

    expect(entry.message.length).toBeLessThanOrEqual(2_048);
    expect(entry.stack?.length).toBeLessThanOrEqual(12_000);
    expect(entry.context?.length).toBeLessThanOrEqual(256);
    expect(entry.message).toMatch(/…$/);
    expect(entry.stack).toMatch(/…$/);
    expect(entry.context).toMatch(/…$/);
  });

  it("installs console.error capture idempotently and calls the original exactly once", () => {
    const originalError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const uninstall = installErrorConsole();
    installErrorConsole();
    const error = new Error("Console exploded");

    try {
      console.error(error);

      expect(originalError).toHaveBeenCalledTimes(1);
      expect(originalError).toHaveBeenCalledWith(error);
      expect(getErrorConsoleSnapshot()).toHaveLength(1);
      expect(getErrorConsoleSnapshot()[0]).toMatchObject({
        source: "console",
        context: null,
        message: "Console exploded",
        stack: expect.stringContaining("Console exploded"),
      });
    } finally {
      uninstall();
      originalError.mockRestore();
    }
  });

  it("captures window error events and removes the listener on uninstall", () => {
    const uninstall = installErrorConsole();

    try {
      const capturedEvent = new ErrorEvent("error", {
        cancelable: true,
        message: "Window exploded",
        error: new Error("Window exploded"),
      });
      capturedEvent.preventDefault();
      window.dispatchEvent(capturedEvent);
      expect(getErrorConsoleSnapshot()).toHaveLength(1);
      expect(getErrorConsoleSnapshot()[0]).toMatchObject({
        source: "window",
        message: "Window exploded",
        stack: expect.stringContaining("Window exploded"),
      });

      uninstall();
      const suppressUnhandledTestEvent = (): void => undefined;
      window.addEventListener("error", suppressUnhandledTestEvent);
      const ignoredEvent = new ErrorEvent("error", {
        cancelable: true,
        message: "After uninstall",
        error: new Error("After uninstall"),
      });
      ignoredEvent.preventDefault();
      window.dispatchEvent(ignoredEvent);
      window.removeEventListener("error", suppressUnhandledTestEvent);
      expect(getErrorConsoleSnapshot()).toHaveLength(1);
    } finally {
      uninstall();
    }
  });

  it("captures unhandled promise rejections", () => {
    const suppressUnhandledTestEvent = (): void => undefined;
    window.addEventListener("unhandledrejection", suppressUnhandledTestEvent);
    const uninstall = installErrorConsole();
    const rejection = new Event("unhandledrejection", {
      cancelable: true,
    }) as PromiseRejectionEvent;
    Object.defineProperty(rejection, "reason", {
      value: new Error("Promise exploded"),
    });
    rejection.preventDefault();

    try {
      window.dispatchEvent(rejection);

      expect(getErrorConsoleSnapshot()).toHaveLength(1);
      expect(getErrorConsoleSnapshot()[0]).toMatchObject({
        source: "promise",
        context: null,
        message: "Promise exploded",
        stack: expect.stringContaining("Promise exploded"),
      });
    } finally {
      uninstall();
      window.removeEventListener("unhandledrejection", suppressUnhandledTestEvent);
    }
  });

  it("exposes a stable external-store API", () => {
    expect(errorConsole).toEqual({
      subscribe: subscribeToErrorConsole,
      get: getErrorConsoleSnapshot,
      getSnapshot: getErrorConsoleSnapshot,
      clear: clearErrorConsole,
      report: reportError,
      install: installErrorConsole,
    });
    expect(Object.isFrozen(errorConsole)).toBe(true);
  });

  it("does not recursively capture console errors emitted by subscribers", () => {
    const originalError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const uninstall = installErrorConsole();
    let notifications = 0;
    const unsubscribe = subscribeToErrorConsole(() => {
      notifications += 1;
      if (notifications === 1) console.error("Nested subscriber log");
    });

    try {
      console.error("Outer failure");

      expect(notifications).toBe(1);
      expect(getErrorConsoleSnapshot()).toHaveLength(1);
      expect(getErrorConsoleSnapshot()[0]?.message).toBe("Outer failure");
      expect(originalError).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      uninstall();
      originalError.mockRestore();
    }
  });

  it("normalizes primitive thrown values without throwing", () => {
    expect(reportError(null).message).toBe("Unknown error");
    expect(reportError(undefined).message).toBe("Unknown error");
    expect(reportError(503).message).toBe("503");
    expect(reportError(false).message).toBe("false");
    expect(reportError(12n).message).toBe("12");
    expect(reportError(Symbol("reason")).message).toBe("Symbol(reason)");
    expect(reportError("").message).toBe("Unknown error");
  });
});
