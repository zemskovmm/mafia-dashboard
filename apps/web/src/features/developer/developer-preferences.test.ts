import { describe, expect, it, vi } from "vitest";
import {
  clearDeveloperPreferences,
  DEVELOPER_MODE_ENABLED_STORAGE_KEY,
  DEVELOPER_UNLOCKED_STORAGE_KEY,
  PREVIEW_UNDEALT_ROLES_STORAGE_KEY,
  readDeveloperPreferences,
  writeDeveloperModeEnabled,
  writeDeveloperUnlocked,
  writePreviewUndealtRoles,
} from "./developer-preferences.js";

describe("developer preferences", () => {
  it("defaults developer flags and role preview off and rejects malformed values", () => {
    expect(readDeveloperPreferences({ getItem: () => null })).toEqual({
      unlocked: false,
      devModeEnabled: false,
      previewUndealtRoles: false,
    });
    expect(
      readDeveloperPreferences({
        getItem: (key) =>
          key === DEVELOPER_UNLOCKED_STORAGE_KEY
            ? "true"
            : key === DEVELOPER_MODE_ENABLED_STORAGE_KEY
              ? "yes"
              : null,
      }),
    ).toEqual({ unlocked: false, devModeEnabled: false, previewUndealtRoles: false });
  });

  it("persists developer menu access and development tools independently", () => {
    const setItem = vi.fn();

    writeDeveloperUnlocked({ setItem }, true);
    writeDeveloperModeEnabled({ setItem }, true);
    writeDeveloperModeEnabled({ setItem }, false);

    expect(setItem).toHaveBeenNthCalledWith(1, DEVELOPER_UNLOCKED_STORAGE_KEY, "unlocked");
    expect(setItem).toHaveBeenNthCalledWith(2, DEVELOPER_MODE_ENABLED_STORAGE_KEY, "enabled");
    expect(setItem).toHaveBeenNthCalledWith(3, DEVELOPER_MODE_ENABLED_STORAGE_KEY, "disabled");
  });

  it("persists the role preview independently and fails closed when storage is blocked", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    writePreviewUndealtRoles(storage, true);
    expect(readDeveloperPreferences(storage)).toEqual({
      unlocked: false,
      devModeEnabled: false,
      previewUndealtRoles: true,
    });
    writePreviewUndealtRoles(storage, false);
    expect(readDeveloperPreferences(storage).previewUndealtRoles).toBe(false);
    const blocked = () => {
      throw new Error("Storage blocked");
    };
    expect(readDeveloperPreferences({ getItem: blocked })).toEqual({
      unlocked: false,
      devModeEnabled: false,
      previewUndealtRoles: false,
    });
    expect(() => writePreviewUndealtRoles({ setItem: blocked }, true)).not.toThrow();
    expect(() => clearDeveloperPreferences({ removeItem: blocked })).not.toThrow();
  });

  it("clears developer flags and role preview without touching other preferences", () => {
    const removeItem = vi.fn();
    clearDeveloperPreferences({ removeItem });

    expect(removeItem).toHaveBeenCalledTimes(3);
    expect(removeItem).toHaveBeenNthCalledWith(1, DEVELOPER_UNLOCKED_STORAGE_KEY);
    expect(removeItem).toHaveBeenNthCalledWith(2, DEVELOPER_MODE_ENABLED_STORAGE_KEY);
    expect(removeItem).toHaveBeenNthCalledWith(3, PREVIEW_UNDEALT_ROLES_STORAGE_KEY);
  });
});
