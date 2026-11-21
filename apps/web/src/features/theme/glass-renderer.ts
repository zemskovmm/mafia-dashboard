import { createGlassBackdrop, MAX_GLASS_PIXELS, UNIFORM_COPY_DST } from "./glass-backdrop.js";
import { GLASS_PASS_SHADER } from "./vendor/arya3d/glass-pass.js";
import type { SurfaceOptics } from "./glass-preferences.js";

export type SceneRect = readonly [number, number, number, number];
export interface GlassSurfaceGeometry {
  readonly rect: SceneRect;
  readonly clip: SceneRect;
  readonly radius: number;
  readonly tint: readonly [number, number, number];
  readonly tintAmount?: number;
  readonly frosting?: number;
  readonly optics?: SurfaceOptics;
  readonly excludeTableFelt?: boolean;
  readonly selectionFinish?: number;
  readonly opacity: number;
  /** Gap is total original-width percent; both clipped halves stay in rect. */
  readonly tear?: { readonly progress: number; readonly gap: number };
  readonly roundedClips?: readonly { readonly rect: SceneRect; readonly radius: number }[];
}
export interface GlassSceneGeometry {
  readonly width: number;
  readonly height: number;
  readonly table: SceneRect;
  readonly panel: SceneRect;
  readonly nomination: SceneRect;
  readonly workspace: SceneRect;
  readonly workspaceRadius: number;

  readonly background: readonly number[];
  readonly top: readonly number[];
  readonly theme: readonly number[];
  readonly felt: readonly number[];
  readonly feltDark: readonly number[];
  readonly night: boolean;
  readonly gold: number;
  readonly strength: number;
  readonly matte: boolean;
  /** Legacy input accepted for callers; native optics always use the reference lens. */
  readonly profile?: "edge" | "simple";
  readonly frosting: number;
  readonly tintAmount: number;
  readonly edgeHighlights: number;
  readonly caustics: number;
  readonly surfaces: readonly GlassSurfaceGeometry[];
}

export interface GlassRenderer {
  draw: (scene: GlassSceneGeometry) => void;
  /** Always destroy owned resources; false skips unconfiguring the canvas. */
  dispose: (releaseContext?: boolean) => void;
}

const MAX_SURFACES = 256;
const MAX_DIMENSION = 4096;
const UNIFORM_FLOATS = 60; // Match the WGSL Uniform layout, including vec4 alignment.
const UNIFORM_BYTES = UNIFORM_FLOATS * Float32Array.BYTES_PER_ELEMENT;
const FRAGMENT_STAGE: GPUShaderStageFlags = 0x2;
const owners = new WeakMap<GPUCanvasContext, GlassRenderer>();
const pending = new WeakMap<HTMLCanvasElement, symbol>();

const bounded = (value: number, max = 1) =>
  Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : 0;

const createLens = async (device: GPUDevice, format: GPUTextureFormat) => {
  const bindings = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: FRAGMENT_STAGE,
        buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: UNIFORM_BYTES },
      },
      { binding: 1, visibility: FRAGMENT_STAGE, sampler: { type: "filtering" } },
      { binding: 2, visibility: FRAGMENT_STAGE, texture: { sampleType: "float" } },
    ],
  });
  const module = device.createShaderModule({ label: "arya3d glass lens", code: GLASS_PASS_SHADER });
  const pipeline = await device.createRenderPipelineAsync({
    label: "Shared glass lens pipeline",
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindings] }),
    vertex: { module, entryPoint: "vert_main" },
    fragment: {
      module,
      entryPoint: "frag_main",
      targets: [
        {
          format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        },
      ],
    },
  });
  return { bindings, pipeline };
};

export const createGlassRenderer = async (
  canvas: HTMLCanvasElement,
  backgroundImage?: HTMLImageElement,
  onLost?: () => void,
): Promise<GlassRenderer> => {
  const token = Symbol();
  pending.set(canvas, token);
  let device: GPUDevice | undefined;
  try {
    const gpu = navigator.gpu;
    const adapter = await gpu?.requestAdapter();
    if (!adapter) throw new Error("WebGPU is unavailable");
    if (pending.get(canvas) !== token) throw new Error("Glass renderer was superseded");
    const context = canvas.getContext("webgpu");
    if (!context || !("configure" in context)) throw new Error("WebGPU canvas is unavailable");
    device = await adapter.requestDevice();
    return await configureRenderer(
      canvas,
      context,
      device,
      gpu.getPreferredCanvasFormat(),
      token,
      backgroundImage,
      onLost,
    );
  } catch (error) {
    device?.destroy();
    throw error;
  } finally {
    if (pending.get(canvas) === token) pending.delete(canvas);
  }
};

