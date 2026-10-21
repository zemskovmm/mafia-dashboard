import type { FeatureMessages } from "../I18nProvider.js";

const en = {
  "setup.searchPlayers": "Search {label}",
  "setup.browsePlayers": "Browse {label}",
  "setup.clearRole": "Clear role",
  "setup.clearRoleForSeat": "Clear role for seat {seat}",
  "setup.undealtPreview": "Dev preview · undealt roles",
  "setup.previewRole": "Preview: {role}",
  "tutorial.help": "Role giveaway help",
  "tutorial.title": "Role giveaway tutorial",
  "tutorial.revealTitle": "Tap to reveal",
  "tutorial.revealBody": "Tap an undealt player card to reveal its role.",
  "tutorial.rerollTitle": "Three taps to reshuffle",
  "tutorial.rerollBody":
    "Quickly tap a dealt card three times to reshuffle it with the undealt cards. Other dealt cards stay unchanged.",
  "tutorial.rerollNote": "Only while cards remain. Not for Casper. The role may stay the same.",
  "tutorial.readyTitle": "Ready to begin",
  "tutorial.readyBody": "Once every role is dealt, choose “{action}”.",
  "tutorial.demoNote": "Just a guide — your deal stays unchanged.",
  "tutorial.exampleUndealt": "Example: undealt card",
  "tutorial.exampleDealt": "Example: dealt card",
  "tutorial.progress": "Step {current} of {total}",
  "tutorial.back": "Back",
  "tutorial.next": "Next",
  "tutorial.done": "Done",
  "tutorial.close": "Close tutorial",
  "tutorial.swipe": "Swipe left or right to explore",
} as const;

export type SetupMessageKey = keyof typeof en;

export const setupMessages: FeatureMessages<SetupMessageKey> = {
  en,
  ru: {
    "setup.searchPlayers": "Поиск: {label}",
    "setup.browsePlayers": "Выбрать: {label}",
    "setup.clearRole": "Сбросить роль",
    "setup.clearRoleForSeat": "Сбросить роль для места {seat}",
    "setup.undealtPreview": "Dev-просмотр · неразданные роли",
    "setup.previewRole": "Предпросмотр: {role}",
    "tutorial.help": "Помощь с раздачей ролей",
    "tutorial.title": "Как раздавать роли",
    "tutorial.revealTitle": "Нажмите, чтобы открыть роль",
    "tutorial.revealBody":
      "Нажмите на карточку игрока, которому ещё не выдана роль, чтобы открыть её.",
    "tutorial.rerollTitle": "Три нажатия для перераздачи",
    "tutorial.rerollBody":
      "Быстро нажмите трижды на открытую карточку, чтобы перемешать её роль с неразданными. Другие выданные роли не изменятся.",
    "tutorial.rerollNote":
      "Только пока есть неразданные роли. Не для Каспера. Роль может остаться прежней.",
    "tutorial.readyTitle": "Можно начинать",
    "tutorial.readyBody": "Когда все роли выданы, нажмите «{action}».",
    "tutorial.demoNote": "Это лишь подсказки — раздача не меняется.",
    "tutorial.exampleUndealt": "Пример: роль не выдана",
    "tutorial.exampleDealt": "Пример: роль выдана",
    "tutorial.progress": "Шаг {current} из {total}",
    "tutorial.back": "Назад",
    "tutorial.next": "Далее",
    "tutorial.done": "Готово",
    "tutorial.close": "Закрыть подсказки",
    "tutorial.swipe": "Листайте влево или вправо",
  },
};
