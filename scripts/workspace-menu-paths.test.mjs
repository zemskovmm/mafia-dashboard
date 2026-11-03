import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";
import {
  enterDeveloperSection,
  enterManageAction,
  enterManageSection,
  workspaceMenuPath,
} from "./workspace-menu-paths.mjs";

function nativePage() {
  const calls = [];
  const page = {
    getByRole(role, { name, exact }) {
      assert.equal(exact, true);
      return {
        or() {
          return this;
        },
        click: async () => calls.push({ role, name, activation: "click" }),
        tap: async () => calls.push({ role, name, activation: "tap" }),
      };
    },
  };
  return { page, calls };
}

test("grouped Main/Developer paths are explicit in both locales", async () => {
  const expected = {
    en: {
      main: {
        game: ["Game & records"],
        club: ["Club settings"],
        details: ["Club settings", "Club details"],
        appearance: ["Preferences", "Appearance"],
        help: ["Preferences", "Help"],
        music: ["Preferences", "Music player setup"],
      },
      developer: {
        visual: ["Visual effects"],
        testing: ["Game testing"],
        diagnostics: ["Diagnostics & local data"],
      },
    },
    ru: {
      main: {
        game: ["Игра и записи"],
        club: ["Настройки клуба"],
        details: ["Настройки клуба", "Данные клуба"],
        appearance: ["Предпочтения", "Внешний вид"],
        help: ["Предпочтения", "Помощь"],
        music: ["Предпочтения", "Настройка музыкального плеера"],
      },
      developer: {
        visual: ["Визуальные эффекты"],
        testing: ["Тестирование игры"],
        diagnostics: ["Диагностика и локальные данные"],
      },
    },
  };
  for (const [locale, menus] of Object.entries(expected))
    for (const [menu, sections] of Object.entries(menus))
      for (const [section, names] of Object.entries(sections)) {
        assert.deepEqual(workspaceMenuPath(menu, section, locale), names);
        const { page, calls } = nativePage();
        const enter = menu === "main" ? enterManageSection : enterDeveloperSection;
        await enter(page, section, locale, "tap");
        assert.deepEqual(
          calls,
          names.map((name) => ({ role: "button", name, activation: "tap" })),
        );
      }
});

test("existing action helpers route records and details but leave direct roots direct", async () => {
  for (const [name, locale, path] of [
    ["Past game timeline", "en", ["Game & records"]],
    ["Статистика", "ru", ["Игра и записи"]],
    ["Edit club", "en", ["Club settings", "Club details"]],
    ["Players screen", "en", []],
    ["Экран игроков", "ru", []],
    ["Start new game", "en", []],
  ]) {
    const { page, calls } = nativePage();
    await enterManageAction(page, name, locale);
    assert.deepEqual(
      calls.map(({ name }) => name),
      path,
    );
  }
});

test("unknown paths fail closed without bypassing native permission gates", async () => {
  const { page, calls } = nativePage();
  assert.throws(() => workspaceMenuPath("main", "unknown"), /Unknown/);
  assert.throws(() => workspaceMenuPath("main", "game", "xx"), /Unknown menu locale/);
  await assert.rejects(enterManageAction(page, "Console"), /Unknown main menu destination/);
  await assert.rejects(
    enterDeveloperSection(page, "visual", "en", "dispatchEvent"),
    /Unknown native/,
  );
  assert.deepEqual(calls, []);
});

test("imported actual-App scenario helpers use grouped navigation too", async () => {
  for (const [path, pattern] of [
    [
      "../apps/web/src/features/theme/GlassScene.host-ui-scenarios.mjs",
      /enterManageAction\(page, name, locale, "tap"\)/,
    ],
    [
      "../apps/web/src/features/theme/GlassScene.background-scenarios.mjs",
      /enterManageAction\(page, name\)/,
    ],
    [
      "../apps/web/src/features/theme/GlassScene.shared-scenarios.mjs",
      /enterDeveloperSection\(page, "visual"\)/,
    ],
    ["./verify-player-card-styles-ui.mjs", /enterManageSection\(page, "appearance", locale\)/],
    ["./verify-fancy-features-ui.mjs", /enterDeveloperSection\(page, "visual"\)/],
  ])
    assert.match(await readFile(new URL(path, import.meta.url), "utf8"), pattern, path);
});
