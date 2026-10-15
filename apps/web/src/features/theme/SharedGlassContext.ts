import { createContext } from "react";

// True after a shared draw succeeds: skip redundant local SVG maps/sweeps.
// Visibility is per surface (data-glass-painted), never this global hint;
// newly mounted/unregistered cards retain CSS fallback until actually drawn.
export const SharedGlassContext = createContext(false);
