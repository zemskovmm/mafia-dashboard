import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { YouTubePlaylistPlayer } from "./YouTubePlaylistPlayer.js";
import type { YouTubePlayerHandle } from "./YouTubePlaylistPlayer.js";

const api = vi.hoisted(() => ({ listMusicPlaylistItems: vi.fn() }));

vi.mock(import("../../api/client.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  ...api,
}));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const playlistMethods = () => {
  const getPlaylistIndex = vi.fn(() => 0);
  const getPlaylist = vi.fn<() => readonly string[] | undefined>(() => undefined);
  const applyPlaylist = (...args: Parameters<YT.Player["loadPlaylist"]>) => {
    getPlaylistIndex.mockReturnValue(args[1] ?? 0);
    getPlaylist.mockReturnValue(typeof args[0] === "string" ? undefined : args[0]);
  };
  return {
    cuePlaylist: vi.fn(applyPlaylist),
    loadPlaylist: vi.fn(applyPlaylist),
    getPlaylistIndex,
    getPlaylist,
  };
};

const installQueuePlayer = () => {
  const iframe = document.createElement("iframe");
  const player = {
    playVideo: vi.fn(),
    pauseVideo: vi.fn(),
    setVolume: vi.fn(),
    getVolume: vi.fn(() => 80),
    getIframe: vi.fn(() => iframe),
    ...playlistMethods(),
    getCurrentTime: vi.fn(() => 42),
    getPlayerState: vi.fn(() => 1),
    getVideoData: vi.fn(() => ({ video_id: "a" })),
    playVideoAt: vi.fn(),
    destroy: vi.fn(),
  };
  const target = player as unknown as YT.Player;
  const constructorSpy = vi.fn();
  let events: YT.PlayerOptions["events"];
  class FakePlayer {
    public constructor(_elementId: string, options: YT.PlayerOptions) {
      constructorSpy();
      events = options.events;
      return target;
    }
  }
  window.YT = {
    Player: FakePlayer as unknown as typeof YT.Player,
    PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0, BUFFERING: 3, CUED: 5 },
  };
  return {
    player,
    constructorSpy,
    getEvents: () => events,
    async ready() {
      await vi.waitFor(() => expect(events?.onReady).toBeTypeOf("function"));
      await act(async () => {
        events?.onReady?.({ target });
        player.getPlayerState.mockReturnValue(5);
        events?.onStateChange?.({ target, data: 5 });
      });
    },
    state(data: number, currentState = data) {
      act(() => {
        player.getPlayerState.mockReturnValue(currentState);
        events?.onStateChange?.({ target, data });
      });
    },
  };
};

afterEach(() => {
  Object.defineProperty(window, "YT", { configurable: true, value: undefined, writable: true });
  vi.clearAllMocks();
});

