import type { FeatureMessages } from "../I18nProvider.js";

const en = {
  "setup.searchPlayers": "Search {label}",
  "setup.browsePlayers": "Browse {label}",
  "setup.clearRole": "Clear role",
  "setup.clearRoleForSeat": "Clear role for seat {seat}",
  "setup.undealtPreview": "Dev preview · undealt roles",
  "setup.previewRole": "Preview: {role}",
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
  },
};
