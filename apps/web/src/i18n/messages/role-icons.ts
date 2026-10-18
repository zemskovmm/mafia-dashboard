import type { FeatureMessages } from "../I18nProvider.js";

const en = {
  "Role icons": "Role icons",
  "Role icons guidance": "Choose an icon for each role. Changes are saved with the profile.",
  Citizen: "Citizen",
  Mafia: "Mafia",
  Don: "Don",
  Sheriff: "Sheriff",
  "Edit role icon": "{player}: {role} icon",
  "Role icon title": "{role} icon",
  "Search icons": "Search icons",
  "Icon category": "Icon category",
  "All icons": "All icons",
  "No icons found": "No icons found. Try another search or category.",
  "Use default": "Use default",
  "Default icon": "Default icon",
  "Selected icon": "Selected icon",
  "Custom image": "Custom image",
  "Upload image": "Upload image",
  "Upload limits":
    "Static PNG, JPEG or WebP · up to 512 KiB · up to 4 million pixels. The server validates and normalizes images to fit within 256 × 256 px.",
  "Upload consent":
    "Uploads require data-processing consent. Built-in icons are available without consent.",
  "Reading image": "Reading image…",
  "Upload format error":
    "Choose a PNG, JPEG or WebP image. SVG and animated images are not supported.",
  "Upload size error": "The image must be no larger than 512 KiB.",
  "Upload pixels error": "The image must contain no more than 4 million pixels.",
  "Upload decode error": "The image could not be read. Choose another image.",
  "Use icon": "Use icon",
  Cancel: "Cancel",
  "Cancel player changes": "Cancel {player} changes",
} as const;
type Key = keyof typeof en;
export const roleIconMessages = {
  en,
  ru: {
    "Role icons": "Иконки ролей",
    "Role icons guidance":
      "Выберите иконку для каждой роли. Изменения сохраняются вместе с профилем.",
    Citizen: "Мирный",
    Mafia: "Мафия",
    Don: "Дон",
    Sheriff: "Шериф",
    "Edit role icon": "{player}: иконка роли «{role}»",
    "Role icon title": "{role}: иконка",
    "Search icons": "Поиск иконок",
    "Icon category": "Категория иконок",
    "All icons": "Все иконки",
    "No icons found": "Иконки не найдены. Измените запрос или категорию.",
    "Use default": "По умолчанию",
    "Default icon": "Иконка по умолчанию",
    "Selected icon": "Выбранная иконка",
    "Custom image": "Своё изображение",
    "Upload image": "Загрузить изображение",
    "Upload limits":
      "Статические PNG, JPEG или WebP · до 512 КиБ · до 4 миллионов пикселей. Сервер проверяет изображения и уменьшает их до размеров не более 256 × 256 пикселей.",
    "Upload consent":
      "Для загрузки нужно согласие на обработку персональных данных. Встроенные иконки доступны без согласия.",
    "Reading image": "Чтение изображения…",
    "Upload format error":
      "Выберите PNG, JPEG или WebP. SVG и анимированные изображения не поддерживаются.",
    "Upload size error": "Размер изображения не должен превышать 512 КиБ.",
    "Upload pixels error": "Изображение должно содержать не более 4 миллионов пикселей.",
    "Upload decode error": "Не удалось прочитать изображение. Выберите другое.",
    "Use icon": "Выбрать иконку",
    Cancel: "Отмена",
    "Cancel player changes": "Отменить изменения: {player}",
  },
} as const satisfies FeatureMessages<Key>;
