import { applyGameEvent } from "@mafia/game-domain";
import type { CanonicalGameEventDraft, GameState } from "@mafia/game-domain";
import { useMessages } from "../../i18n/I18nProvider.js";
import { federationBestMoveMessages } from "../../i18n/messages/federation-best-move.js";
import { usePlayerDisplayName } from "../players/player-display.js";
import { GameTable } from "../table/GameTable.js";

import "./federation-controls.css";

interface BestMoveProps {
  readonly game: GameState;
  readonly onGameChange: (game: GameState) => void;
  readonly onEvent: (type: string, payload: Record<string, unknown>) => void;
  readonly onAcceptedEvent?: (event: CanonicalGameEventDraft) => void;
}

const FederationBestMoveTranscript = ({ game }: { readonly game: GameState }) => {
  const { t } = useMessages(federationBestMoveMessages);
  if (!game.bestMove || game.bestMove.completionReason) return null;
  return (
    <div className="federation-transcript">
      <ol aria-label={t("best.selected")}>
        {game.bestMove.selectedSeats.map((number, position) => (
          <li key={position}>#{number}</li>
        ))}
      </ol>
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
}: BestMoveProps & {
  readonly hostName: string;
  readonly blocked?: boolean;
  readonly onSeatPenalty?: (seat: number) => void;
}) => {
  const { t } = useMessages(federationBestMoveMessages);
  const displayName = usePlayerDisplayName();
  const selected = game.bestMove?.selectedSeats ?? [];
  const unavailable = blocked || !game.bestMove || !!game.bestMove.completionReason;
  const canRecord =
    selected.length === 3 &&
    new Set(selected).size === 3 &&
    !selected.includes(game.bestMove?.playerSeat ?? -1);
  const accept = (event: CanonicalGameEventDraft) => {
    if (onAcceptedEvent) onAcceptedEvent(event);
    else {
      onGameChange(applyGameEvent(game, event));
      onEvent(event.type, { ...event.payload });
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
        votingHighlight:
          player.seat === game.bestMove?.playerSeat || selected.includes(player.seat),
        pressed: selected.includes(player.seat),
      }))}
      seatActionLabel={(seat) =>
        t(selected.includes(seat.seat) ? "best.deselect" : "best.select", { seat: seat.seat })
      }
      seatActionDisabled={(seat) =>
        unavailable ||
        (seat.seat === game.bestMove?.playerSeat && !selected.includes(seat.seat)) ||
        (selected.length >= 3 && !selected.includes(seat.seat))
      }
      onSeatClick={(seat) => accept({ type: "best-move.selection-toggled", payload: { seat } })}
      center={
        <div className="federation-best-move">
          <span className="table-prompt">{t("best.prompt")}</span>
          <small>{t("best.timer")}</small>
          <FederationBestMoveTranscript game={game} />
        </div>
      }
      advance={
        <div className="table-advance-options federation-best-actions">
          <button
            type="button"
            disabled={unavailable || !canRecord}
            onClick={() => accept({ type: "best-move.recorded", payload: {} })}
          >
            {t("best.record")}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={unavailable}
            onClick={() => accept({ type: "best-move.skipped", payload: {} })}
          >
            {t("best.skip")}
          </button>
        </div>
      }
    />
  );
};
