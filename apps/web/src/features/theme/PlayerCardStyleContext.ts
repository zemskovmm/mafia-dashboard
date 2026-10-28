import { createContext } from "react";
import {
  DEFAULT_PLAYER_CARD_PREFERENCES,
  type PlayerCardPreferences,
} from "./player-card-preferences.js";

export const PlayerCardStyleContext = createContext<PlayerCardPreferences>(
  DEFAULT_PLAYER_CARD_PREFERENCES,
);
