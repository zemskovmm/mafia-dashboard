import { useEffectEvent, useLayoutEffect, useRef } from "react";
import type { GlassStatus } from "../developer/GlassControls.js";
import { validateGlassSettings, type GlassSettings } from "./glass-preferences.js";
import { backgroundAsset, type BackgroundId } from "./background-preferences.js";
import { useFancyFeatures } from "../effects/FancyFeaturesContext.js";
import { loadVisualImage } from "../effects/image-assets.js";
import {
  createGlassRenderer,
  type GlassRenderer,
  type GlassSceneGeometry,
  type GlassSurfaceGeometry,
  type SceneRect,
} from "./glass-renderer.js";

const empty: SceneRect = [0, 0, 0, 0];
const opticalHandoffMs = 120;
const deviceRetryDelayMs = 500;
const panelSelector =
  ".glass-surface,.player-setup-card,.table-workspace,.nomination-panel,.timer-panel";
const surfaceSelector = `[data-player-glass],${panelSelector},button`;
// Overlay stacking, top-layer clipping and embedded media are DOM-owned. Never
// flatten their materials (or a developer card preview) into the workspace.
const localOverlay = "dialog,[popover],.app-drawer,[data-glass-local]";

const numericProperty = (
  style: CSSStyleDeclaration,
  name: string,
  fallback: number,
  min: number,
  max: number,
) => {
  const parsed = parseFloat(style.getPropertyValue(name));
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
};

