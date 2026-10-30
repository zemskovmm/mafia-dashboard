import { getRoleTeam, type PlayerStatus, type Role, type Winner } from "@mafia/game-domain";
import type { CSSProperties, ReactNode } from "react";
import { useContext, useRef } from "react";
import { Hand, MessageCircleOff } from "lucide-react";
import { resolvePlayerLightingKind } from "../effects/PlayerCardLighting.js";
import {
  ActivePlayerLighting,
  VgpuPlayerLightingCanvas,
  VgpuTableLightingCanvas,
} from "../effects/vgpu/VgpuLightingCanvas.js";
import { useMessages } from "../../i18n/I18nProvider.js";
import { gameMessages } from "../../i18n/messages/game.js";
import { LiquidCardGlass } from "../theme/LiquidCardGlass.js";
import { PlayerCardAppearanceContext } from "../theme/PlayerCardAppearanceContext.js";
import { PlayerCardStyleContext } from "../theme/PlayerCardStyleContext.js";
import { PrintedPlayerCard } from "./PrintedPlayerCard.js";
import { cardSuit, CARD_SUIT_SYMBOLS } from "./card-suit.js";
import { CardGameIdentityContext } from "./CardGameIdentityContext.js";
import { PlayerRoleIcon } from "./PlayerRoleIcon.js";
import { usePlayerExits } from "../game/PlayerExitProvider.js";
import { PlayerExitAnimation } from "./PlayerExitAnimation.js";
import { departurePresentationStyle } from "./PlayerDepartureEffects.js";
import { PlayerFeedback } from "./PlayerFeedback.js";
import { DEFAULT_PLAYER_EXIT_SETTINGS } from "../effects/player-exit-preferences.js";
import "./GameTable.css";
import { PlayerCardCaption } from "./PlayerCardCaption.js";
import {
  RoleDrawGlow,
  RoleDrawPresentation,
  type RoleDrawRequest,
} from "./RoleDrawPresentation.js";

export interface TableSeatView {
  readonly playerId?: string;
  readonly seat: number;
  readonly name: string;
  readonly status?: PlayerStatus;
  readonly role?: Role;
  /** Explicit giveaway-only facts; preview roles are never dealt assignments. */
  readonly roleDraw?: Readonly<{ dealt: boolean; role?: Role; request?: RoleDrawRequest }>;
  readonly current?: boolean;
  readonly currentVoter?: boolean;
  readonly votingCandidate?: boolean;
  readonly fouls?: number;
  readonly nominated?: boolean;
  readonly supportCount?: number;
  readonly nominationSelected?: boolean;
  readonly pressed?: boolean;
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
  readonly completed?: boolean;
  readonly winner?: Winner;
  readonly animateActive?: boolean;
  readonly hostName?: string;
  readonly privacyHidden?: boolean;
  readonly seatActionLabel?: (seat: TableSeatView) => string;
  readonly seatActionDisabled?: (seat: TableSeatView) => boolean;
  readonly onSeatClick?: (seat: number) => void;
  readonly onRoleDrawComplete?: (seat: number, id: number) => void;
  readonly onSeatSwipe?: (seat: number) => void;
  readonly onSeatPenalty?: (seat: number) => void;
  readonly onSeatFoul?: (seat: number) => void;
  readonly renderSeatActions?: (seat: TableSeatView) => ReactNode;
  readonly center?: ReactNode;
  readonly advance?: ReactNode;
  readonly readOnly?: boolean;
}

const TABLE_POSITION_COUNT = 10;
const FIRST_SEAT_ANGLE = 198;

