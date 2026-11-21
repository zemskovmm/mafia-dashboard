import type { GlassSceneGeometry } from "./glass-renderer.js";

export const BACKDROP_FORMAT: GPUTextureFormat = "rgba8unorm";
export const MAX_GLASS_PIXELS = 4_194_304;

// TS 6's DOM library has WebGPU interfaces but not the global flag constants.
export const UNIFORM_COPY_DST: GPUBufferUsageFlags = 0x40 | 0x08;
const RENDERABLE_TEXTURE: GPUTextureUsageFlags = 0x10 | 0x04;
const TEXTURE_COPY_DST: GPUTextureUsageFlags = 0x02;

// The backdrop and the table-workspace lens use the same CSS-pixel ellipse.
export const TABLE_ELLIPSE_WGSL = /* wgsl */ `
fn table_ellipse_radius(p: vec2f, table: vec4f) -> f32 {
    if (any(table.zw <= vec2f(0.0))) { return 1.0; }
    let half_size = table.zw * 0.5;
    return length((p - (table.xy + half_size)) / half_size);
}
`;

// CSS-pixel scene geometry, with the viewport's fixed center/cover image transform.
// Keep one texture as the source of truth for both the visible scene and all lenses.
const backdropShader = /* wgsl */ `
struct Scene {
    size: vec4f, // CSS size, backing store size
    image: vec4f, // cover scale, has image, workspace radius
    table: vec4f,
    panel: vec4f,
    nomination: vec4f,
    workspace: vec4f,
    background: vec4f,
    top: vec4f,
    theme: vec4f,
    felt: vec4f,
    felt_dark: vec4f,
    light: vec4f, // night, gold
};

@group(0) @binding(0) var<uniform> scene: Scene;
@group(0) @binding(1) var image_sampler: sampler;
@group(0) @binding(2) var image_texture: texture_2d<f32>;

${TABLE_ELLIPSE_WGSL}

@vertex
fn backdrop_vertex(@builtin(vertex_index) vertex: u32) -> @builtin(position) vec4f {
    const triangle = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
    return vec4f(triangle[vertex], 0, 1);
}

fn rounded_distance(p: vec2f, rect: vec4f, radius: f32) -> f32 {
    let q = abs(p - rect.xy - rect.zw * 0.5) - (rect.zw * 0.5 - radius);
    return length(max(q, vec2f(0))) + min(max(q.x, q.y), 0) - radius;
}

fn spot(uv: vec2f, center: vec2f, size: f32) -> f32 {
    let delta = uv - center;
    return exp(-dot(delta, delta) / (size * size));
}

@fragment
fn backdrop_fragment(@builtin(position) coord: vec4f) -> @location(0) vec4f {
    let uv = coord.xy / scene.size.zw;
    let p = coord.xy / (scene.size.zw / scene.size.xy);
    var color: vec3f;
    if (scene.image.z > 0.5) {
        color = textureSampleLevel(image_texture, image_sampler, (uv - 0.5) * scene.image.xy + 0.5, 0).rgb;
    } else {
        color = mix(scene.top.rgb, scene.background.rgb, saturate(uv.x * 0.4 + uv.y * 0.6));
        color += scene.theme.rgb * scene.light.y * 0.25 * exp(-dot(uv, uv) * 2.3);
        let t = (p.x * 0.829 + p.y * 0.559 + 390.0) % 195.0;
        let band = smoothstep(78.0, 95.0, t) * (1.0 - smoothstep(119.0, 144.0, t));
        let mask = mix(0.08, 0.8, smoothstep(0.0, 0.38, uv.y)) * (1.0 - 0.60 * smoothstep(0.82, 1.0, uv.y));
        color += vec3f(0.125, 0.120, 0.091) * band * mask;
        color += sin(p.x * 1.73 + p.y * 2.31) * sin(p.y * 1.17 - p.x * 0.83) * 0.002;
    }
    let distance_to_center = table_ellipse_radius(p, scene.table);
    if (distance_to_center < 1.0) {
        let center = scene.table.xy + scene.table.zw * 0.5;
        let night = scene.light.x;
        let table_uv = (p - scene.table.xy) / scene.table.zw;
        var felt = mix(scene.felt.rgb, scene.felt_dark.rgb, saturate(table_uv.y));
        felt = mix(felt, felt * vec3f(0.60, 0.65, 0.89), night * 0.52);
        felt += mix(vec3f(0.055, 0.038, 0.015), vec3f(0.013, 0.016, 0.045), night) * spot(table_uv, vec2f(0.24, 0.2), 0.25);
        let grain = sin(length(p - center) * 0.90) * 0.003;
        color = select(felt + grain, mix(vec3f(0.16, 0.11, 0.07), vec3f(0.12, 0.12, 0.20), night), distance_to_center > 0.965);
    }
    if (scene.panel.z > 0 && rounded_distance(p, scene.panel, 20.0) < 0) {
        let panel_uv = (p - scene.panel.xy) / scene.panel.zw;
        color = mix(color, vec3f(15, 16, 17) / 255.0, 0.48);
        color += vec3f(0.04) * max(0.0, 1.0 - panel_uv.x - panel_uv.y);
    }
    if (scene.nomination.z > 0 && rounded_distance(p, scene.nomination, 14.0) < 0) {
        color = mix(color, vec3f(0.04, 0.04, 0.03) + scene.theme.rgb * 0.08, 0.34);
    }
    if (scene.workspace.z > 0 && rounded_distance(p, scene.workspace, scene.image.w) < 0) {
        color = mix(color, vec3f(15, 16, 17) / 255.0, 0.48);
    }
    return vec4f(color, 1);
}

// The base pass copies the same texels the optics sample, not a second scene evaluation.
@group(0) @binding(3) var backdrop_texture: texture_2d<f32>;
@fragment
fn backdrop_copy(@builtin(position) coord: vec4f) -> @location(0) vec4f {
    return textureLoad(backdrop_texture, vec2i(coord.xy), 0);
}
`;

