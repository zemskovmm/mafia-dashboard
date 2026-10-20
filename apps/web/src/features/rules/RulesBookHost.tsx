import { Component, Suspense, lazy, useEffect, useMemo, useState, type ReactNode } from "react";
import { useI18n, useMessages } from "../../i18n/I18nProvider.js";
import { rulesReaderMessages } from "../../i18n/messages/rules-reader.js";
import { FederationJudgeDialog } from "../game/FederationJudgeDialog.js";
import type { RuleReferenceId } from "./rule-references.js";
import { loadRulesBookContent, prepareRulesBook } from "./rules-book-loading.js";

/** Optional enhanced assets only. Caller owns requested-policy, deadline and cancellation. */
export function preloadRulesBook(options?: { readonly retry?: boolean }): Promise<void> {
  return prepareRulesBook(options);
}

const BookStatus = ({
  open,
  onClose,
  failed = false,
  onRetry,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly failed?: boolean;
  readonly onRetry?: () => void;
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
      {failed && (
        <button type="button" onClick={onRetry}>
          {t("retry")}
        </button>
      )}
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
  const [attempt, setAttempt] = useState(0);
  // React annotates lazy thenables. Give each lazy payload its own promise rather
  // than reusing an already-fulfilled one while its new payload is still pending.
  const Book = useMemo(() => lazy(async () => loadRulesBookContent()), [attempt]);
  useEffect(() => {
    if (open) setVisited(true);
  }, [open]);
  if (!open && !visited) return null;
  return (
    <BookBoundary
      key={attempt}
      fallback={
        <BookStatus
          open={open}
          onClose={onClose}
          onRetry={() => setAttempt((value) => value + 1)}
          failed
        />
      }
    >
      <Suspense fallback={<BookStatus open={open} onClose={onClose} />}>
        <Book open={open} locale={locale} rule={rule} onClose={onClose} />
      </Suspense>
    </BookBoundary>
  );
};
