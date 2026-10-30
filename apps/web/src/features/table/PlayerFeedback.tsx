import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { PlayerExitSettings } from "../effects/player-exit-preferences.js";
import { useFancyFeatures } from "../effects/FancyFeaturesContext.js";
import { usePlayerExits } from "../game/PlayerExitProvider.js";

export interface PlayerFeedbackRequest {
  readonly id: number;
  readonly startedAt: number;
  readonly settings: PlayerExitSettings;
  readonly foulNumber?: number;
}

/** Bounded accepted-action feedback only; authoritative markers/result remain ordinary DOM. */
export const PlayerFeedback = ({
  request,
  children,
  className,
  result = false,
}: Readonly<{
  request?: PlayerFeedbackRequest;
  children: ReactNode;
  className?: string;
  result?: boolean;
}>) => {
  const fancy = useFancyFeatures();
  const host = useRef<HTMLDivElement>(null);
  const settled = useRef<PlayerFeedbackRequest>(undefined);
  useLayoutEffect(() => {
    if (!request || settled.current === request) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const elapsed = Math.max(0, performance.now() - request.startedAt);
    if (
      !fancy ||
      !request.settings.enabled ||
      reduced?.matches ||
      document.hidden ||
      !host.current?.animate ||
      elapsed >= request.settings.disciplineMs
    ) {
      settled.current = request;
      return;
    }
    const animations: Animation[] = [];
    const cancel = () => animations.forEach((animation) => animation.cancel());
    const animate = (element: Element | null, frames: Keyframe[]) => {
      if (!element) return;
      const animation = element.animate(frames, {
        duration: request.settings.disciplineMs,
        easing: "ease-out",
      });
      animation.id = `player-feedback-${request.id}`;
      animation.currentTime = elapsed;
      void animation.finished.catch(() => {});
      animations.push(animation);
    };
    try {
      if (result)
        animate(host.current, [
          { boxShadow: "0 0 0 0 #d3b57000" },
          { boxShadow: "0 0 0 5px #d3b57070", offset: 0.35 },
          { boxShadow: "0 0 0 0 #d3b57000" },
        ]);
      else {
        animate(host.current.querySelector(`.foul-dot:nth-child(${request.foulNumber})`), [
          { transform: "scale(1)" },
          { transform: "scale(1.65)", offset: 0.3 },
          { transform: "scale(1)" },
        ]);
        if (request.foulNumber === 3)
          animate(host.current.querySelector(".card-mute"), [
            { transform: "translateY(2px)", opacity: 0.5 },
            { transform: "translateY(-2px)", opacity: 1, offset: 0.4 },
            { transform: "translateY(0)", opacity: 1 },
          ]);
      }
    } catch {
      settled.current = request;
      cancel();
    }
    void Promise.all(animations.map((animation) => animation.finished)).then(
      () => {
        settled.current = request;
      },
      () => {},
    );
    const interrupt = () => {
      if (document.hidden || reduced?.matches) {
        settled.current = request;
        cancel();
      }
    };
    document.addEventListener("visibilitychange", interrupt);
    reduced?.addEventListener("change", interrupt);
    return () => {
      cancel();
      document.removeEventListener("visibilitychange", interrupt);
      reduced?.removeEventListener("change", interrupt);
    };
  }, [request, fancy, result]);
  const Tag = result ? "div" : "span";
  return (
    <Tag
      ref={host}
      className={className}
      role={result ? "status" : undefined}
      data-player-feedback={request?.id}
    >
      {children}
    </Tag>
  );
};

export const PlayerResultFeedback = ({
  children,
  className,
}: Readonly<{ children: ReactNode; className: string }>) => (
  <PlayerFeedback className={className} request={usePlayerExits().adjudication} result>
    {children}
  </PlayerFeedback>
);
