import { useLayoutEffect, useRef, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { getRoleTeam } from "@mafia/game-domain";
import { Hand, MessageCircleOff, Plus, ShieldAlert } from "lucide-react";
import { useMessages } from "../../i18n/I18nProvider.js";
import { ledgerMessages } from "../../i18n/messages/ledger.js";
import { ledgerHistoryMessages } from "../../i18n/messages/ledger-history.js";
import { usePlayerExits } from "../game/PlayerExitProvider.js";
import type { HostBoardProps, LedgerScrollPosition } from "../game/HostBoard.js";
import type { LedgerFact, LedgerModel } from "./ledger-types.js";
import "./GameLedger.css";

export const GameLedger = ({
  seats,
  model,
  currentPeriod,
  scrollPosition,
  controlsTarget = null,
  phaseTools,
  completed = false,
  winner = null,
  privacyHidden: requestedPrivacyHidden = false,
  seatActionLabel,
  seatActionDisabled,
  onSeatClick,
  onSeatPenalty,
  onSeatFoul,
  renderSeatActions,
  center,
  advance,
  readOnly = false,
}: HostBoardProps & {
  readonly model: LedgerModel;
  readonly currentPeriod: "day" | "night" | null;
  readonly scrollPosition?: RefObject<LedgerScrollPosition>;
  readonly controlsTarget?: HTMLDivElement | null;
}) => {
  const { t } = useMessages(ledgerMessages);
  const history = useMessages(ledgerHistoryMessages);
  const exits = usePlayerExits();
  const scrollRef = useRef<HTMLDivElement>(null);
  const privacyHidden = requestedPrivacyHidden && !completed;
  const rounds = model.columns.filter(({ day }) => day > 0);
  // Reserve future space in the presentation only, never in the game/history model.
  while (rounds.length < 4) rounds.push({ day: rounds.length + 1, current: false });
  const columns = rounds.flatMap((column) =>
    (["day", "night"] as const).map((period) => ({
      ...column,
      period,
      current: column.current && period === currentPeriod,
    })),
  );
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !scrollPosition) return;
    const restore = () => {
      const current = element.querySelector<HTMLElement>("thead .ledger-current-day");
      const period = element.querySelector("thead [data-ledger-period]");
      const initialLeft =
        (Number(current?.dataset.ledgerDay ?? 1) - 1) *
        2 *
        (period?.getBoundingClientRect().width ?? 0);
      element.scrollLeft =
        scrollPosition.current.left < 0 ? initialLeft : scrollPosition.current.left;
      element.scrollTop = scrollPosition.current.top;
    };
    restore();
    // The utility rail can settle after mount; preserve the initial target until scrolling occurs.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(restore);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [scrollPosition]);
  const fact = (value: LedgerFact) => (
    <span key={value.id} className={`ledger-fact${value.provisional ? " is-provisional" : ""}`}>
      {history.t(value.kind, value.values)}
      {value.provisional && <em>{t("draft")}</em>}
    </span>
  );
  const controls =
    center || advance || phaseTools || readOnly || !model.historyAvailable ? (
      <div className="ledger-phase-bar">
        {center && <div className="ledger-prompt">{center}</div>}
        {!readOnly && advance && <div className="ledger-advance">{advance}</div>}
        {!readOnly && phaseTools}
        {readOnly && <span className="ledger-readonly">{t("readOnly")}</span>}
        {!model.historyAvailable && <span className="ledger-readonly">{t("unavailable")}</span>}
      </div>
    ) : null;
  return (
    <section className="game-ledger" aria-label={t("title")}>
      {controlsTarget === null ? controls : createPortal(controls, controlsTarget)}
      <div
        className="ledger-scroll"
        ref={scrollRef}
        role="region"
        aria-label={t("scroll")}
        onScroll={(event) => {
          if (scrollPosition)
            scrollPosition.current = {
              left: event.currentTarget.scrollLeft,
              top: event.currentTarget.scrollTop,
            };
        }}
      >
        <table
          className="ledger-table"
          aria-label={t("title")}
          style={{ "--ledger-period-count": columns.length } as CSSProperties}
        >
          <colgroup>
            <col className="ledger-identity-column" />
            <col className="ledger-action-column" />
            {columns.map(({ day, period }) => (
              <col key={`${day}:${period}`} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th scope="col">{t("player")}</th>
              <th scope="col">{t("status")}</th>
              {columns.map(({ day, period, current }) => (
                <th
                  key={`${day}:${period}`}
                  scope="col"
                  data-ledger-day={day}
                  data-ledger-period={period}
                  className={current ? "ledger-current-day" : undefined}
                >
                  <strong>
                    {period === "night"
                      ? t("night", { night: day + 1 })
                      : day === 1
                        ? t("zero")
                        : t("day", { day: day - 1 })}
                  </strong>
                  {current && <span>{t("current")}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {model.rows.map((row) => {
              const seat = seats.find((value) => value.seat === row.seat);
              if (!seat) return null;
              const waiting =
                seat.status === "eliminated" && exits.pendingDepartures.includes(seat.seat);
              const departed =
                !waiting &&
                !seat.provisionalDeceased &&
                (seat.status === "eliminated" || seat.status === "red-carded");
              const exit = completed ? undefined : exits.requests[seat.seat];
              const showRole =
                seat.role !== undefined &&
                !privacyHidden &&
                !exit?.hideRole &&
                !(exit && exits.privacyHidden);
              const winning = completed && seat.role && getRoleTeam(seat.role) === winner;
              const current =
                !completed && (seat.current || seat.currentVoter || seat.votingCandidate);
              const selected = seat.pressed ?? seat.nominationSelected ?? seat.voted;
              const action = seatActionLabel?.(seat);
              return (
                <tr
                  key={`${row.playerId}:${row.seat}`}
                  data-ledger-seat={row.seat}
                  className={`${current ? "is-current " : ""}${departed ? "is-departed " : ""}${selected ? "is-selected " : ""}${winning ? "is-winner" : ""}`}
                >
                  <th scope="row">
                    <div className="ledger-player">
                      <span className="ledger-seat">{seat.seat}</span>
                      <div>
                        <strong title={seat.name}>{seat.name}</strong>
                        <span
                          className={`ledger-role${showRole && seat.role ? ` role-${seat.role}` : ""}`}
                        >
                          {showRole && seat.role ? t(seat.role) : t("hidden")}
                          {departed
                            ? ` · ${t(seat.status === "red-carded" ? "removed" : "eliminated")}`
                            : ""}
                        </span>
                      </div>
                      {current && (
                        <span className="ledger-current-marker" aria-label={t("currentPlayer")} />
                      )}
                    </div>
                  </th>
                  <td className="ledger-actions">
                    <div className="ledger-player-state">
                      {(seat.fouls ?? 0) > 0 && (
                        <span
                          className="ledger-fouls"
                          aria-label={t("fouls", { count: seat.fouls ?? 0 })}
                        >
                          {"●".repeat(seat.fouls ?? 0)}
                        </span>
                      )}
                      {seat.muted && <MessageCircleOff aria-label={t("muted")} />}
                      {seat.nominated && (
                        <span className="ledger-nomination" aria-label={t("nominated")}>
                          <Hand aria-hidden="true" />
                          {(seat.supportCount ?? 0) > 0 && (
                            <span aria-label={t("supporters", { count: seat.supportCount ?? 0 })}>
                              +{seat.supportCount}
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                    {!readOnly && !completed && (
                      <div className="ledger-row-controls">
                        {onSeatClick && action && (
                          <button
                            className="ledger-player-action"
                            type="button"
                            aria-label={action}
                            title={action}
                            disabled={seatActionDisabled?.(seat) ?? false}
                            aria-pressed={selected}
                            onClick={() => onSeatClick(seat.seat)}
                          >
                            {renderSeatActions ? "◎" : action}
                          </button>
                        )}
                        {renderSeatActions?.(seat)}
                        {onSeatFoul && (seat.status ?? "active") === "active" && (
                          <button
                            className="ledger-foul-button"
                            type="button"
                            aria-label={t("foul", { name: seat.name })}
                            title={t("foul", { name: seat.name })}
                            onClick={() => onSeatFoul(seat.seat)}
                          >
                            <Plus aria-hidden="true" />
                          </button>
                        )}
                        {onSeatPenalty && (
                          <button
                            className="ledger-penalty-button"
                            type="button"
                            aria-label={t("penalty", { name: seat.name })}
                            title={t("penalty", { name: seat.name })}
                            onClick={() => onSeatPenalty(seat.seat)}
                          >
                            <ShieldAlert aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                  {columns.map(({ day, period, current }) => {
                    const facts =
                      row.cells
                        .find((cell) => cell.day === day)
                        ?.facts.filter(
                          (value) => value.period === period && !value.kind.startsWith("ballot"),
                        ) ?? [];
                    const summary = new Set(facts.slice(-2));
                    return (
                      <td
                        key={`${day}:${period}`}
                        data-ledger-day={day}
                        data-ledger-period={period}
                        className={current ? "ledger-current-day" : undefined}
                      >
                        {facts.length > 0 ? (
                          <details className="ledger-cell-details">
                            <summary>
                              {[...summary].map(fact)}
                              <span className="ledger-detail-count">
                                {t("details", { count: facts.length })}
                              </span>
                            </summary>
                            <div>{facts.filter((value) => !summary.has(value)).map(fact)}</div>
                          </details>
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
};
