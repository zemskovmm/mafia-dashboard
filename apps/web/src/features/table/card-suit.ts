export const CARD_SUITS = ["spade", "heart", "diamond", "club"] as const;
export type CardSuit = (typeof CARD_SUITS)[number];
export const CARD_SUIT_SYMBOLS: Readonly<Record<CardSuit, string>> = {
  spade: "♠",
  heart: "♥",
  diamond: "♦",
  club: "♣",
};

/** Frozen v1: FNV-1a over length-framed UTF-16 game/player IDs, then avalanche.
 * Neither canonical data nor render-time randomness participates. Duplicates are valid.
 */
export const cardSuit = (gameId: string | null, playerId?: string): CardSuit | null => {
  if (!gameId || !playerId) return null;
  const key = `${gameId.length}:${gameId}${playerId.length}:${playerId}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193);
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  return CARD_SUITS[(hash >>> 0) % CARD_SUITS.length]!;
};