const configureRenderer = async (
  canvas: HTMLCanvasElement,
  context: GPUCanvasContext,
  device: GPUDevice,
  format: GPUTextureFormat,
  token: symbol,
  backgroundImage?: HTMLImageElement,
  onLost?: () => void,
): Promise<GlassRenderer> => {
  const maximumSize = Math.min(MAX_DIMENSION, device.limits.maxTextureDimension2D);
  const alignment = device.limits.minUniformBufferOffsetAlignment;
  const stride = Math.ceil(UNIFORM_BYTES / alignment) * alignment;
  const strideFloats = stride / Float32Array.BYTES_PER_ELEMENT;
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  let backdrop: Awaited<ReturnType<typeof createGlassBackdrop>> | undefined;
  let buffer: GPUBuffer | undefined;
  let configured = false;
  try {
    const lens = await createLens(device, format);
    device.pushErrorScope("validation");
    let validation: GPUError | null;
    try {
      backdrop = await createGlassBackdrop(device, sampler, format, maximumSize, backgroundImage);
      buffer = device.createBuffer({
        label: "Shared glass surface uniforms",
        size: MAX_SURFACES * stride,
        usage: UNIFORM_COPY_DST,
      });
    } finally {
      validation = await device.popErrorScope();
    }
    if (validation) throw new Error(validation.message);
    if (pending.get(canvas) !== token) throw new Error("Glass renderer was superseded");
    owners.get(context)?.dispose(false);
    context.configure({ device, format, alphaMode: "opaque" });
    configured = true;
    const renderer = renderScene(
      canvas,
      context,
      device,
      lens,
      backdrop,
      sampler,
      buffer,
      maximumSize,
      stride,
      strideFloats,
      onLost,
    );
    owners.set(context, renderer);
    return renderer;
  } catch (error) {
    if (configured) context.unconfigure();
    backdrop?.dispose();
    buffer?.destroy();
    throw error;
  }
};

