export const vgpuLightingShader = /* wgsl */ `
struct LightingConfig {
  resolution: vec2f,
  time: f32,
  variant: f32,
  primary: vec4f,
  secondary: vec4f,
  // Canvas padding, emitter corner radius and DPR, in physical pixels.
  geometry: vec4f,
  // Player pulse speed/amplitude and semantic fire flag; table stays independent.
  pulse: vec4f,
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
  let breathe = 1.0 - cfg.pulse.y + cfg.pulse.y * sin(cfg.time * 1.4 * cfg.pulse.x);
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

// Mode 1 of the approved fire study: turbulent, layered flame sheets. The
// source study draws it over the card with CSS screen blending; this canvas is
// straight-alpha, so the helper below maps that screen result over the card's
// dark material into a non-opaque source colour and alpha.
fn fire_hash(p: vec3f) -> f32 {
  let q = fract(p * 0.3183099 + vec3f(0.11, 0.27, 0.37));
  let r = q * 17.0;
  return fract(r.x * r.y * r.z * (r.x + r.y + r.z));
}

fn fire_noise(p: vec3f) -> f32 {
  let cell = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(
      mix(fire_hash(cell), fire_hash(cell + vec3f(1.0, 0.0, 0.0)), u.x),
      mix(fire_hash(cell + vec3f(0.0, 1.0, 0.0)), fire_hash(cell + vec3f(1.0, 1.0, 0.0)), u.x),
      u.y,
    ),
    mix(
      mix(fire_hash(cell + vec3f(0.0, 0.0, 1.0)), fire_hash(cell + vec3f(1.0, 0.0, 1.0)), u.x),
      mix(fire_hash(cell + vec3f(0.0, 1.0, 1.0)), fire_hash(cell + vec3f(1.0, 1.0, 1.0)), u.x),
      u.y,
    ),
    u.z,
  );
}

fn fire_fbm(p: vec3f) -> f32 {
  return 0.57 * fire_noise(p)
    + 0.28 * fire_noise(p * 2.07 + vec3f(3.1))
    + 0.15 * fire_noise(p * 4.13 + vec3f(8.3));
}

fn screen_to_straight_alpha(screenEmission: vec3f) -> vec4f {
  let emission = clamp(screenEmission, vec3f(0.0), vec3f(1.0));
  let alpha = max(max(emission.r, emission.g), emission.b);
  if (alpha <= 0.0001) {
    return vec4f(0.0);
  }
  // Fixed prototype reference material; production card gradients can differ.
  let backdrop = vec3f(23.0 / 255.0, 20.0 / 255.0, 22.0 / 255.0);
  let screened = 1.0 - (1.0 - backdrop) * (1.0 - emission);
  let colour = clamp(
    (screened - backdrop * (1.0 - alpha)) / alpha,
    vec3f(0.0),
    vec3f(1.0),
  );
  return vec4f(colour, alpha);
}

fn player_fire(position: vec2f, distance: f32) -> vec4f {
  // Keep the fire contribution entirely inside the same rounded SDF as the card.
  if (distance >= 0.0) {
    return vec4f(0.0);
  }
  let dpr = max(cfg.geometry.z, 1.0);
  let halfSize = max((safe_resolution() * 0.5 - vec2f(cfg.geometry.x)) / dpr, vec2f(1.0));
  let local = (position - safe_resolution() * 0.5) / dpr;
  let topDownUv = clamp((local + halfSize) / (halfSize * 2.0), vec2f(0.0), vec2f(1.0));
  // WebGL's study uses bottom-up UVs, while @builtin(position) is top-down.
  let uv = vec2f(topDownUv.x, 1.0 - topDownUv.y);
  let x = uv.x;
  let y = uv.y;
  // cfg.time remains the runtime clock: selected speed 1.6x retains the study's 0.65 factor.
  let t = cfg.time * 1.6 * 0.65;
  let rise = y / 0.85;
  var sum = vec3f(0.0);
  var absorption = 0.0;
  for (var i = 0; i < 14; i++) {
    let z = f32(i) / 13.0 - 0.5;
    var p = vec3f(x * 5.3, rise * 3.2 - t * 2.0, z * 2.0 + 9.0);
    let bend = fire_fbm(vec3f(x * 3.0, rise * 2.0 - t * 0.75, z + 7.0));
    p.x += (bend - 0.5) * (1.2 + rise * 2.1);
    p.y += 0.5 * fire_fbm(p * 0.65 + vec3f(4.0));
    let noise = fire_fbm(p);
    let detail = fire_noise(p * 7.1 + vec3f(0.0, -t, 0.0));
    let root = 0.24 + 0.22 * fire_noise(vec3f(x * 7.0, 0.0, 4.0));
    let field = noise - rise * 0.53 + root - 0.47 - abs(z) * 0.19;
    var body = smoothstep(-0.025, 0.055, field)
      * (1.0 - smoothstep(0.16, 0.30, field));
    body *= 0.65 + 0.35 * detail;
    let tip = 1.0 - smoothstep(0.64, 1.05, rise);
    let density = body * tip * 0.15;
    let temperature = clamp(field * 2.8 + (1.0 - rise) * 0.4 + detail * 0.14, 0.0, 1.0);
    var colour = mix(vec3f(0.78, 0.058, 0.004), vec3f(1.0, 0.37, 0.032), smoothstep(0.06, 0.5, temperature));
    colour = mix(colour, vec3f(1.0, 0.77, 0.31), pow(temperature, 3.0));
    sum += (1.0 - absorption) * colour * density;
    absorption += (1.0 - absorption) * density * 0.64;
  }
  // Protect card content in the same way as the reference sample.
  let side = pow(abs(x * 2.0 - 1.0), 1.4);
  let reading = 1.0 - 0.77 * exp(-pow(abs((x - 0.5) / 0.29), 4.0) - pow(abs((y - 0.52) / 0.24), 4.0));
  let edge = smoothstep(0.0, 0.025, x) * smoothstep(0.0, 0.025, 1.0 - x);
  let base = exp(-y * 24.0) * (0.55 + 0.45 * fire_noise(vec3f(x * 44.0, t * 0.7, 1.0)));
  sum += vec3f(0.27, 0.041, 0.003) * base;
  sum *= 0.50 * 1.5 * reading * edge * mix(0.65, 1.0, side);
  return screen_to_straight_alpha(sum);
}

@fragment fn main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let distance = emitter_distance(position.xy);
  if (cfg.variant < 0.5) {
    let glow = player_light(distance);
    if (cfg.pulse.z > 0.5) {
      let fire = player_fire(position.xy, distance);
      let alpha = fire.a + glow.a * (1.0 - fire.a);
      return vec4f((fire.rgb * fire.a + glow.rgb * glow.a * (1.0 - fire.a)) / max(alpha, 0.001), alpha);
    }
    return glow;
  }
  return table_light(distance);
}
`;
