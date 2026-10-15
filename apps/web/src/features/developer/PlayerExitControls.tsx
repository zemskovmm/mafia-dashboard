import { useEffect, useRef, useState } from "react";
import { useMessages } from "../../i18n/I18nProvider.js";
import { playerExitMessages } from "../../i18n/messages/player-exit.js";
import {
  DEFAULT_PLAYER_EXIT_SETTINGS,
  PLAYER_EXIT_EASINGS,
  type PlayerExitEasing,
  type PlayerExitSettings,
} from "../effects/player-exit-preferences.js";
import type { PlayerExitRequest } from "../game/PlayerExitProvider.js";
import { PlayerExitAnimation } from "../table/PlayerExitAnimation.js";
import { LiquidCardGlass } from "../theme/LiquidCardGlass.js";

export const PlayerExitControls = ({
  settings,
  onChange,
}: Readonly<{
  settings: PlayerExitSettings;
  onChange: (settings: PlayerExitSettings) => void;
}>) => {
  const { t } = useMessages(playerExitMessages);
  const serial = useRef(0);
  const [preview, setPreview] = useState<PlayerExitRequest>();
  const [previewed, setPreviewed] = useState(false);
  useEffect(() => {
    if (!settings.enabled) setPreview(undefined);
  }, [settings.enabled]);
  const overlapMs = (settings.liftMs * settings.overlap) / 100;
  return (
    <details className="player-exit-controls">
      <summary>{t("section")}</summary>
      <div className="player-exit-fields">
        <button
          type="button"
          className="dev-setting-toggle"
          aria-label={t(settings.enabled ? "disable" : "enable")}
          aria-pressed={settings.enabled}
          onClick={() => onChange({ ...settings, enabled: !settings.enabled })}
        >
          <strong>{t("section")}</strong>
          <span className="dev-setting-state">{t(settings.enabled ? "on" : "off")}</span>
        </button>
        <p>{t("local")}</p>
        {(
          [
            ["liftMs", 80, 700, 10],
            ["landingMs", 200, 1400, 10],
            ["overlap", 0, 100, 5],
          ] as const
        ).map(([key, min, max, step]) => (
          <label key={key}>
            <span>
              {t(key)} ·{" "}
              <output>
                {key === "overlap"
                  ? t("overlapValue", { value: settings[key], duration: Math.round(overlapMs) })
                  : t("durationValue", { value: settings[key] })}
              </output>
            </span>
            <input
              type="range"
              aria-label={t(key)}
              min={min}
              max={max}
              step={step}
              value={settings[key]}
              disabled={!settings.enabled}
              onChange={(event) =>
                onChange({ ...settings, [key]: Number(event.currentTarget.value) })
              }
            />
          </label>
        ))}
        <p data-exit-timing>
          {t("timing", {
            start: Math.round(settings.liftMs - overlapMs),
            apex: settings.liftMs,
            end: settings.liftMs + settings.landingMs,
          })}
        </p>
        <p>{t("help")}</p>
        {(["lift", "flip", "drop"] as const).map((phase) => (
          <fieldset key={phase} disabled={!settings.enabled}>
            <legend>{t(phase)}</legend>
            <select
              aria-label={t("easing", { phase: t(phase) })}
              value={settings[phase].easing}
              onChange={(event) =>
                onChange({
                  ...settings,
                  [phase]: {
                    ...settings[phase],
                    easing: event.currentTarget.value as PlayerExitEasing,
                  },
                })
              }
            >
              {PLAYER_EXIT_EASINGS.map((easing) => (
                <option key={easing} value={easing}>
                  {t(easing)}
                </option>
              ))}
            </select>
            <label>
              <span>
                {t("strength", { phase: t(phase) })} · <output>{settings[phase].strength}%</output>
              </span>
              <input
                type="range"
                aria-label={t("strength", { phase: t(phase) })}
                min="0"
                max="100"
                step="5"
                value={settings[phase].strength}
                disabled={settings[phase].easing === "linear"}
                onChange={(event) =>
                  onChange({
                    ...settings,
                    [phase]: { ...settings[phase], strength: Number(event.currentTarget.value) },
                  })
                }
              />
            </label>
          </fieldset>
        ))}
        <p>{t("easeHelp")}</p>
        <div className="player-exit-preview">
          <div
            className={`table-card player-seat status-${previewed ? "eliminated" : "active"}${preview ? " is-exiting" : ""}`}
            data-player-glass="table"
            data-player-exit={preview?.id}
            role="img"
            aria-label={t("sample")}
          >
            <LiquidCardGlass />
            <PlayerExitAnimation
              request={preview}
              deceased={previewed}
              onComplete={(id) =>
                setPreview((current) => (current?.id === id ? undefined : current))
              }
            >
              <span className="seat-number">7</span>
              <svg viewBox="0 0 48 48" aria-hidden="true" className="person-icon">
                <circle cx="24" cy="15" r="8" />
                <path d="M9 43c1.3-11.1 6.3-16.7 15-16.7S37.7 31.9 39 43" />
              </svg>
              <span className="seat-name">{t("sample")}</span>
            </PlayerExitAnimation>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            setPreviewed(true);
            setPreview({
              id: ++serial.current,
              settings,
              startedAt: performance.now(),
              hideRole: true,
            });
          }}
        >
          {t("preview")}
        </button>
        <button type="button" onClick={() => onChange(DEFAULT_PLAYER_EXIT_SETTINGS)}>
          {t("reset")}
        </button>
      </div>
    </details>
  );
};
