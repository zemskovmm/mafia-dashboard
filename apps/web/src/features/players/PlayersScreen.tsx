import { useEffect, useState } from "react";
import { isCasperPlayer } from "@mafia/game-domain";
import { ApiError } from "../../api/client.js";
import type { PlayerProfile, PlayerProfileInput } from "../../api/client.js";
import {
  PLAYER_ICON_ROLES,
  type PlayerRoleIcons,
  type PlayerRoleIconsInput,
} from "../../api/player-role-icon-contracts.js";
import { reportError } from "../console/error-console.js";
import { useMessages } from "../../i18n/I18nProvider.js";
import { playersMusicMessages } from "../../i18n/messages/players-music.js";
import { GlassSurface } from "../theme/GlassSurface.js";
import { LiquidCardGlass } from "../theme/LiquidCardGlass.js";
import { roleIconMessages } from "../../i18n/messages/role-icons.js";
import { RoleIconFields } from "./RoleIconPicker.js";
import { usePlayerRoleAppearance } from "./player-display.js";

interface PlayersScreenProps {
  readonly players: readonly PlayerProfile[];
  readonly onBack?: () => void;
  readonly onCreate: (input: PlayerProfileInput) => Promise<void>;
  readonly onUpdate: (playerId: string, input: PlayerProfileInput) => Promise<void>;
  readonly onDelete?: (playerId: string) => Promise<void>;
  readonly deletionProtectedPlayerIds?: ReadonlySet<string>;
}

interface ProfileDraft {
  readonly nickname: string;
  readonly consent: boolean;
  readonly clubAccess: "none" | "user" | "manager";
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly roleIcons?: PlayerRoleIconsInput;
}

const emptyDraft: ProfileDraft = {
  nickname: "",
  consent: false,
  clubAccess: "none",
  firstName: "",
  lastName: "",
  email: "",
};

const draftFromPlayer = (player: PlayerProfile): ProfileDraft => ({
  nickname: player.nickname,
  consent: player.consent,
  clubAccess: player.clubAccess,
  firstName: player.firstName ?? "",
  lastName: player.lastName ?? "",
  email: player.email ?? "",
});

const withoutUploadedIcons = (
  saved: PlayerRoleIcons | undefined,
  changes: PlayerRoleIconsInput | undefined,
): PlayerRoleIconsInput | undefined => {
  const result = { ...changes };
  const combined = { ...saved, ...changes };
  for (const role of PLAYER_ICON_ROLES) {
    if (combined[role]?.kind === "image" || combined[role]?.kind === "upload") result[role] = null;
  }
  return Object.keys(result).length ? result : undefined;
};

const toInput = (draft: ProfileDraft): PlayerProfileInput => {
  const roleIcons = draft.consent
    ? draft.roleIcons
    : withoutUploadedIcons(undefined, draft.roleIcons);
  return {
    ...(roleIcons && Object.keys(roleIcons).length ? { roleIcons } : {}),
    ...(draft.consent
      ? {
          nickname: draft.nickname.trim(),
          consent: true,
          clubAccess: draft.clubAccess,
          firstName: draft.firstName.trim(),
          lastName: draft.lastName.trim(),
          email: draft.email.trim(),
        }
      : {
          nickname: draft.nickname.trim(),
          consent: false,
          clubAccess: draft.clubAccess === "manager" ? "manager" : "none",
          firstName: null,
          lastName: null,
          email: null,
        }),
  };
};

type PlayersMusicTranslate = (
  key: keyof typeof playersMusicMessages.en,
  values?: Readonly<Record<string, string | number>>,
) => string;

const errorMessage = (t: PlayersMusicTranslate, error: unknown): string => {
  if (error instanceof ApiError && error.code === "nickname_conflict") {
    return t("Nickname conflict");
  }
  if (error instanceof ApiError && error.code === "club_access_email_conflict") {
    return t("Club access email conflict");
  }
  return t("Player save failed");
};

const deletionConfirmation = (t: PlayersMusicTranslate, player: PlayerProfile): string => {
  const gameCount = player.statistics.hostedGames + player.statistics.gamesPlayed;
  return gameCount === 0
    ? t("Delete player without games", { nickname: player.nickname })
    : t("Delete player with games", { count: gameCount, nickname: player.nickname });
};

