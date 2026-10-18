import { useState, type ReactNode } from "react";
import { findRoleIcon } from "./role-icon-library.js";
import "./role-icons.css";
import type { PlayerRoleIconInput } from "../../api/player-role-icon-contracts.js";

export interface RoleIconArtworkProps {
  readonly choice?: PlayerRoleIconInput;
  readonly images?: Readonly<Record<string, string>>;
  readonly className?: string;
  readonly fallback?: ReactNode;
}

const RasterArtwork = ({
  source,
  fallback,
}: {
  readonly source: string;
  readonly fallback: ReactNode;
}) => {
  const [failed, setFailed] = useState(false);
  return failed ? <>{fallback}</> : <img src={source} alt="" onError={() => setFailed(true)} />;
};

export const RoleIconArtwork = ({
  choice,
  images = {},
  className = "",
  fallback = null,
}: RoleIconArtworkProps) => {
  const Icon = choice?.kind === "builtin" ? findRoleIcon(choice.id)?.Icon : undefined;
  const source =
    choice?.kind === "image"
      ? choice.dataUrl
      : choice?.kind === "upload"
        ? images[choice.id]
        : undefined;
  const safeSource =
    source && /^data:image\/(?:png|jpeg|webp);base64,/i.test(source) ? source : undefined;
  return (
    <span className={`role-icon-artwork ${className}`} aria-hidden="true">
      {Icon ? (
        <Icon />
      ) : safeSource ? (
        <RasterArtwork key={safeSource} source={safeSource} fallback={fallback} />
      ) : (
        fallback
      )}
    </span>
  );
};
