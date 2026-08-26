export interface GlassSettings {
  readonly enabled: boolean;
  readonly blur: number;
  readonly glassThickness: number;
  readonly bezelWidth: number;
  readonly refractiveIndex: number;
  readonly specularOpacity: number;
  readonly specularAngle: number;
  readonly fallbackOpacity: number;
}

interface GlassSettingsReader {
  readonly getItem: (key: string) => string | null;
}

interface GlassSettingsWriter {
  readonly setItem: (key: string, value: string) => unknown;
}

export const GLASS_SETTINGS_STORAGE_KEY = "mafia-dashboard.glass-settings.v1";
export const MINIMUM_GLASS_SURFACE_RADIUS = 12;

export const GLASS_SETTINGS_BOUNDS = Object.freeze({
  blur: Object.freeze({ min: 0, max: 24, step: 1 }),
  glassThickness: Object.freeze({ min: 0, max: 200, step: 1 }),
  bezelWidth: Object.freeze({ min: 0, max: 64, step: 1 }),
  refractiveIndex: Object.freeze({ min: 1, max: 3, step: 0.05 }),
  specularOpacity: Object.freeze({ min: 0, max: 1, step: 0.01 }),
  specularAngle: Object.freeze({ min: 0, max: 360, step: 1 }),
  fallbackOpacity: Object.freeze({ min: 0, max: 1, step: 0.01 }),
});

export const DEFAULT_GLASS_SETTINGS: Readonly<GlassSettings> = Object.freeze({
  enabled: true,
  blur: 4,
  glassThickness: 70,
  bezelWidth: 10,
  refractiveIndex: 1.5,
  specularOpacity: 0.28,
  specularAngle: 45,
  fallbackOpacity: 0.62,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finiteNumberOr = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const boundedNumber = (
  value: unknown,
  fallback: number,
  bounds: { readonly min: number; readonly max: number },
): number => clamp(finiteNumberOr(value, fallback), bounds.min, bounds.max);

const normalizeAngle = (value: unknown): number => {
  const finiteAngle = finiteNumberOr(value, DEFAULT_GLASS_SETTINGS.specularAngle);
  return ((finiteAngle % 360) + 360) % 360;
};

export const sanitizeGlassSettings = (
  value: unknown,
  minimumSurfaceRadius = MINIMUM_GLASS_SURFACE_RADIUS,
): GlassSettings => {
  const source = isRecord(value) ? value : {};

  const safeMinimumRadius = Math.max(
    1,
    finiteNumberOr(minimumSurfaceRadius, MINIMUM_GLASS_SURFACE_RADIUS),
  );
  const boundedBezel = boundedNumber(
    source.bezelWidth,
    DEFAULT_GLASS_SETTINGS.bezelWidth,
    GLASS_SETTINGS_BOUNDS.bezelWidth,
  );

  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_GLASS_SETTINGS.enabled,
    blur: boundedNumber(source.blur, DEFAULT_GLASS_SETTINGS.blur, GLASS_SETTINGS_BOUNDS.blur),
    glassThickness: boundedNumber(
      source.glassThickness,
      DEFAULT_GLASS_SETTINGS.glassThickness,
      GLASS_SETTINGS_BOUNDS.glassThickness,
    ),
    bezelWidth: Math.max(0, Math.min(boundedBezel, safeMinimumRadius - 1)),
    refractiveIndex: boundedNumber(
      source.refractiveIndex,
      DEFAULT_GLASS_SETTINGS.refractiveIndex,
      GLASS_SETTINGS_BOUNDS.refractiveIndex,
    ),
    specularOpacity: boundedNumber(
      source.specularOpacity,
      DEFAULT_GLASS_SETTINGS.specularOpacity,
      GLASS_SETTINGS_BOUNDS.specularOpacity,
    ),
    specularAngle: normalizeAngle(source.specularAngle),
    fallbackOpacity: boundedNumber(
      source.fallbackOpacity,
      DEFAULT_GLASS_SETTINGS.fallbackOpacity,
      GLASS_SETTINGS_BOUNDS.fallbackOpacity,
    ),
  };
};

export const readGlassSettings = (
  storage: GlassSettingsReader,
  minimumSurfaceRadius = MINIMUM_GLASS_SURFACE_RADIUS,
): GlassSettings => {
  try {
    return sanitizeGlassSettings(
      JSON.parse(storage.getItem(GLASS_SETTINGS_STORAGE_KEY) ?? "null"),
      minimumSurfaceRadius,
    );
  } catch {
    return sanitizeGlassSettings({}, minimumSurfaceRadius);
  }
};

export const writeGlassSettings = (
  storage: GlassSettingsWriter,
  value: unknown,
  minimumSurfaceRadius = MINIMUM_GLASS_SURFACE_RADIUS,
): GlassSettings => {
  const settings = sanitizeGlassSettings(value, minimumSurfaceRadius);
  storage.setItem(GLASS_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  return settings;
};
