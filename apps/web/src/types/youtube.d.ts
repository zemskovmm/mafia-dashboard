export {};

declare global {
  namespace YT {
    interface PlayerEvent {
      target: Player;
    }

    interface OnStateChangeEvent extends PlayerEvent {
      data: number;
    }

    interface PlayerOptions {
      width?: number | string;
      height?: number | string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (event: PlayerEvent) => void;
        onStateChange?: (event: OnStateChangeEvent) => void;
        onError?: () => void;
      };
    }

    class Player {
      constructor(elementId: string, options: PlayerOptions);
      playVideo(): void;
      pauseVideo(): void;
      setVolume(volume: number): void;
      getVolume(): number;
      getIframe(): HTMLIFrameElement;
      cuePlaylist(
        playlist: string | readonly string[],
        index?: number,
        startSeconds?: number,
      ): void;
      loadPlaylist(
        playlist: string | readonly string[],
        index?: number,
        startSeconds?: number,
      ): void;
      getPlaylistIndex(): number;
      getCurrentTime(): number;
      getPlayerState(): number;
      playVideoAt(index: number): void;
      destroy(): void;
    }
  }

  interface Window {
    YT?: {
      Player: typeof YT.Player;
      PlayerState: {
        PLAYING: number;
        PAUSED: number;
        ENDED: number;
        BUFFERING: number;
        CUED: number;
      };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}
