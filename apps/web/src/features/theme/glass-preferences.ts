export const GLASS_STORAGE_KEY = "mafia-dashboard.glass.v1";

export interface GlassSettings {
  readonly version: 1;
  readonly enabled: boolean;
  readonly refraction: number;
  readonly goldLight: number;
}

export const DEFAULT_GLASS_SETTINGS: GlassSettings = Object.freeze({
  version: 1,
  enabled: false,
  refraction: 10,
  goldLight: 25,
});

const validNumber = (value: unknown, maximum: number, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum
    ? value
    : fallback;

export const validateGlassSettings = (value: unknown): GlassSettings => {
  if (value === null || typeof value !== "object" || !("version" in value) || value.version !== 1)
    return DEFAULT_GLASS_SETTINGS;
  const record = value as Record<string, unknown>;
  return {
    version: 1,
    enabled: typeof record.enabled === "boolean" ? record.enabled : false,
    refraction: validNumber(record.refraction, 24, 10),
    goldLight: validNumber(record.goldLight, 100, 25),
  };
};

// Resolve browser storage inside the guard: even accessing localStorage may throw.
export const readGlassSettings = (
  storage: () => Pick<Storage, "getItem"> = () => window.localStorage,
): GlassSettings => {
  try {
    return validateGlassSettings(JSON.parse(storage().getItem(GLASS_STORAGE_KEY) ?? "null"));
  } catch {
    return DEFAULT_GLASS_SETTINGS;
  }
};

export const writeGlassSettings = (
  settings: GlassSettings,
  storage: () => Pick<Storage, "setItem"> = () => window.localStorage,
): void => {
  try {
    storage().setItem(GLASS_STORAGE_KEY, JSON.stringify(validateGlassSettings(settings)));
  } catch {
    // Appearance remains usable in memory when persistence is denied.
  }
};