export const GameTable = ({
  seats,
  completed = false,
  winner = null,
  animateActive = false,
  privacyHidden: requestedPrivacyHidden = false,
  seatActionLabel,
  seatActionDisabled,
  onSeatClick,
  onRoleDrawComplete,
  onSeatSwipe,
  onSeatPenalty,
  onSeatFoul,
  renderSeatActions,
  center,
  advance,
  readOnly = false,
}: GameTableProps) => {
  const { t } = useMessages(gameMessages);
  const appearance = useContext(PlayerCardAppearanceContext);
  const cardPreferences = useContext(PlayerCardStyleContext);
  const printed = cardPreferences.style !== "glass";
  const gameId = useContext(CardGameIdentityContext);
  const exits = usePlayerExits();
  const privacyHidden = requestedPrivacyHidden && !completed;
  const seatButtonsRef = useRef(new Map<number, HTMLButtonElement>());
  const swipeStart = useRef<{
    readonly seat: number;
    readonly identifier: number;
    readonly kind: "touch" | "pointer";
    readonly x: number;
    readonly y: number;
  } | null>(null);
  const suppressClick = useRef<{ seat: number; until: number } | null>(null);

  const table = (
    <section
      className={`table-stage${animateActive ? " has-active-emphasis" : ""}`}
      aria-label={t("game.table")}
    >
      <div className="round-table">
        <VgpuTableLightingCanvas />
        <div className="table-center">{center}</div>
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
          const horizontalActionAvailable =
            onSeatSwipe !== undefined &&
            !disabled &&
            !seat.inactive &&
            (seat.status ?? "active") === "active";
          const gestureAvailable =
            !readOnly &&
            (horizontalActionAvailable ||
              !!onSeatPenalty ||
              foulAvailable ||
              onSeatClick !== undefined);
          // Native horizontal panning cancels role-touch completion. Reserve only enabled axes.
          const touchAction =
            onSeatPenalty || foulAvailable
              ? "none"
              : horizontalActionAvailable
                ? "pan-y pinch-zoom"
                : undefined;
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
                  : horizontalActionAvailable &&
                      Math.abs(dx) > 44 &&
                      Math.abs(dx) > Math.abs(dy) * 1.2
                    ? onSeatSwipe
                    : undefined;
            if (action) {
              action(seat.seat);
            }
            return moved;
          };
          const exit = completed ? undefined : exits.requests[seat.seat];
          const roleDraw = privacyHidden || completed ? undefined : seat.roleDraw;
          const visibleRole = roleDraw ? roleDraw.role : seat.role;
          const waiting =
            seat.status === "eliminated" && exits.pendingDepartures.includes(seat.seat);
          const showRole =
            visibleRole !== undefined &&
            !privacyHidden &&
            !exit?.hideRole &&
            !(exit && exits.privacyHidden);
          const departed =
            !completed &&
            !waiting &&
            !seat.provisionalDeceased &&
            (seat.status === "eliminated" || seat.status === "red-carded");
          const printedPrivacy = Boolean(
            privacyHidden || exit?.hideRole || (exit && exits.privacyHidden),
          );
          const departureCause = departed
            ? (exits.endpoints[seat.seat] ??
              (seat.status === "red-carded" ? "discipline" : "unknown"))
            : undefined;
          const departureStyle = departurePresentationStyle(
            departureCause,
            exit?.settings ?? exits.settings ?? DEFAULT_PLAYER_EXIT_SETTINGS,
          );
          const printedFaceDown =
            printed &&
            (printedPrivacy || departed || (roleDraw !== undefined && visibleRole === undefined));
          const privateCuesVisible = !privacyHidden && !printedFaceDown;
          // Voters share speaker visuals, not the current-speaker aria semantics.
          const activeEmphasis = !completed && (seat.current || seat.currentVoter);
          const winningTeam =
            completed && seat.role && getRoleTeam(seat.role) === winner ? winner : undefined;
          const completionClass = completed ? " is-game-complete" : "";
          const className = `table-card player-seat status-${seat.status ?? "active"}${activeEmphasis ? " is-current" : ""}${seat.mafiaShooter && privateCuesVisible ? " is-mafia-shooter" : ""}${seat.sheriffHighlight && privateCuesVisible ? " is-sheriff-highlight" : ""}${seat.nightCheckHighlight && privateCuesVisible ? " is-night-check-highlight" : ""}${seat.goodbyeHighlight ? " is-goodbye-highlight" : ""}${seat.votingHighlight ? " is-voting-highlight" : ""}${seat.voted ? " is-voted" : ""}${seat.dimmed && !privacyHidden ? " is-dimmed" : ""}${seat.inactive ? " is-inactive" : ""}${seat.provisionalDeceased ? " is-provisional-deceased" : ""}${exit ? " is-exiting" : ""}${waiting ? " is-awaiting-goodbye" : ""}`;
          const lightingKind = resolvePlayerLightingKind({
            ...seat,
            current: activeEmphasis,
            mafiaShooter: privateCuesVisible && seat.mafiaShooter,
            sheriffHighlight: privateCuesVisible && seat.sheriffHighlight,
          });
          const nominationClass = `${seat.nominated ? " is-nominated" : ""}${seat.nominationSelected ? " is-nomination-selected" : ""}${seat.votingCandidate ? " is-voting-candidate" : ""}`;
          const suit = cardSuit(gameId, seat.playerId);
          const index = (lower: boolean) => (
            <span className={`card-index${lower ? " card-index--lower" : ""}`} aria-hidden="true">
              <span className="seat-number">{seat.seat}</span>
              <span className="card-suit">{suit === null ? "◇" : CARD_SUIT_SYMBOLS[suit]}</span>
            </span>
          );
          const roleDrawClass =
            roleDraw && !printedFaceDown
              ? ` role-draw-card${roleDraw.dealt ? " is-role-dealt" : roleDraw.role ? " role-draw-preview" : ""}${roleDraw.request ? " is-role-flipping" : ""}`
              : "";
          const statusRails = (
            <>
              <span
                className="card-nomination-status"
                data-treatment={appearance.nominationTreatment}
              >
                {seat.nominated ? (
                  <span
                    className="card-status-slot card-nomination-symbol"
                    role="img"
                    aria-label={t("table.nominated")}
                  >
                    <Hand aria-hidden="true" />
                  </span>
                ) : null}
                {seat.nominated && seat.supportCount ? (
                  <span
                    className="card-status-slot card-support"
                    role="img"
                    aria-label={t("table.supportCount", { count: seat.supportCount })}
                  >
                    <span aria-hidden="true">+{seat.supportCount}</span>
                  </span>
                ) : null}
              </span>
              <PlayerFeedback
                className="card-discipline-status"
                request={exits.feedback[seat.seat]}
              >
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
              </PlayerFeedback>
            </>
          );
          const voteBadge = (
            <span className="seat-badges">
              {seat.voteTargetSeat === undefined ? null : (
                <span className="state-badge">
                  {t("table.voteTarget", { seat: seat.voteTargetSeat })}
                </span>
              )}
            </span>
          );
          const face = (faceRole: Role | undefined) => (
            <>
              {index(false)}
              {index(true)}
              <PlayerRoleIcon
                role={showRole ? faceRole : undefined}
                playerId={seat.playerId}
                unknown={roleDraw !== undefined && faceRole === undefined}
              />
              {statusRails}
              {voteBadge}
            </>
          );
          const content = (
            <>
              {!printed ? <LiquidCardGlass /> : null}
              {roleDraw?.dealt && !printedFaceDown ? <RoleDrawGlow /> : null}
              {animateActive ? (
                <ActivePlayerLighting active={Boolean(activeEmphasis) && !exit} />
              ) : null}
              <VgpuPlayerLightingCanvas
                kind={
                  completed || exit || (animateActive && lightingKind === "speaker")
                    ? null
                    : lightingKind
                }
              />
              {cardPreferences.style !== "glass" ? (
                <PrintedPlayerCard
                  style={cardPreferences.style}
                  seat={seat.seat}
                  suit={suit === null ? "◇" : CARD_SUIT_SYMBOLS[suit]}
                  role={showRole && !printedFaceDown ? visibleRole : undefined}
                  rolePlacement={cardPreferences.rolePlacement}
                  faceDown={printedFaceDown}
                  privacyHidden={printedPrivacy}
                  roleDrawRequest={roleDraw?.request}
                  exitRequest={departed ? exit : undefined}
                  departureCause={departureCause}
                  onRoleDrawComplete={(id) => onRoleDrawComplete?.(seat.seat, id)}
                  onExitComplete={(id) => exits.complete(seat.seat, id)}
                >
                  {statusRails}
                  {voteBadge}
                </PrintedPlayerCard>
              ) : roleDraw ? (
                <RoleDrawPresentation
                  role={visibleRole}
                  request={roleDraw.request}
                  onComplete={(id) => onRoleDrawComplete?.(seat.seat, id)}
                >
                  {face}
                </RoleDrawPresentation>
              ) : (
                <PlayerExitAnimation
                  request={exit}
                  departureCause={departureCause}
                  reverse={
                    <>
                      {index(false)}
                      {index(true)}
                      {statusRails}
                      {voteBadge}
                    </>
                  }
                  deceased={
                    !completed &&
                    !waiting &&
                    (seat.status === "eliminated" || seat.status === "red-carded")
                  }
                  onComplete={(id) => exits.complete(seat.seat, id)}
                >
                  {face(visibleRole)}
                </PlayerExitAnimation>
              )}
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
                  className={className + nominationClass + roleDrawClass + completionClass}
                  data-winner-team={winningTeam}
                  data-role-draw-role={printedFaceDown ? undefined : roleDraw?.role}
                  data-role-dealt={printedFaceDown ? undefined : roleDraw?.dealt}
                  data-role-draw-flip={roleDraw?.request?.id}
                  data-player-glass={printed ? undefined : "table"}
                  data-card-style={cardPreferences.style}
                  data-card-face={
                    completed ? "front" : printed ? (printedFaceDown ? "back" : "front") : undefined
                  }
                  role="group"
                  data-player-exit={exit?.id}
                  data-departure-cause={departureCause}
                  style={departureStyle}
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
                  className={className + nominationClass + roleDrawClass + completionClass}
                  data-winner-team={winningTeam}
                  data-role-draw-role={printedFaceDown ? undefined : roleDraw?.role}
                  data-role-dealt={printedFaceDown ? undefined : roleDraw?.dealt}
                  data-role-draw-flip={roleDraw?.request?.id}
                  aria-pressed={seat.pressed ?? seat.nominationSelected}
                  style={{ ...departureStyle, touchAction }}
                  data-player-glass={printed ? undefined : "table"}
                  data-card-style={cardPreferences.style}
                  data-card-face={
                    completed ? "front" : printed ? (printedFaceDown ? "back" : "front") : undefined
                  }
                  aria-label={label}
                  data-player-exit={exit?.id}
                  data-departure-cause={departureCause}
                  aria-current={seat.current ? "step" : undefined}
                  aria-haspopup={horizontalActionAvailable ? "dialog" : undefined}
                  title={foulAvailable ? t("table.foulHint") : undefined}

                  onClick={() => {
                    if (!disabled) onSeatClick?.(seat.seat);
                  }}
                >
                  {content}
                </button>
              )}
              <PlayerCardCaption name={seat.name} />
              {readOnly || renderSeatActions === undefined ? null : (
                <div className="seat-actions">{renderSeatActions(seat)}</div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
  return table;
};
