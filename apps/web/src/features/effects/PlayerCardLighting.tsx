export type PlayerLightingKind = "speaker" | "mafia" | "sheriff" | "attention";

interface PlayerLightingSignals {
  readonly current?: boolean;
  readonly mafiaShooter?: boolean;
  readonly sheriffHighlight?: boolean;
  readonly goodbyeHighlight?: boolean;
  readonly votingHighlight?: boolean;
}

export const resolvePlayerLightingKind = ({
  current,
  mafiaShooter,
  sheriffHighlight,
  goodbyeHighlight,
  votingHighlight,
}: PlayerLightingSignals): PlayerLightingKind | null => {
  if (current) return "speaker";
  if (mafiaShooter) return "mafia";
  if (sheriffHighlight) return "sheriff";
  if (goodbyeHighlight || votingHighlight) return "attention";
  return null;
};
