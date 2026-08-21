import { act, render, screen } from "@testing-library/react";
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
    api.listMusicPlaylistItems.mockResolvedValue([
      { videoId: "video-1", title: "Opening", position: 0, thumbnailUrl: null },
      { videoId: "video-2", title: "Middle", position: 1, thumbnailUrl: null },
      { videoId: "video-1", title: "Opening reprise", position: 2, thumbnailUrl: null },
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
    expect(player.cuePlaylist).toHaveBeenCalledWith(["video-1", "video-2", "video-1"], 0, 0);
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
      "Opening",
      "Middle",
      "Opening reprise",
    ]);
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
