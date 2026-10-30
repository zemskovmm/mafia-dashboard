import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useFancyFeatures } from "../effects/FancyFeaturesContext.js";
import { playerDepartureTimeline } from "../effects/player-departure-timeline.js";
import { synchronizeCardAnimations } from "../effects/synchronize-card-animations.js";
import type { PlayerDepartureCause } from "../game/player-action-presentation.js";
import { animateDepartureEffects, DepartureMarks, TornReverse } from "./PlayerDepartureEffects.js";
import type { PlayerExitRequest } from "../game/PlayerExitProvider.js";
import "./PlayerExitAnimation.css";

/** Content-only faces preserve the existing interactive host and its single first glass child. */
export const PlayerExitAnimation = ({
  request,
  deceased,
  departureCause,
  reverse,
  onComplete,
  children,
}: Readonly<{
  request?: PlayerExitRequest;
  deceased: boolean;
  departureCause?: PlayerDepartureCause;
  /** Public status only; player names and role artwork belong to the front. */
  reverse: ReactNode;
  onComplete: (id: number) => void;
  children: ReactNode;
}>) => {
  const fancy = useFancyFeatures();
  const [suppressedRequest, setSuppressedRequest] = useState<PlayerExitRequest>();
  const completedRequest = useRef<PlayerExitRequest>(undefined);
  const presentingRequest = fancy && request !== suppressedRequest ? request : undefined;
  const front = useRef<HTMLSpanElement>(null);
  const back = useRef<HTMLSpanElement>(null);
  const complete = useRef(onComplete);
  useLayoutEffect(() => {
    complete.current = onComplete;
  });
  useLayoutEffect(() => {
    if (!request || suppressedRequest === request) return;
    const finish = () => {
      if (completedRequest.current === request) return;
      completedRequest.current = request;
      setSuppressedRequest(request);
      complete.current(request.id);
    };
    if (!fancy) {
      // Direct developer previews bypass the provider. Settle here, and retain
      // the static endpoint if a caller keeps this request through re-enabling.
      setSuppressedRequest(request);
      finish();
      return;
    }
    if (completedRequest.current === request) return;
    const card = front.current?.closest<HTMLElement>(".player-seat");
    const motionPreference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (
      !card?.animate ||
      !front.current ||
      !back.current ||
      document.hidden ||
      motionPreference?.matches ||
      !request.settings.enabled
    ) {
      finish();
      return;
    }
    const motion = playerDepartureTimeline(request.settings, request.cause);
    const elapsed = Math.max(0, performance.now() - request.startedAt);
    if (elapsed >= motion.duration) {
      finish();
      return;
    }
    const options: KeyframeAnimationOptions = {
      duration: motion.duration,
      fill: "both",
      easing: "linear",
    };
    const animations: Animation[] = [];
    let active = true;
    let timeout: number | undefined;
    const interrupt = () => {
      if (document.hidden || motionPreference?.matches) finish();
    };
    const cleanup = () => {
      active = false;
      window.clearTimeout(timeout);
      timeout = undefined;
      animations.forEach((animation) => animation.cancel());
      document.removeEventListener("visibilitychange", interrupt);
      motionPreference?.removeEventListener?.("change", interrupt);
    };
    try {
      for (const [target, frames] of [
        [card, motion.lift],
        [card, motion.turn],
        [front.current, motion.front],
        [back.current, motion.back],
      ] as const)
        animations.push(target.animate(frames, options));
      for (const material of card.querySelectorAll<HTMLElement>(":scope > .liquid-card-glass"))
        animations.push(material.animate(motion.material, options));
      animateDepartureEffects(card, card, request, animations);
      for (const animation of animations) animation.id = `player-exit-${request.id}`;
      synchronizeCardAnimations(animations, request.startedAt);
    } catch {
      for (const animation of animations) {
        void animation.finished.catch(() => {});
      }
      finish();
      // Even partial startup retains its frames until the static React commit.
      return cleanup;
    }
    void Promise.all(animations.map((animation) => animation.finished)).then(
      () => {
        if (active) finish();
      },
      () => {
        if (active) finish();
      },
    );
    timeout = window.setTimeout(finish, motion.duration - elapsed + 80);
    document.addEventListener("visibilitychange", interrupt);
    motionPreference?.addEventListener?.("change", interrupt);
    return cleanup;
  }, [request, fancy, suppressedRequest]);

  const cross = <span className="deceased-cross" aria-hidden="true" />;
  const known = deceased && departureCause && departureCause !== "unknown";
  const neutral = (
    <>
      <span className="player-exit-decoration" aria-hidden="true">
        {/* The host's single Glass material owns the reverse, including its tear.
            Only cause-specific marks belong above it, never an inset card frame. */}
        {departureCause === "vote" ? <TornReverse>{null}</TornReverse> : null}
        <DepartureMarks cause={departureCause} />
      </span>
      {reverse}
    </>
  );
  if (!presentingRequest)
    return (
      <>
        {known ? neutral : children}
        {deceased && !known ? cross : null}
      </>
    );
  return (
    <>
      <span ref={front} className="player-exit-face player-exit-front" aria-hidden="true">
        {children}
        <DepartureMarks cause={departureCause} />
      </span>
      <span ref={back} className="player-exit-face player-exit-back" aria-hidden="true">
        {known ? (
          neutral
        ) : (
          <>
            {reverse}
            {cross}
          </>
        )}
      </span>
    </>
  );
};
