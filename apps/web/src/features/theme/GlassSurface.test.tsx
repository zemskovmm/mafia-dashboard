import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GlassSurface } from "./GlassSurface.js";

describe("GlassSurface", () => {
  it("renders one semantic native glass element with caller attributes", () => {
    render(
      <GlassSurface
        as="aside"
        radius={24}
        role="complementary"
        aria-label="Live controls"
        className="live-panel"
        style={{ color: "red" }}
      >
        Controls
      </GlassSurface>,
    );

    const surface = screen.getByRole("complementary", { name: "Live controls" });
    expect(surface.tagName).toBe("ASIDE");
    expect(surface).toHaveClass("glass-surface", "live-panel");
    expect(surface).not.toHaveClass("is-glass-plain", "is-glass-fallback", "is-glass-refractive");
    expect(surface.style.getPropertyValue("--glass-radius")).toBe("24px");
    expect(surface.style.color).toBe("red");
    expect(surface).toHaveTextContent("Controls");
  });

  it("marks only opted-in surfaces as specular", () => {
    render(<GlassSurface radius={16} specular role="region" aria-label="Specular glass" />);

    expect(screen.getByRole("region", { name: "Specular glass" })).toHaveClass("is-specular");
  });

  it.each([
    { radius: Number.NaN, expected: "1px" },
    { radius: 10_000, expected: "256px" },
  ])("bounds the local radius to safe geometry", ({ radius, expected }) => {
    render(<GlassSurface radius={radius} role="region" aria-label="Bounded glass" />);

    expect(
      screen
        .getByRole("region", { name: "Bounded glass" })
        .style.getPropertyValue("--glass-radius"),
    ).toBe(expected);
  });
});
