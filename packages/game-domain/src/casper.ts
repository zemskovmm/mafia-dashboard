import type { PlayerInput, Role } from "./types.js";

export const CASPER_PLAYER_ID = "casper";
export const CASPER_SEAT = 10;
export const CASPER_NAME = "Casper";

export const isCasperPlayer = (player: Pick<PlayerInput, "id">): boolean =>
  player.id === CASPER_PLAYER_ID;

export const assertCasperPlayer = (player: PlayerInput): void => {
  if (!isCasperPlayer(player)) return;
  if (player.seat !== CASPER_SEAT) throw new Error("Casper must occupy seat 10");
};

export const assertCasperRole = (player: PlayerInput, role: Role | undefined): void => {
  assertCasperPlayer(player);
  if (isCasperPlayer(player) && role !== "citizen") {
    throw new Error("Casper must be assigned the citizen role");
  }
};
