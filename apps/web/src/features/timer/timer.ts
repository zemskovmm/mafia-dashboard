export interface CountdownState {
  readonly status: "running" | "paused" | "expired";
  readonly endsAt: number;
  readonly remainingWhenPausedMs: number;
  readonly warningEmitted: boolean;
}

export interface CountdownReading {
  readonly timer: CountdownState;
  readonly remainingSeconds: number;
  readonly emitWarning: boolean;
}

const remainingMilliseconds = (timer: CountdownState, now: number): number =>
  timer.status === "paused" ? timer.remainingWhenPausedMs : Math.max(0, timer.endsAt - now);

export const startCountdown = (seconds: number, now: number): CountdownState => {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("Countdown duration must be positive");
  }
  return {
    status: "running",
    endsAt: now + seconds * 1_000,
    remainingWhenPausedMs: 0,
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

export const pauseCountdown = (timer: CountdownState, now: number): CountdownState => {
  if (timer.status !== "running") {
    return timer;
  }
  const remainingWhenPausedMs = remainingMilliseconds(timer, now);
  return {
    ...timer,
    status: remainingWhenPausedMs === 0 ? "expired" : "paused",
    remainingWhenPausedMs,
  };
};

export const resumeCountdown = (timer: CountdownState, now: number): CountdownState => {
  if (timer.status !== "paused") {
    return timer;
  }
  return {
    ...timer,
    status: "running",
    endsAt: now + timer.remainingWhenPausedMs,
    remainingWhenPausedMs: 0,
  };
};
