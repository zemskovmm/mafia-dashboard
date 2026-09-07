import { useEffect, useState } from "react";
import { disconnectMusicAccount, listMusicPlaylists } from "../../api/client.js";
import type { MusicAccountStatus, MusicPlaylist } from "../../api/client.js";
import { reportError } from "../console/error-console.js";
import { useMessages } from "../../i18n/I18nProvider.js";
import { playersMusicMessages } from "../../i18n/messages/players-music.js";

interface AccountPlaylistPickerProps {
  readonly playlistId: string;
  readonly onPlaylistIdChange: (playlistId: string) => void;
  readonly onAccountDisconnected: () => void;
  readonly status: MusicAccountStatus | null;
  readonly statusError: boolean;
  readonly onRetry: () => void;
  readonly onStatusChange: (status: MusicAccountStatus) => void;
}

export const AccountPlaylistPicker = ({
  playlistId,
  onPlaylistIdChange,
  onAccountDisconnected,
  status,
  statusError,
  onRetry,
  onStatusChange,
}: AccountPlaylistPickerProps) => {
  const { t } = useMessages(playersMusicMessages);
  const [playlists, setPlaylists] = useState<readonly MusicPlaylist[] | null>(null);
  const [playlistLoadFailed, setPlaylistLoadFailed] = useState(false);
  const [disconnectFailed, setDisconnectFailed] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    setPlaylists(null);
    setPlaylistLoadFailed(false);
    if (status?.connected !== true) return undefined;
    let current = true;
    void listMusicPlaylists()
      .then((next) => {
        if (current) setPlaylists(next);
      })
      .catch((error: unknown) => {
        reportError(error, { source: "api", context: "music-playlists.list" });
        if (current) setPlaylistLoadFailed(true);
      });
    return () => {
      current = false;
    };
  }, [status?.accountLabel, status?.connected]);

  if (statusError) {
    return (
      <section className="account-playlist-picker">
        <p className="account-playlist-error" role="alert">
          {t("Music account check failed")}
        </p>
        <button type="button" onClick={onRetry}>
          {t("Retry music account check")}
        </button>
      </section>
    );
  }
  if (playlistLoadFailed || disconnectFailed) {
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
        <button type="button" disabled>
          {t("Music account connection unavailable")}
        </button>
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
                onStatusChange({ configured: true, connected: false, accountLabel: null });
              })
              .catch((error: unknown) => {
                reportError(error, { source: "api", context: "music-account.disconnect" });
                setDisconnectFailed(true);
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
