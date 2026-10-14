export interface LiquidCardLensPixels {
  readonly width: number;
  readonly height: number;
  readonly radius: number;
  readonly rasterWidth: number;
  readonly rasterHeight: number;
  readonly displacement: Uint8ClampedArray;
  readonly edgeMask: Uint8ClampedArray;
}

/** The mockup's rounded-rectangle SDF, sampled in local CSS pixels. */
export const buildLiquidCardLensPixels = (
  width: number,
  height: number,
  radius: number,
): LiquidCardLensPixels | null => {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  // CSS-pixel sampling is sufficient for this soft edge. Never scale work with
  // devicePixelRatio or allocate an unbounded bitmap for an unexpected host.
  const rasterScale = Math.min(1, 512 / Math.max(width, height));
  const rasterWidth = Math.max(1, Math.ceil(width * rasterScale));
  const rasterHeight = Math.max(1, Math.ceil(height * rasterScale));
  const safeRadius = Math.min(
    Number.isFinite(radius) ? Math.max(0, radius) : 0,
    width / 2,
    height / 2,
  );
  const band = Math.min(12, Math.min(width, height) / 4);
  const displacement = new Uint8ClampedArray(rasterWidth * rasterHeight * 4);
  const edgeMask = new Uint8ClampedArray(displacement.length);
  const distance = (x: number, y: number): number => {
    const qx = Math.abs(x - width / 2) - (width / 2 - safeRadius);
    const qy = Math.abs(y - height / 2) - (height / 2 - safeRadius);
    return (
      Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - safeRadius
    );
  };

  for (let y = 0; y < rasterHeight; y += 1) {
    for (let x = 0; x < rasterWidth; x += 1) {
      const px = ((x + 0.5) * width) / rasterWidth;
      const py = ((y + 0.5) * height) / rasterHeight;
      const d = distance(px, py);
      const depth = Math.max(0, -d);
      const strength = d <= 0 && depth < band ? (1 - depth / band) ** 2 : 0;
      const nx = distance(px + 0.5, py) - distance(px - 0.5, py);
      const ny = distance(px, py + 0.5) - distance(px, py - 0.5);
      const index = (y * rasterWidth + x) * 4;
      displacement[index] = 128 - nx * strength * 112;
      displacement[index + 1] = 128 - ny * strength * 112;
      displacement[index + 2] = 128;
      displacement[index + 3] = 255;
      edgeMask[index] = 255;
      edgeMask[index + 1] = 255;
      edgeMask[index + 2] = 255;
      edgeMask[index + 3] = Math.round(strength * 255);
    }
  }

  return { width, height, radius: safeRadius, rasterWidth, rasterHeight, displacement, edgeMask };
};

export interface LiquidCardLens {
  readonly width: number;
  readonly height: number;
  readonly radius: number;
  readonly displacementUrl: string;
  readonly edgeMaskUrl: string;
}

// Cache encoded maps, not DOM/canvas/context objects. Weak ownership also lets
// an embedded document disappear without keeping it or its image data alive.
const documentMaps = new WeakMap<Document, Map<string, LiquidCardLens>>();
const MAX_CACHED_LENSES = 24;

export const createLiquidCardLens = (
  ownerDocument: Document,
  width: number,
  height: number,
  radius: number,
): LiquidCardLens | null => {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const safeRadius = Math.min(
    Number.isFinite(radius) ? Math.max(0, radius) : 0,
    width / 2,
    height / 2,
  );
  const key = `${width}:${height}:${safeRadius}`;
  const cache = documentMaps.get(ownerDocument) ?? new Map<string, LiquidCardLens>();
  const cached = cache.get(key);
  if (cached !== undefined) {
    // LRU keeps the real current card size warm during responsive resizing.
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  try {
    const canvas = ownerDocument.createElement("canvas");
    const context = canvas.getContext("2d");
    if (context === null) return null;
    const pixels = buildLiquidCardLensPixels(width, height, safeRadius);
    if (pixels === null) return null;
    canvas.width = pixels.rasterWidth;
    canvas.height = pixels.rasterHeight;
    const image = context.createImageData(pixels.rasterWidth, pixels.rasterHeight);
    image.data.set(pixels.displacement);
    context.putImageData(image, 0, 0);
    const displacementUrl = canvas.toDataURL("image/png");
    image.data.set(pixels.edgeMask);
    context.putImageData(image, 0, 0);
    const edgeMaskUrl = canvas.toDataURL("image/png");
    if (!displacementUrl.startsWith("data:image/png") || !edgeMaskUrl.startsWith("data:image/png"))
      return null;
    const lens = { width, height, radius: safeRadius, displacementUrl, edgeMaskUrl };
    cache.set(key, lens);
    if (cache.size > MAX_CACHED_LENSES) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) cache.delete(oldestKey);
    }
    documentMaps.set(ownerDocument, cache);
    return lens;
  } catch {
    // A decoration must never prevent a card rendering in a restricted browser.
    return null;
  }
};
