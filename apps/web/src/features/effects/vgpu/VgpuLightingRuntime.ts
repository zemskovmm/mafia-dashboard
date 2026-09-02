import type { Effect, Frame, FrameLoopHandle, Gpu, Surface } from "vgpu";
import type * as VgpuModule from "vgpu";
import { vgpuLightingShader } from "./lighting-shader.js";

export type VgpuLightingModule = Pick<
  typeof VgpuModule,
  "clock" | "effect" | "frame" | "frameLoop" | "init" | "surface"
>;

export type VgpuLightingDescriptor =
  | Readonly<{
      kind: "player";
      primary: readonly [number, number, number];
      secondary: readonly [number, number, number];
    }>
  | Readonly<{ kind: "table"; cycle: "day" | "night" }>;

export interface VgpuLightingRegistration {
  readonly ready: Promise<void>;
  readonly dispose: () => void;
}

export interface VgpuLightingRuntime {
  readonly ready: Promise<void>;
  readonly register: (
    canvas: HTMLCanvasElement,
    descriptor: VgpuLightingDescriptor,
  ) => VgpuLightingRegistration;
  readonly setReducedMotion: (reduced: boolean) => void;
  readonly dispose: () => void;
}

interface RuntimeEntry {
  readonly surface: Surface;
  readonly effect: Effect;
  readonly descriptor: VgpuLightingDescriptor;
  active: boolean;
  ready: boolean;
}

const tableColours = {
  day: {
    primary: [1, 0.48, 0.15] as const,
    secondary: [1, 0.86, 0.34] as const,
  },
  night: {
    primary: [0.24, 0.31, 0.94] as const,
    secondary: [0.51, 0.29, 1] as const,
  },
};

const configFor = (entry: RuntimeEntry, time: number) => {
  const descriptor = entry.descriptor;
  const colours = descriptor.kind === "table" ? tableColours[descriptor.cycle] : descriptor;
  return {
    resolution: entry.surface.size,
    time,
    variant: descriptor.kind === "player" ? 0 : descriptor.cycle === "day" ? 1 : 2,
    primary: [...colours.primary, 1],
    secondary: [...colours.secondary, 1],
  };
};

class Runtime implements VgpuLightingRuntime {
  readonly #entries = new Set<RuntimeEntry>();
  readonly #clock;
  readonly #offError;
  readonly ready: Promise<void>;
  #resolveReady!: () => void;
  #readyResolved = false;
  #loop: FrameLoopHandle | undefined;
  #disposed = false;
  #failed = false;
  #reducedMotion = false;