const renderScene = (
  canvas: HTMLCanvasElement,
  context: GPUCanvasContext,
  device: GPUDevice,
  lens: Awaited<ReturnType<typeof createLens>>,
  backdrop: Awaited<ReturnType<typeof createGlassBackdrop>>,
  sampler: GPUSampler,
  buffer: GPUBuffer,
  maximumSize: number,
  stride: number,
  strideFloats: number,
  onLost?: () => void,
): GlassRenderer => {
  const uniforms = new Float32Array(MAX_SURFACES * strideFloats);
  const scissors = new Uint32Array(MAX_SURFACES * 4);
  const dynamicOffset = new Uint32Array(1);
  let disposed = false;
  let textureView: GPUTextureView | undefined;
  let bindings: GPUBindGroup | undefined;

  const lose = () => {
    if (disposed) return;
    renderer.dispose();
    onLost?.();
  };
  const onGPUError = (event: GPUUncapturedErrorEvent) => {
    event.preventDefault();
    lose();
  };
  const renderer: GlassRenderer = {
    dispose(releaseContext = true) {
      if (disposed) return;
      disposed = true;
      device.removeEventListener("uncapturederror", onGPUError);
      if (owners.get(context) === renderer) {
        owners.delete(context);
        if (releaseContext) context.unconfigure();
      }
      backdrop.dispose();
      buffer.destroy();
      device.destroy();
    },
    draw(scene) {
      if (disposed) throw new Error("Glass renderer is unavailable");
      if (
        !Number.isFinite(scene.width) ||
        !Number.isFinite(scene.height) ||
        scene.width <= 0 ||
        scene.height <= 0
      )
        return;
      const dpr = Math.min(
        canvas.ownerDocument.defaultView?.devicePixelRatio || 1,
        1.5,
        maximumSize / scene.width,
        maximumSize / scene.height,
        Math.sqrt(MAX_GLASS_PIXELS / scene.width / scene.height),
      );
      const width = Math.max(1, Math.floor(scene.width * dpr));
      const height = Math.max(1, Math.floor(scene.height * dpr));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      const sx = width / scene.width;
      const sy = height / scene.height;

      let count = 0;
      for (const surface of scene.surfaces) {
        const [x, y, w, h] = surface.rect;
        const [cx, cy, cw, ch] = surface.clip;
        const opacity = bounded(surface.opacity);
        const clips = surface.roundedClips ?? [];
        if (!opacity || w <= 0 || h <= 0 || cw <= 0 || ch <= 0 || clips.length > 4) continue;
        const left = Math.max(0, Math.floor(Math.max(x, cx) * sx));
        const right = Math.min(width, Math.ceil(Math.min(x + w, cx + cw) * sx));
        const top = Math.max(0, Math.floor(Math.max(y, cy) * sy));
        const bottom = Math.min(height, Math.ceil(Math.min(y + h, cy + ch) * sy));
        if (!(right > left && bottom > top)) continue;
        // A partial frame would tell the host to hide CSS fallback for unpainted surfaces.
        if (count === MAX_SURFACES) throw new Error("Glass surface limit exceeded");
        scissors.set([left, top, right - left, bottom - top], count * 4);
        const offset = count * strideFloats;
        const selection = bounded(surface.selectionFinish ?? 0);
        const frosting = bounded(
          surface.frosting ?? (scene.matte ? scene.frosting : 0) + selection * 8,
          12,
        );
        const tear =
          (bounded(surface.tear?.progress ?? 0) * bounded(surface.tear?.gap ?? 0, 95)) / 100;
        const shortest = Math.min(w, h);
        const shine = surface.optics ? bounded(surface.optics.shine / 100) : undefined;
        uniforms.set(
          [
            x,
            y,
            w,
            h,
            1,
            h / w,
            (2 * bounded(surface.radius, shortest / 2)) / w,
            // arya3d's default bend depth, in units of the short side.
            (0.3 * shortest) / h,
            32 / h,
            0.04,
            0.008,
            32,
            shine ?? bounded(scene.edgeHighlights),
            0.15,
            0.3,
            bounded(surface.optics?.refraction ?? scene.strength, 24) / 14,
            x,
            y,
            w,
            h,
            cx,
            cy,
            cw,
            ch,
            ...surface.tint,
            bounded(surface.tintAmount ?? scene.tintAmount),
            opacity,
            frosting,
            selection,
            shine ?? bounded(scene.caustics),
            sx,
            sy,
            tear,
            0,
          ],
          offset,
        );
        // Reset absent optional geometry on every surface/frame.
        uniforms.fill(0, offset + 36, offset + UNIFORM_FLOATS);
        for (const [index, clip] of clips.entries()) {
          uniforms.set(clip.rect, offset + 36 + index * 4);
          uniforms[offset + 52 + index] = bounded(
            clip.radius,
            Math.min(clip.rect[2], clip.rect[3]) / 2,
          );
        }
        if (surface.excludeTableFelt) uniforms.set(scene.table, offset + 56);
        count++;
      }
      const encoder = device.createCommandEncoder();
      const view = backdrop.prepare(encoder, scene, width, height);
      if (view !== textureView) {
        bindings = device.createBindGroup({
          layout: lens.bindings,
          entries: [
            { binding: 0, resource: { buffer, size: UNIFORM_BYTES } },
            { binding: 1, resource: sampler },
            { binding: 2, resource: view },
          ],
        });
        textureView = view;
      }
      if (count) device.queue.writeBuffer(buffer, 0, uniforms.subarray(0, count * strideFloats));
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store" },
        ],
      });
      backdrop.paint(pass);
      if (count) {
        pass.setPipeline(lens.pipeline);
        for (let i = 0; i < count; i++) {
          const at = i * 4;
          pass.setScissorRect(
            scissors[at]!,
            scissors[at + 1]!,
            scissors[at + 2]!,
            scissors[at + 3]!,
          );
          dynamicOffset[0] = i * stride;
          pass.setBindGroup(0, bindings!, dynamicOffset);
          pass.draw(3);
        }
      }
      pass.end();
      device.queue.submit([encoder.finish()]);
    },
  };
  device.addEventListener("uncapturederror", onGPUError);
  void device.lost.then(lose);
  return renderer;
};
