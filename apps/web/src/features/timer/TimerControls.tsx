import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { readCountdown, startCountdown } from "./timer.js";
import type { CountdownState } from "./timer.js";

export interface TimerControlsHandle {
  start(seconds: 10 | 30 | 60): void;
}

const playFaintChime = () => {
  const AudioContextConstructor = window.AudioContext;
  if (AudioContextConstructor === undefined) {
    return;
  }
  const context = new AudioContextConstructor();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = 660;
  gain.gain.setValueAtTime(0.025, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.18);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.18);
};

export const TimerControls = forwardRef<TimerControlsHandle>((_, ref) => {
  const [timer, setTimer] = useState<CountdownState | null>(null);
  const [remaining, setRemaining] = useState(0);

  const start = (seconds: 10 | 30 | 60) => {
    const next = startCountdown(seconds, Date.now());
    const reading = readCountdown(next, Date.now());
    setTimer(reading.timer);
    setRemaining(reading.remainingSeconds);
    if (reading.emitWarning) {
      playFaintChime();
    }
  };

  useImperativeHandle(ref, () => ({ start }));

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
        if (reading.emitWarning) {
          playFaintChime();
        }
        return reading.timer;
      });
    }, 200);
    return () => window.clearInterval(interval);
  }, [timer?.status]);

  const stop = () => {
    if (timer === null || timer.status === "expired") {
      return;
    }
    setTimer(null);
    setRemaining(0);
  };

  return (
    <section className="timer-panel" aria-label="Timer controls">
      <div className={`timer-display${remaining <= 10 && remaining > 0 ? " is-warning" : ""}`}>
        <span className="timer-label">Timer</span>
        <strong>{remaining.toString().padStart(2, "0")}</strong>
        <span>seconds</span>
      </div>
      <div className="timer-presets">
        {([60, 30, 10] as const).map((seconds) => (
          <button
            type="button"
            key={seconds}
            aria-label={`Start ${seconds} second timer`}
            onClick={() => start(seconds)}
          >
            +{seconds}
          </button>
        ))}
        <button
          type="button"
          aria-label="Stop timer"
          onClick={stop}
          disabled={timer === null || timer.status === "expired"}
        >
          Stop
        </button>
      </div>
    </section>
  );
});

TimerControls.displayName = "TimerControls";
