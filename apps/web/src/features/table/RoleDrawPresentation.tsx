import type { Role } from "@mafia/game-domain";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { playerExitMotion } from "../effects/player-exit-motion.js";
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
  const back = useRef<HTMLSpanElement>(null);
  const complete = useRef(onComplete);
  useLayoutEffect(() => {
    complete.current = onComplete;
  });
  useLayoutEffect(() => {
    if (!request) return;
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
      complete.current(request.id);
      return;
    }
    const animations: Animation[] = [];
    let active = true;
    const settle = () => {
      if (!active) return;
      active = false;
      // Retain the last frame until React commits the upright current face.
      // Effect cleanup cancels WAAPI in that same commit, before paint.
      complete.current(request.id);
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
        animation.currentTime = elapsed;
      }
    } catch {
      // A later animate() can fail after earlier ones started; observe their
      // cancellation rejections before settling the partial request.
      void Promise.all(animations.map((animation) => animation.finished)).catch(() => {});
      animations.forEach((animation) => animation.cancel());
      settle();
      return;
    }
    void Promise.all(animations.map((animation) => animation.finished)).then(settle, settle);
    const timeout = window.setTimeout(settle, motion.duration - elapsed + 80);
    const interrupt = () => {
      if (document.hidden || preference?.matches) settle();
    };
    document.addEventListener("visibilitychange", interrupt);
    preference?.addEventListener?.("change", interrupt);
    return () => {
      active = false;
      window.clearTimeout(timeout);
      animations.forEach((animation) => animation.cancel());
      document.removeEventListener("visibilitychange", interrupt);
      preference?.removeEventListener?.("change", interrupt);
    };
  }, [request]);
  return (
    <>
      {request ? (
        <span
          key="front"
          ref={front}
          className="role-draw-face role-draw-face--front"
          aria-hidden="true"
        >
          {children(request.previousRole)}
        </span>
      ) : null}
      <span
        key="current"
        ref={back}
        className={`role-draw-face${request ? " role-draw-face--back" : ""}`}
        aria-hidden={request ? true : undefined}
      >
        {children(role)}
      </span>
    </>
  );
};

/** Giveaway-only glyphs; ordinary gameplay always retains its person. */
export const RoleDrawIcon = ({ role }: Readonly<{ role?: Role }>) => (
  <svg
    viewBox={role === "don" ? "100 85 550 295" : "0 0 48 48"}
    aria-hidden="true"
    className="person-icon role-draw-icon"
    data-role-glyph={role ?? "hidden"}
  >
    {role === "sheriff" ? (
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
