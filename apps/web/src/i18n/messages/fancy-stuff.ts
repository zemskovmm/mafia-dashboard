import type { FeatureMessages } from "../I18nProvider.js";
import type { Message } from "./types.js";

const en = {
  section: "Fancy Features",
  master: "Advanced visual effects",
  enable: "Enable Fancy Features",
  disable: "Disable Fancy Features",
  on: "On",
  off: "Off",
  help: "Enhanced glass, lighting, animations and the illustrated book. Turn off for lightweight visuals and a flat rules manual; game controls, timer and music stay available.",
  local: "Saved only in this browser. Reduced motion still applies.",
  preparing: "Preparing visuals…",
  continue: "Continue with lightweight visuals",
  lightweight: "Lightweight visuals active. Your advanced appearance choices are kept.",
  failed: "Some visual assets could not be prepared. Lightweight visuals remain available.",
  retry: "Retry visual preparation",
} as const satisfies Record<string, Message>;
const ru = {
  section: "Красивые эффекты",
  master: "Дополнительные визуальные эффекты",
  enable: "Включить красивые эффекты",
  disable: "Выключить красивые эффекты",
  on: "Вкл.",
  off: "Выкл.",
  help: "Стекло, подсветка, анимация и иллюстрированная книга. Выключите для лёгкого оформления и обычного справочника; управление игрой, таймер и музыка останутся доступны.",
  local: "Сохраняется только в этом браузере. Настройка уменьшения движения учитывается всегда.",
  preparing: "Подготовка оформления…",
  continue: "Продолжить с лёгким оформлением",
  lightweight: "Включено лёгкое оформление. Ваши настройки дополнительных эффектов сохранены.",
  failed: "Не удалось подготовить часть оформления. Лёгкое оформление остаётся доступным.",
  retry: "Повторить подготовку оформления",
} as const satisfies Record<keyof typeof en, Message>;
export const fancyStuffMessages: FeatureMessages<keyof typeof en> = { en, ru };
