import { useSyncExternalStore } from "react";
import { errorConsole } from "./error-console.js";

export interface ErrorConsoleScreenProps {
  readonly onBack: () => void;
}

export const ErrorConsoleScreen = ({ onBack }: ErrorConsoleScreenProps) => {
  const entries = useSyncExternalStore(
    errorConsole.subscribe,
    errorConsole.getSnapshot,
    errorConsole.getSnapshot,
  );

  return (
    <main className="error-console-screen" aria-labelledby="error-console-title">
      <header className="error-console-header">
        <button type="button" onClick={onBack}>
          Back
        </button>
        <h1 id="error-console-title">Console</h1>
        <button type="button" onClick={errorConsole.clear}>
          Clear console
        </button>
      </header>

      <section className="error-console-content" aria-label="Error console entries">
        {entries.length === 0 ? (
          <p>No errors have been captured.</p>
        ) : (
          <ol className="error-console-list" aria-label="Captured errors">
            {entries.map((entry) => (
              <li key={entry.id}>
                <article
                  className="error-console-entry"
                  aria-label={`Error from ${entry.source}: ${entry.message}`}
                >
                  <header>
                    <time dateTime={entry.createdAt}>
                      {new Date(entry.createdAt).toLocaleString()}
                    </time>
                  </header>
                  <dl>
                    <div>
                      <dt>Source</dt>
                      <dd>{entry.source}</dd>
                    </div>
                    <div>
                      <dt>Context</dt>
                      <dd>{entry.context ?? "None"}</dd>
                    </div>
                  </dl>
                  <p className="error-console-message">{entry.message}</p>
                  <pre aria-label="Stack trace">{entry.stack ?? "No stack trace available."}</pre>
                </article>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
};
