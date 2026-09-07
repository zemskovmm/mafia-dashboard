import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentType } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  disconnectMusicAccount,
  listMusicPlaylists,
  type MusicAccountStatus,
} from "../../api/client.js";
import { I18nProvider } from "../../i18n/I18nProvider.js";
import { AccountPlaylistPicker } from "./AccountPlaylistPicker.js";

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
    expect(screen.getByText("Connected as Mafia Host")).toBeInTheDocument();
    expect(
      within(picker).getByRole("option", { name: "Dinner mix · 12 tracks" }),
    ).toBeInTheDocument();

    await user.selectOptions(picker, "PL-late");
    expect(onPlaylistIdChange).toHaveBeenCalledWith("PL-late");
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

  it("leaves playlist state unchanged when disconnecting the account fails", async () => {
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

    expect(
      await screen.findByText("Unable to check the YouTube Music account."),
    ).toBeInTheDocument();
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
