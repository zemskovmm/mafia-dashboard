import { describe, expect, it } from "vitest";
import { parseByteRange } from "./byte-range.js";

describe("parseByteRange", () => {
  it("maps a suffix range to the final requested bytes", () => {
    expect(parseByteRange("bytes=-100", 1_000)).toEqual({ start: 900, end: 999 });
  });

  it("maps an open-ended range through the final byte", () => {
    expect(parseByteRange("bytes=100-", 1_000)).toEqual({ start: 100, end: 999 });
  });

  it("clamps a bounded range to the available representation", () => {
    expect(parseByteRange("bytes=100-2000", 1_000)).toEqual({ start: 100, end: 999 });
  });

  it.each([
    ["bytes=1000-", 1_000],
    ["bytes=500-100", 1_000],
    ["bytes=-0", 1_000],
    ["bytes=0-", 0],
    ["bytes=9007199254740992-", 1_000],
  ])("rejects unsatisfiable range %s", (header, size) => {
    expect(parseByteRange(header, size)).toBe("invalid");
  });

  it.each(["bytes=", "items=0-1", "bytes=0-1,4-5", "bytes=one-two", "bytes=-"])(
    "rejects malformed or multiple range %s",
    (header) => {
      expect(parseByteRange(header, 1_000)).toBe("invalid");
    },
  );

  it("returns no range when the header is absent", () => {
    expect(parseByteRange(undefined, 1_000)).toBeNull();
  });

  it("serves the whole representation when a suffix exceeds its size", () => {
    expect(parseByteRange("bytes=-2000", 1_000)).toEqual({ start: 0, end: 999 });
  });
});
