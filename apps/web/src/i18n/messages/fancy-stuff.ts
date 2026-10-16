import type { FeatureMessages } from "../I18nProvider.js";
import type { Message } from "./types.js";

const en = {
  section: "Fancy stuff",
  clubEntryEffects: "Club entry effects",
  enable: "Enable club entry effects",
  disable: "Disable club entry effects",
  on: "On",
  off: "Off",
  help: "Card embers and the burn transition when entering a club. Turn off to enter without animation.",
  local: "Saved only in this browser. Reduced motion still applies.",
} as const satisfies Record<string, Message>;
const ru = {
  section: "Красивые эффекты",
  clubEntryEffects: "Эффекты входа в клуб",
  enable: "Включить эффекты входа в клуб",
  disable: "Выключить эффекты входа в клуб",
  on: "Вкл.",
  off: "Выкл.",
  help: "Тлеющие края карточек и эффект выгорания при входе в клуб. Выключите, чтобы входить без анимации.",
  local: "Сохраняется только в этом браузере. Настройка уменьшения движения учитывается всегда.",
} as const satisfies Record<keyof typeof en, Message>;
export const fancyStuffMessages: FeatureMessages<keyof typeof en> = { en, ru };
