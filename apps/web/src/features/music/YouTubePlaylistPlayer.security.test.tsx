import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { YouTubePlaylistPlayer } from "./YouTubePlaylistPlayer.js";

const api = vi.hoisted(() => ({ listMusicPlaylistItems: vi.fn() }));

vi.mock(import("../../api/client.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  ...api,
}));

afterEach(() => {
  Object.defineProperty(window, "YT", { configurable: true, value: undefined, writable: true });
  vi.clearAllMocks();
});

describe("YouTubePlaylistPlayer security", () => {
  it("binds the IFrame player to the exact application origin", async () => {
    api.listMusicPlaylistItems.mockResolvedValue([
      { videoId: "video-1", title: "Opening", position: 0, thumbnailUrl: null },
    ]);
    let options: YT.PlayerOptions | undefined;
    const player = {
      destroy: vi.fn(),
    } as unknown as YT.Player;
    class FakePlayer {
      public constructor(_elementId: string, playerOptions: YT.PlayerOptions) {
        options = playerOptions;
        return player;
      }
    }
    window.YT = {
      Player: FakePlayer as unknown as typeof YT.Player,
      PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0, BUFFERING: 3, CUED: 5 },
    };

    render(
      <I18nProvider>
        <YouTubePlaylistPlayer playlistId="PL-security" onStateChange={vi.fn()} />
      </I18nProvider>,
    );

    await vi.waitFor(() => expect(options).toBeDefined());
    expect(options?.playerVars).toMatchObject({ origin: window.location.origin });
  });
});
