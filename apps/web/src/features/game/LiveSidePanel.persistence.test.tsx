import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_GLASS_SETTINGS } from "../theme/glass-settings.js";
import { LiveSidePanel } from "./LiveSidePanel.js";

vi.mock("../theme/GlassSurface.js", () => ({
  GlassSurface: ({
    supportsTrueRefraction,
    children,
    ...props
  }: {
    supportsTrueRefraction: boolean;
    children?: React.ReactNode;
    [key: string]: unknown;
  }) => {
    const Tag = supportsTrueRefraction ? "section" : "div";
    return <Tag {...props}>{children}</Tag>;
  },
}));

describe("LiveSidePanel player lifetime", () => {
  it("does not remount the player when true refraction availability changes", () => {
    const { rerender } = render(
      <LiveSidePanel
        game={null}
        theme="malaga-glass"
        glassSettings={DEFAULT_GLASS_SETTINGS}
        supportsTrueRefraction={false}
      >
        <div data-testid="persistent-player" />
      </LiveSidePanel>,
    );
    const player = screen.getByTestId("persistent-player");

    rerender(
      <LiveSidePanel
        game={null}
        theme="malaga-glass"
        glassSettings={DEFAULT_GLASS_SETTINGS}
        supportsTrueRefraction
      >
        <div data-testid="persistent-player" />
      </LiveSidePanel>,
    );

    expect(screen.getByTestId("persistent-player")).toBe(player);
  });
});
