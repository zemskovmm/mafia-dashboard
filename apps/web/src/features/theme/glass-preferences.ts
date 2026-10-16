export const GLASS_STORAGE_KEY = "mafia-dashboard.glass.v1";

export interface GlassSettings {
  readonly version: 1;
  readonly enabled: boolean;
  readonly refraction: number;
  readonly goldLight: number;
  readonly matte: boolean;
  readonly profile: "edge" | "simple";
  readonly frosting: number;
  readonly tint: number;
  readonly edgeHighlights: number;
  readonly caustics: number;
  readonly nominationTint: number;
  readonly nominationColor: string;
  readonly nominationTreatment: "icons" | "tint" | "hybrid";
  readonly nominationIcon: "vote" | "flag";
  readonly supportIcon: "hand" | "thumbs-up";
  readonly selectionStyle: "check-outline" | "check";
}

export const DEFAULT_GLASS_SETTINGS: GlassSettings = Object.freeze({
  version: 1,
  enabled: true,
  refraction: 14,
  goldLight: 25,
  matte: true,
  profile: "edge",
  frosting: 50,
  tint: 13,
  edgeHighlights: 100,
  caustics: 100,
  nominationTint: 18,
  nominationColor: "#e6bc7e",
  nominationTreatment: "hybrid",
  nominationIcon: "vote",
  supportIcon: "hand",
  selectionStyle: "check-outline",
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
    enabled: typeof record.enabled === "boolean" ? record.enabled : DEFAULT_GLASS_SETTINGS.enabled,
    refraction: validNumber(record.refraction, 24, DEFAULT_GLASS_SETTINGS.refraction),
    goldLight: validNumber(record.goldLight, 100, DEFAULT_GLASS_SETTINGS.goldLight),
    matte: typeof record.matte === "boolean" ? record.matte : DEFAULT_GLASS_SETTINGS.matte,
    profile:
      record.profile === "edge" || record.profile === "simple"
        ? record.profile
        : DEFAULT_GLASS_SETTINGS.profile,
    frosting: validNumber(record.frosting, 100, DEFAULT_GLASS_SETTINGS.frosting),
    tint: validNumber(record.tint, 30, DEFAULT_GLASS_SETTINGS.tint),
    edgeHighlights: validNumber(record.edgeHighlights, 100, DEFAULT_GLASS_SETTINGS.edgeHighlights),
    caustics: validNumber(record.caustics, 100, DEFAULT_GLASS_SETTINGS.caustics),
    nominationTint: validNumber(record.nominationTint, 50, DEFAULT_GLASS_SETTINGS.nominationTint),
    nominationColor:
      typeof record.nominationColor === "string" &&
      /^#[\da-f]{6}$/i.test(record.nominationColor) &&
      record.nominationColor.length === 7
        ? record.nominationColor
        : DEFAULT_GLASS_SETTINGS.nominationColor,
    nominationTreatment:
      record.nominationTreatment === "icons" ||
      record.nominationTreatment === "tint" ||
      record.nominationTreatment === "hybrid"
        ? record.nominationTreatment
        : DEFAULT_GLASS_SETTINGS.nominationTreatment,
    nominationIcon:
      record.nominationIcon === "vote" || record.nominationIcon === "flag"
        ? record.nominationIcon
        : DEFAULT_GLASS_SETTINGS.nominationIcon,
    supportIcon:
      record.supportIcon === "hand" || record.supportIcon === "thumbs-up"
        ? record.supportIcon
        : DEFAULT_GLASS_SETTINGS.supportIcon,
    selectionStyle:
      record.selectionStyle === "check-outline" || record.selectionStyle === "check"
        ? record.selectionStyle
        : DEFAULT_GLASS_SETTINGS.selectionStyle,
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
