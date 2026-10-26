import type { Message } from "./types.js";

const en = {
  "best.prompt": "Select three other players",
  "best.select": "Select player {seat} for Best Move",
  "best.deselect": "Deselect player {seat} from Best Move",
  "best.selected": "Selected Best Move players",
  "best.timer": "20 seconds",
  "best.skip": "Skip Best Move",
  "best.record": "Record Best Move",
  "best.finalized": "Best Move recorded",
} as const satisfies Record<string, Message>;
const ru = {
  "best.prompt": "Выберите трёх других игроков",
  "best.select": "Выбрать игрока {seat} для лучшего хода",
  "best.deselect": "Убрать игрока {seat} из лучшего хода",
  "best.selected": "Выбранные игроки лучшего хода",
  "best.timer": "20 секунд",
  "best.skip": "Пропустить лучший ход",
  "best.record": "Записать лучший ход",
  "best.finalized": "Лучший ход записан",
} as const satisfies Record<keyof typeof en, Message>;
export const federationBestMoveMessages = { en, ru } as const;
