import type { PlayerStatus, Role } from "@mafia/game-domain";
import type { CSSProperties, ReactNode } from "react";

export interface TableSeatView {
  readonly seat: number;
  readonly name: string;
  readonly status?: PlayerStatus;
  readonly role?: Role;
  readonly current?: boolean;
  readonly fouls?: number;
  readonly nominated?: boolean;
  readonly muted?: boolean;
}

interface GameTableProps {
  readonly seats: readonly TableSeatView[];
  readonly hostName?: string;
  readonly privacyHidden?: boolean;
  readonly seatActionLabel?: (seat: TableSeatView) => string;
  readonly onSeatClick?: (seat: number) => void;
  readonly renderSeatActions?: (seat: TableSeatView) => ReactNode;
  readonly center?: ReactNode;
}

const PersonIcon = () => (
  <svg viewBox="0 0 48 48" aria-hidden="true" className="person-icon">
    <circle cx="24" cy="15" r="8" />
    <path d="M9 43c1.3-11.1 6.3-16.7 15-16.7S37.7 31.9 39 43" />
  </svg>
);

const TABLE_POSITION_COUNT = 11;
const HOST_ANGLE = 180;

export const GameTable = ({
  seats,
  hostName = "Host",
  privacyHidden = false,
  seatActionLabel,
  onSeatClick,
  renderSeatActions,
  center,
}: GameTableProps) => (
  <section className="table-stage" aria-label="Mafia table">
    <div className="round-table">
      <div className="table-center">{center}</div>
      {seats.map((seat) => {
        const angle = HOST_ANGLE + (seat.seat * 360) / TABLE_POSITION_COUNT;
        const label = seatActionLabel?.(seat) ?? `Seat ${seat.seat}: ${seat.name}`;
        return (
          <div
            key={seat.seat}
            className="seat-anchor"
            style={{ "--seat-angle": `${angle}deg` } as CSSProperties}
          >
            <button
              type="button"
              className={`table-card player-seat status-${seat.status ?? "active"}${seat.current ? " is-current" : ""}`}
              aria-label={label}
              aria-current={seat.current ? "step" : undefined}
              onClick={() => onSeatClick?.(seat.seat)}
            >
              <span className="seat-number">{seat.seat}</span>
              <PersonIcon />
              <span className="seat-name">{seat.name}</span>
              {seat.role !== undefined && !privacyHidden ? (
                <span className={`role-badge role-${seat.role}`}>{seat.role}</span>
              ) : null}
              {seat.fouls ? <span className="foul-badge">Foul ×{seat.fouls}</span> : null}
              {seat.muted ? <span className="state-badge">Muted turn</span> : null}
              {seat.nominated ? <span className="state-badge">Nominated</span> : null}
            </button>
            {renderSeatActions === undefined ? null : (
              <div className="seat-actions">{renderSeatActions(seat)}</div>
            )}
          </div>
        );
      })}
      <div
        className="seat-anchor host-anchor"
        style={{ "--seat-angle": `${HOST_ANGLE}deg` } as CSSProperties}
      >
        <div className="table-card host-seat" role="group" aria-label={`Host: ${hostName}`}>
          <span className="host-crown">◆</span>
          <span className="host-name">{hostName}</span>
          <span className="host-role">Host</span>
        </div>
      </div>
    </div>
  </section>
);
