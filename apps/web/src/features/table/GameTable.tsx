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

const TABLE_SEAT_COUNT = 10;
const FIRST_SEAT_POSITION_INDEX = 8;

export const GameTable = ({
  seats,
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
        const positionIndex = (FIRST_SEAT_POSITION_INDEX + seat.seat - 1) % TABLE_SEAT_COUNT;
        const angle = (positionIndex / TABLE_SEAT_COUNT) * 360 - 90;
        const label = seatActionLabel?.(seat) ?? `Seat ${seat.seat}: ${seat.name}`;
        return (
          <div
            key={seat.seat}
            className="seat-anchor"
            style={{ "--seat-angle": `${angle}deg` } as CSSProperties}
          >
            <button
              type="button"
              className={`player-seat status-${seat.status ?? "active"}${seat.current ? " is-current" : ""}`}
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
      <div className="host-seat" aria-label="Host position">
        <span className="host-crown">◆</span>
        <span>Host</span>
      </div>
    </div>
  </section>
);
