import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useLightingRenderer } from "../LightingRendererContext.js";
import type { PlayerLightingKind } from "../PlayerCardLighting.js";
import { useVgpuLightingRuntime } from "./VgpuLightingProvider.js";
import { lightingPadding, type VgpuLightingDescriptor } from "./VgpuLightingRuntime.js";

const playerColours: Readonly<
  Record<
    PlayerLightingKind,
    Readonly<{
      primary: readonly [number, number, number];
      secondary: readonly [number, number, number];
    }>
  >
> = {
  speaker: { primary: [1, 0.74, 0.3], secondary: [1, 0.9, 0.64] },
  mafia: { primary: [1, 0.19, 0.15], secondary: [1, 0.19, 0.15] },
  sheriff: { primary: [0.24, 0.67, 1], secondary: [0.24, 0.67, 1] },
  attention: { primary: [1, 0.82, 0.2], secondary: [1, 0.82, 0.2] },
};

const LightingCanvas = ({
  className,
  descriptor,
}: Readonly<{ className: string; descriptor: VgpuLightingDescriptor }>) => {
  const runtime = useVgpuLightingRuntime();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    setReady(false);
    if (runtime === null || canvas === null) return;
    let current = true;
    const registration = runtime.register(canvas, descriptor);
    void registration.ready
      .then(() => {
        if (current) setReady(true);
      })
      .catch(() => undefined);
    return () => {
      current = false;
      registration.dispose();
    };
  }, [descriptor, runtime]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={
        { "--vgpu-lighting-padding": `${lightingPadding[descriptor.kind]}px` } as CSSProperties
      }
      data-vgpu-ready={String(ready)}
      aria-hidden="true"
    />
  );
};

export const VgpuPlayerLightingCanvas = ({
  kind,
}: Readonly<{ kind: PlayerLightingKind | null }>) => {
  const { requestedRenderer } = useLightingRenderer();
  const descriptor = useMemo<VgpuLightingDescriptor | null>(
    () =>
      kind === null ? null : { kind: "player", ...playerColours[kind], fire: kind === "mafia" },
    [kind],
  );
  if (requestedRenderer !== "vgpu" || descriptor === null) return null;
  return (
    <LightingCanvas className="vgpu-lighting-canvas vgpu-player-lighting" descriptor={descriptor} />
  );
};

// Retain only the public active-player light during its exit. Role lighting
// still unmounts immediately, so privacy changes never wait for a fade.
export const ActivePlayerLighting = ({ active }: Readonly<{ active: boolean }>) => {
  const [retained, setRetained] = useState(active);
  useEffect(() => {
    if (active) {
      setRetained(true);
      return;
    }
    if (!retained) return;
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const clear = () => setRetained(false);
    if (motion?.matches) {
      clear();
      return;
    }
    // A small paint allowance follows the 250 ms CSS fade; no idle GPU work.
    const timeout = window.setTimeout(clear, 300);
    const onMotionChange = () => {
      if (motion?.matches) clear();
    };
    motion?.addEventListener("change", onMotionChange);
    return () => {
      window.clearTimeout(timeout);
      motion?.removeEventListener("change", onMotionChange);
    };
  }, [active, retained]);
  return (
    <span className="active-player-lighting" data-active={String(active)} aria-hidden="true">
      {active || retained ? <VgpuPlayerLightingCanvas kind="speaker" /> : null}
    </span>
  );
};

export const VgpuTableLightingCanvas = () => {
  const { requestedRenderer } = useLightingRenderer();
  const canvasRef = useRef<HTMLSpanElement>(null);
  const [cycle, setCycle] = useState<"day" | "night">("day");

  useLayoutEffect(() => {
    const shell = canvasRef.current?.closest(".game-shell");
    if (shell === null || shell === undefined) return;
    const update = () =>
      setCycle(shell.classList.contains("is-table-cycle-night") ? "night" : "day");
    update();
    const observer = new MutationObserver(update);
    observer.observe(shell, { attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [requestedRenderer]);

  const descriptor = useMemo<VgpuLightingDescriptor>(() => ({ kind: "table", cycle }), [cycle]);
  if (requestedRenderer !== "vgpu") return null;
  return (
    <span ref={canvasRef} className="vgpu-table-lighting-host">
      <LightingCanvas
        className="vgpu-lighting-canvas vgpu-table-lighting"
        descriptor={descriptor}
      />
    </span>
  );
};
