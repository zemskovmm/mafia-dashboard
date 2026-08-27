import { useEffect, useState } from "react";
import { ApiError } from "../../api/client.js";
import type { PlayerProfile, PlayerProfileInput } from "../../api/client.js";
import { reportError } from "../console/error-console.js";
import { GlassSurface } from "../theme/GlassSurface.js";

interface PlayersScreenProps {
  readonly players: readonly PlayerProfile[];
  readonly onCreate: (input: PlayerProfileInput) => Promise<void>;
  readonly onUpdate: (playerId: string, input: PlayerProfileInput) => Promise<void>;
  readonly onDelete?: (playerId: string) => Promise<void>;
  readonly deletionProtectedPlayerIds?: ReadonlySet<string>;
}

interface ProfileDraft {
  readonly nickname: string;
  readonly consent: boolean;
  readonly clubManager: boolean;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
}

const emptyDraft: ProfileDraft = {
  nickname: "",
  consent: false,
  clubManager: false,
  firstName: "",
  lastName: "",
  email: "",
};

const draftFromPlayer = (player: PlayerProfile): ProfileDraft => ({
  nickname: player.nickname,
  consent: player.consent,
  clubManager: player.clubManager,
  firstName: player.firstName ?? "",
  lastName: player.lastName ?? "",
  email: player.email ?? "",
});

const toInput = (draft: ProfileDraft): PlayerProfileInput =>
  draft.consent
    ? {
        nickname: draft.nickname.trim(),
        consent: true,
        clubManager: draft.clubManager,
        firstName: draft.firstName.trim(),
        lastName: draft.lastName.trim(),
        email: draft.email.trim(),
      }
    : {
        nickname: draft.nickname.trim(),
        consent: false,
        clubManager: draft.clubManager,
        firstName: null,
        lastName: null,
        email: null,
      };

const errorMessage = (error: unknown): string => {
  if (error instanceof ApiError && error.code === "nickname_conflict") {
    return "That nickname already exists. Choose another nickname.";
  }
  if (error instanceof ApiError && error.code === "manager_email_conflict") {
    return "That email is already assigned to another club manager.";
  }
  return "The player could not be saved. Please try again.";
};

const deleteErrorMessage = (): string => {
  return "The player could not be deleted. Please try again.";
};

