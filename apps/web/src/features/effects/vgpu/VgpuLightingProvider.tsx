import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { DEFAULT_PLAYER_PULSE, type PlayerPulseSettings } from "../lighting-preferences.js";
import { loadVgpuLightingRuntime, type VgpuLightingRuntime } from "./VgpuLightingRuntime.js";
import { useFancyFeatures } from "../FancyFeaturesContext.js";

interface RuntimeOptions {
  readonly onError: (error: unknown) => void;
}

interface VgpuLightingProviderProps {
  readonly enabled: boolean;
  readonly generation: number;
  readonly onReady: (generation: number) => void;
  readonly onFailure: (generation: number) => void;
  readonly playerPulse?: PlayerPulseSettings;
  readonly createRuntime?: (options: RuntimeOptions) => Promise<VgpuLightingRuntime>;
  readonly children: ReactNode;
}

const RuntimeContext = createContext<VgpuLightingRuntime | null>(null);

export const useVgpuLightingRuntime = (): VgpuLightingRuntime | null => useContext(RuntimeContext);

export const VgpuLightingProvider = ({
  enabled,
  generation,
  onReady,
  onFailure,
  playerPulse = DEFAULT_PLAYER_PULSE,
  createRuntime = loadVgpuLightingRuntime,
  children,
}: VgpuLightingProviderProps) => {
  const fancyEnabled = useFancyFeatures();
  const active = enabled && fancyEnabled;
  const [runtime, setRuntime] = useState<VgpuLightingRuntime | null>(null);

  useEffect(() => {
    if (active) runtime?.setPlayerPulse(playerPulse);
  }, [active, playerPulse, runtime]);

  useEffect(() => {
    if (!active) {
      setRuntime(null);
      return;
    }
    let current = true;
    let activeRuntime: VgpuLightingRuntime | null = null;
    let failed = false;
    let media: MediaQueryList | null = null;
    let initializationTimeout: ReturnType<typeof setTimeout> | undefined;
    const fail = () => {
      if (!current || failed) return;
      failed = true;
      clearTimeout(initializationTimeout);
      initializationTimeout = undefined;
      activeRuntime?.dispose();
      activeRuntime = null;
      setRuntime(null);
      onFailure(generation);
    };
    const onMotionChange = (event: MediaQueryListEvent) =>
      activeRuntime?.setReducedMotion(event.matches);

    initializationTimeout = setTimeout(fail, 8_000);
    void createRuntime({ onError: fail })
      .then((nextRuntime) => {
        clearTimeout(initializationTimeout);
        initializationTimeout = undefined;
        if (!current || failed) {
          nextRuntime.dispose();
          return;
        }
        activeRuntime = nextRuntime;
        media = window.matchMedia("(prefers-reduced-motion: reduce)");
        nextRuntime.setReducedMotion(media.matches);
        media.addEventListener("change", onMotionChange);
        setRuntime(nextRuntime);
        void nextRuntime.ready
          .then(() => {
            if (current && !failed) onReady(generation);
          })
          .catch(() => fail());
      })
      .catch(() => fail());

    return () => {
      current = false;
      clearTimeout(initializationTimeout);
      media?.removeEventListener("change", onMotionChange);
      activeRuntime?.dispose();
      activeRuntime = null;
    };
  }, [active, createRuntime, generation, onFailure, onReady]);

  return (
    <RuntimeContext.Provider value={active ? runtime : null}>{children}</RuntimeContext.Provider>
  );
};
