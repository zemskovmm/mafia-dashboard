import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { YouTubePlaylistPlayer } from "./YouTubePlaylistPlayer.js";

const api = vi.hoisted(() => ({ listMusicPlaylistItems: vi.fn() }));

vi.mock("../../api/client.js", () => api);

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
    let onPlayerStateChange: ((event: YT.OnStateChangeEvent) => void) | undefined;
    class FakePlayer {
      public constructor(_elementId: string, options: YT.PlayerOptions) {
        onPlayerStateChange = options.events?.onStateChange;
        queueMicrotask(() => options.events?.onReady?.({ target: player }));
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
        playlistId="PL-selected"
        onStateChange={onStateChange}
        expanded
        onExpandedChange={() => undefined}
      />,
    );
    await vi.waitFor(() => expect(onPlayerStateChange).toBeTypeOf("function"));
    expect(api.listMusicPlaylistItems).toHaveBeenCalledWith("PL-selected");
    expect(player.cuePlaylist).toHaveBeenCalledWith(["video-1", "video-2", "video-3"], 0, 0);
    expect(player.setVolume).toHaveBeenCalledWith(80);
    expect(player.playVideo).not.toHaveBeenCalled();
    expect(onStateChange).toHaveBeenLastCalledWith("loading");
    expect(iframe.getAttribute("allow")).toBe(
      "accelerometer; autoplay; encrypted-media; fullscreen",
    );

    await act(async () => {
      onPlayerStateChange?.({ target: player, data: window.YT!.PlayerState.CUED });
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

    await act(async () => {
      onPlayerStateChange?.({ target: player, data: window.YT!.PlayerState.CUED });
    });
    await user.click(screen.getByRole("button", { name: "Play Middle now" }));
    expect(player.playVideoAt).toHaveBeenCalledWith(2);

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
    class FakePlayer {
      public constructor(_elementId: string, options: YT.PlayerOptions) {
        queueMicrotask(() => options.events?.onReady?.({ target: player }));
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

    await vi.waitFor(() => expect(onStateChange).toHaveBeenLastCalledWith("paused"));
    expect(player.setVolume).toHaveBeenCalledWith(65);
    expect(player.cuePlaylist).not.toHaveBeenCalled();
  });
});
