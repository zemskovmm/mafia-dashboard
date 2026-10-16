import RulesSketchbook from "./RulesSketchbook.js";
import { rulesChapters } from "./rules-content.js";
import { ruleReferenceTarget, type RuleReferenceId } from "./rule-references.js";
import type { Locale } from "../../i18n/I18nProvider.js";

export default function RulesBookContent({
  open,
  rule,
  locale,
  onClose,
}: {
  readonly open: boolean;
  readonly rule?: RuleReferenceId;
  readonly locale: Locale;
  readonly onClose: () => void;
}) {
  return (
    <RulesSketchbook
      open={open}
      targetId={rule && ruleReferenceTarget(rule)}
      locale={locale}
      chapters={rulesChapters}
      onClose={onClose}
    />
  );
}
