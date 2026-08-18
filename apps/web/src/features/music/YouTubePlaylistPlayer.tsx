import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { MusicController } from "./music-controller.js";
import type { MusicPlayerAdapter } from "./music-controller.js";

export type YouTubePlaybackState = "idle" | "loading" | "playing" | "paused" | "error";

export interface YouTubePlayerHandle {
  fadeIn(): Promise<boolean>;
  quickFadeOut(): Promise<void>;
  slowFadeOut(): Promise<void>;
}

interface YouTubePlaylistPlayerProps {
  readonly playlistId: string;
  readonly onStateChange: (state: YouTubePlaybackState) => void;
}

let apiPromise: Promise<void> | null = null;
const loadApi = (): Promise<void> => {
  if (window.YT?.Player !== undefined) return Promise.resolve();
  if (apiPromise !== null) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.onerror = () => reject(new Error("Unable to load the YouTube IFrame API"));
    document.head.append(script);
  });
  return apiPromise;
};

class YouTubeAdapter implements MusicPlayerAdapter {
  public constructor(private readonly player: YT.Player) {}
  public play(): void {
    this.player.playVideo();
  }
  public pause(): void {
    this.player.pauseVideo();
  }
  public setVolume(volume: number): void {
    this.player.setVolume(volume);
  }
  public getVolume(): number {
    return this.player.getVolume();
  }
}

export const YouTubePlaylistPlayer = forwardRef<YouTubePlayerHandle, YouTubePlaylistPlayerProps>(
  ({ playlistId, onStateChange }, ref) => {
    const [instanceKey, setInstanceKey] = useState(0);
    const playerRef = useRef<YT.Player | null>(null);
    const controllerRef = useRef<MusicController | null>(null);
    const readyRef = useRef(false);
    const elementId = `youtube-mafia-player-${instanceKey}`;

    useEffect(() => {
      if (playlistId.trim().length === 0) {
        onStateChange("idle");
        return undefined;
      }

      let cancelled = false;
      onStateChange("loading");
      void loadApi()
        .then(() => {
          if (cancelled || window.YT === undefined) return;
          playerRef.current?.destroy();
          readyRef.current = false;
          const playerVars: Record<string, string | number> = {
            playsinline: 1,
            controls: 1,
            rel: 0,
            listType: "playlist",
            list: playlistId.trim(),
          };
          playerRef.current = new window.YT.Player(elementId, {
            width: "100%",
            height: "100%",
            playerVars,
            events: {
              onReady: ({ target }) => {
                readyRef.current = true;
                controllerRef.current = new MusicController(new YouTubeAdapter(target));
                onStateChange("paused");
              },
              onStateChange: ({ data }) => {
                if (data === window.YT?.PlayerState.PLAYING) onStateChange("playing");
                else if (data === window.YT?.PlayerState.ENDED) onStateChange("paused");
                else if (data === window.YT?.PlayerState.PAUSED) onStateChange("paused");
              },
              onError: () => onStateChange("error"),
            },
          });
        })
        .catch(() => onStateChange("error"));

      return () => {
        cancelled = true;
      };
    }, [elementId, onStateChange, playlistId]);

    useImperativeHandle(ref, () => ({
      async fadeIn() {
        if (!readyRef.current || controllerRef.current === null) {
          onStateChange(playlistId.trim().length === 0 ? "error" : "loading");
          return false;
        }
        await controllerRef.current.fadeIn({ durationMs: 2_000, targetVolume: 65 });
        return true;
      },
      async quickFadeOut() {
        await controllerRef.current?.fadeOut({ durationMs: 500 });
      },
      async slowFadeOut() {
        await controllerRef.current?.fadeOut({ durationMs: 3_000 });
      },
    }));

    return (
      <div className="youtube-player-frame" aria-label="YouTube playlist player">
        <div id={elementId} />
        <button
          type="button"
          className="reload-player"
          onClick={() => setInstanceKey((key) => key + 1)}
        >
          Reload player
        </button>
      </div>
    );
  },
);

YouTubePlaylistPlayer.displayName = "YouTubePlaylistPlayer";
