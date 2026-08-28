export type Locale = "en" | "ru";

export type MessageValues = Readonly<Record<string, string | number>>;

export type PluralMessage = Readonly<
  Partial<Record<Intl.LDMLPluralRule, string>> & { readonly other: string }
>;

export type Message = string | PluralMessage;