const radiusFor = (style: CSSStyleDeclaration, rect: SceneRect, element: HTMLElement) => {
  // One circular radius per lens. Use an inscribed corner on joined buttons,
  // so the canvas never spills into a corner that CSS rounds more strongly.
  const scale = rect[2] / (element.offsetWidth || rect[2]);
  const radius = Math.max(
    0,
    ...[
      style.borderTopLeftRadius,
      style.borderTopRightRadius,
      style.borderBottomRightRadius,
      style.borderBottomLeftRadius,
    ]
      .flatMap((corner) =>
        corner
          .split(/\s+/)
          .map((value, axis) =>
            value.endsWith("%")
              ? (parseFloat(value) / 100) * rect[axis + 2]!
              : parseFloat(value) * scale,
          ),
      )
      .filter(Number.isFinite),
  );
  return Math.min(radius, rect[2] / 2, rect[3] / 2);
};
const visibleRect = (element: Element | null, style?: CSSStyleDeclaration): SceneRect => {
  if (!(element instanceof HTMLElement) || element.closest("[hidden]")) return empty;
  const r = element.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0 || (style ?? getComputedStyle(element)).visibility === "hidden")
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
  background = "black",
}: Readonly<{
  settings: GlassSettings;
  onStatus: (status: GlassStatus) => void;
  background?: BackgroundId;
}>) => {
  const enabled = useFancyFeatures() && settings.enabled;
  const layerRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef(settings);
  const redrawRef = useRef<(() => void) | null>(null);
  const reportStatus = useEffectEvent(onStatus);
  useLayoutEffect(() => {
    settingsRef.current = validateGlassSettings(settings);
    redrawRef.current?.();
  }, [settings]);

  useLayoutEffect(() => {
    if (!enabled) {
      reportStatus("off");
      return;
    }
    const layer = layerRef.current;
    const root = layer?.closest<HTMLElement>(".app-shell");
    if (layer === null || !root) return;
    if (typeof window.matchMedia !== "function" || typeof ResizeObserver !== "function") {
      reportStatus("unavailable");
      return;
    }
    const transparency = window.matchMedia("(prefers-reduced-transparency: reduce)");
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let renderer: GlassRenderer | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let frame: number | null = null;
    let ready = false;
    let until = 0;
    let disposed = false;
    let draws = 0;
    let lastGeometry = "";
    let generation = 0;
    let recovering = false;
    let retryTimer: number | null = null;
    let retryOnReturn = false;
    let pageSuspended = false;
    let painted = new Set<HTMLElement>();
    let candidates: HTMLElement[] = [];
    let collected: HTMLElement[] = [];
    let localTurns = new WeakMap<HTMLElement, number | null>();
    let localWeights = new Map<HTMLElement, number>();
    const setLocalWeight = (element: HTMLElement, weight: number) => {
      if (weight > 0) {
        element.dataset.glassBlending = "true";
        const value = String(weight);
        if (element.style.getPropertyValue("--glass-local-weight") !== value)
          element.style.setProperty("--glass-local-weight", value);
      } else {
        delete element.dataset.glassBlending;
        if (element.style.getPropertyValue("--glass-local-weight") !== "")
          element.style.removeProperty("--glass-local-weight");
      }
    };
    const markPainted = (elements: readonly HTMLElement[]) => {
      const next = new Set(elements);
      for (const element of painted)
        if (!next.has(element)) {
          delete element.dataset.glassPainted;
          setLocalWeight(element, 0);
        }
      for (const element of next) {
        if (!painted.has(element)) element.dataset.glassPainted = "true";
        setLocalWeight(element, localWeights.get(element) ?? 0);
      }
      painted = next;
    };
    const clearPaint = () => {
      if (canvas) {
        canvas.style.visibility = "hidden";
        delete canvas.dataset.glassBackground;
      }
      markPainted([]);
      localTurns = new WeakMap();
      localWeights.clear();
    };
    let colors: CanvasRenderingContext2D | null | undefined;
    const colorCache = new Map<string, readonly number[]>();
    const color = (value: string, fallback: readonly number[]): readonly number[] => {
      const cached = colorCache.get(value);
      if (cached !== undefined) return cached;
      if (colors === undefined)
        colors = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
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
    const collect = (now: number): GlassSceneGeometry => {
      const style = getComputedStyle(root);
      const variable = (name: string, fallback: readonly number[]) =>
        color(style.getPropertyValue(name), fallback);
      const view: SceneRect = [0, 0, window.innerWidth, window.innerHeight];
      const night = root.querySelector(".is-table-cycle-night") !== null;
      collected = [];
      localWeights = new Map();
      const appearance = settingsRef.current;
      const surfaces = candidates.flatMap<GlassSurfaceGeometry>((element) => {
        if (element.closest(localOverlay)) return [];
        const player = element.hasAttribute("data-player-glass");
        const panel = element.matches(panelSelector);
        const s = getComputedStyle(element);
        const button =
          !player && !panel && s.getPropertyValue("--host-glass-button").trim() === "1";
        if (!player && !panel && !button) return [];
        // Screen-space lenses cannot represent a rotating 3D perimeter.
        // The moving card owns its local fallback until it is planar again.
        const degrees = Number.parseFloat(s.rotate.split(/\s+/).at(-1) ?? "0");
        const turning =
          player &&
          Number.isFinite(degrees) &&
          Math.abs(Math.sin((degrees * Math.PI) / 180)) > 1e-4;
        if (turning) {
          localTurns.set(element, null);
          return [];
        }
        const rect = visibleRect(element, s);
        if (rect[2] === 0 || rect[3] === 0) return [];
        let clip = intersect(rect, view);
        const roundedClips: { rect: SceneRect; radius: number }[] = [];
        for (
          let parent = element.parentElement;
          parent !== null && parent !== root;
          parent = parent.parentElement
        ) {
          const parentStyle = getComputedStyle(parent);
          const clipsX = /auto|scroll|hidden|clip/.test(parentStyle.overflowX);
          const clipsY = /auto|scroll|hidden|clip/.test(parentStyle.overflowY);
          if (clipsX || clipsY) {
            const bounds = visibleRect(parent, parentStyle);
            clip = intersect(clip, [
              clipsX ? bounds[0] : view[0],
              clipsY ? bounds[1] : view[1],
              clipsX ? bounds[2] : view[2],
              clipsY ? bounds[3] : view[3],
            ]);
            const radius = clipsX && clipsY ? radiusFor(parentStyle, bounds, parent) : 0;
            if (radius > 0) roundedClips.push({ rect: bounds, radius });
          }
        }
        // Retain local fallback rather than pretending unsupported clipping painted.
        if (clip[2] === 0 || clip[3] === 0 || roundedClips.length > 4) return [];
        const geometry = { rect, clip, radius: radiusFor(s, rect, element), roundedClips };
        collected.push(element);
        if (!player) {
          if (button) {
            // Keep the same gold/frost controls as CSS without changing the
            // player-card settings, text opacity or semantic button states.
            const gold = numericProperty(s, "--button-glass-gold", 0.35, 0, 1);
            const frost = numericProperty(s, "--button-glass-frost", 4.2, 0, 6);
            return [
              {
                ...geometry,
                optics: appearance.surfaces.buttons,
                tint: [0.06 + gold * 0.32, 0.075 + gold * 0.21, 0.07 + gold * 0.09] as const,
                tintAmount: 0.62 + gold * 0.14,
                frosting: frost,
                opacity: Number(s.opacity || "1"),
              },
            ];
          }
          const isTableWorkspace = element.matches(".table-workspace");
          return [
            {
              ...geometry,
              optics: appearance.surfaces[isTableWorkspace ? "table" : "panels"],
              excludeTableFelt: isTableWorkspace,
              frosting: 0.5,
              tint: [0.059, 0.063, 0.067] as const,
              tintAmount: numericProperty(s, "--host-glass-panel-floor", 0.58, 0, 1),
              opacity: 1,
            },
          ];
        }
        const tear = numericProperty(s, "--player-exit-tear", 0, 0, 1);
        const gap = numericProperty(s, "--player-exit-gap", 6, 2, 12);
        const fade = numericProperty(s, "--player-exit-fade", 1, 0, 1);
        let sharedWeight = 1;
        const handoff = localTurns.get(element);
        if (handoff !== undefined) {
          const began = handoff ?? now;
          // Only the returning planar lens blends. The semantic card, public
          // content and shared opaque scene never receive this opacity.
          if (
            !motion.matches &&
            (element.hasAttribute("data-player-exit") ||
              element.classList.contains("role-draw-card"))
          )
            sharedWeight = Math.min(1, Math.max(0, (now - began) / opticalHandoffMs));
          if (sharedWeight < 1) {
            localTurns.set(element, began);
            localWeights.set(element, 1 - sharedWeight);
            until = Math.max(until, began + opticalHandoffMs);
          } else localTurns.delete(element);
        }

        const baseTint: readonly [number, number, number] = element.matches(".is-sheriff-highlight")
          ? [0.3, 0.5, 0.85]
          : element.matches(".is-mafia-shooter")
            ? [0.75, 0.24, 0.22]
            : element.matches(
                  ".is-current,.is-voting-highlight,.is-goodbye-highlight,.is-availability-selected",
                )
              ? [0.67, 0.51, 0.25]
              : [0.08, 0.1, 0.09];

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
        return [
          {
            ...geometry,
            tint,
            tintAmount,
            selectionFinish: element.matches(".table-stage .player-seat.is-nomination-selected")
              ? 0.5
              : 0,
            opacity: Number(s.opacity || "1") * fade * sharedWeight,
            ...(tear > 0 ? { tear: { progress: tear, gap } } : {}),
          },
        ];
      });
      const workspace = root.querySelector(".availability-selection-card,.player-setup-card");
      const table = root.querySelector<HTMLElement>(".round-table");
      const tableRect = visibleRect(table);
      if (table && tableRect[2] > 0 && tableRect[3] > 0) collected.push(table);
      return {
        width: view[2],
        height: view[3],
        table: tableRect,
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
    const cancelRetry = () => {
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = null;
    };
    const revoke = () => {
      generation += 1;
      stop();
      cancelRetry();
      ready = false;
      clearPaint();
      const retired = renderer;
      renderer = null;
      const target = canvas;
      canvas = null;
      retired?.dispose();
      target?.remove();
    };
    const requestDraw = () => {
      const version = generation;
      frame = requestAnimationFrame((now) => {
        if (version === generation) draw(now);
      });
    };
    const draw = (now: number) => {
      frame = null;
      if (disposed || document.hidden || transparency.matches || !renderer || !canvas) return;
      const active = renderer;
      const target = canvas;
      try {
        const scene = collect(now);
        const geometry = JSON.stringify(scene);
        if (geometry !== lastGeometry) {
          active.draw(scene);
          // A loss callback can fire during the draw. Never publish that frame.
          if (renderer !== active) return;
          lastGeometry = geometry;
          draws += 1;
          target.dataset.glassDraws = String(draws);
          target.dataset.glassSurfaces = String(scene.surfaces.length);
          target.dataset.glassBackground = background;
          target.style.visibility = "";
        }
        // A filtered/replaced host may reuse pixels at identical geometry.
        markPainted(collected);
        if (!ready) {
          ready = true;
          recovering = false;
          retryOnReturn = false;
          reportStatus("ready");
        }
        if (now < until) requestDraw();
      } catch {
        if (renderer !== active) return;
        revoke();
        reportStatus("unavailable");
      }
    };
    const schedule = (duration = 0, force = false) => {
      if (force) lastGeometry = "";
      if (disposed || document.hidden || renderer === null || transparency.matches) return;
      until = Math.max(until, performance.now() + (motion.matches ? 0 : duration));
      if (frame === null) requestDraw();
    };
    const start = () => {
      revoke();
      lastGeometry = "";
      draws = 0;
      if (transparency.matches) {
        reportStatus("reduced-transparency");
        return;
      }

      // Canvas contexts are single-owner. A slow obsolete acquisition may still
      // resolve and dispose after a new attempt has started, so never share its
      // canvas. React owns the empty slot; this effect owns its only child.
      const target = document.createElement("canvas");
      target.className = "glass-scene-canvas";
      target.style.visibility = "hidden";
      layer.append(target);
      canvas = target;
      reportStatus("initializing");
      const version = generation;
      const current = () => !disposed && version === generation && !transparency.matches;
      const onLost = () => {
        if (!current()) return;
        const firstLoss = !recovering;
        recovering = true;
        const foreground = !document.hidden && !pageSuspended;
        if (firstLoss || !foreground) retryOnReturn = true;
        revoke();
        // Budget one automatic retry until a replacement actually paints. If
        // it fails (or the page goes hidden), wait for the next page return.
        if (firstLoss && foreground) {
          const lostGeneration = generation;
          retryTimer = window.setTimeout(() => {
            if (generation !== lostGeneration || disposed) return;
            retryTimer = null;
            if (!document.hidden && !pageSuspended && !transparency.matches) {
              retryOnReturn = false;
              start();
            }
          }, deviceRetryDelayMs);
        }
        reportStatus("context-lost");
      };
      const initialize = async () => {
        try {
          // Let StrictMode's setup/cleanup replay settle before asking for GPU
          // resources. Image decoding is shared and must not be cancelled here.
          await Promise.resolve();
          if (!current()) return;
          const asset = backgroundAsset(background);
          const image = asset === null ? undefined : await loadVisualImage(asset);
          if (!current()) return;
          const acquired = await createGlassRenderer(target, image, onLost);
          if (!current()) {
            acquired.dispose();
            return;
          }
          renderer = acquired;
          schedule(950, true);
        } catch {
          if (!current()) return;
          revoke();
          reportStatus("unavailable");
        }
      };
      void initialize();
    };
    const geometryChanged = () => schedule(950);
    const playerExitMotion = (event: Event) => {
      const duration = (event as CustomEvent<{ duration?: unknown }>).detail?.duration;
      if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) return;
      // WAAPI custom-property ticks do not mutate style attributes. Stay awake
      // for this bounded track, including the first frame after its endpoint.
      schedule(Math.min(duration, 30_000));
    };
    const suspendRecovery = () => {
      stop();
      cancelRetry();
      if (recovering) retryOnReturn = true;
    };
    const returnToPage = () => {
      if (document.hidden || pageSuspended) return;
      if (retryOnReturn && retryTimer === null) {
        // The return grants one attempt, even when pageshow and visibilitychange
        // arrive on opposite sides of a failed acquisition.
        retryOnReturn = false;
        if (canvas === null && !transparency.matches) start();
      }
      schedule(950, true);
    };
    const visibilityChanged = () => {
      if (document.hidden) suspendRecovery();
      else returnToPage();
    };
    const pageHidden = () => {
      pageSuspended = true;
      suspendRecovery();
    };
    const pageShown = () => {
      pageSuspended = false;
      returnToPage();
    };
    const transparencyChanged = () => {
      recovering = false;
      retryOnReturn = false;
      start();
    };

    const resize = new ResizeObserver(geometryChanged);
    resize.observe(root);
    const observed = new Set<Element>();
    // The observed contents can change without resizing their fixed viewport.
    const watchLayout = () => {
      candidates = [...root.querySelectorAll<HTMLElement>(surfaceSelector)];
      const current = new Set(root.querySelectorAll(`.round-table,${surfaceSelector}`));
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
    const mutation = new MutationObserver((records) => {
      if (records.some((record) => record.target !== layer && record.target !== canvas)) {
        if (
          records.some(
            (record) =>
              record.type === "childList" ||
              record.attributeName === "class" ||
              record.attributeName === "data-player-glass",
          )
        )
          watchLayout();
        geometryChanged();
      }
    });
    mutation.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "aria-pressed", "open", "data-player-glass"],
    });
    const themeChanges = new MutationObserver(geometryChanged);
    themeChanges.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class", "data-theme"],
    });
    window.addEventListener("resize", geometryChanged);
    window.addEventListener("orientationchange", geometryChanged);
    window.addEventListener("pagehide", pageHidden);
    window.addEventListener("pageshow", pageShown);
    document.addEventListener("visibilitychange", visibilityChanged);
    root.addEventListener("scroll", geometryChanged, true);
    root.addEventListener("transitionrun", geometryChanged, true);
    root.addEventListener("transitionend", geometryChanged, true);
    root.addEventListener("player-exit-motion", playerExitMotion);
    transparency.addEventListener("change", transparencyChanged);
    motion.addEventListener("change", geometryChanged);
    redrawRef.current = () => schedule(950, true);
    start();
    return () => {
      disposed = true;
      revoke();
      mutation.disconnect();
      themeChanges.disconnect();
      resize.disconnect();
      window.removeEventListener("resize", geometryChanged);
      window.removeEventListener("orientationchange", geometryChanged);
      window.removeEventListener("pagehide", pageHidden);
      window.removeEventListener("pageshow", pageShown);
      document.removeEventListener("visibilitychange", visibilityChanged);
      root.removeEventListener("scroll", geometryChanged, true);
      root.removeEventListener("transitionrun", geometryChanged, true);
      root.removeEventListener("transitionend", geometryChanged, true);
      root.removeEventListener("player-exit-motion", playerExitMotion);
      transparency.removeEventListener("change", transparencyChanged);
      motion.removeEventListener("change", geometryChanged);
      redrawRef.current = null;
    };
  }, [background, enabled]);
  return enabled ? <div ref={layerRef} className="glass-scene-layer" aria-hidden="true" /> : null;
};
