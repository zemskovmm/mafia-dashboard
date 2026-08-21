import type { ReactNode } from "react";
import { LiveMusicControls } from "./LiveMusicControls.js";

interface MusicDockProps {
  readonly expanded?: boolean;
  readonly hidden?: boolean;
  readonly children: ReactNode;
  readonly isPlaying: boolean;
  readonly canFadeIn: boolean;
  readonly onFadeIn: () => void;
  readonly onQuickFadeOut: () => void;
  readonly onSlowFadeOut: () => void;
}

export const MusicDock = ({
  expanded = false,
  hidden = false,
  children,
  isPlaying,
  canFadeIn,
  onFadeIn,
  onQuickFadeOut,
  onSlowFadeOut,
}: MusicDockProps) => (
  <section
    className={`music-dock youtube-dock is-compact${expanded ? " is-expanded" : ""}`}
    aria-label="Table music dock"
    hidden={hidden}
  >
    {children}
    <LiveMusicControls
      isPlaying={isPlaying}
      canFadeIn={canFadeIn}
      onFadeIn={onFadeIn}
      onQuickFadeOut={onQuickFadeOut}
      onSlowFadeOut={onSlowFadeOut}
    />
  </section>
);
