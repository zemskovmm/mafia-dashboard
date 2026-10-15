import type { PlayerStatus, Role } from "@mafia/game-domain";
import type { CSSProperties, ReactNode } from "react";
import { useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Flag, Hand, MessageCircleOff, ThumbsUp, Vote } from "lucide-react";
import { resolvePlayerLightingKind } from "../effects/PlayerCardLighting.js";
import {
  ActivePlayerLighting,
  VgpuPlayerLightingCanvas,
  VgpuTableLightingCanvas,
} from "../effects/vgpu/VgpuLightingCanvas.js";
import { useMessages } from "../../i18n/I18nProvider.js";
import { gameMessages, type GameMessageKey } from "../../i18n/messages/game.js";
import { LiquidCardGlass } from "../theme/LiquidCardGlass.js";
import { PlayerCardAppearanceContext } from "../theme/PlayerCardAppearanceContext.js";
import { usePlayerExits } from "../game/PlayerExitProvider.js";
import { PlayerExitAnimation } from "./PlayerExitAnimation.js";

export interface TableSeatView {
  readonly seat: number;
  readonly name: string;
  readonly status?: PlayerStatus;
  readonly role?: Role;
  readonly current?: boolean;
  readonly currentVoter?: boolean;
  readonly fouls?: number;
  readonly nominated?: boolean;
  readonly supportCount?: number;
  readonly nominationSelected?: boolean;
  readonly muted?: boolean;
  readonly mafiaShooter?: boolean;
  readonly sheriffHighlight?: boolean;
  readonly nightCheckHighlight?: boolean;
  readonly goodbyeHighlight?: boolean;
  readonly votingHighlight?: boolean;
  readonly voted?: boolean;
  readonly dimmed?: boolean;
  readonly inactive?: boolean;
  readonly provisionalDeceased?: boolean;
  readonly voteTargetSeat?: number;
}

