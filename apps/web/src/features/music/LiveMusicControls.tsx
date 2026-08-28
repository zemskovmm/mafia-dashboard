import { useMessages } from "../../i18n/I18nProvider.js";
import { playersMusicMessages } from "../../i18n/messages/players-music.js";

interface LiveMusicControlsProps {
  readonly isPlaying: boolean;
  readonly canFadeIn: boolean;
  readonly onFadeIn: () => void;
  readonly onQuickFadeOut: () => void;
  readonly onSlowFadeOut: () => void;
}

export const LiveMusicControls = ({
  isPlaying,
  canFadeIn,
  onFadeIn,
  onQuickFadeOut,
  onSlowFadeOut,
}: LiveMusicControlsProps) => {
  const { t } = useMessages(playersMusicMessages);
  return (
    <section className="live-music-controls" aria-label={t("Live music controls")}>
      <div>
        <button
          type="button"
          aria-label={t("Music fade in")}
          disabled={!canFadeIn}
          onClick={onFadeIn}
        >
          {t("Fade in")}
        </button>
        <button
          type="button"
          aria-label={t("Quick music fade out")}
          disabled={!isPlaying}
          onClick={onQuickFadeOut}
        >
          {t("Quick fade")}
        </button>
        <button
          type="button"
          aria-label={t("Slow music fade out")}
          disabled={!isPlaying}
          onClick={onSlowFadeOut}
        >
          {t("Slow fade")}
        </button>
      </div>
    </section>
  );
};
