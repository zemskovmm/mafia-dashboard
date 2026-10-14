import type { FeatureMessages } from "../I18nProvider.js";
import type { Message } from "./types.js";

const en = {
  title: "Referee-awarded victory",
  losingTeam: "Losing team",
  red: "Red",
  black: "Black",
  offender: "Offender seat (optional)",
  none: "Not specified",
  rule: "Applicable rule",
  reason: "Judge's reason",
  committee: "Required committee agreement obtained",
  winner: "Result: {team} wins. Player statuses will not be changed.",
  accept: "Award victory to opposing team",
  invalid:
    "This ruling cannot be accepted in the current game state. Check the rule, reason and required acknowledgements.",
  "6.3.1": "6.3.1 · Oaths, pleading, threats, bribery or wagers",
  "6.3.2": "6.3.2 · Non-game ethical or religious appeals",
  "6.3.3": "6.3.3 · Unique night information used to prove Sheriff",
  "6.3.4": "6.3.4 · Audience hints",
  "6.3.5": "6.3.5 · Specified misconduct with committee agreement",
  "6.6.4": "6.6.4 · Information passed after disqualification",
} as const satisfies Record<string, Message>;
const ru = {
  title: "Победа по решению судьи (ППК)",
  losingTeam: "Проигравшая команда",
  red: "Красные",
  black: "Чёрные",
  offender: "Игрок-нарушитель (необязательно)",
  none: "Не указан",
  rule: "Пункт правил",
  reason: "Обоснование судьи",
  committee: "Необходимое согласование с СК получено",
  winner: "Результат: победа команды «{team}». Статусы игроков не изменятся.",
  accept: "Присудить победу противоположной команде",
  invalid:
    "Решение нельзя принять в текущем состоянии игры. Проверьте пункт правил, обоснование и необходимые подтверждения.",
  "6.3.1": "6.3.1 · Клятвы, мольбы, угрозы, подкуп или пари",
  "6.3.2": "6.3.2 · Неигровые этические или религиозные апелляции",
  "6.3.3": "6.3.3 · Доказывание роли шерифа уникальной ночной информацией",
  "6.3.4": "6.3.4 · Подсказки из зрительного зала",
  "6.3.5": "6.3.5 · Указанные нарушения по согласованию с СК",
  "6.6.4": "6.6.4 · Передача информации после дисквалификации",
} as const satisfies Record<keyof typeof en, Message>;
export const adjudicationMessages: FeatureMessages<keyof typeof en> = { en, ru };
