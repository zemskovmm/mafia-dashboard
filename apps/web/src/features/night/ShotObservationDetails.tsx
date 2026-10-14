import { useMessages } from "../../i18n/I18nProvider.js";
import { nightMessages } from "../../i18n/messages/night.js";

/** Seat-only details for the existing private host log, never a public projection. */
export const ShotObservationDetails = ({ observations }: { readonly observations: unknown }) => {
  const { t } = useMessages(nightMessages);
  if (!Array.isArray(observations) || observations.length === 0) return null;
  const shots: { shooterSeat: number; targetSeat: number }[] = [];
  for (const observation of observations) {
    if (observation == null || typeof observation !== "object") return null;
    const { shooterSeat, targetSeat } = observation as Record<string, unknown>;
    if (
      typeof shooterSeat !== "number" ||
      !Number.isSafeInteger(shooterSeat) ||
      shooterSeat < 1 ||
      shooterSeat > 10 ||
      typeof targetSeat !== "number" ||
      !Number.isSafeInteger(targetSeat) ||
      targetSeat < 1 ||
      targetSeat > 10
    )
      return null;
    shots.push({ shooterSeat, targetSeat });
  }
  return (
    <ol>
      {shots.map((shot, index) => (
        <li key={index}>
          {t("night.observedShotDetail", {
            number: index + 1,
            shooter: shot.shooterSeat,
            target: shot.targetSeat,
          })}
        </li>
      ))}
    </ol>
  );
};
