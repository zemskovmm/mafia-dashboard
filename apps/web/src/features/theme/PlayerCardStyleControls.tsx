import { useMessages } from "../../i18n/I18nProvider.js";
import { playerCardStyleMessages } from "../../i18n/messages/player-card-styles.js";
import {
  validatePlayerCardPreferences,
  type PlayerCardPreferences,
} from "./player-card-preferences.js";
import "./PlayerCardStyleControls.css";

export const PlayerCardStyleControls = ({
  settings,
  onChange,
}: Readonly<{
  settings: PlayerCardPreferences;
  onChange: (settings: PlayerCardPreferences) => void;
}>) => {
  const { t } = useMessages(playerCardStyleMessages);
  return (
    <fieldset className="player-card-style-controls">
      <legend>{t("section")}</legend>
      <label className="player-card-style-field">
        <span>{t("style")}</span>
        <select
          aria-label={t("style")}
          value={settings.style}
          onChange={(event) =>
            onChange(
              validatePlayerCardPreferences({ ...settings, style: event.currentTarget.value }),
            )
          }
        >
          {(["glass", "classic", "heritage", "noir"] as const).map((style) => (
            <option key={style} value={style}>
              {t(style)}
            </option>
          ))}
        </select>
      </label>
      {settings.style !== "glass" ? (
        <label className="player-card-style-field">
          <span>{t("rolePlacement")}</span>
          <select
            aria-label={t("rolePlacement")}
            value={settings.rolePlacement}
            onChange={(event) =>
              onChange(
                validatePlayerCardPreferences({
                  ...settings,
                  rolePlacement: event.currentTarget.value,
                }),
              )
            }
          >
            {(["below", "ribbon", "top"] as const).map((placement) => (
              <option key={placement} value={placement}>
                {t(placement)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <p className="player-card-style-local">{t("local")}</p>
    </fieldset>
  );
};
