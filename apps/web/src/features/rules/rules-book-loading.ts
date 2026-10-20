import type RulesBookContent from "./RulesBookContent.js";
type ReaderModule = { default: typeof RulesBookContent };
let reader: Promise<ReaderModule> | undefined;
let readiness: Promise<void> | undefined;
let ready = false;

/** Shared by React.lazy and explicit preparation; failed attempts are retryable. */
export function loadRulesBookContent(): Promise<ReaderModule> {
  if (!reader) {
    reader = import("./RulesBookContent.js").catch((error: unknown) => {
      reader = undefined;
      throw error;
    });
  }
  return reader;
}

export function isRulesBookReady(): boolean {
  return ready;
}

export function prepareRulesBook({ retry = false } = {}): Promise<void> {
  if (retry && !ready) readiness = undefined;
  if (!readiness) {
    // Import the real code/CSS first; the asset owner also awaits font registration.
    const pending = loadRulesBookContent()
      .then(() => import("./rules-book-assets.js"))
      .then(({ preloadRulesBookAssets }) => preloadRulesBookAssets({ retry }))
      .then(() => {
        if (readiness === pending) ready = true;
      })
      .catch((error: unknown) => {
        if (readiness === pending) readiness = undefined;
        throw error;
      });
    readiness = pending;
  }
  return readiness;
}
