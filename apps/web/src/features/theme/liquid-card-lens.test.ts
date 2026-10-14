import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLiquidCardLensPixels, createLiquidCardLens } from "./liquid-card-lens.js";

const pixel = (data: Uint8ClampedArray, width: number, x: number, y: number) =>
  Array.from(data.slice((y * width + x) * 4, (y * width + x) * 4 + 4));

describe("rounded liquid-card lens", () => {
  it.each([
    [0, 108],
    [-1, 108],
    [124, 0],
    [Number.NaN, 108],
    [124, Number.POSITIVE_INFINITY],
  ])("does not allocate a lens for invalid or hidden geometry (%s × %s)", (width, height) => {
    expect(buildLiquidCardLensPixels(width, height, 14)).toBeNull();
  });

  it("bounds raster work while retaining fractional local dimensions and safe rounded geometry", () => {
    const lens = buildLiquidCardLensPixels(1024.5, 108.5, 200);
    expect(lens).toMatchObject({ width: 1024.5, height: 108.5, radius: 54.25 });
    if (lens === null) throw new Error("Expected a visible lens");
    expect(lens.rasterWidth).toBeLessThanOrEqual(512);
    expect(lens.rasterHeight).toBeLessThanOrEqual(512);
    expect(lens.displacement.length).toBe(lens.rasterWidth * lens.rasterHeight * 4);
    expect(pixel(lens.edgeMask, lens.rasterWidth, 256, 27)[3]).toBe(0);

    const invalidRadius = buildLiquidCardLensPixels(32, 24, Number.NaN);
    expect(invalidRadius?.radius).toBe(0);
    expect(buildLiquidCardLensPixels(32, 24, -4)?.radius).toBe(0);
  });

  it("refracts only the rounded perimeter, leaving the centre and clipped corners neutral", () => {
    const lens = buildLiquidCardLensPixels(124, 108, 14);
    expect(lens).not.toBeNull();
    if (lens === null) throw new Error("Expected a visible lens");

    expect(pixel(lens.displacement, lens.rasterWidth, 62, 54)).toEqual([128, 128, 128, 255]);
    expect(pixel(lens.edgeMask, lens.rasterWidth, 62, 54)[3]).toBe(0);
    expect(pixel(lens.displacement, lens.rasterWidth, 0, 0)).toEqual([128, 128, 128, 255]);
    expect(pixel(lens.edgeMask, lens.rasterWidth, 0, 0)[3]).toBe(0);

    const left = pixel(lens.displacement, lens.rasterWidth, 1, 54);
    const right = pixel(lens.displacement, lens.rasterWidth, 122, 54);
    const top = pixel(lens.displacement, lens.rasterWidth, 62, 1);
    const bottom = pixel(lens.displacement, lens.rasterWidth, 62, 106);
    expect(left[0]).toBeGreaterThan(128);
    expect(right[0]).toBeLessThan(128);
    expect(top[1]).toBeGreaterThan(128);
    expect(bottom[1]).toBeLessThan(128);
    expect(pixel(lens.edgeMask, lens.rasterWidth, 1, 54)[3]).toBeGreaterThan(100);
    expect(pixel(lens.edgeMask, lens.rasterWidth, 62, 16)[3]).toBe(0);
  });
});

afterEach(() => vi.restoreAllMocks());

describe("encoded lens reuse and fallback", () => {
  it("shares size-matched maps across cards but does not reuse a different size or radius", () => {
    const ownerDocument = document.implementation.createHTMLDocument();
    const context = {
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData: vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );
    let imageNumber = 0;
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(
      () => `data:image/png;base64,mocked-map-${imageNumber++}`,
    );

    const lens = createLiquidCardLens(ownerDocument, 124, 108, 14);
    expect(lens).toMatchObject({ width: 124, height: 108, radius: 14 });
    expect(lens?.displacementUrl).toMatch(/^data:image\/png/);
    expect(lens?.edgeMaskUrl).not.toBe(lens?.displacementUrl);
    expect(createLiquidCardLens(ownerDocument, 124, 108, 14)).toBe(lens);
    expect(createLiquidCardLens(ownerDocument, 124, 108, 20)).not.toBe(lens);
    expect(createLiquidCardLens(ownerDocument, 126, 108, 14)).not.toBe(lens);
    // A resize session cannot retain an unbounded collection of PNGs.
    for (let width = 20; width < 60; width += 1) createLiquidCardLens(ownerDocument, width, 20, 4);
    expect(createLiquidCardLens(ownerDocument, 124, 108, 14)).not.toBe(lens);
  });

  it("keeps the CSS path when the bitmap context or PNG encoder is unavailable", () => {
    const ownerDocument = document.implementation.createHTMLDocument();
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    expect(createLiquidCardLens(ownerDocument, 124, 108, 14)).toBeNull();
    getContext.mockImplementation(() => {
      throw new Error("Canvas unavailable");
    });
    expect(createLiquidCardLens(ownerDocument, 126, 108, 14)).toBeNull();
  });
});
