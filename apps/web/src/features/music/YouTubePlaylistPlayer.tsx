import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { listMusicPlaylistItems } from "../../api/client.js";
import type { MusicPlaylistItem } from "../../api/client.js";
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
  readonly expanded?: boolean;
  readonly onExpandedChange?: (expanded: boolean) => void;
  readonly volumePresets?: readonly [number, number];
  readonly activeVolume?: number;
  readonly onVolumeChange?: (volume: number) => void;
  readonly reloadRequest?: number;
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

const disablePictureInPicture = (player: YT.Player) => {
  const iframe = (
    player as YT.Player & { readonly getIframe: () => HTMLIFrameElement }
  ).getIframe();
  const permissions = (iframe.getAttribute("allow") ?? "")
    .split(";")
    .map((permission) => permission.trim())
    .filter((permission) => permission.length > 0 && !permission.startsWith("picture-in-picture"));
  iframe.setAttribute("allow", permissions.join("; "));
};

export const YouTubePlaylistPlayer = forwardRef<YouTubePlayerHandle, YouTubePlaylistPlayerProps>(
  (
    {
      playlistId,
      onStateChange,
      expanded = false,
      onExpandedChange = () => undefined,
      volumePresets = [50, 80],
      activeVolume = 80,
      onVolumeChange = () => undefined,
      reloadRequest = 0,
    },
    ref,
  ) => {
    const [instanceKey, setInstanceKey] = useState(0);
    const [queueState, setQueueState] = useState<{
      readonly playlistId: string;
      readonly items: readonly MusicPlaylistItem[];
      readonly unavailable: boolean;
    } | null>(null);
    const playerRef = useRef<YT.Player | null>(null);
    const controllerRef = useRef<MusicController | null>(null);
    const readyRef = useRef(false);
    const queueRef = useRef<readonly MusicPlaylistItem[]>([]);
    const activeVolumeRef = useRef(activeVolume);
    activeVolumeRef.current = activeVolume;
    const handledReloadRequest = useRef(reloadRequest);
    const elementId = `youtube-mafia-player-${instanceKey}`;
    const normalizedPlaylistId = playlistId.trim();
    const queue = queueState?.playlistId === normalizedPlaylistId ? queueState.items : null;
    const queueUnavailable =
      queueState?.playlistId === normalizedPlaylistId && queueState.unavailable;
    const queueLoaded = queue !== null;

    useEffect(() => {
      if (handledReloadRequest.current === reloadRequest) return;
      handledReloadRequest.current = reloadRequest;
      setInstanceKey((key) => key + 1);
    }, [reloadRequest]);

    useEffect(() => {
      queueRef.current = [];
      readyRef.current = false;
      controllerRef.current?.cancelActiveFade();
      setQueueState(null);
      if (normalizedPlaylistId.length === 0) {
        onStateChange("idle");
        return undefined;
      }
      let cancelled = false;
      onStateChange("loading");
      void listMusicPlaylistItems(normalizedPlaylistId).then(
        (items) => {
          if (cancelled) return;
          queueRef.current = items;
          setQueueState({ playlistId: normalizedPlaylistId, items, unavailable: false });
        },
        () => {
          if (cancelled) return;
          queueRef.current = [];
          setQueueState({ playlistId: normalizedPlaylistId, items: [], unavailable: true });
        },
      );
      return () => {
        cancelled = true;
      };
    }, [normalizedPlaylistId, onStateChange]);

    useEffect(() => {
      if (!queueLoaded || normalizedPlaylistId.length === 0) return undefined;
      let cancelled = false;
      void loadApi()
        .then(() => {
          if (cancelled || window.YT === undefined) return;
          playerRef.current?.destroy();
          readyRef.current = false;
          const playerVars: Record<string, string | number> = {
            playsinline: 1,
            controls: 1,
            rel: 0,
            ...(queueRef.current.length === 0
              ? { listType: "playlist", list: normalizedPlaylistId }
              : {}),
          };
          playerRef.current = new window.YT.Player(elementId, {
            width: "100%",
            height: "100%",
            playerVars,
            events: {
              onReady: ({ target }) => {
                disablePictureInPicture(target);
                target.setVolume(activeVolumeRef.current);
                controllerRef.current = new MusicController(new YouTubeAdapter(target));
                if (queueRef.current.length > 0) {
                  readyRef.current = false;
                  target.cuePlaylist(
                    queueRef.current.map(({ videoId }) => videoId),
                    0,
                    0,
                  );
                } else {
                  readyRef.current = true;
                  onStateChange("paused");
                }
              },
              onStateChange: ({ data }) => {
                if (data === window.YT?.PlayerState.CUED) {
                  readyRef.current = true;
                  onStateChange("paused");
                } else if (data === window.YT?.PlayerState.PLAYING) {
                  readyRef.current = true;
                  onStateChange("playing");
                } else if (data === window.YT?.PlayerState.ENDED) {
                  onStateChange("paused");
                } else if (data === window.YT?.PlayerState.PAUSED) {
                  onStateChange("paused");
                }
              },
              onError: () => onStateChange("error"),
            },
          });
        })
        .catch(() => onStateChange("error"));

      return () => {
        cancelled = true;
        playerRef.current?.destroy();
        playerRef.current = null;
      };
    }, [elementId, normalizedPlaylistId, onStateChange, queueLoaded]);

    useImperativeHandle(ref, () => ({
      async fadeIn() {
        if (!readyRef.current || controllerRef.current === null) {
          onStateChange(playlistId.trim().length === 0 ? "error" : "loading");
          return false;
        }
        await controllerRef.current.fadeIn({ durationMs: 2_000, targetVolume: activeVolume });
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
      <section
        className={`youtube-player-frame${expanded ? " is-expanded" : ""}`}
        aria-label="YouTube playlist player"
      >
        <div className="youtube-player-video" id={elementId} />
        <div className="youtube-player-actions">
          <div className="youtube-volume-presets" aria-label="Music volume modes">
            {volumePresets.map((volume) => (
              <button
                key={volume}
                type="button"
                aria-label={`Set music volume to ${volume}%`}
                aria-pressed={activeVolume === volume}
                onClick={() => {
                  playerRef.current?.setVolume(volume);
                  onVolumeChange(volume);
                }}
              >
                {volume}%
              </button>
            ))}
          </div>
          <button type="button" onClick={() => onExpandedChange(!expanded)}>
            {expanded ? "Collapse player" : "Expand player and playlist"}
          </button>
        </div>
        {expanded ? (
          <section className="youtube-session-queue" aria-label="Selected playlist">
            <h2>Selected playlist</h2>
            {queue === null ? <p>Loading playlist queue…</p> : null}
            {queueUnavailable ? (
              <p>Playlist details are unavailable, but playback can still be cued.</p>
            ) : null}
            {queue !== null && !queueUnavailable ? (
              <ol>
                {queue.map((item, index) => (
                  <li key={`${item.videoId}-${index}`}>
                    {item.thumbnailUrl === null ? (
                      <span className="queue-thumbnail-placeholder" />
                    ) : (
                      <img src={item.thumbnailUrl} alt="" loading="lazy" />
                    )}
                    <span>{item.title}</span>
                  </li>
                ))}
              </ol>
            ) : null}
          </section>
        ) : null}
      </section>
    );
  },
);

YouTubePlaylistPlayer.displayName = "YouTubePlaylistPlayer";