const deletionConfirmation = (player: PlayerProfile): string => {
  const gameCount = player.statistics.hostedGames + player.statistics.gamesPlayed;
  if (gameCount === 0) return `Delete player "${player.nickname}"? This cannot be undone.`;
  return `Delete player "${player.nickname}" and ${gameCount} associated ${gameCount === 1 ? "game" : "games"}? Those games will also be removed from every affected player's statistics. This cannot be undone.`;
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
  const update = (changes: Partial<ProfileDraft>) => onChange({ ...draft, ...changes });
  return (
    <div className="player-profile-fields">
      <label htmlFor={`${idPrefix}-nickname`}>
        Nickname
        <input
          id={`${idPrefix}-nickname`}
          aria-label={`${labelPrefix} nickname`}
          value={draft.nickname}
          maxLength={80}
          required
          onChange={(event) => update({ nickname: event.currentTarget.value })}
        />
      </label>
      <label className="player-toggle-field" htmlFor={`${idPrefix}-consent`}>
        <span>Data processing</span>
        <span className="player-toggle-control">
          <input
            id={`${idPrefix}-consent`}
            aria-label={`${labelPrefix} Agree for data processing`}
            type="checkbox"
            checked={draft.consent}
            aria-describedby={managerLocked ? managerGuidanceId : undefined}
            onChange={(event) =>
              update(
                event.currentTarget.checked
                  ? { consent: true }
                  : {
                      consent: false,
                      clubManager: managerLocked ? draft.clubManager : false,
                      firstName: "",
                      lastName: "",
                      email: "",
                    },
              )
            }
          />
          Agree for data processing
        </span>
      </label>
      <label className="player-toggle-field" htmlFor={`${idPrefix}-club-manager`}>
        <span>Club manager</span>
        <span className="player-toggle-control">
          <input
            id={`${idPrefix}-club-manager`}
            aria-label={`${labelPrefix} Club manager`}
            type="checkbox"
            checked={draft.clubManager}
            disabled={busy || managerLocked || !draft.consent}
            aria-describedby={managerLocked ? managerGuidanceId : undefined}
            onChange={(event) => update({ clubManager: event.currentTarget.checked })}
          />
          Club manager
        </span>
      </label>
      <label htmlFor={`${idPrefix}-first-name`}>
        First name
        <input
          id={`${idPrefix}-first-name`}
          aria-label={`${labelPrefix} first name`}
          value={draft.firstName}
          disabled={!draft.consent}
          required={draft.consent}
          maxLength={100}
          onChange={(event) => update({ firstName: event.currentTarget.value })}
        />
      </label>
      <label htmlFor={`${idPrefix}-last-name`}>
        Last name
        <input
          id={`${idPrefix}-last-name`}
          aria-label={`${labelPrefix} last name`}
          value={draft.lastName}
          disabled={!draft.consent}
          required={draft.consent}
          maxLength={100}
          onChange={(event) => update({ lastName: event.currentTarget.value })}
        />
      </label>
      <label htmlFor={`${idPrefix}-email`}>
        Email
        <input
          id={`${idPrefix}-email`}
          aria-label={`${labelPrefix} email`}
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
    ? "Manager access remains linked to the club creator while personal profile data is removed after consent withdrawal. The Owner player profile cannot be deleted."
    : deletionProtected
      ? "This player is selected in the current game and cannot be deleted."
      : null;
  const winRate =
    statistics.gamesPlayed === 0 ? 0 : Math.round((statistics.wins / statistics.gamesPlayed) * 100);

  return (
    <article className="player-profile-card" aria-label={`Player ${player.nickname}`}>
      <header>
        <h2>{player.nickname}</h2>
        {player.lastPlayedAt === null ? null : (
          <p className="last-played">
            Last played {new Date(player.lastPlayedAt).toLocaleDateString()}
          </p>
        )}
      </header>

      <div className="statistics-summary">
        <div>
          <strong>{statistics.hostedGames}</strong>
          <span>Hosted</span>
        </div>
        <div>
          <strong>{statistics.gamesPlayed}</strong>
          <span>Games</span>
        </div>
        <div>
          <strong>{statistics.wins}</strong>
          <span>Wins</span>
        </div>
        <div>
          <strong>{statistics.losses}</strong>
          <span>Losses</span>
        </div>
      </div>
      <p className="win-rate">{winRate}% win rate</p>
      <dl className="statistics-details">
        <div>
          <dt>Teams</dt>
          <dd>
            Red {statistics.redWins}/{statistics.redGames} · Black {statistics.blackWins}/
            {statistics.blackGames}
          </dd>
        </div>
        <div>
          <dt>Roles</dt>
          <dd>
            Sheriff {statistics.sheriffGames} · Citizen {statistics.citizenGames} · Mafia{" "}
            {statistics.mafiaGames} · Don {statistics.donGames}
          </dd>
        </div>
        <div>
          <dt>Discipline</dt>
          <dd>
            {statistics.totalFouls} fouls · {statistics.eliminations} eliminated ·{" "}
            {statistics.redCards} red cards
          </dd>
        </div>
        <div>
          <dt>Best moves</dt>
          <dd>
            {statistics.bestMoveMafiaHits} Mafia hits across {statistics.bestMoves}{" "}
            {statistics.bestMoves === 1 ? "move" : "moves"}
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
              setError(errorMessage(reason));
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
          onChange={setDraft}
        />
        {blockedReason === null ? null : (
          <p id={deletionGuidanceId} className="deletion-guidance">
            {blockedReason}
          </p>
        )}
        {error === null ? null : <p role="alert">{error}</p>}
        <div className="player-card-actions">
          <button type="submit" disabled={saving || deleting}>
            {saving ? "Saving…" : `Save ${player.nickname}`}
          </button>
          {onDelete === undefined || player.managerLocked ? null : (
            <button
              type="button"
              className="danger-action"
              disabled={saving || deleting || blockedReason !== null}
              aria-describedby={blockedReason === null ? undefined : deletionGuidanceId}
              title={
                player.managerLocked
                  ? "The club creator's player profile cannot be deleted."
                  : deletionProtected
                    ? "Clear the current game state before deleting this player."
                    : undefined
              }
              onClick={() => {
                if (!window.confirm(deletionConfirmation(player))) {
                  return;
                }
                setError(null);
                setDeleting(true);
                void onDelete(player.id)
                  .catch((reason: unknown) => {
                    reportError(reason, { source: "api", context: "players.delete" });
                    setError(deleteErrorMessage());
                  })
                  .finally(() => setDeleting(false));
              }}
            >
              {deleting ? "Deleting…" : `Delete ${player.nickname}`}
            </button>
          )}
        </div>
      </form>
    </article>
  );
};

export const PlayersScreen = ({
  players,
  onCreate,
  onUpdate,
  onDelete,
  deletionProtectedPlayerIds,
}: PlayersScreenProps) => {
  const [draft, setDraft] = useState<ProfileDraft>(emptyDraft);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visiblePlayers = players.filter((player) =>
    [player.nickname, player.firstName, player.lastName, player.email]
      .filter((value): value is string => value !== null)
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery)),
  );

  return (
    <main className="players-shell">
      <GlassSurface
        as="section"
        className="new-player-panel"
        radius={16}
        specular
        aria-labelledby="new-player-title"
      >
        <div className="new-player-heading">
          <h2 id="new-player-title" className="eyebrow">
            New player
          </h2>
          <button type="submit" form="new-player-form" className="primary-action" disabled={saving}>
            {saving ? "Adding…" : "Add player"}
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
                setError(errorMessage(reason));
              })
              .finally(() => setSaving(false));
          }}
        >
          <ProfileFields
            draft={draft}
            idPrefix="new-player"
            labelPrefix="New player"
            busy={saving}
            managerLocked={false}
            onChange={setDraft}
          />
          {error === null ? null : <p role="alert">{error}</p>}
        </form>
      </GlassSurface>

      <label className="player-search" htmlFor="player-search">
        <span>Search players</span>
        <input
          id="player-search"
          type="search"
          value={query}
          placeholder="Search by nickname, name, or email"
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </label>

      {players.length === 0 ? (
        <section className="empty-players">
          <h2>No players yet</h2>
          <p>Add at least eleven nicknames before starting a game.</p>
        </section>
      ) : visiblePlayers.length === 0 ? (
        <section className="empty-players">
          <h2>No matching players</h2>
          <p>Try another search.</p>
        </section>
      ) : (
        <section className="player-card-grid" aria-label="Player profiles">
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
