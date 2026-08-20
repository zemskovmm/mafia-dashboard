import { useEffect, useState } from "react";
import { ApiError } from "../../api/client.js";
import type { PlayerProfile, PlayerProfileInput } from "../../api/client.js";

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
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
}

const emptyDraft: ProfileDraft = {
  nickname: "",
  consent: false,
  firstName: "",
  lastName: "",
  email: "",
};

const draftFromPlayer = (player: PlayerProfile): ProfileDraft => ({
  nickname: player.nickname,
  consent: player.consent,
  firstName: player.firstName ?? "",
  lastName: player.lastName ?? "",
  email: player.email ?? "",
});

const toInput = (draft: ProfileDraft): PlayerProfileInput =>
  draft.consent
    ? {
        nickname: draft.nickname.trim(),
        consent: true,
        firstName: draft.firstName.trim(),
        lastName: draft.lastName.trim(),
        email: draft.email.trim(),
      }
    : {
        nickname: draft.nickname.trim(),
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
      };

const errorMessage = (error: unknown): string => {
  if (error instanceof ApiError && error.code === "nickname_conflict") {
    return "That nickname already exists. Choose another nickname.";
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
  onChange,
}: {
  readonly draft: ProfileDraft;
  readonly idPrefix: string;
  readonly labelPrefix: string;
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
      <label className="consent-field" htmlFor={`${idPrefix}-consent`}>
        <input
          id={`${idPrefix}-consent`}
          aria-label={`${labelPrefix} Agree for data processing`}
          type="checkbox"
          checked={draft.consent}
          onChange={(event) =>
            update(
              event.currentTarget.checked
                ? { consent: true }
                : { consent: false, firstName: "", lastName: "", email: "" },
            )
          }
        />
        Agree for data processing
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
  const winRate =
    statistics.gamesPlayed === 0 ? 0 : Math.round((statistics.wins / statistics.gamesPlayed) * 100);

  return (
    <article className="player-profile-card" aria-label={`Player ${player.nickname}`}>
      <header>
        <div>
          <p className="eyebrow">Player profile</p>
          <h2>{player.nickname}</h2>
        </div>
        <p className="last-played">
          {player.lastPlayedAt === null
            ? "Never played"
            : `Last played ${new Date(player.lastPlayedAt).toLocaleDateString()}`}
        </p>
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
      </dl>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          setSaving(true);
          void onUpdate(player.id, toInput(draft))
            .catch((reason: unknown) => setError(errorMessage(reason)))
            .finally(() => setSaving(false));
        }}
      >
        <ProfileFields
          draft={draft}
          idPrefix={`player-${player.id}`}
          labelPrefix={player.nickname}
          onChange={setDraft}
        />
        {error === null ? null : <p role="alert">{error}</p>}
        <button type="submit" disabled={saving || deleting}>
          {saving ? "Saving…" : `Save ${player.nickname}`}
        </button>
        {onDelete === undefined ? null : (
          <>
            {deletionProtected ? (
              <p id={deletionGuidanceId} className="deletion-guidance">
                This player is selected in the current game and cannot be deleted.
              </p>
            ) : null}
            <button
              type="button"
              className="danger-action"
              disabled={saving || deleting || deletionProtected}
              aria-describedby={deletionProtected ? deletionGuidanceId : undefined}
              title={
                deletionProtected
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
                  .catch(() => setError(deleteErrorMessage()))
                  .finally(() => setDeleting(false));
              }}
            >
              {deleting ? "Deleting…" : `Delete ${player.nickname}`}
            </button>
          </>
        )}
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

  return (
    <main className="players-shell">
      <p className="players-roster-note">
        Nicknames are always saved. Personal details are stored only with explicit consent.
      </p>

      <section className="new-player-panel" aria-labelledby="new-player-title">
        <div>
          <p className="eyebrow">Add to roster</p>
          <h2 id="new-player-title">New player</h2>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            setSaving(true);
            void onCreate(toInput(draft))
              .then(() => setDraft(emptyDraft))
              .catch((reason: unknown) => setError(errorMessage(reason)))
              .finally(() => setSaving(false));
          }}
        >
          <ProfileFields
            draft={draft}
            idPrefix="new-player"
            labelPrefix="New player"
            onChange={setDraft}
          />
          {error === null ? null : <p role="alert">{error}</p>}
          <button type="submit" className="primary-action" disabled={saving}>
            {saving ? "Adding…" : "Add player"}
          </button>
        </form>
      </section>

      {players.length === 0 ? (
        <section className="empty-roster">
          <h2>No players yet</h2>
          <p>Add at least ten nicknames before starting a game.</p>
        </section>
      ) : (
        <section className="player-card-grid" aria-label="Player profiles">
          {players.map((player) => (
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
