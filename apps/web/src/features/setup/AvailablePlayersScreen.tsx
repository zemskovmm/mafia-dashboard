import { useState } from "react";
import { X } from "lucide-react";
import type { PlayerProfile } from "../../api/client.js";

interface AvailablePlayersScreenProps {
  readonly players: readonly PlayerProfile[];
  readonly availablePlayerIds: ReadonlySet<string>;
  readonly onAvailabilityChange: (playerId: string, available: boolean) => void;
  readonly onClose: () => void;
}

const PersonIcon = () => (
  <svg viewBox="0 0 48 48" aria-hidden="true" className="person-icon">
    <circle cx="24" cy="15" r="8" />
    <path d="M9 43c1.3-11.1 6.3-16.7 15-16.7S37.7 31.9 39 43" />
  </svg>
);

export const AvailablePlayersScreen = ({
  players,
  availablePlayerIds,
  onAvailabilityChange,
  onClose,
}: AvailablePlayersScreenProps) => {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const availableCount = players.filter(({ id }) => availablePlayerIds.has(id)).length;
  const visiblePlayers = players.filter((player) =>
    [player.nickname, player.firstName, player.lastName, player.email]
      .filter((value): value is string => value !== null)
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery)),
  );

  return (
    <main className="setup-shell is-player-setup is-availability-setup">
      <section className="wizard-card player-setup-card availability-selection-card">
        <header className="availability-selection-header">
          <div>
            <p className="eyebrow">Game setup</p>
            <h1>Available players</h1>
          </div>
          <button
            type="button"
            className="availability-close-button"
            aria-label="Close available players"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </header>

        <label className="availability-search" htmlFor="availability-search">
          <span>Search players</span>
          <input
            id="availability-search"
            type="search"
            aria-label="Search available players"
            value={query}
            placeholder="Search by nickname, name, or email"
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>

        <p className="availability-count">
          {availableCount} available · {players.length} registered
        </p>

        {visiblePlayers.length === 0 ? (
          <div className="availability-empty">No matching players</div>
        ) : (
          <div className="availability-player-grid" role="group" aria-label="Player availability">
            {visiblePlayers.map((player) => {
              const available = availablePlayerIds.has(player.id);
              return (
                <button
                  key={player.id}
                  type="button"
                  className={`table-card player-seat availability-player-card${
                    available ? " is-availability-selected" : ""
                  }`}
                  aria-label={`Mark ${player.nickname} ${available ? "unavailable" : "available"}`}
                  aria-pressed={available}
                  onClick={() => onAvailabilityChange(player.id, !available)}
                >
                  <PersonIcon />
                  <span className="seat-name">{player.nickname}</span>
                  <span className="state-badge">{available ? "Available" : "Tap to select"}</span>
                </button>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
};
