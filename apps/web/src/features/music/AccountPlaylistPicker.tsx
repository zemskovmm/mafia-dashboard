import { useEffect, useState } from "react";
import {
  disconnectMusicAccount,
  getMusicAccountStatus,
  listMusicPlaylists,
} from "../../api/client.js";
import type { MusicAccountStatus, MusicPlaylist } from "../../api/client.js";
import { reportError } from "../console/error-console.js";
import { useMessages } from "../../i18n/I18nProvider.js";
import { playersMusicMessages } from "../../i18n/messages/players-music.js";

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
  const { t } = useMessages(playersMusicMessages);
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
    return <p className="account-playlist-error">{t("Music account check failed")}</p>;
  }
  if (status === null) {
    return <p className="muted">{t("Checking music account")}</p>;
  }
  if (!status.configured) {
    return (
      <section className="account-playlist-picker">
        <h2>{t("Music playlist")}</h2>
        <p className="muted">{t("Music account access not configured")}</p>
        <label className="wide-field">
          <span>{t("Music playlist ID")}</span>
          <input
            value={playlistId}
            placeholder={t("Paste music playlist ID")}
            onChange={(event) => onPlaylistIdChange(event.target.value)}
          />
        </label>
      </section>
    );
  }
  if (!status.connected) {
    return (
      <section className="account-playlist-picker">
        <h2>{t("Music account")}</h2>
        <p className="muted">{t("Music read-only guidance")}</p>
        <a className="oauth-connect" href="/api/music/oauth/start">
          {t("Connect music account")}
        </a>
      </section>
    );
  }
  if (playlists === null) {
    return (
      <p className="muted">
        {t("Loading playlists for {account}", { account: status.accountLabel ?? "" })}
      </p>
    );
  }
  return (
    <section className="account-playlist-picker">
      <div className="account-playlist-heading">
        <div>
          <h2>{t("Music library")}</h2>
          <p className="muted">
            {t("Connected as {account}", { account: status.accountLabel ?? "" })}
          </p>
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
          {disconnecting ? t("Disconnecting…") : t("Disconnect account")}
        </button>
      </div>
      <label className="wide-field">
        <span>{t("Music playlist")}</span>
        <select
          aria-label={t("Music playlist")}
          value={playlistId}
          onChange={(event) => onPlaylistIdChange(event.target.value)}
        >
          <option value="">{t("Choose a playlist")}</option>
          {playlists.map((playlist) => (
            <option key={playlist.id} value={playlist.id}>
              {playlist.title} · {t("Playlist tracks", { count: playlist.itemCount })}
            </option>
          ))}
        </select>
      </label>
      {playlists.length === 0 ? <p className="muted">{t("No account playlists")}</p> : null}
    </section>
  );
};
