import { createContext } from "react";

/** Setup-only DOM slot; the picker keeps all state and other consumers stay inline. */
export const SetupTournamentFieldsContext = createContext<HTMLElement | null>(null);
