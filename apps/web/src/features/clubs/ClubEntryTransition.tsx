import { useId, useLayoutEffect, useRef, type RefObject } from "react";
import {
  computeBurnGeometry,
  createClubFireRenderer,
  type ClubFireRenderer,
  type FirePoint,
  type FireSurface,
} from "./club-fire-renderer.js";
import "./club-fire.css";

export interface ClubEntryOrigin {
  x: number;
  y: number;
  front?: readonly FirePoint[];
  card?: HTMLElement;
  cardTransform?: string;
}

const BURN_DURATION = 1800;
const READINESS_LIMIT = 3000;

/** Clips the REAL retained portal. Nothing is photographed or recreated. */
export function ClubEntryTransition({
  sourceRef,
  origin,
  ready,
  onComplete,
}: {
  sourceRef: RefObject<HTMLDivElement | null>;
  origin: ClubEntryOrigin;
  ready: boolean;
  onComplete: () => void;
}) {
  const id = `club-burn-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const completeRef = useRef(onComplete);
  const readyRef = useRef(ready);
  const doneRef = useRef(false);
  const kickRef = useRef<(() => void) | null>(null);
  completeRef.current = onComplete;
  readyRef.current = ready;

  useLayoutEffect(() => {
    const source = sourceRef.current,
      wrapper = wrapperRef.current;
    const canvas = canvasRef.current,
      path = pathRef.current;
    if (!wrapper || !canvas || !path || doneRef.current) return;
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? {
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    };
    let renderer: ClubFireRenderer | null = null;
    let frame: number | null = null;
    let waitTimer: number | null = null;
    let finishTimer: number | null = null;
    let disposed = false;
    let begun = false;
    let ordinaryStarted = false;
    let attempted = false;
    let startedAt = 0;
    let pendingOrdinary = "";
    const properties = ["clip-path", "-webkit-clip-path", "opacity", "transition", "visibility"];
    const previousStyles = properties.map((property) => ({
      property,
      value: source?.style.getPropertyValue(property) ?? "",
      priority: source?.style.getPropertyPriority(property) ?? "",
    }));
    const previousMask = source?.getAttribute("data-club-burn-mask") ?? null;
    const card = origin.card && source?.contains(origin.card) ? origin.card : null;
    const previousCardStyles = ["transform", "transition"].map((property) => ({
      property,
      value: card?.style.getPropertyValue(property) ?? "",
      priority: card?.style.getPropertyPriority(property) ?? "",
    }));
    if (card) {
      // Inertness ends hover/focus. Keep the original face under its captured
      // contour instead of letting the CSS hover-lift animate out of alignment.
      card.style.setProperty("transition", "none");
      card.style.setProperty("transform", origin.cardTransform || "none");
    }
    if (source) {
      const z = parseInt(getComputedStyle(source).zIndex, 10);
      wrapper.style.zIndex = String(Math.max(1001, Number.isFinite(z) ? z + 1 : 1001));
    }
    wrapper.dataset.clubBurnProgress = "0";
    wrapper.dataset.phase = "waiting";
    wrapper.dataset.renderer = "waiting";
    wrapper.dataset.clubBurnOriginX = String(origin.x);
    wrapper.dataset.clubBurnOriginY = String(origin.y);
    const stopFrame = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    };
    const clearTimers = () => {
      if (waitTimer !== null) window.clearTimeout(waitTimer);
      if (finishTimer !== null) window.clearTimeout(finishTimer);
      waitTimer = null;
      finishTimer = null;
    };
    const finish = (reason: string) => {
      if (disposed || doneRef.current) return;
      doneRef.current = true;
      stopFrame();
      clearTimers();
      renderer?.clear();
      wrapper.dataset.clubBurnProgress = "1";
      wrapper.dataset.phase = "complete";
      wrapper.dataset.completionReason = reason;
      // Parent owns removal + incoming focus/inert changes. Hiding the source
      // here also makes completion safe if its React update is deferred.
      if (source) source.style.visibility = "hidden";
      completeRef.current();
    };
    const ordinary = (reason: string, immediate = false) => {
      if (disposed || doneRef.current || ordinaryStarted) return;
      ordinaryStarted = true;
      begun = true;
      stopFrame();
      clearTimers();
      renderer?.clear();
      renderer?.dispose(false);
      renderer = null;
      wrapper.dataset.renderer = reason;
      canvas.dataset.renderer = reason;
      wrapper.dataset.phase = "ordinary";
      // Keep any already-cut hole if a context fails halfway through: never
      // flash the original full portal back over the incoming real workspace.
      if (immediate || motion.matches || document.hidden || !source) {
        queueMicrotask(() => finish(reason));
        return;
      }
      source.style.transition = "opacity 160ms ease-out";
      source.style.opacity = "0";
      finishTimer = window.setTimeout(() => finish(reason), 190);
    };
    const draw = (now: number) => {
      frame = null;
      if (disposed || doneRef.current || !source || !renderer) return;
      if (document.hidden) return finish("hidden");
      const progress = Math.min(1, Math.max(0, (now - startedAt) / BURN_DURATION));
      try {
        const bounds = source.getBoundingClientRect();
        const width = bounds.width || window.innerWidth;
        const height = bounds.height || window.innerHeight;
        const geometry = computeBurnGeometry(
          width,
          height,
          {
            x: origin.x - bounds.left,
            y: origin.y - bounds.top,
            front: origin.front?.map(([x, y]) => [x - bounds.left, y - bounds.top] as const),
          },
          progress,
        );
        path.setAttribute("d", geometry.maskPath);
        wrapper.dataset.clubBurnProgress = progress.toFixed(4);
        const surfaces: FireSurface[] = [
          {
            front: geometry.front.map(([x, y]) => [x + bounds.left, y + bounds.top] as const),
            clip: [0, 0, window.innerWidth, window.innerHeight],
            energy: 0.95,
            kind: "burn",
            seed: 3.27,
          },
        ];
        if (geometry.cardFront.length) {
          const remainingRadius = Math.hypot(
            geometry.cardFront[0]![0] - (origin.x - bounds.left),
            geometry.cardFront[0]![1] - (origin.y - bounds.top),
          );
          surfaces.push({
            front: geometry.cardFront.map(([x, y]) => [x + bounds.left, y + bounds.top] as const),
            clip: [0, 0, window.innerWidth, window.innerHeight],
            energy: 0.95,
            kind: "burn",
            seed: 3.27,
            inward: true,
            thickness: Math.min(0.45, remainingRadius / 60),
          });
        }
        renderer.draw(window.innerWidth, window.innerHeight, now / 1000, surfaces);
        if (progress >= 1) finish("burn-complete");
        else frame = requestAnimationFrame(draw);
      } catch {
        ordinary("graphics-failed");
      }
    };
    const begin = () => {
      if (disposed || doneRef.current || begun || !readyRef.current) return;
      if (!source) return ordinary("missing-source", true);
      if (motion.matches) return ordinary("reduced-motion", true);
      if (document.hidden) return ordinary("hidden", true);
      if (pendingOrdinary) return ordinary(pendingOrdinary);
      const clip = `url("#${id}")`;
      if (typeof CSS === "undefined" || !CSS.supports("clip-path", clip))
        return ordinary("clip-unavailable");
      try {
        attempted = true;
        renderer = createClubFireRenderer(canvas);
        source.style.setProperty("clip-path", clip);
        source.style.setProperty("-webkit-clip-path", clip);
        source.setAttribute("data-club-burn-mask", "svg-evenodd");
        begun = true;
        clearTimers();
        wrapper.dataset.renderer = "webgl";
        canvas.dataset.renderer = "webgl";
        wrapper.dataset.phase = "burning";
        startedAt = performance.now();
        // Install before the first draw so graphics fallback can replace it.
        finishTimer = window.setTimeout(() => finish("animation-watchdog"), BURN_DURATION + 220);
        // Paint the full opening and its fire together before the first frame.
        draw(startedAt);
      } catch {
        ordinary("graphics-unavailable");
      }
    };
    const visibility = () => {
      if (!document.hidden) return;
      if (begun) finish("hidden");
      else pendingOrdinary = "hidden";
    };
    const resize = () => {
      if (begun) finish("resize");
      else pendingOrdinary = "resize";
    };
    const preference = () => {
      if (!motion.matches) return;
      if (begun) ordinary("reduced-motion", true);
      else pendingOrdinary = "reduced-motion";
    };
    const contextLost = (event: Event) => {
      event.preventDefault();
      ordinary("context-lost");
    };
    kickRef.current = begin;
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("resize", resize);
    window.addEventListener("orientationchange", resize);
    window.visualViewport?.addEventListener("resize", resize);
    motion.addEventListener("change", preference);
    canvas.addEventListener("webglcontextlost", contextLost);
    waitTimer = window.setTimeout(() => {
      wrapper.dataset.readinessTimeout = "true";
      ordinary("readiness-timeout");
    }, READINESS_LIMIT);
    begin();
    return () => {
      disposed = true;
      kickRef.current = null;
      stopFrame();
      clearTimers();
      renderer?.clear();
      renderer?.dispose(false);
      renderer = null;
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("resize", resize);
      window.removeEventListener("orientationchange", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      motion.removeEventListener("change", preference);
      canvas.removeEventListener("webglcontextlost", contextLost);
      if (card) {
        for (const { property, value, priority } of previousCardStyles) {
          if (value) card.style.setProperty(property, value, priority);
          else card.style.removeProperty(property);
        }
      }
      if (source) {
        for (const { property, value, priority } of previousStyles) {
          if (value) source.style.setProperty(property, value, priority);
          else source.style.removeProperty(property);
        }
        if (previousMask === null) source.removeAttribute("data-club-burn-mask");
        else source.setAttribute("data-club-burn-mask", previousMask);
      }
      queueMicrotask(() => {
        if (attempted && !canvas.isConnected)
          canvas.getContext("webgl")?.getExtension("WEBGL_lose_context")?.loseContext();
      });
    };
  }, [sourceRef, id, origin.x, origin.y, origin.front, origin.card, origin.cardTransform]);

  useLayoutEffect(() => {
    kickRef.current?.();
  }, [ready]);

  return (
    <div
      ref={wrapperRef}
      className="club-entry-effect"
      aria-hidden="true"
      data-club-burn-progress="0"
      data-renderer="waiting"
    >
      <svg className="club-entry-defs" width="0" height="0" focusable="false">
        <defs>
          <clipPath id={id} clipPathUnits="userSpaceOnUse">
            <path ref={pathRef} clipRule="evenodd" fillRule="evenodd" />
          </clipPath>
        </defs>
      </svg>
      <canvas ref={canvasRef} className="club-entry-canvas" aria-hidden="true" />
    </div>
  );
}
