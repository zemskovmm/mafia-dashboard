import { useSyncExternalStore } from "react";
import { useMessages } from "../../i18n/I18nProvider.js";
import { timelineConsoleMessages } from "../../i18n/messages/timeline-console.js";
import { errorConsole } from "./error-console.js";

export interface ErrorConsoleScreenProps {
  readonly onBack: () => void;
}

export const ErrorConsoleScreen = ({ onBack }: ErrorConsoleScreenProps) => {
  const { formatDateTime, t } = useMessages(timelineConsoleMessages);
  const entries = useSyncExternalStore(
    errorConsole.subscribe,
    errorConsole.getSnapshot,
    errorConsole.getSnapshot,
  );

  return (
    <main className="error-console-screen" aria-labelledby="error-console-title">
      <header className="error-console-header">
        <button type="button" onClick={onBack}>
          {t("Back")}
        </button>
        <h1 id="error-console-title">{t("Console")}</h1>
        <button type="button" onClick={errorConsole.clear}>
          {t("Clear console")}
        </button>
      </header>

      <section className="error-console-content" aria-label={t("Error console entries")}>
        {entries.length === 0 ? (
          <p>{t("No errors have been captured.")}</p>
        ) : (
          <ol className="error-console-list" aria-label={t("Captured errors")}>
            {entries.map((entry) => (
              <li key={entry.id}>
                <article
                  className="error-console-entry"
                  aria-label={t("Error from {source}: {message}", {
                    source: entry.source,
                    message: entry.message,
                  })}
                >
                  <header>
                    <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
                  </header>
                  <dl>
                    <div>
                      <dt>{t("Source")}</dt>
                      <dd>{entry.source}</dd>
                    </div>
                    <div>
                      <dt>{t("Context")}</dt>
                      <dd>{entry.context ?? t("None")}</dd>
                    </div>
                  </dl>
                  <p className="error-console-message">{entry.message}</p>
                  <pre aria-label={t("Stack trace")}>
                    {entry.stack ?? t("No stack trace available.")}
                  </pre>
                </article>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
};
