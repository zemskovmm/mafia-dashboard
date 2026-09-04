import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { listMusicPlaylistItems } from "../../api/client.js";
import type { MusicPlaylistItem } from "../../api/client.js";
import { reportError } from "../console/error-console.js";
import { useMessages } from "../../i18n/I18nProvider.js";
import { playersMusicMessages } from "../../i18n/messages/players-music.js";
import { classifyPanelSwipe } from "../game/panel-swipe.js";
import { MusicController } from "./music-controller.js";
import type { MusicPlayerAdapter } from "./music-controller.js";
import {
  openingQueue,
  queueEntryKey,
  restoreQueueOrder,
  shuffledQueue,
  shuffledQueueWithPreferred,
} from "./music-preferences.js";

export type YouTubePlaybackState = "idle" | "loading" | "playing" | "paused" | "error";

export interface YouTubePlayerHandle {
  fadeIn(): Promise<boolean>;
  quickFadeOut(): Promise<void>;
  slowFadeOut(): Promise<void>;
  startOpeningQueue(): boolean;
  playFirstRegularTrack(): boolean;
  shuffleQueue(options?: { readonly preferEndgame?: boolean }): boolean;
}

interface YouTubePlaylistPlayerProps {
  readonly playlistId: string;
  readonly onStateChange: (state: YouTubePlaybackState) => void;
  readonly expanded?: boolean;
  readonly reloadRequest?: number;
  readonly rememberedQueueOrder?: readonly string[];
  readonly onQueueOrderChange?: (playlistId: string, orderedEntryKeys: readonly string[]) => void;
  readonly initialStageEntryKeys?: readonly string[];
  readonly onInitialStageEntryKeysChange?: (
    playlistId: string,
    entryKeys: readonly string[],
  ) => void;
  readonly endgameEntryKeys?: readonly string[];
  readonly onEndgameEntryKeysChange?: (playlistId: string, entryKeys: readonly string[]) => void;
}

const EMPTY_QUEUE_ORDER: readonly string[] = [];
const FULL_VOLUME = 100;

