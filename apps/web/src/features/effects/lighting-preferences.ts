export const LIGHTING_RENDERER_STORAGE_KEY = "mafia-dashboard.lighting-renderer.v1";
export const PLAYER_PULSE_STORAGE_KEY = "mafia-dashboard.player-pulse.v1";
export const DEFAULT_LIGHTING_RENDERER = "vgpu";

export interface PlayerPulseSettings {
  readonly enabled: boolean;
  readonly speed: number;
  readonly strength: number;
}

export const DEFAULT_PLAYER_PULSE: PlayerPulseSettings = {
  enabled: true,
  speed: 1,
  strength: 0.05,
};

export type LightingRenderer = "legacy" | "vgpu";

interface StorageReader {
  readonly getItem: (key: string) => string | null;
}

interface StorageWriter {
  readonly setItem: (key: string, value: string) => unknown;
}

const isPlayerPulseSettings = (value: unknown): value is PlayerPulseSettings => {
  if (typeof value !== "object" || value === null) return false;
  const settings = value as Record<string, unknown>;
  return (
    typeof settings.enabled === "boolean" &&
    typeof settings.speed === "number" &&
    Number.isFinite(settings.speed) &&
    settings.speed >= 0.25 &&
    settings.speed <= 3 &&
    typeof settings.strength === "number" &&
    Number.isFinite(settings.strength) &&
    settings.strength >= 0 &&
    settings.strength <= 0.5
  );
};

const validatedPlayerPulse = (value: unknown): PlayerPulseSettings =>
  isPlayerPulseSettings(value) ? value : DEFAULT_PLAYER_PULSE;

export const readLightingRenderer = (storage: StorageReader): LightingRenderer => {
  const value = storage.getItem(LIGHTING_RENDERER_STORAGE_KEY);
  return value === "legacy" || value === "vgpu" ? value : DEFAULT_LIGHTING_RENDERER;
};

export const writeLightingRenderer = (storage: StorageWriter, renderer: LightingRenderer) =>
  storage.setItem(LIGHTING_RENDERER_STORAGE_KEY, renderer);

export const readPlayerPulse = (storage: StorageReader): PlayerPulseSettings => {
  const raw = storage.getItem(PLAYER_PULSE_STORAGE_KEY);
  if (raw === null) return DEFAULT_PLAYER_PULSE;
  try {
    return validatedPlayerPulse(JSON.parse(raw));
  } catch {
    return DEFAULT_PLAYER_PULSE;
  }
};

export const writePlayerPulse = (storage: StorageWriter, settings: PlayerPulseSettings) =>
  storage.setItem(PLAYER_PULSE_STORAGE_KEY, JSON.stringify(validatedPlayerPulse(settings)));
