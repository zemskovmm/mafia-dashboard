import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BACKGROUND } from "../theme/background-preferences.js";
import { FANCY_PREPARATION_TIMEOUT_MS, useFancyPreparation } from "./useFancyPreparation.js";

const assets = vi.hoisted(() => ({ prepare: vi.fn(), ready: false, retry: vi.fn() }));
vi.mock("./fancy-assets.js", () => ({
  prepareFancyAssets: assets.prepare,
  areFancyAssetsReady: () => assets.ready,
  retryFancyAssets: assets.retry,
  fancyAssetKey: (request: unknown) => JSON.stringify(request),
}));
const request = { background: DEFAULT_BACKGROUND, glass: true, vgpu: true } as const;
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
beforeEach(() => {
  vi.useFakeTimers();
  assets.ready = false;
  assets.prepare.mockReset();
  assets.retry.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("effective visual preparation", () => {
  it("does not flash a loading state when re-enabling already prepared assets", () => {
    const statuses: string[] = [];
    const view = renderHook(
      ({ enabled }) => {
        const value = useFancyPreparation(enabled, request);
        statuses.push(value.status);
        return value;
      },
      { initialProps: { enabled: false } },
    );
    assets.ready = true;
    statuses.length = 0;
    view.rerender({ enabled: true });
    expect(statuses).not.toContain("preparing");
    expect(view.result.current.enabled).toBe(true);
    expect(assets.prepare).not.toHaveBeenCalled();
  });

  it("starts no assets while OFF and ignores completion after opting out", async () => {
    const pending = deferred();
    assets.prepare.mockReturnValue(pending.promise);
    const view = renderHook(({ enabled }) => useFancyPreparation(enabled, request), {
      initialProps: { enabled: false },
    });
    expect(view.result.current.status).toBe("off");
    expect(assets.prepare).not.toHaveBeenCalled();
    view.rerender({ enabled: true });
    expect(view.result.current.status).toBe("preparing");
    view.rerender({ enabled: false });
    await act(async () => pending.resolve());
    expect(view.result.current.enabled).toBe(false);
    expect(view.result.current.status).toBe("off");
  });

  it("keeps Continue lightweight across late success and changed assets until explicit opt-in", async () => {
    const pending = deferred();
    assets.prepare.mockReturnValue(pending.promise);
    const view = renderHook(
      ({ enabled, glass }) => useFancyPreparation(enabled, { ...request, glass }),
      {
        initialProps: { enabled: true, glass: true },
      },
    );
    act(() => view.result.current.skip());
    await act(async () => pending.resolve());
    view.rerender({ enabled: true, glass: false });
    expect(view.result.current.status).toBe("skipped");
    expect(view.result.current.enabled).toBe(false);
    expect(assets.prepare).toHaveBeenCalledTimes(1);
    view.rerender({ enabled: false, glass: false });
    assets.ready = true;
    view.rerender({ enabled: true, glass: false });
    expect(view.result.current.enabled).toBe(true);
  });

  it("bounds a stalled attempt, rejects its late success and permits an explicit retry", async () => {
    const old = deferred(),
      current = deferred();
    assets.prepare.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const view = renderHook(() => useFancyPreparation(true, request));
    act(() => vi.advanceTimersByTime(FANCY_PREPARATION_TIMEOUT_MS));
    expect(view.result.current.status).toBe("fallback");
    await act(async () => old.resolve());
    expect(view.result.current.enabled).toBe(false);
    act(() => view.result.current.retry());
    expect(view.result.current.status).toBe("preparing");
    await act(async () => current.resolve());
    expect(view.result.current.status).toBe("ready");
  });

  it("applies only the latest asset requirements and reports a current failure", async () => {
    const old = deferred(),
      current = deferred();
    assets.prepare.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const view = renderHook(({ glass }) => useFancyPreparation(true, { ...request, glass }), {
      initialProps: { glass: true },
    });
    view.rerender({ glass: false });
    await act(async () => old.resolve());
    expect(view.result.current.status).toBe("preparing");
    await act(async () => current.reject(new Error("missing asset")));
    expect(view.result.current.status).toBe("fallback");
  });
});
