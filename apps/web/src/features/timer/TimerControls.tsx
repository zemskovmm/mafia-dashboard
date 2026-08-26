import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { reportError } from "../console/error-console.js";
import { readCountdown, startCountdown } from "./timer.js";
import type { CountdownState } from "./timer.js";

export interface TimerControlsHandle {
  start(seconds: 10 | 30 | 60): void;
}

const scheduleFaintChime = (context: AudioContext, seconds: 10 | 30 | 60): OscillatorNode => {
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
  const [timer, setTimer] = useState<CountdownState | null>(null);
  const [remaining, setRemaining] = useState(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const warningOscillatorRef = useRef<OscillatorNode | null>(null);

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

  const start = (seconds: 10 | 30 | 60) => {
    cancelScheduledWarning();
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
    const next = startCountdown(seconds, Date.now());
    const reading = readCountdown(next, Date.now());
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

  const stop = () => {
    if (timer === null || timer.status === "expired") {
      return;
    }
    cancelScheduledWarning();
    setTimer(null);
    setRemaining(0);
  };

  return (
    <section className="timer-panel" aria-label="Timer controls">
      <button
        type="button"
        className="timer-preset-60"
        aria-label="Start 60 second timer"
        onClick={() => start(60)}
      >
        +60
      </button>
      <button
        type="button"
        className={`timer-display${remaining <= 10 && remaining > 0 ? " is-warning" : ""}`}
        aria-label={timer === null || timer.status === "expired" ? "Timer face" : "Stop timer"}
        disabled={timer === null || timer.status === "expired"}
        onClick={stop}
      >
        <span className="timer-label">Timer</span>
        <strong>{remaining.toString().padStart(2, "0")}</strong>
        <span>seconds</span>
      </button>
      <div className="timer-side-presets">
        {([30, 10] as const).map((seconds) => (
          <button
            type="button"
            key={seconds}
            aria-label={`Start ${seconds} second timer`}
            onClick={() => start(seconds)}
          >
            +{seconds}
          </button>
        ))}
      </div>
    </section>
  );
});

TimerControls.displayName = "TimerControls";
