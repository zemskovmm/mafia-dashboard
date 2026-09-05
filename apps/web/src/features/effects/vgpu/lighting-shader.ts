export const vgpuLightingShader = /* wgsl */ `
struct LightingConfig {
  resolution: vec2f,
  time: f32,
  variant: f32,
  primary: vec4f,
  secondary: vec4f,
  // Canvas padding, emitter corner radius and DPR, in physical pixels.
  geometry: vec4f,
}

@group(0) @binding(0) var<uniform> cfg: LightingConfig;

fn safe_resolution() -> vec2f {
  return max(cfg.resolution, vec2f(1.0));
}

fn emitter_distance(position: vec2f) -> f32 {
  let halfSize = max(safe_resolution() * 0.5 - vec2f(cfg.geometry.x), vec2f(1.0));
  let radius = clamp(cfg.geometry.y, 0.0, min(halfSize.x, halfSize.y));
  let q = abs(position - safe_resolution() * 0.5) - halfSize + vec2f(radius);
  return (length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - radius)
    / max(cfg.geometry.z, 1.0);
}

fn player_light(distance: f32) -> vec4f {
  let outside = max(distance, 0.0);
  let core = exp(-abs(distance) / 1.4);
  let halo = 0.32 * exp(-outside / 9.0);
  let spill = 0.23 * exp(-outside / 32.0);
  let padding = cfg.geometry.x / max(cfg.geometry.z, 1.0);
  let fade = 1.0 - smoothstep(padding * 0.65, padding - 2.0, outside);
  let breathe = 0.95 + 0.05 * sin(cfg.time * 1.4);
  // Light the surroundings, not the opaque card face and its content.
  let mask = smoothstep(-2.0, 0.0, distance);
  let alpha = min((core * 0.9 + halo + spill) * mask * fade * breathe, 0.98);
  let colour = mix(mix(cfg.primary.rgb, cfg.secondary.rgb, core), vec3f(1.0), core * 0.45);
  return vec4f(colour, alpha);
}

fn table_light(distance: f32) -> vec4f {
  let inward = max(-distance, 0.0);
  let core = exp(-abs(distance) / 1.25);
  let wash = (0.10 * exp(-inward / 8.0) + 0.08 * exp(-inward / 26.0))
    * (1.0 - smoothstep(0.0, 2.0, distance));
  let outer = 0.04 * exp(-abs(distance) / 6.0);
  let fade = 1.0 - smoothstep(12.0, 22.0, max(distance, 0.0));
  let breathe = 0.97 + 0.03 * sin(cfg.time * 0.8);
  let alpha = (core * 0.32 + wash + outer) * fade * breathe;
  return vec4f(mix(cfg.primary.rgb, cfg.secondary.rgb, core), alpha);
}

@fragment fn main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let distance = emitter_distance(position.xy);
  if (cfg.variant < 0.5) {
    return player_light(distance);
  }
  return table_light(distance);
}
`;