const queueOrdersEqual = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((entryKey, index) => entryKey === right[index]);

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
      reloadRequest = 0,
      rememberedQueueOrder = EMPTY_QUEUE_ORDER,
      onQueueOrderChange = () => undefined,
      initialStageEntryKeys = EMPTY_QUEUE_ORDER,
      onInitialStageEntryKeysChange = () => undefined,
      endgameEntryKeys = EMPTY_QUEUE_ORDER,
      onEndgameEntryKeysChange = () => undefined,
    },
    ref,
  ) => {
    const { t } = useMessages(playersMusicMessages);
    const [instanceKey, setInstanceKey] = useState(0);
    const [queueState, setQueueState] = useState<{
      readonly playlistId: string;
      readonly items: readonly MusicPlaylistItem[];
      readonly unavailable: boolean;
    } | null>(null);
    const [playerReady, setPlayerReady] = useState(false);
    const [revealedTagEntryKey, setRevealedTagEntryKey] = useState<string | null>(null);
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
    const playerGenerationRef = useRef(0);
    const controllerRef = useRef<MusicController | null>(null);
    const iframeReadyRef = useRef(false);
    const readyRef = useRef(false);
    const queueRef = useRef<readonly MusicPlaylistItem[]>([]);
    const providerQueueRef = useRef<{
      readonly playlistId: string;
      readonly items: readonly MusicPlaylistItem[];
    } | null>(null);
    const appliedRememberedQueueOrderRef = useRef<{
      readonly playlistId: string;
      readonly order: readonly string[];
    } | null>(null);
    const queueUnavailableRef = useRef(false);
    const normalizedPlaylistIdRef = useRef(playlistId.trim());
    const rememberedQueueOrderRef = useRef(rememberedQueueOrder);
    rememberedQueueOrderRef.current = rememberedQueueOrder;
    const onStateChangeRef = useRef(onStateChange);
    onStateChangeRef.current = onStateChange;
    const playbackStateRef = useRef<YouTubePlaybackState>("idle");
    const draggedIndexRef = useRef<number | null>(null);
    const pointerDropIndexRef = useRef<number | null>(null);
    const tagSwipeStartRef = useRef<{
      readonly entryKey: string;
      readonly x: number;
      readonly y: number;
    } | null>(null);
    const suppressTagClickRef = useRef(false);
    const pendingOpeningFadeRef = useRef(false);
    const handledReloadRequest = useRef(reloadRequest);
    const elementId = `youtube-mafia-player-${instanceKey}`;
    const normalizedPlaylistId = playlistId.trim();
    normalizedPlaylistIdRef.current = normalizedPlaylistId;
    const queue = queueState?.playlistId === normalizedPlaylistId ? queueState.items : null;
    const queueUnavailable =
      queueState?.playlistId === normalizedPlaylistId && queueState.unavailable;
    const queueLoaded = queue !== null;

    useEffect(() => {
      if (handledReloadRequest.current === reloadRequest) return;
      handledReloadRequest.current = reloadRequest;
      playerGenerationRef.current += 1;
      setInstanceKey((key) => key + 1);
    }, [reloadRequest]);

    useEffect(() => {
      queueRef.current = [];
      providerQueueRef.current = null;
      appliedRememberedQueueOrderRef.current = null;
      queueUnavailableRef.current = false;
      readyRef.current = false;
      setPlayerReady(false);
      setRevealedTagEntryKey(null);
      pendingOpeningFadeRef.current = false;
      controllerRef.current?.cancelActiveFade();
      setQueueState(null);
      if (normalizedPlaylistId.length === 0) {
        playerRef.current?.pauseVideo();
        playbackStateRef.current = "idle";
        onStateChangeRef.current("idle");
        return undefined;
      }
      let cancelled = false;
      onStateChangeRef.current("loading");
      void listMusicPlaylistItems(normalizedPlaylistId).then(
        (items) => {
          if (cancelled) return;
          const rememberedOrder = rememberedQueueOrderRef.current;
          const restoredItems = restoreQueueOrder(rememberedOrder, items);
          providerQueueRef.current = { playlistId: normalizedPlaylistId, items };
          appliedRememberedQueueOrderRef.current = {
            playlistId: normalizedPlaylistId,
            order: [...rememberedOrder],
          };
          queueRef.current = restoredItems;
          queueUnavailableRef.current = false;
          setQueueState({
            playlistId: normalizedPlaylistId,
            items: restoredItems,
            unavailable: false,
          });
          if (playerRef.current !== null && iframeReadyRef.current) {
            applyQueue(restoredItems, null);
          }
        },
        () => {
          if (cancelled) return;
          queueRef.current = [];
          queueUnavailableRef.current = true;
          setQueueState({ playlistId: normalizedPlaylistId, items: [], unavailable: true });
          if (playerRef.current !== null && iframeReadyRef.current) {
            applyPlaylist(normalizedPlaylistId, 0, 0);
          }
        },
      );
      return () => {
        cancelled = true;
      };
    }, [normalizedPlaylistId]);

    useEffect(() => {
      if (!expanded) setRevealedTagEntryKey(null);
    }, [expanded]);

    useEffect(() => {
      const providerQueue = providerQueueRef.current;
      if (providerQueue?.playlistId !== normalizedPlaylistId) return;
      const appliedOrder = appliedRememberedQueueOrderRef.current;
      if (
        appliedOrder?.playlistId === normalizedPlaylistId &&
        queueOrdersEqual(appliedOrder.order, rememberedQueueOrder)
      )
        return;
      const position = currentPosition();
      const restoredItems = restoreQueueOrder(rememberedQueueOrder, providerQueue.items);
      appliedRememberedQueueOrderRef.current = {
        playlistId: normalizedPlaylistId,
        order: [...rememberedQueueOrder],
      };
      queueRef.current = restoredItems;
      setQueueState({
        playlistId: normalizedPlaylistId,
        items: restoredItems,
        unavailable: false,
      });
      if (playerRef.current !== null && iframeReadyRef.current) {
        applyQueue(restoredItems, position);
      }
    }, [normalizedPlaylistId, rememberedQueueOrder]);

    useEffect(() => {
      if (!queueLoaded || normalizedPlaylistId.length === 0) return undefined;
      if (playerRef.current !== null) return undefined;
      let cancelled = false;
      void loadApi()
        .then(() => {
          if (cancelled || window.YT === undefined || playerRef.current !== null) return;
          iframeReadyRef.current = false;
          readyRef.current = false;
          const configuredFallbackPlaylistId =
            queueRef.current.length === 0 ? normalizedPlaylistId : null;
          const playerVars: Record<string, string | number> = {
            playsinline: 1,
            controls: 1,
            rel: 0,
            origin: window.location.origin,
            ...(configuredFallbackPlaylistId !== null
              ? { listType: "playlist", list: configuredFallbackPlaylistId }
              : {}),
          };
          const playerGeneration = playerGenerationRef.current + 1;
          playerGenerationRef.current = playerGeneration;
          playerRef.current = new window.YT.Player(elementId, {
            width: "100%",
            height: "100%",
            playerVars,
            events: {
              onReady: ({ target }) => {
                if (
                  playerGenerationRef.current !== playerGeneration ||
                  playerRef.current !== target ||
                  normalizedPlaylistIdRef.current.length === 0
                )
                  return;
                iframeReadyRef.current = true;
                disablePictureInPicture(target);
                controllerRef.current = new MusicController(new YouTubeAdapter(target));
                if (queueRef.current.length > 0) {
                  readyRef.current = false;
                  target.cuePlaylist(
                    queueRef.current.map(({ videoId }) => videoId),
                    0,
                    0,
                  );
                } else if (
                  queueUnavailableRef.current &&
                  normalizedPlaylistIdRef.current !== configuredFallbackPlaylistId
                ) {
                  applyPlaylist(normalizedPlaylistIdRef.current, 0, 0);
                } else {
                  playbackStateRef.current = "paused";
                  readyRef.current = true;
                  setPlayerReady(true);
                  onStateChangeRef.current("paused");
                }
              },
              onStateChange: ({ target, data }) => {
                if (
                  playerGenerationRef.current !== playerGeneration ||
                  playerRef.current !== target ||
                  normalizedPlaylistIdRef.current.length === 0
                )
                  return;
                if (data === window.YT?.PlayerState.CUED) {
                  playbackStateRef.current = "paused";
                  readyRef.current = true;
                  setPlayerReady(true);
                  if (pendingOpeningFadeRef.current && controllerRef.current !== null) {
                    pendingOpeningFadeRef.current = false;
                    void controllerRef.current.fadeIn({
                      durationMs: 2_000,
                      targetVolume: FULL_VOLUME,
                    });
                  } else {
                    pendingOpeningFadeRef.current = false;
                    onStateChangeRef.current("paused");
                  }
                } else if (data === window.YT?.PlayerState.PLAYING) {
                  playbackStateRef.current = "playing";
                  readyRef.current = true;
                  setPlayerReady(true);
                  onStateChangeRef.current("playing");
                } else if (data === window.YT?.PlayerState.ENDED) {
                  playbackStateRef.current = "paused";
                  onStateChangeRef.current("paused");
                } else if (data === window.YT?.PlayerState.PAUSED) {
                  playbackStateRef.current = "paused";
                  onStateChangeRef.current("paused");
                }
              },
              onError: () => {
                if (
                  playerGenerationRef.current !== playerGeneration ||
                  normalizedPlaylistIdRef.current.length === 0
                )
                  return;
                pendingOpeningFadeRef.current = false;
                onStateChangeRef.current("error");
              },
            },
          });
        })
        .catch((error: unknown) => {
          reportError(error, { source: "api", context: "music-playlist-items.list" });
          onStateChangeRef.current("error");
        });

      return () => {
        cancelled = true;
      };
    }, [elementId, normalizedPlaylistId, queueLoaded]);

    useEffect(
      () => () => {
        playerGenerationRef.current += 1;
        playerRef.current?.destroy();
        playerRef.current = null;
        controllerRef.current = null;
        iframeReadyRef.current = false;
        readyRef.current = false;
        pendingOpeningFadeRef.current = false;
      },
      [elementId],
    );

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

    function applyPlaylist(playlist: string | readonly string[], index: number, seconds: number) {
      const player = playerRef.current;
      if (player === null) return;
      readyRef.current = false;
      setPlayerReady(false);
      controllerRef.current?.cancelActiveFade();
      onStateChangeRef.current("loading");
      if (playbackStateRef.current === "playing") {
        (
          player.loadPlaylist as (
            nextPlaylist: string | readonly string[],
            nextIndex?: number,
            startSeconds?: number,
          ) => void
        )(playlist, index, seconds);
      } else {
        player.cuePlaylist(playlist, index, seconds);
      }
    }

    function applyQueue(
      next: readonly MusicPlaylistItem[],
      position: ReturnType<typeof currentPosition>,
    ) {
      pendingOpeningFadeRef.current = false;
      setRevealedTagEntryKey(null);
      const nextIndex =
        position?.item === null || position?.item === undefined
          ? 0
          : Math.max(0, next.indexOf(position.item));
      const seconds = position?.seconds ?? 0;
      applyPlaylist(
        next.map(({ videoId }) => videoId),
        nextIndex,
        seconds,
      );
    }

    function emitQueueOrder(next: readonly MusicPlaylistItem[]) {
      const order = next.map(queueEntryKey);
      appliedRememberedQueueOrderRef.current = {
        playlistId: normalizedPlaylistId,
        order,
      };
      onQueueOrderChange(normalizedPlaylistId, order);
    }

    const reorderQueue = (index: number, target: number) => {
      if (queue === null || queueState === null || target < 0 || target >= queue.length) return;
      const position = currentPosition();
      const next = [...queueRef.current];
      const [moved] = next.splice(index, 1);
      if (moved === undefined) return;
      next.splice(target, 0, moved);
      queueRef.current = next;
      setQueueState((current) => (current === null ? null : { ...current, items: next }));
      emitQueueOrder(next);
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
      emitQueueOrder(next);
      applyQueue(next, position);
    };

    const playNow = (index: number) => {
      const player = playerRef.current;
      const controller = controllerRef.current;
      if (player === null || controller === null || !readyRef.current) return;
      void controller.fadeIn({
        durationMs: 2_000,
        targetVolume: FULL_VOLUME,
        startPlayback: () => player.playVideoAt(index),
      });
    };

    const toggledEntryKeys = (entryKeys: readonly string[], entryKey: string): readonly string[] =>
      entryKeys.includes(entryKey)
        ? entryKeys.filter((candidate) => candidate !== entryKey)
        : [...entryKeys, entryKey];

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
        await controllerRef.current.fadeIn({
          durationMs: 2_000,
          targetVolume: FULL_VOLUME,
        });
        return true;
      },
      async quickFadeOut() {
        await controllerRef.current?.fadeOut({ durationMs: 500 });
      },
      async slowFadeOut() {
        await controllerRef.current?.fadeOut({ durationMs: 3_000 });
      },
      startOpeningQueue() {
        const player = playerRef.current;
        if (
          player === null ||
          controllerRef.current === null ||
          !readyRef.current ||
          queueUnavailableRef.current
        )
          return false;
        const initial = new Set(initialStageEntryKeys);
        const endgame = new Set(endgameEntryKeys);
        const next = openingQueue(
          queueRef.current,
          (item) => initial.has(queueEntryKey(item)),
          (item) => endgame.has(queueEntryKey(item)),
        );
        if (next === null) return false;
        queueRef.current = next;
        setQueueState((state) => (state === null ? null : { ...state, items: next }));
        setRevealedTagEntryKey(null);
        emitQueueOrder(next);
        readyRef.current = false;
        setPlayerReady(false);
        controllerRef.current.cancelActiveFade();
        playbackStateRef.current = "loading";
        pendingOpeningFadeRef.current = true;
        onStateChangeRef.current("loading");
        player.cuePlaylist(
          next.map(({ videoId }) => videoId),
          0,
          0,
        );
        return true;
      },
      playFirstRegularTrack() {
        const player = playerRef.current;
        if (
          player === null ||
          !readyRef.current ||
          queueUnavailableRef.current ||
          playbackStateRef.current !== "playing"
        )
          return false;
        const marked = new Set(initialStageEntryKeys);
        const index = queueRef.current.findIndex((item) => !marked.has(queueEntryKey(item)));
        if (index < 0) return false;
        controllerRef.current?.cancelActiveFade({ pausePendingPlayback: false });
        player.setVolume(FULL_VOLUME);
        player.playVideoAt(index);
        return true;
      },
      shuffleQueue({ preferEndgame = false } = {}) {
        const current = queueRef.current;
        if (queueUnavailableRef.current || current.length < 2) return false;
        pendingOpeningFadeRef.current = false;
        setRevealedTagEntryKey(null);
        const position = currentPosition();
        const endgame = new Set(endgameEntryKeys);
        const hasPreferred =
          preferEndgame && current.some((item) => endgame.has(queueEntryKey(item)));
        const next = hasPreferred
          ? shuffledQueueWithPreferred(current, (item) => endgame.has(queueEntryKey(item)))
          : shuffledQueue(current);
        const nextIndex = hasPreferred
          ? 0
          : position?.item == null
            ? 0
            : Math.max(0, next.indexOf(position.item));
        const seconds = hasPreferred ? 0 : (position?.seconds ?? 0);
        queueRef.current = next;
        setQueueState((state) => (state === null ? null : { ...state, items: next }));
        emitQueueOrder(next);
        const player = playerRef.current;
        if (player !== null && iframeReadyRef.current) {
          readyRef.current = false;
          setPlayerReady(false);
          controllerRef.current?.cancelActiveFade();
          playbackStateRef.current = "loading";
          onStateChangeRef.current("loading");
          player.cuePlaylist(
            next.map(({ videoId }) => videoId),
            nextIndex,
            seconds,
          );
        }
        return true;
      },
    }));

    return (
      <section
        className={`youtube-player-frame${expanded ? " is-expanded" : ""}`}
        aria-label={t("YouTube playlist player")}
      >
        <div className="youtube-player-video" id={elementId} />
        {expanded ? (
          <section className="youtube-session-queue" aria-label={t("Session playlist queue")}>
            <h2>{t("Session queue")}</h2>
            {queue === null ? <p>{t("Loading playlist queue")}</p> : null}
            {queueUnavailable ? <p>{t("Playlist details unavailable")}</p> : null}
            {queue !== null && !queueUnavailable ? (
              <ol>
                {queue.map((item, index) => {
                  const entryKey = queueEntryKey(item);
                  const endgameMarked = endgameEntryKeys.includes(entryKey);
                  const initialMarked = !endgameMarked && initialStageEntryKeys.includes(entryKey);
                  const revealed = revealedTagEntryKey === entryKey;
                  return (
                    <li
                      key={entryKey}
                      className={`${dragPreview?.originIndex === index ? "is-dragging" : ""}${
                        revealed ? " is-queue-tags-revealed" : ""
                      }`}
                      data-queue-index={index}
                      data-initial-stage={initialMarked}
                      data-endgame={endgameMarked}
                      style={queueItemStyle(index)}
                      onClickCapture={(event) => {
                        if (!suppressTagClickRef.current) return;
                        suppressTagClickRef.current = false;
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                    >
                      <div
                        className="queue-tag-actions"
                        role="group"
                        aria-label={t("Track types for {title}", { title: item.title })}
                      >
                        <button
                          type="button"
                          className="queue-tag-action is-initial"
                          aria-label={t(
                            initialMarked
                              ? "Unmark {title}: role giveaway"
                              : "Mark {title}: role giveaway",
                            { title: item.title },
                          )}
                          aria-pressed={initialMarked}
                          onClick={() => {
                            onInitialStageEntryKeysChange(
                              normalizedPlaylistId,
                              toggledEntryKeys(initialStageEntryKeys, entryKey),
                            );
                            setRevealedTagEntryKey(null);
                          }}
                        >
                          {t("Initial")}
                        </button>
                        <button
                          type="button"
                          className="queue-tag-action is-endgame"
                          aria-label={t(
                            endgameMarked
                              ? "Unmark {title}: critical endgame"
                              : "Mark {title}: critical endgame",
                            { title: item.title },
                          )}
                          aria-pressed={endgameMarked}
                          onClick={() => {
                            onEndgameEntryKeysChange(
                              normalizedPlaylistId,
                              toggledEntryKeys(endgameEntryKeys, entryKey),
                            );
                            setRevealedTagEntryKey(null);
                          }}
                        >
                          {t("Endgame")}
                        </button>
                      </div>
                      <div
                        className="queue-item-content"
                        onTouchStart={(event) => {
                          const target = event.target as HTMLElement;
                          if (
                            target.closest(
                              ".queue-drag-handle, .queue-item-actions, .queue-tag-actions",
                            ) !== null
                          ) {
                            tagSwipeStartRef.current = null;
                            return;
                          }
                          const touch = event.touches[0];
                          tagSwipeStartRef.current = touch
                            ? { entryKey, x: touch.clientX, y: touch.clientY }
                            : null;
                          suppressTagClickRef.current = false;
                        }}
                        onTouchEnd={(event) => {
                          const start = tagSwipeStartRef.current;
                          tagSwipeStartRef.current = null;
                          const touch = event.changedTouches[0];
                          if (!start || !touch || start.entryKey !== entryKey) return;
                          const swipe = classifyPanelSwipe(
                            { x: start.x, y: start.y },
                            { x: touch.clientX, y: touch.clientY },
                            44,
                          );
                          if (swipe !== "left" && swipe !== "right") return;
                          suppressTagClickRef.current = true;
                          setRevealedTagEntryKey(swipe === "left" ? entryKey : null);
                        }}
                      >
                        <span
                          className="queue-drag-handle"
                          aria-label={t("Drag {title}", { title: item.title })}
                          onPointerDown={(event) => {
                            const row =
                              event.currentTarget.closest<HTMLElement>("[data-queue-index]");
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
                            if (!Number.isInteger(targetIndex) || targetIndex === draggedIndex)
                              return;
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
                        <span className="queue-item-copy">
                          <span className="queue-item-title">{item.title}</span>
                        </span>
                        <div className="queue-item-actions">
                          <button
                            type="button"
                            aria-label={t("Play {title} next", { title: item.title })}
                            title={t("Play next")}
                            onClick={() => playNext(index)}
                          >
                            <svg aria-hidden="true" viewBox="0 0 24 24">
                              <path d="M5 6h8a4 4 0 0 1 4 4v7" />
                              <path d="m13 14 4 4 4-4" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            aria-label={t("Play {title} now", { title: item.title })}
                            title={t("Play now")}
                            disabled={!playerReady}
                            onClick={() => playNow(index)}
                          >
                            <svg aria-hidden="true" viewBox="0 0 24 24">
                              <path d="m8 5 11 7-11 7V5Z" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
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
