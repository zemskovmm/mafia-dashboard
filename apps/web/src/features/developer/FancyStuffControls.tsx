import { useMessages } from "../../i18n/I18nProvider.js";
import { fancyStuffMessages } from "../../i18n/messages/fancy-stuff.js";
import type { FancyStuffSettings } from "../effects/fancy-stuff-preferences.js";
import "./FancyStuffControls.css";

export const FancyStuffControls = ({
  settings,
  onChange,
}: Readonly<{
  settings: FancyStuffSettings;
  onChange: (settings: FancyStuffSettings) => void;
}>) => {
  const { t } = useMessages(fancyStuffMessages);
  return (
    <details className="fancy-stuff-controls">
      <summary>{t("section")}</summary>
      <div className="fancy-stuff-fields">
        <button
          type="button"
          className="dev-setting-toggle"
          aria-label={t(settings.clubEntryEffects ? "disable" : "enable")}
          aria-pressed={settings.clubEntryEffects}
          onClick={() => onChange({ ...settings, clubEntryEffects: !settings.clubEntryEffects })}
        >
          <strong>{t("clubEntryEffects")}</strong>
          <span className="dev-setting-state">{t(settings.clubEntryEffects ? "on" : "off")}</span>
        </button>
        <p>{t("help")}</p>
        <p>{t("local")}</p>
      </div>
    </details>
  );
};
