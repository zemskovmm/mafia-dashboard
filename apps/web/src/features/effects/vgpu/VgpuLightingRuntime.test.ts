import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVgpuLightingRuntime, type VgpuLightingModule } from "./VgpuLightingRuntime.js";

let resized: ResizeObserverCallback;
const disconnect = vi.fn();
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resized = callback;
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = disconnect;
    },
  );
});
afterEach(() => vi.unstubAllGlobals());
const resize = (target: HTMLCanvasElement) =>
  resized(
    [
      {
        target,
        contentRect: target.getBoundingClientRect(),
        borderBoxSize: [],
        contentBoxSize: [],
        devicePixelContentBoxSize: [],
      },
    ],
    {} as ResizeObserver,
  );

const setupModule = () => {
  const stop = vi.fn();
  const gpu = {
    disposed: false,
    gpu: { lost: new Promise(() => undefined) },
    onError: vi.fn(() => vi.fn()),
    settled: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  };
  const surfaces: Array<{
    format: GPUTextureFormat;
    size: [number, number];
    dpr: number;
    read: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  const effects: Array<{
    compile: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    draw: ReturnType<typeof vi.fn>;
  }> = [];
  const pass = { draw: vi.fn() };
  const currentFrame = {
    pass: vi.fn((_options: unknown, body: (value: typeof pass) => void) => body(pass)),
  };
  let loopCallback: ((frame: typeof currentFrame) => void) | undefined;
  const module = {
    init: vi.fn().mockResolvedValue(gpu),
    surface: vi.fn(() => {
      const created = {
        format: "bgra8unorm" as GPUTextureFormat,
        size: [200, 100] as [number, number],
        dpr: 1,
        read: vi.fn().mockResolvedValue(Uint8Array.from([0, 0, 0, 255])),
        dispose: vi.fn(),
      };
      surfaces.push(created);
      return created;
    }),
    effect: vi.fn(() => {
      const created = {
        compile: vi.fn().mockResolvedValue(undefined),
        set: vi.fn(),
        draw: vi.fn(),
      };
      effects.push(created);
      return created;
    }),
    frameLoop: vi.fn((_gpu: unknown, callback: (frame: typeof currentFrame) => void) => {
      loopCallback = callback;
      return { stop };
    }),
    frame: vi.fn((_gpu: unknown, callback: (frame: typeof currentFrame) => void) =>
      callback(currentFrame),
    ),
    clock: vi.fn(() => ({ time: 2, deltaTime: 1 / 60, frameCount: 1 })),
  } as unknown as VgpuLightingModule;
  return {
    module,
    gpu,
    surfaces,
    effects,
    stop,
    currentFrame,
    pass,
    loop: () => loopCallback,
  };
};

describe("VgpuLightingRuntime", () => {
  it("keeps padded card geometry in CSS pixels across DPR and reduced-motion resize", async () => {
    const env = setupModule();
    const runtime = await createVgpuLightingRuntime(env.module, { onError: vi.fn() });
    const canvas = document.createElement("canvas");
    canvas.style.borderTopLeftRadius = "14px";
    document.body.append(canvas);
    const registration = runtime.register(canvas, {
      kind: "player",
      primary: [1, 0.74, 0.3],
      secondary: [1, 0.9, 0.64],
    });
    await registration.ready;
    expect(env.effects[0]!.set).toHaveBeenLastCalledWith({
      cfg: expect.objectContaining({ geometry: [96, 14, 1, 0] }),
    });
    runtime.setReducedMotion(true);
    env.surfaces[0]!.dpr = 2;
    env.surfaces[0]!.size = [576, 536];
    canvas.style.borderTopLeftRadius = "10px";
    resize(canvas);
    expect(env.effects[0]!.set).toHaveBeenLastCalledWith({
      cfg: expect.objectContaining({ resolution: [576, 536], geometry: [192, 20, 2, 0], time: 0 }),
    });
    runtime.dispose();
    expect(disconnect).toHaveBeenCalled();
  });

  it("aligns a circular or compact rounded table emitter with its padded surface", async () => {
    const env = setupModule();
    const runtime = await createVgpuLightingRuntime(env.module, { onError: vi.fn() });
    const canvas = document.createElement("canvas");
    canvas.style.borderTopLeftRadius = "50%";
    const table = document.createElement("div");
    table.className = "round-table";
    table.style.borderTopLeftRadius = "50%";
    table.append(canvas);
    document.body.append(table);
    const registration = runtime.register(canvas, { kind: "table", cycle: "day" });
    env.surfaces[0]!.size = [744, 744];
    await registration.ready;
    expect(env.effects[0]!.set).toHaveBeenLastCalledWith({
      cfg: expect.objectContaining({ geometry: [24, 348, 1, 0] }),
    });
    table.style.borderTopLeftRadius = "16px";
    env.surfaces[0]!.size = [400, 700];
    resize(canvas);
    env.loop()?.(env.currentFrame);
    expect(env.effects[0]!.set).toHaveBeenLastCalledWith({
      cfg: expect.objectContaining({ geometry: [24, 16, 1, 0] }),
    });
    runtime.dispose();
  });

  it("disposes the GPU if runtime setup fails after initialization", async () => {
    const env = setupModule();
    vi.mocked(env.module.clock).mockImplementationOnce(() => {
      throw new Error("clock failed");
    });

    await expect(createVgpuLightingRuntime(env.module, { onError: vi.fn() })).rejects.toThrow(
      "clock failed",
    );
    expect(env.gpu.dispose).toHaveBeenCalledOnce();
  });

  it("shares one GPU and loop while owning one surface and effect per canvas", async () => {
    const env = setupModule();
    const runtime = await createVgpuLightingRuntime(env.module, { onError: vi.fn() });
    expect(env.module.frameLoop).not.toHaveBeenCalled();
    const firstSurfaceReady = (runtime as typeof runtime & { ready: Promise<void> }).ready;
    const first = runtime.register(document.createElement("canvas"), {
      kind: "player",
      primary: [1, 0, 0],
      secondary: [1, 0, 0],
    });
    const second = runtime.register(document.createElement("canvas"), {
      kind: "table",
      cycle: "night",
    });

    await Promise.all([first.ready, second.ready, firstSurfaceReady]);
    expect(env.module.init).toHaveBeenCalledOnce();
    expect(env.module.frameLoop).toHaveBeenCalledOnce();
    expect(env.module.frame).toHaveBeenCalled();
    expect(env.surfaces).toHaveLength(2);
    expect(env.effects).toHaveLength(2);

    const passCountBeforeLoop = env.currentFrame.pass.mock.calls.length;
    env.loop()?.(env.currentFrame);
    expect(env.currentFrame.pass).toHaveBeenCalledTimes(passCountBeforeLoop + 2);
    expect(env.effects[0]!.set).toHaveBeenCalledWith({
      cfg: expect.objectContaining({ variant: 0, time: 2 }),
    });
    expect(env.effects[1]!.set).toHaveBeenCalledWith({
      cfg: expect.objectContaining({ variant: 2, time: 2 }),
    });

    first.dispose();
    expect(env.surfaces[0]!.dispose).toHaveBeenCalledOnce();
    expect(env.stop).not.toHaveBeenCalled();
    second.dispose();
    expect(env.stop).toHaveBeenCalledOnce();
    runtime.dispose();
    expect(env.stop).toHaveBeenCalledOnce();
    expect(env.surfaces[1]!.dispose).toHaveBeenCalledOnce();
    expect(env.gpu.dispose).toHaveBeenCalledOnce();
  });

  it("does not publish readiness when starting the shared loop fails", async () => {
    const env = setupModule();
    const onError = vi.fn();
    const runtime = await createVgpuLightingRuntime(env.module, { onError });
    vi.mocked(env.module.frameLoop).mockImplementationOnce(() => {
      throw new Error("frame loop failed");
    });
    let ready = false;
    void runtime.ready.then(() => {
      ready = true;
    });

    const registration = runtime.register(document.createElement("canvas"), {
      kind: "table",
      cycle: "day",
    });

    await expect(registration.ready).rejects.toThrow("frame loop failed");
    await Promise.resolve();
    expect(ready).toBe(false);
    expect(onError).toHaveBeenCalledOnce();
    expect(env.gpu.dispose).toHaveBeenCalledOnce();
  });

  it("stops animation and renders one static frame for reduced motion", async () => {
    const env = setupModule();
    const runtime = await createVgpuLightingRuntime(env.module, { onError: vi.fn() });
    const registration = runtime.register(document.createElement("canvas"), {
      kind: "table",
      cycle: "day",
    });
    await registration.ready;

    runtime.setReducedMotion(true);

    expect(env.stop).toHaveBeenCalledOnce();
    expect(env.module.frame).toHaveBeenCalled();
    expect(env.effects[0]!.set).toHaveBeenLastCalledWith({
      cfg: expect.objectContaining({ time: 0, variant: 1 }),
    });
    runtime.dispose();
  });

  it("reports a current render failure once and tears down", async () => {
    const env = setupModule();
    const onError = vi.fn();
    const runtime = await createVgpuLightingRuntime(env.module, { onError });
    const registration = runtime.register(document.createElement("canvas"), {
      kind: "table",
      cycle: "day",
    });
    await registration.ready;
    env.currentFrame.pass.mockImplementationOnce(() => {
      throw new Error("render failed");
    });

    expect(() => env.loop()?.(env.currentFrame)).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();
    expect(env.gpu.dispose).toHaveBeenCalledOnce();
  });

  it("turns a synchronous canvas-surface failure into a handled runtime failure", async () => {
    const env = setupModule();
    const onError = vi.fn();
    const runtime = await createVgpuLightingRuntime(env.module, { onError });
    vi.mocked(env.module.surface).mockImplementationOnce(() => {
      throw new Error("surface failed");
    });

    const registration = runtime.register(document.createElement("canvas"), {
      kind: "table",
      cycle: "day",
    });

    await expect(registration.ready).rejects.toThrow("surface failed");
    expect(onError).toHaveBeenCalledOnce();
    expect(env.gpu.dispose).toHaveBeenCalledOnce();
  });

  it("disposes a partial surface when effect creation fails synchronously", async () => {
    const env = setupModule();
    const onError = vi.fn();
    const runtime = await createVgpuLightingRuntime(env.module, { onError });
    vi.mocked(env.module.effect).mockImplementationOnce(() => {
      throw new Error("effect failed");
    });

    const registration = runtime.register(document.createElement("canvas"), {
      kind: "player",
      primary: [1, 0, 0],
      secondary: [1, 0, 0],
    });

    await expect(registration.ready).rejects.toThrow("effect failed");
    expect(env.surfaces[0]?.dispose).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(env.gpu.dispose).toHaveBeenCalledOnce();
  });

  it("falls back when a surface shader does not compile promptly", async () => {
    vi.useFakeTimers();
    const env = setupModule();
    env.module.effect = vi.fn(() => ({
      compile: vi.fn(() => new Promise(() => undefined)),
      set: vi.fn(),
      draw: vi.fn(),
    })) as never;
    const onError = vi.fn();
    const runtime = await createVgpuLightingRuntime(env.module, { onError });
    const registration = runtime.register(document.createElement("canvas"), {
      kind: "player",
      primary: [1, 0, 0],
      secondary: [1, 0, 0],
    });
    const rejected = expect(registration.ready).rejects.toThrow("timed out");

    await vi.advanceTimersByTimeAsync(8_000);

    await rejected;
    expect(onError).toHaveBeenCalledOnce();
    expect(env.gpu.dispose).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
