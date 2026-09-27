export type CountdownState = {
  readonly warningEmitted: boolean;
} & (
  | { readonly status: "running" | "expired"; readonly endsAt: number }
  | { readonly status: "paused"; readonly remainingMs: number }
);

export interface CountdownReading {
  readonly timer: CountdownState;
  readonly remainingSeconds: number;
  readonly emitWarning: boolean;
}

const remainingMilliseconds = (timer: CountdownState, now: number): number =>
  timer.status === "paused" ? timer.remainingMs : Math.max(0, timer.endsAt - now);

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
  const emitWarning =
    timer.status === "running" &&
    !timer.warningEmitted &&
    remainingSeconds > 0 &&
    remainingSeconds <= 10;
  const nextTimer: CountdownState =
    remainingMs === 0
      ? { status: "expired", endsAt: now, warningEmitted: timer.warningEmitted }
      : { ...timer, warningEmitted: timer.warningEmitted || emitWarning };
  return { timer: nextTimer, remainingSeconds, emitWarning };
};

export const toggleCountdown = (timer: CountdownState, now: number): CountdownState => {
  const current = readCountdown(timer, now).timer;
  if (current.status === "expired") {
    return current;
  }
  return current.status === "paused"
    ? {
        status: "running",
        endsAt: now + current.remainingMs,
        warningEmitted: current.warningEmitted,
      }
    : {
        status: "paused",
        remainingMs: current.endsAt - now,
        warningEmitted: current.warningEmitted,
      };
};
