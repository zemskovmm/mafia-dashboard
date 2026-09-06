import { describe, expect, it } from "vitest";
import { effect, frame, init, target } from "vgpu/mock";
import { vgpuLightingShader } from "./lighting-shader.js";

const config = {
  resolution: [64, 64],
  time: 0,
  variant: 0,
  primary: [1, 0, 0, 1],
  secondary: [1, 1, 0, 1],
  geometry: [12, 8, 1, 0],
  pulse: [1, 0.05, 0, 0],
};

describe("V-GPU lighting shader", () => {
  it("selects the approved turbulent sheets as fourteen-slice semantic interior fire", () => {
    expect(vgpuLightingShader).toContain("if (distance >= 0.0)");
    expect(vgpuLightingShader).toContain("cfg.pulse.z > 0.5");
    expect(vgpuLightingShader).toContain("fn fire_hash(p: vec3f)");
    expect(vgpuLightingShader).toContain("for (var i = 0; i < 14; i++)");
    expect(vgpuLightingShader).toContain("let t = cfg.time * 1.6 * 0.65;");
    expect(vgpuLightingShader).toContain("fn screen_to_straight_alpha");
    expect(vgpuLightingShader).not.toContain("fn flame_domain");
  });

  it("compiles and submits both player and table variants with the mock adapter", async () => {
    const gpu = await init();
    const output = target(gpu, {
      size: [64, 64],
      format: "rgba8unorm",
      clearColor: [0, 0, 0, 0],
    });
    const lighting = effect(gpu, vgpuLightingShader, {
      blend: "alpha",
      set: { cfg: config },
    });

    await lighting.compile(output);
    for (const variant of [0, 1, 2]) {
      lighting.set({ cfg: { ...config, variant } });
      frame(gpu, (current) => current.pass({ target: output, clear: [0, 0, 0, 0] }, lighting));
    }
    await gpu.settled();

    expect(lighting.gpu).toBeDefined();
    gpu.dispose();
  });
});
