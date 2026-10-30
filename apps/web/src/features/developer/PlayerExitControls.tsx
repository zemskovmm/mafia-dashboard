import { useEffect, useRef, useState } from "react";
import { MessageCircleOff } from "lucide-react";
import { DeveloperSettingToggle } from "./DeveloperSettingToggle.js";
import { useMessages } from "../../i18n/I18nProvider.js";
import { playerExitMessages } from "../../i18n/messages/player-exit.js";
import {
  DEFAULT_PLAYER_EXIT_SETTINGS,
  PLAYER_EXIT_EASINGS,
  type PlayerExitEasing,
  type PlayerExitSettings,
} from "../effects/player-exit-preferences.js";
import { playerDepartureTimeline } from "../effects/player-departure-timeline.js";
import type { PlayerExitRequest } from "../game/PlayerExitProvider.js";
import type { PlayerDepartureCause } from "../game/player-action-presentation.js";
import { PlayerExitAnimation } from "../table/PlayerExitAnimation.js";
import { PrintedPlayerCard } from "../table/PrintedPlayerCard.js";
import { PlayerCardCaption } from "../table/PlayerCardCaption.js";
import { departurePresentationStyle } from "../table/PlayerDepartureEffects.js";
import { PlayerFeedback, type PlayerFeedbackRequest } from "../table/PlayerFeedback.js";
import { PlayerRoleIcon } from "../table/PlayerRoleIcon.js";
import { LiquidCardGlass } from "../theme/LiquidCardGlass.js";
import type { PlayerCardStyle } from "../theme/player-card-preferences.js";
import "./PlayerExitControls.css";

const PREVIEW_ACTIONS = [
  "unknown",
  "mafia",
  "vote",
  "foul1",
  "foul2",
  "foul3",
  "fourth-foul",
  "exclusion",
  "opposing-result",
] as const;
type PreviewAction = (typeof PREVIEW_ACTIONS)[number];
const PREVIEW_STYLES = ["glass", "classic", "heritage", "noir"] as const;
const previewCause = (action: PreviewAction): PlayerDepartureCause | undefined => {
  if (action === "unknown" || action === "mafia" || action === "vote") return action;
  if (action === "fourth-foul" || action === "exclusion") return "discipline";
  return undefined;
};
const previewFouls = (action?: PreviewAction): number =>
  action === "fourth-foul"
    ? 4
    : action === "foul3"
      ? 3
      : action === "foul2"
        ? 2
        : action === "foul1"
          ? 1
          : 0;

type PendingPreview = Readonly<{ id: number; action: PreviewAction; settings: PlayerExitSettings }>;
type Preview = Readonly<{
  action: PreviewAction;
  settings: PlayerExitSettings;
  exit?: PlayerExitRequest;
  feedback?: PlayerFeedbackRequest;
}>;

