import { useMessages } from "../../i18n/I18nProvider.js";
import { DeveloperSettingToggle } from "./DeveloperSettingToggle.js";
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
    <details className="dev-disclosure fancy-stuff-controls">
      <summary>{t("section")}</summary>
      <div className="dev-disclosure-fields fancy-stuff-fields">
        <DeveloperSettingToggle
          title={t("clubEntryEffects")}
          ariaLabel={t(settings.clubEntryEffects ? "disable" : "enable")}
          pressed={settings.clubEntryEffects}
          stateLabel={t(settings.clubEntryEffects ? "on" : "off")}
          onClick={() => onChange({ ...settings, clubEntryEffects: !settings.clubEntryEffects })}
        />
        <p className="dev-disclosure-help">{t("help")}</p>
        <p className="dev-disclosure-help">{t("local")}</p>
      </div>
    </details>
  );
};
