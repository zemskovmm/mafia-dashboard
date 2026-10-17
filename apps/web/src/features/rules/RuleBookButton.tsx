import { BookOpen } from "lucide-react";
import { useMessages } from "../../i18n/I18nProvider.js";
import { rulesReaderMessages } from "../../i18n/messages/rules-reader.js";
import { isRuleReferenceId, type RuleReferenceId } from "./rule-references.js";

export const RuleBookButton = ({
  rule,
  onOpen,
}: {
  readonly rule: string;
  readonly onOpen?: (rule: RuleReferenceId) => void;
}) => {
  const { t } = useMessages(rulesReaderMessages);
  const valid = isRuleReferenceId(rule);
  const label = valid ? t("readRule", { rule }) : t("chooseRule");
  return (
    <button
      type="button"
      disabled={!valid || !onOpen}
      aria-label={label}
      title={label}
      aria-haspopup="dialog"
      onClick={() => {
        if (isRuleReferenceId(rule)) onOpen?.(rule);
      }}
    >
      <BookOpen aria-hidden="true" />
    </button>
  );
};