export const createGlassBackdrop = async (
  device: GPUDevice,
  sampler: GPUSampler,
  canvasFormat: GPUTextureFormat,
  maximumSize: number,
  image?: HTMLImageElement,
) => {
  const module = device.createShaderModule({
    label: "Shared glass backdrop",
    code: backdropShader,
  });
  const makePipeline = (entryPoint: string, format: GPUTextureFormat) =>
    device.createRenderPipelineAsync({
      layout: "auto",
      vertex: { module, entryPoint: "backdrop_vertex" },
      fragment: { module, entryPoint, targets: [{ format }] },
    });
  const [generate, copy] = await Promise.all([
    makePipeline("backdrop_fragment", BACKDROP_FORMAT),
    makePipeline("backdrop_copy", canvasFormat),
  ]);
  const imageWidth = image?.naturalWidth ?? 1;
  const imageHeight = image?.naturalHeight ?? 1;
  if (image && (!image.complete || !imageWidth || !imageHeight)) {
    throw new Error("Glass backdrop image is not ready");
  }
  const uploadScale = Math.min(
    1,
    maximumSize / Math.max(imageWidth, imageHeight),
    Math.sqrt(MAX_GLASS_PIXELS / imageWidth / imageHeight),
  );
  const imageSize: [number, number] = [
    Math.max(1, Math.floor(imageWidth * uploadScale)),
    Math.max(1, Math.floor(imageHeight * uploadScale)),
  ];
  // A 2D staging canvas also supports decoded SVGs on browsers that can't copy
  // SVG HTMLImageElements directly. No DOM capture or per-frame image upload.
  let source: HTMLCanvasElement | undefined;
  if (image) {
    source = image.ownerDocument.createElement("canvas");
    [source.width, source.height] = imageSize;
    const context = source.getContext("2d");
    if (!context) throw new Error("Glass backdrop image staging is unavailable");
    context.drawImage(image, 0, 0, source.width, source.height);
  }
  const uniforms = new Float32Array(48);
  const previous = new Float32Array(uniforms.length);
  const buffer = device.createBuffer({
    size: uniforms.byteLength,
    usage: UNIFORM_COPY_DST,
  });
  let imageTexture: GPUTexture | undefined;
  let texture: GPUTexture | undefined;
  let view: GPUTextureView;
  let copyBindings: GPUBindGroup;
  try {
    imageTexture = device.createTexture({
      size: imageSize,
      format: BACKDROP_FORMAT,
      usage: RENDERABLE_TEXTURE | TEXTURE_COPY_DST,
    });
    if (source)
      device.queue.copyExternalImageToTexture({ source }, { texture: imageTexture }, imageSize);
    const generationBindings = device.createBindGroup({
      layout: generate.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: imageTexture.createView() },
      ],
    });
    return {
      prepare(
        encoder: GPUCommandEncoder,
        scene: GlassSceneGeometry,
        width: number,
        height: number,
      ) {
        const cover = Math.max(scene.width / imageWidth, scene.height / imageHeight);
        uniforms.set([
          scene.width,
          scene.height,
          width,
          height,
          scene.width / (imageWidth * cover),
          scene.height / (imageHeight * cover),
          image ? 1 : 0,
          scene.workspaceRadius,
        ]);
        uniforms.set(scene.table, 8);
        uniforms.set(scene.panel, 12);
        uniforms.set(scene.nomination, 16);
        uniforms.set(scene.workspace, 20);
        uniforms.set(scene.background.slice(0, 3), 24);
        uniforms.set(scene.top.slice(0, 3), 28);
        uniforms.set(scene.theme.slice(0, 3), 32);
        uniforms.set(scene.felt.slice(0, 3), 36);
        uniforms.set(scene.feltDark.slice(0, 3), 40);
        uniforms[44] = scene.night ? 1 : 0;
        uniforms[45] = scene.gold;
        if (texture && uniforms.every((value, index) => value === previous[index])) return view;

        if (texture?.width !== width || texture.height !== height) {
          texture?.destroy();
          texture = device.createTexture({
            label: "Shared glass scene texture",
            size: [width, height],
            format: BACKDROP_FORMAT,
            usage: RENDERABLE_TEXTURE,
          });
          view = texture.createView();
          copyBindings = device.createBindGroup({
            layout: copy.getBindGroupLayout(0),
            entries: [{ binding: 3, resource: view }],
          });
        }
        device.queue.writeBuffer(buffer, 0, uniforms);
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view, loadOp: "clear", storeOp: "store" }],
        });
        pass.setPipeline(generate);
        pass.setBindGroup(0, generationBindings);
        pass.draw(3);
        pass.end();
        previous.set(uniforms);
        return view;
      },
      paint(pass: GPURenderPassEncoder) {
        pass.setPipeline(copy);
        pass.setBindGroup(0, copyBindings);
        pass.draw(3);
      },
      dispose() {
        buffer.destroy();
        imageTexture?.destroy();
        texture?.destroy();
      },
    };
  } catch (error) {
    buffer.destroy();
    imageTexture?.destroy();
    throw error;
  } finally {
    if (source) source.width = 0;
  }
};