  constructor(
    readonly module: VgpuLightingModule,
    readonly gpu: Gpu,
    readonly onError: (error: unknown) => void,
  ) {
    this.ready = new Promise((resolve) => {
      this.#resolveReady = resolve;
    });
    this.#clock = module.clock(gpu);
    this.#offError = gpu.onError((error) => this.#fail(error));
    void gpu.gpu.lost.then((info) => {
      if (!this.#disposed) this.#fail(new Error(`WebGPU device lost: ${info.message}`));
    });
  }

  register(
    canvas: HTMLCanvasElement,
    descriptor: VgpuLightingDescriptor,
  ): VgpuLightingRegistration {
    try {
      return this.#register(canvas, descriptor);
    } catch (error) {
      this.#fail(error);
      return { ready: Promise.reject(error), dispose: () => undefined };
    }
  }

  #register(
    canvas: HTMLCanvasElement,
    descriptor: VgpuLightingDescriptor,
  ): VgpuLightingRegistration {
    if (this.#disposed) throw new Error("V-GPU lighting runtime is disposed");
    const target = this.module.surface(this.gpu, canvas, {
      alphaMode: "premultiplied",
      autoResize: true,
      clearColor: [0, 0, 0, 0],
      dpr: [1, 2],
      label: `mafia-lighting-${descriptor.kind}`,
    });
    let shader: Effect;
    try {
      shader = this.module.effect(this.gpu, vgpuLightingShader, {
        blend: "alpha",
        label: `mafia-lighting-${descriptor.kind}`,
      });
    } catch (error) {
      target.dispose();
      throw error;
    }
    const entry: RuntimeEntry = {
      surface: target,
      effect: shader,
      descriptor,
      active: true,
      ready: false,
    };
    this.#entries.add(entry);
    let compileTimeout: ReturnType<typeof setTimeout>;
    const compiled = shader.compile({ colors: [target.format] }).then(() => {
      if (!entry.active || this.#disposed) return;
      entry.ready = true;
      if (this.#renderOnce()) {
        this.#startLoop();
        this.#markReady();
      }
    });
    const timedOut = new Promise<never>((_resolve, reject) => {
      compileTimeout = setTimeout(
        () => reject(new Error("V-GPU lighting shader compilation timed out")),
        8_000,
      );
    });
    const ready = Promise.race([compiled, timedOut])
      .catch((error: unknown) => {
        if (entry.active && !this.#disposed) this.#fail(error);
        throw error;
      })
      .finally(() => clearTimeout(compileTimeout));
    return {
      ready,
      dispose: () => {
        if (!entry.active) return;
        entry.active = false;
        this.#entries.delete(entry);
        target.dispose();
        if (![...this.#entries].some((candidate) => candidate.ready)) this.#stopLoop();
      },
    };
  }

  setReducedMotion(reduced: boolean): void {
    if (this.#disposed || reduced === this.#reducedMotion) return;
    this.#reducedMotion = reduced;
    if (reduced) {
      this.#stopLoop();
      this.#renderOnce();
    } else {
      this.#startLoop();
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stopLoop();
    this.#offError();
    for (const entry of this.#entries) {
      entry.active = false;
      entry.surface.dispose();
    }
    this.#entries.clear();
    this.gpu.dispose();
  }

  #startLoop(): void {
    if (
      this.#disposed ||
      this.#reducedMotion ||
      this.#loop !== undefined ||
      ![...this.#entries].some((entry) => entry.ready)
    )
      return;
    this.#loop = this.module.frameLoop(this.gpu, (currentFrame) => {
      try {
        this.#render(currentFrame, this.#clock.time);
      } catch (error) {
        this.#fail(error);
      }
    });
  }

  #stopLoop(): void {
    this.#loop?.stop();
    this.#loop = undefined;
  }

  #renderOnce(): boolean {
    if (this.#disposed) return false;
    try {
      this.module.frame(this.gpu, (currentFrame) => this.#render(currentFrame, 0));
      return true;
    } catch (error) {
      this.#fail(error);
      return false;
    }
  }

  #markReady(): void {
    if (this.#readyResolved) return;
    this.#readyResolved = true;
    this.#resolveReady();
  }

  #render(currentFrame: Frame, time: number): void {
    for (const entry of this.#entries) {
      if (!entry.active || !entry.ready) continue;
      entry.effect.set({ cfg: configFor(entry, time) });
      currentFrame.pass({ target: entry.surface, clear: [0, 0, 0, 0] }, (pass) =>
        pass.draw(entry.effect),
      );
    }
  }

  #fail(error: unknown): void {
    if (this.#disposed || this.#failed) return;
    this.#failed = true;
    try {
      this.onError(error);
    } finally {
      this.dispose();
    }
  }
}

export const createVgpuLightingRuntime = async (
  module: VgpuLightingModule,
  options: Readonly<{ onError: (error: unknown) => void }>,
): Promise<VgpuLightingRuntime> => {
  const gpu = await module.init();
  try {
    return new Runtime(module, gpu, options.onError);
  } catch (error) {
    gpu.dispose();
    throw error;
  }
};

export const loadVgpuLightingRuntime = async (
  options: Readonly<{ onError: (error: unknown) => void }>,
): Promise<VgpuLightingRuntime> => createVgpuLightingRuntime(await import("vgpu"), options);
