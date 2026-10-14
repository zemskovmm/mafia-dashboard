import { useState } from "react";
import { recordActualMultipleShot } from "@mafia/game-domain";
import type { CanonicalGameEventDraft, GameState } from "@mafia/game-domain";
import { useMessages } from "../../i18n/I18nProvider.js";
import { nightMessages } from "../../i18n/messages/night.js";
import { FederationJudgeDialog } from "../game/FederationJudgeDialog.js";
import { usePlayerDisplayName } from "../players/player-display.js";

export const NightShootingObservation = ({
  game,
  onGameChange,
  onEvent,
  onAcceptedEvent,
}: {
  readonly game: GameState;
  readonly onGameChange: (game: GameState) => void;
  readonly onEvent: (type: string, payload: Record<string, unknown>) => void;
  readonly onAcceptedEvent?: (draft: CanonicalGameEventDraft) => void;
}) => {
  const { t } = useMessages(nightMessages);
  const displayName = usePlayerDisplayName();
  const shooters = game.players.filter((p) => p.team === "black" && p.status === "active");
  const [shooterSeat, setShooterSeat] = useState(shooters[0]?.seat ?? 0);
  const [observed, setObserved] = useState(false);
  const [open, setOpen] = useState(false);
  return (
    <div className="federation-shooting-observation">
      <button type="button" onClick={() => setOpen(true)}>
        {t("night.multipleShooting")}
      </button>
      {open ? (
        <FederationJudgeDialog
          title={t("night.multipleShooting")}
          closeLabel={t("night.closeObservation")}
          onDismiss={() => setOpen(false)}
        >
          <label>
            {t("night.observedShooter")}
            <select
              value={shooterSeat}
              onChange={(e) => {
                setShooterSeat(Number(e.target.value));
                setObserved(false);
              }}
            >
              {shooters.map((p) => (
                <option key={p.seat} value={p.seat}>
                  #{p.seat} · {displayName(p)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={observed}
              onChange={(e) => setObserved(e.target.checked)}
            />
            {t("night.confirmPhysicalShooting")}
          </label>
          <button
            type="button"
            disabled={
              !observed ||
              !shooters.some((p) => p.seat === shooterSeat) ||
              game.actualMultipleShotSeats?.includes(shooterSeat)
            }
            onClick={() => {
              const next = recordActualMultipleShot(game, shooterSeat);
              if (onAcceptedEvent)
                onAcceptedEvent({ type: "mafia.multiple-shot-observed", payload: { shooterSeat } });
              else {
                onGameChange(next);
                onEvent("mafia.multiple-shot-observed", { shooterSeat });
              }
              setObserved(false);
              setOpen(false);
            }}
          >
            {t("night.recordMultipleShot")}
          </button>
          {game.actualMultipleShotSeats?.length ? (
            <small role="status">
              {t("night.multipleShotRecorded", {
                seats: game.actualMultipleShotSeats.map((seat) => `#${seat}`).join(", "),
              })}
            </small>
          ) : null}
        </FederationJudgeDialog>
      ) : null}
    </div>
  );
};
