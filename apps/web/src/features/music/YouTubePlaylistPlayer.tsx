import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { CSSProperties } from "react";
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
    const [nextItemPosition, setNextItemPosition] = useState<number | null>(null);
    const [playerReady, setPlayerReady] = useState(false);
    const [dragPreview, setDragPreview] = useState<{
      readonly item: MusicPlaylistItem;
      readonly originIndex: number;
      readonly targetIndex: number;
      readonly pointerY: number;
      readonly offsetY: number;
      readonly left: number;
      readonly width: number;
      readonly height: number;
    } | null>(null);
    const playerRef = useRef<YT.Player | null>(null);
    const controllerRef = useRef<MusicController | null>(null);
    const readyRef = useRef(false);
    const queueRef = useRef<readonly MusicPlaylistItem[]>([]);
    const activeVolumeRef = useRef(activeVolume);
    activeVolumeRef.current = activeVolume;
    const playbackStateRef = useRef<YouTubePlaybackState>("idle");
    const draggedIndexRef = useRef<number | null>(null);
    const pointerDropIndexRef = useRef<number | null>(null);
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
      setPlayerReady(false);
      setNextItemPosition(null);
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
                  playbackStateRef.current = "paused";
                  readyRef.current = true;
                  setPlayerReady(true);
                  onStateChange("paused");
                }
              },
              onStateChange: ({ data }) => {
                if (data === window.YT?.PlayerState.CUED) {
                  playbackStateRef.current = "paused";
                  readyRef.current = true;
                  setPlayerReady(true);
                  onStateChange("paused");
                } else if (data === window.YT?.PlayerState.PLAYING) {
                  playbackStateRef.current = "playing";
                  readyRef.current = true;
                  setPlayerReady(true);
                  onStateChange("playing");
                } else if (data === window.YT?.PlayerState.ENDED) {
                  setNextItemPosition(null);
                  playbackStateRef.current = "paused";
                  onStateChange("paused");
                } else if (data === window.YT?.PlayerState.PAUSED) {
                  playbackStateRef.current = "paused";
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

    const currentPosition = () => {
      const player = playerRef.current;
      if (player === null || !readyRef.current) return null;
      const reportedIndex = player.getPlaylistIndex();
      const currentIndex = reportedIndex < 0 ? 0 : reportedIndex;
      return {
        item: queueRef.current[currentIndex] ?? null,
        seconds: player.getCurrentTime(),
      };
    };

    const applyQueue = (
      next: readonly MusicPlaylistItem[],
      position: ReturnType<typeof currentPosition>,
    ) => {
      const player = playerRef.current;
      if (player === null) return;
      const nextIndex =
        position?.item === null || position?.item === undefined
          ? 0
          : Math.max(0, next.indexOf(position.item));
      const seconds = position?.seconds ?? 0;
      readyRef.current = false;
      setPlayerReady(false);
      controllerRef.current?.cancelActiveFade();
      onStateChange("loading");
      const videoIds = next.map(({ videoId }) => videoId);
      if (playbackStateRef.current === "playing") {
        player.loadPlaylist(videoIds, nextIndex, seconds);
      } else {
        player.cuePlaylist(videoIds, nextIndex, seconds);
      }
    };

    const reorderQueue = (index: number, target: number) => {
      if (queue === null || queueState === null || target < 0 || target >= queue.length) return;
      const position = currentPosition();
      const next = [...queueRef.current];
      const [moved] = next.splice(index, 1);
      if (moved === undefined) return;
      next.splice(target, 0, moved);
      queueRef.current = next;
      setQueueState((current) => (current === null ? null : { ...current, items: next }));
      applyQueue(next, position);
    };

    const playNext = (selectedIndex: number) => {
      const player = playerRef.current;
      const selected = queueRef.current[selectedIndex];
      const reportedCurrentIndex = player?.getPlaylistIndex() ?? 0;
      const currentIndex = reportedCurrentIndex < 0 ? 0 : reportedCurrentIndex;
      const current = queueRef.current[currentIndex];
      if (selected === undefined || current === undefined || selected === current) return;
      const position = currentPosition();
      const next = [...queueRef.current];
      next.splice(selectedIndex, 1);
      const nextCurrentIndex = next.indexOf(current);
      next.splice(Math.min(nextCurrentIndex + 1, next.length), 0, selected);
      queueRef.current = next;
      setQueueState((state) => (state === null ? null : { ...state, items: next }));
      setNextItemPosition(selected.position);
      applyQueue(next, position);
    };

    const playNow = (index: number) => {
      setNextItemPosition(null);
      playerRef.current?.playVideoAt(index);
    };

    const queueItemStyle = (index: number): CSSProperties | undefined => {
      if (dragPreview === null || index === dragPreview.originIndex) return undefined;
      const distance = dragPreview.height + 7;
      if (
        dragPreview.originIndex < dragPreview.targetIndex &&
        index > dragPreview.originIndex &&
        index <= dragPreview.targetIndex
      ) {
        return { transform: `translateY(-${distance}px)` };
      }
      if (
        dragPreview.originIndex > dragPreview.targetIndex &&
        index >= dragPreview.targetIndex &&
        index < dragPreview.originIndex
      ) {
        return { transform: `translateY(${distance}px)` };
      }
      return undefined;
    };

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
            {expanded ? "Collapse player" : "Expand player and queue"}
          </button>
        </div>
        {expanded ? (
          <section className="youtube-session-queue" aria-label="Session playlist queue">
            <h2>Session queue</h2>
            {queue === null ? <p>Loading playlist queue…</p> : null}
            {queueUnavailable ? (
              <p>Playlist details are unavailable, but playback can still be cued.</p>
            ) : null}
            {queue !== null && !queueUnavailable ? (
              <ol>
                {queue.map((item, index) => (
                  <li
                    key={`${item.videoId}-${item.position}`}
                    className={`${nextItemPosition === item.position ? "is-next" : ""}${
                      dragPreview?.originIndex === index ? " is-dragging" : ""
                    }`}
                    data-queue-index={index}
                    style={queueItemStyle(index)}
                  >
                    <span
                      className="queue-drag-handle"
                      aria-label={`Drag ${item.title}`}
                      onPointerDown={(event) => {
                        const row = event.currentTarget.closest<HTMLElement>("[data-queue-index]");
                        const bounds = row?.getBoundingClientRect();
                        draggedIndexRef.current = index;
                        pointerDropIndexRef.current = index;
                        if (bounds !== undefined) {
                          setDragPreview({
                            item,
                            originIndex: index,
                            targetIndex: index,
                            pointerY: event.clientY,
                            offsetY: event.clientY - bounds.top,
                            left: bounds.left,
                            width: bounds.width,
                            height: bounds.height,
                          });
                        }
                        event.currentTarget.setPointerCapture?.(event.pointerId);
                      }}
                      onPointerMove={(event) => {
                        const draggedIndex = draggedIndexRef.current;
                        if (draggedIndex === null) return;
                        setDragPreview((current) =>
                          current === null ? null : { ...current, pointerY: event.clientY },
                        );
                        const targetRow = document
                          .elementFromPoint(event.clientX, event.clientY)
                          ?.closest<HTMLElement>("[data-queue-index]");
                        const targetIndex = Number(targetRow?.dataset.queueIndex);
                        if (!Number.isInteger(targetIndex) || targetIndex === draggedIndex) return;
                        pointerDropIndexRef.current = targetIndex;
                        setDragPreview((current) =>
                          current === null ? null : { ...current, targetIndex },
                        );
                      }}
                      onPointerUp={(event) => {
                        const draggedIndex = draggedIndexRef.current;
                        const targetIndex = pointerDropIndexRef.current;
                        if (
                          draggedIndex !== null &&
                          targetIndex !== null &&
                          targetIndex !== draggedIndex
                        ) {
                          reorderQueue(draggedIndex, targetIndex);
                        }
                        draggedIndexRef.current = null;
                        pointerDropIndexRef.current = null;
                        setDragPreview(null);
                        event.currentTarget.releasePointerCapture?.(event.pointerId);
                      }}
                      onPointerCancel={() => {
                        draggedIndexRef.current = null;
                        pointerDropIndexRef.current = null;
                        setDragPreview(null);
                      }}
                    >
                      <svg aria-hidden="true" viewBox="0 0 24 24">
                        <circle cx="8" cy="6" r="1.5" />
                        <circle cx="16" cy="6" r="1.5" />
                        <circle cx="8" cy="12" r="1.5" />
                        <circle cx="16" cy="12" r="1.5" />
                        <circle cx="8" cy="18" r="1.5" />
                        <circle cx="16" cy="18" r="1.5" />
                      </svg>
                    </span>
                    {item.thumbnailUrl === null ? (
                      <span className="queue-thumbnail-placeholder" />
                    ) : (
                      <img src={item.thumbnailUrl} alt="" loading="lazy" />
                    )}
                    <span>{item.title}</span>
                    <div className="queue-item-actions">
                      <button
                        type="button"
                        aria-label={`Play ${item.title} next`}
                        title="Play next"
                        aria-pressed={nextItemPosition === item.position}
                        onClick={() => playNext(index)}
                      >
                        <svg aria-hidden="true" viewBox="0 0 24 24">
                          <path d="M5 6h8a4 4 0 0 1 4 4v7" />
                          <path d="m13 14 4 4 4-4" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        aria-label={`Play ${item.title} now`}
                        title="Play now"
                        disabled={!playerReady}
                        onClick={() => playNow(index)}
                      >
                        <svg aria-hidden="true" viewBox="0 0 24 24">
                          <path d="m8 5 11 7-11 7V5Z" />
                        </svg>
                      </button>
                    </div>
                  </li>
                ))}
              </ol>
            ) : null}
            {dragPreview === null ? null : (
              <div
                className="queue-drag-preview"
                style={{
                  top: dragPreview.pointerY - dragPreview.offsetY,
                  left: dragPreview.left,
                  width: dragPreview.width,
                  height: dragPreview.height,
                }}
                aria-hidden="true"
              >
                {dragPreview.item.thumbnailUrl === null ? (
                  <span className="queue-thumbnail-placeholder" />
                ) : (
                  <img src={dragPreview.item.thumbnailUrl} alt="" />
                )}
                <strong>{dragPreview.item.title}</strong>
              </div>
            )}
          </section>
        ) : null}
      </section>
    );
  },
);

YouTubePlaylistPlayer.displayName = "YouTubePlaylistPlayer";
