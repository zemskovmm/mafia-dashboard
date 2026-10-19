import { MessageCircleOff } from "lucide-react";
import { DeveloperSettingToggle } from "./DeveloperSettingToggle.js";
import { useMessages } from "../../i18n/I18nProvider.js";
import { shellMessages } from "../../i18n/messages/shell.js";
import {
  DEFAULT_GLASS_SETTINGS,
  validateGlassSettings,
  type GlassSettings,
} from "../theme/glass-preferences.js";

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
  monochromeBackground = false,
}: Readonly<{
  settings: GlassSettings;
  status: GlassStatus;
  onChange: (settings: GlassSettings) => void;
  monochromeBackground?: boolean;
}>) => {
  const { t } = useMessages(shellMessages);
  const active = settings.enabled && status === "ready";
  const reducedTransparency = status === "reduced-transparency";
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
    <details className="dev-disclosure dev-glass-controls">
      <summary>{t("glassSection")}</summary>
      <div className="dev-disclosure-fields dev-glass-fields">
        <DeveloperSettingToggle
          title={t("enhancedGlass")}
          ariaLabel={t(settings.enabled ? "disableEnhancedGlass" : "enableEnhancedGlass")}
          pressed={settings.enabled}
          stateLabel={t(settings.enabled ? "settingOn" : "settingOff")}
          stateBadge={false}
          onClick={() => onChange({ ...settings, enabled: !settings.enabled })}
        />
        <p id="glass-renderer-reason" role="status" className="dev-renderer-status">
          {active ? t("glassActive") : reason}
        </p>
        <DeveloperSettingToggle
          title={t("matteGlass")}
          ariaLabel={t(settings.matte ? "disableMatteGlass" : "enableMatteGlass")}
          ariaDescribedBy="glass-material-reason"
          pressed={settings.matte}
          stateLabel={t(settings.matte ? "settingOn" : "settingOff")}
          stateBadge={false}
          onClick={() => onChange({ ...settings, matte: !settings.matte })}
        />
        <p id="glass-material-reason" className="dev-renderer-status">
          {t(reducedTransparency ? "glassMaterialReducedReason" : "glassMaterialDescription")}
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
            aria-describedby="glass-gold-description"
            value={settings.goldLight}
            disabled={monochromeBackground}
            onChange={(event) =>
              onChange({ ...settings, goldLight: Number(event.currentTarget.value) })
            }
          />
        </label>
        <p id="glass-gold-description" className="dev-renderer-status">
          {t(monochromeBackground ? "glassGoldMonochromeReason" : "glassGoldDescription")}
        </p>
        <details className="dev-glass-advanced">
          <summary>{t("glassFineTuning")}</summary>
          <div className="dev-disclosure-fields dev-glass-fields">
            <label className="dev-renderer-field">
              <span>{t("refractionProfile")}</span>
              <select
                aria-label={t("refractionProfile")}
                aria-describedby="glass-renderer-reason"
                value={settings.profile}
                disabled={!active}
                onChange={(event) =>
                  onChange({
                    ...settings,
                    profile: event.currentTarget.value === "simple" ? "simple" : "edge",
                  })
                }
              >
                <option value="edge">{t("refractionProfileEdge")}</option>
                <option value="simple">{t("refractionProfileSimple")}</option>
              </select>
            </label>
            <label className="dev-renderer-field">
              <span>{t("frostingValue", { value: settings.frosting })}</span>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                aria-label={t("frostingAmount")}
                aria-describedby={
                  !settings.matte && !reducedTransparency
                    ? "glass-frosting-reason glass-material-reason"
                    : "glass-material-reason"
                }
                value={settings.frosting}
                disabled={!settings.matte || reducedTransparency}
                onChange={(event) =>
                  onChange({ ...settings, frosting: Number(event.currentTarget.value) })
                }
              />
            </label>
            {!settings.matte && !reducedTransparency && (
              <p id="glass-frosting-reason" className="dev-renderer-status">
                {t("glassFrostingOffReason")}
              </p>
            )}
            {(
              [
                ["tint", "glassTint", "glassTintValue", 30],
                ["edgeHighlights", "edgeHighlights", "edgeHighlightsValue", 100],
                ["caustics", "causticLight", "causticLightValue", 100],
              ] as const
            ).map(([field, label, valueLabel, maximum]) => (
              <label key={field} className="dev-renderer-field">
                <span>{t(valueLabel, { value: settings[field] })}</span>
                <input
                  type="range"
                  min="0"
                  max={maximum}
                  step="1"
                  aria-label={t(label)}
                  aria-describedby="glass-material-reason"
                  value={settings[field]}
                  disabled={reducedTransparency}
                  onChange={(event) =>
                    onChange({ ...settings, [field]: Number(event.currentTarget.value) })
                  }
                />
              </label>
            ))}
          </div>
        </details>
        <details className="dev-button-glass">
          <summary>{t("glassButtons")}</summary>
          <div className="dev-disclosure-fields dev-glass-fields">
            <label className="dev-renderer-field">
              <span>
                {t("buttonFrosting")} · {settings.buttonFrosting}%
              </span>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                aria-label={t("buttonFrosting")}
                aria-describedby="glass-material-reason"
                value={settings.buttonFrosting}
                disabled={reducedTransparency}
                onChange={(event) =>
                  onChange({ ...settings, buttonFrosting: Number(event.currentTarget.value) })
                }
              />
            </label>
            <label className="dev-renderer-field">
              <span>
                {t("buttonGold")} · {settings.buttonGold}%
              </span>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                aria-label={t("buttonGold")}
                value={settings.buttonGold}
                onChange={(event) =>
                  onChange({ ...settings, buttonGold: Number(event.currentTarget.value) })
                }
              />
            </label>
            <button
              type="button"
              onClick={() =>
                onChange({
                  ...settings,
                  buttonFrosting: DEFAULT_GLASS_SETTINGS.buttonFrosting,
                  buttonGold: DEFAULT_GLASS_SETTINGS.buttonGold,
                })
              }
            >
              {t("resetButtonGlass")}
            </button>
          </div>
        </details>
        <details className="dev-player-card-appearance">
          <summary>{t("playerCardAppearance")}</summary>
          <div className="dev-disclosure-fields dev-glass-fields">
            <p id="player-card-appearance-description" className="dev-renderer-status">
              {t("playerCardAppearanceDescription")}
            </p>
            <label className="dev-renderer-field">
              <span>{t("nominationTintValue", { value: settings.nominationTint })}</span>
              <input
                type="range"
                min="0"
                max="50"
                step="1"
                aria-label={t("nominationTint")}
                aria-describedby="player-card-appearance-description"
                value={settings.nominationTint}
                onChange={(event) =>
                  onChange({ ...settings, nominationTint: Number(event.currentTarget.value) })
                }
              />
            </label>
            <label className="dev-renderer-field">
              <span>
                {t("nominationColor")}: <code>{settings.nominationColor}</code>
              </span>
              <input
                type="color"
                aria-label={t("nominationColor")}
                value={settings.nominationColor}
                onChange={(event) =>
                  onChange({ ...settings, nominationColor: event.currentTarget.value })
                }
              />
            </label>
            <div
              className="dev-player-card-colors"
              role="group"
              aria-label={t("nominationColorPresets")}
            >
              {(
                [
                  ["#e6bc7e", "nominationColorAmber"],
                  ["#88c7e3", "nominationColorBlue"],
                  ["#bda5ec", "nominationColorLilac"],
                  ["#a8d6b1", "nominationColorGreen"],
                ] as const
              ).map(([color, label]) => (
                <button
                  key={color}
                  type="button"
                  aria-label={t(label)}
                  aria-pressed={settings.nominationColor.toLowerCase() === color}
                  onClick={() => onChange({ ...settings, nominationColor: color })}
                >
                  <span aria-hidden="true" style={{ backgroundColor: color }} />
                  {t(label)}
                </button>
              ))}
            </div>
            {(
              [
                [
                  "nominationTreatment",
                  "nominationTreatment",
                  [
                    ["icons", "nominationTreatmentIcons"],
                    ["tint", "nominationTreatmentTint"],
                    ["hybrid", "nominationTreatmentHybrid"],
                  ],
                ],
              ] as const
            ).map(([field, label, choices]) => (
              <label key={field} className="dev-renderer-field">
                <span>{t(label)}</span>
                <select
                  aria-label={t(label)}
                  value={settings[field]}
                  aria-describedby="player-card-appearance-description"
                  onChange={(event) =>
                    onChange(
                      validateGlassSettings({ ...settings, [field]: event.currentTarget.value }),
                    )
                  }
                >
                  {choices.map(([value, choice]) => (
                    <option key={value} value={value}>
                      {t(choice)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <p className="dev-renderer-status dev-player-card-mute">
              <MessageCircleOff aria-hidden="true" size={18} />
              {t("playerCardMuteIndicator")}
            </p>
          </div>
        </details>
        <button type="button" onClick={() => onChange(DEFAULT_GLASS_SETTINGS)}>
          {t("resetGlassSettings")}
        </button>
      </div>
    </details>
  );
};
