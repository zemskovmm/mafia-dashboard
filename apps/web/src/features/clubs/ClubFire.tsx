import { useEffect, useRef, type RefObject } from "react";
import {
  computeCardFront,
  createClubFireRenderer,
  type ClubFireRenderer,
  type FireRect,
  type FireSurface,
} from "./club-fire-renderer.js";
import "./club-fire.css";

const CARD_SELECTOR = ".club-playing-card:not(.new-club-card)";

const intersect = (a: FireRect, b: FireRect): FireRect => {
  const x = Math.max(a[0], b[0]),
    y = Math.max(a[1], b[1]);
  return [
    x,
    y,
    Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - x),
    Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - y),
  ];
};

/** One shared, hit-test-transparent scene for existing (never "new") cards. */
export function ClubFire({
  rootRef,
  enabled = true,
}: {
  rootRef: RefObject<HTMLElement | null>;
  enabled?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // A parent host ref is assigned after its children's layout effects. Run
  // after the whole commit so this also works when mounted INSIDE rootRef.
  useEffect(() => {
    const root = rootRef.current,
      canvas = canvasRef.current;
    if (!enabled || !root || !canvas) return;
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? {
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    };
    let renderer: ClubFireRenderer | null = null;
    let frame: number | null = null;
    let disposed = false;
    let lost = false;
    let failed = false;
    let attempted = false;
    let lastDraw = -Infinity;
    let draws = 0;
    let cards: HTMLElement[] = [];
    const pulses = new WeakMap<HTMLElement, number>();
    const energies = new WeakMap<HTMLElement, number>();
    const originalCues = new Map<HTMLElement, string | null>();
    const restoreCue = (card: HTMLElement) => {
      if (!originalCues.has(card)) return;
      const previous = originalCues.get(card);
      if (previous == null) card.removeAttribute("data-club-fire-static");
      else card.setAttribute("data-club-fire-static", previous);
      originalCues.delete(card);
    };
    const cues = (active: boolean) => {
      for (const card of cards) {
        if (active) {
          if (!originalCues.has(card))
            originalCues.set(card, card.getAttribute("data-club-fire-static"));
          card.setAttribute("data-club-fire-static", "true");
        } else restoreCue(card);
      }
    };
    const stop = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    };
    const fallback = (reason: string) => {
      stop();
      failed = true;
      renderer?.clear();
      renderer?.dispose(false);
      renderer = null;
      canvas.dataset.renderer = reason;
      cues(true);
    };
    const collect = (now: number): FireSurface[] => {
      const view: FireRect = [0, 0, window.innerWidth, window.innerHeight];
      const surfaces: FireSurface[] = [];
      let active = 0;
      cards.forEach((card, index) => {
        const viewport = card.closest(".club-portal-content");
        if (!(viewport instanceof HTMLElement) || card.closest("[hidden]")) return;
        const r = card.getBoundingClientRect();
        const style = getComputedStyle(card);
        if (
          r.width <= 0 ||
          r.height <= 0 ||
          style.visibility === "hidden" ||
          Number(style.opacity) === 0
        )
          return;
        const port = viewport.getBoundingClientRect();
        let clip = intersect(view, [
          port.left + viewport.clientLeft,
          port.top + viewport.clientTop,
          viewport.clientWidth,
          viewport.clientHeight,
        ]);
        // Respect other actual scrolling/clipping ancestors, not just the page.
        for (
          let ancestor = viewport.parentElement;
          ancestor && ancestor !== root;
          ancestor = ancestor.parentElement
        ) {
          const parentStyle = getComputedStyle(ancestor);
          if (/auto|scroll|hidden|clip/.test(parentStyle.overflowX + parentStyle.overflowY)) {
            const bounds = ancestor.getBoundingClientRect();
            clip = intersect(clip, [bounds.x, bounds.y, bounds.width, bounds.height]);
          }
        }
        if (
          clip[2] <= 0 ||
          clip[3] <= 0 ||
          r.right < clip[0] ||
          r.left > clip[0] + clip[2] ||
          r.bottom < clip[1] ||
          r.top > clip[1] + clip[3]
        )
          return;
        const hovered = card.matches(":hover,:focus-within");
        const pulse = Math.max(0, ((pulses.get(card) ?? 0) - now) / 650);
        const target = pulse > 0 ? 1 : hovered ? 0.82 : 0.065;
        const energy = (energies.get(card) ?? target) * 0.79 + target * 0.21;
        energies.set(card, energy);
        if (hovered || pulse > 0) active++;
        surfaces.push({
          front: computeCardFront(card, r, style),
          clip,
          energy,
          kind: "card",
          seed: index + 0.71,
        });
      });
      canvas.dataset.clubFireActive = String(active);
      canvas.dataset.clubFireCards = String(surfaces.length);
      return surfaces;
    };
    const draw = (now: number) => {
      frame = null;
      if (disposed || document.hidden || motion.matches || !renderer) return;
      if (now - lastDraw >= 1000 / 30) {
        try {
          const surfaces = collect(now);
          renderer.draw(window.innerWidth, window.innerHeight, now / 1000, surfaces);
          canvas.dataset.clubFireDraws = String(++draws);
          lastDraw = now;
          if (!surfaces.length) return; // mutations/scroll/resize wake it again
        } catch {
          fallback("static-unavailable");
          return;
        }
      }
      frame = requestAnimationFrame(draw);
    };
    const schedule = () => {
      if (!disposed && !document.hidden && !motion.matches && renderer && frame === null)
        frame = requestAnimationFrame(draw);
    };
    const refresh = () => {
      const current = [...root.querySelectorAll<HTMLElement>(CARD_SELECTOR)];
      for (const previous of cards) if (!current.includes(previous)) restoreCue(previous);
      cards = current;
      cues(motion.matches || failed || lost);
      schedule();
    };
    const start = () => {
      stop();
      renderer?.dispose(false);
      renderer = null;
      failed = false;
      if (motion.matches) {
        canvas.dataset.renderer = "static-reduced-motion";
        cues(true);
        return;
      }
      if (lost) return fallback("static-context-lost");
      try {
        attempted = true;
        renderer = createClubFireRenderer(canvas);
        canvas.dataset.renderer = "webgl";
        cues(false);
        lastDraw = -Infinity;
        schedule();
      } catch {
        fallback("static-unavailable");
      }
    };
    const contextLost = (event: Event) => {
      event.preventDefault();
      lost = true;
      fallback("static-context-lost");
    };
    const contextRestored = () => {
      lost = false;
      start();
    };
    const visibility = () => {
      canvas.dataset.paused = String(document.hidden);
      if (document.hidden) stop();
      else schedule();
    };
    const pulse = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") return;
      const card =
        event.target instanceof Element ? event.target.closest<HTMLElement>(CARD_SELECTOR) : null;
      if (card && root.contains(card)) pulses.set(card, performance.now() + 650);
      schedule();
    };
    const mutation = new MutationObserver(refresh);
    mutation.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden"],
    });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(root);
    root.querySelectorAll(".club-portal-content").forEach((element) => resize?.observe(element));
    root.addEventListener("scroll", schedule, true);
    root.addEventListener("pointerover", schedule);
    root.addEventListener("focusin", schedule);
    root.addEventListener("pointerdown", pulse);
    root.addEventListener("keydown", pulse);
    window.addEventListener("resize", schedule);
    document.addEventListener("visibilitychange", visibility);
    motion.addEventListener("change", start);
    canvas.addEventListener("webglcontextlost", contextLost);
    canvas.addEventListener("webglcontextrestored", contextRestored);
    refresh();
    start();
    visibility();
    return () => {
      disposed = true;
      stop();
      mutation.disconnect();
      resize?.disconnect();
      root.removeEventListener("scroll", schedule, true);
      root.removeEventListener("pointerover", schedule);
      root.removeEventListener("focusin", schedule);
      root.removeEventListener("pointerdown", pulse);
      root.removeEventListener("keydown", pulse);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("visibilitychange", visibility);
      motion.removeEventListener("change", start);
      canvas.removeEventListener("webglcontextlost", contextLost);
      canvas.removeEventListener("webglcontextrestored", contextRestored);
      for (const card of [...originalCues.keys()]) restoreCue(card);
      renderer?.clear();
      renderer?.dispose(false);
      renderer = null;
      // StrictMode reuses a connected canvas: never lose that live context.
      queueMicrotask(() => {
        if (attempted && !canvas.isConnected)
          canvas.getContext("webgl")?.getExtension("WEBGL_lose_context")?.loseContext();
      });
    };
  }, [rootRef, enabled]);

  return (
    <canvas
      ref={canvasRef}
      className="club-fire-canvas"
      aria-hidden="true"
      hidden={!enabled}
      data-renderer="initializing"
    />
  );
}
