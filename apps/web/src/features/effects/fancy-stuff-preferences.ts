export const FANCY_STUFF_STORAGE_KEY = "mafia-dashboard.fancy-stuff.v1";

export interface FancyStuffSettings {
  readonly version: 1;
  readonly clubEntryEffects: boolean;
}

export const DEFAULT_FANCY_STUFF_SETTINGS: FancyStuffSettings = Object.freeze({
  version: 1,
  clubEntryEffects: true,
});

export const validateFancyStuffSettings = (value: unknown): FancyStuffSettings => {
  if (value === null || typeof value !== "object" || !("version" in value) || value.version !== 1)
    return DEFAULT_FANCY_STUFF_SETTINGS;
  const record = value as Record<string, unknown>;
  return {
    version: 1,
    clubEntryEffects:
      typeof record.clubEntryEffects === "boolean"
        ? record.clubEntryEffects
        : DEFAULT_FANCY_STUFF_SETTINGS.clubEntryEffects,
  };
};

export const readFancyStuffSettings = (
  storage: () => Pick<Storage, "getItem"> = () => window.localStorage,
): FancyStuffSettings => {
  try {
    return validateFancyStuffSettings(
      JSON.parse(storage().getItem(FANCY_STUFF_STORAGE_KEY) ?? "null"),
    );
  } catch {
    return DEFAULT_FANCY_STUFF_SETTINGS;
  }
};

export const writeFancyStuffSettings = (
  settings: FancyStuffSettings,
  storage: () => Pick<Storage, "setItem"> = () => window.localStorage,
): void => {
  try {
    storage().setItem(
      FANCY_STUFF_STORAGE_KEY,
      JSON.stringify(validateFancyStuffSettings(settings)),
    );
  } catch {
    // Keep the live preference usable even when this browser denies persistence.
  }
};
