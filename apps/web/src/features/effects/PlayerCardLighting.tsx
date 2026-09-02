import type { CSSProperties } from "react";
import { useLightingRenderer } from "./LightingRendererContext.js";

export type PlayerLightingKind = "speaker" | "mafia" | "sheriff" | "attention";

interface PlayerLightingSignals {
  readonly current?: boolean;
  readonly mafiaShooter?: boolean;
  readonly sheriffHighlight?: boolean;
  readonly goodbyeHighlight?: boolean;
  readonly votingHighlight?: boolean;
}

export const resolvePlayerLightingKind = ({
  current,
  mafiaShooter,
  sheriffHighlight,
  goodbyeHighlight,
  votingHighlight,
}: PlayerLightingSignals): PlayerLightingKind | null => {
  if (current) return "speaker";
  if (mafiaShooter) return "mafia";
  if (sheriffHighlight) return "sheriff";
  if (goodbyeHighlight || votingHighlight) return "attention";
  return null;
};

const ledPoints = [
  ...Array.from({ length: 8 }, (_, index) => ({ x: 9 + index * 11.7, y: 6 })),
  ...Array.from({ length: 6 }, (_, index) => ({ x: 94, y: 17 + index * 13.2 })),
  ...Array.from({ length: 8 }, (_, index) => ({ x: 91 - index * 11.7, y: 94 })),
  ...Array.from({ length: 6 }, (_, index) => ({ x: 6, y: 83 - index * 13.2 })),
] as const;

const palette: Record<PlayerLightingKind, string> = {
  speaker: "yellow-blue",
  mafia: "red",
  sheriff: "blue",
  attention: "yellow",
};

export const PlayerCardLighting = ({ kind }: Readonly<{ kind: PlayerLightingKind | null }>) => {
  const { effectiveRenderer, requestedRenderer, playerLightingEnabled } = useLightingRenderer();
  if (
    (effectiveRenderer !== "svg" && requestedRenderer !== "vgpu") ||
    !playerLightingEnabled ||
    kind === null
  )
    return null;

  return (
    <svg
      className={`player-card-lighting is-${kind}`}
      data-testid="player-card-lighting"
      data-player-lighting-kind={kind}
      data-player-lighting-palette={palette[kind]}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect className="player-card-lighting-track" x="5" y="5" width="90" height="90" rx="8" />
      {ledPoints.map(({ x, y }, index) => (
        <circle
          key={`${x}-${y}`}
          className={kind === "speaker" && index % 2 === 1 ? "is-secondary" : undefined}
          cx={x}
          cy={y}
          r="2.15"
          style={{ "--led-index": index } as CSSProperties}
        />
      ))}
    </svg>
  );
};
