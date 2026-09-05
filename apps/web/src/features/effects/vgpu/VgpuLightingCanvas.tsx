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
  const { requestedRenderer, playerLightingEnabled } = useLightingRenderer();
  const descriptor = useMemo<VgpuLightingDescriptor | null>(
    () => (kind === null ? null : { kind: "player", ...playerColours[kind] }),
    [kind],
  );
  if (requestedRenderer !== "vgpu" || !playerLightingEnabled || descriptor === null) return null;
  return (
    <LightingCanvas className="vgpu-lighting-canvas vgpu-player-lighting" descriptor={descriptor} />
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
