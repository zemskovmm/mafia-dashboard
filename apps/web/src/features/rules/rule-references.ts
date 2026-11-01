import { removalRules } from "../../i18n/messages/federation-discipline.js";

export const adjudicationRules = ["6.3.1", "6.3.2", "6.3.3", "6.3.4", "6.3.5", "6.6.4"] as const;
export const ruleReferenceIds = [...removalRules, ...adjudicationRules] as const;
export type RuleReferenceId = (typeof ruleReferenceIds)[number];

/** Presentation only: never include these symbols in canonical rule IDs. */
export const ruleReferenceEmojis = {
  "6.2.1": "🟥",
  "6.2.2": "🗯️",
  "6.2.3": "🌙",
  "6.2.4": "🚪",
  "6.2.5": "😢",
  "6.2.6": "🗳️",
  "6.2.7": "🎯",
  "6.2.8": "🤫",
  "6.2.9": "🤬",
  "6.2.10": "🕵️",
  "6.2.11": "🗣️",
  "6.2.12": "🎭",
  "6.2.13": "💬",
  "6.3.1": "🤝",
  "6.3.2": "⚖️",
  "6.3.3": "🔎",
  "6.3.4": "📣",
  "6.3.5": "👥",
  "6.6.4": "🚫",
} as const satisfies Record<RuleReferenceId, string>;

export const isRuleReferenceId = (value: string): value is RuleReferenceId =>
  ruleReferenceIds.some((id) => id === value);

/** Stable targets are independent of language, layout and physical page count. */
export const ruleReferenceTarget = (id: RuleReferenceId): string => `rule-${id}`;
