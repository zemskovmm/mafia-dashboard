import type { FeatureMessages } from "../I18nProvider.js";

const en = {
  "setup.edition.federation": "MAFGAME · 1 July 2026",
  "setup.edition.legacy": "Legacy club rules",
  "setup.deviations.title": "Nonstandard club deviations",
  "setup.deviations.casper": "Casper replaces a human player.",
  "setup.deviations.best-move-disabled": "Best Move is disabled.",
  "setup.deviations.role-reroll": "A discretionary role reroll was used.",
  "setup.deviations.acknowledge": "I acknowledge these nonstandard club deviations",
  "setup.reroll.title": "Nonstandard role reroll",
  "setup.reroll.explanation":
    "Choosing a new role for convenience is a nonstandard club deviation, not correction of a physically dealt card.",
  "setup.reroll.confirm": "Acknowledge deviation and reroll",
  "setup.reroll.card": "{name}: {role}. Triple tap to request a nonstandard reroll",
  "setup.physicalDeal":
    "Record or correct the physically dealt card; do not choose a new deal for convenience.",
} as const;

export type SetupMessageKey = keyof typeof en;

export const setupMessages: FeatureMessages<SetupMessageKey> = {
  en,
  ru: {
    "setup.edition.federation": "MAFGAME · 1 июля 2026",
    "setup.edition.legacy": "Прежние клубные правила",
    "setup.deviations.title": "Нестандартные клубные отклонения",
    "setup.deviations.casper": "Каспер заменяет живого игрока.",
    "setup.deviations.best-move-disabled": "Лучший ход отключён.",
    "setup.deviations.role-reroll": "Роль была перераздана по усмотрению ведущего.",
    "setup.deviations.acknowledge": "Я подтверждаю эти нестандартные клубные отклонения",
    "setup.reroll.title": "Нестандартная перераздача роли",
    "setup.reroll.explanation":
      "Выбор новой роли по желанию — нестандартное клубное отклонение, а не исправление записи физически выданной карты.",
    "setup.reroll.confirm": "Подтвердить отклонение и перераздать",
    "setup.reroll.card": "{name}: {role}. Тройное нажатие — запрос нестандартной перераздачи",
    "setup.physicalDeal":
      "Запишите или исправьте физически выданную карту; не выбирайте новую раздачу по желанию.",
  },
};
