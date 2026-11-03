/* global document, window, URL, fetch */
/** Focused actual-App cases registered in ClubEntryTransition's protected Vite/API harness.
 * Run only after freezing source:
 * node --test --test-name-pattern=workspace-menu apps/web/src/features/clubs/ClubEntryTransition.browser.test.mjs
 */
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import {
  enterManageSection,
  enterDeveloperSection,
} from "../../../../../scripts/workspace-menu-paths.mjs";

export function registerWorkspaceMenuScenarios({ scenario, baseURL, clubs, picker, settled }) {
  const layouts = [
    { name: "compact", engine: "chromium", viewport: { width: 1000, height: 600 } },
    { name: "desktop", engine: "chromium", viewport: { width: 1366, height: 768 } },
    { name: "webkit", engine: "webkit", viewport: { width: 1366, height: 1024 } },
    { name: "narrow", engine: "chromium", viewport: { width: 390, height: 844 }, hasTouch: true },
  ];
  for (const locale of ["en", "ru"])
    for (const role of ["manager", "user"])
      for (const layout of layouts)
        scenario(
          `workspace-menu-${role}-${locale}-${layout.name}`,
          {
            engine: layout.engine,
            locale: locale === "ru" ? "ru-RU" : "en-US",
            reducedMotion: "reduce",
            viewport: layout.viewport,
            hasTouch: layout.hasTouch ?? false,
          },
          async ({ page, context, row, capture }) => {
            const ru = locale === "ru";
            const text = {
              menu: ru ? "Меню" : "Menu",
              dialog: ru ? "Управление" : "Manage",
              open: ru ? "Открыть меню управления" : "Open Manage menu",
              close: ru ? "Закрыть меню управления" : "Close Manage menu",
              back: ru ? "Назад" : "Back",
              club: ru ? "Настройки клуба" : "Club settings",
              players: ru ? "Экран игроков" : "Players screen",
              timeline: ru ? "Хронология прошлых игр" : "Past game timeline",
              statistics: ru ? "Статистика" : "Statistics",
              bestMove: ru ? "Включить «Лучший ход»" : "Enable Best move",
              save: ru ? "Сохранить изменения" : "Save changes",
              retry: ru ? "Повторить сохранение" : "Retry save",
              name: ru ? "Название клуба" : "Club name",
              city: ru ? "Город" : "City",
              saveClub: ru ? "Сохранить клуб" : "Save club",
              style: ru ? "Стиль карточек игроков" : "Player card style",
              placement: ru ? "Расположение роли" : "Role placement",
              help: ru ? "Показывать кнопки подсказок" : "Show tutorial help buttons",
              music: ru ? "Настройка музыкального плеера" : "Music player setup",
              reload: ru ? "Перезагрузить музыкальный плеер" : "Reload music player",
              developer: ru ? "Открыть меню разработчика" : "Open developer menu",
              hideDeveloper: ru ? "Скрыть режим разработчика" : "Hide developer mode",
            };
            let saved = { ...clubs[0], language: locale, role };
            const writes = [];
            let failSave = true;
            await context.route(`${baseURL()}/api/clubs`, async (route) => {
              const request = route.request();
              if (request.method() === "GET") return route.fulfill({ json: { clubs: [saved] } });
              assert.equal(request.method(), "POST");
              const input = request.postDataJSON();
              assert.equal(
                input.bestMoveEnabled,
                true,
                "Creation explicitly retains the enabled default",
              );
              assert.equal(input.ownerConsent, true, "Creation retains explicit Owner consent");
              writes.push({ method: "POST", input });
              saved = { ...saved, ...input, id: "00000000-0000-4000-8000-000000000303" };
              return route.fulfill({ status: 201, json: { club: saved } });
            });
            await context.route(`${baseURL()}/api/clubs/*`, async (route) => {
              const request = route.request();
              assert.equal(new URL(request.url()).pathname, `/api/clubs/${saved.id}`);
              assert.equal(request.method(), "PUT");
              const input = request.postDataJSON();
              writes.push({ method: "PUT", input });
              if (failSave) {
                failSave = false;
                return route.fulfill({
                  status: 503,
                  json: { error: "Focused fixture: retry required" },
                });
              }
              saved = { ...saved, ...input };
              return route.fulfill({ json: { club: saved } });
            });
            // Disable optional artwork, not permissions. Ordinary navigation must need no Dev unlock.
            await page.addInitScript(() =>
              window.localStorage.setItem(
                "mafia-dashboard.fancy-stuff.v1",
                JSON.stringify({ version: 2, enabled: false }),
              ),
            );
            await picker(
              page,
              ru ? "Город засыпает. Игра начинается." : "The city sleeps. The game begins.",
            );
            if (role === "manager") {
              await page.locator(".new-club-card").click();
              await expect(
                page.getByRole("checkbox", { name: text.bestMove, exact: true }),
              ).toHaveCount(0);
              await expect(page.locator('.club-editor-card input[type="file"]')).toHaveCount(2);
              await page.getByLabel(text.name, { exact: true }).fill("Grouped menu fixture");
              await page.getByLabel(text.city, { exact: true }).fill("Local fixture");
              const saveClub = page.getByRole("button", { name: text.saveClub, exact: true });
              await expect(saveClub).toBeDisabled();
              await page.locator('.club-editor-card input[type="checkbox"]').check();
              await capture("clean-creation");
              await saveClub.click();
              await page.locator(".club-card-open").first().waitFor();
              assert.equal(writes.length, 1);
            }
            await page.locator(".club-card-open").filter({ hasText: saved.name }).click();
            await settled(page);
            const activation = layout.hasTouch ? "tap" : "click";
            const open = async () =>
              page.getByRole("button", { name: text.open, exact: true })[activation]();
            const close = async () =>
              page.getByRole("button", { name: text.close, exact: true })[activation]();
            const back = async () =>
              page.getByRole("button", { name: text.back, exact: true })[activation]();
            await expect(page.locator(".dev-toolbar-button")).toHaveCount(0);
            await open();
            const dialog = page.getByRole("dialog", { name: text.dialog, exact: true });
            await expect(
              dialog.getByRole("heading", { name: text.menu, exact: true }),
            ).toBeVisible();
            const geometry = await dialog.evaluate((element) => {
              const drawer = element.getBoundingClientRect();
              const toolbar = document.querySelector(".app-fixed-toolbar").getBoundingClientRect();
              return {
                top: drawer.top,
                width: drawer.width,
                toolbarBottom: toolbar.bottom,
                viewport: window.innerWidth,
              };
            });
            assert(
              geometry.top >= geometry.toolbarBottom,
              "Drawer navigation stays below the complete wrapped toolbar",
            );
            if (geometry.viewport === 1000)
              assert.equal(
                Math.round(geometry.width),
                335,
                "Compact landscape retains the existing sidebar width",
              );
            const firstAction = dialog.locator(".workspace-menu-body button").first();
            await expect(firstAction).toHaveCount(1);
            assert.match(
              (await firstAction.innerText()).trim(),
              ru ? /^Начать новую игру$/u : /^Start (?:a )?new game$/,
            );
            await expect(dialog.getByRole("button", { name: text.club, exact: true })).toHaveCount(
              role === "manager" ? 1 : 0,
            );
            await expect(
              dialog.getByRole("button", { name: text.players, exact: true }),
            ).toHaveCount(role === "manager" ? 1 : 0);
            await capture("root");
            await enterManageSection(page, "game", locale);
            await expect(
              dialog.getByRole("button", { name: text.statistics, exact: true }),
            ).toBeVisible();
            await expect(
              dialog.getByRole("button", { name: text.timeline, exact: true }),
            ).toHaveCount(role === "manager" ? 1 : 0);
            await back();
            await enterManageSection(page, "appearance", locale);
            const style = dialog.getByRole("combobox", { name: text.style, exact: true });
            await expect(style).toBeVisible();
            // Printed-role placement is contextual: the existing Glass style has no printed role.
            await style.selectOption("classic");
            await expect(
              dialog.getByRole("combobox", { name: text.placement, exact: true }),
            ).toBeVisible();
            await expect(dialog.locator('input[type="color"]')).toHaveCount(
              role === "manager" ? 1 : 0,
            );
            await capture("ordinary-appearance");
            await close();
            await open();
            await enterManageSection(page, "help", locale);
            const tutorial = dialog.getByRole("switch", { name: text.help, exact: true });
            const original = await tutorial.getAttribute("aria-checked");
            await tutorial.click();
            await expect(tutorial).toHaveAttribute("aria-checked", String(original !== "true"));
            await tutorial.click();
            await expect(tutorial).toHaveAttribute("aria-checked", original);
            await dialog
              .getByRole("button", { name: ru ? "Правила игры" : "Rules guide", exact: true })
              .click();
            await expect(dialog).toHaveCount(0);
            const rules = page.locator("dialog.rules-sketchbook[open]");
            await expect(rules).toBeVisible();
            await rules.locator(".rs-close").click();
            await expect(rules).toHaveCount(0);
            await open();
            await enterManageSection(page, "help", locale);
            await back();
            await expect(dialog.getByRole("button", { name: text.music, exact: true })).toHaveCount(
              role === "manager" ? 1 : 0,
            );
            await close();
            if (role === "manager") {
              await open();
              await enterManageSection(page, "music", locale);
              await expect(
                page.getByRole("region", { name: text.music, exact: true }),
              ).toBeVisible();
              // This harness deliberately reports an unconfigured account. The same
              // account panel opens immediately; Reload remains connected-account-only.
              await expect(
                page.getByRole("button", { name: text.reload, exact: true }),
              ).toHaveCount(0);
              await expect(page.locator(".account-playlist-picker button[disabled]")).toBeVisible();
              await close();
              await open();
              await enterManageSection(page, "club", locale);
              const option = dialog.getByRole("switch", { name: text.bestMove, exact: true });
              await expect(option).toHaveAttribute("aria-checked", "true");
              await expect(
                dialog.getByRole("button", { name: text.save, exact: true }),
              ).toBeDisabled();
              await option.click();
              await close();
              assert.equal(writes.length, 1, "Closing an unsaved draft sends no club write");
              await open();
              await enterManageSection(page, "club", locale);
              await expect(option).toHaveAttribute("aria-checked", "true");
              await option.click();
              const sessionBefore = await page.evaluate(() =>
                window.localStorage.getItem("mafia-dashboard.game-session.v5"),
              );
              await dialog.getByRole("button", { name: text.save, exact: true }).click();
              await expect(dialog.getByRole("alert")).toBeVisible();
              await expect(option).toHaveAttribute("aria-checked", "false");
              await dialog.getByRole("button", { name: text.retry, exact: true }).click();
              await expect(dialog.getByRole("status")).toContainText(
                ru ? "Изменения сохранены" : "Changes saved",
              );
              assert.deepEqual(
                writes.slice(1).map(({ input }) => input),
                Array(2).fill({
                  name: saved.name,
                  city: saved.city,
                  language: locale,
                  headerLogo: null,
                  cardLogo: null,
                  bestMoveEnabled: false,
                }),
                "Retry uses the full club payload without changing unrelated fields",
              );
              assert.equal(
                await page.evaluate(() =>
                  window.localStorage.getItem("mafia-dashboard.game-session.v5"),
                ),
                sessionBefore,
                "Editing a club default cannot rewrite browser game recovery state",
              );
              const readback = await page.evaluate(async () => (await fetch("/api/clubs")).json());
              assert.equal(readback.clubs[0].bestMoveEnabled, false);
              await capture("best-move-settings");
              await close();
              await page.reload();
              await page.locator(".club-card-open").filter({ hasText: saved.name }).click();
              await settled(page);
              await open();
              await enterManageSection(page, "club", locale);
              await expect(option).toHaveAttribute("aria-checked", "false");
              await close();
            } else {
              assert.deepEqual(writes, [], "Ordinary user preferences issue no club write");
            }
            const privacy = page.locator(".privacy-button");
            const privacyBefore = await privacy.getAttribute("aria-pressed");
            for (let i = 0; i < 6; i++) await privacy.click();
            await expect(privacy).toHaveAttribute("aria-pressed", privacyBefore);
            if (role === "manager") {
              await page.getByRole("button", { name: text.developer, exact: true }).click();
              await enterDeveloperSection(page, "visual", locale);
              await expect(page.locator(".dev-glass-controls")).toBeVisible();
              await back();
              await enterDeveloperSection(page, "testing", locale);
              await expect(
                page.getByRole("button", {
                  name: ru ? "Показать невыданные роли" : "Show undealt role preview",
                  exact: true,
                }),
              ).toBeVisible();
              await back();
              await enterDeveloperSection(page, "diagnostics", locale);
              await expect(
                page.getByRole("button", { name: ru ? "Консоль" : "Console", exact: true }),
              ).toBeVisible();
              await capture("developer-diagnostics");
              await back();
              await page.getByRole("button", { name: text.hideDeveloper, exact: true }).click();
            }
            await expect(page.locator(".dev-toolbar-button")).toHaveCount(0);
            await expect
              .poll(() =>
                page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
              )
              .toBe(true);
            row.checks.push(
              "actual App; EN/RU grouped native paths; close/back; manager/user boundaries; ordinary preferences without Dev; direct music panel; creation default/consent; failed save/retry/full-payload readback and reload; direct Dev hide",
            );
            row.clubWrites = writes;
          },
        );
}
