import type { MessageKey } from "./en.js";
import type { Message } from "./types.js";

export const russianMessages = {
  Language: "Язык",
  English: "Английский",
  Russian: "Русский",
  "Day {day}": "День {day}",
  "Hello, {name}": "Привет, {name}",
  "players.games": {
    one: "{count} игра",
    few: "{count} игры",
    many: "{count} игр",
    other: "{count} игры",
  },
} as const satisfies Record<MessageKey, Message>;
