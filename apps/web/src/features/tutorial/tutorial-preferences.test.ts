import { describe, expect, it, vi } from "vitest";
import {
  readTutorialHelp,
  TUTORIAL_HELP_STORAGE_KEY,
  writeTutorialHelp,
} from "./tutorial-preferences.js";

describe("tutorial help preference", () => {
  it.each([
    null,
    "broken",
    "null",
    "false",
    "{}",
    '{"version":2,"enabled":false}',
    '{"version":1,"enabled":"false"}',
  ])("defaults to visible for missing or invalid data: %s", (value) =>
    expect(readTutorialHelp(() => ({ getItem: () => value }))).toBe(true),
  );

  it.each([true, false])("round-trips explicit visibility %s", (enabled) => {
    let saved: string | null = null;
    const storage = {
      getItem: () => saved,
      setItem: vi.fn((_key: string, value: string) => {
        saved = value;
      }),
    };
    writeTutorialHelp(enabled, () => storage);
    expect(storage.setItem).toHaveBeenCalledWith(
      TUTORIAL_HELP_STORAGE_KEY,
      JSON.stringify({ version: 1, enabled }),
    );
    expect(readTutorialHelp(() => storage)).toBe(enabled);
  });

  it("tolerates access denial without breaking live UI", () => {
    const unavailable = () => {
      throw new DOMException("Denied", "SecurityError");
    };
    expect(readTutorialHelp(unavailable)).toBe(true);
    expect(() => writeTutorialHelp(false, unavailable)).not.toThrow();
  });
});
