import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps, type ComponentType } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  disconnectMusicAccount,
  listMusicPlaylists,
  type MusicAccountStatus,
} from "../../api/client.js";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { AccountPlaylistPicker as Picker } from "./AccountPlaylistPicker.js";

const AccountPlaylistPicker = (props: Omit<ComponentProps<typeof Picker>, "view">) => (
  <>
    <section aria-label="Account setup">
      <Picker {...props} view="account" />
    </section>
    <section aria-label="Queue header">
      <Picker {...props} view="playlist" />
    </section>
  </>
);

vi.mock(import("../../api/client.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  listMusicPlaylists: vi.fn(),
  disconnectMusicAccount: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(listMusicPlaylists).mockReset();
  vi.mocked(disconnectMusicAccount).mockReset();
});

describe("AccountPlaylistPicker", () => {
  it("offers Google authorization when no account is connected", async () => {
    render(
      <AccountPlaylistPicker
        playlistId=""
        onPlaylistIdChange={vi.fn()}
        onAccountDisconnected={vi.fn()}
        status={{ configured: true, connected: false, accountLabel: null }}
        statusError={false}
        onRetry={vi.fn()}
        onStatusChange={vi.fn()}
      />,
    );

    const connect = screen.getByRole("link", {
      name: "Connect YouTube Music account",
    });
    expect(connect).toHaveAttribute("href", "/api/music/oauth/start");
    expect(screen.getByText(/least-privilege read-only access/i)).toBeInTheDocument();
  });

  it("shows unavailable account setup without a manual playlist-ID bypass", () => {
    const onPlaylistIdChange = vi.fn();
    render(
      <AccountPlaylistPicker
        playlistId="remembered-playlist"
        onPlaylistIdChange={onPlaylistIdChange}
        onAccountDisconnected={vi.fn()}
        status={{ configured: false, connected: false, accountLabel: null }}
        statusError={false}
        onRetry={vi.fn()}
        onStatusChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Connect YouTube Music account unavailable/i }),
    ).toBeDisabled();
    expect(screen.queryByRole("textbox", { name: "YouTube Music playlist ID" })).toBeNull();
    expect(onPlaylistIdChange).not.toHaveBeenCalled();
  });

  it("lists account playlists and selects one for playback", async () => {
    const onPlaylistIdChange = vi.fn();
    vi.mocked(listMusicPlaylists).mockResolvedValue([
      { id: "PL-dinner", title: "Dinner mix", itemCount: 12, thumbnailUrl: null },
      { id: "PL-late", title: "Late night", itemCount: 8, thumbnailUrl: null },
    ]);
    const user = userEvent.setup();

    render(
      <AccountPlaylistPicker
        playlistId=""
        onPlaylistIdChange={onPlaylistIdChange}
        onAccountDisconnected={vi.fn()}
        status={{ configured: true, connected: true, accountLabel: "Mafia Host" }}
        statusError={false}
        onRetry={vi.fn()}
        onStatusChange={vi.fn()}
      />,
    );
    const picker = await screen.findByRole("combobox", { name: "YouTube Music playlist" });
    expect(
      within(screen.getByRole("region", { name: "Account setup" })).queryByRole("combobox"),
    ).toBeNull();
    expect(within(screen.getByRole("region", { name: "Queue header" })).getByRole("combobox")).toBe(
      picker,
    );
    expect(
      within(screen.getByRole("region", { name: "Queue header" })).queryByRole("button", {
        name: "Disconnect account",
      }),
    ).toBeNull();
    expect(listMusicPlaylists).toHaveBeenCalledOnce();
    expect(screen.getByText("Connected as Mafia Host")).toBeInTheDocument();
    expect(
      within(picker).getByRole("option", { name: "Dinner mix · 12 tracks" }),
    ).toBeInTheDocument();

    await user.selectOptions(picker, "PL-late");
    expect(onPlaylistIdChange).toHaveBeenCalledWith("PL-late");
  });

  it("retains account controls and reloads playlists after a transient loading failure", async () => {
    vi.mocked(listMusicPlaylists)
      .mockRejectedValueOnce(new Error("playlist provider unavailable"))
      .mockResolvedValueOnce([
        { id: "PL-remembered", title: "Remembered mix", itemCount: 12, thumbnailUrl: null },
      ]);
    const user = userEvent.setup();

    render(
      <AccountPlaylistPicker
        playlistId="PL-remembered"
        onPlaylistIdChange={vi.fn()}
        onAccountDisconnected={vi.fn()}
        status={{ configured: true, connected: true, accountLabel: "Mafia Host" }}
        statusError={false}
        onRetry={vi.fn()}
        onStatusChange={vi.fn()}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to load YouTube Music playlists. Please try again.",
    );
    expect(screen.getByText("Connected as Mafia Host")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect account" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Connect YouTube Music account" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Retry loading playlists" }));

    expect(await screen.findByRole("combobox", { name: "YouTube Music playlist" })).toHaveValue(
      "PL-remembered",
    );
    expect(listMusicPlaylists).toHaveBeenCalledTimes(2);
  });

  it("offers reconnection instead of retrying when playlist authorization is revoked", async () => {
    vi.mocked(listMusicPlaylists).mockRejectedValue(
      new ApiError("YouTube authorization must be renewed", 409, "youtube_reconnect_required"),
    );

    render(
      <AccountPlaylistPicker
        playlistId="PL-remembered"
        onPlaylistIdChange={vi.fn()}
        onAccountDisconnected={vi.fn()}
        status={{ configured: true, connected: true, accountLabel: "Mafia Host" }}
        statusError={false}
        onRetry={vi.fn()}
        onStatusChange={vi.fn()}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your YouTube Music authorization has expired or was revoked. Reconnect your account to load playlists.",
    );
    const reconnect = screen.getByRole("link", { name: "Reconnect YouTube Music account" });
    expect(reconnect).toHaveAttribute("href", "/api/music/oauth/start");
    expect(screen.queryByRole("button", { name: "Retry loading playlists" })).toBeNull();
  });

  it("ignores a stale playlist response after the connected account changes", async () => {
    let resolveStale: (
      playlists: readonly { id: string; title: string; itemCount: number; thumbnailUrl: null }[],
    ) => void;
    const stalePlaylists = new Promise<
      readonly { id: string; title: string; itemCount: number; thumbnailUrl: null }[]
    >((resolve) => {
      resolveStale = resolve;
    });
    vi.mocked(listMusicPlaylists)
      .mockReturnValueOnce(stalePlaylists)
      .mockResolvedValueOnce([
        { id: "PL-current", title: "Current mix", itemCount: 8, thumbnailUrl: null },
      ]);

    const { rerender } = render(
      <AccountPlaylistPicker
        playlistId=""
        onPlaylistIdChange={vi.fn()}
        onAccountDisconnected={vi.fn()}
        status={{ configured: true, connected: true, accountLabel: "Earlier Host" }}
        statusError={false}
        onRetry={vi.fn()}
        onStatusChange={vi.fn()}
      />,
    );
    await screen.findByText("Loading playlists for Earlier Host…");

    rerender(
      <AccountPlaylistPicker
        playlistId=""
        onPlaylistIdChange={vi.fn()}
        onAccountDisconnected={vi.fn()}
        status={{ configured: true, connected: true, accountLabel: "Current Host" }}
        statusError={false}
        onRetry={vi.fn()}
        onStatusChange={vi.fn()}
      />,
    );

    expect(
      await screen.findByRole("option", { name: "Current mix · 8 tracks" }),
    ).toBeInTheDocument();
    await act(async () => {
      resolveStale([{ id: "PL-stale", title: "Stale mix", itemCount: 3, thumbnailUrl: null }]);
    });

    expect(screen.getByRole("option", { name: "Current mix · 8 tracks" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Stale mix · 3 tracks" })).toBeNull();
  });

  it("renders only one remembered playlist selector even when obsolete stage props are present", async () => {
    const LegacyCompatiblePicker = AccountPlaylistPicker as unknown as ComponentType<
      Record<string, unknown>
    >;
    vi.mocked(listMusicPlaylists).mockResolvedValue([
      { id: "PL-day", title: "Day mix", itemCount: 12, thumbnailUrl: null },
      { id: "PL-vote", title: "Vote mix", itemCount: 8, thumbnailUrl: null },
      { id: "PL-night", title: "Night mix", itemCount: 10, thumbnailUrl: null },
    ]);
    render(
      <LegacyCompatiblePicker
        playlistId="PL-day"
        onPlaylistIdChange={vi.fn()}
        onAccountDisconnected={vi.fn()}
        status={{ configured: true, connected: true, accountLabel: "Mafia Host" }}
        statusError={false}
        onRetry={vi.fn()}
        onStatusChange={vi.fn()}
        stagePlaylistIds={{ day: "PL-day", night: "PL-night" }}
        onStagePlaylistIdsChange={vi.fn()}
      />,
    );

    await screen.findByRole("combobox", { name: "YouTube Music playlist" });
    expect(screen.queryByRole("combobox", { name: "Day playlist" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Voting playlist" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Night playlist" })).toBeNull();
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
    expect(listMusicPlaylists).toHaveBeenCalledOnce();
  });

  it("delegates successful disconnect cleanup to one account-disconnected callback", async () => {
    const onPlaylistIdChange = vi.fn();
    const onAccountDisconnected = vi.fn();
    vi.mocked(listMusicPlaylists).mockResolvedValue([
      { id: "PL-music", title: "Mafia music", itemCount: 20, thumbnailUrl: null },
    ]);
    vi.mocked(disconnectMusicAccount).mockResolvedValue(undefined);
    const user = userEvent.setup();
    const Harness = () => {
      const [status, setStatus] = useState<MusicAccountStatus>({
        configured: true,
        connected: true,
        accountLabel: "Mafia Host",
      });
      return (
        <AccountPlaylistPicker
          playlistId="PL-music"
          onPlaylistIdChange={onPlaylistIdChange}
          onAccountDisconnected={onAccountDisconnected}
          status={status}
          statusError={false}
          onRetry={vi.fn()}
          onStatusChange={setStatus}
        />
      );
    };

    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: "Disconnect account" }));

    expect(disconnectMusicAccount).toHaveBeenCalledOnce();
    expect(onAccountDisconnected).toHaveBeenCalledOnce();
    expect(onPlaylistIdChange).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("link", { name: "Connect YouTube Music account" }),
    ).toBeInTheDocument();
  });

  it("keeps account controls and playlist state when disconnecting the account fails", async () => {
    const onPlaylistIdChange = vi.fn();
    const onAccountDisconnected = vi.fn();
    vi.mocked(listMusicPlaylists).mockResolvedValue([
      { id: "PL-music", title: "Mafia music", itemCount: 20, thumbnailUrl: null },
    ]);
    vi.mocked(disconnectMusicAccount).mockRejectedValue(new Error("disconnect failed"));
    const user = userEvent.setup();

    render(
      <AccountPlaylistPicker
        playlistId="PL-music"
        onPlaylistIdChange={onPlaylistIdChange}
        onAccountDisconnected={onAccountDisconnected}
        status={{ configured: true, connected: true, accountLabel: "Mafia Host" }}
        statusError={false}
        onRetry={vi.fn()}
        onStatusChange={vi.fn()}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Disconnect account" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to disconnect the YouTube Music account. Please try again.",
    );
    expect(screen.getByText("Connected as Mafia Host")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect account" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "YouTube Music playlist" })).toHaveValue(
      "PL-music",
    );
    expect(disconnectMusicAccount).toHaveBeenCalledOnce();
    expect(onAccountDisconnected).not.toHaveBeenCalled();
    expect(onPlaylistIdChange).not.toHaveBeenCalled();
  });

  it("renders Russian account loading without a manual playlist bypass", () => {
    render(
      <I18nProvider locale="ru">
        <AccountPlaylistPicker
          playlistId=""
          onPlaylistIdChange={vi.fn()}
          onAccountDisconnected={vi.fn()}
          status={null}
          statusError={false}
          onRetry={vi.fn()}
          onStatusChange={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("Проверяем аккаунт YouTube Music…")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "ID плейлиста YouTube Music" })).toBeNull();
  });

  it("offers a retry after the shared account status check fails", async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(
      <AccountPlaylistPicker
        playlistId=""
        onPlaylistIdChange={vi.fn()}
        onAccountDisconnected={vi.fn()}
        status={null}
        statusError
        onRetry={onRetry}
        onStatusChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Unable to check the YouTube Music account.",
    );
    await user.click(screen.getByRole("button", { name: "Retry music account check" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
