import { expect, test } from "@playwright/test";
import { hostingAppUrl } from "../src/site-settings";

const pages = [
  { route: "", name: "home", heading: "La Verdad" },
  { route: "games/2026-08-17", name: "august", heading: "Последняя игра 17 августа 2026 года" },
  {
    route: "games/2026-09-06",
    name: "september",
    heading: "Бесшерифская игра 6 сентября 2026 года",
  },
];

test.beforeEach(async ({ context }) => {
  // Tilda and every other external service are unavailable in the local-site checks.
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.hostname === "127.0.0.1" ? route.continue() : route.abort();
  });
});

for (const entry of pages) {
  test(`${entry.name}: direct static navigation, local assets, responsive content and links`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    const remote: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (new URL(request.url()).hostname !== "127.0.0.1") remote.push(request.url());
    });
    page.on("response", (response) => {
      if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    });
    const response = await page.goto(entry.route || "./");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(entry.heading);
    if (entry.route) await expect(page).toHaveURL(new RegExp(`${entry.route}/$`));
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator("body")).toHaveCSS("-webkit-font-smoothing", "antialiased");
    for (const image of await page.locator("img").all()) {
      await image.scrollIntoViewIfNeeded();
      await expect
        .poll(() =>
          image.evaluate(
            (element) =>
              element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0,
          ),
        )
        .toBe(true);
      await image.evaluate((element) => {
        if (!(element instanceof HTMLImageElement)) throw new Error("Expected an image");
        return element.decode();
      });
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    if (entry.route) {
      await expect(page.locator(".article-panel")).toHaveCSS(
        "background-color",
        "rgba(12, 11, 10, 0.8)",
      );
      if (entry.name === "august" && page.viewportSize()!.width < 1200) {
        await expect(page.locator(".article-image")).toHaveJSProperty(
          "clientWidth",
          page.viewportSize()!.width,
        );
      }
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(await page.evaluate(() => document.fonts.check('400 42px "Poiret One"', "Мафия"))).toBe(
      true,
    );
    expect(await page.locator(".app-link").count()).toBeGreaterThan(0);
    for (const link of await page.locator(".app-link").all())
      await expect(link).toHaveAttribute("href", hostingAppUrl);
    await expect(page.getByRole("link", { name: "Icons from Tilda Publishing" })).toHaveAttribute(
      "href",
      "https://tilda.cc/",
    );
    for (const anchor of await page.locator('a[href^="#"]').all()) {
      const fragment = await anchor.getAttribute("href");
      expect(await page.locator(`[id="${fragment?.slice(1)}"]`).count()).toBe(1);
    }
    await page.screenshot({ path: testInfo.outputPath(`${entry.name}-full.png`), fullPage: true });
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(entry.heading);
    expect(errors).toEqual([]);
    expect(remote).toEqual([]);
  });
}

test("videos load only on request and the keyboard-dismissed dialog stops playback", async ({
  page,
}) => {
  // A controlled provider boundary verifies URLs/lifecycle, not third-party video playback.
  await page.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<p>Video provider test boundary</p>" }),
  );
  await page.route("https://player.vimeo.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<p>Video provider test boundary</p>" }),
  );
  await page.goto("./");
  await expect(page.locator("iframe")).toHaveCount(0);
  const tutorial = page.getByRole("link", { name: "короткое видео с правилами", exact: true });
  await tutorial.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("iframe")).toHaveAttribute("src", /youtube\.com\/embed\/hLQM89v0XZg/);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(dialog.locator("iframe")).toHaveCount(0);
  await expect(tutorial).toBeFocused();
  await tutorial.click();
  await page.getByRole("button", { name: "Закрыть видео" }).click();
  await expect(dialog.locator("iframe")).toHaveCount(0);
  await page.getByRole("link", { name: "Воспроизвести видео: как играют в мафию" }).click();
  await expect(page.locator("[data-inline-player] iframe")).toHaveAttribute(
    "src",
    /player\.vimeo\.com\/video\/1102965770/,
  );
  await expect(page.getByRole("link", { name: "Смотреть на Vimeo" })).toBeVisible();
});

test("static content and external video fallbacks survive without JavaScript; missing routes are 404", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    for (const entry of pages) {
      await page.goto(new URL(entry.route || "./", baseURL).href);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(entry.heading);
      await expect(page.locator("main")).not.toBeEmpty();
    }
    await page.goto(baseURL!);
    await expect(
      page.getByRole("link", { name: "короткое видео с правилами", exact: true }),
    ).toHaveAttribute("href", "https://www.youtube.com/watch?v=hLQM89v0XZg");
    const missing = await page.goto(new URL("does-not-exist", baseURL).href);
    expect(missing?.status()).toBe(404);
  } finally {
    await context.close();
  }
});
