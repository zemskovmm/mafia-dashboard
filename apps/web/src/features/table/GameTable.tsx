import type { PlayerStatus, Role } from "@mafia/game-domain";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { resolvePlayerLightingKind } from "../effects/PlayerCardLighting.js";
import {
  VgpuPlayerLightingCanvas,
  VgpuTableLightingCanvas,
} from "../effects/vgpu/VgpuLightingCanvas.js";
import { useMessages } from "../../i18n/I18nProvider.js";
import { gameMessages, type GameMessageKey } from "../../i18n/messages/game.js";

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
  readonly nightCheckHighlight?: boolean;
  readonly goodbyeHighlight?: boolean;
  readonly votingHighlight?: boolean;
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
  readonly seatActionDisabled?: (seat: TableSeatView) => boolean;
  readonly onSeatClick?: (seat: number) => void;
  readonly onSeatSwipe?: (seat: number) => void;
  readonly renderSeatActions?: (seat: TableSeatView) => ReactNode;
  readonly swipeAction?: ReactNode;
  readonly onDismissSwipeAction?: () => void;
  readonly contextActionOpen?: boolean;
  readonly center?: ReactNode;
  readonly advance?: ReactNode;
  readonly readOnly?: boolean;
}

const PersonIcon = () => (
  <svg viewBox="0 0 48 48" aria-hidden="true" className="person-icon">
    <circle cx="24" cy="15" r="8" />
    <path d="M9 43c1.3-11.1 6.3-16.7 15-16.7S37.7 31.9 39 43" />
  </svg>
);

const TABLE_POSITION_COUNT = 10;
const FIRST_SEAT_ANGLE = 198;
const roleMessageKeys: Record<Role, GameMessageKey> = {
  citizen: "role.citizen",
  don: "role.don",
  mafia: "role.mafia",
  sheriff: "role.sheriff",
};

