import { createContext, useContext, type ReactNode } from "react";
import { CASPER_NAME, CASPER_PLAYER_ID } from "@mafia/game-domain";
import { useMessages } from "../../i18n/I18nProvider.js";
import { gameMessages } from "../../i18n/messages/game.js";

export interface DisplayProfile {
  readonly id: string;
  readonly nickname: string;
}

const PlayerDirectory = createContext<readonly DisplayProfile[]>([]);

export const PlayerDirectoryProvider = ({
  profiles,
  children,
}: {
  readonly profiles: readonly DisplayProfile[];
  readonly children: ReactNode;
}) => <PlayerDirectory.Provider value={profiles}>{children}</PlayerDirectory.Provider>;

/** Presentation only: never merge this output into a GameState or a save operation. */
export const usePlayerDisplayName = () => {
  const profiles = useContext(PlayerDirectory);
  const { t } = useMessages(gameMessages);
  return (player: { readonly id: string; readonly seat: number }): string =>
    player.id === CASPER_PLAYER_ID
      ? CASPER_NAME
      : (profiles.find(({ id }) => id === player.id)?.nickname ?? t("player.anonymous"));
};
