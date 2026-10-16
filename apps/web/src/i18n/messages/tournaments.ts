import type { FeatureMessages } from "../I18nProvider.js";
import type { Message } from "./types.js";

const en = {
  include: "Include in tournament",
  tournament: "Tournament",
  choose: "Choose a tournament",
  selected: "Selected tournament (unavailable in this list)",
  new: "New tournament…",
  name: "Tournament name",
  create: "Create tournament",
  creating: "Creating…",
  cancel: "Cancel",
  loading: "Loading tournaments…",
  retry: "Retry",
  loadError: "Unable to load tournaments.",
  createError: "Unable to create tournament. Check the name and retry.",
  chooseHelp: "Choose or create a tournament to continue, or turn this option off.",
  nameHelp: "Name only, up to 100 characters. An existing name selects that club tournament.",
  none: "No tournament",
} as const satisfies Record<string, Message>;
const ru = {
  include: "Включить в турнир",
  tournament: "Турнир",
  choose: "Выберите турнир",
  selected: "Выбранный турнир (недоступен в списке)",
  new: "Новый турнир…",
  name: "Название турнира",
  create: "Создать турнир",
  creating: "Создание…",
  cancel: "Отмена",
  loading: "Загрузка турниров…",
  retry: "Повторить",
  loadError: "Не удалось загрузить турниры.",
  createError: "Не удалось создать турнир. Проверьте название и повторите попытку.",
  chooseHelp: "Выберите или создайте турнир, чтобы продолжить, либо выключите эту опцию.",
  nameHelp: "Только название, до 100 символов. Существующее название выбирает этот турнир клуба.",
  none: "Без турнира",
} as const satisfies Record<keyof typeof en, Message>;
export const tournamentMessages: FeatureMessages<keyof typeof en> = { en, ru };