export const GameTable = ({
  seats,
  privacyHidden = false,
  seatActionLabel,
  seatActionDisabled,
  onSeatClick,
  onSeatSwipe,
  renderSeatActions,
  swipeAction,
  onDismissSwipeAction,
  contextActionOpen,
  center,
  advance,
  readOnly = false,
}: GameTableProps) => {
  const { t } = useMessages(gameMessages);
  const tableRef = useRef<HTMLElement | null>(null);
  const seatButtonsRef = useRef(new Map<number, HTMLButtonElement>());
  const [keyboardContextSeat, setKeyboardContextSeat] = useState<number | null>(null);
  const actionOpen = contextActionOpen ?? swipeAction !== undefined;
  const swipeStart = useRef<{
    readonly seat: number;
    readonly x: number;
    readonly y: number;
  } | null>(null);
  const suppressClickSeat = useRef<number | null>(null);

  useEffect(() => {
    if (keyboardContextSeat === null) return;
    if (actionOpen) {
      tableRef.current
        ?.querySelector<HTMLButtonElement>("[data-context-action] button:not(:disabled)")
        ?.focus();
      return;
    }
    seatButtonsRef.current.get(keyboardContextSeat)?.focus();
    setKeyboardContextSeat(null);
  }, [actionOpen, keyboardContextSeat]);

  const table = (
    <section
      ref={tableRef}
      className={`table-stage${swipeAction !== undefined && onDismissSwipeAction !== undefined ? " is-context-action-open" : ""}`}
      aria-label={t("game.table")}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || keyboardContextSeat === null || !actionOpen) return;
        event.preventDefault();
        onSeatSwipe?.(keyboardContextSeat);
      }}
    >
      <div className="round-table">
        <VgpuTableLightingCanvas />
        <div className="table-center">{center}</div>
        {swipeAction === undefined ? null : (
          <div
            className="table-swipe-menu"
            role="dialog"
            aria-label={t("table.playerActions")}
            data-context-action
          >
            {swipeAction}
          </div>
        )}
        {readOnly ? null : (
          <div className="table-advance">
            {advance ?? (
              <button type="button" disabled>
                {t("table.continue")}
              </button>
            )}
          </div>
        )}
        {seats.map((seat) => {
          const angle = FIRST_SEAT_ANGLE + ((seat.seat - 1) * 360) / TABLE_POSITION_COUNT;
          const label =
            seatActionLabel?.(seat) ?? t("table.seat", { seat: seat.seat, name: seat.name });
          const disabled = seatActionDisabled?.(seat) ?? false;
          const contextActionAvailable =
            onSeatSwipe !== undefined &&
            !disabled &&
            !seat.inactive &&
            (seat.status ?? "active") === "active";
          const showRole = seat.role !== undefined && !privacyHidden;
          const className = `table-card player-seat status-${seat.status ?? "active"}${seat.current ? " is-current" : ""}${seat.mafiaShooter && !privacyHidden ? " is-mafia-shooter" : ""}${seat.sheriffHighlight && !privacyHidden ? " is-sheriff-highlight" : ""}${seat.nightCheckHighlight && !privacyHidden ? " is-night-check-highlight" : ""}${seat.goodbyeHighlight ? " is-goodbye-highlight" : ""}${seat.votingHighlight ? " is-voting-highlight" : ""}${seat.dimmed && !privacyHidden ? " is-dimmed" : ""}${seat.inactive ? " is-inactive" : ""}${seat.provisionalDeceased ? " is-provisional-deceased" : ""}`;
          const lightingKind = resolvePlayerLightingKind({
            ...seat,
            mafiaShooter: !privacyHidden && seat.mafiaShooter,
            sheriffHighlight: !privacyHidden && seat.sheriffHighlight,
          });
          const content = (
            <>
              <VgpuPlayerLightingCanvas kind={lightingKind} />
              <span className="seat-number">{seat.seat}</span>
              <PersonIcon />
              <span className="seat-name">{seat.name}</span>
              <span className="seat-badges">
                {showRole ? (
                  <span className={`role-badge role-${seat.role}`}>
                    {t(roleMessageKeys[seat.role])}
                  </span>
                ) : null}
                {seat.fouls ? (
                  <span className="foul-badge">{t("table.foulCount", { count: seat.fouls })}</span>
                ) : null}
                {seat.muted ? <span className="state-badge">{t("table.mutedTurn")}</span> : null}
                {seat.nominated ? (
                  <span className="state-badge">{t("table.nominated")}</span>
                ) : null}
                {seat.voteTargetSeat === undefined ? null : (
                  <span className="state-badge">
                    {t("table.voteTarget", { seat: seat.voteTargetSeat })}
                  </span>
                )}
              </span>
              {seat.status === "eliminated" ? (
                <span className="deceased-cross" aria-hidden="true" />
              ) : null}
            </>
          );
          return (
            <div
              key={seat.seat}
              className="seat-anchor"
              data-seat={seat.seat}
              style={{ "--seat-angle": `${angle}deg` } as CSSProperties}
            >
              {readOnly ? (
                <div
                  className={className}
                  role="group"
                  aria-label={label}
                  aria-current={seat.current ? "step" : undefined}
                >
                  {content}
                </div>
              ) : (
                <button
                  ref={(element) => {
                    if (element === null) seatButtonsRef.current.delete(seat.seat);
                    else seatButtonsRef.current.set(seat.seat, element);
                  }}
                  type="button"
                  disabled={disabled}
                  className={className}
                  aria-label={label}
                  aria-current={seat.current ? "step" : undefined}
                  aria-haspopup={contextActionAvailable ? "dialog" : undefined}
                  onTouchStart={(event) => {
                    if (!contextActionAvailable) return;
                    const touch = event.touches[0];
                    if (touch !== undefined) {
                      swipeStart.current = { seat: seat.seat, x: touch.clientX, y: touch.clientY };
                    }
                  }}
                  onTouchEnd={(event) => {
                    const start = swipeStart.current;
                    swipeStart.current = null;
                    if (start?.seat !== seat.seat || !contextActionAvailable) return;
                    const touch = event.changedTouches[0];
                    if (touch === undefined) return;
                    const deltaX = touch.clientX - start.x;
                    const deltaY = touch.clientY - start.y;
                    if (Math.abs(deltaX) > 44 && Math.abs(deltaX) > Math.abs(deltaY) * 1.2) {
                      // The synthetic click after a swipe must not hit the newly mounted backdrop.
                      event.preventDefault();
                      suppressClickSeat.current = seat.seat;
                      onSeatSwipe(seat.seat);
                      window.setTimeout(() => {
                        if (suppressClickSeat.current === seat.seat)
                          suppressClickSeat.current = null;
                      }, 0);
                    }
                  }}
                  onTouchCancel={() => {
                    swipeStart.current = null;
                  }}
                  onKeyDown={(event) => {
                    if (
                      !contextActionAvailable ||
                      (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey))
                    )
                      return;
                    event.preventDefault();
                    setKeyboardContextSeat(seat.seat);
                    onSeatSwipe(seat.seat);
                  }}
                  onClick={() => {
                    if (suppressClickSeat.current === seat.seat) {
                      suppressClickSeat.current = null;
                      return;
                    }
                    onSeatClick?.(seat.seat);
                  }}
                >
                  {content}
                </button>
              )}
              {readOnly || renderSeatActions === undefined ? null : (
                <div className="seat-actions">{renderSeatActions(seat)}</div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
  return (
    <>
      {swipeAction !== undefined && onDismissSwipeAction !== undefined
        ? createPortal(
            <div
              className="table-swipe-backdrop"
              aria-hidden="true"
              onClick={onDismissSwipeAction}
            />,
            document.body,
          )
        : null}
      {table}
    </>
  );
};
