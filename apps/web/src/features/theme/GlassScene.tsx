import { useEffect, useLayoutEffect, useRef } from "react";
import type { GlassStatus } from "../developer/GlassControls.js";
import { validateGlassSettings, type GlassSettings } from "./glass-preferences.js";
import {
  createGlassRenderer,
  type GlassRenderer,
  type GlassSceneGeometry,
  type SceneRect,
} from "./glass-renderer.js";

const empty: SceneRect = [0, 0, 0, 0];
const visibleRect = (element: Element | null): SceneRect => {
  if (!(element instanceof HTMLElement) || element.closest("[hidden]")) return empty;
  const r = element.getBoundingClientRect();
  if (r.width === 0 || r.height === 0 || getComputedStyle(element).visibility === "hidden")
    return empty;
  return [r.x, r.y, r.width, r.height];
};
const intersect = (a: SceneRect, b: SceneRect): SceneRect => {
  const x = Math.max(a[0], b[0]);
  const y = Math.max(a[1], b[1]);
  return [
    x,
    y,
    Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - x),
    Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - y),
  ];
};

export const GlassScene = ({
  settings,
  onStatus,
}: Readonly<{
  settings: GlassSettings;
  onStatus: (status: GlassStatus) => void;
}>) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const settingsRef = useRef(settings);
  const redrawRef = useRef<(() => void) | null>(null);
  settingsRef.current = validateGlassSettings(settings);
  useEffect(() => {
    redrawRef.current?.();
  }, [settings]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const root = canvas?.closest(".app-shell");
    if (canvas === null || !(root instanceof HTMLElement)) return;
    if (typeof window.matchMedia !== "function" || typeof ResizeObserver !== "function") {
      onStatus("unavailable");
      return;
    }
    const transparency = window.matchMedia("(prefers-reduced-transparency: reduce)");
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let renderer: GlassRenderer | null = null;
    let frame: number | null = null;
    let until = 0;
    let disposed = false;
    let draws = 0;
    let lastGeometry = "";
    let lost = false;
    let painted = new Set<HTMLElement>();
    let collected: HTMLElement[] = [];
    const markPainted = (elements: readonly HTMLElement[]) => {
      const next = new Set(elements);
      for (const element of painted) if (!next.has(element)) delete element.dataset.glassPainted;
      for (const element of next) element.dataset.glassPainted = "true";
      painted = next;
    };
    const colors = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    const colorCache = new Map<string, readonly number[]>();
    const color = (value: string, fallback: readonly number[]): readonly number[] => {
      const cached = colorCache.get(value);
      if (cached !== undefined) return cached;
      if (colors === null) return fallback;
      colors.clearRect(0, 0, 1, 1);
      colors.fillStyle = "#000";
      colors.fillStyle = value.trim();
      colors.fillRect(0, 0, 1, 1);
      const p = colors.getImageData(0, 0, 1, 1).data;
      const result = [p[0]! / 255, p[1]! / 255, p[2]! / 255];
      if (colorCache.size >= 64) colorCache.clear();
      colorCache.set(value, result);
      return result;
    };
    const collect = (): GlassSceneGeometry => {
      const style = getComputedStyle(root);
      const variable = (name: string, fallback: readonly number[]) =>
        color(style.getPropertyValue(name), fallback);
      const view: SceneRect = [0, 0, window.innerWidth, window.innerHeight];
      const night = root.querySelector(".is-table-cycle-night") !== null;
      collected = [];
      const surfaces = [...root.querySelectorAll<HTMLElement>("[data-player-glass]")].flatMap(
        (element) => {
          const rect = visibleRect(element);
          if (rect[2] === 0 || rect[3] === 0) return [];
          let clip = intersect(rect, view);
          const roundedClips: { rect: SceneRect; radius: number }[] = [];
          for (
            let parent = element.parentElement;
            parent !== null && parent !== root;
            parent = parent.parentElement
          ) {
            const parentStyle = getComputedStyle(parent);
            if (/auto|scroll|hidden|clip/.test(parentStyle.overflowX + parentStyle.overflowY)) {
              const bounds = visibleRect(parent);
              clip = intersect(clip, bounds);
              const radius = parseFloat(parentStyle.borderTopLeftRadius);
              if (radius > 0) roundedClips.push({ rect: bounds, radius });
            }
          }
          // Retain local fallback rather than pretending unsupported clipping painted.
          if (clip[2] === 0 || clip[3] === 0 || roundedClips.length > 4) return [];
          const s = getComputedStyle(element);
          const radius = parseFloat(s.borderTopLeftRadius) * (rect[2] / element.offsetWidth);
          const baseTint: readonly [number, number, number] = element.matches(
            ".is-sheriff-highlight",
          )
            ? [0.3, 0.5, 0.85]
            : element.matches(".is-mafia-shooter")
              ? [0.75, 0.24, 0.22]
              : element.matches(
                    ".is-current,.is-voting-highlight,.is-goodbye-highlight,.is-availability-selected",
                  )
                ? [0.67, 0.51, 0.25]
                : [0.08, 0.1, 0.09];
          const appearance = settingsRef.current;
          const nominated =
            !night &&
            element.matches(
              ".player-seat.is-nominated:not(.is-current,.is-voting-highlight,.is-goodbye-highlight,.is-sheriff-highlight,.is-mafia-shooter,.is-night-check-highlight,.is-availability-selected)",
            );
          const extra =
            nominated && appearance.nominationTreatment !== "icons"
              ? appearance.nominationTint / 100
              : 0;

          const contrastFloor = Math.min(
            1,
            Math.max(0, parseFloat(s.getPropertyValue("--liquid-card-contrast-floor")) || 0),
          );
          const base = contrastFloor + (1 - contrastFloor) * (appearance.tint / 100);
          const tintAmount = base + extra * (1 - base);
          const nomination = color(appearance.nominationColor, [230 / 255, 188 / 255, 126 / 255]);
          // Compose the extra wash into the existing tint uniform. This is
          // algebraically the same two mixes as the fallback, with no new
          // shader path or duplicated base-tint control. Active cues skip it.
          const channel = (index: number) =>
            (baseTint[index]! * base * (1 - extra) + nomination[index]! * extra) / tintAmount;
          const tint: readonly [number, number, number] =
            extra > 0 ? [channel(0), channel(1), channel(2)] : baseTint;
          collected.push(element);
          return [
            {
              rect,
              clip,
              radius: Math.min(Number.isFinite(radius) ? radius : 10, rect[2] / 2, rect[3] / 2),
              tint,
              tintAmount,
              opacity: Number(s.opacity),
              roundedClips,
            },
          ];
        },
      );
      const workspace = root.querySelector(".availability-selection-card,.player-setup-card");
      return {
        width: view[2],
        height: view[3],
        table: visibleRect(root.querySelector(".round-table")),
        panel: visibleRect(root.querySelector(".live-side-panel")),
        nomination: visibleRect(root.querySelector(".nomination-panel")),
        workspace: visibleRect(workspace),
        workspaceRadius:
          workspace === null ? 0 : parseFloat(getComputedStyle(workspace).borderTopLeftRadius),
        background: variable("--glass-bg", [0.047, 0.043, 0.04]),
        top: variable("--glass-top", [0.063, 0.055, 0.043]),
        theme: variable("--theme-base", [0.765, 0.604, 0.345]),
        felt: variable("--felt", [0.09, 0.23, 0.18]),
        feltDark: variable("--felt-dark", [0.04, 0.14, 0.11]),
        night,
        gold: settingsRef.current.goldLight / 100,
        strength: settingsRef.current.refraction,
        matte: settingsRef.current.matte,
        profile: settingsRef.current.profile,
        frosting: settingsRef.current.frosting * 0.04,
        tintAmount: settingsRef.current.tint / 100,
        edgeHighlights: settingsRef.current.edgeHighlights / 100,
        caustics: settingsRef.current.caustics / 100,
        surfaces,
      };
    };
    const stop = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      until = 0;
    };
    const draw = (now: number) => {
      frame = null;
      if (disposed || document.hidden || transparency.matches || renderer === null) return;
      try {
        const scene = collect();
        const geometry = JSON.stringify(scene);
        if (geometry !== lastGeometry) {
          renderer.draw(scene);
          lastGeometry = geometry;
          draws += 1;
          canvas.dataset.glassDraws = String(draws);
          canvas.dataset.glassSurfaces = String(scene.surfaces.length);
          onStatus("ready");
        }
        // A filtered/replaced host may reuse pixels at identical geometry.
        markPainted(collected);
        if (now < until) frame = requestAnimationFrame(draw);
      } catch {
        markPainted([]);
        stop();
        renderer?.dispose(false);
        renderer = null;
        onStatus("unavailable");
      }
    };
    const schedule = (duration = 0, force = false) => {
      if (force) lastGeometry = "";
      if (disposed || document.hidden || renderer === null || transparency.matches) return;
      until = Math.max(until, performance.now() + (motion.matches ? 0 : duration));
      if (frame === null) frame = requestAnimationFrame(draw);
    };
    const start = () => {
      // Media changes reuse the canvas context. Deliberately losing it here
      // would be indistinguishable from an external loss and prevent restart.
      stop();
      renderer?.dispose(false);
      renderer = null;
      lastGeometry = "";
      markPainted([]);
      if (transparency.matches) {
        onStatus("reduced-transparency");
        return;
      }
      if (lost) {
        onStatus("context-lost");
        return;
      }
      onStatus("initializing");
      try {
        renderer = createGlassRenderer(canvas);
        schedule(950, true);
      } catch {
        onStatus("unavailable");
      }
    };
    const geometryChanged = () => schedule(950);
    const returnToPage = () => {
      if (document.hidden) stop();
      else schedule(950, true);
    };
    const contextLost = (event: Event) => {
      event.preventDefault();
      lost = true;
      markPainted([]);
      stop();
      renderer?.dispose(false);
      renderer = null;
      onStatus("context-lost");
    };
    const contextRestored = () => {
      lost = false;
      start();
    };
    const preferenceChanged = () => {
      start();
    };
    const mutation = new MutationObserver(geometryChanged);
    mutation.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden"],
    });
    const resize = new ResizeObserver(geometryChanged);
    resize.observe(root);
    const observed = new Set<Element>();
    // The observed contents can change without resizing their fixed viewport.
    const watchLayout = () => {
      const current = new Set(
        root.querySelectorAll(
          ".round-table,.live-side-panel,.nomination-panel,.player-setup-card,.availability-selection-card,[data-player-glass]",
        ),
      );
      for (const node of observed)
        if (!current.has(node)) {
          resize.unobserve(node);
          observed.delete(node);
        }
      for (const node of current)
        if (!observed.has(node)) {
          resize.observe(node);
          observed.add(node);
        }
    };
    watchLayout();
    const children = new MutationObserver(watchLayout);
    children.observe(root, { childList: true, subtree: true });
    const themeChanges = new MutationObserver(geometryChanged);
    themeChanges.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class", "data-theme"],
    });
    window.addEventListener("resize", geometryChanged);
    window.addEventListener("orientationchange", geometryChanged);
    window.addEventListener("pageshow", returnToPage);
    document.addEventListener("visibilitychange", returnToPage);
    root.addEventListener("scroll", geometryChanged, true);
    root.addEventListener("transitionrun", geometryChanged, true);
    root.addEventListener("transitionend", geometryChanged, true);
    canvas.addEventListener("webglcontextlost", contextLost);
    canvas.addEventListener("webglcontextrestored", contextRestored);
    transparency.addEventListener("change", preferenceChanged);
    redrawRef.current = () => schedule(950, true);
    start();
    return () => {
      disposed = true;
      markPainted([]);
      stop();
      mutation.disconnect();
      children.disconnect();
      themeChanges.disconnect();
      resize.disconnect();
      window.removeEventListener("resize", geometryChanged);
      window.removeEventListener("orientationchange", geometryChanged);
      window.removeEventListener("pageshow", returnToPage);
      document.removeEventListener("visibilitychange", returnToPage);
      root.removeEventListener("scroll", geometryChanged, true);
      root.removeEventListener("transitionrun", geometryChanged, true);
      root.removeEventListener("transitionend", geometryChanged, true);
      canvas.removeEventListener("webglcontextlost", contextLost);
      canvas.removeEventListener("webglcontextrestored", contextRestored);
      transparency.removeEventListener("change", preferenceChanged);
      redrawRef.current = null;
      renderer?.dispose(false);
      // StrictMode replays layout effects on the same connected canvas. Delete
      // resources now, but release its context only after a genuine DOM exit.
      queueMicrotask(() => {
        if (!canvas.isConnected)
          canvas.getContext("webgl")?.getExtension("WEBGL_lose_context")?.loseContext();
      });
      renderer = null;
      onStatus("initializing");
    };
  }, [onStatus]);
  return <canvas ref={canvasRef} className="glass-scene-canvas" aria-hidden="true" />;
};
