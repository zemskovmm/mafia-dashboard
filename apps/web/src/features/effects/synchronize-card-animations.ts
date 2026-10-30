type ClockAnimation = Pick<Animation, "currentTime" | "startTime">;

/** Align pose, face visibility and material effects to the accepted request. */
export const synchronizeCardAnimations = (
  animations: readonly ClockAnimation[],
  startedAt: number,
): void => {
  const now = performance.now();
  const startTime = Math.min(startedAt, now);
  const timelineTime = document.timeline?.currentTime;
  for (const animation of animations) {
    // The default document timeline shares performance.now()'s origin, but its
    // currentTime is sampled at a frame boundary. Subtracting wall-clock elapsed
    // from that older sample would count a busy frame twice and skip early poses.
    if (typeof timelineTime === "number" && Number.isFinite(timelineTime))
      animation.startTime = startTime;
    else animation.currentTime = now - startTime;
  }
};
