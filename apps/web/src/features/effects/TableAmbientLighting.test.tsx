import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  LightingRendererContext,
  type LightingRendererContextValue,
} from "./LightingRendererContext.js";
import { TableAmbientLighting } from "./TableAmbientLighting.js";

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

describe("TableAmbientLighting", () => {
  it("renders an inert SVG lighting field for the SVG renderer", () => {
    render(<TableAmbientLighting />);

    const lighting = screen.getByTestId("table-ambient-lighting");
    expect(lighting).toHaveAttribute("aria-hidden", "true");
    expect(lighting).toHaveAttribute("focusable", "false");
    expect(lighting.querySelectorAll(".table-lighting-radiance")).toHaveLength(3);
    expect(lighting.querySelectorAll(".table-lighting-halo")).toHaveLength(3);
    expect(lighting.querySelectorAll("circle")).toHaveLength(16);
  });

  it("keeps table lighting when player lighting is disabled", () => {
    render(
      <LightingRendererContext.Provider value={context({ playerLightingEnabled: false })}>
        <TableAmbientLighting />
      </LightingRendererContext.Provider>,
    );

    expect(screen.getByTestId("table-ambient-lighting")).toBeInTheDocument();
  });

  it("does not render over the legacy renderer", () => {
    const { container } = render(
      <LightingRendererContext.Provider value={context({ effectiveRenderer: "legacy" })}>
        <TableAmbientLighting />
      </LightingRendererContext.Provider>,
    );

    expect(container.querySelector(".table-ambient-lighting")).toBeNull();
  });
});
