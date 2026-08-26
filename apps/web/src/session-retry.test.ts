import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api/client.js";
import { SessionRetryController } from "./session-retry.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionRetryController", () => {
  it("tries a transient save three times before entering offline mode", async () => {
    vi.useFakeTimers();
    const flush = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const reportTerminal = vi.fn();
    const controller = new SessionRetryController({
      flush,
      probe: vi.fn(),
      pendingCount: () => 1,
      reportTerminal,
    });

    controller.requestAutoSync();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getSnapshot()).toMatchObject({ phase: "retrying", attempt: 1 });
    expect(flush).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(controller.getSnapshot()).toMatchObject({ phase: "retrying", attempt: 2 });
    expect(flush).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "offline",
      attempt: 3,
      terminalReason: "unreachable",
    });
    expect(flush).toHaveBeenCalledTimes(3);
    expect(reportTerminal).toHaveBeenCalledOnce();
  });

  it("returns to saved when a retry drains the pending queue", async () => {
    vi.useFakeTimers();
    let pending = 1;
    const flush = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockImplementationOnce(() => {
        pending = 0;
        return Promise.resolve();
      });
    const reportTerminal = vi.fn();
    const controller = new SessionRetryController({
      flush,
      probe: vi.fn(),
      pendingCount: () => pending,
      reportTerminal,
    });

    controller.requestAutoSync();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(flush).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot()).toMatchObject({ phase: "saved", attempt: 2 });
    expect(reportTerminal).not.toHaveBeenCalled();
  });

  it("stops immediately when the server rejects a non-retryable mutation", async () => {
    vi.useFakeTimers();
    const flush = vi.fn().mockRejectedValue(new ApiError("invalid mutation", 400, "invalid"));
    const reportTerminal = vi.fn();
    const controller = new SessionRetryController({
      flush,
      probe: vi.fn(),
      pendingCount: () => 1,
      reportTerminal,
    });

    controller.requestAutoSync();
    await vi.advanceTimersByTimeAsync(0);

    expect(flush).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "offline",
      attempt: 1,
      terminalReason: "rejected",
    });
    expect(reportTerminal).toHaveBeenCalledOnce();
  });

  it("uses a readiness probe when manual retry has no pending changes", async () => {
    const flush = vi.fn();
    const probe = vi.fn().mockResolvedValue(undefined);
    const controller = new SessionRetryController({
      flush,
      probe,
      pendingCount: () => 0,
      reportTerminal: vi.fn(),
    });

    controller.retryNow();
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("saved"));

    expect(probe).toHaveBeenCalledOnce();
    expect(flush).not.toHaveBeenCalled();
  });

  it("flushes a change enqueued while a readiness probe is in flight", async () => {
    let resolveProbe: (() => void) | undefined;
    let pending = 0;
    const probe = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const flush = vi.fn().mockImplementation(() => {
      pending = 0;
      return Promise.resolve();
    });
    const controller = new SessionRetryController({
      flush,
      probe,
      pendingCount: () => pending,
      reportTerminal: vi.fn(),
    });

    controller.retryNow();
    pending = 1;
    controller.requestAutoSync();
    resolveProbe?.();
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("saved"));

    expect(probe).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledOnce();
    expect(pending).toBe(0);
  });

  it("does not publish saved when a flush resolves with pending changes", async () => {
    vi.useFakeTimers();
    const flush = vi.fn().mockResolvedValue(undefined);
    const controller = new SessionRetryController({
      flush,
      probe: vi.fn(),
      pendingCount: () => 1,
      reportTerminal: vi.fn(),
    });

    controller.requestAutoSync();
    await vi.advanceTimersByTimeAsync(0);

    expect(flush).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({ phase: "retrying", attempt: 1 });
  });

  it("stays offline until a manual retry is requested", async () => {
    vi.useFakeTimers();
    let reachable = false;
    let pending = 1;
    const flush = vi.fn().mockImplementation(() => {
      if (!reachable) return Promise.reject(new TypeError("fetch failed"));
      pending = 0;
      return Promise.resolve();
    });
    const controller = new SessionRetryController({
      flush,
      probe: vi.fn(),
      pendingCount: () => pending,
      reportTerminal: vi.fn(),
    });

    controller.requestAutoSync();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(controller.getSnapshot().phase).toBe("offline");
    expect(flush).toHaveBeenCalledTimes(3);

    controller.requestAutoSync();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(flush).toHaveBeenCalledTimes(3);

    reachable = true;
    controller.retryNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(flush).toHaveBeenCalledTimes(4);
    expect(controller.getSnapshot()).toMatchObject({ phase: "saved", attempt: 1 });
  });

  it("does not start an overlapping flush while one is in flight", async () => {
    let resolveFlush: (() => void) | undefined;
    let pending = 1;
    const flush = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveFlush = resolve;
        }),
    );
    const controller = new SessionRetryController({
      flush,
      probe: vi.fn(),
      pendingCount: () => pending,
      reportTerminal: vi.fn(),
    });

    controller.requestAutoSync();
    controller.requestAutoSync();
    controller.retryNow();
    expect(flush).toHaveBeenCalledOnce();

    pending = 0;
    resolveFlush?.();
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("saved"));
    expect(flush).toHaveBeenCalledOnce();
  });
});
