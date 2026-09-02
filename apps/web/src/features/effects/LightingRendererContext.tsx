import { createContext, useContext } from "react";
import {
  readLightingRenderer,
  readPlayerLightingEnabled,
  type LightingRenderer,
} from "./lighting-preferences.js";

export type VgpuStatus = "idle" | "initializing" | "ready" | "fallback";

export interface LightingRendererState {
  readonly requestedRenderer: LightingRenderer;
  readonly effectiveRenderer: LightingRenderer;
  readonly playerLightingEnabled: boolean;
  readonly vgpuGeneration: number;
  readonly vgpuStatus: VgpuStatus;
}

export type LightingRendererAction =
  | { readonly type: "select"; readonly renderer: LightingRenderer }
  | { readonly type: "set-player-lighting"; readonly enabled: boolean }
  | { readonly type: "vgpu-ready"; readonly generation: number }
  | { readonly type: "vgpu-failed"; readonly generation: number };

interface StorageReader {
  readonly getItem: (key: string) => string | null;
}

export const createLightingRendererState = (storage: StorageReader): LightingRendererState => {
  const requestedRenderer = readLightingRenderer(storage);
  return {
    requestedRenderer,
    effectiveRenderer: requestedRenderer === "vgpu" ? "svg" : requestedRenderer,
    playerLightingEnabled: readPlayerLightingEnabled(storage),
    vgpuGeneration: requestedRenderer === "vgpu" ? 1 : 0,
    vgpuStatus: requestedRenderer === "vgpu" ? "initializing" : "idle",
  };
};

export const lightingRendererReducer = (
  state: LightingRendererState,
  action: LightingRendererAction,
): LightingRendererState => {
  if (action.type === "set-player-lighting")
    return { ...state, playerLightingEnabled: action.enabled };

  if (action.type === "select") {
    const vgpuGeneration = state.vgpuGeneration + 1;
    return action.renderer === "vgpu"
      ? {
          ...state,
          requestedRenderer: "vgpu",
          effectiveRenderer: "svg",
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
    : { ...state, effectiveRenderer: "svg", vgpuStatus: "fallback" };
};

export type LightingRendererContextValue = LightingRendererState;

const defaultContext: LightingRendererContextValue = {
  requestedRenderer: "svg",
  effectiveRenderer: "svg",
  playerLightingEnabled: true,
  vgpuGeneration: 0,
  vgpuStatus: "idle",
};

export const LightingRendererContext = createContext(defaultContext);
export const useLightingRenderer = (): LightingRendererContextValue =>
  useContext(LightingRendererContext);
