import { useEffect, useState } from "react";
import { ApiError, disconnectMusicAccount, listMusicPlaylists } from "../../api/client.js";
import type { MusicAccountStatus, MusicPlaylist } from "../../api/client.js";
import { reportError } from "../console/error-console.js";
import { useMessages } from "../../i18n/I18nProvider.js";
import { playersMusicMessages } from "../../i18n/messages/players-music.js";

interface AccountPlaylistPickerProps {
  readonly view: "account" | "playlist";
  readonly playlistId: string;
  readonly onPlaylistIdChange: (playlistId: string) => void;
  readonly onAccountDisconnected: () => void;
  readonly status: MusicAccountStatus | null;
  readonly statusError: boolean;
  readonly onRetry: () => void;
  readonly onStatusChange: (status: MusicAccountStatus) => void;
}

export const AccountPlaylistPicker = ({
  view,
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
  const [playlistReconnectRequired, setPlaylistReconnectRequired] = useState(false);
  const [playlistReload, setPlaylistReload] = useState(0);
  const [disconnectFailed, setDisconnectFailed] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    setPlaylists(null);
    setPlaylistLoadFailed(false);
    setPlaylistReconnectRequired(false);
    if (view !== "playlist" || statusError || status?.connected !== true) return undefined;
    let current = true;
    void listMusicPlaylists()
      .then((next) => {
        if (current) setPlaylists(next);
      })
      .catch((error: unknown) => {
        reportError(error, { source: "api", context: "music-playlists.list" });
        if (current) {
          setPlaylistLoadFailed(true);
          setPlaylistReconnectRequired(
            error instanceof ApiError && error.code === "youtube_reconnect_required",
          );
        }
      });
    return () => {
      current = false;
    };
  }, [playlistReload, status?.accountLabel, status?.connected, statusError, view]);

  const mafiaPlaylists = playlists?.filter(({ title }) =>
    title.trim().toLowerCase().startsWith("mafia"),
  );

  if (view === "playlist" && (statusError || !status?.configured || !status.connected)) return null;

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
  return (
    <section className={view === "playlist" ? "queue-playlist-picker" : "account-playlist-picker"}>
      {view === "account" ? (
        <>
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
                setDisconnectFailed(false);
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
          {disconnectFailed ? (
            <p className="account-playlist-error" role="alert">
              {t("Music account disconnect failed")}
            </p>
          ) : null}
        </>
      ) : playlistLoadFailed ? (
        <div>
          <p className="account-playlist-error" role="alert">
            {t(
              playlistReconnectRequired
                ? "Music account reconnect required"
                : "Music playlists load failed",
            )}
          </p>
          {playlistReconnectRequired ? (
            <a className="oauth-connect" href="/api/music/oauth/start">
              {t("Reconnect music account")}
            </a>
          ) : (
            <button type="button" onClick={() => setPlaylistReload((attempt) => attempt + 1)}>
              {t("Retry loading playlists")}
            </button>
          )}
        </div>
      ) : playlists === null ? (
        <p className="muted">
          {t("Loading playlists for {account}", { account: status.accountLabel ?? "" })}
        </p>
      ) : (
        <>
          <select
            aria-label={t("Music playlist")}
            value={mafiaPlaylists?.some(({ id }) => id === playlistId) ? playlistId : ""}
            onChange={(event) => onPlaylistIdChange(event.target.value)}
          >
            <option value="">{t("Choose a playlist")}</option>
            {mafiaPlaylists?.map((playlist) => (
              <option key={playlist.id} value={playlist.id}>
                {playlist.title} · {t("Playlist tracks", { count: playlist.itemCount })}
              </option>
            ))}
          </select>
          {mafiaPlaylists?.length === 0 ? <p className="muted">{t("No Mafia playlists")}</p> : null}
        </>
      )}
    </section>
  );
};