export const PlayerExitControls = ({
  settings,
  onChange,
}: Readonly<{
  settings: PlayerExitSettings;
  onChange: (settings: PlayerExitSettings) => void;
}>) => {
  const { t } = useMessages(playerExitMessages);
  const serial = useRef(0);
  const [style, setStyle] = useState<PlayerCardStyle>("glass");
  const [action, setAction] = useState<PreviewAction>("unknown");
  const [pending, setPending] = useState<PendingPreview>();
  const [preview, setPreview] = useState<Preview>();
  useEffect(() => {
    if (!pending) return;
    // PrintedPlayerCard deliberately treats requests present at mount as snapshots.
    // Commit an active/reset card first, then request a new turn without remounting it.
    const cause = previewCause(pending.action);
    const request = { id: pending.id, startedAt: performance.now(), settings: pending.settings };
    setPreview({
      action: pending.action,
      settings: pending.settings,
      exit: cause ? { ...request, cause, hideRole: true } : undefined,
      feedback: cause
        ? undefined
        : { ...request, foulNumber: previewFouls(pending.action) || undefined },
    });
    setPending(undefined);
  }, [pending]);
  useEffect(() => {
    if (!settings.enabled)
      setPreview((current) =>
        current && (current.exit || current.feedback)
          ? { ...current, exit: undefined, feedback: undefined }
          : current,
      );
  }, [settings.enabled]);

  const overlapMs = (settings.liftMs * settings.overlap) / 100;
  const selectedCause = previewCause(action);
  const timeline = playerDepartureTimeline(settings, selectedCause);
  const total = selectedCause ? timeline.duration : settings.disciplineMs;
  const cause = preview ? previewCause(preview.action) : undefined;
  const deceased = cause !== undefined;
  const fouls = previewFouls(preview?.action);
  const endpointSettings = preview?.settings ?? settings;
  const complete = (id: number) =>
    setPreview((current) => (current?.exit?.id === id ? { ...current, exit: undefined } : current));
  const index = (lower: boolean) => (
    <span className={`card-index${lower ? " card-index--lower" : ""}`} aria-hidden="true">
      <span className="seat-number">7</span>
      <span className="card-suit">◇</span>
    </span>
  );
  const discipline = (
    <PlayerFeedback
      className="card-discipline-status"
      request={preview?.action === "opposing-result" ? undefined : preview?.feedback}
    >
      {fouls ? (
        <span
          className="card-status-slot foul-markers"
          role="img"
          aria-label={t("foulCount", { count: fouls })}
        >
          {Array.from({ length: Math.min(3, fouls) }, (_, number) => (
            <span key={number} className="foul-dot" aria-hidden="true" />
          ))}
        </span>
      ) : null}
      {preview?.action === "foul3" ? (
        <span className="card-status-slot card-mute" role="img" aria-label={t("pendingMute")}>
          <MessageCircleOff aria-hidden="true" />
        </span>
      ) : null}
    </PlayerFeedback>
  );
  const publicIdentity = (
    <>
      {index(false)}
      {index(true)}
      {discipline}
    </>
  );
  return (
    <details className="dev-disclosure player-exit-controls">
      <summary>{t("section")}</summary>
      <div className="dev-disclosure-fields player-exit-fields">
        <DeveloperSettingToggle
          title={t("section")}
          ariaLabel={t(settings.enabled ? "disable" : "enable")}
          pressed={settings.enabled}
          stateLabel={t(settings.enabled ? "on" : "off")}
          onClick={() => onChange({ ...settings, enabled: !settings.enabled })}
        />
        <p className="dev-disclosure-help">{t("local")}</p>
        {(
          [
            ["liftMs", 80, 700, 10],
            ["landingMs", 200, 1400, 10],
            ["overlap", 0, 100, 5],
            ["impactMs", 240, 900, 10],
            ["tearMs", 200, 800, 10],
            ["fadeMs", 200, 900, 10],
            ["disciplineMs", 300, 1000, 10],
            ["gap", 2, 12, 1],
            ["finalOpacity", 25, 70, 1],
          ] as const
        ).map(([key, min, max, step]) => (
          <label key={key}>
            <span>
              {t(key)} ·{" "}
              <output>
                {key === "overlap"
                  ? t("overlapValue", { value: settings[key], duration: Math.round(overlapMs) })
                  : key === "gap" || key === "finalOpacity"
                    ? t("percentValue", { value: settings[key] })
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
        <p className="dev-disclosure-help" data-exit-timing>
          {t("timing", {
            start: Math.round(settings.liftMs - overlapMs),
            apex: settings.liftMs,
            end: settings.liftMs + settings.landingMs,
          })}
        </p>
        <p className="dev-disclosure-help">{t("help")}</p>
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
        <p className="dev-disclosure-help">{t("easeHelp")}</p>
        <p className="dev-disclosure-help">{t("phaseHelp")}</p>
        <label>
          <span>{t("previewStyle")}</span>
          <select
            aria-label={t("previewStyle")}
            value={style}
            onChange={(event) => {
              setStyle(event.currentTarget.value as PlayerCardStyle);
              // Style changes restore the endpoint; only Replay accepts a new sample action.
              setPending(undefined);
              setPreview((current) =>
                current ? { ...current, exit: undefined, feedback: undefined } : current,
              );
            }}
          >
            {PREVIEW_STYLES.map((choice) => (
              <option key={choice} value={choice}>
                {t(`style.${choice}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t("previewAction")}</span>
          <select
            aria-label={t("previewAction")}
            value={action}
            onChange={(event) => {
              setAction(event.currentTarget.value as PreviewAction);
              setPending(undefined);
              setPreview(undefined);
            }}
          >
            {PREVIEW_ACTIONS.map((choice) => (
              <option key={choice} value={choice}>
                {t(`action.${choice}`)}
              </option>
            ))}
          </select>
        </label>
        <div className="player-exit-resolved-timing" data-departure-timing={action}>
          <strong>{t("totalTiming", { total })}</strong>
          {selectedCause ? (
            <p>
              {t("resolvedTurn", {
                start: timeline.turnStart,
                flip: Math.round(timeline.turnStart + settings.liftMs - overlapMs),
                drop: timeline.turnStart + settings.liftMs,
                end: timeline.tearStart,
              })}
            </p>
          ) : null}
          {selectedCause === "mafia" ? (
            <p>
              {t("impactTiming", {
                first: Math.round(settings.impactMs * 0.08),
                second: Math.round(settings.impactMs * 0.4),
                third: Math.round(settings.impactMs * 0.72),
                end: timeline.turnStart,
              })}
            </p>
          ) : null}
          {selectedCause === "vote" ? (
            <p>
              {t("voteTiming", {
                tear: timeline.tearStart,
                fade: timeline.fadeStart,
                end: timeline.duration,
              })}
            </p>
          ) : null}
          {selectedCause === "discipline" ? (
            <p>{t("disciplineTiming", { end: timeline.turnStart })}</p>
          ) : null}
          {selectedCause && selectedCause !== "vote" ? (
            <p>{t("fadeTiming", { start: timeline.fadeStart, end: timeline.duration })}</p>
          ) : null}
          {!selectedCause ? <p>{t("feedbackTiming", { end: settings.disciplineMs })}</p> : null}
        </div>
        <div className="player-exit-preview table-stage">
          <div
            className={`table-card player-seat status-${deceased ? (cause === "discipline" ? "red-carded" : "eliminated") : "active"}${preview?.exit ? " is-exiting" : ""}`}
            data-card-style={style}
            data-player-glass={style === "glass" ? "table" : undefined}
            data-player-exit={preview?.exit?.id}
            data-departure-cause={cause}
            style={departurePresentationStyle(cause, endpointSettings)}
            role="img"
            aria-label={t("sample")}
          >
            {style === "glass" ? <LiquidCardGlass /> : null}
            {style === "glass" ? (
              <PlayerExitAnimation
                request={preview?.exit}
                deceased={deceased}
                departureCause={cause}
                reverse={publicIdentity}
                onComplete={complete}
              >
                {index(false)}
                {index(true)}
                <PlayerRoleIcon />
                {discipline}
              </PlayerExitAnimation>
            ) : (
              <PrintedPlayerCard
                style={style}
                seat={7}
                suit="◇"
                rolePlacement="below"
                faceDown={deceased}
                privacyHidden={false}
                exitRequest={preview?.exit}
                departureCause={cause}
                onExitComplete={complete}
              >
                {discipline}
              </PrintedPlayerCard>
            )}
          </div>
          <PlayerCardCaption name={t("sample")} />
        </div>
        {preview?.action === "opposing-result" ? (
          <PlayerFeedback
            result
            className="winner-card player-exit-preview-result"
            request={preview.feedback}
          >
            <span className="table-prompt">{t("sampleResult")}</span>
            <strong>{t("opposingWinner")}</strong>
          </PlayerFeedback>
        ) : null}
        <p className="dev-disclosure-help" data-preview-state>
          {t("sampleCounts", { active: deceased ? 0 : 1, departures: deceased ? 1 : 0, fouls })}
        </p>
        {preview ? (
          <p className="dev-disclosure-help" data-preview-endpoint>
            {t(`endpoint.${preview.action}`)}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => {
            setPreview(undefined);
            setPending({ id: ++serial.current, action, settings });
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
