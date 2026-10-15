import { useContext, useEffect, useId, useRef, useState } from "react";
import { SharedGlassContext } from "./SharedGlassContext.js";
import { PlayerCardAppearanceContext } from "./PlayerCardAppearanceContext.js";
import { DEFAULT_GLASS_SETTINGS, validateGlassSettings } from "./glass-preferences.js";
import type { CSSProperties } from "react";
import { createLiquidCardLens } from "./liquid-card-lens.js";
import type { LiquidCardLens } from "./liquid-card-lens.js";
import "./LiquidCardGlass.css";

const RESIZE_SETTLE_MS = 100;

const localRadius = (surface: HTMLElement, width: number, height: number): number => {
  const view = surface.ownerDocument.defaultView;
  if (view === null) return 0;
  const ownStyle = view.getComputedStyle(surface);
  const hostStyle =
    surface.parentElement === null ? null : view.getComputedStyle(surface.parentElement);
  const ownRadius = ownStyle.borderTopLeftRadius || ownStyle.borderRadius;
  const value =
    ownRadius && ownRadius !== "inherit"
      ? ownRadius
      : hostStyle?.borderTopLeftRadius || hostStyle?.borderRadius || "0";
  const firstRadius = value.split(/\s+/)[0] ?? "0";
  const radius = Number.parseFloat(firstRadius);
  if (!Number.isFinite(radius)) return 0;
  return firstRadius.endsWith("%") ? (radius * Math.min(width, height)) / 100 : radius;
};

/**
 * Insert as the first child of a positioned card, before its lighting/content.
 * No content is wrapped or filtered. The host owns its semantics, transparent
 * fill, focus outline and state colours; this span owns only the glass surface.
 */
export const LiquidCardGlass = () => {
  return useContext(SharedGlassContext) ? null : <ExistingLiquidCardGlass />;
};

