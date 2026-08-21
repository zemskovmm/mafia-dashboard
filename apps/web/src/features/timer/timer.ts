export interface CountdownState {
  readonly status: "running" | "expired";
  readonly endsAt: number;
  readonly warningEmitted: boolean;
}

export interface CountdownReading {
  readonly timer: CountdownState;
  readonly remainingSeconds: number;
  readonly emitWarning: boolean;
}

const remainingMilliseconds = (timer: CountdownState, now: number): number =>
  Math.max(0, timer.endsAt - now);

export const startCountdown = (seconds: number, now: number): CountdownState => {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("Countdown duration must be positive");
  }
  return {
    status: "running",
    endsAt: now + seconds * 1_000,
    warningEmitted: false,
  };
};

export const readCountdown = (timer: CountdownState, now: number): CountdownReading => {
  const remainingMs = remainingMilliseconds(timer, now);
  const remainingSeconds = Math.ceil(remainingMs / 1_000);
  const emitWarning = !timer.warningEmitted && remainingSeconds > 0 && remainingSeconds <= 10;
  const nextTimer: CountdownState = {
    ...timer,
    status: remainingMs === 0 ? "expired" : timer.status,
    warningEmitted: timer.warningEmitted || emitWarning,
  };
  return { timer: nextTimer, remainingSeconds, emitWarning };
};
