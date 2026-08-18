import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  listLocalMusicTracks,
  uploadLocalMusicTrack,
  type LocalMusicTrack,
} from "../../api/client.js";
import { MusicController } from "./music-controller.js";
import { CrossfadeController } from "./crossfade-controller.js";
import { shouldStartCrossfade } from "./crossfade-timing.js";
import { GainAudioAdapter } from "./gain-audio-adapter.js";
import { mergeByStableId, uploadSequentially } from "./local-upload.js";
import { shouldStopPrearmedDeck } from "./prearm-guard.js";
import type { YouTubePlaybackState, YouTubePlayerHandle } from "./YouTubePlaylistPlayer.js";
import { WaveformScrubber } from "./WaveformScrubber.js";

export interface LocalDJSessionState {
  readonly queueIds: readonly string[];
  readonly currentStartSeconds: number;
  readonly nextStartSeconds: number;
  readonly crossfadeSeconds: number;
}

interface LocalDJPlayerProps {
  readonly onStateChange: (state: YouTubePlaybackState) => void;
  readonly initialSessionState?: LocalDJSessionState | null;
  readonly onSessionStateChange?: (state: LocalDJSessionState) => void;
}

const dedupe = (ids: readonly string[]) => [...new Set(ids)];

export const LocalDJPlayer = forwardRef<YouTubePlayerHandle, LocalDJPlayerProps>(
  ({ onStateChange, initialSessionState = null, onSessionStateChange }, ref) => {
    const [tracks, setTracks] = useState<readonly LocalMusicTrack[]>([]);
    const [queueIds, setQueueIds] = useState<readonly string[]>(
      initialSessionState?.queueIds ?? [],
    );
    const [currentStartSeconds, setCurrentStartSeconds] = useState(
      initialSessionState?.currentStartSeconds ?? 0,
    );
    const [nextStartSeconds, setNextStartSeconds] = useState(
      initialSessionState?.nextStartSeconds ?? 0,
    );
    const [crossfadeSeconds, setCrossfadeSeconds] = useState(
      initialSessionState?.crossfadeSeconds ?? 5,
    );
    const [activeDeck, setActiveDeck] = useState<"a" | "b">("a");
    const activeDeckRef = useRef<"a" | "b">("a");
    const [playedSeconds, setPlayedSeconds] = useState(0);
    const [uploading, setUploading] = useState(false);
    const [isTransitioning, setIsTransitioning] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const uploadedTrackIdsRef = useRef(new Set<string>());
    const deckARef = useRef<HTMLAudioElement>(null);
    const deckBRef = useRef<HTMLAudioElement>(null);
    const crossfadeRef = useRef(new CrossfadeController());
    const fadeControllerRef = useRef<{
      readonly audio: HTMLAudioElement;
      readonly controller: MusicController;
    } | null>(null);
    const fadeControllersRef = useRef(new Map<HTMLAudioElement, MusicController>());
    const transitioningRef = useRef(false);
    const transitionGenerationRef = useRef(0);
    const audioContextRef = useRef<AudioContext | null>(null);
    const gainNodesRef = useRef(new Map<HTMLAudioElement, GainNode>());
    const mountedRef = useRef(false);
    const lifecycleGenerationRef = useRef(0);
    const libraryActivityGenerationRef = useRef(0);
    const uploadGenerationRef = useRef(0);
    const isCurrentLifecycle = useCallback(
      (generation: number) => mountedRef.current && generation === lifecycleGenerationRef.current,
      [],
    );
    const notifyStateChange = useCallback(
      (state: YouTubePlaybackState, generation = lifecycleGenerationRef.current) => {
        if (isCurrentLifecycle(generation)) onStateChange(state);
      },
      [isCurrentLifecycle, onStateChange],
    );

    useEffect(() => {
      const lifecycleGeneration = ++lifecycleGenerationRef.current;
      mountedRef.current = true;
      const deckA = deckARef.current;
      const deckB = deckBRef.current;
      return () => {
        if (lifecycleGeneration === lifecycleGenerationRef.current) {
          mountedRef.current = false;
          lifecycleGenerationRef.current += 1;
          uploadGenerationRef.current += 1;
        }
        transitionGenerationRef.current += 1;
        for (const controller of fadeControllersRef.current.values()) controller.cancelActiveFade();
        fadeControllersRef.current.clear();
        fadeControllerRef.current = null;
        crossfadeRef.current.cancel();
        deckA?.pause();
        deckB?.pause();
        gainNodesRef.current.clear();
        void audioContextRef.current?.close();
        audioContextRef.current = null;
      };
    }, []);

    useEffect(() => {
      const lifecycleGeneration = lifecycleGenerationRef.current;
      const libraryActivityGeneration = libraryActivityGenerationRef.current;
      let current = true;
      void listLocalMusicTracks()
        .then((loaded) => {
          if (!current || !isCurrentLifecycle(lifecycleGeneration)) return;
          setTracks((existing) => mergeByStableId(loaded, existing));
          setQueueIds((existing) => {
            const loadedIds = loaded.map(({ id }) => id);
            const knownIds = new Set([...loadedIds, ...uploadedTrackIdsRef.current]);
            const valid = existing.filter((id) => knownIds.has(id));
            return dedupe([...valid, ...loadedIds, ...uploadedTrackIdsRef.current]);
          });
          notifyStateChange(
            loaded.length === 0 && uploadedTrackIdsRef.current.size === 0 ? "idle" : "paused",
            lifecycleGeneration,
          );
        })
        .catch(() => {
          if (
            !current ||
            !isCurrentLifecycle(lifecycleGeneration) ||
            libraryActivityGeneration !== libraryActivityGenerationRef.current
          )
            return;
          setError("Unable to load the local music library.");
          notifyStateChange("error", lifecycleGeneration);
        });
      return () => {
        current = false;
      };
    }, [isCurrentLifecycle, notifyStateChange]);

    useEffect(() => {
      onSessionStateChange?.({
        queueIds,
        currentStartSeconds,
        nextStartSeconds,
        crossfadeSeconds,
      });
    }, [crossfadeSeconds, currentStartSeconds, nextStartSeconds, onSessionStateChange, queueIds]);

    const trackById = useMemo(
      () => new Map(tracks.map((track) => [track.id, track] as const)),
      [tracks],
    );
    const currentTrack = trackById.get(queueIds[0] ?? "") ?? null;
    const nextTrack = trackById.get(queueIds[1] ?? "") ?? null;
    const deckATrack = activeDeck === "a" ? currentTrack : nextTrack;
    const deckBTrack = activeDeck === "b" ? currentTrack : nextTrack;
    const currentAudio = () => (activeDeck === "a" ? deckARef.current : deckBRef.current);
    const nextAudio = () => (activeDeck === "a" ? deckBRef.current : deckARef.current);
    const adapterFor = useCallback(
      (audio: HTMLAudioElement) =>
        new GainAudioAdapter(audio, gainNodesRef.current.get(audio)?.gain),
      [],
    );
    const fadeControllerFor = useCallback(
      (audio: HTMLAudioElement) => {
        const existing = fadeControllerRef.current;
        if (existing?.audio === audio) return existing.controller;
        existing?.controller.cancelActiveFade();
        let controller = fadeControllersRef.current.get(audio);
        if (controller === undefined) {
          controller = new MusicController(adapterFor(audio));
          fadeControllersRef.current.set(audio, controller);
        }
        fadeControllerRef.current = { audio, controller };
        return controller;
      },
      [adapterFor],
    );
    const cancelCrossfade = useCallback(() => {
      transitionGenerationRef.current += 1;
      crossfadeRef.current.cancel();
      transitioningRef.current = false;
    }, []);
    const ensureAudioGraph = useCallback(() => {
      if (audioContextRef.current !== null || typeof window.AudioContext !== "function") return;
      const deckA = deckARef.current;
      const deckB = deckBRef.current;
      if (deckA === null || deckB === null) return;
      let context: AudioContext | null = null;
      try {
        const activeContext = new window.AudioContext();
        context = activeContext;
        const connect = (deck: HTMLAudioElement) => {
          const gain = activeContext.createGain();
          activeContext
            .createMediaElementSource(deck)
            .connect(gain)
            .connect(activeContext.destination);
          gainNodesRef.current.set(deck, gain);
        };
        connect(deckA);
        connect(deckB);
        audioContextRef.current = activeContext;
      } catch {
        gainNodesRef.current.clear();
        void context?.close();
      }
    }, []);
    const resumeAudioContext = useCallback(() => {
      const resume = audioContextRef.current?.resume();
      if (resume !== undefined) void resume.catch(() => undefined);
    }, []);

    const crossfade = useCallback(async () => {
      const lifecycleGeneration = lifecycleGenerationRef.current;
      const from = currentAudio();
      const to = nextAudio();
      if (
        !isCurrentLifecycle(lifecycleGeneration) ||
        from === null ||
        to === null ||
        nextTrack === null ||
        transitioningRef.current
      )
        return;
      const transitionGeneration = ++transitionGenerationRef.current;
      transitioningRef.current = true;
      setIsTransitioning(true);
      setError(null);
      ensureAudioGraph();
      resumeAudioContext();
      fadeControllerRef.current?.controller.cancelActiveFade({ pausePendingPlayback: false });
      notifyStateChange("playing", lifecycleGeneration);
      try {
        const result = await crossfadeRef.current.crossfade({
          current: adapterFor(from),
          next: adapterFor(to),
          nextStartSeconds,
          durationMs: crossfadeSeconds * 1_000,
          targetVolume: 0.65,
        });
        if (
          result !== "completed" ||
          transitionGeneration !== transitionGenerationRef.current ||
          !isCurrentLifecycle(lifecycleGeneration)
        )
          return;
        setError(null);
        const nextDeck = activeDeck === "a" ? "b" : "a";
        activeDeckRef.current = nextDeck;
        setActiveDeck(nextDeck);
        setQueueIds((ids) => ids.slice(1));
        setCurrentStartSeconds(nextStartSeconds);
        setNextStartSeconds(0);
        setPlayedSeconds(nextStartSeconds);
      } catch {
        if (
          transitionGeneration !== transitionGenerationRef.current ||
          !isCurrentLifecycle(lifecycleGeneration)
        )
          return;
        setError("The next deck could not start. Tap Crossfade now to retry.");
        notifyStateChange("error", lifecycleGeneration);
      } finally {
        if (
          transitionGeneration === transitionGenerationRef.current &&
          isCurrentLifecycle(lifecycleGeneration)
        ) {
          transitioningRef.current = false;
          setIsTransitioning(false);
        }
      }
    }, [
      activeDeck,
      adapterFor,
      crossfadeSeconds,
      ensureAudioGraph,
      isCurrentLifecycle,
      nextStartSeconds,
      nextTrack,
      notifyStateChange,
      resumeAudioContext,
    ]);

    useImperativeHandle(ref, () => ({
      async fadeIn() {
        const lifecycleGeneration = lifecycleGenerationRef.current;
        if (!isCurrentLifecycle(lifecycleGeneration)) return false;
        const audio = currentAudio();
        if (audio === null || currentTrack === null) {
          notifyStateChange(tracks.length === 0 ? "idle" : "loading", lifecycleGeneration);
          return false;
        }
        cancelCrossfade();
        const prearmGeneration = transitionGenerationRef.current;
        setIsTransitioning(false);
        audio.currentTime = currentStartSeconds;
        ensureAudioGraph();
        resumeAudioContext();
        const queued = nextAudio();
        if (queued !== null && nextTrack !== null) {
          const prearmDeck = activeDeckRef.current;
          adapterFor(queued).setVolume(0);
          queued.currentTime = nextStartSeconds;
          void queued
            .play()
            .then(() => {
              if (
                !isCurrentLifecycle(lifecycleGeneration) ||
                prearmGeneration !== transitionGenerationRef.current
              )
                return;
              if (
                shouldStopPrearmedDeck({
                  transitioning: transitioningRef.current,
                  activeDeck: activeDeckRef.current,
                  prearmDeck,
                })
              ) {
                queued.pause();
                queued.currentTime = nextStartSeconds;
              }
            })
            .catch(() => undefined);
        }
        const controller = fadeControllerFor(audio);
        let result;
        try {
          result = await controller.fadeIn({ durationMs: 2_000, targetVolume: 65 });
        } catch {
          if (!isCurrentLifecycle(lifecycleGeneration)) return false;
          setError("Playback was blocked. Tap Start · fade in to retry.");
          notifyStateChange("error", lifecycleGeneration);
          return false;
        }
        if (result === "cancelled" || !isCurrentLifecycle(lifecycleGeneration)) return false;
        notifyStateChange("playing", lifecycleGeneration);
        return true;
      },
      async quickFadeOut() {
        const lifecycleGeneration = lifecycleGenerationRef.current;
        if (!isCurrentLifecycle(lifecycleGeneration)) return;
        const audio = currentAudio();
        if (audio !== null) {
          cancelCrossfade();
          setIsTransitioning(false);
          const controller = fadeControllerFor(audio);
          const result = await controller.fadeOut({ durationMs: 500 });
          if (result === "cancelled" || !isCurrentLifecycle(lifecycleGeneration)) return;
          notifyStateChange("paused", lifecycleGeneration);
        }
      },
      async slowFadeOut() {
        const lifecycleGeneration = lifecycleGenerationRef.current;
        if (!isCurrentLifecycle(lifecycleGeneration)) return;
        const audio = currentAudio();
        if (audio !== null) {
          cancelCrossfade();
          setIsTransitioning(false);
          const controller = fadeControllerFor(audio);
          const result = await controller.fadeOut({ durationMs: 3_000 });
          if (result === "cancelled" || !isCurrentLifecycle(lifecycleGeneration)) return;
          notifyStateChange("paused", lifecycleGeneration);
        }
      },
    }));

    const updateCurrentTrack = (id: string) => {
      fadeControllerRef.current?.controller.cancelActiveFade();
      fadeControllerRef.current = null;
      cancelCrossfade();
      setIsTransitioning(false);
      currentAudio()?.pause();
      nextAudio()?.pause();
      setQueueIds((ids) => dedupe([id, ...ids.filter((item) => item !== id)]));
      setCurrentStartSeconds(0);
      setPlayedSeconds(0);
      notifyStateChange("paused");
    };
    const updateNextTrack = (id: string) => {
      fadeControllerRef.current?.controller.cancelActiveFade();
      fadeControllerRef.current = null;
      cancelCrossfade();
      setIsTransitioning(false);
      nextAudio()?.pause();
      setQueueIds((ids) => {
        const current = ids[0];
        return dedupe([...(current === undefined ? [] : [current]), id, ...ids.slice(1)]);
      });
      setNextStartSeconds(0);
    };

    return (
      <section className="local-dj-player" aria-label="Local audio DJ player">
        <div className="dj-library-heading">
          <div>
            <p className="eyebrow">Local audio · two-deck mode</p>
            <h2>Waveform DJ player</h2>
          </div>
          <label className={`audio-upload${isTransitioning ? " is-disabled" : ""}`}>
            <span>{uploading ? "Analyzing…" : "Upload audio"}</span>
            <input
              type="file"
              accept="audio/*,.mp3,.m4a,.wav,.flac,.aac,.ogg"
              multiple
              disabled={uploading || isTransitioning}
              onChange={(event) => {
                const files = [...(event.target.files ?? [])];
                if (files.length === 0) return;
                const lifecycleGeneration = lifecycleGenerationRef.current;
                if (!isCurrentLifecycle(lifecycleGeneration)) return;
                const uploadGeneration = ++uploadGenerationRef.current;
                libraryActivityGenerationRef.current += 1;
                const isCurrentUpload = () =>
                  isCurrentLifecycle(lifecycleGeneration) &&
                  uploadGeneration === uploadGenerationRef.current;
                setUploading(true);
                setError(null);
                void uploadSequentially(files, uploadLocalMusicTrack, (uploaded) => {
                  if (!isCurrentUpload()) return;
                  setError(null);
                  uploadedTrackIdsRef.current.add(uploaded.id);
                  setTracks((existing) => mergeByStableId(existing, [uploaded]));
                  setQueueIds((ids) => dedupe([...ids, uploaded.id]));
                  notifyStateChange("paused", lifecycleGeneration);
                })
                  .then(() => {
                    if (isCurrentUpload()) notifyStateChange("paused", lifecycleGeneration);
                  })
                  .catch(() => {
                    if (isCurrentUpload()) setError("Upload or waveform analysis failed.");
                  })
                  .finally(() => {
                    if (isCurrentUpload()) setUploading(false);
                  });
              }}
            />
          </label>
        </div>
        {error === null ? null : <p className="queue-error">{error}</p>}
        {tracks.length === 0 && error === null ? (
          <p className="muted">
            Upload two or more audio files to create the first crossfade queue.
          </p>
        ) : null}

        <div className="dj-decks">
          <article className="dj-deck is-current">
            <div className="dj-deck-heading">
              <div>
                <span>Deck A · on air</span>
                <h3>Current · {currentTrack?.title ?? "Choose a track"}</h3>
              </div>
              <select
                aria-label="Current track"
                value={currentTrack?.id ?? ""}
                disabled={isTransitioning}
                onChange={(event) => updateCurrentTrack(event.target.value)}
              >
                <option value="">Choose current track</option>
                {tracks.map((track) => (
                  <option key={track.id} value={track.id}>
                    {track.title}
                  </option>
                ))}
              </select>
            </div>
            <WaveformScrubber
              label="Current track start position"
              waveform={currentTrack?.waveform ?? []}
              durationSeconds={currentTrack?.durationSeconds ?? 0}
              value={currentStartSeconds}
              playedSeconds={playedSeconds}
              disabled={isTransitioning}
              onChange={(seconds) => {
                setCurrentStartSeconds(seconds);
                setPlayedSeconds(seconds);
                const audio = currentAudio();
                if (audio !== null) audio.currentTime = seconds;
              }}
            />
          </article>

          <article className="dj-deck is-next">
            <div className="dj-deck-heading">
              <div>
                <span>Deck B · queued</span>
                <h3>Next · {nextTrack?.title ?? "Choose a track"}</h3>
              </div>
              <select
                aria-label="Next track"
                value={nextTrack?.id ?? ""}
                disabled={isTransitioning}
                onChange={(event) => updateNextTrack(event.target.value)}
              >
                <option value="">Choose next track</option>
                {tracks
                  .filter(({ id }) => id !== currentTrack?.id)
                  .map((track) => (
                    <option key={track.id} value={track.id}>
                      {track.title}
                    </option>
                  ))}
              </select>
            </div>
            <WaveformScrubber
              label="Next track start position"
              waveform={nextTrack?.waveform ?? []}
              durationSeconds={nextTrack?.durationSeconds ?? 0}
              value={nextStartSeconds}
              onChange={setNextStartSeconds}
              disabled={isTransitioning}
            />
          </article>
        </div>

        <div className="crossfade-controls">
          <label>
            <span>Crossfade</span>
            <select
              aria-label="Crossfade duration"
              value={crossfadeSeconds}
              disabled={isTransitioning}
              onChange={(event) => setCrossfadeSeconds(Number(event.target.value))}
            >
              {[3, 5, 8, 12].map((seconds) => (
                <option key={seconds} value={seconds}>
                  {seconds} seconds
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="primary-action"
            disabled={currentTrack === null || nextTrack === null || isTransitioning}
            aria-label={`Crossfade to ${nextTrack?.title ?? "next track"}`}
            onClick={() => void crossfade()}
          >
            Crossfade now
          </button>
        </div>

        <div className="dj-queue">
          <strong>Up next</strong>
          <ol>
            {queueIds.slice(1).map((id) => (
              <li key={id}>{trackById.get(id)?.title ?? id}</li>
            ))}
          </ol>
        </div>

        <audio
          ref={deckARef}
          src={deckATrack?.audioUrl}
          preload="auto"
          onPlay={() => {
            if (activeDeckRef.current === "a") notifyStateChange("playing");
          }}
          onPause={() => {
            if (activeDeckRef.current === "a" && !transitioningRef.current)
              notifyStateChange("paused");
          }}
          onTimeUpdate={(event) => {
            if (activeDeckRef.current !== "a") return;
            const audio = event.currentTarget;
            setPlayedSeconds(audio.currentTime);
            if (
              !transitioningRef.current &&
              nextTrack !== null &&
              shouldStartCrossfade({
                durationSeconds: audio.duration,
                currentSeconds: audio.currentTime,
                crossfadeSeconds,
              })
            )
              void crossfade();
          }}
        />
        <audio
          ref={deckBRef}
          src={deckBTrack?.audioUrl}
          preload="auto"
          onPlay={() => {
            if (activeDeckRef.current === "b") notifyStateChange("playing");
          }}
          onPause={() => {
            if (activeDeckRef.current === "b" && !transitioningRef.current)
              notifyStateChange("paused");
          }}
          onTimeUpdate={(event) => {
            if (activeDeckRef.current !== "b") return;
            const audio = event.currentTarget;
            setPlayedSeconds(audio.currentTime);
            if (
              !transitioningRef.current &&
              nextTrack !== null &&
              shouldStartCrossfade({
                durationSeconds: audio.duration,
                currentSeconds: audio.currentTime,
                crossfadeSeconds,
              })
            )
              void crossfade();
          }}
        />
      </section>
    );
  },
);

LocalDJPlayer.displayName = "LocalDJPlayer";
