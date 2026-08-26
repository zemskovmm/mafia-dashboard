import { useEffect, useState } from "react";
import {
  disconnectMusicAccount,
  getMusicAccountStatus,
  listMusicPlaylists,
} from "../../api/client.js";
import type { MusicAccountStatus, MusicPlaylist } from "../../api/client.js";
import { reportError } from "../console/error-console.js";

interface AccountPlaylistPickerProps {
  readonly playlistId: string;
  readonly onPlaylistIdChange: (playlistId: string) => void;
  readonly onAccountDisconnected: () => void;
}

export const AccountPlaylistPicker = ({
  playlistId,
  onPlaylistIdChange,
  onAccountDisconnected,
}: AccountPlaylistPickerProps) => {
  const [status, setStatus] = useState<MusicAccountStatus | null>(null);
  const [playlists, setPlaylists] = useState<readonly MusicPlaylist[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    let current = true;
    void getMusicAccountStatus()
      .then((next) => {
        if (current) setStatus(next);
      })
      .catch((error: unknown) => {
        reportError(error, { source: "api", context: "music-account.status" });
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    if (status?.connected !== true) return undefined;
    let current = true;
    void listMusicPlaylists()
      .then((next) => {
        if (current) setPlaylists(next);
      })
      .catch((error: unknown) => {
        reportError(error, { source: "api", context: "music-playlists.list" });
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [status]);

  if (failed) {
    return <p className="account-playlist-error">Unable to check the YouTube Music account.</p>;
  }
  if (status === null) {
    return <p className="muted">Checking YouTube Music account…</p>;
  }
  if (!status.configured) {
    return (
      <section className="account-playlist-picker">
        <h2>YouTube Music playlist</h2>
        <p className="muted">
          Google account access is not configured yet. A playlist ID can still be used.
        </p>
        <label className="wide-field">
          <span>YouTube Music playlist ID</span>
          <input
            value={playlistId}
            placeholder="Paste a playlist ID"
            onChange={(event) => onPlaylistIdChange(event.target.value)}
          />
        </label>
      </section>
    );
  }
  if (!status.connected) {
    return (
      <section className="account-playlist-picker">
        <h2>YouTube Music account</h2>
        <p className="muted">
          Connect with least-privilege read-only access to choose playlists from your library.
        </p>
        <a className="oauth-connect" href="/api/music/oauth/start">
          Connect YouTube Music account
        </a>
      </section>
    );
  }
  if (playlists === null) {
    return <p className="muted">Loading playlists for {status.accountLabel}…</p>;
  }
  return (
    <section className="account-playlist-picker">
      <div className="account-playlist-heading">
        <div>
          <h2>YouTube Music library</h2>
          <p className="muted">Connected as {status.accountLabel}</p>
        </div>
        <button
          type="button"
          disabled={disconnecting}
          onClick={() => {
            setDisconnecting(true);
            void disconnectMusicAccount()
              .then(() => {
                onAccountDisconnected();
                setPlaylists(null);
                setStatus({ configured: true, connected: false, accountLabel: null });
              })
              .catch((error: unknown) => {
                reportError(error, { source: "api", context: "music-account.disconnect" });
                setFailed(true);
              })
              .finally(() => setDisconnecting(false));
          }}
        >
          {disconnecting ? "Disconnecting…" : "Disconnect account"}
        </button>
      </div>
      <label className="wide-field">
        <span>YouTube Music playlist</span>
        <select
          aria-label="YouTube Music playlist"
          value={playlistId}
          onChange={(event) => onPlaylistIdChange(event.target.value)}
        >
          <option value="">Choose a playlist</option>
          {playlists.map((playlist) => (
            <option key={playlist.id} value={playlist.id}>
              {playlist.title} · {playlist.itemCount} tracks
            </option>
          ))}
        </select>
      </label>
      {playlists.length === 0 ? (
        <p className="muted">No playlists were found in this account.</p>
      ) : null}
    </section>
  );
};
