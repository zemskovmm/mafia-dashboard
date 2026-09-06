import { describe, expect, it, vi } from "vitest";
import {
  clearDeveloperPreferences,
  DEVELOPER_MODE_ENABLED_STORAGE_KEY,
  DEVELOPER_UNLOCKED_STORAGE_KEY,
  readDeveloperPreferences,
  writeDeveloperModeEnabled,
  writeDeveloperUnlocked,
} from "./developer-preferences.js";

describe("developer preferences", () => {
  it("defaults both developer flags off and rejects malformed values", () => {
    expect(readDeveloperPreferences({ getItem: () => null })).toEqual({
      unlocked: false,
      devModeEnabled: false,
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
    ).toEqual({ unlocked: false, devModeEnabled: false });
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

  it("clears both developer flags without touching other preferences", () => {
    const removeItem = vi.fn();
    clearDeveloperPreferences({ removeItem });

    expect(removeItem).toHaveBeenCalledTimes(2);
    expect(removeItem).toHaveBeenNthCalledWith(1, DEVELOPER_UNLOCKED_STORAGE_KEY);
    expect(removeItem).toHaveBeenNthCalledWith(2, DEVELOPER_MODE_ENABLED_STORAGE_KEY);
  });
});
