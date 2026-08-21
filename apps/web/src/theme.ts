export type ColorTheme = "midnight" | "malaga";

const storageKey = "mafia-dashboard.color-theme";

interface ThemeReader {
  readonly getItem: (key: string) => string | null;
}

interface ThemeWriter {
  readonly setItem: (key: string, value: string) => unknown;
}

export const readColorTheme = (storage: ThemeReader): ColorTheme =>
  storage.getItem(storageKey) === "malaga" ? "malaga" : "midnight";

export const applyColorTheme = (
  root: HTMLElement,
  storage: ThemeWriter,
  theme: ColorTheme,
): void => {
  root.dataset.theme = theme;
  storage.setItem(storageKey, theme);
};
