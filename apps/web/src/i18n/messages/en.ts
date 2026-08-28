import type { Message } from "./types.js";

export const englishMessages = {
  Language: "Language",
  English: "English",
  Russian: "Russian",
  "Day {day}": "Day {day}",
  "Hello, {name}": "Hello, {name}",
  "players.games": {
    one: "{count} game",
    other: "{count} games",
  },
} as const satisfies Record<string, Message>;

export type MessageKey = keyof typeof englishMessages;
