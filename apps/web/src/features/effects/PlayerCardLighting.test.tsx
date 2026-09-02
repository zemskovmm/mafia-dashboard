import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  LightingRendererContext,
  type LightingRendererContextValue,
} from "./LightingRendererContext.js";
import { PlayerCardLighting, resolvePlayerLightingKind } from "./PlayerCardLighting.js";

const context = (
  overrides: Partial<LightingRendererContextValue> = {},
): LightingRendererContextValue => ({
  requestedRenderer: "svg",
  effectiveRenderer: "svg",
  playerLightingEnabled: true,
  vgpuGeneration: 0,
  vgpuStatus: "idle",
  ...overrides,
});

describe("PlayerCardLighting", () => {
  it.each([
    [{ current: true }, "speaker"],
    [{ mafiaShooter: true }, "mafia"],
    [{ sheriffHighlight: true }, "sheriff"],
    [{ goodbyeHighlight: true }, "attention"],
    [{ votingHighlight: true }, "attention"],
    [{}, null],
  ] as const)("maps %j to %s", (seat, expected) => {
    expect(resolvePlayerLightingKind(seat)).toBe(expected);
  });

  it("renders distinct perimeter LEDs as one decorative SVG", () => {
    const { container } = render(<PlayerCardLighting kind="speaker" />);

    const lighting = container.querySelector(".player-card-lighting");
    expect(lighting).toHaveAttribute("aria-hidden", "true");
    expect(lighting).toHaveAttribute("data-player-lighting-kind", "speaker");
    expect(lighting).toHaveAttribute("data-player-lighting-palette", "yellow-blue");
    expect(lighting?.querySelectorAll("circle")).toHaveLength(28);
  });

  it.each<readonly [Partial<LightingRendererContextValue>, string]>([
    [{ effectiveRenderer: "legacy" as const }, "legacy renderer"],
    [{ playerLightingEnabled: false }, "disabled player lighting"],
  ])("renders no SVG for %s", (overrides) => {
    const { container } = render(
      <LightingRendererContext.Provider value={context(overrides)}>
        <PlayerCardLighting kind="mafia" />
      </LightingRendererContext.Provider>,
    );
    expect(container.querySelector(".player-card-lighting")).toBeNull();
  });

  it("keeps SVG visible while a requested V-GPU renderer is falling back", () => {
    render(
      <LightingRendererContext.Provider
        value={context({
          requestedRenderer: "vgpu",
          effectiveRenderer: "svg",
          vgpuStatus: "fallback",
        })}
      >
        <PlayerCardLighting kind="sheriff" />
      </LightingRendererContext.Provider>,
    );
    expect(screen.getByTestId("player-card-lighting")).toHaveAttribute(
      "data-player-lighting-kind",
      "sheriff",
    );
  });
});