describe("YouTubePlaylistPlayer", () => {
  it("retries a failed shared API load through reload and ignores an unmounted consumer", async () => {
    api.listMusicPlaylistItems.mockResolvedValue([
      { videoId: "video-a", title: "Playlist A", position: 0, thumbnailUrl: null },
    ]);
    const previous = vi.fn();
    const originalCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = previous;
    const selector = 'script[src="https://www.youtube.com/iframe_api"]';
    const onStateChange = vi.fn();
    const abandonedState = vi.fn();
    try {
      const active = render(
        <YouTubePlaylistPlayer playlistId="PL-A" onStateChange={onStateChange} />,
      );
      const abandoned = render(
        <YouTubePlaylistPlayer playlistId="PL-A" onStateChange={abandonedState} />,
      );
      await vi.waitFor(() => expect(document.querySelectorAll(selector)).toHaveLength(1));
      const failedScript = document.querySelector(selector)!;
      abandoned.unmount();
      abandonedState.mockClear();
      await act(async () => {
        fireEvent.error(failedScript);
      });
      expect(onStateChange).toHaveBeenLastCalledWith("error");

      // The real Manage → Reload music player action increments this public prop.
      active.rerender(
        <YouTubePlaylistPlayer playlistId="PL-A" reloadRequest={1} onStateChange={onStateChange} />,
      );
      await vi.waitFor(() => {
        expect(document.querySelectorAll(selector)).toHaveLength(1);
        expect(document.querySelector(selector)).not.toBe(failedScript);
      });
      expect(abandonedState).not.toHaveBeenCalled();
      expect(failedScript.isConnected).toBe(false);
      const player = installQueuePlayer();
      await act(async () => {
        window.onYouTubeIframeAPIReady?.();
      });
      await player.ready();
      expect(onStateChange).toHaveBeenLastCalledWith("paused");
      expect(player.constructorSpy).toHaveBeenCalledOnce();
      expect(previous).toHaveBeenCalledOnce();
      expect(window.onYouTubeIframeAPIReady).toBe(previous);
      const reusable = render(<YouTubePlaylistPlayer playlistId="PL-A" onStateChange={vi.fn()} />);
      await vi.waitFor(() => expect(player.constructorSpy).toHaveBeenCalledTimes(2));
      expect(document.querySelectorAll(selector)).toHaveLength(1);
      reusable.unmount();
      active.unmount();
      expect(player.player.destroy).toHaveBeenCalledTimes(2);
    } finally {
      window.onYouTubeIframeAPIReady = originalCallback;
      document.querySelectorAll(selector).forEach((script) => script.remove());
    }
  });

  it("renders the playlist picker beside the expanded queue heading even with no playlist selected", () => {
    const playlistPicker = (
      <select aria-label="YouTube Music playlist">
        <option>Select playlist</option>
      </select>
    );
    const { rerender } = render(
      <YouTubePlaylistPlayer
        playlistId=""
        playlistPicker={playlistPicker}
        onStateChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole("combobox", { name: "YouTube Music playlist" })).toBeNull();
    rerender(
      <YouTubePlaylistPlayer
        playlistId=""
        playlistPicker={playlistPicker}
        onStateChange={vi.fn()}
        expanded
      />,
    );
    const heading = screen.getByRole("heading", { name: "Session queue" });
    const picker = screen.getByRole("combobox", { name: "YouTube Music playlist" });
    expect(heading.parentElement).toHaveClass("youtube-session-queue-heading");
    expect(picker.parentElement).toBe(heading.parentElement);
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    rerender(
      <YouTubePlaylistPlayer
        playlistId=""
        playlistPicker={playlistPicker}
        onStateChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole("combobox", { name: "YouTube Music playlist" })).toBeNull();
  });

  it.each(["empty", "unavailable"] as const)(
    "keeps the expanded playlist picker available with %s playlist details",
    async (state) => {
      if (state === "empty") api.listMusicPlaylistItems.mockResolvedValue([]);
      else api.listMusicPlaylistItems.mockRejectedValue(new Error("details unavailable"));
      const fake = installQueuePlayer();
      render(
        <YouTubePlaylistPlayer
          playlistId="PL-empty"
          playlistPicker={
            <select aria-label="YouTube Music playlist">
              <option>Choose another playlist</option>
            </select>
          }
          onStateChange={vi.fn()}
          expanded
        />,
      );
      await fake.ready();
      expect(screen.getByRole("combobox", { name: "YouTube Music playlist" })).toBeEnabled();
      expect(screen.getByRole("heading", { name: "Session queue" }).parentElement).toContainElement(
        screen.getByRole("combobox"),
      );
      expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    },
  );

  it("queues Play next without touching active playback or cancelling its fade", async () => {
    api.listMusicPlaylistItems.mockResolvedValue([
      { videoId: "a", title: "A", position: 0, thumbnailUrl: null },
      { videoId: "b", title: "B", position: 1, thumbnailUrl: null },
      { videoId: "c", title: "C", position: 2, thumbnailUrl: null },
    ]);
    const fake = installQueuePlayer();
    const handle = createRef<YouTubePlayerHandle>();
    const onStateChange = vi.fn();
    const onQueueOrderChange = vi.fn();
    render(
      <YouTubePlaylistPlayer
        ref={handle}
        playlistId="PL-next"
        initialStageEntryKeys={["a:0"]}
        onStateChange={onStateChange}
        onQueueOrderChange={onQueueOrderChange}
        expanded
      />,
    );
    await fake.ready();
    fake.state(1);
    fake.player.cuePlaylist.mockClear();
    onStateChange.mockClear();
    vi.useFakeTimers();
    try {
      let fade!: Promise<boolean>;
      await act(async () => {
        fade = handle.current!.fadeIn();
        await Promise.resolve();
      });
      await vi.advanceTimersByTimeAsync(500);
      fake.player.playVideo.mockClear();
      fake.player.setVolume.mockClear();

      fireEvent.click(screen.getByRole("button", { name: "Play C next" }));

      expect(onQueueOrderChange).toHaveBeenLastCalledWith("PL-next", ["a:0", "c:2", "b:1"]);
      expect(fake.player.loadPlaylist).not.toHaveBeenCalled();
      expect(fake.player.cuePlaylist).not.toHaveBeenCalled();
      expect(fake.player.pauseVideo).not.toHaveBeenCalled();
      expect(fake.player.playVideoAt).not.toHaveBeenCalled();
      expect(fake.player.playVideo).not.toHaveBeenCalled();
      expect(fake.player.destroy).not.toHaveBeenCalled();
      expect(fake.constructorSpy).toHaveBeenCalledOnce();
      expect(fake.player.getCurrentTime()).toBe(42);
      expect(fake.player.setVolume).not.toHaveBeenCalled();
      expect(onStateChange).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Play C now" })).toBeEnabled();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(fade).resolves.toBe(true);
      expect(fake.player.setVolume).toHaveBeenLastCalledWith(100);
      act(() => {
        expect(handle.current!.playFirstRegularTrack()).toBe(true);
      });
      expect(fake.player.loadPlaylist).toHaveBeenCalledExactlyOnceWith(["a", "c", "b"], 1, 0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([2, -1, 3])(
    "reconciles native Next on early state %s before video identity changes or the old successor plays",
    async (earlyState) => {
      api.listMusicPlaylistItems.mockResolvedValue([
        { videoId: "a", title: "A", position: 0, thumbnailUrl: null },
        { videoId: "b", title: "B", position: 1, thumbnailUrl: null },
        { videoId: "c", title: "C", position: 2, thumbnailUrl: null },
        { videoId: "d", title: "D", position: 3, thumbnailUrl: null },
      ]);
      const fake = installQueuePlayer();
      const onStateChange = vi.fn();
      render(
        <YouTubePlaylistPlayer playlistId="PL-native" onStateChange={onStateChange} expanded />,
      );
      await fake.ready();
      fake.state(1);
      fireEvent.click(screen.getByRole("button", { name: "Play C next" }));
      fireEvent.click(screen.getByRole("button", { name: "Play D next" }));
      expect(fake.player.loadPlaylist).not.toHaveBeenCalled();

      fake.player.getPlaylistIndex.mockReturnValue(1); // Old provider successor is B.
      fake.state(earlyState);
      expect(fake.player.getVideoData).not.toHaveBeenCalled();
      expect(fake.player.loadPlaylist).toHaveBeenCalledExactlyOnceWith(["a", "d", "c", "b"], 1, 0);
      expect(onStateChange).toHaveBeenLastCalledWith("loading");
      expect(screen.getByRole("button", { name: "Play D now" })).toBeDisabled();
      fake.state(0, 3); // Delayed ENDED while the replacement is buffering.
      expect(fake.player.loadPlaylist).toHaveBeenCalledTimes(1);
      fake.state(1);

      fake.player.getPlaylistIndex.mockReturnValue(2);
      fake.state(3);
      fake.state(1);
      expect(fake.player.loadPlaylist).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole("button", { name: "Play C next" }));
      expect(fake.player.loadPlaylist).toHaveBeenCalledTimes(1);
      fake.state(0);
      expect(fake.player.loadPlaylist).toHaveBeenLastCalledWith(["a", "d", "c", "b"], 3, 0);
    },
  );

  it("tracks rapid native selections while the preceding native track is still buffering", async () => {
    api.listMusicPlaylistItems.mockResolvedValue([
      { videoId: "a", title: "A", position: 0, thumbnailUrl: null },
      { videoId: "b", title: "B", position: 1, thumbnailUrl: null },
      { videoId: "c", title: "C", position: 2, thumbnailUrl: null },
    ]);
    const fake = installQueuePlayer();
    const onQueueOrderChange = vi.fn();
    render(
      <YouTubePlaylistPlayer
        playlistId="PL-rapid"
        onStateChange={vi.fn()}
        onQueueOrderChange={onQueueOrderChange}
        expanded
      />,
    );
    await fake.ready();
    fake.state(1);
    fake.player.getPlaylistIndex.mockReturnValue(1);
    fake.state(3);
    fake.player.getPlaylistIndex.mockReturnValue(2);
    fake.state(3);
    fake.state(1);
    expect(screen.getByRole("button", { name: "Play C now" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Play C next" }));
    expect(onQueueOrderChange).not.toHaveBeenCalled();
    fake.state(0);
    expect(fake.player.loadPlaylist).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "accepts rapid native Next after the replacement starts buffering (stale snapshot first: %s)",
    async (staleFirst) => {
      api.listMusicPlaylistItems.mockResolvedValue(
        ["a", "b", "c", "d"].map((videoId, position) => ({
          videoId,
          title: videoId.toUpperCase(),
          position,
          thumbnailUrl: null,
        })),
      );
      const fake = installQueuePlayer();
      const onQueueOrderChange = vi.fn();
      render(
        <YouTubePlaylistPlayer
          playlistId="PL-replacement-rapid"
          onStateChange={vi.fn()}
          onQueueOrderChange={onQueueOrderChange}
          expanded
        />,
      );
      await fake.ready();
      fake.state(1);
      fireEvent.click(screen.getByRole("button", { name: "Play C next" }));
      fake.player.getPlaylistIndex.mockReturnValue(1);
      fake.state(3);
      expect(fake.player.loadPlaylist).toHaveBeenCalledExactlyOnceWith(["a", "c", "b", "d"], 1, 0);
      if (staleFirst) {
        fake.player.getPlaylist.mockReturnValue(["a", "b", "c", "d"]);
        fake.state(3);
        fake.player.getPlaylistIndex.mockReturnValue(2);
        fake.state(3);
        fake.state(1);
        expect(screen.getByRole("button", { name: "Play B now" })).toBeDisabled();
        fake.player.getPlaylist.mockReturnValue(["a", "c", "b", "d"]);
        fake.player.getPlaylistIndex.mockReturnValue(1);
      }
      fake.state(3); // The replacement has started buffering at its expected index.
      fake.player.getPlaylistIndex.mockReturnValue(2);
      fake.state(3);
      fake.state(1);
      expect(screen.getByRole("button", { name: "Play B now" })).toBeEnabled();
      onQueueOrderChange.mockClear();
      fireEvent.click(screen.getByRole("button", { name: "Play B next" }));
      expect(onQueueOrderChange).not.toHaveBeenCalled();
      fake.state(0);
      expect(fake.player.loadPlaylist).toHaveBeenLastCalledWith(["a", "c", "b", "d"], 3, 0);
    },
  );

  it("ignores old provider indices while a transition replacement settles at its new index", async () => {
    api.listMusicPlaylistItems.mockResolvedValue([
      { videoId: "a", title: "A", position: 0, thumbnailUrl: null },
      { videoId: "b", title: "B", position: 1, thumbnailUrl: null },
      { videoId: "c", title: "C", position: 2, thumbnailUrl: null },
      { videoId: "d", title: "D", position: 3, thumbnailUrl: null },
    ]);
    const fake = installQueuePlayer();
    render(<YouTubePlaylistPlayer playlistId="PL-settle" onStateChange={vi.fn()} expanded />);
    await fake.ready();
    fake.player.getPlaylistIndex.mockReturnValue(2);
    fake.state(1);
    fireEvent.click(screen.getByRole("button", { name: "Play A next" }));
    fake.player.getPlaylistIndex.mockReturnValue(3);
    fake.state(2);
    expect(fake.player.loadPlaylist).toHaveBeenCalledExactlyOnceWith(["b", "c", "a", "d"], 2, 0);
    fake.player.getPlaylistIndex.mockReturnValue(3);
    for (const state of [2, -1, 3, 5, 1, 0]) fake.state(state);
    expect(fake.player.loadPlaylist).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Play A now" })).toBeDisabled();
    fake.player.getPlaylistIndex.mockReturnValue(2);
    fake.state(2);
    expect(screen.getByRole("button", { name: "Play A now" })).toBeEnabled();
    fake.state(1);
    fake.state(0);
    expect(fake.player.loadPlaylist).toHaveBeenLastCalledWith(["b", "c", "a", "d"], 3, 0);
  });

  it("does not double-advance when provider auto-next changes index before ENDED arrives", async () => {
    api.listMusicPlaylistItems.mockResolvedValue([
      { videoId: "a", title: "A", position: 0, thumbnailUrl: null },
      { videoId: "b", title: "B", position: 1, thumbnailUrl: null },
      { videoId: "c", title: "C", position: 2, thumbnailUrl: null },
    ]);
    const fake = installQueuePlayer();
    const onStateChange = vi.fn();
    render(<YouTubePlaylistPlayer playlistId="PL-race" onStateChange={onStateChange} expanded />);
    await fake.ready();
    fake.state(1);
    fake.player.getPlaylistIndex.mockReturnValue(1);
    fake.state(0);
    fake.state(0);
    expect(fake.player.loadPlaylist).not.toHaveBeenCalled();
    fake.state(1);
    fake.state(0, 1);
    expect(fake.player.loadPlaylist).not.toHaveBeenCalled();
    fake.player.getPlaylistIndex.mockReturnValue(2);
    fake.state(3);
    fake.state(1);
    expect(fake.player.loadPlaylist).not.toHaveBeenCalled();
    fake.state(0);
    expect(onStateChange).toHaveBeenLastCalledWith("paused");
    expect(fake.player.loadPlaylist).not.toHaveBeenCalled();
  });

  it.each([
    ["Previous", 2, 1],
    ["direct selection", 0, 3],
  ] as const)(
    "keeps snapshot occurrence identity for native %s after queue edits",
    async (_action, from, selected) => {
      api.listMusicPlaylistItems.mockResolvedValue([
        { videoId: "duplicate", title: "Earlier", position: 0, thumbnailUrl: null },
        { videoId: "middle", title: "Middle", position: 1, thumbnailUrl: null },
        { videoId: "current", title: "Current", position: 2, thumbnailUrl: null },
        { videoId: "duplicate", title: "Later", position: 3, thumbnailUrl: null },
      ]);
      const fake = installQueuePlayer();
      const onQueueOrderChange = vi.fn();
      render(
        <YouTubePlaylistPlayer
          playlistId="PL-selection"
          onStateChange={vi.fn()}
          onQueueOrderChange={onQueueOrderChange}
          expanded
        />,
      );
      await fake.ready();
      fake.player.getPlaylistIndex.mockReturnValue(from);
      fake.state(1);
      fireEvent.click(
        screen.getByRole("button", { name: from === 2 ? "Play Earlier next" : "Play Later next" }),
      );
      const order =
        from === 2
          ? ["middle", "current", "duplicate", "duplicate"]
          : ["duplicate", "duplicate", "middle", "current"];
      const expectedIndex = from === 2 ? 0 : 1;
      fake.player.getPlaylistIndex.mockReturnValue(selected);
      fake.state(3);
      expect(fake.player.loadPlaylist).toHaveBeenCalledExactlyOnceWith(order, expectedIndex, 0);
      fake.state(1);
      onQueueOrderChange.mockClear();
      fireEvent.click(
        screen.getByRole("button", { name: from === 2 ? "Play Middle next" : "Play Later next" }),
      );
      expect(onQueueOrderChange).not.toHaveBeenCalled();
    },
  );

  it("leaves a last-loaded native Next unavailable after Play next but advances naturally", async () => {
    api.listMusicPlaylistItems.mockResolvedValue([
      { videoId: "a", title: "A", position: 0, thumbnailUrl: null },
      { videoId: "b", title: "B", position: 1, thumbnailUrl: null },
    ]);
    const fake = installQueuePlayer();
    render(<YouTubePlaylistPlayer playlistId="PL-last" onStateChange={vi.fn()} expanded />);
    await fake.ready();
    fake.player.getPlaylistIndex.mockReturnValue(1);
    fake.state(3);
    fake.state(1);
    fireEvent.click(screen.getByRole("button", { name: "Play A next" }));
    // There is deliberately no provider update to enable native Next at the last slot.
    expect(fake.player.cuePlaylist).toHaveBeenCalledExactlyOnceWith(["a", "b"], 0, 0);
    expect(fake.player.loadPlaylist).not.toHaveBeenCalled();
    fake.state(0);
    expect(fake.player.loadPlaylist).toHaveBeenCalledExactlyOnceWith(["b", "a"], 1, 0);
    fake.state(0);
    fake.state(1);
    fake.state(0);
    expect(fake.player.loadPlaylist).toHaveBeenCalledTimes(1);
  });

  it("advances through the edited queue once on natural completion and ignores stale ENDED", async () => {
    api.listMusicPlaylistItems.mockResolvedValue([
      { videoId: "a", title: "A", position: 0, thumbnailUrl: null },
      { videoId: "b", title: "B", position: 1, thumbnailUrl: null },
      { videoId: "c", title: "C", position: 2, thumbnailUrl: null },
    ]);
    const fake = installQueuePlayer();
    const onStateChange = vi.fn();
    render(
      <YouTubePlaylistPlayer playlistId="PL-natural" onStateChange={onStateChange} expanded />,
    );
    await fake.ready();
    fake.state(1);
    fireEvent.click(screen.getByRole("button", { name: "Play C next" }));

    fake.state(0);
    expect(fake.player.loadPlaylist).toHaveBeenCalledExactlyOnceWith(["a", "c", "b"], 1, 0);
    expect(fake.player.cuePlaylist).toHaveBeenCalledExactlyOnceWith(["a", "b", "c"], 0, 0);
    expect(onStateChange).toHaveBeenLastCalledWith("loading");
    fake.state(0);
    expect(fake.player.loadPlaylist).toHaveBeenCalledTimes(1);
    fake.state(1, 0); // Delayed old-entry PLAYING must not arm a duplicate ENDED.
    fake.state(0);
    expect(fake.player.loadPlaylist).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Play C now" })).toBeDisabled();

    fake.state(1);
    fake.state(0, 1);
    expect(fake.player.loadPlaylist).toHaveBeenCalledTimes(1);
    fake.state(0);
    expect(fake.player.loadPlaylist).toHaveBeenLastCalledWith(["a", "c", "b"], 2, 0);
    expect(fake.player.loadPlaylist).toHaveBeenCalledTimes(2);
    fake.state(1);
    fake.state(0);
    expect(fake.player.loadPlaylist).toHaveBeenCalledTimes(2);
    expect(onStateChange).toHaveBeenLastCalledWith("paused");
  });

  it.each([
    ["quickFadeOut", 500, "natural"],
    ["slowFadeOut", 3_000, "natural"],
    ["quickFadeOut", 500, "native"],
    ["slowFadeOut", 3_000, "native"],
  ] as const)(
    "resumes after %s (%i ms) pauses a %s transition before PLAYING",
    async (fadeMethod, duration, transition) => {
      api.listMusicPlaylistItems.mockResolvedValue([
        { videoId: "a", title: "A", position: 0, thumbnailUrl: null },
        { videoId: "b", title: "B", position: 1, thumbnailUrl: null },
        ...(transition === "native"
          ? [{ videoId: "c", title: "C", position: 2, thumbnailUrl: null }]
          : []),
      ]);
      const fake = installQueuePlayer();
      const handle = createRef<YouTubePlayerHandle>();
      const onStateChange = vi.fn();
      render(
        <YouTubePlaylistPlayer
          ref={handle}
          playlistId="PL-fade-transition"
          onStateChange={onStateChange}
          expanded
        />,
      );
      await fake.ready();
      fake.state(1);
      vi.useFakeTimers();
      try {
        const fade = handle.current![fadeMethod]();
        await vi.advanceTimersByTimeAsync(100);
        if (transition === "native") {
          fireEvent.click(screen.getByRole("button", { name: "Play C next" }));
          expect(fake.player.loadPlaylist).not.toHaveBeenCalled();
          expect(fake.player.pauseVideo).not.toHaveBeenCalled();
          fake.player.getPlaylistIndex.mockReturnValue(1);
          fake.state(3);
          expect(fake.player.loadPlaylist).toHaveBeenCalledExactlyOnceWith(["a", "c", "b"], 1, 0);
        } else {
          fake.state(0);
          expect(fake.player.loadPlaylist).toHaveBeenCalledExactlyOnceWith(["a", "b"], 1, 0);
        }
        expect(vi.getTimerCount()).toBe(1);
        expect(screen.getByRole("button", { name: "Play B now" })).toBeDisabled();
        if (fadeMethod === "slowFadeOut") {
          fake.state(2, 3); // A delayed old-entry PAUSED while B is still buffering.
          expect(onStateChange).toHaveBeenLastCalledWith("loading");
          expect(screen.getByRole("button", { name: "Play B now" })).toBeDisabled();
        }
        await vi.advanceTimersByTimeAsync(duration - 100);
        await fade;
        expect(fake.player.pauseVideo).toHaveBeenCalledOnce();
        fake.state(2); // B really paused before ever emitting PLAYING.
        expect(screen.getByRole("button", { name: "Play B now" })).toBeEnabled();
        const resume = handle.current!.fadeIn();
        expect(fake.player.playVideo).toHaveBeenCalledOnce();
        fake.state(1);
        await vi.advanceTimersByTimeAsync(2_000);
        await expect(resume).resolves.toBe(true);
        expect(onStateChange).toHaveBeenLastCalledWith("playing");
        expect(fake.player.loadPlaylist).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("keeps duplicate entry identity through repeated Play next edits before the current track and while paused", async () => {
    api.listMusicPlaylistItems.mockResolvedValue([
      { videoId: "duplicate", title: "Earlier duplicate", position: 0, thumbnailUrl: null },
      { videoId: "opening", title: "Opening", position: 1, thumbnailUrl: null },
      { videoId: "duplicate", title: "Later duplicate", position: 2, thumbnailUrl: null },
      { videoId: "last", title: "Last", position: 3, thumbnailUrl: null },
    ]);
    const fake = installQueuePlayer();
    const onStateChange = vi.fn();
    const onQueueOrderChange = vi.fn();
    render(
      <YouTubePlaylistPlayer
        playlistId="PL-duplicates"
        onStateChange={onStateChange}
        onQueueOrderChange={onQueueOrderChange}
        expanded
      />,
    );
    await fake.ready();
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Play Opening now" }));
      await vi.advanceTimersByTimeAsync(2_000);
    } finally {
      vi.useRealTimers();
    }
    expect(fake.player.loadPlaylist).toHaveBeenLastCalledWith(
      ["duplicate", "opening", "duplicate", "last"],
      1,
      0,
    );
    fake.state(1);
    fake.player.cuePlaylist.mockClear();
    fake.player.loadPlaylist.mockClear();
    fake.player.setVolume.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Play Earlier duplicate next" }));
    fireEvent.click(screen.getByRole("button", { name: "Play Last next" }));
    expect(onQueueOrderChange).toHaveBeenLastCalledWith("PL-duplicates", [
      "opening:1",
      "last:3",
      "duplicate:0",
      "duplicate:2",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Play Opening next" }));
    fireEvent.click(screen.getByRole("button", { name: "Play Last next" }));
    expect(onQueueOrderChange).toHaveBeenCalledTimes(2);

    fake.state(2);
    onStateChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Play Later duplicate next" }));
    expect(onQueueOrderChange).toHaveBeenLastCalledWith("PL-duplicates", [
      "opening:1",
      "duplicate:2",
      "last:3",
      "duplicate:0",
    ]);
    expect(fake.player.loadPlaylist).not.toHaveBeenCalled();
    expect(fake.player.cuePlaylist).not.toHaveBeenCalled();
    expect(fake.player.setVolume).not.toHaveBeenCalled();
    expect(fake.player.pauseVideo).not.toHaveBeenCalled();
    expect(fake.player.playVideoAt).not.toHaveBeenCalled();
    expect(fake.player.playVideo).not.toHaveBeenCalled();
    expect(onStateChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Play Later duplicate now" })).toBeEnabled();
    fake.state(0);
    expect(fake.player.loadPlaylist).not.toHaveBeenCalled();

    fake.state(1);
    fake.state(0);
    expect(fake.player.loadPlaylist).toHaveBeenLastCalledWith(
      ["opening", "duplicate", "last", "duplicate"],
      1,
      0,
    );
    fake.state(1);
    fireEvent.click(screen.getByRole("button", { name: "Play Earlier duplicate next" }));
    expect(onQueueOrderChange).toHaveBeenLastCalledWith("PL-duplicates", [
      "opening:1",
      "duplicate:2",
      "duplicate:0",
      "last:3",
    ]);
    fake.state(0);
    expect(fake.player.loadPlaylist).toHaveBeenCalledTimes(2);
    fake.state(1);
    fireEvent.click(screen.getByRole("button", { name: "Play Earlier duplicate next" }));
    expect(onQueueOrderChange).toHaveBeenCalledTimes(4);
    fireEvent.click(screen.getByRole("button", { name: "Play Later duplicate next" }));
    expect(onQueueOrderChange).toHaveBeenLastCalledWith("PL-duplicates", [
      "opening:1",
      "duplicate:0",
      "duplicate:2",
      "last:3",
    ]);
    fake.state(0);
    expect(fake.player.loadPlaylist).toHaveBeenCalledTimes(3);
    fake.state(1);
    fake.state(0);
    expect(fake.player.loadPlaylist).toHaveBeenLastCalledWith(
      ["opening", "duplicate", "duplicate", "last"],
      3,
      0,
    );
    expect(fake.player.loadPlaylist).toHaveBeenCalledTimes(4);
  });

  it("cancels the active fade and resets loaded entry identity on explicit reload after Play next", async () => {
    api.listMusicPlaylistItems.mockResolvedValue([
      { videoId: "a", title: "A", position: 0, thumbnailUrl: null },
      { videoId: "b", title: "B", position: 1, thumbnailUrl: null },
      { videoId: "c", title: "C", position: 2, thumbnailUrl: null },
    ]);
    const fake = installQueuePlayer();
    const handle = createRef<YouTubePlayerHandle>();
    const onStateChange = vi.fn();
    const { rerender } = render(
      <YouTubePlaylistPlayer
        ref={handle}
        playlistId="PL-reload-next"
        onStateChange={onStateChange}
        expanded
      />,
    );
    await fake.ready();
    fake.state(1);
    fireEvent.click(screen.getByRole("button", { name: "Play C next" }));
    const staleEvents = fake.getEvents();
    vi.useFakeTimers();
    try {
      let fade!: Promise<void>;
      await act(async () => {
        fade = handle.current!.slowFadeOut();
        await Promise.resolve();
      });
      expect(vi.getTimerCount()).toBe(1);
      await act(async () => {
        rerender(
          <YouTubePlaylistPlayer
            ref={handle}
            playlistId="PL-reload-next"
            reloadRequest={1}
            onStateChange={onStateChange}
            expanded
          />,
        );
      });
      expect(fake.constructorSpy).toHaveBeenCalledTimes(2);
      expect(fake.player.destroy).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      await fade;
    } finally {
      vi.useRealTimers();
    }
    onStateChange.mockClear();
    act(() => {
      staleEvents?.onStateChange?.({ target: fake.player as unknown as YT.Player, data: 0 });
      staleEvents?.onReady?.({ target: fake.player as unknown as YT.Player });
    });
    expect(onStateChange).not.toHaveBeenCalled();
    expect(fake.player.loadPlaylist).not.toHaveBeenCalled();
    await fake.ready();
    expect(fake.player.cuePlaylist).toHaveBeenLastCalledWith(["a", "c", "b"], 0, 0);
    fake.state(1);
    fake.state(0);
    expect(fake.player.loadPlaylist).toHaveBeenCalledExactlyOnceWith(["a", "c", "b"], 1, 0);
  });

  it("cues and presents the supplied playlist order before enabling playback", async () => {
    const user = userEvent.setup();
    api.listMusicPlaylistItems.mockResolvedValue([
      { videoId: "video-1", title: "Opening", position: 0, thumbnailUrl: null },
      { videoId: "video-2", title: "Middle", position: 1, thumbnailUrl: null },
      { videoId: "video-3", title: "Finale", position: 2, thumbnailUrl: null },
    ]);
    const iframe = document.createElement("iframe");
    iframe.setAttribute(
      "allow",
      "accelerometer; autoplay; encrypted-media; picture-in-picture; fullscreen",
    );
    const player = {
      playVideo: vi.fn(),
      pauseVideo: vi.fn(),
      setVolume: vi.fn(),
      getVolume: vi.fn(() => 65),
      getIframe: vi.fn(() => iframe),
      ...playlistMethods(),
      getCurrentTime: vi.fn(() => 42),
      getPlayerState: vi.fn(() => 1),
      playVideoAt: vi.fn(),
      destroy: vi.fn(),
    } as unknown as YT.Player;
    let playerEvents: YT.PlayerOptions["events"];
    class FakePlayer {
      public constructor(_elementId: string, options: YT.PlayerOptions) {
        playerEvents = options.events;
        return player;
      }
    }
    window.YT = {
      Player: FakePlayer as unknown as typeof YT.Player,
      PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0, BUFFERING: 3, CUED: 5 },
    };
    const onStateChange = vi.fn();
    const onQueueOrderChange = vi.fn();
    const onInitialStageEntryKeysChange = vi.fn();
    const onEndgameEntryKeysChange = vi.fn();
    const playerHandle = createRef<YouTubePlayerHandle>();

    render(
      <YouTubePlaylistPlayer
        ref={playerHandle}
        playlistId="PL-selected"
        onStateChange={onStateChange}
        onQueueOrderChange={onQueueOrderChange}
        initialStageEntryKeys={["video-1:0"]}
        onInitialStageEntryKeysChange={onInitialStageEntryKeysChange}
        endgameEntryKeys={["video-3:2"]}
        onEndgameEntryKeysChange={onEndgameEntryKeysChange}
        expanded
      />,
    );
    await vi.waitFor(() => expect(playerEvents?.onReady).toBeTypeOf("function"));
    await act(async () => {
      playerEvents?.onReady?.({ target: player });
    });
    expect(api.listMusicPlaylistItems).toHaveBeenCalledWith("PL-selected");
    expect(player.cuePlaylist).toHaveBeenCalledWith(["video-1", "video-2", "video-3"], 0, 0);
    expect(player.setVolume).not.toHaveBeenCalled();
    expect(player.playVideo).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /set music volume/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /collapse player/i })).toBeNull();
    expect(onStateChange).toHaveBeenLastCalledWith("loading");
    expect(iframe.getAttribute("allow")).toBe(
      "accelerometer; autoplay; encrypted-media; fullscreen",
    );

    await act(async () => {
      playerEvents?.onStateChange?.({ target: player, data: window.YT!.PlayerState.CUED });
    });
    expect(onStateChange).toHaveBeenLastCalledWith("paused");
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("Opening"),
      expect.stringContaining("Middle"),
      expect.stringContaining("Finale"),
    ]);
    const initialRows = screen.getAllByRole("listitem");
    expect(initialRows[0]).toHaveAttribute("data-initial-stage", "true");
    expect(initialRows[0]).toHaveAttribute("data-endgame", "false");
    expect(initialRows[1]).toHaveAttribute("data-initial-stage", "false");
    expect(initialRows[1]).toHaveAttribute("data-endgame", "false");
    expect(initialRows[2]).toHaveAttribute("data-initial-stage", "false");
    expect(initialRows[2]).toHaveAttribute("data-endgame", "true");
    expect(document.querySelector(".queue-item-tags")).toBeNull();

    const middleContent = screen.getByText("Middle").closest<HTMLElement>(".queue-item-content");
    expect(middleContent).not.toBeNull();
    fireEvent.touchStart(middleContent!, {
      touches: [{ clientX: 180, clientY: 40 }],
    });
    fireEvent.touchEnd(middleContent!, {
      changedTouches: [{ clientX: 80, clientY: 42 }],
    });
    fireEvent.click(middleContent!);
    expect(onEndgameEntryKeysChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Mark Middle for Critical endgame" }));
    expect(onEndgameEntryKeysChange).toHaveBeenCalledWith("PL-selected", [
      "video-3:2",
      "video-2:1",
    ]);

    await act(async () => {
      playerEvents?.onStateChange?.({ target: player, data: window.YT!.PlayerState.PLAYING });
    });
    vi.useFakeTimers();
    try {
      let fadePromise!: Promise<boolean>;
      await act(async () => {
        fadePromise = playerHandle.current!.fadeIn();
        await Promise.resolve();
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(player.setVolume).toHaveBeenLastCalledWith(25);

      expect(playerHandle.current?.playFirstRegularTrack()).toBe(true);
      expect(player.setVolume).toHaveBeenLastCalledWith(100);
      expect(player.loadPlaylist).toHaveBeenLastCalledWith(["video-1", "video-2", "video-3"], 1, 0);
      expect(vi.mocked(player.setVolume).mock.invocationCallOrder.at(-1)!).toBeLessThan(
        vi.mocked(player.loadPlaylist).mock.invocationCallOrder.at(-1)!,
      );
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(fadePromise).resolves.toBe(true);
      expect(player.setVolume).toHaveBeenLastCalledWith(100);
    } finally {
      vi.useRealTimers();
    }
    vi.mocked(player.playVideoAt).mockClear();
    await act(async () => {
      playerEvents?.onStateChange?.({ target: player, data: window.YT!.PlayerState.CUED });
    });

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Play Opening now" }));
    await vi.advanceTimersByTimeAsync(2_000);
    vi.useRealTimers();
    await act(async () => {
      playerEvents?.onStateChange?.({ target: player, data: window.YT!.PlayerState.CUED });
    });
    vi.mocked(player.setVolume).mockClear();
    vi.mocked(player.loadPlaylist).mockClear();

    const finaleContent = screen.getByText("Finale").closest<HTMLElement>(".queue-item-content");
    fireEvent.touchStart(finaleContent!, { touches: [{ clientX: 180, clientY: 40 }] });
    fireEvent.touchEnd(finaleContent!, { changedTouches: [{ clientX: 80, clientY: 42 }] });
    expect(screen.getByText("Finale").closest("li")).toHaveClass("is-queue-tags-revealed");
    expect(screen.getByRole("button", { name: "Unmark Finale for Critical endgame" })).toHaveClass(
      "queue-tag-action",
      "is-endgame",
    );
    expect(screen.getByRole("button", { name: "Mark Finale for Role giveaway" })).toHaveClass(
      "queue-tag-action",
      "is-initial",
    );
    fireEvent.click(finaleContent!);
    await user.click(screen.getByRole("button", { name: "Play Finale next" }));
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("Opening"),
      expect.stringContaining("Finale"),
      expect.stringContaining("Middle"),
    ]);
    const movedFinaleRow = screen.getByText("Finale").closest("li");
    expect(movedFinaleRow).not.toHaveClass("is-queue-tags-revealed");
    expect(movedFinaleRow).not.toHaveClass("is-next");
    expect(screen.getByRole("button", { name: "Play Finale next" })).not.toHaveAttribute(
      "aria-pressed",
    );
    expect(player.cuePlaylist).toHaveBeenCalledTimes(1);
    expect(onQueueOrderChange).toHaveBeenLastCalledWith("PL-selected", [
      "video-1:0",
      "video-3:2",
      "video-2:1",
    ]);

    await act(async () => {
      playerEvents?.onStateChange?.({ target: player, data: window.YT!.PlayerState.CUED });
    });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Play Middle now" }));
    expect(player.setVolume).toHaveBeenNthCalledWith(1, 0);
    expect(player.loadPlaylist).toHaveBeenCalledWith(["video-1", "video-3", "video-2"], 2, 0);
    expect(vi.mocked(player.setVolume).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(player.loadPlaylist).mock.invocationCallOrder[0]!,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(player.setVolume).toHaveBeenLastCalledWith(100);
    vi.useRealTimers();
    expect(onQueueOrderChange).toHaveBeenCalledTimes(1);

    await act(async () => {
      playerEvents?.onStateChange?.({ target: player, data: window.YT!.PlayerState.PLAYING });
      playerEvents?.onStateChange?.({ target: player, data: window.YT!.PlayerState.PAUSED });
    });
    vi.mocked(player.setVolume).mockClear();
    vi.mocked(player.playVideo).mockClear();
    vi.useFakeTimers();
    try {
      let fadePromise!: Promise<boolean>;
      await act(async () => {
        fadePromise = playerHandle.current!.fadeIn();
        await Promise.resolve();
      });
      expect(player.setVolume).toHaveBeenNthCalledWith(1, 0);
      expect(player.playVideo).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(fadePromise).resolves.toBe(true);
      expect(player.setVolume).toHaveBeenLastCalledWith(100);
    } finally {
      vi.useRealTimers();
    }

    const queueItems = screen.getAllByRole("listitem");
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => queueItems[1]!),
    });
    const middleDragHandle = screen.getByLabelText("Drag Middle");
    fireEvent.pointerDown(middleDragHandle, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(middleDragHandle, { pointerId: 1, clientX: 10, clientY: 40 });
    fireEvent.pointerUp(middleDragHandle, { pointerId: 1, clientX: 10, clientY: 40 });
    Reflect.deleteProperty(document, "elementFromPoint");
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("Opening"),
      expect.stringContaining("Middle"),
      expect.stringContaining("Finale"),
    ]);
    expect(screen.getByText("Finale").closest("li")).not.toHaveClass("is-next");
    expect(player.cuePlaylist).toHaveBeenLastCalledWith(["video-1", "video-2", "video-3"], 1, 42);
    expect(onQueueOrderChange).toHaveBeenLastCalledWith("PL-selected", [
      "video-1:0",
      "video-2:1",
      "video-3:2",
    ]);
    expect(onQueueOrderChange).toHaveBeenCalledTimes(2);

    await act(async () => {
      playerEvents?.onStateChange?.({ target: player, data: window.YT!.PlayerState.PLAYING });
    });
    vi.mocked(player.loadPlaylist).mockClear();
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(playerHandle.current?.shuffleQueue({ preferEndgame: true })).toBe(true);
    expect(player.cuePlaylist).toHaveBeenLastCalledWith(["video-3", "video-2", "video-1"], 0, 0);
    expect(player.loadPlaylist).not.toHaveBeenCalled();
    expect(onQueueOrderChange).toHaveBeenLastCalledWith("PL-selected", [
      "video-3:2",
      "video-2:1",
      "video-1:0",
    ]);
  });

  it("cues a constrained opening queue before fading its Initial current track in", async () => {
    api.listMusicPlaylistItems.mockResolvedValue([
      { videoId: "initial-a", title: "Initial A", position: 0, thumbnailUrl: null },
      { videoId: "ordinary-a", title: "Ordinary A", position: 1, thumbnailUrl: null },
      { videoId: "endgame", title: "Endgame", position: 2, thumbnailUrl: null },
      { videoId: "initial-b", title: "Initial B", position: 3, thumbnailUrl: null },
      { videoId: "ordinary-b", title: "Ordinary B", position: 4, thumbnailUrl: null },
    ]);
    const player = {
      playVideo: vi.fn(),
      pauseVideo: vi.fn(),
      setVolume: vi.fn(),
      getVolume: vi.fn(() => 65),
      getIframe: vi.fn(() => document.createElement("iframe")),
      ...playlistMethods(),
      getCurrentTime: vi.fn(() => 0),
      playVideoAt: vi.fn(),
      destroy: vi.fn(),
    } as unknown as YT.Player;
    let playerEvents: YT.PlayerOptions["events"];
    class FakePlayer {
      public constructor(_elementId: string, options: YT.PlayerOptions) {
        playerEvents = options.events;
        return player;
      }
    }
    window.YT = {
      Player: FakePlayer as unknown as typeof YT.Player,
      PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0, BUFFERING: 3, CUED: 5 },
    };
    const handle = createRef<YouTubePlayerHandle>();
    const onQueueOrderChange = vi.fn();
    const onStateChange = vi.fn();
    render(
      <YouTubePlaylistPlayer
        ref={handle}
        playlistId="PL-opening"
        onStateChange={onStateChange}
        onQueueOrderChange={onQueueOrderChange}
        initialStageEntryKeys={["initial-a:0", "initial-b:3"]}
        endgameEntryKeys={["endgame:2"]}
        expanded
      />,
    );

    await vi.waitFor(() => expect(playerEvents?.onReady).toBeTypeOf("function"));
    await act(async () => {
      playerEvents?.onReady?.({ target: player });
      playerEvents?.onStateChange?.({ target: player, data: window.YT!.PlayerState.CUED });
    });
    vi.mocked(player.cuePlaylist).mockClear();
    onQueueOrderChange.mockClear();
    vi.mocked(player.playVideo).mockClear();
    vi.mocked(player.setVolume).mockClear();
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    vi.useFakeTimers();
    try {
      let started = false;
      act(() => {
        started = handle.current?.startOpeningQueue() ?? false;
      });
      expect(started).toBe(true);
      random.mockRestore();
      expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
        expect.stringContaining("Initial B"),
        expect.stringContaining("Ordinary B"),
        expect.stringContaining("Endgame"),
        expect.stringContaining("Ordinary A"),
        expect.stringContaining("Initial A"),
      ]);
      expect(onQueueOrderChange).toHaveBeenCalledWith("PL-opening", [
        "initial-b:3",
        "ordinary-b:4",
        "endgame:2",
        "ordinary-a:1",
        "initial-a:0",
      ]);
      expect(player.cuePlaylist).toHaveBeenCalledWith(
        ["initial-b", "ordinary-b", "endgame", "ordinary-a", "initial-a"],
        0,
        0,
      );
      expect(player.playVideo).not.toHaveBeenCalled();
      expect(onStateChange).toHaveBeenLastCalledWith("loading");

      await act(async () => {
        playerEvents?.onStateChange?.({ target: player, data: window.YT!.PlayerState.CUED });
      });
      expect(player.setVolume).toHaveBeenNthCalledWith(1, 0);
      expect(player.playVideo).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(player.setVolume).toHaveBeenLastCalledWith(100);
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("restores remembered queue order by stable entry key", async () => {
    api.listMusicPlaylistItems.mockResolvedValue([
      { videoId: "duplicate", title: "Duplicate first", position: 0, thumbnailUrl: null },
      { videoId: "other", title: "Other", position: 1, thumbnailUrl: null },
      { videoId: "duplicate", title: "Duplicate later", position: 2, thumbnailUrl: null },
    ]);
    const iframe = document.createElement("iframe");
    const player = {
      playVideo: vi.fn(),
      pauseVideo: vi.fn(),
      setVolume: vi.fn(),
      getVolume: vi.fn(() => 80),
      getIframe: vi.fn(() => iframe),
      ...playlistMethods(),
      getCurrentTime: vi.fn(() => 0),
      playVideoAt: vi.fn(),
      destroy: vi.fn(),
    } as unknown as YT.Player;
    let playerEvents: YT.PlayerOptions["events"];
    class FakePlayer {
      public constructor(_elementId: string, options: YT.PlayerOptions) {
        playerEvents = options.events;
        return player;
      }
    }
    window.YT = {
      Player: FakePlayer as unknown as typeof YT.Player,
      PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0, BUFFERING: 3, CUED: 5 },
    };

    render(
      <YouTubePlaylistPlayer
        playlistId="PL-remembered"
        rememberedQueueOrder={["duplicate:2", "other:1", "duplicate:0"]}
        onStateChange={() => undefined}
        expanded
      />,
    );

    await vi.waitFor(() =>
      expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
        expect.stringContaining("Duplicate later"),
        expect.stringContaining("Other"),
        expect.stringContaining("Duplicate first"),
      ]),
    );
    await vi.waitFor(() => expect(playerEvents?.onReady).toBeTypeOf("function"));
    await act(async () => {
      playerEvents?.onReady?.({ target: player });
    });
    expect(player.cuePlaylist).toHaveBeenCalledWith(["duplicate", "other", "duplicate"], 0, 0);
  });

  it("applies a changed remembered order for the current playlist from provider order", async () => {
    api.listMusicPlaylistItems.mockResolvedValue([
      { videoId: "video-a", title: "A", position: 0, thumbnailUrl: null },
      { videoId: "video-b", title: "B", position: 1, thumbnailUrl: null },
      { videoId: "video-c", title: "C", position: 2, thumbnailUrl: null },
    ]);
    const iframe = document.createElement("iframe");
    const player = {
      playVideo: vi.fn(),
      pauseVideo: vi.fn(),
      setVolume: vi.fn(),
      getVolume: vi.fn(() => 80),
      getIframe: vi.fn(() => iframe),
      ...playlistMethods(),
      getCurrentTime: vi.fn(() => 7),
      playVideoAt: vi.fn(),
      destroy: vi.fn(),
    } as unknown as YT.Player;
    const constructorSpy = vi.fn();
    let playerEvents: YT.PlayerOptions["events"];
    class FakePlayer {
      public constructor(_elementId: string, options: YT.PlayerOptions) {
        constructorSpy();
        playerEvents = options.events;
        return player;
      }
    }
    window.YT = {
      Player: FakePlayer as unknown as typeof YT.Player,
      PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0, BUFFERING: 3, CUED: 5 },
    };
    const onStateChange = vi.fn();
    const { rerender } = render(
      <YouTubePlaylistPlayer
        playlistId="PL-remembered"
        rememberedQueueOrder={[]}
        onStateChange={onStateChange}
        expanded
      />,
    );
    await vi.waitFor(() => expect(constructorSpy).toHaveBeenCalledTimes(1));
    await act(async () => {
      playerEvents?.onReady?.({ target: player });
      playerEvents?.onStateChange?.({ target: player, data: window.YT!.PlayerState.CUED });
    });

    rerender(
      <YouTubePlaylistPlayer
        playlistId="PL-remembered"
        rememberedQueueOrder={["video-c:2", "video-a:0", "video-b:1"]}
        onStateChange={onStateChange}
        expanded
      />,
    );

    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("C"),
      expect.stringContaining("A"),
      expect.stringContaining("B"),
    ]);
    expect(player.cuePlaylist).toHaveBeenLastCalledWith(["video-c", "video-a", "video-b"], 1, 7);
    expect(player.cuePlaylist).toHaveBeenCalledTimes(2);
    expect(api.listMusicPlaylistItems).toHaveBeenCalledTimes(1);
    expect(constructorSpy).toHaveBeenCalledTimes(1);
    expect(player.destroy).not.toHaveBeenCalled();
  });

  it("uses the refreshed occurrence index and stops at the logical end after a playing reorder", async () => {
    api.listMusicPlaylistItems.mockResolvedValue([
      { videoId: "a", title: "A", position: 0, thumbnailUrl: null },
      { videoId: "b", title: "B", position: 1, thumbnailUrl: null },
      { videoId: "c", title: "C", position: 2, thumbnailUrl: null },
    ]);
    const fake = installQueuePlayer();
    const onStateChange = vi.fn();
    const { rerender } = render(
      <YouTubePlaylistPlayer playlistId="PL-reorder-end" onStateChange={onStateChange} expanded />,
    );
    await fake.ready();
    fake.player.getPlaylistIndex.mockReturnValue(1);
    fake.state(1);
    rerender(
      <YouTubePlaylistPlayer
        playlistId="PL-reorder-end"
        rememberedQueueOrder={["b:1", "c:2", "a:0"]}
        onStateChange={onStateChange}
        expanded
      />,
    );
    expect(fake.player.loadPlaylist).toHaveBeenCalledExactlyOnceWith(["b", "c", "a"], 0, 42);
    fake.state(1);
    fake.player.getPlaylistIndex.mockReturnValue(1); // Provider already moved B -> C.
    fake.state(0);
    fake.state(0);
    expect(fake.player.loadPlaylist).toHaveBeenCalledTimes(1);
    fake.state(1);
    fake.state(0);
    expect(fake.player.loadPlaylist).toHaveBeenLastCalledWith(["b", "c", "a"], 2, 0);
    fake.state(1);
    fake.state(0);
    expect(fake.player.loadPlaylist).toHaveBeenCalledTimes(2);
    expect(onStateChange).toHaveBeenLastCalledWith("paused");
  });

  it("does not re-cue when the parent echoes the just-emitted queue order", async () => {
    const user = userEvent.setup();
    api.listMusicPlaylistItems.mockResolvedValue([
      { videoId: "video-a", title: "A", position: 0, thumbnailUrl: null },
      { videoId: "video-b", title: "B", position: 1, thumbnailUrl: null },
      { videoId: "video-c", title: "C", position: 2, thumbnailUrl: null },
    ]);
    const iframe = document.createElement("iframe");
    const player = {
      playVideo: vi.fn(),
      pauseVideo: vi.fn(),
      setVolume: vi.fn(),
      getVolume: vi.fn(() => 80),
      getIframe: vi.fn(() => iframe),
      ...playlistMethods(),
      getCurrentTime: vi.fn(() => 5),
      playVideoAt: vi.fn(),
      destroy: vi.fn(),
    } as unknown as YT.Player;
    let playerEvents: YT.PlayerOptions["events"];
    class FakePlayer {
      public constructor(_elementId: string, options: YT.PlayerOptions) {
        playerEvents = options.events;
        return player;
      }
    }
    window.YT = {
      Player: FakePlayer as unknown as typeof YT.Player,
      PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0, BUFFERING: 3, CUED: 5 },
    };
    const onQueueOrderChange = vi.fn();
    const { rerender } = render(
      <YouTubePlaylistPlayer
        playlistId="PL-echo"
        rememberedQueueOrder={[]}
        onQueueOrderChange={onQueueOrderChange}
        onStateChange={() => undefined}
        expanded
      />,
    );
    await vi.waitFor(() => expect(playerEvents?.onReady).toBeTypeOf("function"));
    await act(async () => {
      playerEvents?.onReady?.({ target: player });
      playerEvents?.onStateChange?.({ target: player, data: window.YT!.PlayerState.CUED });
    });

    await user.click(screen.getByRole("button", { name: "Play C next" }));
    const emittedOrder = ["video-a:0", "video-c:2", "video-b:1"];
    expect(onQueueOrderChange).toHaveBeenLastCalledWith("PL-echo", emittedOrder);
    expect(player.cuePlaylist).toHaveBeenCalledTimes(1);

    rerender(
      <YouTubePlaylistPlayer
        playlistId="PL-echo"
        rememberedQueueOrder={emittedOrder}
        onQueueOrderChange={onQueueOrderChange}
        onStateChange={() => undefined}
        expanded
      />,
    );

    expect(player.cuePlaylist).toHaveBeenCalledTimes(1);
    expect(api.listMusicPlaylistItems).toHaveBeenCalledTimes(1);
    expect(player.destroy).not.toHaveBeenCalled();
  });

  it("hot-swaps a paused playlist without reconstructing the iframe player", async () => {
    const playlistA =
      deferred<
        readonly [{ videoId: string; title: string; position: number; thumbnailUrl: null }]
      >();
    const playlistB =
      deferred<
        readonly [{ videoId: string; title: string; position: number; thumbnailUrl: null }]
      >();
    api.listMusicPlaylistItems.mockImplementation((playlistId: string) =>
      playlistId === "PL-A" ? playlistA.promise : playlistB.promise,
    );
    const iframe = document.createElement("iframe");
    const player = {
      playVideo: vi.fn(),
      pauseVideo: vi.fn(),
      setVolume: vi.fn(),
      getVolume: vi.fn(() => 80),
      getIframe: vi.fn(() => iframe),
      ...playlistMethods(),
      getCurrentTime: vi.fn(() => 9),
      playVideoAt: vi.fn(),
      destroy: vi.fn(),
    } as unknown as YT.Player;
    const constructorSpy = vi.fn();
    let playerEvents: YT.PlayerOptions["events"];
    class FakePlayer {
      public constructor(_elementId: string, options: YT.PlayerOptions) {
        constructorSpy();
        playerEvents = options.events;
        return player;
      }
    }
    window.YT = {
      Player: FakePlayer as unknown as typeof YT.Player,
      PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0, BUFFERING: 3, CUED: 5 },
    };
    const onStateChange = vi.fn();
    const { rerender } = render(
      <YouTubePlaylistPlayer playlistId="PL-A" onStateChange={onStateChange} expanded />,
    );

    await act(async () => {
      playlistA.resolve([
        { videoId: "video-a", title: "Playlist A", position: 0, thumbnailUrl: null },
      ]);
    });
    await vi.waitFor(() => expect(constructorSpy).toHaveBeenCalledTimes(1));
    await act(async () => {
      playerEvents?.onReady?.({ target: player });
      playerEvents?.onStateChange?.({ target: player, data: window.YT!.PlayerState.CUED });
    });
    expect(player.cuePlaylist).toHaveBeenLastCalledWith(["video-a"], 0, 0);

    rerender(<YouTubePlaylistPlayer playlistId="PL-B" onStateChange={onStateChange} expanded />);
    expect(player.destroy).not.toHaveBeenCalled();
    await act(async () => {
      playlistB.resolve([
        { videoId: "video-b", title: "Playlist B", position: 0, thumbnailUrl: null },
      ]);
    });

    await vi.waitFor(() => expect(player.cuePlaylist).toHaveBeenLastCalledWith(["video-b"], 0, 0));
    expect(constructorSpy).toHaveBeenCalledTimes(1);
    expect(player.destroy).not.toHaveBeenCalled();
    expect(player.loadPlaylist).not.toHaveBeenCalled();
    expect(player.playVideo).not.toHaveBeenCalled();
    expect(screen.getByText("Playlist B")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play Playlist B now" })).toBeDisabled();
    expect(onStateChange).toHaveBeenLastCalledWith("loading");
    await act(async () => {
      playerEvents?.onStateChange?.({ target: player, data: window.YT!.PlayerState.CUED });
    });
    expect(screen.getByRole("button", { name: "Play Playlist B now" })).toBeEnabled();
    expect(onStateChange).toHaveBeenLastCalledWith("paused");
  });

  it("loads a hot-swapped queue while playing and cancels the active fade", async () => {
    const user = userEvent.setup();
    const playlistA =
      deferred<
        readonly [
          { videoId: string; title: string; position: number; thumbnailUrl: null },
          { videoId: string; title: string; position: number; thumbnailUrl: null },
          { videoId: string; title: string; position: number; thumbnailUrl: null },
        ]
      >();
    const playlistB =
      deferred<
        readonly [{ videoId: string; title: string; position: number; thumbnailUrl: null }]
      >();
    api.listMusicPlaylistItems.mockImplementation((playlistId: string) =>
      playlistId === "PL-A" ? playlistA.promise : playlistB.promise,
    );
    const iframe = document.createElement("iframe");
    const player = {
      playVideo: vi.fn(),
      pauseVideo: vi.fn(),
      setVolume: vi.fn(),
      getVolume: vi.fn(() => 80),
      getIframe: vi.fn(() => iframe),
      ...playlistMethods(),
      getCurrentTime: vi.fn(() => 4),
      playVideoAt: vi.fn(),
      destroy: vi.fn(),
    } as unknown as YT.Player;
    const constructorSpy = vi.fn();
    let playerEvents: YT.PlayerOptions["events"];
    class FakePlayer {
      public constructor(_elementId: string, options: YT.PlayerOptions) {
        constructorSpy();
        playerEvents = options.events;
        return player;
      }
    }
    window.YT = {
      Player: FakePlayer as unknown as typeof YT.Player,
      PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0, BUFFERING: 3, CUED: 5 },
    };
    const playerHandle = createRef<YouTubePlayerHandle>();
    const onStateChange = vi.fn();
    const { rerender } = render(
      <YouTubePlaylistPlayer
        ref={playerHandle}
        playlistId="PL-A"
        onStateChange={onStateChange}
        expanded
      />,
    );
    await act(async () => {
      playlistA.resolve([
        { videoId: "video-a1", title: "A one", position: 0, thumbnailUrl: null },
        { videoId: "video-a2", title: "A two", position: 1, thumbnailUrl: null },
        { videoId: "video-a3", title: "A three", position: 2, thumbnailUrl: null },
      ]);
    });
    await vi.waitFor(() => expect(constructorSpy).toHaveBeenCalledTimes(1));
    await act(async () => {
      playerEvents?.onReady?.({ target: player });
      playerEvents?.onStateChange?.({ target: player, data: window.YT!.PlayerState.CUED });
    });
    await user.click(screen.getByRole("button", { name: "Play A three next" }));
    expect(screen.getByRole("button", { name: "Play A three next" })).not.toHaveAttribute(
      "aria-pressed",
    );
    expect(screen.getByText("A three").closest("li")).not.toHaveClass("is-next");
    await act(async () => {
      playerEvents?.onStateChange?.({ target: player, data: window.YT!.PlayerState.PLAYING });
    });

    vi.useFakeTimers();
    try {
      let fadePromise!: Promise<void>;
      await act(async () => {
        fadePromise = playerHandle.current!.slowFadeOut();
        await Promise.resolve();
      });
      expect(vi.getTimerCount()).toBe(1);
      rerender(
        <YouTubePlaylistPlayer
          ref={playerHandle}
          playlistId="PL-B"
          onStateChange={onStateChange}
          expanded
        />,
      );
      expect(vi.getTimerCount()).toBe(0);
      await fadePromise;
    } finally {
      vi.useRealTimers();
    }

    await act(async () => {
      playlistB.resolve([
        { videoId: "video-b", title: "Playlist B", position: 0, thumbnailUrl: null },
      ]);
    });
    await vi.waitFor(() => expect(player.loadPlaylist).toHaveBeenLastCalledWith(["video-b"], 0, 0));
    expect(player.cuePlaylist).not.toHaveBeenLastCalledWith(["video-b"], 0, 0);
    expect(screen.getByRole("button", { name: "Play Playlist B next" })).not.toHaveAttribute(
      "aria-pressed",
    );
    expect(constructorSpy).toHaveBeenCalledTimes(1);
    expect(player.destroy).not.toHaveBeenCalled();
    expect(player.playVideo).not.toHaveBeenCalled();
  });

  it("pauses playback and resets transient state when the playlist is cleared", async () => {
    api.listMusicPlaylistItems.mockResolvedValue([
      { videoId: "video-a", title: "Playlist A", position: 0, thumbnailUrl: null },
    ]);
    const iframe = document.createElement("iframe");
    const player = {
      playVideo: vi.fn(),
      pauseVideo: vi.fn(),
      setVolume: vi.fn(),
      getVolume: vi.fn(() => 80),
      getIframe: vi.fn(() => iframe),
      ...playlistMethods(),
      getCurrentTime: vi.fn(() => 4),
      playVideoAt: vi.fn(),
      destroy: vi.fn(),
    } as unknown as YT.Player;
    const constructorSpy = vi.fn();
    let playerEvents: YT.PlayerOptions["events"];
    class FakePlayer {
      public constructor(_elementId: string, options: YT.PlayerOptions) {
        constructorSpy();
        playerEvents = options.events;
        return player;
      }
    }
    window.YT = {
      Player: FakePlayer as unknown as typeof YT.Player,
      PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0, BUFFERING: 3, CUED: 5 },
    };
    const playerHandle = createRef<YouTubePlayerHandle>();
    const onStateChange = vi.fn();
    const { rerender } = render(
      <YouTubePlaylistPlayer
        ref={playerHandle}
        playlistId="PL-A"
        onStateChange={onStateChange}
        expanded
      />,
    );
    await vi.waitFor(() => expect(constructorSpy).toHaveBeenCalledTimes(1));
    await act(async () => {
      playerEvents?.onReady?.({ target: player });
      playerEvents?.onStateChange?.({ target: player, data: window.YT!.PlayerState.CUED });
      playerEvents?.onStateChange?.({ target: player, data: window.YT!.PlayerState.PLAYING });
    });

    vi.useFakeTimers();
    try {
      let fadePromise!: Promise<void>;
      await act(async () => {
        fadePromise = playerHandle.current!.slowFadeOut();
        await Promise.resolve();
      });
      expect(vi.getTimerCount()).toBe(1);

      rerender(
        <YouTubePlaylistPlayer
          ref={playerHandle}
          playlistId=""
          onStateChange={onStateChange}
          expanded
        />,
      );

      expect(vi.getTimerCount()).toBe(0);
      await fadePromise;
      expect(player.pauseVideo).toHaveBeenCalledTimes(1);
      expect(player.destroy).not.toHaveBeenCalled();
      expect(onStateChange).toHaveBeenLastCalledWith("idle");
      await act(async () => {
        playerEvents?.onReady?.({ target: player });
        playerEvents?.onStateChange?.({ target: player, data: window.YT!.PlayerState.PAUSED });
        playerEvents?.onStateChange?.({ target: player, data: window.YT!.PlayerState.CUED });
        playerEvents?.onError?.();
      });
      expect(onStateChange).toHaveBeenLastCalledWith("idle");
      await expect(playerHandle.current!.fadeIn()).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconstructs the iframe player only for an explicit reload request", async () => {
    const playlist =
      deferred<
        readonly [{ videoId: string; title: string; position: number; thumbnailUrl: null }]
      >();
    api.listMusicPlaylistItems.mockReturnValue(playlist.promise);
    const iframe = document.createElement("iframe");
    const player = {
      playVideo: vi.fn(),
      pauseVideo: vi.fn(),
      setVolume: vi.fn(),
      getVolume: vi.fn(() => 80),
      getIframe: vi.fn(() => iframe),
      ...playlistMethods(),
      getCurrentTime: vi.fn(() => 0),
      playVideoAt: vi.fn(),
      destroy: vi.fn(),
    } as unknown as YT.Player;
    const constructorSpy = vi.fn();
    let playerEvents: YT.PlayerOptions["events"];
    class FakePlayer {
      public constructor(_elementId: string, options: YT.PlayerOptions) {
        constructorSpy();
        playerEvents = options.events;
        return player;
      }
    }
    window.YT = {
      Player: FakePlayer as unknown as typeof YT.Player,
      PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0, BUFFERING: 3, CUED: 5 },
    };
    const onStateChange = vi.fn();
    const { rerender } = render(
      <YouTubePlaylistPlayer
        playlistId="PL-reload"
        reloadRequest={0}
        onStateChange={onStateChange}
      />,
    );
    await act(async () => {
      playlist.resolve([
        { videoId: "video-a", title: "Playlist A", position: 0, thumbnailUrl: null },
      ]);
    });
    await vi.waitFor(() => expect(constructorSpy).toHaveBeenCalledTimes(1));
    await act(async () => {
      playerEvents?.onReady?.({ target: player });
    });
    const stalePlayerEvents = playerEvents;
    const setVolumeCallsBeforeReload = vi.mocked(player.setVolume).mock.calls.length;

    rerender(
      <YouTubePlaylistPlayer
        playlistId="PL-reload"
        reloadRequest={1}
        onStateChange={onStateChange}
      />,
    );

    await vi.waitFor(() => expect(constructorSpy).toHaveBeenCalledTimes(2));
    expect(player.destroy).toHaveBeenCalledTimes(1);
    expect(api.listMusicPlaylistItems).toHaveBeenCalledTimes(1);
    onStateChange.mockClear();
    await act(async () => {
      stalePlayerEvents?.onReady?.({ target: player });
      stalePlayerEvents?.onStateChange?.({ target: player, data: window.YT!.PlayerState.CUED });
      stalePlayerEvents?.onError?.();
    });
    expect(player.setVolume).toHaveBeenCalledTimes(setVolumeCallsBeforeReload);
    expect(onStateChange).not.toHaveBeenCalled();
  });

  it("keys metadata requests by playlist ID and ignores stale responses", async () => {
    const playlistA =
      deferred<
        readonly [{ videoId: string; title: string; position: number; thumbnailUrl: null }]
      >();
    const playlistB =
      deferred<
        readonly [{ videoId: string; title: string; position: number; thumbnailUrl: null }]
      >();
    api.listMusicPlaylistItems.mockImplementation((playlistId: string) =>
      playlistId === "PL-A" ? playlistA.promise : playlistB.promise,
    );
    const iframe = document.createElement("iframe");
    const player = {
      playVideo: vi.fn(),
      pauseVideo: vi.fn(),
      setVolume: vi.fn(),
      getVolume: vi.fn(() => 80),
      getIframe: vi.fn(() => iframe),
      ...playlistMethods(),
      getCurrentTime: vi.fn(() => 0),
      playVideoAt: vi.fn(),
      destroy: vi.fn(),
    } as unknown as YT.Player;
    const constructorSpy = vi.fn();
    let playerEvents: YT.PlayerOptions["events"];
    class FakePlayer {
      public constructor(_elementId: string, options: YT.PlayerOptions) {
        constructorSpy();
        playerEvents = options.events;
        return player;
      }
    }
    window.YT = {
      Player: FakePlayer as unknown as typeof YT.Player,
      PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0, BUFFERING: 3, CUED: 5 },
    };
    const { rerender } = render(
      <YouTubePlaylistPlayer playlistId="PL-A" onStateChange={() => undefined} expanded />,
    );

    rerender(<YouTubePlaylistPlayer playlistId="PL-A" onStateChange={() => undefined} expanded />);
    expect(api.listMusicPlaylistItems).toHaveBeenCalledTimes(1);
    rerender(<YouTubePlaylistPlayer playlistId="PL-B" onStateChange={() => undefined} expanded />);
    await act(async () => {
      playlistB.resolve([
        { videoId: "video-b", title: "Latest playlist", position: 0, thumbnailUrl: null },
      ]);
    });
    await vi.waitFor(() => expect(constructorSpy).toHaveBeenCalledTimes(1));
    await act(async () => {
      playerEvents?.onReady?.({ target: player });
    });
    expect(player.cuePlaylist).toHaveBeenLastCalledWith(["video-b"], 0, 0);

    await act(async () => {
      playlistA.resolve([
        { videoId: "video-a", title: "Stale playlist", position: 0, thumbnailUrl: null },
      ]);
    });
    expect(screen.getByText("Latest playlist")).toBeInTheDocument();
    expect(screen.queryByText("Stale playlist")).not.toBeInTheDocument();
    expect(player.cuePlaylist).toHaveBeenCalledTimes(1);
    expect(constructorSpy).toHaveBeenCalledTimes(1);
  });

  it("hot-swaps to the playlist fallback when metadata fails", async () => {
    const playlistA =
      deferred<
        readonly [{ videoId: string; title: string; position: number; thumbnailUrl: null }]
      >();
    const playlistB = deferred<never>();
    api.listMusicPlaylistItems.mockImplementation((playlistId: string) =>
      playlistId === "PL-A" ? playlistA.promise : playlistB.promise,
    );
    const iframe = document.createElement("iframe");
    const player = {
      playVideo: vi.fn(),
      pauseVideo: vi.fn(),
      setVolume: vi.fn(),
      getVolume: vi.fn(() => 80),
      getIframe: vi.fn(() => iframe),
      ...playlistMethods(),
      getCurrentTime: vi.fn(() => 0),
      playVideoAt: vi.fn(),
      destroy: vi.fn(),
    } as unknown as YT.Player;
    const constructorSpy = vi.fn();
    let playerEvents: YT.PlayerOptions["events"];
    class FakePlayer {
      public constructor(_elementId: string, options: YT.PlayerOptions) {
        constructorSpy();
        playerEvents = options.events;
        return player;
      }
    }
    window.YT = {
      Player: FakePlayer as unknown as typeof YT.Player,
      PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0, BUFFERING: 3, CUED: 5 },
    };
    const onStateChange = vi.fn();
    const { rerender } = render(
      <YouTubePlaylistPlayer playlistId="PL-A" onStateChange={onStateChange} expanded />,
    );
    await act(async () => {
      playlistA.resolve([
        { videoId: "video-a", title: "Playlist A", position: 0, thumbnailUrl: null },
      ]);
    });
    await vi.waitFor(() => expect(constructorSpy).toHaveBeenCalledTimes(1));
    await act(async () => {
      playerEvents?.onReady?.({ target: player });
      playerEvents?.onStateChange?.({ target: player, data: window.YT!.PlayerState.CUED });
    });

    rerender(<YouTubePlaylistPlayer playlistId="PL-B" onStateChange={onStateChange} expanded />);
    await act(async () => {
      playlistB.reject(new Error("metadata unavailable"));
    });

    await vi.waitFor(() => expect(player.cuePlaylist).toHaveBeenLastCalledWith("PL-B", 0, 0));
    expect(screen.getByText(/Playlist details are unavailable/)).toBeInTheDocument();
    expect(onStateChange).toHaveBeenLastCalledWith("loading");
    expect(constructorSpy).toHaveBeenCalledTimes(1);
    expect(player.destroy).not.toHaveBeenCalled();
    await act(async () => {
      playerEvents?.onStateChange?.({ target: player, data: window.YT!.PlayerState.CUED });
    });
    expect(onStateChange).toHaveBeenLastCalledWith("paused");
  });

  it("applies a fallback hot-swap that settles before iframe readiness", async () => {
    const playlistA =
      deferred<
        readonly [{ videoId: string; title: string; position: number; thumbnailUrl: null }]
      >();
    const playlistB = deferred<never>();
    api.listMusicPlaylistItems.mockImplementation((playlistId: string) =>
      playlistId === "PL-A" ? playlistA.promise : playlistB.promise,
    );
    const iframe = document.createElement("iframe");
    const player = {
      playVideo: vi.fn(),
      pauseVideo: vi.fn(),
      setVolume: vi.fn(),
      getVolume: vi.fn(() => 80),
      getIframe: vi.fn(() => iframe),
      ...playlistMethods(),
      getCurrentTime: vi.fn(() => 0),
      playVideoAt: vi.fn(),
      destroy: vi.fn(),
    } as unknown as YT.Player;
    const constructorSpy = vi.fn();
    let playerEvents: YT.PlayerOptions["events"];
    class FakePlayer {
      public constructor(_elementId: string, options: YT.PlayerOptions) {
        constructorSpy();
        playerEvents = options.events;
        return player;
      }
    }
    window.YT = {
      Player: FakePlayer as unknown as typeof YT.Player,
      PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0, BUFFERING: 3, CUED: 5 },
    };
    const onStateChange = vi.fn();
    const { rerender } = render(
      <YouTubePlaylistPlayer playlistId="PL-A" onStateChange={onStateChange} />,
    );
    await act(async () => {
      playlistA.resolve([
        { videoId: "video-a", title: "Playlist A", position: 0, thumbnailUrl: null },
      ]);
    });
    await vi.waitFor(() => expect(constructorSpy).toHaveBeenCalledTimes(1));

    rerender(<YouTubePlaylistPlayer playlistId="PL-B" onStateChange={onStateChange} />);
    await act(async () => {
      playlistB.reject(new Error("metadata unavailable"));
    });
    await act(async () => {
      playerEvents?.onReady?.({ target: player });
    });

    expect(player.cuePlaylist).toHaveBeenLastCalledWith("PL-B", 0, 0);
    expect(onStateChange).toHaveBeenLastCalledWith("loading");
    expect(constructorSpy).toHaveBeenCalledTimes(1);
    expect(player.destroy).not.toHaveBeenCalled();
  });

  it("becomes ready with the playlist fallback when queue loading fails", async () => {
    api.listMusicPlaylistItems.mockRejectedValue(new Error("queue unavailable"));
    const iframe = document.createElement("iframe");
    const player = {
      playVideo: vi.fn(),
      pauseVideo: vi.fn(),
      setVolume: vi.fn(),
      getVolume: vi.fn(() => 65),
      getIframe: vi.fn(() => iframe),
      ...playlistMethods(),
      getCurrentTime: vi.fn(() => 0),
      playVideoAt: vi.fn(),
      destroy: vi.fn(),
    } as unknown as YT.Player;
    let playerEvents: YT.PlayerOptions["events"];
    class FakePlayer {
      public constructor(_elementId: string, options: YT.PlayerOptions) {
        playerEvents = options.events;
        return player;
      }
    }
    window.YT = {
      Player: FakePlayer as unknown as typeof YT.Player,
      PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0, BUFFERING: 3, CUED: 5 },
    };
    const onStateChange = vi.fn();

    render(<YouTubePlaylistPlayer playlistId="PL-fallback" onStateChange={onStateChange} />);

    await vi.waitFor(() => expect(playerEvents?.onReady).toBeTypeOf("function"));
    await act(async () => {
      playerEvents?.onReady?.({ target: player });
    });
    expect(onStateChange).toHaveBeenLastCalledWith("paused");
    expect(player.setVolume).not.toHaveBeenCalled();
    expect(player.cuePlaylist).not.toHaveBeenCalled();
  });

  it("renders Russian queue loading, tag, and playback controls without translating track titles", async () => {
    api.listMusicPlaylistItems.mockResolvedValue([
      { videoId: "video-1", title: "Opening", position: 0, thumbnailUrl: null },
    ]);

    render(
      <I18nProvider locale="ru">
        <YouTubePlaylistPlayer playlistId="PL-russian" onStateChange={vi.fn()} expanded />
      </I18nProvider>,
    );

    expect(screen.getByRole("region", { name: "Очередь плейлиста сессии" })).toBeInTheDocument();
    expect(screen.getByText("Загрузка очереди плейлиста…")).toBeInTheDocument();
    await screen.findByRole("listitem");
    expect(
      screen.getByRole("button", { name: "Отметить Opening: раскрытие роли" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Воспроизвести Opening следующим" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Воспроизвести Opening сейчас" })).toBeDisabled();
    expect(screen.getByLabelText("Перетащить Opening")).toBeInTheDocument();
  });
});
