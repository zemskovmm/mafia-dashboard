import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
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

    render(<AccountPlaylistPicker playlistId="" onPlaylistIdChange={vi.fn()} />);

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

    render(<AccountPlaylistPicker playlistId="" onPlaylistIdChange={onPlaylistIdChange} />);
    const picker = await screen.findByRole("combobox", { name: "YouTube Music playlist" });
    expect(screen.getByText("Connected as Mafia Host")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Dinner mix · 12 tracks" })).toBeInTheDocument();

    await user.selectOptions(picker, "PL-late");
    expect(onPlaylistIdChange).toHaveBeenCalledWith("PL-late");
  });

  it("disconnects the account and clears the selected playlist", async () => {
    const onPlaylistIdChange = vi.fn();
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

    render(<AccountPlaylistPicker playlistId="PL-music" onPlaylistIdChange={onPlaylistIdChange} />);
    await user.click(await screen.findByRole("button", { name: "Disconnect account" }));

    expect(disconnectMusicAccount).toHaveBeenCalledOnce();
    expect(onPlaylistIdChange).toHaveBeenCalledWith("");
    expect(
      await screen.findByRole("link", { name: "Connect YouTube Music account" }),
    ).toBeInTheDocument();
  });
});
