import { useRef, useState, type ReactNode } from "react";
import type { GameState } from "@mafia/game-domain";
import { GlassSurface } from "../theme/GlassSurface.js";
import { GameUtilityPanels } from "./GameUtilityPanels.js";

interface LiveSidePanelProps {
  readonly game: GameState | null;
  readonly hidden?: boolean;
  readonly children: ReactNode;
}

export const LiveSidePanel = ({ game, hidden = false, children }: LiveSidePanelProps) => {
  const [utilitiesHidden, setUtilitiesHidden] = useState(false);
  const touchStartRef = useRef<{ readonly x: number; readonly y: number } | null>(null);
  const suppressNextClickRef = useRef(false);

  return (
    <aside
      className="live-side-panel has-live-utilities"
      aria-label="Live game controls"
      hidden={hidden}
    >
      <GlassSurface aria-hidden="true" className="live-side-panel-glass" radius={20} />
      <button
        type="button"
        className="panel-swipe-handle utility-panels-toggle"
        aria-label={utilitiesHidden ? "Show timer and voting" : "Hide timer and voting"}
        aria-controls="game-utility-panels"
        aria-expanded={!utilitiesHidden}
        onClick={() => {
          if (suppressNextClickRef.current) {
            suppressNextClickRef.current = false;
            return;
          }
          setUtilitiesHidden((current) => !current);
        }}
        onTouchStart={(event) => {
          const touch = event.touches[0];
          touchStartRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
          suppressNextClickRef.current = false;
        }}
        onTouchEnd={(event) => {
          const start = touchStartRef.current;
          const touch = event.changedTouches[0];
          touchStartRef.current = null;
          if (!start || !touch) return;
          suppressNextClickRef.current =
            Math.max(Math.abs(touch.clientX - start.x), Math.abs(touch.clientY - start.y)) >= 44;
        }}
      >
        <span aria-hidden="true" />
      </button>
      <div id="game-utility-panels" hidden={utilitiesHidden}>
        <GameUtilityPanels game={game} />
      </div>
      {children}
    </aside>
  );
};
