import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

const memoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  };
};

Object.defineProperties(window, {
  localStorage: { configurable: true, value: memoryStorage() },
  sessionStorage: { configurable: true, value: memoryStorage() },
});

window.matchMedia ??= (query) =>
  Object.assign(new EventTarget(), {
    media: query,
    matches: false,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
  });

afterEach(cleanup);
