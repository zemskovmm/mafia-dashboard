import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { CASPER_NAME, CASPER_PLAYER_ID } from "@mafia/game-domain";
import { getPlayerRoleIcons } from "../../api/client.js";
import type {
  PlayerRoleIconBundle,
  PlayerRoleIcons,
} from "../../api/player-role-icon-contracts.js";
import { useMessages } from "../../i18n/I18nProvider.js";
import { gameMessages } from "../../i18n/messages/game.js";

export interface DisplayProfile {
  readonly id: string;
  readonly nickname: string;
  readonly roleIcons?: PlayerRoleIcons;
  readonly roleIconsVersion?: string | null;
}

const PlayerDirectory = createContext<readonly DisplayProfile[]>([]);
const emptyIcons: PlayerRoleIcons = {};
const emptyImages: Readonly<Record<string, string>> = {};

const createMediaCache = (clubId: string) => {
  const entries = new Map<string, Promise<PlayerRoleIconBundle>>();
  const controllers = new Set<AbortController>();
  return {
    load(playerId: string, version: string) {
      const key = JSON.stringify([playerId, version]);
      let entry = entries.get(key);
      if (!entry) {
        const controller = new AbortController();
        controllers.add(controller);
        entry = getPlayerRoleIcons(playerId, clubId, controller.signal)
          .catch((error: unknown) => {
            if (entries.get(key) === entry) entries.delete(key);
            throw error;
          })
          .finally(() => controllers.delete(controller));
        entries.set(key, entry);
      }
      return entry;
    },
    dispose() {
      controllers.forEach((controller) => controller.abort());
      controllers.clear();
      entries.clear();
    },
  };
};
const PlayerMedia = createContext<ReturnType<typeof createMediaCache> | null>(null);

export const PlayerDirectoryProvider = ({
  profiles,
  clubId,
  children,
}: {
  readonly profiles: readonly DisplayProfile[];
  readonly clubId?: string;
  readonly children: ReactNode;
}) => {
  // A directory refresh invalidates cached permissions, versions and retired profiles.
  const media = useMemo(() => (clubId ? createMediaCache(clubId) : null), [clubId, profiles]);
  useEffect(() => () => media?.dispose(), [media]);
  return (
    <PlayerDirectory.Provider value={profiles}>
      <PlayerMedia.Provider value={media}>{children}</PlayerMedia.Provider>
    </PlayerDirectory.Provider>
  );
};

/** Only mounted identities load media; the assigned game role is never an input. */
export const usePlayerRoleAppearance = (playerId?: string) => {
  const profiles = useContext(PlayerDirectory);
  const media = useContext(PlayerMedia);
  const profile =
    playerId === CASPER_PLAYER_ID ? undefined : profiles.find(({ id }) => id === playerId);
  const version = profile?.roleIconsVersion;
  const [loaded, setLoaded] = useState<{
    media: typeof media;
    playerId: string;
    version: string;
    images: PlayerRoleIconBundle["images"];
  } | null>(null);
  useEffect(() => {
    setLoaded(null);
    if (!media || !playerId || !version) return;
    let active = true;
    void media.load(playerId, version).then(
      (bundle) => {
        if (active && bundle.version === version)
          setLoaded({ media, playerId, version, images: bundle.images });
      },
      () => {
        /* Failed private media uses the built-in default; never alter game state. */
      },
    );
    return () => {
      active = false;
    };
  }, [media, playerId, version]);
  return {
    roleIcons: profile?.roleIcons ?? emptyIcons,
    images:
      loaded?.media === media && loaded?.playerId === playerId && loaded?.version === version
        ? loaded.images
        : emptyImages,
  };
};

/** Presentation only: never merge this output into a GameState or a save operation. */
export const usePlayerDisplayName = () => {
  const profiles = useContext(PlayerDirectory);
  const { t } = useMessages(gameMessages);
  return (player: { readonly id: string; readonly seat: number }): string =>
    player.id === CASPER_PLAYER_ID
      ? CASPER_NAME
      : (profiles.find(({ id }) => id === player.id)?.nickname ?? t("player.anonymous"));
};
