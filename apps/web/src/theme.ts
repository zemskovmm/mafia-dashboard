export type ColorTheme = "midnight" | "malaga" | "malaga-glass";

const storageKey = "mafia-dashboard.color-theme";

interface ThemeReader {
  readonly getItem: (key: string) => string | null;
}

interface ThemeWriter {
  readonly setItem: (key: string, value: string) => unknown;
}

export const readColorTheme = (storage: ThemeReader): ColorTheme => {
  const stored = storage.getItem(storageKey);
  return stored === "malaga" || stored === "malaga-glass" ? stored : "midnight";
};

export const applyColorTheme = (
  root: HTMLElement,
  storage: ThemeWriter,
  theme: ColorTheme,
): void => {
  root.dataset.theme = theme;
  storage.setItem(storageKey, theme);
};
