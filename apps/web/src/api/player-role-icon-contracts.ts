/** Presentation-only profile data. Never embed it in game records. */
export const PLAYER_ICON_ROLES = ["citizen", "mafia", "don", "sheriff"] as const;
export type PlayerIconRole = (typeof PLAYER_ICON_ROLES)[number];

export const BUILTIN_ROLE_ICON_IDS = [
  "user",
  "smile",
  "venetian-mask",
  "hat-glasses",
  "star",
  "shield",
  "crown",
  "heart",
  "spade",
  "diamond",
  "club",
  "cat",
  "dog",
  "bird",
  "fish",
  "rabbit",
  "squirrel",
  "flame",
  "moon",
  "sun",
] as const;
export type BuiltinRoleIconId = (typeof BUILTIN_ROLE_ICON_IDS)[number];
export type PlayerRoleIconChoice =
  Readonly<{ kind: "builtin"; id: BuiltinRoleIconId }> | Readonly<{ kind: "upload"; id: string }>;
export type PlayerRoleIconInput =
  PlayerRoleIconChoice | Readonly<{ kind: "image"; dataUrl: string }> | null;
export type PlayerRoleIcons = Readonly<Partial<Record<PlayerIconRole, PlayerRoleIconChoice>>>;
/** Omission preserves; explicit null resets one role. */
export type PlayerRoleIconsInput = Readonly<Partial<Record<PlayerIconRole, PlayerRoleIconInput>>>;
export interface PlayerRoleIconBundle {
  readonly version: string | null;
  readonly images: Readonly<Record<string, string>>;
}
