import { Component, Suspense, lazy, useEffect, useState, type ReactNode } from "react";
import { useI18n, useMessages } from "../../i18n/I18nProvider.js";
import { rulesReaderMessages } from "../../i18n/messages/rules-reader.js";
import { FederationJudgeDialog } from "../game/FederationJudgeDialog.js";
import type { RuleReferenceId } from "./rule-references.js";

const Book = lazy(() => import("./RulesBookContent.js"));

const BookStatus = ({
  open,
  onClose,
  failed = false,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly failed?: boolean;
}) => {
  const { t } = useMessages(rulesReaderMessages);
  return (
    <FederationJudgeDialog
      active={open}
      title={t("statusTitle")}
      closeLabel={t("statusClose")}
      onDismiss={onClose}
    >
      <p role={failed ? "alert" : "status"}>{t(failed ? "failed" : "loading")}</p>
    </FederationJudgeDialog>
  );
};

class BookBoundary extends Component<
  { readonly children: ReactNode; readonly fallback: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Loading the reader never replaces the game or the unfinished disciplinary form. */
export const RulesBookHost = ({
  open,
  rule,
  onClose,
}: {
  readonly open: boolean;
  readonly rule?: RuleReferenceId;
  readonly onClose: () => void;
}) => {
  const { locale } = useI18n();
  const [visited, setVisited] = useState(false);
  useEffect(() => {
    if (open) setVisited(true);
  }, [open]);
  if (!open && !visited) return null;
  return (
    <BookBoundary fallback={<BookStatus open={open} onClose={onClose} failed />}>
      <Suspense fallback={<BookStatus open={open} onClose={onClose} />}>
        <Book open={open} locale={locale} rule={rule} onClose={onClose} />
      </Suspense>
    </BookBoundary>
  );
};
