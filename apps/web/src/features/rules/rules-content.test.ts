import { describe, expect, it } from "vitest";
import { removalRules } from "../../i18n/messages/federation-discipline.js";
import {
  adjudicationRules,
  isRuleReferenceId,
  ruleReferenceIds,
  ruleReferenceTarget,
} from "./rule-references.js";
import { rulesChapters } from "./rules-content.js";

describe("bilingual rules book content", () => {
  it("maps every selectable rule to one unique, substantial bilingual chapter", () => {
    const ids = [...removalRules, ...adjudicationRules];
    expect(ids).toHaveLength(19);
    expect(ruleReferenceIds).toEqual(ids);
    expect(new Set(rulesChapters.map(({ id }) => id)).size).toBe(rulesChapters.length);
    expect(rulesChapters.filter(({ reference }) => reference)).toHaveLength(ids.length);
    for (const id of ids) {
      const chapters = rulesChapters.filter((chapter) => chapter.id === ruleReferenceTarget(id));
      expect(chapters).toHaveLength(1);
      const chapter = chapters[0]!;
      expect(chapter.reference).toBe(id);
      expect(chapter.source).toBe("https://mafgame.org/pages/rules");
      for (const locale of ["en", "ru"] as const) {
        expect(chapter[locale].title[0]).toBe(id);
        expect(chapter[locale].paragraphs!.length).toBeGreaterThan(0);
        expect(chapter[locale].paragraphs!.join(" ").length).toBeGreaterThan(200);
        expect(chapter[locale].margin.length).toBeGreaterThan(30);
        expect(JSON.stringify(chapter[locale])).not.toMatch(/<(?:script|div|p|em|strong)\b/);
      }
    }
    for (const invalid of ["", "6.2.14", "6.2.01", " 6.2.1", "6.6.5"]) {
      expect(isRuleReferenceId(invalid)).toBe(false);
    }
  });

  it("retains source qualifications rather than treating every removal as team defeat", () => {
    const escalation = rulesChapters.find(({ reference }) => reference === "6.3.5")!;
    for (const locale of ["en", "ru"] as const) {
      const body = escalation[locale].paragraphs!.join(" ");
      for (const rule of ["6.2.5", "6.2.11", "6.2.12", "6.2.13"]) expect(body).toContain(rule);
      expect(body).toContain("версии");
      expect(body).toContain("СК");
    }
    const excluded = rulesChapters.find(({ reference }) => reference === "6.6.4")!;
    expect(excluded.en.paragraphs!.join(" ")).toContain("shots are ignored");
    expect(excluded.ru.paragraphs!.join(" ")).toContain("выстрелы не учитываются");
  });
});
