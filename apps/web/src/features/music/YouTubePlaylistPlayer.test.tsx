import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider.js";
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
    expect(playerHandle.current?.playFirstRegularTrack()).toBe(true);
    expect(player.playVideoAt).toHaveBeenLastCalledWith(1);
    vi.mocked(player.playVideoAt).mockClear();
    await act(async () => {
      playerEvents?.onStateChange?.({ target: player, data: window.YT!.PlayerState.CUED });
    });

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
    expect(player.cuePlaylist).toHaveBeenLastCalledWith(["video-1", "video-3", "video-2"], 0, 42);
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
    expect(player.playVideoAt).toHaveBeenCalledWith(2);
    expect(vi.mocked(player.setVolume).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(player.playVideoAt).mock.invocationCallOrder[0]!,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(player.setVolume).toHaveBeenLastCalledWith(65);
    vi.useRealTimers();
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
    expect(screen.getByText("Finale").closest("li")).not.toHaveClass("is-next");
    expect(player.cuePlaylist).toHaveBeenLastCalledWith(["video-1", "video-2", "video-3"], 0, 42);
    expect(onQueueOrderChange).toHaveBeenLastCalledWith("PL-selected", [
      "video-1:0",
      "video-2:1",
      "video-3:2",
    ]);
    expect(onQueueOrderChange).toHaveBeenCalledTimes(2);

    await act(async () => {
      playerEvents?.onStateChange?.({ target: player, data: window.YT!.PlayerState.PLAYING });
    });
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
      expect(player.setVolume).toHaveBeenLastCalledWith(65);
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
