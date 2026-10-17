import type { FeatureMessages } from "../I18nProvider.js";

const en = {
  "setup.clearRole": "Clear role",
  "setup.clearRoleForSeat": "Clear role for seat {seat}",
} as const;

export type SetupMessageKey = keyof typeof en;

export const setupMessages: FeatureMessages<SetupMessageKey> = {
  en,
  ru: {
    "setup.clearRole": "Сбросить роль",
    "setup.clearRoleForSeat": "Сбросить роль для места {seat}",
  },
};
