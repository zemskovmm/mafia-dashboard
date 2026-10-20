import { createContext, useContext } from "react";
import "./fancy-features.css";

/** Effective presentation, after the saved preference and asset readiness. */
export const FancyFeaturesContext = createContext(true);
export const useFancyFeatures = () => useContext(FancyFeaturesContext);
