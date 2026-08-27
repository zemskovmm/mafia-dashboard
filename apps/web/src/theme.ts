export const DEFAULT_THEME_COLOR = "#c39a58";
export const THEME_COLOR_STORAGE_KEY = "mafia-dashboard.theme-color.v1";

const legacyThemeStorageKey = "mafia-dashboard.color-theme";
const legacyGlassSettingsStorageKey = "mafia-dashboard.glass-settings.v1";
const colorPattern = /^#[0-9a-f]{6}$/i;
const legacyColors: Readonly<Record<string, string>> = {
  midnight: "#7170ff",
  malaga: "#b08d57",
  "malaga-glass": DEFAULT_THEME_COLOR,
};

export interface ThemeReader {
  readonly getItem: (key: string) => string | null;
}

export interface ThemeStorage extends ThemeReader {
  readonly setItem: (key: string, value: string) => unknown;
  readonly removeItem: (key: string) => unknown;
}

const normalizedColor = (value: string | null): string | null =>
  value !== null && colorPattern.test(value) ? value.toLowerCase() : null;

export const readThemeColor = (storage: ThemeReader): string => {
  const stored = normalizedColor(storage.getItem(THEME_COLOR_STORAGE_KEY));
  if (stored !== null) return stored;
  return legacyColors[storage.getItem(legacyThemeStorageKey) ?? ""] ?? DEFAULT_THEME_COLOR;
};

export const applyThemeColor = (
  root: HTMLElement,
  storage: ThemeStorage,
  color: string,
): string => {
  const normalized = normalizedColor(color) ?? DEFAULT_THEME_COLOR;
  root.style.setProperty("--theme-base", normalized);
  delete root.dataset.theme;
  storage.setItem(THEME_COLOR_STORAGE_KEY, normalized);
  storage.removeItem(legacyThemeStorageKey);
  storage.removeItem(legacyGlassSettingsStorageKey);
  return normalized;
};
