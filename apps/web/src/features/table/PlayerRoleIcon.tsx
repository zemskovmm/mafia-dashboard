import type { Role } from "@mafia/game-domain";
import { usePlayerRoleAppearance } from "../players/player-display.js";
import { RoleIconArtwork } from "../players/RoleIconArtwork.js";
import { useMessages } from "../../i18n/I18nProvider.js";
import { gameMessages } from "../../i18n/messages/game.js";
import { RoleDrawIcon } from "./RoleDrawPresentation.js";

export const PlayerRoleIcon = ({
  role,
  playerId,
  unknown = false,
}: Readonly<{ role?: Role; playerId?: string; unknown?: boolean }>) => {
  const { t } = useMessages(gameMessages);
  const { roleIcons, images } = usePlayerRoleAppearance(playerId);
  // Resolve the whole appearance bundle independent of role visibility.
  if (role === undefined)
    return (
      <span className="player-role-icon" aria-hidden="true">
        <RoleDrawIcon unknown={unknown} />
      </span>
    );
  return (
    <span className="player-role-icon" role="img" aria-label={t(`role.${role}`)}>
      <RoleIconArtwork
        choice={roleIcons[role]}
        images={images}
        fallback={<RoleDrawIcon role={role} />}
      />
    </span>
  );
};
