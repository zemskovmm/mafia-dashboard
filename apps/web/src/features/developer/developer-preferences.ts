export const DEVELOPER_UNLOCKED_STORAGE_KEY = "mafia-dashboard.developer-unlocked.v1";
// Retained only to clear the obsolete independent activation preference.
export const DEVELOPER_MODE_ENABLED_STORAGE_KEY = "mafia-dashboard.developer-mode.v1";
export const PREVIEW_UNDEALT_ROLES_STORAGE_KEY = "mafia-dashboard.preview-undealt-roles.v1";

export interface DeveloperPreferences {
  readonly unlocked: boolean;

  readonly previewUndealtRoles: boolean;
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

export const readDeveloperPreferences = (storage: StorageReader): DeveloperPreferences => {
  try {
    return {
      unlocked: storage.getItem(DEVELOPER_UNLOCKED_STORAGE_KEY) === "unlocked",

      previewUndealtRoles: storage.getItem(PREVIEW_UNDEALT_ROLES_STORAGE_KEY) === "enabled",
    };
  } catch {
    return { unlocked: false, previewUndealtRoles: false };
  }
};

export const writeDeveloperUnlocked = (storage: StorageWriter, unlocked: boolean): void => {
  try {
    storage.setItem(DEVELOPER_UNLOCKED_STORAGE_KEY, unlocked ? "unlocked" : "hidden");
  } catch {
    // Unlocking remains usable for the session when persistence is unavailable.
  }
};

export const clearDeveloperPreferences = (storage: StorageRemover): void => {
  for (const key of [
    DEVELOPER_UNLOCKED_STORAGE_KEY,
    DEVELOPER_MODE_ENABLED_STORAGE_KEY,
    PREVIEW_UNDEALT_ROLES_STORAGE_KEY,
  ]) {
    try {
      storage.removeItem(key);
    } catch {
      // Local storage is optional; callers still clear the live developer state.
    }
  }
};

export const writePreviewUndealtRoles = (storage: StorageWriter, enabled: boolean): void => {
  try {
    storage.setItem(PREVIEW_UNDEALT_ROLES_STORAGE_KEY, enabled ? "enabled" : "disabled");
  } catch {
    // Keep the current-session choice when persistence is unavailable.
  }
};
