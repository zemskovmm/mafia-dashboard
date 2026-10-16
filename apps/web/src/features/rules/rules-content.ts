import { guideChapters } from "./guide-chapters.js";
import { ruleReferences } from "./reference-content.js";
import { ruleReferenceTarget } from "./rule-references.js";
import type { RulesChapter, RulesChapterText } from "./rules-types.js";

const referenceText = (
  reference: (typeof ruleReferences)[number],
  locale: "en" | "ru",
): RulesChapterText => {
  const text = reference[locale];
  return {
    name: `${reference.id} · ${text.title}`,
    title: [reference.id, text.title],
    tag: locale === "ru" ? "Пояснительная справка" : "Explanatory reference",
    plate: `MAFGAME · ${reference.id}`,
    note: "MAFGAME · 01.07.2026",
    lede:
      locale === "ru"
        ? "Авторское пояснение, а не официальный текст правил. Решение принимает судья."
        : "An authored explanation, not official rule wording. The judge makes the decision.",
    paragraphs: text.paragraphs,
    margin: text.note,
  };
};

export const rulesChapters: readonly RulesChapter[] = [
  ...guideChapters,
  ...ruleReferences.map((reference): RulesChapter => ({
    id: ruleReferenceTarget(reference.id),
    reference: reference.id,
    art: reference.id === "6.6.4" || reference.id === "6.2.3" ? "night" : "club",
    source: reference.source,
    en: referenceText(reference, "en"),
    ru: referenceText(reference, "ru"),
  })),
];
