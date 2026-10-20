import clubArt from "./assets/club.webp";
import nightArt from "./assets/night.webp";

// The reader and preloader consume the same application-resolved asset URLs.
// Importing this inventory alone does not fetch optional media or fonts.
export { clubArt, nightArt };

const fontFaces = (
  [
    ["normal", "400"],
    ["normal", "600"],
    ["italic", "400"],
  ] as const
).map(([style, weight]) => ({ style, weight, font: `${style} ${weight} 20px "RulesCormorant"` }));
const fontCoverage = "Mafia rules Мафия правила Ёё";
const loads = new Map<string, Promise<void>>();
const loaded = new Set<string>();
let readiness: Promise<void> | undefined;

function waitForFontRegistration(): Promise<void> | undefined {
  if (!document.fonts) return Promise.reject(new Error("Rules book font loading is unavailable"));
  const registered = () =>
    fontFaces.every(({ style, weight }) =>
      [...document.fonts].some(
        (face) =>
          face.family.replaceAll('"', "") === "RulesCormorant" &&
          face.style === style &&
          face.weight === weight,
      ),
    );
  if (registered()) return;
  // WebKit can resolve a CSS import (and fonts.ready) before @font-face
  // registration while another stylesheet import is pending. Never poll forever.
  return new Promise<void>((resolve, reject) => {
    const poll = window.setInterval(() => {
      if (!registered()) return;
      window.clearInterval(poll);
      window.clearTimeout(deadline);
      resolve();
    }, 50);
    const deadline = window.setTimeout(() => {
      window.clearInterval(poll);
      reject(new Error("Rules book font registration timed out"));
    }, 10_000);
  });
}

function once(key: string, load: () => Promise<void>): Promise<void> {
  const previous = loads.get(key);
  if (previous) return previous;
  const pending = load()
    .then(() => {
      if (loads.get(key) === pending) loaded.add(key);
    })
    .catch((error: unknown) => {
      if (loads.get(key) === pending) loads.delete(key);
      throw error;
    });
  loads.set(key, pending);
  return pending;
}

/** Call after the reader's CSS import; font registration may still be pending. */
export function preloadRulesBookAssets({ retry = false } = {}): Promise<void> {
  if (retry) {
    // A deadline does not reject the browser's font/decode promises. Replace
    // unfinished work deliberately, retaining every successfully prepared asset.
    for (const key of loads.keys()) {
      if (!loaded.has(key)) loads.delete(key);
    }
    readiness = undefined;
  }
  if (readiness) return readiness;
  const registration = waitForFontRegistration();
  const load = () =>
    Promise.all([
      ...[clubArt, nightArt].map((url) =>
        once(url, async () => {
          const image = new Image();
          image.decoding = "async";
          image.src = url;
          await image.decode();
        }),
      ),
      ...fontFaces.map(({ font }) =>
        once(font, async () => {
          if (!document.fonts) throw new Error("Rules book font loading is unavailable");
          const faces = await document.fonts.load(font, fontCoverage);
          if (!faces.length || faces.some((face) => face.status !== "loaded")) {
            throw new Error(`Rules book font did not load: ${font}`);
          }
        }),
      ),
    ]);
  const pending = (registration ? registration.then(load) : load())
    .then(() => undefined)
    .catch((error: unknown) => {
      if (readiness === pending) readiness = undefined;
      throw error;
    });
  readiness = pending;
  return pending;
}
