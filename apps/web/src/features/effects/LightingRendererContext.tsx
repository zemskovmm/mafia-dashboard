import { createContext, useContext } from "react";
import {
  DEFAULT_PLAYER_PULSE,
  readPlayerPulse,
  readLightingRenderer,
  type LightingRenderer,
  type PlayerPulseSettings,
} from "./lighting-preferences.js";

export type VgpuStatus = "idle" | "initializing" | "ready" | "fallback";

export interface LightingRendererState {
  readonly requestedRenderer: LightingRenderer;
  readonly effectiveRenderer: LightingRenderer;
  readonly playerPulse: PlayerPulseSettings;
  readonly vgpuGeneration: number;
  readonly vgpuStatus: VgpuStatus;
}

export type LightingRendererAction =
  | { readonly type: "select"; readonly renderer: LightingRenderer }
  | { readonly type: "set-player-pulse"; readonly settings: PlayerPulseSettings }
  | { readonly type: "vgpu-ready"; readonly generation: number }
  | { readonly type: "vgpu-failed"; readonly generation: number };

interface StorageReader {
  readonly getItem: (key: string) => string | null;
}

export const createLightingRendererState = (storage: StorageReader): LightingRendererState => {
  const requestedRenderer = readLightingRenderer(storage);
  return {
    requestedRenderer,
    effectiveRenderer: requestedRenderer === "vgpu" ? "legacy" : requestedRenderer,
    playerPulse: readPlayerPulse(storage),
    vgpuGeneration: requestedRenderer === "vgpu" ? 1 : 0,
    vgpuStatus: requestedRenderer === "vgpu" ? "initializing" : "idle",
  };
};

export const lightingRendererReducer = (
  state: LightingRendererState,
  action: LightingRendererAction,
): LightingRendererState => {
  if (action.type === "set-player-pulse") return { ...state, playerPulse: action.settings };

  if (action.type === "select") {
    const vgpuGeneration = state.vgpuGeneration + 1;
    return action.renderer === "vgpu"
      ? {
          ...state,
          requestedRenderer: "vgpu",
          effectiveRenderer: "legacy",
          vgpuGeneration,
          vgpuStatus: "initializing",
        }
      : {
          ...state,
          requestedRenderer: action.renderer,
          effectiveRenderer: action.renderer,
          vgpuGeneration,
          vgpuStatus: "idle",
        };
  }

  if (action.generation !== state.vgpuGeneration || state.requestedRenderer !== "vgpu")
    return state;
  return action.type === "vgpu-ready"
    ? { ...state, effectiveRenderer: "vgpu", vgpuStatus: "ready" }
    : { ...state, effectiveRenderer: "legacy", vgpuStatus: "fallback" };
};

export type LightingRendererContextValue = LightingRendererState;

const defaultContext: LightingRendererContextValue = {
  requestedRenderer: "vgpu",
  effectiveRenderer: "legacy",
  playerPulse: DEFAULT_PLAYER_PULSE,
  vgpuGeneration: 1,
  vgpuStatus: "initializing",
};

export const LightingRendererContext = createContext(defaultContext);
export const useLightingRenderer = (): LightingRendererContextValue =>
  useContext(LightingRendererContext);
