import type { NotebookRecord } from "@mafia/game-domain";
import { useMessages } from "../../i18n/I18nProvider.js";
import { notebookMessages } from "../../i18n/messages/notebook.js";
import { readNotebookRecord } from "./notebook-import.js";
import "./notebook.css";

export interface NotebookRecordViewProps {
  readonly notebook: NotebookRecord;
  readonly participants: readonly {
    readonly playerId: string;
    readonly seat: number | null;
    readonly role?: string | null;
  }[];
  readonly playerName: (id: string) => string;
}

export const NotebookRecordView = ({
  notebook,
  participants,
  playerName,
}: NotebookRecordViewProps) => {
  const { t } = useMessages(notebookMessages);
  const record = readNotebookRecord(notebook);
  if (record === null) return null;
  const roleLabel = (role: string | null | undefined) =>
    role === "citizen" || role === "mafia" || role === "don" || role === "sheriff"
      ? t(role)
      : t("unknown");
  const seatName = (seat: number) => {
    const player = participants.find((participant) => participant.seat === seat);
    return `${t("seat", { seat })} · ${player === undefined ? t("unknown") : playerName(player.playerId)}`;
  };
  return (
    <section className="notebook-record" aria-label={t("savedTable")}>
      <p className="notebook-help">{t("notation")}</p>
      <p className="notebook-help">{t("scroll")}</p>
      <div className="notebook-table-scroll" role="region" aria-label={t("savedTable")}>
        <table className="notebook-table" aria-label={t("savedTable")}>
          <thead>
            <tr>
              <th scope="col" className="notebook-player-column">
                {t("player")}
              </th>
              <th scope="col">{t("role")}</th>
              {Array.from({ length: record.dayCount * 2 }, (_, column) => (
                <th scope="col" key={column}>
                  {t(column % 2 === 0 ? "day" : "night", { day: Math.floor(column / 2) + 1 })}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 10 }, (_, index) => {
              const seat = index + 1;
              const player = participants.find((participant) => participant.seat === seat);
              return (
                <tr key={seat}>
                  <th scope="row" className="notebook-player-column">
                    {seatName(seat)}
                  </th>
                  <td>
                    {roleLabel(
                      record.seatRoles?.find((entry) => entry.seat === seat)?.role ?? player?.role,
                    )}
                  </td>
                  {Array.from({ length: record.dayCount * 2 }, (_, column) => {
                    const day = Math.floor(column / 2) + 1;
                    const phase = column % 2 === 0 ? "day" : "night";
                    const cell = record.cells.find(
                      (candidate) =>
                        candidate.seat === seat &&
                        candidate.day === day &&
                        candidate.phase === phase,
                    );
                    const text =
                      cell === undefined
                        ? "—"
                        : [cell.nomination, cell.eliminated === true ? "X" : undefined]
                            .filter((value) => value !== undefined)
                            .join(" ");
                    return (
                      <td
                        key={column}
                        className={phase === "night" ? "notebook-night" : undefined}
                        aria-label={`${t(phase === "day" ? "dayCell" : "nightCell", { seat, day })}: ${cell === undefined ? t("unknown") : text}`}
                      >
                        {text}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {record.bestMove !== undefined && (
        <div className="notebook-best-summary">
          <h3>{t("bestMove")}</h3>
          <p>
            {t("owner")}:{" "}
            {record.bestMove.ownerSeat === undefined
              ? t("unknown")
              : seatName(record.bestMove.ownerSeat)}
          </p>
          <p>
            {t("targets")}:{" "}
            {record.bestMove.targetSeats.length === 0
              ? t("none")
              : record.bestMove.targetSeats.join(", ")}
          </p>
        </div>
      )}
    </section>
  );
};
