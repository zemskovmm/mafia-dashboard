import { useRef, type ReactNode } from "react";
import { classifyPanelSwipe } from "../game/panel-swipe.js";
import { useMessages } from "../../i18n/I18nProvider.js";
import { playersMusicMessages } from "../../i18n/messages/players-music.js";
import { LiveMusicControls } from "./LiveMusicControls.js";

const PANEL_SWIPE_THRESHOLD = 44;

interface MusicDockProps {
  readonly expanded?: boolean;
  readonly onExpandedChange?: (expanded: boolean) => void;
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
  onExpandedChange = () => undefined,
  hidden = false,
  children,
  isPlaying,
  canFadeIn,
  onFadeIn,
  onQuickFadeOut,
  onSlowFadeOut,
}: MusicDockProps) => {
  const { t } = useMessages(playersMusicMessages);
  const touchStartRef = useRef<{ readonly x: number; readonly y: number } | null>(null);
  const suppressNextClickRef = useRef(false);

  return (
    <section
      className={`music-dock youtube-dock is-compact${expanded ? " is-expanded" : ""}`}
      aria-label={t("Table music dock")}
      hidden={hidden}
    >
      <button
        type="button"
        className="panel-swipe-handle music-panel-handle"
        aria-label={t("Music player panel handle")}
        aria-expanded={expanded}
        onTouchStart={(event) => {
          const touch = event.touches[0];
          touchStartRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
          suppressNextClickRef.current = false;
        }}
        onTouchEnd={(event) => {
          const touch = event.changedTouches[0];
          if (!touch || !touchStartRef.current) return;
          const start = touchStartRef.current;
          const end = {
            x: touch.clientX,
            y: touch.clientY,
          };
          suppressNextClickRef.current =
            Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y)) >= PANEL_SWIPE_THRESHOLD;
          const swipe = classifyPanelSwipe(start, end, PANEL_SWIPE_THRESHOLD);
          touchStartRef.current = null;
          if (swipe !== "up" && swipe !== "down") return;
          onExpandedChange(swipe === "up");
        }}
        onClick={() => {
          if (suppressNextClickRef.current) {
            suppressNextClickRef.current = false;
            return;
          }
          onExpandedChange(!expanded);
        }}
      >
        <span aria-hidden="true" />
      </button>
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
};
