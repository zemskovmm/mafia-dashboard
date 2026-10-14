import { createContext } from "react";

// True only after a real scene draw succeeds. A lost/failed scene immediately
// remounts the existing readable card material rather than leaving empty cards.
export const SharedGlassContext = createContext(false);
