import { describe, expect, it } from "vitest";
import { supportsTrueRefraction } from "./refractive-support.js";

describe("true refraction support", () => {
  it("allows enabled Chromium-family browsers with SVG filter URL support", () => {
    expect(
      supportsTrueRefraction({
        enabled: true,
        cssSupportsFilterUrl: true,
        browserBrands: ["Chromium"],
      }),
    ).toBe(true);
  });

  it.each(["Google Chrome", "Microsoft Edge", "Opera", "Brave"])(
    "recognizes the %s Chromium-family brand",
    (brand) => {
      expect(
        supportsTrueRefraction({
          cssSupportsFilterUrl: true,
          browserBrands: [brand],
        }),
      ).toBe(true);
    },
  );

  it.each([
    {
      name: "disabled effects",
      input: { enabled: false, cssSupportsFilterUrl: true, browserBrands: ["Chromium"] },
    },
    {
      name: "missing CSS filter URL support",
      input: { enabled: true, cssSupportsFilterUrl: false, browserBrands: ["Chromium"] },
    },
    {
      name: "Safari",
      input: { enabled: true, cssSupportsFilterUrl: true, browserBrands: ["Safari"] },
    },
    {
      name: "Firefox",
      input: { enabled: true, cssSupportsFilterUrl: true, browserBrands: ["Firefox"] },
    },
    {
      name: "jsdom or an unidentified browser",
      input: { enabled: true, cssSupportsFilterUrl: true, browserBrands: [] },
    },
    {
      name: "an explicitly unsupported brand mixed with Chromium",
      input: {
        enabled: true,
        cssSupportsFilterUrl: true,
        browserBrands: ["Chromium", "Safari"],
      },
    },
  ])("rejects $name", ({ input }) => {
    expect(supportsTrueRefraction(input)).toBe(false);
  });
});
