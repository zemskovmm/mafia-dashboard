export type PlayerCardStyle = "glass" | "classic" | "heritage" | "noir";
export type PrintedCardStyle = Exclude<PlayerCardStyle, "glass">;
export type PrintedRolePlacement = "below" | "ribbon" | "top";

export interface PlayerCardPreferences {
  readonly style: PlayerCardStyle;
  readonly rolePlacement: PrintedRolePlacement;
}

export const DEFAULT_PLAYER_CARD_PREFERENCES: PlayerCardPreferences = {
  style: "glass",
  rolePlacement: "below",
};

export const PLAYER_CARD_PREFERENCES_KEY = "mafia-dashboard.player-card-preferences.v1";

export const validatePlayerCardPreferences = (value: unknown): PlayerCardPreferences => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_PLAYER_CARD_PREFERENCES;
  }
  const record = value as Record<string, unknown>;
  return {
    style:
      record.style === "glass" ||
      record.style === "classic" ||
      record.style === "heritage" ||
      record.style === "noir"
        ? record.style
        : DEFAULT_PLAYER_CARD_PREFERENCES.style,
    rolePlacement:
      record.rolePlacement === "below" ||
      record.rolePlacement === "ribbon" ||
      record.rolePlacement === "top"
        ? record.rolePlacement
        : DEFAULT_PLAYER_CARD_PREFERENCES.rolePlacement,
  };
};

export const readPlayerCardPreferences = (): PlayerCardPreferences => {
  try {
    // Resolving localStorage can itself throw, before getItem is called.
    return validatePlayerCardPreferences(
      JSON.parse(window.localStorage.getItem(PLAYER_CARD_PREFERENCES_KEY) ?? "null"),
    );
  } catch {
    return DEFAULT_PLAYER_CARD_PREFERENCES;
  }
};

export const writePlayerCardPreferences = (settings: PlayerCardPreferences): void => {
  try {
    window.localStorage.setItem(
      PLAYER_CARD_PREFERENCES_KEY,
      JSON.stringify(validatePlayerCardPreferences(settings)),
    );
  } catch {
    // The caller's current-session preferences remain usable when storage is denied.
  }
};
