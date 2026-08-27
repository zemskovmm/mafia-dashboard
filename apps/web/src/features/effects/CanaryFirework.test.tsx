import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CanaryFirework } from "./CanaryFirework.js";

describe("CanaryFirework", () => {
  it("renders a deterministic dense burst of decorative canaries", () => {
    const { container } = render(<CanaryFirework burstKey={1} />);
    const burst = container.querySelector(".canary-firework");
    const particles = container.querySelectorAll<HTMLElement>("[data-canary-particle]");

    expect(burst).toHaveAttribute("aria-hidden", "true");
    expect(burst).toHaveAttribute("data-burst-key", "1");
    expect(particles).toHaveLength(32);
    for (const particle of particles) {
      expect(particle.style.getPropertyValue("--canary-x")).toMatch(/px$/);
      expect(particle.style.getPropertyValue("--canary-y")).toMatch(/px$/);
      expect(particle.style.getPropertyValue("--canary-delay")).toMatch(/ms$/);
      expect(particle.querySelector(".lucide-bird")).toBeInTheDocument();
    }
  });

  it("changes the burst identity without scheduling particle timers", () => {
    const { container, rerender } = render(<CanaryFirework burstKey={1} />);
    rerender(<CanaryFirework burstKey={2} />);

    expect(container.querySelector(".canary-firework")).toHaveAttribute("data-burst-key", "2");
    expect(container.querySelectorAll("[data-canary-particle]")).toHaveLength(32);
  });

  it("keeps the toolbar burst inside the top viewport edge", () => {
    const { container } = render(<CanaryFirework burstKey={1} />);
    const verticalOffsets = [
      ...container.querySelectorAll<HTMLElement>("[data-canary-particle]"),
    ].map((particle) => Number.parseFloat(particle.style.getPropertyValue("--canary-y")));

    expect(Math.min(...verticalOffsets)).toBeGreaterThanOrEqual(-18);
    expect(Math.max(...verticalOffsets)).toBeLessThanOrEqual(74);
  });
});