const ProfileFields = ({
  draft,
  idPrefix,
  labelPrefix,
  busy,
  managerLocked,
  managerGuidanceId,
  onChange,
}: {
  readonly draft: ProfileDraft;
  readonly idPrefix: string;
  readonly labelPrefix: string;
  readonly busy: boolean;
  readonly managerLocked: boolean;
  readonly managerGuidanceId?: string;
  readonly onChange: (draft: ProfileDraft) => void;
}) => {
  const { t } = useMessages(playersMusicMessages);
  const update = (changes: Partial<ProfileDraft>) => onChange({ ...draft, ...changes });
  return (
    <div className="player-profile-fields">
      <label htmlFor={`${idPrefix}-nickname`}>
        {t("Nickname")}
        <input
          id={`${idPrefix}-nickname`}
          aria-label={t("Player nickname aria", { player: labelPrefix })}
          value={draft.nickname}
          maxLength={80}
          required
          onChange={(event) => update({ nickname: event.currentTarget.value })}
        />
      </label>
      <label className="player-toggle-field" htmlFor={`${idPrefix}-consent`}>
        <span>{t("Data processing")}</span>
        <span className="player-toggle-control">
          <input
            id={`${idPrefix}-consent`}
            aria-label={`${labelPrefix} ${t("Agree for data processing")}`}
            type="checkbox"
            checked={draft.consent}
            aria-describedby={managerLocked ? managerGuidanceId : undefined}
            onChange={(event) =>
              update(
                event.currentTarget.checked
                  ? { consent: true }
                  : {
                      consent: false,
                      clubAccess: managerLocked ? draft.clubAccess : "none",
                      firstName: "",
                      lastName: "",
                      email: "",
                    },
              )
            }
          />
          {t("Agree for data processing")}
        </span>
      </label>
      <label htmlFor={`${idPrefix}-club-access`}>
        {t("Club access")}
        <select
          id={`${idPrefix}-club-access`}
          aria-label={`${labelPrefix} ${t("Club access")}`}
          value={draft.clubAccess}
          disabled={busy || managerLocked || !draft.consent}
          aria-describedby={managerLocked ? managerGuidanceId : undefined}
          onChange={(event) =>
            update({ clubAccess: event.currentTarget.value as ProfileDraft["clubAccess"] })
          }
        >
          <option value="none">{t("No club access")}</option>
          <option value="user">{t("Regular user")}</option>
          <option value="manager">{t("Club manager")}</option>
        </select>
      </label>
      <label htmlFor={`${idPrefix}-first-name`}>
        {t("First name")}
        <input
          id={`${idPrefix}-first-name`}
          aria-label={t("Player first name aria", { player: labelPrefix })}
          value={draft.firstName}
          disabled={!draft.consent}
          required={draft.consent}
          maxLength={100}
          onChange={(event) => update({ firstName: event.currentTarget.value })}
        />
      </label>
      <label htmlFor={`${idPrefix}-last-name`}>
        {t("Last name")}
        <input
          id={`${idPrefix}-last-name`}
          aria-label={t("Player last name aria", { player: labelPrefix })}
          value={draft.lastName}
          disabled={!draft.consent}
          required={draft.consent}
          maxLength={100}
          onChange={(event) => update({ lastName: event.currentTarget.value })}
        />
      </label>
      <label htmlFor={`${idPrefix}-email`}>
        {t("Email")}
        <input
          id={`${idPrefix}-email`}
          aria-label={t("Player email aria", { player: labelPrefix })}
          type="email"
          value={draft.email}
          disabled={!draft.consent}
          required={draft.consent}
          maxLength={254}
          onChange={(event) => update({ email: event.currentTarget.value })}
        />
      </label>
    </div>
  );
};

