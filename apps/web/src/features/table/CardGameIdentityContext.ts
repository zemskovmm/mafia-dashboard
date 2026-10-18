import { createContext } from "react";

/** Presentation only. Follow the rendered game, including read-only event preview. */
export const CardGameIdentityContext = createContext<string | null>(null);
