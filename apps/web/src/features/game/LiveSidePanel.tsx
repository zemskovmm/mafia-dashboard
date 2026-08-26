import { useState, type ReactNode } from "react";
import type { GameState } from "@mafia/game-domain";
import { GlassSurface, type GlassTheme } from "../theme/GlassSurface.js";
import { DEFAULT_GLASS_SETTINGS, type GlassSettings } from "../theme/glass-settings.js";
import { GameUtilityPanels } from "./GameUtilityPanels.js";

interface LiveSidePanelProps {
  readonly game: GameState | null;
  readonly hidden?: boolean;
  readonly children: ReactNode;
  readonly theme?: GlassTheme;
  readonly glassSettings?: Readonly<GlassSettings>;
  readonly supportsTrueRefraction?: boolean;
}

export const LiveSidePanel = ({
  game,
  hidden = false,
  children,
  theme = "midnight",
  glassSettings = DEFAULT_GLASS_SETTINGS,
  supportsTrueRefraction = false,
}: LiveSidePanelProps) => {
  const [timerHidden, setTimerHidden] = useState(false);
  const [votingHidden, setVotingHidden] = useState(false);

  return (
    <aside
      className={`live-side-panel ${game ? "has-live-utilities" : "is-player-only"}`}
      aria-label="Live game controls"
      hidden={hidden}
    >
      <GlassSurface
        aria-hidden="true"
        className="live-side-panel-glass"
        theme={theme}
        settings={glassSettings}
        supportsTrueRefraction={supportsTrueRefraction}
        radius={20}
      />
      {game ? (
        <GameUtilityPanels
          game={game}
          timerHidden={timerHidden}
          votingHidden={votingHidden}
          onTimerHiddenChange={setTimerHidden}
          onVotingHiddenChange={setVotingHidden}
        />
      ) : null}
      {children}
    </aside>
  );
};