const PlayerCard = ({
  player,
  onUpdate,
  onDelete,
  deletionProtected,
}: {
  readonly player: PlayerProfile;
  readonly onUpdate: PlayersScreenProps["onUpdate"];
  readonly onDelete: PlayersScreenProps["onDelete"];
  readonly deletionProtected: boolean;
}) => {
  const { formatDate, t } = useMessages(playersMusicMessages);
  const { t: iconText } = useMessages(roleIconMessages);
  const { images } = usePlayerRoleAppearance(player.id);
  const [draft, setDraft] = useState(() => draftFromPlayer(player));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setDraft(draftFromPlayer(player));
  }, [player]);

  const statistics = player.statistics;
  const deletionGuidanceId = `player-${player.id}-deletion-guidance`;
  const blockedReason = player.managerLocked
    ? t("Manager locked guidance")
    : deletionProtected
      ? t("Deletion protected guidance")
      : null;
  const winRate =
    statistics.gamesPlayed === 0 ? 0 : Math.round((statistics.wins / statistics.gamesPlayed) * 100);

  return (
    <article
      className="player-profile-card"
      data-player-glass="profile"
      aria-label={t("Player {nickname}", { nickname: player.nickname })}
    >
      <LiquidCardGlass />
      <header>
        <h2>{player.nickname}</h2>
        {player.lastPlayedAt === null ? null : (
          <p className="last-played">
            {t("Last played {date}", { date: formatDate(player.lastPlayedAt) })}
          </p>
        )}
      </header>

      <div className="statistics-summary">
        <div>
          <strong>{statistics.hostedGames}</strong>
          <span>{t("Hosted")}</span>
        </div>
        <div>
          <strong>{statistics.gamesPlayed}</strong>
          <span>{t("Games")}</span>
        </div>
        <div>
          <strong>{statistics.wins}</strong>
          <span>{t("Wins")}</span>
        </div>
        <div>
          <strong>{statistics.losses}</strong>
          <span>{t("Losses")}</span>
        </div>
      </div>
      <p className="win-rate">{t("Win rate {rate}%", { rate: winRate })}</p>
      <dl className="statistics-details">
        <div>
          <dt>{t("Teams")}</dt>
          <dd>
            {t("Red")} {statistics.redWins}/{statistics.redGames} · {t("Black")}{" "}
            {statistics.blackWins}/{statistics.blackGames}
          </dd>
        </div>
        <div>
          <dt>{t("Roles")}</dt>
          <dd>
            {t("Sheriff")} {statistics.sheriffGames} · {t("Citizen")} {statistics.citizenGames} ·{" "}
            {t("Mafia")} {statistics.mafiaGames} · {t("Don")} {statistics.donGames}
          </dd>
        </div>
        <div>
          <dt>{t("Discipline")}</dt>
          <dd>
            {t("Fouls", { count: statistics.totalFouls })} ·{" "}
            {t("Eliminated", { count: statistics.eliminations })} ·{" "}
            {t("Red cards", { count: statistics.redCards })}
          </dd>
        </div>
        <div>
          <dt>{t("Best moves")}</dt>
          <dd>
            {t("Best moves summary", {
              hits: statistics.bestMoveMafiaHits,
              count: statistics.bestMoves,
              moves: t("Moves", { count: statistics.bestMoves }),
            })}
          </dd>
        </div>
      </dl>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          setSaving(true);
          void onUpdate(player.id, toInput(draft))
            .catch((reason: unknown) => {
              reportError(reason, { source: "api", context: "players.update" });
              setError(errorMessage(t, reason));
            })
            .finally(() => setSaving(false));
        }}
      >
        <ProfileFields
          draft={draft}
          idPrefix={`player-${player.id}`}
          labelPrefix={player.nickname}
          busy={saving || deleting}
          managerLocked={player.managerLocked}
          managerGuidanceId={deletionGuidanceId}
          onChange={(next) =>
            setDraft(
              next.consent
                ? next
                : { ...next, roleIcons: withoutUploadedIcons(player.roleIcons, next.roleIcons) },
            )
          }
        />
        <RoleIconFields
          choices={{ ...player.roleIcons, ...draft.roleIcons }}
          draftIdentity={player}
          images={images}
          consent={draft.consent}
          busy={saving || deleting}
          labelPrefix={player.nickname}
          onChange={(role, choice) =>
            setDraft((current) => ({
              ...current,
              roleIcons: { ...current.roleIcons, [role]: choice },
            }))
          }
        />
        {blockedReason === null ? null : (
          <p id={deletionGuidanceId} className="deletion-guidance">
            {blockedReason}
          </p>
        )}
        {error === null ? null : <p role="alert">{error}</p>}
        <div className="player-card-actions">
          <button type="submit" disabled={saving || deleting}>
            {saving ? t("Saving…") : t("Save {nickname}", { nickname: player.nickname })}
          </button>
          <button
            type="button"
            disabled={saving || deleting}
            aria-label={iconText("Cancel player changes", { player: player.nickname })}
            onClick={() => {
              setDraft(draftFromPlayer(player));
              setError(null);
            }}
          >
            {iconText("Cancel")}
          </button>
          {onDelete === undefined || player.managerLocked ? null : (
            <button
              type="button"
              className="danger-action"
              disabled={saving || deleting || blockedReason !== null}
              aria-describedby={blockedReason === null ? undefined : deletionGuidanceId}
              title={
                player.managerLocked
                  ? t("Creator cannot be deleted")
                  : deletionProtected
                    ? t("Clear game before delete")
                    : undefined
              }
              onClick={() => {
                if (!window.confirm(deletionConfirmation(t, player))) {
                  return;
                }
                setError(null);
                setDeleting(true);
                void onDelete(player.id)
                  .catch((reason: unknown) => {
                    reportError(reason, { source: "api", context: "players.delete" });
                    setError(t("Player delete failed"));
                  })
                  .finally(() => setDeleting(false));
              }}
            >
              {deleting ? t("Deleting…") : t("Delete {nickname}", { nickname: player.nickname })}
            </button>
          )}
        </div>
      </form>
    </article>
  );
};

