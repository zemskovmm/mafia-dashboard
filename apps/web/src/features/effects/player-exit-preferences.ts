export const PLAYER_EXIT_STORAGE_KEY = "mafia-dashboard.player-exit.v1";
export const PLAYER_EXIT_EASINGS = ["linear", "in", "out", "in-out", "original"] as const;
export type PlayerExitEasing = (typeof PLAYER_EXIT_EASINGS)[number];
export type PlayerExitPhase = "lift" | "flip" | "drop";

export interface PlayerExitCurve {
  readonly easing: PlayerExitEasing;
  readonly strength: number;
}

export interface PlayerExitSettings {
  readonly version: 1;
  readonly enabled: boolean;
  readonly liftMs: number;
  readonly landingMs: number;
  readonly overlap: number;
  readonly lift: PlayerExitCurve;
  readonly flip: PlayerExitCurve;
  readonly drop: PlayerExitCurve;
  readonly impactMs: number;
  readonly tearMs: number;
  readonly fadeMs: number;
  readonly disciplineMs: number;
  readonly gap: number;
  readonly finalOpacity: number;
}

export const DEFAULT_PLAYER_EXIT_SETTINGS: PlayerExitSettings = Object.freeze({
  version: 1,
  enabled: true,
  liftMs: 100,
  landingMs: 480,
  overlap: 100,
  lift: Object.freeze({ easing: "out", strength: 100 }),
  flip: Object.freeze({ easing: "out", strength: 100 }),
  drop: Object.freeze({ easing: "out", strength: 100 }),
  impactMs: 420,
  tearMs: 360,
  fadeMs: 360,
  disciplineMs: 600,
  gap: 6,
  finalOpacity: 45,
});

const bounded = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback;

const validateCurve = (value: unknown): PlayerExitCurve => {
  if (value === null || typeof value !== "object") return DEFAULT_PLAYER_EXIT_SETTINGS.lift;
  const record = value as Record<string, unknown>;
  return {
    easing: PLAYER_EXIT_EASINGS.includes(record.easing as PlayerExitEasing)
      ? (record.easing as PlayerExitEasing)
      : "out",
    strength: bounded(record.strength, 0, 100, 100),
  };
};

export const validatePlayerExitSettings = (value: unknown): PlayerExitSettings => {
  if (value === null || typeof value !== "object" || !("version" in value) || value.version !== 1)
    return DEFAULT_PLAYER_EXIT_SETTINGS;
  const record = value as Record<string, unknown>;
  return {
    version: 1,
    enabled:
      typeof record.enabled === "boolean" ? record.enabled : DEFAULT_PLAYER_EXIT_SETTINGS.enabled,
    liftMs: bounded(record.liftMs, 80, 700, DEFAULT_PLAYER_EXIT_SETTINGS.liftMs),
    landingMs: bounded(record.landingMs, 200, 1400, DEFAULT_PLAYER_EXIT_SETTINGS.landingMs),
    overlap: bounded(record.overlap, 0, 100, DEFAULT_PLAYER_EXIT_SETTINGS.overlap),
    lift: validateCurve(record.lift),
    flip: validateCurve(record.flip),
    drop: validateCurve(record.drop),
    impactMs: bounded(record.impactMs, 240, 900, DEFAULT_PLAYER_EXIT_SETTINGS.impactMs),
    tearMs: bounded(record.tearMs, 200, 800, DEFAULT_PLAYER_EXIT_SETTINGS.tearMs),
    fadeMs: bounded(record.fadeMs, 200, 900, DEFAULT_PLAYER_EXIT_SETTINGS.fadeMs),
    disciplineMs: bounded(
      record.disciplineMs,
      300,
      1000,
      DEFAULT_PLAYER_EXIT_SETTINGS.disciplineMs,
    ),
    gap: bounded(record.gap, 2, 12, DEFAULT_PLAYER_EXIT_SETTINGS.gap),
    finalOpacity: bounded(record.finalOpacity, 25, 70, DEFAULT_PLAYER_EXIT_SETTINGS.finalOpacity),
  };
};

export const readPlayerExitSettings = (
  storage: () => Pick<Storage, "getItem"> = () => window.localStorage,
): PlayerExitSettings => {
  try {
    return validatePlayerExitSettings(
      JSON.parse(storage().getItem(PLAYER_EXIT_STORAGE_KEY) ?? "null"),
    );
  } catch {
    return DEFAULT_PLAYER_EXIT_SETTINGS;
  }
};

export const writePlayerExitSettings = (
  settings: PlayerExitSettings,
  storage: () => Pick<Storage, "setItem"> = () => window.localStorage,
): void => {
  try {
    storage().setItem(
      PLAYER_EXIT_STORAGE_KEY,
      JSON.stringify(validatePlayerExitSettings(settings)),
    );
  } catch {
    // Appearance controls remain usable in memory when local storage is unavailable.
  }
};
