export const BACKGROUND_STORAGE_KEY = "mafia-dashboard.background.v1";
export const DEFAULT_BACKGROUND = "noir-skyline";
export const BACKGROUND_OPTIONS = [
  { id: "noir-skyline", message: "backgroundNoirSkyline" },
  { id: "old-town", message: "backgroundOldTown" },
  { id: "harbour", message: "backgroundHarbour" },
  { id: "black", message: "backgroundBlack" },
  { id: "grey-33", message: "backgroundGrey33" },
  { id: "grey-66", message: "backgroundGrey66" },
  { id: "white", message: "backgroundWhite" },
] as const;
export type BackgroundId = (typeof BACKGROUND_OPTIONS)[number]["id"];
export type CityBackgroundId = "noir-skyline" | "old-town" | "harbour";

export const isCityBackground = (id: BackgroundId): id is CityBackgroundId =>
  id === "noir-skyline" || id === "old-town" || id === "harbour";

export const backgroundAsset = (id: BackgroundId): string | null =>
  isCityBackground(id) ? `/backgrounds/${id}.svg` : null;

export const validateBackground = (value: unknown): BackgroundId =>
  BACKGROUND_OPTIONS.find(({ id }) => id === value)?.id ?? DEFAULT_BACKGROUND;

export const readBackground = (
  storage: () => Pick<Storage, "getItem"> = () => window.localStorage,
): BackgroundId => {
  try {
    const value: unknown = JSON.parse(storage().getItem(BACKGROUND_STORAGE_KEY) ?? "null");
    return value !== null &&
      typeof value === "object" &&
      "version" in value &&
      value.version === 1 &&
      "background" in value
      ? validateBackground(value.background)
      : DEFAULT_BACKGROUND;
  } catch {
    return DEFAULT_BACKGROUND;
  }
};

export const writeBackground = (
  background: BackgroundId,
  storage: () => Pick<Storage, "setItem"> = () => window.localStorage,
): void => {
  try {
    storage().setItem(
      BACKGROUND_STORAGE_KEY,
      JSON.stringify({ version: 1, background: validateBackground(background) }),
    );
  } catch {
    // Keep the current session usable when browser persistence is unavailable.
  }
};
