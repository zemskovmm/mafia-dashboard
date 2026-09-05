export const LIGHTING_RENDERER_STORAGE_KEY = "mafia-dashboard.lighting-renderer.v1";
export const PLAYER_LIGHTING_STORAGE_KEY = "mafia-dashboard.player-lighting.v1";
export const DEFAULT_LIGHTING_RENDERER = "vgpu";

export type LightingRenderer = "legacy" | "vgpu";

interface StorageReader {
  readonly getItem: (key: string) => string | null;
}

interface StorageWriter {
  readonly setItem: (key: string, value: string) => unknown;
}

export const readLightingRenderer = (storage: StorageReader): LightingRenderer => {
  const value = storage.getItem(LIGHTING_RENDERER_STORAGE_KEY);
  return value === "legacy" || value === "vgpu" ? value : DEFAULT_LIGHTING_RENDERER;
};

export const writeLightingRenderer = (storage: StorageWriter, renderer: LightingRenderer) =>
  storage.setItem(LIGHTING_RENDERER_STORAGE_KEY, renderer);

export const readPlayerLightingEnabled = (storage: StorageReader): boolean =>
  storage.getItem(PLAYER_LIGHTING_STORAGE_KEY) !== "disabled";

export const writePlayerLightingEnabled = (storage: StorageWriter, enabled: boolean) =>
  storage.setItem(PLAYER_LIGHTING_STORAGE_KEY, enabled ? "enabled" : "disabled");