export const PlayersScreen = ({
  players,
  onBack,
  onCreate,
  onUpdate,
  onDelete,
  deletionProtectedPlayerIds,
}: PlayersScreenProps) => {
  const { t } = useMessages(playersMusicMessages);
  const { t: iconText } = useMessages(roleIconMessages);
  const [draft, setDraft] = useState<ProfileDraft>(emptyDraft);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const humanPlayers = players.filter((player) => !isCasperPlayer(player));
  const visiblePlayers = humanPlayers.filter((player) =>
    [player.nickname, player.firstName, player.lastName, player.email]
      .filter((value): value is string => value !== null)
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery)),
  );

  return (
    <main className="players-shell">
      {onBack === undefined ? null : (
        <header className="players-screen-header">
          <button type="button" onClick={onBack}>
            {t("Back to game")}
          </button>
        </header>
      )}
      <GlassSurface
        as="section"
        className="new-player-panel"
        radius={16}
        specular
        aria-labelledby="new-player-title"
      >
        <div className="new-player-heading">
          <h2 id="new-player-title" className="eyebrow">
            {t("New player")}
          </h2>
          <button type="submit" form="new-player-form" className="primary-action" disabled={saving}>
            {saving ? t("Adding…") : t("Add player")}
          </button>
        </div>
        <form
          id="new-player-form"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            setSaving(true);
            void onCreate(toInput(draft))
              .then(() => setDraft(emptyDraft))
              .catch((reason: unknown) => {
                reportError(reason, { source: "api", context: "players.create" });
                setError(errorMessage(t, reason));
              })
              .finally(() => setSaving(false));
          }}
        >
          <ProfileFields
            draft={draft}
            idPrefix="new-player"
            labelPrefix={t("New player")}
            busy={saving}
            managerLocked={false}
            onChange={(next) =>
              setDraft(
                next.consent
                  ? next
                  : { ...next, roleIcons: withoutUploadedIcons(undefined, next.roleIcons) },
              )
            }
          />
          <RoleIconFields
            choices={draft.roleIcons ?? {}}
            consent={draft.consent}
            busy={saving}
            labelPrefix={t("New player")}
            onChange={(role, choice) =>
              setDraft((current) => ({
                ...current,
                roleIcons: { ...current.roleIcons, [role]: choice },
              }))
            }
          />
          <button
            type="button"
            disabled={saving}
            aria-label={iconText("Cancel player changes", { player: t("New player") })}
            onClick={() => {
              setDraft(emptyDraft);
              setError(null);
            }}
          >
            {iconText("Cancel")}
          </button>
          {error === null ? null : <p role="alert">{error}</p>}
        </form>
      </GlassSurface>

      <label className="player-search" htmlFor="player-search">
        <input
          id="player-search"
          type="search"
          aria-label={t("Search players")}
          value={query}
          placeholder={t("Search players placeholder")}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </label>

      {humanPlayers.length === 0 ? (
        <section className="empty-players">
          <h2>{t("No players yet")}</h2>
          <p>{t("Add eleven players")}</p>
        </section>
      ) : visiblePlayers.length === 0 ? (
        <section className="empty-players">
          <h2>{t("No matching players")}</h2>
          <p>{t("Try another search")}</p>
        </section>
      ) : (
        <section className="player-card-grid" aria-label={t("Player profiles")}>
          {visiblePlayers.map((player) => (
            <PlayerCard
              key={player.id}
              player={player}
              onUpdate={onUpdate}
              onDelete={onDelete}
              deletionProtected={deletionProtectedPlayerIds?.has(player.id) ?? false}
            />
          ))}
        </section>
      )}
    </main>
  );
};
