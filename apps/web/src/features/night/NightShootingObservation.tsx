import { useId } from "react";
import type { GameState } from "@mafia/game-domain";
import { useMessages } from "../../i18n/I18nProvider.js";
import { nightMessages } from "../../i18n/messages/night.js";

export const NightShootingObservation = ({
  game,
  active,
  onToggle,
}: {
  readonly game: GameState;
  readonly active: boolean;
  readonly onToggle: () => void;
}) => {
  const { t } = useMessages(nightMessages);
  const statusId = useId();
  const count = game.shotObservations?.length ?? 0;
  const multipleSeats = [
    ...new Set([
      ...(game.actualMultipleShotSeats ?? []),
      ...(game.shotObservations ?? [])
        .filter(
          (shot) =>
            shot.additional &&
            game.players.some(
              (player) =>
                player.seat === shot.shooterSeat &&
                player.status === "active" &&
                player.team === "black",
            ),
        )
        .map((shot) => shot.shooterSeat),
    ]),
  ];
  return (
    <div className="federation-shooting-observation">
      <button type="button" aria-pressed={active} aria-describedby={statusId} onClick={onToggle}>
        {t("night.multipleShooting")}
      </button>
      <small id={statusId} role="status">
        {t(active ? "night.observationModeActive" : "night.observationModeOff")}
        {count > 0 ? ` ${t("night.observationCount", { count })}` : ""}
      </small>
      {multipleSeats.length > 0 ? (
        <small role="status">
          {t("night.multipleShotRecorded", {
            seats: multipleSeats.map((seat) => `#${seat}`).join(", "),
          })}
        </small>
      ) : null}
    </div>
  );
};
