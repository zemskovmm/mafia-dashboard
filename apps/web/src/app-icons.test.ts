import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

describe("application icons", () => {
  it("ships a revised iPad icon separately from the browser favicons", () => {
    const html = new DOMParser().parseFromString(
      readFileSync(resolve(process.cwd(), "index.html"), "utf8"),
      "text/html",
    );
    const touchIcon = html.querySelector('link[rel="apple-touch-icon"]');
    expect(touchIcon?.getAttribute("sizes")).toBe("180x180");
    expect(touchIcon?.getAttribute("href")).toBe("/apple-touch-icon.png?v=3");

    const url = new URL(touchIcon!.getAttribute("href")!, "https://example.test");
    const png = readFileSync(resolve(process.cwd(), "public", url.pathname.slice(1)));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.toString("ascii", 12, 16)).toBe("IHDR");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([180, 180]);

    // iPad Chrome can display this touch icon in its tab without an OS corner mask.
    expect([png[24], png[25], png[28]]).toEqual([8, 6, 0]); // 8-bit RGBA, non-interlaced
    const imageData: Buffer[] = [];
    for (let offset = 8; offset < png.length;) {
      const length = png.readUInt32BE(offset);
      if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") {
        imageData.push(png.subarray(offset + 8, offset + 8 + length));
      }
      offset += length + 12;
    }
    // The first pixel has no left/above neighbors, so every PNG filter leaves it unchanged.
    const firstScanline = inflateSync(Buffer.concat(imageData));
    expect(firstScanline[4], "touch icon's top-left corner must be transparent").toBe(0);

    expect(
      [...html.querySelectorAll('link[rel="icon"]')].map((icon) => ({
        href: icon.getAttribute("href"),
        sizes: icon.getAttribute("sizes"),
        type: icon.getAttribute("type"),
      })),
    ).toEqual([
      { href: "/favicon-16.png", sizes: "16x16", type: "image/png" },
      { href: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { href: "/la-verdad.svg", sizes: "any", type: "image/svg+xml" },
    ]);
  });
});
