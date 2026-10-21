export const TUTORIAL_HELP_STORAGE_KEY = "mafia-dashboard.tutorial-help.v1";

export const readTutorialHelp = (
  storage: () => Pick<Storage, "getItem"> = () => window.localStorage,
): boolean => {
  try {
    const value: unknown = JSON.parse(storage().getItem(TUTORIAL_HELP_STORAGE_KEY) ?? "null");
    return (
      value === null ||
      typeof value !== "object" ||
      !("version" in value) ||
      value.version !== 1 ||
      !("enabled" in value) ||
      value.enabled !== false
    );
  } catch {
    return true;
  }
};

export const writeTutorialHelp = (
  enabled: boolean,
  storage: () => Pick<Storage, "setItem"> = () => window.localStorage,
): void => {
  try {
    storage().setItem(TUTORIAL_HELP_STORAGE_KEY, JSON.stringify({ version: 1, enabled }));
  } catch {
    // Keep the live preference usable when this browser denies persistence.
  }
};
