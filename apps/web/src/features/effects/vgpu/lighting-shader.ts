export const vgpuLightingShader = /* wgsl */ `
struct LightingConfig {
  resolution: vec2f,
  time: f32,
  variant: f32,
  primary: vec4f,
  secondary: vec4f,
}

@group(0) @binding(0) var<uniform> cfg: LightingConfig;

fn safe_resolution() -> vec2f {
  return max(cfg.resolution, vec2f(1.0));
}

fn player_light(uv: vec2f) -> vec4f {
  let aspect = cfg.resolution.x / max(cfg.resolution.y, 1.0);
  var nearestDistance = 100.0;
  var nearestIndex = 0u;
  for (var i = 0u; i < 16u; i = i + 1u) {
    let side = i / 4u;
    let offset = (f32(i % 4u) + 0.5) / 4.0;
    var centre = vec2f(0.0);
    if (side == 0u) {
      centre = vec2f(offset, 0.10);
    } else if (side == 1u) {
      centre = vec2f(0.90, offset);
    } else if (side == 2u) {
      centre = vec2f(1.0 - offset, 0.90);
    } else {
      centre = vec2f(0.10, 1.0 - offset);
    }
    var delta = uv - centre;
    delta.x *= aspect;
    let distanceSquared = dot(delta, delta);
    if (distanceSquared < nearestDistance) {
      nearestDistance = distanceSquared;
      nearestIndex = i;
    }
  }
  let distanceToLed = sqrt(nearestDistance);
  let core = 1.0 - smoothstep(0.018, 0.038, distanceToLed);
  let glow = 1.0 - smoothstep(0.030, 0.085, distanceToLed);
  let phase = f32(nearestIndex) / 16.0;
  let chase = 0.66 + 0.34 * pow(0.5 + 0.5 * cos(phase * 6.2832 - cfg.time * 4.6), 4.0);
  let colour = mix(cfg.primary, cfg.secondary, f32(nearestIndex % 2u));
  let alpha = clamp(core * chase + glow * 0.34, 0.0, 1.0);
  return vec4f(colour.rgb * (0.76 + core * 0.52), alpha);
}

fn table_light(uv: vec2f, resolution: vec2f) -> vec4f {
  var p = uv - vec2f(0.5);
  p.x *= resolution.x / max(resolution.y, 1.0);
  let radius = length(p);
  let angle = atan2(p.y, p.x);
  let ring = exp(-abs(radius - 0.39) * 20.0);
  let outer = exp(-abs(radius - 0.39) * 12.0) * 0.28;
  let chase = pow(0.5 + 0.5 * cos(angle * 11.0 - cfg.time * 2.8), 5.0);
  let fade = 0.72 + 0.28 * sin(cfg.time * 1.3 + angle * 2.0);
  let colour = mix(cfg.primary, cfg.secondary, 0.5 + 0.5 * sin(angle * 3.0 + cfg.time));
  let alpha = clamp((ring * (0.52 + 0.48 * chase) + outer) * fade, 0.0, 0.94);
  return vec4f(colour.rgb * (0.78 + chase * 0.42), alpha);
}

@fragment fn main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let resolution = safe_resolution();
  let uv = position.xy / resolution;
  if (cfg.variant < 0.5) {
    return player_light(uv);
  }
  return table_light(uv, resolution);
}
`;
