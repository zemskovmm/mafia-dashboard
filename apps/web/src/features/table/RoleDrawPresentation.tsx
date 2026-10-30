import type { Role } from "@mafia/game-domain";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useFancyFeatures } from "../effects/FancyFeaturesContext.js";
import { playerExitMotion } from "../effects/player-exit-motion.js";
import { synchronizeCardAnimations } from "../effects/synchronize-card-animations.js";
import { DEFAULT_PLAYER_EXIT_SETTINGS } from "../effects/player-exit-preferences.js";
import "./RoleDrawPresentation.css";

export interface RoleDrawRequest {
  readonly id: number;
  readonly startedAt: number;
  readonly previousRole?: Role;
}

/** Ephemeral content faces only: the native card button and glass child never remount. */
export const RoleDrawPresentation = ({
  role,
  request,
  onComplete,
  children,
}: Readonly<{
  role?: Role;
  request?: RoleDrawRequest;
  onComplete: (id: number) => void;
  children: (role: Role | undefined) => ReactNode;
}>) => {
  const front = useRef<HTMLSpanElement>(null);
  const fancy = useFancyFeatures();
  const [suppressedRequest, setSuppressedRequest] = useState<RoleDrawRequest>();
  const completedRequest = useRef<RoleDrawRequest>(undefined);
  const presentingRequest = fancy && request !== suppressedRequest ? request : undefined;
  const back = useRef<HTMLSpanElement>(null);
  const complete = useRef(onComplete);
  useLayoutEffect(() => {
    complete.current = onComplete;
  });
  useLayoutEffect(() => {
    if (!request || suppressedRequest === request) return;
    const completeRequest = () => {
      if (completedRequest.current === request) return;
      completedRequest.current = request;
      setSuppressedRequest(request);
      complete.current(request.id);
    };
    if (!fancy) {
      // Keep the upright current face mounted, even if the caller retains the
      // completed request through a later opt-in. Never replay that motion.
      setSuppressedRequest(request);
      completeRequest();
      return;
    }
    if (completedRequest.current === request) return;
    const card = front.current?.closest<HTMLElement>(".player-seat");
    const preference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const motion = playerExitMotion(DEFAULT_PLAYER_EXIT_SETTINGS);
    const elapsed = Math.max(0, performance.now() - request.startedAt);
    if (
      !card?.animate ||
      !front.current ||
      !back.current ||
      document.hidden ||
      preference?.matches ||
      elapsed >= motion.duration
    ) {
      completeRequest();
      return;
    }
    const animations: Animation[] = [];
    let active = true;
    let timeout: number | undefined;
    const interrupt = () => {
      if (document.hidden || preference?.matches) settle();
    };
    const cleanup = () => {
      active = false;
      window.clearTimeout(timeout);
      timeout = undefined;
      animations.forEach((animation) => animation.cancel());
      document.removeEventListener("visibilitychange", interrupt);
      preference?.removeEventListener?.("change", interrupt);
    };
    const settle = () => {
      if (!active) return;
      active = false;
      // Retain the last frame until React commits the upright current face.
      // Effect cleanup cancels WAAPI in that same commit, before paint.
      completeRequest();
    };
    try {
      const options: KeyframeAnimationOptions = {
        duration: motion.duration,
        fill: "both",
        easing: "linear",
      };
      for (const [target, frames] of [
        [card, motion.lift],
        [card, motion.turn],
        [front.current, motion.front],
        [back.current, motion.back],
      ] as const) {
        const animation = target.animate(frames, options);
        animations.push(animation);
        animation.id = `role-draw-${request.id}`;
      }
      for (const material of card.querySelectorAll<HTMLElement>(
        ":scope > .liquid-card-glass, :scope > .role-draw-glow",
      )) {
        const animation = material.animate(motion.material, options);
        animation.id = `role-draw-${request.id}`;
        animations.push(animation);
      }
      synchronizeCardAnimations(animations, request.startedAt);
    } catch {
      // A later animate() can fail after earlier ones started; observe their
      // cancellation rejections before settling the partial request.
      void Promise.all(animations.map((animation) => animation.finished)).catch(() => {});
      settle();
      return cleanup;
    }
    void Promise.all(animations.map((animation) => animation.finished)).then(settle, settle);
    timeout = window.setTimeout(settle, motion.duration - elapsed + 80);
    document.addEventListener("visibilitychange", interrupt);
    preference?.addEventListener?.("change", interrupt);
    return cleanup;
  }, [request, fancy, suppressedRequest]);
  return (
    <>
      {presentingRequest ? (
        <span
          key="front"
          ref={front}
          className="role-draw-face role-draw-face--front"
          aria-hidden="true"
        >
          {children(presentingRequest.previousRole)}
        </span>
      ) : null}
      <span
        key="current"
        ref={back}
        className={`role-draw-face${presentingRequest ? " role-draw-face--back" : ""}`}
        aria-hidden={presentingRequest ? true : undefined}
      >
        {children(role)}
      </span>
    </>
  );
};

/** Giveaway-only glyphs; ordinary gameplay always retains its person. */
export const RoleDrawIcon = ({
  role,
  unknown = false,
}: Readonly<{ role?: Role; unknown?: boolean }>) => (
  <svg
    viewBox={role === "don" ? "100 85 550 295" : "0 0 48 48"}
    aria-hidden="true"
    className="person-icon role-draw-icon"
    data-role-glyph={role ?? (unknown ? "unknown" : "hidden")}
  >
    {role === undefined && unknown ? (
      <>
        <path
          data-question-mark=""
          d="M15 15a9 9 0 0 1 18 0c0 7-9 7-9 14v2"
          fill="none"
          stroke="currentColor"
          strokeWidth="5"
          strokeLinecap="round"
        />
        <circle cx="24" cy="39" r="3" fill="currentColor" stroke="none" />
      </>
    ) : role === "sheriff" ? (
      <path d="m24 4 5.8 12 13.2 1.9-9.5 9.3L35.7 41 24 34.8 12.3 41l2.2-13.8L5 17.9 18.2 16Z" />
    ) : role === "mafia" ? (
      <path
        fillRule="evenodd"
        d="M3 16c7-6 14-6 21-2 7-4 14-4 21 2l-3 16c-7 4-12 2-18-3-6 5-11 7-18 3Zm6 5 2 6c4 1 7 0 9-3-3-3-7-4-11-3Zm30 0c-4-1-8 0-11 3 2 3 5 4 9 3Z"
      />
    ) : role === "don" ? (
      <>
        {/* The two fedora paths from the application's la-verdad.svg emblem. */}
        <path d="M222 207 256 109C328 95 446 104 520 128L544 261C439 228 333 210 222 207Z" />
        <path d="M128 247C205 225 345 238 458 268 532 288 590 316 622 340 630 347 628 353 617 352 564 344 479 320 389 304 279 284 183 273 140 260 126 256 121 251 128 247Z" />
      </>
    ) : (
      <>
        <circle cx="24" cy="15" r="8" />
        <path d="M9 43c1.3-11.1 6.3-16.7 15-16.7S37.7 31.9 39 43" />
      </>
    )}
  </svg>
);

/** Independent of GPU/glass readiness, so neither renderer can suppress a dealt cue. */
export const RoleDrawGlow = () => <span className="role-draw-glow" aria-hidden="true" />;
