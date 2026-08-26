import type { HTMLAttributes } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { DEFAULT_GLASS_SETTINGS } from "./glass-settings.js";
import { GlassSurface } from "./GlassSurface.js";

const refractiveRender = vi.hoisted(() => vi.fn());

vi.mock("@hashintel/refractive", async () => {
  const { createElement } = await import("react");
  const makeRefractive = (tag: string) =>
    function MockRefractive(props: Record<string, unknown>) {
      const { refraction, ...domProps } = props;
      refractiveRender({ tag, refraction });
      return createElement(tag, {
        ...(domProps as HTMLAttributes<HTMLElement>),
        "data-refractive": "true",
      });
    };

  return {
    refractive: {
      article: makeRefractive("article"),
      aside: makeRefractive("aside"),
      div: makeRefractive("div"),
      header: makeRefractive("header"),
      main: makeRefractive("main"),
      nav: makeRefractive("nav"),
      section: makeRefractive("section"),
    },
  };
});

describe("GlassSurface", () => {
  beforeEach(() => {
    refractiveRender.mockClear();
  });

  it.each(["midnight", "malaga"] as const)(
    "renders the %s theme as a plain semantic wrapper",
    (theme) => {
      render(
        <GlassSurface
          as="aside"
          theme={theme}
          supportsTrueRefraction={true}
          settings={DEFAULT_GLASS_SETTINGS}
          radius={24}
          role="complementary"
          aria-label="Live controls"
          className="live-panel"
        >
          Controls
        </GlassSurface>,
      );

      const surface = screen.getByRole("complementary", { name: "Live controls" });
      expect(surface.tagName).toBe("ASIDE");
      expect(surface).toHaveClass("glass-surface", "is-glass-plain", "live-panel");
      expect(surface).not.toHaveAttribute("data-refractive");
      expect(surface).toHaveTextContent("Controls");
      expect(refractiveRender).not.toHaveBeenCalled();
    },
  );

  it("passes only documented bounded settings to a supported Málaga Glass surface", () => {
    render(
      <GlassSurface
        as="aside"
        theme="malaga-glass"
        supportsTrueRefraction={true}
        settings={DEFAULT_GLASS_SETTINGS}
        radius={8}
        role="complementary"
        aria-label="Refractive controls"
      >
        Controls
      </GlassSurface>,
    );

    const surface = screen.getByRole("complementary", { name: "Refractive controls" });
    expect(surface.tagName).toBe("ASIDE");
    expect(surface).toHaveClass("glass-surface", "is-glass-refractive");
    expect(surface).toHaveAttribute("data-refractive", "true");
    expect(surface).toHaveStyle({ borderRadius: "8px" });
    expect(refractiveRender).toHaveBeenCalledOnce();
    expect(refractiveRender).toHaveBeenCalledWith({
      tag: "aside",
      refraction: {
        radius: 8,
        blur: 4,
        glassThickness: 70,
        bezelWidth: 7,
        refractiveIndex: 1.5,
        specularOpacity: 0.28,
        specularAngle: 45,
      },
    });
  });

  it("uses the intentional Málaga fallback when true refraction is unsupported", () => {
    render(
      <GlassSurface
        as="main"
        theme="malaga-glass"
        supportsTrueRefraction={false}
        settings={{ ...DEFAULT_GLASS_SETTINGS, fallbackOpacity: 0.73 }}
        radius={20}
        aria-label="Fallback content"
      >
        Content
      </GlassSurface>,
    );

    const surface = screen.getByRole("main", { name: "Fallback content" });
    expect(surface).toHaveClass("glass-surface", "is-glass-fallback");
    expect(surface).not.toHaveClass("is-glass-plain", "is-glass-refractive");
    expect(surface).not.toHaveAttribute("data-refractive");
    expect(surface).toHaveStyle({ borderRadius: "20px" });
    expect(surface.style.getPropertyValue("--glass-fallback-opacity")).toBe("0.73");
    expect(surface.style.getPropertyValue("--glass-fallback-blur")).toBe("4px");
    expect(refractiveRender).not.toHaveBeenCalled();
  });

  it("uses an opaque blur-free fallback when the effect is disabled", () => {
    render(
      <GlassSurface
        theme="malaga-glass"
        supportsTrueRefraction={true}
        settings={{ ...DEFAULT_GLASS_SETTINGS, enabled: false, fallbackOpacity: 0.2 }}
        radius={16}
        role="region"
        aria-label="Disabled glass"
      />,
    );

    const surface = screen.getByRole("region", { name: "Disabled glass" });
    expect(surface).toHaveClass("is-glass-fallback", "is-glass-disabled");
    expect(surface.style.getPropertyValue("--glass-fallback-opacity")).toBe("1");
    expect(surface.style.getPropertyValue("--glass-fallback-blur")).toBe("0px");
    expect(refractiveRender).not.toHaveBeenCalled();
  });

  it.each([
    { label: "non-finite", radius: Number.NaN, expectedRadius: 1, expectedBezel: 0 },
    { label: "oversized", radius: 10_000, expectedRadius: 256, expectedBezel: 10 },
  ])(
    "bounds a $label radius before invoking the beta package",
    ({ radius, expectedRadius, expectedBezel }) => {
      render(
        <GlassSurface
          theme="malaga-glass"
          supportsTrueRefraction={true}
          settings={DEFAULT_GLASS_SETTINGS}
          radius={radius}
          role="region"
          aria-label="Bounded radius"
        />,
      );

      expect(refractiveRender).toHaveBeenCalledWith({
        tag: "div",
        refraction: expect.objectContaining({
          radius: expectedRadius,
          bezelWidth: expectedBezel,
        }),
      });
    },
  );

  it("owns radius in plain mode so every mode keeps identical geometry", () => {
    render(
      <GlassSurface
        as="section"
        theme="midnight"
        supportsTrueRefraction={false}
        settings={DEFAULT_GLASS_SETTINGS}
        radius={22}
        style={{ borderRadius: "99px", color: "red" }}
        role="region"
        aria-label="Plain geometry"
      />,
    );

    const surface = screen.getByRole("region", { name: "Plain geometry" });
    expect(surface).toHaveStyle({ borderRadius: "22px" });
    expect(surface.style.color).toBe("red");
  });

  it("does not pass a competing backdrop filter to the refractive component", () => {
    render(
      <GlassSurface
        theme="malaga-glass"
        supportsTrueRefraction={true}
        settings={DEFAULT_GLASS_SETTINGS}
        radius={18}
        style={{ backdropFilter: "blur(99px)", color: "red" }}
        role="region"
        aria-label="Owned filter"
      />,
    );

    const surface = screen.getByRole("region", { name: "Owned filter" });
    expect(surface.style.backdropFilter).toBe("");
    expect(surface).toHaveStyle({ borderRadius: "18px" });
    expect(surface.style.color).toBe("red");
  });
});
