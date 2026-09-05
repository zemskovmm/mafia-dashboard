export const DEFAULT_THEME_COLOR = "#c39a58";
export const THEME_COLOR_STORAGE_KEY = "mafia-dashboard.theme-color.v1";

const colorPattern = /^#[0-9a-f]{6}$/i;

export interface ThemeReader {
  readonly getItem: (key: string) => string | null;
}

export interface ThemeStorage extends ThemeReader {
  readonly setItem: (key: string, value: string) => unknown;
}

const normalizedColor = (value: string | null): string | null =>
  value !== null && colorPattern.test(value) ? value.toLowerCase() : null;

export const readThemeColor = (storage: ThemeReader): string =>
  normalizedColor(storage.getItem(THEME_COLOR_STORAGE_KEY)) ?? DEFAULT_THEME_COLOR;

export const applyThemeColor = (
  root: HTMLElement,
  storage: ThemeStorage,
  color: string,
): string => {
  const normalized = normalizedColor(color) ?? DEFAULT_THEME_COLOR;
  root.style.setProperty("--theme-base", normalized);
  delete root.dataset.theme;
  storage.setItem(THEME_COLOR_STORAGE_KEY, normalized);
  return normalized;
};
