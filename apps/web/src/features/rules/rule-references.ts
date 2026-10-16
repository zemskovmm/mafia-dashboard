import { removalRules } from "../../i18n/messages/federation-discipline.js";

export const adjudicationRules = ["6.3.1", "6.3.2", "6.3.3", "6.3.4", "6.3.5", "6.6.4"] as const;
export const ruleReferenceIds = [...removalRules, ...adjudicationRules] as const;
export type RuleReferenceId = (typeof ruleReferenceIds)[number];

export const isRuleReferenceId = (value: string): value is RuleReferenceId =>
  ruleReferenceIds.some((id) => id === value);

/** Stable targets are independent of language, layout and physical page count. */
export const ruleReferenceTarget = (id: RuleReferenceId): string => `rule-${id}`;
