import { createContext } from "react";
import { DEFAULT_GLASS_SETTINGS, type GlassSettings } from "./glass-preferences.js";

export type PlayerCardAppearance = Pick<
  GlassSettings,
  "nominationTint" | "nominationColor" | "nominationTreatment"
>;

// Device-local presentation only; no dependency on game state or renderer readiness.
export const PlayerCardAppearanceContext =
  createContext<PlayerCardAppearance>(DEFAULT_GLASS_SETTINGS);
