import { PLAYER_TEAR_SEAM_POINTS } from "../../../effects/player-tear-geometry.js";
import { TABLE_ELLIPSE_WGSL } from "../../glass-backdrop.js";

// Adapted from src/glassPassShader.ts and src/glassUniforms.ts at:
// https://github.com/arya3d/liquid-glass-webgpu/tree/90cb73931bbaf38bd54b3263cd3fda1daef1869c
// Dashboard adaptations: CSS-pixel lens coordinates, shared scene sampling,
// per-surface clipping/tear, straight-alpha overlay, and material controls.
export const GLASS_PASS_SHADER = /* wgsl */ `
/*
MIT License

Copyright (c) 2026 arya3d

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

struct Uniform {
    canvas_position: vec2f,
    resolution: vec2f,
    width: f32,
    height: f32,
    radius: f32,
    lens_refraction: f32,
    sharp: f32,
    f0: f32,
    dispersion: f32,
    spec_power: f32,
    edge_highlight: f32,
    rim_strength: f32,
    fresnel: f32,
    strength: f32,
    rect: vec4f,
    clip: vec4f,
    tint: vec4f,
    material: vec4f, // opacity, frosting (CSS px), selection finish, caustics
    geometry: vec4f, // backing pixels per CSS pixel (xy), tear gap fraction (z)
    rounded_clips: array<vec4f, 4>,
    clip_radii: vec4f,
    excluded_ellipse: vec4f, // the backdrop's felt bounds for the table-workspace lens only
};

@group(0) @binding(0) var<uniform> uniforms: Uniform;
@group(0) @binding(1) var page_sampler: sampler;
@group(0) @binding(2) var page_texture: texture_2d<f32>;

${TABLE_ELLIPSE_WGSL}

const MASK_SHARPNESS = 32.0;
const FACE_ON_SPREAD_CUT = 0.909;
const RIM_POWER = 3.0;
const SPECULAR_ON_RING = 0.5;
const VIEW_DIRECTION = vec3f(0.0, 0.0, 1.0);
const KEY_LIGHT = vec3f(0.3, -0.5, 1.0);

@vertex
fn vert_main(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4f {
    const triangle = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
    return vec4f(triangle[vertex_index], 0, 1);
}

fn canvas_aspect() -> f32 {
    return uniforms.resolution.x / uniforms.resolution.y;
}

fn pixel_to_glass_space(pixel: vec2f) -> vec2f {
    var position = pixel / uniforms.resolution - 0.5;
    position.x *= canvas_aspect();
    return position;
}

fn canvas_pixel_to_page_uv(canvas_pixel: vec2f) -> vec2f {
    let page_pixel = (canvas_pixel + uniforms.canvas_position) * uniforms.geometry.xy;
    let page_size = vec2f(textureDimensions(page_texture));
    return page_pixel / page_size;
}

fn glass_space_to_page_uv(position: vec2f) -> vec2f {
    let unstretched = vec2f(position.x / canvas_aspect(), position.y);
    let canvas_pixel = (unstretched + 0.5) * uniforms.resolution;
    return canvas_pixel_to_page_uv(canvas_pixel);
}

fn sample_page(position: vec2f) -> vec4f {
    let page_uv = glass_space_to_page_uv(position);
    return textureSampleLevel(page_texture, page_sampler, page_uv, 0.0);
}

fn rounded_box_distance(point: vec2f, half_size: vec2f, corner_radius: f32) -> f32 {
    let from_corner = abs(point) - half_size + corner_radius;
    let outside = length(max(from_corner, vec2f(0.0)));
    let inside = min(max(from_corner.x, from_corner.y), 0.0);
    return outside + inside - corner_radius;
}

fn tear_distance(p: vec2f, half_size: vec2f, radius: f32, side: f32) -> f32 {
    // Compress each full-card clipped half toward its own exterior edge.
    let scale = 1.0 - uniforms.geometry.z;
    let offset = select(1.0 - scale, 0.0, side > 0.0);
    let size = half_size * 2.0;
    let local = vec2f((p.x - offset * size.x) / scale, p.y);
    let outer = rounded_box_distance(local - half_size, half_size, radius) * scale;
    const seam = array(
        ${PLAYER_TEAR_SEAM_POINTS.map(([x, y]) => `vec2f(${x}, ${y})`).join(", ")}
    );
    var seam_x = size.x * (0.5 * scale + offset);
    var distance = 1e20;
    for (var i = 0u; i < ${PLAYER_TEAR_SEAM_POINTS.length - 1}u; i++) {
        let a = vec2f(seam[i].x * scale + offset, seam[i].y) * size;
        let b = vec2f(seam[i + 1u].x * scale + offset, seam[i + 1u].y) * size;
        let edge = b - a;
        distance = min(distance, length(p - a - edge * saturate(dot(p - a, edge) / dot(edge, edge))));
        if (p.y >= a.y && p.y <= b.y) {
            seam_x = mix(a.x, b.x, saturate((p.y - a.y) / edge.y));
        }
    }
    return max(outer, distance * select(side, -side, p.x < seam_x));
}

fn glass_edge_distance(position: vec2f) -> f32 {
    let aspect = canvas_aspect();
    let half_size = vec2f(uniforms.width, uniforms.height) / 2.0 * aspect;
    let corner_radius = uniforms.radius / 2.0 * aspect;
    if (uniforms.geometry.z > 0.0) {
        let p = position + half_size;
        return min(tear_distance(p, half_size, corner_radius, 1.0), tear_distance(p, half_size, corner_radius, -1.0));
    }
    return rounded_box_distance(position, half_size, corner_radius);
}

fn coverage(edge_distance: f32, sharpness: f32) -> f32 {
    return saturate(-edge_distance / uniforms.sharp * sharpness);
}

fn lens_bend(edge_distance: f32) -> f32 {
    const FLAT_TOP_POWER = 0.25;
    const QUARTER_TURN = 1.57;
    let depth = saturate(-edge_distance / uniforms.lens_refraction);
    let height = pow(depth, FLAT_TOP_POWER);
    return height * QUARTER_TURN;
}

fn surface_normal(position: vec2f) -> vec3f {
    const PROBE_X = vec2f(0.001, 0.0);
    const PROBE_Y = vec2f(0.0, 0.001);
    let slope_x = glass_edge_distance(position + PROBE_X)
                - glass_edge_distance(position - PROBE_X);
    let slope_y = glass_edge_distance(position + PROBE_Y)
                - glass_edge_distance(position - PROBE_Y);
    // Preserve the SDF gradient, scaled for a visible but shallow bevel.
    return normalize(vec3f(vec2f(slope_x, slope_y) * 150.0, 1.0));
}

fn schlick_fresnel(facing_viewer: f32) -> f32 {
    const SCHLICK_POWER = 5.0;
    let grazing = 1.0 - facing_viewer;
    let reflectance = uniforms.f0;
    return reflectance + (1.0 - reflectance) * pow(grazing, SCHLICK_POWER);
}

fn colour_spread(facing_viewer: f32) -> f32 {
    return uniforms.dispersion * (1.0 - facing_viewer * FACE_ON_SPREAD_CUT);
}

fn refract_page(position: vec2f, bend: f32, spread: f32) -> vec3f {
    const RED_BEND = 0.98;
    const BLUE_BEND = 1.02;
    let bent_lookup = position * sin(bend);
    let channel_offset = bent_lookup * spread;
    let red_lookup = (position - channel_offset) * sin(bend * RED_BEND);
    let blue_lookup = (position + channel_offset) * sin(bend * BLUE_BEND);

    let strength = uniforms.strength;
    let lookup = mix(position, bent_lookup, strength);
    var color: vec3f;
    if (strength > 0.0) {
        let red = sample_page(mix(position, red_lookup, strength)).r;
        let green = sample_page(lookup).g;
        let blue = sample_page(mix(position, blue_lookup, strength)).b;
        color = vec3f(red, green, blue);
    } else {
        color = sample_page(position).rgb;
    }
    let frost = uniforms.material.y / uniforms.resolution.y;
    if (frost > 0.0) {
        let dx = vec2f(frost, 0.0);
        let dy = vec2f(0.0, frost);
        color = color * 0.4 + 0.15 * (sample_page(lookup + dx).rgb + sample_page(lookup - dx).rgb
            + sample_page(lookup + dy).rgb + sample_page(lookup - dy).rgb);
    }
    return color;
}

fn edge_ring(edge_distance: f32) -> f32 {
    const RING_SHARPNESS = 16.0;
    let one_pixel = 1.0 / uniforms.resolution.y;
    let grown_box = coverage(edge_distance - one_pixel, RING_SHARPNESS);
    let box = coverage(edge_distance, RING_SHARPNESS);
    return grown_box - box;
}

fn specular(normal: vec3f) -> f32 {
    let light_direction = normalize(KEY_LIGHT);
    let halfway = normalize(light_direction + VIEW_DIRECTION);
    return pow(max(dot(normal, halfway), 0.0), uniforms.spec_power);
}

@fragment
fn frag_main(@builtin(position) coord: vec4f) -> @location(0) vec4f {
    let css = coord.xy / uniforms.geometry.xy;
    let clip = uniforms.clip;
    if (any(css < clip.xy) || any(css >= clip.xy + clip.zw)) { discard; }
    if (table_ellipse_radius(css, uniforms.excluded_ellipse) < 1.0) { discard; }
    for (var i = 0u; i < 4u; i++) {
        let bounds = uniforms.rounded_clips[i];
        if (bounds.z > 0.0 && rounded_box_distance(css - bounds.xy - bounds.zw * 0.5, bounds.zw * 0.5, uniforms.clip_radii[i]) > 0.0) {
            discard;
        }
    }
    let position = pixel_to_glass_space(css - uniforms.rect.xy);

    let edge_distance = glass_edge_distance(position);
    let glass_coverage = coverage(edge_distance, MASK_SHARPNESS);
    if (glass_coverage <= 0.0) {
        discard;
    }

    let normal = surface_normal(position);
    let facing_viewer = max(dot(normal, VIEW_DIRECTION), 0.0);
    let fresnel = schlick_fresnel(facing_viewer);

    let bend = lens_bend(edge_distance);
    let refracted = refract_page(position, bend, colour_spread(facing_viewer));

    let ring = edge_ring(edge_distance);
    let edge_light = ring * (1.0 + fresnel * 2.0);
    let shine = specular(normal) * ring * SPECULAR_ON_RING;
    let rim = pow(1.0 - facing_viewer, RIM_POWER) * glass_coverage * uniforms.rim_strength;

    let frosted = mix(refracted, vec3f(0.64, 0.67, 0.64), uniforms.material.z * 0.14);
    let tinted = mix(frosted, uniforms.tint.rgb, uniforms.tint.a);
    let reflected = (edge_light + shine + rim) * vec3f(0.30, 0.27, 0.20);
    let band = 1.0 - smoothstep(0.0, uniforms.lens_refraction, -edge_distance);
    let light_side = max(0.0, dot(normal.xy, normalize(KEY_LIGHT.xy)));
    let caustic = vec3f(0.12, 0.115, 0.10) * light_side * band * uniforms.material.w;
    let glass = tinted * (1.0 + fresnel * uniforms.fresnel * uniforms.edge_highlight)
        + reflected * uniforms.edge_highlight + caustic;

    let glass_opacity = smoothstep(0.0, 1.0, glass_coverage);
    return vec4f(glass, glass_opacity * uniforms.material.x);
}

`;
