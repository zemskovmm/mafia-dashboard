import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { YouTubePlaylistPlayer } from "./YouTubePlaylistPlayer.js";

afterEach(() => {
  Object.defineProperty(window, "YT", { configurable: true, value: undefined, writable: true });
  vi.clearAllMocks();
});

describe("YouTubePlaylistPlayer", () => {
  it("supplies the selected playlist directly to YouTube without an order override", async () => {
    const player = {
      playVideo: vi.fn(),
      pauseVideo: vi.fn(),
      setVolume: vi.fn(),
      getVolume: vi.fn(() => 65),
      destroy: vi.fn(),
    } as unknown as YT.Player;
    let onPlayerStateChange: ((event: YT.OnStateChangeEvent) => void) | undefined;
    let playerOptions: YT.PlayerOptions | undefined;
    class FakePlayer {
      public constructor(_elementId: string, options: YT.PlayerOptions) {
        playerOptions = options;
        onPlayerStateChange = options.events?.onStateChange;
        queueMicrotask(() => options.events?.onReady?.({ target: player }));
        return player;
      }
    }
    window.YT = {
      Player: FakePlayer as unknown as typeof YT.Player,
      PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0, BUFFERING: 3 },
    };

    render(<YouTubePlaylistPlayer playlistId="PL-selected" onStateChange={() => undefined} />);
    await vi.waitFor(() => expect(onPlayerStateChange).toBeTypeOf("function"));
    expect(screen.queryByLabelText("Choose next YouTube track")).toBeNull();
    expect(screen.queryByRole("button", { name: "Set next track" })).toBeNull();
    expect(playerOptions?.playerVars).toMatchObject({
      listType: "playlist",
      list: "PL-selected",
    });

    await act(async () => {
      onPlayerStateChange?.({ target: player, data: window.YT!.PlayerState.ENDED });
    });
  });
});
