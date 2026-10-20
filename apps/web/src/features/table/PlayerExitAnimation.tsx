import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useFancyFeatures } from "../effects/FancyFeaturesContext.js";
import { playerExitMotion } from "../effects/player-exit-motion.js";
import type { PlayerExitRequest } from "../game/PlayerExitProvider.js";
import "./PlayerExitAnimation.css";

/** Content-only faces preserve the existing interactive host and its single first glass child. */
export const PlayerExitAnimation = ({
  request,
  deceased,
  onComplete,
  children,
}: Readonly<{
  request?: PlayerExitRequest;
  deceased: boolean;
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
    if (!request) return;
    const finish = () => {
      if (completedRequest.current === request) return;
      completedRequest.current = request;
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
    const motion = playerExitMotion(request.settings);
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
    const animations = [
      card.animate(motion.lift, options),
      card.animate(motion.turn, options),
      front.current.animate(motion.front, options),
      back.current.animate(motion.back, options),
      card.animate(
        [
          { opacity: 1, offset: 0, easing: "steps(1, end)" },
          { opacity: 0.48, offset: motion.edge },
          { opacity: 0.48, offset: 1 },
        ],
        options,
      ),
    ];
    for (const animation of animations) {
      animation.id = `player-exit-${request.id}`;
      animation.currentTime = elapsed;
    }
    let active = true;
    void Promise.all(animations.map((animation) => animation.finished)).then(
      () => {
        if (active) finish();
      },
      () => {
        if (active) finish();
      },
    );
    const interrupt = () => {
      if (document.hidden || motionPreference?.matches) finish();
    };
    document.addEventListener("visibilitychange", interrupt);
    motionPreference?.addEventListener("change", interrupt);
    return () => {
      active = false;
      animations.forEach((animation) => animation.cancel());
      document.removeEventListener("visibilitychange", interrupt);
      motionPreference?.removeEventListener("change", interrupt);
    };
  }, [request, fancy]);

  const cross = <span className="deceased-cross" aria-hidden="true" />;
  if (!presentingRequest)
    return (
      <>
        {children}
        {deceased ? cross : null}
      </>
    );
  return (
    <>
      <span ref={front} className="player-exit-face player-exit-front" aria-hidden="true">
        {children}
      </span>
      <span ref={back} className="player-exit-face player-exit-back" aria-hidden="true">
        {children}
        {cross}
      </span>
    </>
  );
};
