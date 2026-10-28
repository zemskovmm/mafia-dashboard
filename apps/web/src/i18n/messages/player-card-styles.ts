import type { FeatureMessages } from "../I18nProvider.js";
import type { Message } from "./types.js";

const en = {
  section: "Player cards",
  style: "Player card style",
  glass: "Glass",
  classic: "French Classic",
  heritage: "Old-world Engraved",
  noir: "Noir Royale",
  rolePlacement: "Role placement",
  below: "Below name",
  ribbon: "Name band",
  top: "Near top",
  local: "Numbered table cards. Saved only in this browser.",
} as const satisfies Record<string, Message>;

const ru = {
  section: "Карточки игроков",
  style: "Стиль карточек игроков",
  glass: "Стекло",
  classic: "Французская классика",
  heritage: "Старинная гравюра",
  noir: "Нуар Рояль",
  rolePlacement: "Расположение роли",
  below: "Под именем",
  ribbon: "В полосе имени",
  top: "Вверху",
  local: "Нумерованные карточки на столе. Сохраняется только в этом браузере.",
} as const satisfies Record<keyof typeof en, Message>;

export const playerCardStyleMessages: FeatureMessages<keyof typeof en> = { en, ru };
