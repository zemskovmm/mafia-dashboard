import { useEffect, useState } from "react";
import RulesSketchbook from "./RulesSketchbook.js";
import { rulesChapters } from "./rules-content.js";
import { ruleReferenceTarget, type RuleReferenceId } from "./rule-references.js";
import type { Locale } from "../../i18n/I18nProvider.js";
import { useFancyFeatures } from "../effects/FancyFeaturesContext.js";
import { isRulesBookReady, prepareRulesBook } from "./rules-book-loading.js";

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
  const fancy = useFancyFeatures();
  const [ready, setReady] = useState(isRulesBookReady);
  useEffect(() => {
    if (!open || !fancy) return;
    let current = true;
    void prepareRulesBook().then(
      () => {
        if (current) setReady(true);
      },
      () => {
        /* Keep the same readable flat surface; no automatic retry loop. */
      },
    );
    return () => {
      current = false;
    };
  }, [open, fancy]);
  return (
    <RulesSketchbook
      open={open}
      enhancedReady={ready}
      targetId={rule && ruleReferenceTarget(rule)}
      locale={locale}
      chapters={rulesChapters}
      onClose={onClose}
    />
  );
}
