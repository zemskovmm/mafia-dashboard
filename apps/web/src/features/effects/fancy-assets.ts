import { preloadRulesBook } from "../rules/RulesBookHost.js";
import { backgroundAsset, type BackgroundId } from "../theme/background-preferences.js";
import { preloadVgpuLighting } from "./vgpu/VgpuLightingRuntime.js";
import { loadVisualImage } from "./image-assets.js";

export interface FancyAssetRequirements {
  readonly background: BackgroundId;
  readonly glass: boolean;
  readonly vgpu: boolean;
}

const prepared = new Map<string, Promise<void>>();
const ready = new Set<string>();
export const fancyAssetKey = (request: FancyAssetRequirements): string =>
  JSON.stringify([request.vgpu, request.glass ? backgroundAsset(request.background) : null]);
export const areFancyAssetsReady = (request: FancyAssetRequirements): boolean =>
  ready.has(fancyAssetKey(request));

/** No hidden renderers: only required modules, fonts and decoded images. */
export const prepareFancyAssets = (request: FancyAssetRequirements): Promise<void> => {
  const key = fancyAssetKey(request);
  const existing = prepared.get(key);
  if (existing !== undefined) return existing;
  const background = request.glass ? backgroundAsset(request.background) : null;
  const promise = Promise.all([
    preloadRulesBook(),
    ...(request.vgpu ? [preloadVgpuLighting()] : []),
    ...(background === null ? [] : [loadVisualImage(background)]),
  ]).then(() => {
    if (prepared.get(key) === promise) ready.add(key);
  });
  prepared.set(key, promise);
  void promise.catch(() => {
    if (prepared.get(key) === promise) prepared.delete(key);
  });
  return promise;
};

/** A user retry may replace a timed-out attempt; stale consumers stay cancelled. */
export const retryFancyAssets = (request: FancyAssetRequirements): void => {
  if (areFancyAssetsReady(request)) return;
  prepared.delete(fancyAssetKey(request));
  void preloadRulesBook({ retry: true }).catch(() => undefined);
};
