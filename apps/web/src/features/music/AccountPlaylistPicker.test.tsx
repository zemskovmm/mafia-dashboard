import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentType } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  disconnectMusicAccount,
  getMusicAccountStatus,
  listMusicPlaylists,
} from "../../api/client.js";
import { AccountPlaylistPicker } from "./AccountPlaylistPicker.js";

vi.mock("../../api/client.js", () => ({
  getMusicAccountStatus: vi.fn(),
  listMusicPlaylists: vi.fn(),
  disconnectMusicAccount: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(getMusicAccountStatus).mockReset();
  vi.mocked(listMusicPlaylists).mockReset();
  vi.mocked(disconnectMusicAccount).mockReset();
});

describe("AccountPlaylistPicker", () => {
  it("offers Google authorization when no account is connected", async () => {
    vi.mocked(getMusicAccountStatus).mockResolvedValue({
      configured: true,
      connected: false,
      accountLabel: null,
    });

    render(
      <AccountPlaylistPicker
        playlistId=""
        onPlaylistIdChange={vi.fn()}
        onAccountDisconnected={vi.fn()}
      />,
    );

    const connect = await screen.findByRole("link", {
      name: "Connect YouTube Music account",
    });
    expect(connect).toHaveAttribute("href", "/api/music/oauth/start");
    expect(screen.getByText(/least-privilege read-only access/i)).toBeInTheDocument();
  });

  it("keeps playlist-ID playback available when account OAuth is not configured", async () => {
    const onPlaylistIdChange = vi.fn();
    vi.mocked(getMusicAccountStatus).mockResolvedValue({
      configured: false,
      connected: false,
      accountLabel: null,
    });
    const user = userEvent.setup();
    const Harness = () => {
      const [playlistId, setPlaylistId] = useState("");
      return (
        <AccountPlaylistPicker
          playlistId={playlistId}
          onAccountDisconnected={vi.fn()}
          onPlaylistIdChange={(next: string) => {
            setPlaylistId(next);
            onPlaylistIdChange(next);
          }}
        />
      );
    };

    render(<Harness />);
    const playlistId = await screen.findByRole("textbox", {
      name: "YouTube Music playlist ID",
    });
    await user.type(playlistId, "PL-manual");

    expect(onPlaylistIdChange).toHaveBeenLastCalledWith("PL-manual");
  });

  it("lists account playlists and selects one for playback", async () => {
    const onPlaylistIdChange = vi.fn();
    vi.mocked(getMusicAccountStatus).mockResolvedValue({
      configured: true,
      connected: true,
      accountLabel: "Mafia Host",
    });
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

  it("configures Day, Voting, and Night playlists from one account load", async () => {
    const StagePicker = AccountPlaylistPicker as unknown as ComponentType<Record<string, unknown>>;
    const onStagePlaylistIdsChange = vi.fn();
    vi.mocked(getMusicAccountStatus).mockResolvedValue({
      configured: true,
      connected: true,
      accountLabel: "Mafia Host",
    });
    vi.mocked(listMusicPlaylists).mockResolvedValue([
      { id: "PL-day", title: "Day mix", itemCount: 12, thumbnailUrl: null },
      { id: "PL-vote", title: "Vote mix", itemCount: 8, thumbnailUrl: null },
      { id: "PL-night", title: "Night mix", itemCount: 10, thumbnailUrl: null },
    ]);
    const user = userEvent.setup();

    render(
      <StagePicker
        playlistId="PL-day"
        onPlaylistIdChange={vi.fn()}
        onAccountDisconnected={vi.fn()}
        stagePlaylistIds={{ day: "PL-day", night: "PL-night" }}
        onStagePlaylistIdsChange={onStagePlaylistIdsChange}
      />,
    );

    const voting = await screen.findByRole("combobox", { name: "Voting playlist" });
    expect(screen.getByRole("combobox", { name: "Day playlist" })).toHaveValue("PL-day");
    expect(screen.getByRole("combobox", { name: "Night playlist" })).toHaveValue("PL-night");
    await user.selectOptions(voting, "PL-vote");
    expect(onStagePlaylistIdsChange).toHaveBeenCalledWith({
      day: "PL-day",
      voting: "PL-vote",
      night: "PL-night",
    });
    expect(listMusicPlaylists).toHaveBeenCalledOnce();
  });

  it("delegates successful disconnect cleanup to one account-disconnected callback", async () => {
    const onPlaylistIdChange = vi.fn();
    const onAccountDisconnected = vi.fn();
    vi.mocked(getMusicAccountStatus).mockResolvedValue({
      configured: true,
      connected: true,
      accountLabel: "Mafia Host",
    });
    vi.mocked(listMusicPlaylists).mockResolvedValue([
      { id: "PL-music", title: "Mafia music", itemCount: 20, thumbnailUrl: null },
    ]);
    vi.mocked(disconnectMusicAccount).mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <AccountPlaylistPicker
        playlistId="PL-music"
        onPlaylistIdChange={onPlaylistIdChange}
        onAccountDisconnected={onAccountDisconnected}
      />,
    );
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
    vi.mocked(getMusicAccountStatus).mockResolvedValue({
      configured: true,
      connected: true,
      accountLabel: "Mafia Host",
    });
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
});
