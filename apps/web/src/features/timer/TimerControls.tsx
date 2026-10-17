import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { reportError } from "../console/error-console.js";
import { useMessages } from "../../i18n/I18nProvider.js";
import { gameMessages } from "../../i18n/messages/game.js";
import { readCountdown, startCountdown, toggleCountdown } from "./timer.js";
import type { CountdownState } from "./timer.js";
import { ActivationGlassSweep } from "../theme/ActivationGlassSweep.js";
import "./TimerControls.css";

export interface TimerControlsHandle {
  start(seconds: 10 | 20 | 30 | 60): void;
}

const scheduleFaintChime = (context: AudioContext, seconds: number): OscillatorNode => {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const warningTime = context.currentTime + Math.max(0, seconds - 10);
  oscillator.frequency.value = 660;
  gain.gain.setValueAtTime(0.025, warningTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, warningTime + 0.18);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(warningTime);
  oscillator.stop(warningTime + 0.18);
  return oscillator;
};

export const TimerControls = forwardRef<TimerControlsHandle>((_, ref) => {
  const { t } = useMessages(gameMessages);
  const [timer, setTimer] = useState<CountdownState | null>(null);
  const [remaining, setRemaining] = useState(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const warningOscillatorRef = useRef<OscillatorNode | null>(null);
  const lastPointerTapRef = useRef<number | null>(null);

  const cancelScheduledWarning = useCallback(() => {
    const oscillator = warningOscillatorRef.current;
    if (oscillator === null) {
      return;
    }
    try {
      oscillator.stop();
    } catch {
      // It may already have stopped naturally.
    }
    try {
      oscillator.disconnect();
    } catch {
      // A disconnected oscillator is already cancelled.
    }
    warningOscillatorRef.current = null;
  }, []);

  const scheduleWarning = (seconds: number) => {
    const AudioContextConstructor = window.AudioContext;
    if (AudioContextConstructor !== undefined) {
      try {
        const context = audioContextRef.current ?? new AudioContextConstructor();
        audioContextRef.current = context;
        void context.resume().catch((error: unknown) => {
          reportError(error, { source: "application", context: "timer-audio.resume" });
        });
        warningOscillatorRef.current = scheduleFaintChime(context, seconds);
      } catch (error) {
        reportError(error, { source: "application", context: "timer-audio.schedule" });
        // Timers remain usable when Web Audio is unavailable or blocked.
      }
    }
  };

  const start = (seconds: 10 | 20 | 30 | 60) => {
    lastPointerTapRef.current = null;
    cancelScheduledWarning();
    const now = Date.now();
    const reading = readCountdown(startCountdown(seconds, now), now);
    scheduleWarning(seconds);
    setTimer(reading.timer);
    setRemaining(reading.remainingSeconds);
  };

  useImperativeHandle(ref, () => ({ start }));

  useEffect(() => cancelScheduledWarning, [cancelScheduledWarning]);

  useEffect(() => {
    if (timer === null || timer.status !== "running") {
      return undefined;
    }
    const interval = window.setInterval(() => {
      setTimer((current) => {
        if (current === null) {
          return current;
        }
        const reading = readCountdown(current, Date.now());
        setRemaining(reading.remainingSeconds);
        return reading.timer;
      });
    }, 200);
    return () => window.clearInterval(interval);
  }, [timer?.status]);

  const toggle = () => {
    if (timer === null || timer.status === "expired") {
      return;
    }
    cancelScheduledWarning();
    const now = Date.now();
    const reading = readCountdown(toggleCountdown(timer, now), now);
    if (reading.timer.status === "running" && !reading.timer.warningEmitted) {
      scheduleWarning((reading.timer.endsAt - now) / 1_000);
    }
    setTimer(reading.timer);
    setRemaining(reading.remainingSeconds);
  };

  return (
    <section className="timer-panel" aria-label={t("timer.controls")}>
      <div className="timer-side-presets">
        {([60, 30] as const).map((seconds) => (
          <button
            type="button"
            key={seconds}
            className="timer-feedback-button"
            aria-label={t("timer.start", { seconds })}
            onClick={() => start(seconds)}
          >
            <ActivationGlassSweep />
            <span>+{seconds}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        className={`timer-display timer-feedback-button${remaining <= 10 && remaining > 0 ? " is-warning" : ""}`}
        aria-label={
          timer === null || timer.status === "expired"
            ? t("timer.face")
            : timer.status === "paused"
              ? t("timer.resume")
              : t("timer.pause")
        }
        disabled={timer === null || timer.status === "expired"}
        onClick={(event) => {
          const now = Date.now();
          const previous = lastPointerTapRef.current;
          lastPointerTapRef.current = event.detail === 0 ? null : now;
          if (
            event.detail > 0 &&
            previous !== null &&
            now - previous >= 0 &&
            now - previous <= 350
          ) {
            lastPointerTapRef.current = null;
            cancelScheduledWarning();
            setTimer(null);
            setRemaining(0);
          } else {
            toggle();
          }
        }}
      >
        <ActivationGlassSweep disabled={timer === null || timer.status === "expired"} />
        <span className="timer-label">{t("timer.label")}</span>
        <strong>{remaining.toString().padStart(2, "0")}</strong>
        <span>{t("timer.seconds")}</span>
      </button>
      <div className="timer-side-presets">
        {([20, 10] as const).map((seconds) => (
          <button
            type="button"
            key={seconds}
            className="timer-feedback-button"
            aria-label={t("timer.start", { seconds })}
            onClick={() => start(seconds)}
          >
            <ActivationGlassSweep />
            <span>+{seconds}</span>
          </button>
        ))}
      </div>
    </section>
  );
});

TimerControls.displayName = "TimerControls";
