import type { PlayerStatus, Role } from "@mafia/game-domain";
import type { CSSProperties, ReactNode } from "react";
import { useRef } from "react";

export interface TableSeatView {
  readonly seat: number;
  readonly name: string;
  readonly status?: PlayerStatus;
  readonly role?: Role;
  readonly current?: boolean;
  readonly fouls?: number;
  readonly nominated?: boolean;
  readonly muted?: boolean;
  readonly mafiaShooter?: boolean;
  readonly sheriffHighlight?: boolean;
  readonly goodbyeHighlight?: boolean;
  readonly dimmed?: boolean;
  readonly inactive?: boolean;
  readonly provisionalDeceased?: boolean;
  readonly voteTargetSeat?: number;
}

interface GameTableProps {
  readonly seats: readonly TableSeatView[];
  readonly hostName?: string;
  readonly privacyHidden?: boolean;
  readonly seatActionLabel?: (seat: TableSeatView) => string;
  readonly onSeatClick?: (seat: number) => void;
  readonly onSeatSwipeRight?: (seat: number) => void;
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
  onSeatSwipeRight,
  renderSeatActions,
  center,
}: GameTableProps) => {
  const swipeStart = useRef<{
    readonly seat: number;
    readonly x: number;
    readonly y: number;
  } | null>(null);
  const suppressClickSeat = useRef<number | null>(null);
  return (
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
                className={`table-card player-seat status-${seat.status ?? "active"}${seat.current ? " is-current" : ""}${seat.mafiaShooter ? " is-mafia-shooter" : ""}${seat.sheriffHighlight ? " is-sheriff-highlight" : ""}${seat.goodbyeHighlight ? " is-goodbye-highlight" : ""}${seat.dimmed ? " is-dimmed" : ""}${seat.inactive ? " is-inactive" : ""}${seat.provisionalDeceased ? " is-provisional-deceased" : ""}`}
                aria-label={label}
                aria-current={seat.current ? "step" : undefined}
                onTouchStart={(event) => {
                  if (onSeatSwipeRight === undefined) return;
                  const touch = event.touches[0];
                  if (touch !== undefined) {
                    swipeStart.current = { seat: seat.seat, x: touch.clientX, y: touch.clientY };
                  }
                }}
                onTouchEnd={(event) => {
                  const start = swipeStart.current;
                  swipeStart.current = null;
                  if (start?.seat !== seat.seat || onSeatSwipeRight === undefined) return;
                  const touch = event.changedTouches[0];
                  if (touch === undefined) return;
                  const deltaX = touch.clientX - start.x;
                  const deltaY = touch.clientY - start.y;
                  if (deltaX > 44 && Math.abs(deltaX) > Math.abs(deltaY) * 1.2) {
                    suppressClickSeat.current = seat.seat;
                    onSeatSwipeRight(seat.seat);
                    window.setTimeout(() => {
                      if (suppressClickSeat.current === seat.seat) suppressClickSeat.current = null;
                    }, 0);
                  }
                }}
                onTouchCancel={() => {
                  swipeStart.current = null;
                }}
                onClick={() => {
                  if (suppressClickSeat.current === seat.seat) {
                    suppressClickSeat.current = null;
                    return;
                  }
                  onSeatClick?.(seat.seat);
                }}
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
                {seat.voteTargetSeat === undefined ? null : (
                  <span className="state-badge">Vote → #{seat.voteTargetSeat}</span>
                )}
                {seat.status === "eliminated" ? (
                  <span className="deceased-cross" aria-hidden="true" />
                ) : null}
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
};
