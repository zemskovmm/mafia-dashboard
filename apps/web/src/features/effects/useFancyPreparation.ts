import { useEffect, useRef, useState } from "react";
import {
  areFancyAssetsReady,
  fancyAssetKey,
  prepareFancyAssets,
  retryFancyAssets,
  type FancyAssetRequirements,
} from "./fancy-assets.js";

export const FANCY_PREPARATION_TIMEOUT_MS = 10_000;
export type FancyPreparationStatus = "off" | "preparing" | "ready" | "fallback" | "skipped";

export const useFancyPreparation = (enabled: boolean, request: FancyAssetRequirements) => {
  const key = fancyAssetKey(request);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; status: FancyPreparationStatus }>(() => ({
    key,
    status: !enabled ? "off" : areFancyAssetsReady(request) ? "ready" : "preparing",
  }));
  const cancel = useRef(() => undefined as void);

  useEffect(() => {
    if (!enabled) {
      setResult({ key, status: "off" });
      return;
    }
    if (result.status === "skipped") return;
    if (areFancyAssetsReady(request)) {
      setResult({ key, status: "ready" });
      return;
    }
    let current = true;
    setResult({ key, status: "preparing" });
    const timer = window.setTimeout(() => {
      if (current) setResult({ key, status: "fallback" });
      current = false;
    }, FANCY_PREPARATION_TIMEOUT_MS);
    const stop = () => {
      current = false;
      window.clearTimeout(timer);
    };
    cancel.current = stop;
    void prepareFancyAssets(request).then(
      () => {
        if (current) setResult({ key, status: "ready" });
        stop();
      },
      () => {
        if (current) setResult({ key, status: "fallback" });
        stop();
      },
    );
    return stop;
  }, [enabled, key, request.background, request.glass, request.vgpu, attempt]);

  const status: FancyPreparationStatus = !enabled
    ? "off"
    : result.status === "skipped"
      ? "skipped"
      : result.key !== key || result.status === "off"
        ? areFancyAssetsReady(request)
          ? "ready"
          : "preparing"
        : result.status;
  return {
    status,
    enabled: status === "ready",
    skip: () => {
      cancel.current();
      setResult({ key, status: "skipped" });
    },
    retry: () => {
      cancel.current();
      retryFancyAssets(request);
      setResult({ key, status: areFancyAssetsReady(request) ? "ready" : "preparing" });
      setAttempt((value) => value + 1);
    },
  };
};
