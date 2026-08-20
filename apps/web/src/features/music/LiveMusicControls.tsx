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
}: LiveMusicControlsProps) => (
  <section className="live-music-controls" aria-label="Live music controls">
    <strong>Table music</strong>
    <div>
      <button type="button" aria-label="Music fade in" disabled={!canFadeIn} onClick={onFadeIn}>
        Fade in
      </button>
      <button
        type="button"
        aria-label="Quick music fade out"
        disabled={!isPlaying}
        onClick={onQuickFadeOut}
      >
        Quick fade
      </button>
      <button
        type="button"
        aria-label="Slow music fade out"
        disabled={!isPlaying}
        onClick={onSlowFadeOut}
      >
        Slow fade
      </button>
    </div>
  </section>
);
