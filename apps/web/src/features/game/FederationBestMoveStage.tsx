import { useState } from "react";
import { acceptBestMoveSeat, correctBestMoveSlip, finalizeBestMove } from "@mafia/game-domain";
import type {
  BestMoveCompletionReason,
  CanonicalGameEventDraft,
  GameState,
} from "@mafia/game-domain";
import { useMessages } from "../../i18n/I18nProvider.js";
import { federationBestMoveMessages } from "../../i18n/messages/federation-best-move.js";
import { usePlayerDisplayName } from "../players/player-display.js";
import { GameTable } from "../table/GameTable.js";
import { FederationJudgeDialog } from "./FederationJudgeDialog.js";
import "./federation-controls.css";

interface TranscriptProps {
  readonly game: GameState;
  readonly onGameChange: (game: GameState) => void;
  readonly onEvent: (type: string, payload: Record<string, unknown>) => void;
  readonly onAcceptedEvent?: (event: CanonicalGameEventDraft) => void;
  readonly onCorrection?: () => void;
}

export const FederationBestMoveTranscript = ({
  game,
  onGameChange,
  onEvent,
  onAcceptedEvent,
  onCorrection,
}: TranscriptProps) => {
  const { t } = useMessages(federationBestMoveMessages);
  const [correcting, setCorrecting] = useState(false);
  const [index, setIndex] = useState(0);
  const [seat, setSeat] = useState(1);
  const [reason, setReason] = useState("");
  if (!game.bestMove) return null;
  return (
    <div className="federation-transcript">
      {game.bestMove.completionReason ? <strong>{t("best.finalized")}</strong> : null}
      <ol aria-label={t("best.accepted")}>
        {game.bestMove.selectedSeats.map((number, position) => (
          <li key={position}>#{number}</li>
        ))}
      </ol>
      {game.bestMove.selectedSeats.length > 0 ? (
        <button type="button" onClick={() => setCorrecting(true)}>
          {t("best.slip")}
        </button>
      ) : null}
      {correcting ? (
        <FederationJudgeDialog
          title={t("best.slip")}
          closeLabel={t("best.close")}
          onDismiss={() => setCorrecting(false)}
        >
          <label>
            {t("best.entry")}
            <select value={index} onChange={(e) => setIndex(Number(e.target.value))}>
              {game.bestMove.selectedSeats.map((number, position) => (
                <option key={position} value={position}>
                  {position + 1}: #{number}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("best.correctNumber")}
            <select value={seat} onChange={(e) => setSeat(Number(e.target.value))}>
              {game.players.map((player) => (
                <option key={player.seat} value={player.seat}>
                  #{player.seat}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("best.reason")}
            <input maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button
            type="button"
            disabled={!reason.trim()}
            onClick={() => {
              const payload = { index, seat, reason: reason.trim() };
              const next = correctBestMoveSlip(game, index, seat, payload.reason);
              if (onAcceptedEvent) onAcceptedEvent({ type: "best-move.slip-corrected", payload });
              else {
                onGameChange(next);
                onEvent("best-move.slip-corrected", payload);
              }
              onCorrection?.();
              setReason("");
              setCorrecting(false);
            }}
          >
            {t("best.confirmSlip")}
          </button>
        </FederationJudgeDialog>
      ) : null}
    </div>
  );
};

export const FederationBestMoveStage = ({
  game,
  hostName,
  onGameChange,
  onEvent,
  onAcceptedEvent,
  blocked = false,
  onSeatPenalty,
}: TranscriptProps & {
  readonly hostName: string;
  readonly blocked?: boolean;
  readonly onSeatPenalty?: (seat: number) => void;
}) => {
  const { t } = useMessages(federationBestMoveMessages);
  const displayName = usePlayerDisplayName();
  const [readback, setReadback] = useState(false);
  const [cutoffOpen, setCutoffOpen] = useState(false);
  const count = game.bestMove?.selectedSeats.length ?? 0;
  const finish = (reason: BestMoveCompletionReason) => {
    const next = finalizeBestMove(game, reason, readback);
    const payload = { reason, readbackAcknowledged: true as const };
    if (onAcceptedEvent) onAcceptedEvent({ type: "best-move.finalized", payload });
    else {
      onGameChange(next);
      onEvent("best-move.finalized", payload);
    }
  };
  return (
    <GameTable
      onSeatPenalty={onSeatPenalty}
      hostName={hostName}
      privacyHidden={false}
      seats={game.players.map((player) => ({
        playerId: player.id,
        ...player,
        name: displayName(player),
        votingHighlight: player.seat === game.bestMove?.playerSeat,
      }))}
      seatActionLabel={(seat) => t("best.acceptNumber", { seat: seat.seat })}
      seatActionDisabled={() => blocked || count >= 3 || !!game.bestMove?.completionReason}
      onSeatClick={(seat) => {
        const next = acceptBestMoveSeat(game, seat);
        if (onAcceptedEvent)
          onAcceptedEvent({ type: "best-move.number-accepted", payload: { seat } });
        else {
          onGameChange(next);
          onEvent("best-move.number-accepted", { seat });
        }
        setReadback(false);
      }}
      center={
        <div className="federation-best-move">
          <small>{t("best.timer")}</small>
          <FederationBestMoveTranscript
            game={game}
            onGameChange={onGameChange}
            onEvent={onEvent}
            onAcceptedEvent={onAcceptedEvent}
            onCorrection={() => setReadback(false)}
          />
          <label>
            <input
              type="checkbox"
              checked={readback}
              onChange={(e) => setReadback(e.target.checked)}
            />
            {t("best.readback")}
          </label>
        </div>
      }
      advance={
        <div className="table-advance-options federation-best-actions">
          <button
            type="button"
            disabled={blocked || !readback}
            onClick={() =>
              finish(count === 0 ? "declined" : count === 3 ? "complete-list" : "finished-early")
            }
          >
            {t(count === 0 ? "best.skip" : count === 3 ? "best.complete" : "best.early")}
          </button>
          <button
            type="button"
            disabled={blocked || !readback}
            aria-label={t("best.cutoff")}
            onClick={() => setCutoffOpen(true)}
          >
            …
          </button>
          {cutoffOpen ? (
            <FederationJudgeDialog
              title={t("best.cutoff")}
              closeLabel={t("best.close")}
              onDismiss={() => setCutoffOpen(false)}
            >
              <button type="button" onClick={() => finish("time-expired")}>
                {t("best.timeExpired")}
              </button>
              <button type="button" onClick={() => finish("interrupted")}>
                {t("best.interrupted")}
              </button>
            </FederationJudgeDialog>
          ) : null}
        </div>
      }
    />
  );
};
