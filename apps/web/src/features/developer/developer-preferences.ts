export const DEVELOPER_UNLOCKED_STORAGE_KEY = "mafia-dashboard.developer-unlocked.v1";
export const DEVELOPER_MODE_ENABLED_STORAGE_KEY = "mafia-dashboard.developer-mode.v1";

export interface DeveloperPreferences {
  readonly unlocked: boolean;
  readonly devModeEnabled: boolean;
}

interface StorageReader {
  readonly getItem: (key: string) => string | null;
}

interface StorageWriter {
  readonly setItem: (key: string, value: string) => unknown;
}

interface StorageRemover {
  readonly removeItem: (key: string) => unknown;
}

export const readDeveloperPreferences = (storage: StorageReader): DeveloperPreferences => ({
  unlocked: storage.getItem(DEVELOPER_UNLOCKED_STORAGE_KEY) === "unlocked",
  devModeEnabled: storage.getItem(DEVELOPER_MODE_ENABLED_STORAGE_KEY) === "enabled",
});

export const writeDeveloperUnlocked = (storage: StorageWriter, unlocked: boolean): unknown =>
  storage.setItem(DEVELOPER_UNLOCKED_STORAGE_KEY, unlocked ? "unlocked" : "hidden");

export const writeDeveloperModeEnabled = (
  storage: StorageWriter,
  devModeEnabled: boolean,
): unknown =>
  storage.setItem(DEVELOPER_MODE_ENABLED_STORAGE_KEY, devModeEnabled ? "enabled" : "disabled");

export const clearDeveloperPreferences = (storage: StorageRemover): void => {
  storage.removeItem(DEVELOPER_UNLOCKED_STORAGE_KEY);
  storage.removeItem(DEVELOPER_MODE_ENABLED_STORAGE_KEY);
};