const ExistingLiquidCardGlass = () => {
  const appearance = validateGlassSettings({
    ...DEFAULT_GLASS_SETTINGS,
    ...useContext(PlayerCardAppearanceContext),
  });
  const surfaceRef = useRef<HTMLSpanElement>(null);
  const lightRef = useRef<HTMLSpanElement>(null);
  const filterId = `liquid-card-lens-${useId()}`;
  const [lens, setLens] = useState<LiquidCardLens | null>(null);

  useEffect(() => {
    const surface = surfaceRef.current;
    const view = surface?.ownerDocument.defaultView;
    if (surface === null || view === null || view === undefined) return;
    let disposed = false;
    let resizeTimer: number | undefined;
    let width = surface.offsetWidth;
    let height = surface.offsetHeight;
    const reducedTransparency = view.matchMedia?.("(prefers-reduced-transparency: reduce)");
    const updateLens = () => {
      if (disposed) return;
      setLens(
        reducedTransparency?.matches
          ? null
          : createLiquidCardLens(
              surface.ownerDocument,
              width,
              height,
              localRadius(surface, width, height),
            ),
      );
    };
    reducedTransparency?.addEventListener?.("change", updateLens);
    const scheduleResize = (nextWidth: number, nextHeight: number) => {
      if (width === nextWidth && height === nextHeight) return;
      width = nextWidth;
      height = nextHeight;
      view.clearTimeout(resizeTimer);
      resizeTimer = view.setTimeout(updateLens, RESIZE_SETTLE_MS);
    };
    // offset/content sizes remain local when the host scales for a vote; a
    // transformed viewport rect would incorrectly shrink the optical map.
    updateLens();
    const onWindowResize = () => scheduleResize(surface.offsetWidth, surface.offsetHeight);
    const observer =
      typeof view.ResizeObserver === "function"
        ? new view.ResizeObserver((entries) => {
            const entry = entries.find((candidate) => candidate.target === surface);
            if (entry !== undefined)
              scheduleResize(entry.contentRect.width, entry.contentRect.height);
          })
        : null;
    observer?.observe(surface);
    if (observer === null) view.addEventListener("resize", onWindowResize);

    return () => {
      disposed = true;
      view.clearTimeout(resizeTimer);
      observer?.disconnect();
      view.removeEventListener("resize", onWindowResize);
      reducedTransparency?.removeEventListener?.("change", updateLens);
    };
  }, []);

  useEffect(() => {
    const surface = surfaceRef.current;
    const light = lightRef.current;
    const host = surface?.parentElement;
    const view = surface?.ownerDocument.defaultView;
    if (surface === null || light === null || host == null || view == null) return;
    const motion = view.matchMedia?.("(prefers-reduced-motion: reduce)");
    const transparency = view.matchMedia?.("(prefers-reduced-transparency: reduce)");
    let animation: Animation | null = null;
    const cancelSweep = () => {
      if (animation === null) return;
      animation.onfinish = null;
      animation.cancel();
      animation = null;
    };
    const sweep = () => {
      if (
        motion?.matches ||
        transparency?.matches ||
        host.matches(":disabled, [aria-disabled='true']") ||
        typeof light.animate !== "function"
      )
        return;
      cancelSweep();
      // Only this masked highlight moves. The lens map and card content are
      // unchanged; there is no frame callback, bitmap rebuild or React update.
      const nextAnimation = light.animate(
        [
          { transform: "rotate(0deg) scale(1)", opacity: 1 },
          { transform: "rotate(170deg) scale(1.06)", opacity: 0.85, offset: 0.55 },
          { transform: "rotate(360deg) scale(1)", opacity: 1 },
        ],
        { duration: 1050, easing: "ease-in-out", iterations: 1, fill: "none" },
      );
      animation = nextAnimation;
      nextAnimation.onfinish = () => {
        if (animation === nextAnimation) animation = null;
      };
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.repeat && (event.key === "Enter" || event.key === " ")) sweep();
    };
    let voted = host.classList.contains("is-voted");
    const stateObserver = new view.MutationObserver(() => {
      const nextVoted = host.classList.contains("is-voted");
      if (nextVoted !== voted) {
        voted = nextVoted;
        sweep();
      }
    });
    stateObserver.observe(host, { attributes: true, attributeFilter: ["class"] });
    host.addEventListener("pointerenter", sweep, { passive: true });
    host.addEventListener("pointerdown", sweep, { passive: true });
    host.addEventListener("focusin", sweep);
    host.addEventListener("keydown", onKeyDown);
    motion?.addEventListener?.("change", cancelSweep);
    transparency?.addEventListener?.("change", cancelSweep);
    return () => {
      cancelSweep();
      stateObserver.disconnect();
      host.removeEventListener("pointerenter", sweep);
      host.removeEventListener("pointerdown", sweep);
      host.removeEventListener("focusin", sweep);
      host.removeEventListener("keydown", onKeyDown);
      motion?.removeEventListener?.("change", cancelSweep);
      transparency?.removeEventListener?.("change", cancelSweep);
    };
  }, []);

  const style = {
    "--card-nomination-color": appearance.nominationColor,
    "--card-nomination-rgb": [1, 3, 5]
      .map((offset) => parseInt(appearance.nominationColor.slice(offset, offset + 2), 16))
      .join(" "),
    "--card-nomination-tint":
      appearance.nominationTreatment === "icons" ? 0 : appearance.nominationTint / 100,
    ...(lens === null
      ? {}
      : {
          "--liquid-card-refraction": `url("#${filterId}")`,
          "--liquid-card-edge-mask": `url("${lens.edgeMaskUrl}")`,
        }),
  } as CSSProperties;

  return (
    <span
      ref={surfaceRef}
      className="liquid-card-glass"
      aria-hidden="true"
      data-liquid-card-lens={lens === null ? "fallback" : "ready"}
      style={style}
    >
      {lens === null ? null : (
        <svg className="liquid-card-glass__defs" aria-hidden="true" focusable="false">
          <defs>
            <filter
              id={filterId}
              x="0"
              y="0"
              width={lens.width}
              height={lens.height}
              filterUnits="userSpaceOnUse"
              primitiveUnits="userSpaceOnUse"
              colorInterpolationFilters="sRGB"
            >
              <feImage
                href={lens.displacementUrl}
                x="0"
                y="0"
                width={lens.width}
                height={lens.height}
                result="edge-map"
                preserveAspectRatio="none"
              />
              <feDisplacementMap
                in="SourceGraphic"
                in2="edge-map"
                scale={Math.min(18, Math.min(lens.width, lens.height) / 6)}
                xChannelSelector="R"
                yChannelSelector="G"
              />
            </filter>
          </defs>
        </svg>
      )}
      <span className="liquid-card-glass__backdrop" aria-hidden="true" />
      <span className="liquid-card-glass__caustics" aria-hidden="true">
        <span ref={lightRef} className="liquid-card-glass__light" aria-hidden="true" />
      </span>
      <span className="liquid-card-glass__rim" aria-hidden="true" />
    </span>
  );
};
