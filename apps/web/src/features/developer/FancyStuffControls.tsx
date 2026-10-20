import { useMessages } from "../../i18n/I18nProvider.js";
import { DeveloperSettingToggle } from "./DeveloperSettingToggle.js";
import { fancyStuffMessages } from "../../i18n/messages/fancy-stuff.js";
import type { FancyStuffSettings } from "../effects/fancy-stuff-preferences.js";
import { useFancyFeatures } from "../effects/FancyFeaturesContext.js";
import "./FancyStuffControls.css";

export const FancyStuffControls = ({
  settings,
  onChange,
}: Readonly<{
  settings: FancyStuffSettings;
  onChange: (settings: FancyStuffSettings) => void;
}>) => {
  const { t } = useMessages(fancyStuffMessages);
  const effective = useFancyFeatures();
  return (
    <details className="dev-disclosure fancy-stuff-controls">
      <summary>{t("section")}</summary>
      <div className="dev-disclosure-fields fancy-stuff-fields">
        <DeveloperSettingToggle
          title={t("master")}
          ariaLabel={t(settings.enabled ? "disable" : "enable")}
          pressed={settings.enabled}
          stateLabel={t(settings.enabled ? "on" : "off")}
          onClick={() => onChange({ ...settings, enabled: !settings.enabled })}
        />
        <p className="dev-disclosure-help">{t("help")}</p>
        <p className="dev-disclosure-help">{t("local")}</p>
        {!effective ? <p role="status">{t("lightweight")}</p> : null}
      </div>
    </details>
  );
};
