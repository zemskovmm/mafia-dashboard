interface CrossfadeTiming {
  readonly durationSeconds: number;
  readonly currentSeconds: number;
  readonly crossfadeSeconds: number;
}

const mediaEventSchedulingMarginSeconds = 1;

export const shouldStartCrossfade = ({
  durationSeconds,
  currentSeconds,
  crossfadeSeconds,
}: CrossfadeTiming): boolean => {
  if (
    !Number.isFinite(durationSeconds) ||
    !Number.isFinite(currentSeconds) ||
    !Number.isFinite(crossfadeSeconds) ||
    durationSeconds <= 0 ||
    currentSeconds < 0 ||
    crossfadeSeconds < 0
  )
    return false;

  return durationSeconds - currentSeconds <= crossfadeSeconds + mediaEventSchedulingMarginSeconds;
};
