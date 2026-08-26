import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { YouTubePlaylistPlayer } from "./YouTubePlaylistPlayer.js";
import type { YouTubePlayerHandle } from "./YouTubePlaylistPlayer.js";

const api = vi.hoisted(() => ({ listMusicPlaylistItems: vi.fn() }));

vi.mock("../../api/client.js", () => api);

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

afterEach(() => {
  Object.defineProperty(window, "YT", { configurable: true, value: undefined, writable: true });
  vi.clearAllMocks();
});

describe("YouTubePlaylistPlayer", () => {
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
      cuePlaylist: vi.fn(),
      getPlaylistIndex: vi.fn(() => 0),
      getCurrentTime: vi.fn(() => 42),
      loadPlaylist: vi.fn(),
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

    render(
      <YouTubePlaylistPlayer
        playlistId="PL-selected"
        onStateChange={onStateChange}
        onQueueOrderChange={onQueueOrderChange}
        expanded
        onExpandedChange={() => undefined}
      />,
    );
    await vi.waitFor(() => expect(playerEvents?.onReady).toBeTypeOf("function"));
    await act(async () => {
      playerEvents?.onReady?.({ target: player });
    });
    expect(api.listMusicPlaylistItems).toHaveBeenCalledWith("PL-selected");
    expect(player.cuePlaylist).toHaveBeenCalledWith(["video-1", "video-2", "video-3"], 0, 0);
    expect(player.setVolume).toHaveBeenCalledWith(80);
    expect(player.playVideo).not.toHaveBeenCalled();
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

    await user.click(screen.getByRole("button", { name: "Play Finale next" }));
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("Opening"),
      expect.stringContaining("Finale"),
      expect.stringContaining("Middle"),
    ]);
    expect(player.cuePlaylist).toHaveBeenLastCalledWith(["video-1", "video-3", "video-2"], 0, 42);
    expect(onQueueOrderChange).toHaveBeenLastCalledWith("PL-selected", [
      "video-1:0",
      "video-3:2",
      "video-2:1",
    ]);

    await act(async () => {
      playerEvents?.onStateChange?.({ target: player, data: window.YT!.PlayerState.CUED });
    });
    await user.click(screen.getByRole("button", { name: "Play Middle now" }));
    expect(player.playVideoAt).toHaveBeenCalledWith(2);
    expect(onQueueOrderChange).toHaveBeenCalledTimes(1);

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
    expect(player.cuePlaylist).toHaveBeenLastCalledWith(["video-1", "video-2", "video-3"], 0, 42);
    expect(onQueueOrderChange).toHaveBeenLastCalledWith("PL-selected", [
      "video-1:0",
      "video-2:1",
      "video-3:2",
    ]);
    expect(onQueueOrderChange).toHaveBeenCalledTimes(2);
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
      cuePlaylist: vi.fn(),
      getPlaylistIndex: vi.fn(() => 0),
      getCurrentTime: vi.fn(() => 0),
      loadPlaylist: vi.fn(),
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
      cuePlaylist: vi.fn(),
      getPlaylistIndex: vi.fn(() => 0),
      getCurrentTime: vi.fn(() => 7),
      loadPlaylist: vi.fn(),
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
      cuePlaylist: vi.fn(),
      getPlaylistIndex: vi.fn(() => 0),
      getCurrentTime: vi.fn(() => 5),
      loadPlaylist: vi.fn(),
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
    expect(player.cuePlaylist).toHaveBeenCalledTimes(2);

    rerender(
      <YouTubePlaylistPlayer
        playlistId="PL-echo"
        rememberedQueueOrder={emittedOrder}
        onQueueOrderChange={onQueueOrderChange}
        onStateChange={() => undefined}
        expanded
      />,
    );

    expect(player.cuePlaylist).toHaveBeenCalledTimes(2);
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
      cuePlaylist: vi.fn(),
      getPlaylistIndex: vi.fn(() => 0),
      getCurrentTime: vi.fn(() => 9),
      loadPlaylist: vi.fn(),
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
      cuePlaylist: vi.fn(),
      getPlaylistIndex: vi.fn(() => 0),
      getCurrentTime: vi.fn(() => 4),
      loadPlaylist: vi.fn(),
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
    expect(screen.getByRole("button", { name: "Play A three next" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
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
    expect(screen.getByRole("button", { name: "Play Playlist B next" })).toHaveAttribute(
      "aria-pressed",
      "false",
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
      cuePlaylist: vi.fn(),
      getPlaylistIndex: vi.fn(() => 0),
      getCurrentTime: vi.fn(() => 4),
      loadPlaylist: vi.fn(),
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
      cuePlaylist: vi.fn(),
      getPlaylistIndex: vi.fn(() => 0),
      getCurrentTime: vi.fn(() => 0),
      loadPlaylist: vi.fn(),
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
      cuePlaylist: vi.fn(),
      getPlaylistIndex: vi.fn(() => 0),
      getCurrentTime: vi.fn(() => 0),
      loadPlaylist: vi.fn(),
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
      cuePlaylist: vi.fn(),
      getPlaylistIndex: vi.fn(() => 0),
      getCurrentTime: vi.fn(() => 0),
      loadPlaylist: vi.fn(),
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
      cuePlaylist: vi.fn(),
      getPlaylistIndex: vi.fn(() => 0),
      getCurrentTime: vi.fn(() => 0),
      loadPlaylist: vi.fn(),
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
      cuePlaylist: vi.fn(),
      getPlaylistIndex: vi.fn(() => 0),
      getCurrentTime: vi.fn(() => 0),
      loadPlaylist: vi.fn(),
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

    render(
      <YouTubePlaylistPlayer
        playlistId="PL-fallback"
        activeVolume={65}
        onStateChange={onStateChange}
      />,
    );

    await vi.waitFor(() => expect(playerEvents?.onReady).toBeTypeOf("function"));
    await act(async () => {
      playerEvents?.onReady?.({ target: player });
    });
    expect(onStateChange).toHaveBeenLastCalledWith("paused");
    expect(player.setVolume).toHaveBeenCalledWith(65);
    expect(player.cuePlaylist).not.toHaveBeenCalled();
  });
});
