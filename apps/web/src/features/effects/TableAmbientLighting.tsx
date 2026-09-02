import type { CSSProperties } from "react";
import { useLightingRenderer } from "./LightingRendererContext.js";

const chaseDots = Array.from({ length: 16 }, (_, index) => {
  const angle = (index / 16) * Math.PI * 2;
  return {
    x: 50 + Math.cos(angle) * 45,
    y: 50 + Math.sin(angle) * 45,
  };
});

export const TableAmbientLighting = () => {
  const { effectiveRenderer, requestedRenderer } = useLightingRenderer();
  if (effectiveRenderer !== "svg" && requestedRenderer !== "vgpu") return null;

  return (
    <svg
      className="table-ambient-lighting"
      data-testid="table-ambient-lighting"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <ellipse className="table-lighting-radiance is-outer" cx="50" cy="50" rx="47" ry="43" />
      <ellipse className="table-lighting-radiance is-middle" cx="50" cy="50" rx="43" ry="39" />
      <ellipse className="table-lighting-radiance is-inner" cx="50" cy="50" rx="39" ry="35" />
      <ellipse className="table-lighting-halo is-outer" cx="50" cy="50" rx="47" ry="47" />
      <ellipse className="table-lighting-halo is-middle" cx="50" cy="50" rx="40" ry="40" />
      <ellipse className="table-lighting-halo is-inner" cx="50" cy="50" rx="31" ry="31" />
      <g className="table-lighting-chase">
        {chaseDots.map(({ x, y }, index) => (
          <circle
            key={index}
            className={`table-lighting-dot is-color-${index % 3}`}
            cx={x}
            cy={y}
            r="1.25"
            style={{ "--table-led-index": index } as CSSProperties}
          />
        ))}
      </g>
    </svg>
  );
};
