import { useMessages } from "../../i18n/I18nProvider.js";
import { shellMessages } from "../../i18n/messages/shell.js";
import { DEFAULT_GLASS_SETTINGS, type GlassSettings } from "../theme/glass-preferences.js";

export type GlassStatus =
  | "off"
  | "inactive"
  | "initializing"
  | "ready"
  | "unavailable"
  | "context-lost"
  | "reduced-transparency";

export const GlassControls = ({
  settings,
  status,
  onChange,
}: Readonly<{
  settings: GlassSettings;
  status: GlassStatus;
  onChange: (settings: GlassSettings) => void;
}>) => {
  const { t } = useMessages(shellMessages);
  const active = settings.enabled && status === "ready";
  const reason = !settings.enabled
    ? t("glassOffReason")
    : status === "inactive"
      ? t("glassInactiveReason")
      : status === "reduced-transparency"
        ? t("glassReducedReason")
        : status === "initializing"
          ? t("glassStartingReason")
          : status === "context-lost"
            ? t("glassLostReason")
            : t("glassUnavailableReason");
  return (
    <details className="dev-glass-controls">
      <summary>{t("glassSection")}</summary>
      <div className="dev-glass-fields">
        <button
          type="button"
          className="dev-setting-toggle"
          aria-label={t(settings.enabled ? "disableEnhancedGlass" : "enableEnhancedGlass")}
          aria-pressed={settings.enabled}
          onClick={() => onChange({ ...settings, enabled: !settings.enabled })}
        >
          <strong>{t("enhancedGlass")}</strong>
          <span>{t(settings.enabled ? "settingOn" : "settingOff")}</span>
        </button>
        <p id="glass-renderer-reason" role="status" className="dev-renderer-status">
          {active ? t("glassActive") : reason}
        </p>
        <label className="dev-renderer-field">
          <span>{t("refractionValue", { value: settings.refraction })}</span>
          <input
            type="range"
            min="0"
            max="24"
            step="1"
            aria-label={t("refractionStrength")}
            aria-describedby="glass-renderer-reason"
            value={settings.refraction}
            disabled={!active}
            onChange={(event) =>
              onChange({ ...settings, refraction: Number(event.currentTarget.value) })
            }
          />
        </label>
        <label className="dev-renderer-field">
          <span>{t("goldLightValue", { value: settings.goldLight })}</span>
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            aria-label={t("goldBackgroundLight")}
            value={settings.goldLight}
            onChange={(event) =>
              onChange({ ...settings, goldLight: Number(event.currentTarget.value) })
            }
          />
        </label>
        <button type="button" onClick={() => onChange(DEFAULT_GLASS_SETTINGS)}>
          {t("resetGlassSettings")}
        </button>
      </div>
    </details>
  );
};
