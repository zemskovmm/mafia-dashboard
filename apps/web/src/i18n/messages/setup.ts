import type { FeatureMessages } from "../I18nProvider.js";

const en = {
  "setup.edition.federation": "MAFGAME · 1 July 2026",
  "setup.edition.legacy": "Legacy club rules",
  "setup.clearRole": "Clear role",
  "setup.clearRoleForSeat": "Clear role for seat {seat}",
} as const;

export type SetupMessageKey = keyof typeof en;

export const setupMessages: FeatureMessages<SetupMessageKey> = {
  en,
  ru: {
    "setup.edition.federation": "MAFGAME · 1 июля 2026",
    "setup.edition.legacy": "Прежние клубные правила",
    "setup.clearRole": "Сбросить роль",
    "setup.clearRoleForSeat": "Сбросить роль для места {seat}",
  },
};
