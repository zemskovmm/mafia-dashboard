import { useMessages } from "../../i18n/I18nProvider.js";
import { nightMessages } from "../../i18n/messages/night.js";

export const NightShootingObservation = ({
  active,
  onToggle,
}: {
  readonly active: boolean;
  readonly onToggle: () => void;
}) => {
  const { t } = useMessages(nightMessages);
  return (
    <div className="federation-shooting-observation">
      <button type="button" aria-pressed={active} onClick={onToggle}>
        {t("night.multipleShooting")}
      </button>
    </div>
  );
};