interface GameTableProps {
  readonly seats: readonly TableSeatView[];
  readonly animateActive?: boolean;
  readonly hostName?: string;
  readonly privacyHidden?: boolean;
  readonly seatActionLabel?: (seat: TableSeatView) => string;
  readonly seatActionDisabled?: (seat: TableSeatView) => boolean;
  readonly onSeatClick?: (seat: number) => void;
  readonly onSeatSwipe?: (seat: number) => void;
  readonly onSeatPenalty?: (seat: number) => void;
  readonly onSeatFoul?: (seat: number) => void;
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
  animateActive = false,
  privacyHidden = false,
  seatActionLabel,
  seatActionDisabled,
  onSeatClick,
  onSeatSwipe,
  onSeatPenalty,
  onSeatFoul,
  renderSeatActions,
  swipeAction,
  onDismissSwipeAction,
  contextActionOpen,
  center,
  advance,
  readOnly = false,
}: GameTableProps) => {
  const { t } = useMessages(gameMessages);
  const appearance = useContext(PlayerCardAppearanceContext);
  const NominationIcon = appearance.nominationIcon === "flag" ? Flag : Vote;
  const SupportIcon = appearance.supportIcon === "thumbs-up" ? ThumbsUp : Hand;
  const exits = usePlayerExits();
  const tableRef = useRef<HTMLElement | null>(null);
  const seatButtonsRef = useRef(new Map<number, HTMLButtonElement>());
  const [keyboardContextSeat, setKeyboardContextSeat] = useState<number | null>(null);
  const actionOpen = contextActionOpen ?? swipeAction !== undefined;
  const swipeStart = useRef<{
    readonly seat: number;
    readonly identifier: number;
    readonly kind: "touch" | "pointer";
    readonly x: number;
    readonly y: number;
  } | null>(null);
  const suppressClick = useRef<{ seat: number; until: number } | null>(null);

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
      className={`table-stage${animateActive ? " has-active-emphasis" : ""}${swipeAction !== undefined && onDismissSwipeAction !== undefined ? " is-context-action-open" : ""}`}
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
          const foulAvailable = onSeatFoul !== undefined && (seat.status ?? "active") === "active";
          const contextActionAvailable =
            onSeatSwipe !== undefined &&
            !disabled &&
            !seat.inactive &&
            (seat.status ?? "active") === "active";
          const gestureAvailable =
            !readOnly && (contextActionAvailable || !!onSeatPenalty || foulAvailable);
          const cancelGesture = () => {
            const start = swipeStart.current;
            if (start) {
              // The gesture belongs to the table, even when another card cancels it.
              suppressClick.current = { seat: start.seat, until: Date.now() + 400 };
              swipeStart.current = null;
            }
          };
          const finishGesture = (x: number, y: number) => {
            const start = swipeStart.current;
            swipeStart.current = null;
            if (!gestureAvailable || start?.seat !== seat.seat) return false;
            const dx = x - start.x;
            const dy = y - start.y;
            const moved = Math.max(Math.abs(dx), Math.abs(dy)) > 8;
            if (moved) suppressClick.current = { seat: seat.seat, until: Date.now() + 400 };
            const action =
              foulAvailable && dy > 44 && dy > Math.abs(dx) * 1.2
                ? onSeatFoul
                : onSeatPenalty && dy < -44 && -dy > Math.abs(dx) * 1.2
                  ? onSeatPenalty
                  : contextActionAvailable && Math.abs(dx) > 44 && Math.abs(dx) > Math.abs(dy) * 1.2
                    ? onSeatSwipe
                    : undefined;
            if (action) {
              seatButtonsRef.current.get(seat.seat)?.focus();
              action(seat.seat);
            }
            return moved;
          };
          const exit = exits.requests[seat.seat];
          const waiting = seat.status === "eliminated" && exits.waiting.includes(seat.seat);
          const showRole =
            seat.role !== undefined &&
            !privacyHidden &&
            !exit?.hideRole &&
            !(exit && exits.privacyHidden);
          // Voters share speaker visuals, not the current-speaker aria semantics.
          const activeEmphasis = seat.current || seat.currentVoter;
          const className = `table-card player-seat status-${seat.status ?? "active"}${activeEmphasis ? " is-current" : ""}${seat.mafiaShooter && !privacyHidden ? " is-mafia-shooter" : ""}${seat.sheriffHighlight && !privacyHidden ? " is-sheriff-highlight" : ""}${seat.nightCheckHighlight && !privacyHidden ? " is-night-check-highlight" : ""}${seat.goodbyeHighlight ? " is-goodbye-highlight" : ""}${seat.votingHighlight ? " is-voting-highlight" : ""}${seat.voted ? " is-voted" : ""}${seat.dimmed && !privacyHidden ? " is-dimmed" : ""}${seat.inactive ? " is-inactive" : ""}${seat.provisionalDeceased ? " is-provisional-deceased" : ""}${exit ? " is-exiting" : ""}${waiting ? " is-awaiting-goodbye" : ""}`;
          const lightingKind = resolvePlayerLightingKind({
            ...seat,
            current: activeEmphasis,
            mafiaShooter: !privacyHidden && seat.mafiaShooter,
            sheriffHighlight: !privacyHidden && seat.sheriffHighlight,
          });
          const nominationClass = `${seat.nominated ? " is-nominated" : ""}${seat.nominationSelected && appearance.selectionStyle === "check-outline" ? " has-nomination-selection-outline" : ""}`;
          const content = (
            <>
              <LiquidCardGlass />
              {animateActive ? (
                <ActivePlayerLighting active={Boolean(activeEmphasis) && !exit} />
              ) : null}
              <VgpuPlayerLightingCanvas
                kind={exit || (animateActive && lightingKind === "speaker") ? null : lightingKind}
              />
              <PlayerExitAnimation
                request={exit}
                deceased={
                  !waiting && (seat.status === "eliminated" || seat.status === "red-carded")
                }
                onComplete={(id) => exits.complete(seat.seat, id)}
              >
                <span className="seat-number">{seat.seat}</span>
                <PersonIcon />
                {seat.nominated ? (
                  <span
                    className="card-nomination-status"
                    data-treatment={appearance.nominationTreatment}
                  >
                    <span
                      className="card-status-slot card-nomination-symbol"
                      role="img"
                      aria-label={t("table.nominated")}
                    >
                      <NominationIcon aria-hidden="true" />
                    </span>
                    {seat.supportCount ? (
                      <span
                        className="card-status-slot card-support"
                        role="img"
                        aria-label={t("table.supportCount", { count: seat.supportCount })}
                      >
                        <SupportIcon aria-hidden="true" />
                        <span aria-hidden="true">+{seat.supportCount}</span>
                      </span>
                    ) : null}
                  </span>
                ) : null}
                {seat.nominationSelected ? (
                  <span
                    className="card-status-slot card-selection"
                    role="img"
                    aria-label={t("table.currentSelection")}
                  >
                    <Check aria-hidden="true" />
                  </span>
                ) : null}
                <span className="card-discipline-status">
                  {seat.fouls ? (
                    <span
                      className="card-status-slot foul-markers"
                      role="img"
                      aria-label={t("table.foulCount", { count: seat.fouls })}
                    >
                      {Array.from({ length: Math.min(3, seat.fouls) }, (_, index) => (
                        <span key={index} className="foul-dot" aria-hidden="true" />
                      ))}
                    </span>
                  ) : null}
                  {seat.muted ? (
                    <span
                      className="card-status-slot card-mute"
                      role="img"
                      aria-label={t("table.mutedTurn")}
                    >
                      <MessageCircleOff aria-hidden="true" />
                    </span>
                  ) : null}
                </span>
                <span className="seat-name">{seat.name}</span>
                <span className="seat-badges">
                  {showRole ? (
                    <span className={`role-badge role-${seat.role}`}>
                      {t(roleMessageKeys[seat.role])}
                    </span>
                  ) : null}

                  {seat.voteTargetSeat === undefined ? null : (
                    <span className="state-badge">
                      {t("table.voteTarget", { seat: seat.voteTargetSeat })}
                    </span>
                  )}
                </span>
              </PlayerExitAnimation>
            </>
          );
          return (
            <div
              key={seat.seat}
              className="seat-anchor"
              data-seat={seat.seat}
              style={{ "--seat-angle": `${angle}deg` } as CSSProperties}
              onTouchStart={(event) => {
                if (event.touches.length !== 1) {
                  cancelGesture();
                  return;
                }
                swipeStart.current = null;
                suppressClick.current = null;
                if (
                  !gestureAvailable ||
                  event.currentTarget.closest("fieldset:disabled") ||
                  !(event.target as Element).closest(".player-seat")
                )
                  return;
                const touch = event.touches[0]!;
                swipeStart.current = {
                  seat: seat.seat,
                  identifier: touch.identifier,
                  kind: "touch",
                  x: touch.clientX,
                  y: touch.clientY,
                };
              }}
              onTouchMove={(event) => {
                if (event.touches.length !== 1) cancelGesture();
              }}
              onTouchEnd={(event) => {
                const start = swipeStart.current;
                if (start?.kind !== "touch" || start.seat !== seat.seat) return;
                const touch = Array.from(event.changedTouches).find(
                  (touch) => touch.identifier === start.identifier,
                );
                if (!touch) return;
                if (event.currentTarget.closest("fieldset:disabled")) return cancelGesture();
                if (finishGesture(touch.clientX, touch.clientY) && event.cancelable)
                  event.preventDefault();
              }}
              onTouchCancel={cancelGesture}
              onPointerDown={(event) => {
                if (event.pointerType === "touch") return;
                if (event.button !== 0 || event.isPrimary === false) return cancelGesture();
                suppressClick.current = null;
                if (
                  !gestureAvailable ||
                  event.currentTarget.closest("fieldset:disabled") ||
                  !(event.target as Element).closest(".player-seat")
                )
                  return;
                swipeStart.current = {
                  seat: seat.seat,
                  identifier: event.pointerId,
                  kind: "pointer",
                  x: event.clientX,
                  y: event.clientY,
                };
                // Keep capture on the button so an ordinary click still targets it.
                seatButtonsRef.current.get(seat.seat)?.setPointerCapture?.(event.pointerId);
              }}
              onPointerUp={(event) => {
                const start = swipeStart.current;
                if (start?.kind !== "pointer" || start.identifier !== event.pointerId) return;
                if (event.currentTarget.closest("fieldset:disabled")) cancelGesture();
                else finishGesture(event.clientX, event.clientY);
                const button = seatButtonsRef.current.get(seat.seat);
                if (button?.hasPointerCapture?.(event.pointerId))
                  button.releasePointerCapture(event.pointerId);
              }}
              onPointerCancel={cancelGesture}
              onLostPointerCapture={(event) => {
                const start = swipeStart.current;
                // Touch implicitly releases capture before its touchend handler runs.
                if (start?.kind === "pointer" && start.identifier === event.pointerId)
                  cancelGesture();
              }}
              onClickCapture={(event) => {
                if (
                  suppressClick.current?.seat !== seat.seat ||
                  Date.now() > suppressClick.current.until
                )
                  return;
                suppressClick.current = null;
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              {readOnly ? (
                <div
                  className={className + nominationClass}
                  data-player-glass="table"
                  role="group"
                  data-player-exit={exit?.id}
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
                  disabled={disabled && !foulAvailable}
                  aria-disabled={disabled || undefined}
                  className={className + nominationClass}
                  aria-pressed={seat.nominationSelected}
                  style={onSeatPenalty || foulAvailable ? { touchAction: "none" } : undefined}
                  data-player-glass="table"
                  aria-label={label}
                  data-player-exit={exit?.id}
                  aria-current={seat.current ? "step" : undefined}
                  aria-haspopup={contextActionAvailable ? "dialog" : undefined}
                  aria-keyshortcuts={foulAvailable ? "F" : undefined}
                  title={foulAvailable ? t("table.foulHint") : undefined}

                  onKeyDown={(event) => {
                    if (
                      foulAvailable &&
                      event.key.toLowerCase() === "f" &&
                      !event.repeat &&
                      !event.metaKey &&
                      !event.ctrlKey &&
                      !event.altKey &&
                      !event.currentTarget.closest("fieldset:disabled")
                    ) {
                      event.preventDefault();
                      onSeatFoul(seat.seat);
                      return;
                    }
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
                    if (!disabled) onSeatClick?.(seat.seat);
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
