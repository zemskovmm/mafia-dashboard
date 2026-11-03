/** Native grouped-drawer navigation shared by actual-App browser verifiers.
 * Call after the existing toolbar opener. Never grants access, seeds preferences,
 * invokes callbacks or silently falls back to the retired flat menu.
 */
const words = {
  en: {
    game: "Game & records",
    club: "Club settings",
    details: "Club details",
    preferences: "Preferences",
    appearance: "Appearance",
    help: "Help",
    music: "Music player setup",
    visual: "Visual effects",
    testing: "Game testing",
    diagnostics: "Diagnostics & local data",
  },
  ru: {
    game: "Игра и записи",
    club: "Настройки клуба",
    details: "Данные клуба",
    preferences: "Предпочтения",
    appearance: "Внешний вид",
    help: "Помощь",
    music: "Настройка музыкального плеера",
    visual: "Визуальные эффекты",
    testing: "Тестирование игры",
    diagnostics: "Диагностика и локальные данные",
  },
};
export function workspaceMenuPath(menu, section, locale = "en") {
  const text = words[locale];
  if (!text) throw new Error(`Unknown menu locale: ${locale}`);
  const paths = {
    main: {
      game: [text.game],
      club: [text.club],
      details: [text.club, text.details],
      appearance: [text.preferences, text.appearance],
      help: [text.preferences, text.help],
      music: [text.preferences, text.music],
    },
    developer: {
      visual: [text.visual],
      testing: [text.testing],
      diagnostics: [text.diagnostics],
    },
  };
  const result = paths[menu]?.[section];
  if (!result) throw new Error(`Unknown ${menu} menu section: ${section}`);
  return result;
}
async function enter(page, menu, section, locale, activation) {
  if (!["click", "tap"].includes(activation))
    throw new Error(`Unknown native menu activation: ${activation}`);
  for (const name of workspaceMenuPath(menu, section, locale)) {
    // Club details is the sibling native toggle button, not another fly-out.
    await page.getByRole("button", { name, exact: true })[activation]();
  }
}
export const enterManageSection = (page, section, locale = "en", activation = "click") =>
  enter(page, "main", section, locale, activation);
export const enterDeveloperSection = (page, section, locale = "en", activation = "click") =>
  enter(page, "developer", section, locale, activation);
/** Existing helpers still perform the destination action themselves. */
export async function enterManageAction(page, name, locale = "en", activation = "click") {
  if (["Statistics", "Статистика", "Past game timeline", "Хронология прошлых игр"].includes(name))
    return enterManageSection(page, "game", locale, activation);
  if (["Edit club", "Изменить клуб"].includes(name))
    return enterManageSection(page, "details", locale, activation);
  if (
    [
      "Players",
      "Игроки",
      "Players screen",
      "Экран игроков",
      "Start new game",
      "Start a new game",
      "Начать новую игру",
    ].includes(name)
  )
    return;
  throw new Error(`Unknown main menu destination: ${name}`);
}
