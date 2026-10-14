export const FEDERATION_RULES_EDITION = "mafgame-2026-07-01" as const;

/** Absence of this discriminator denotes the supported legacy club rules. */
export type RulesEdition = typeof FEDERATION_RULES_EDITION;

export const assertRulesEdition: (value: unknown) => asserts value is RulesEdition = (value) => {
  if (value !== FEDERATION_RULES_EDITION) {
    throw new Error(`Unsupported rules edition ${String(value)}`);
  }
};

export const isFederationGame = (game: { readonly rulesEdition?: RulesEdition }): boolean =>
  game.rulesEdition === FEDERATION_RULES_EDITION;
