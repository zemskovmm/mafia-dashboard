/* global getComputedStyle */
import assert from "node:assert/strict";
import { fileURLToPath, URL } from "node:url";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

// Isolated real-component browser fixture: no API, user session, or database writes.
const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("../", import.meta.url)),
  plugins: [
    react(),
    {
      name: "night-check-glow-fixture",
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url?.split("?")[0] !== "/") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              "/",
              '<html><head><link rel="stylesheet" href="/apps/web/src/styles/app.css"></head><body><div id="root"></div><script type="module" src="/scripts/fixtures/night-check-glow.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
  server: { host: "127.0.0.1", port: 0 },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const evidence = [];
  for (const renderer of ["legacy", "vgpu"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript((value) => {
      window.localStorage.setItem("mafia-dashboard.lighting-renderer.v1", value);
    }, renderer);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const role of ["don", "sheriff"]) {
      for (const mode of ["check", "prior", "privacy", "retired-disabled"]) {
        await page.goto(`${server.resolvedUrls.local[0]}?role=${role}&${mode}=1`);
        if (mode === "retired-disabled") {
          await page.evaluate(() =>
            window.localStorage.setItem("mafia-dashboard.player-lighting.v1", "disabled"),
          );
          await page.reload();
        }
        const shell = page.locator(".app-shell");
        await expect(shell).toHaveAttribute("data-phase", `night-${role}`);
        if (renderer === "vgpu") {
          await expect(shell).toHaveAttribute("data-vgpu-status", /^(ready|fallback)$/);
        }
        const ownerSeat = await shell.getAttribute("data-owner");
        const otherSeat = await shell.getAttribute("data-other");
        const owner = page.locator(".player-seat").filter({
          has: page.locator(".seat-number", { hasText: new RegExp(`^${ownerSeat}$`) }),
        });
        const other = page.locator(".player-seat").filter({
          has: page.locator(".seat-number", { hasText: new RegExp(`^${otherSeat}$`) }),
        });
        await expect(owner).toHaveClass(/status-eliminated/);
        await expect(owner.locator(".deceased-cross")).toHaveCount(1);
        await expect(other).toHaveCSS("opacity", "0.48");
        await expect(owner).toHaveCSS("opacity", mode === "prior" ? "0.48" : "1");
        await expect(owner).toHaveCSS("filter", mode === "prior" ? "grayscale(0.9)" : "none");
        if (mode === "prior") {
          await expect(owner).toBeDisabled();
          await expect(owner).not.toHaveClass(/is-mafia-shooter|is-sheriff-highlight/);
        } else {
          await expect(owner).toBeEnabled();
          await expect(owner).toHaveClass(
            role === "don" ? /is-mafia-shooter/ : /is-sheriff-highlight/,
          );
          const effective = await shell.getAttribute("data-lighting-renderer");
          if (effective === "vgpu") {
            await expect(owner.locator(".vgpu-player-lighting")).toHaveAttribute(
              "data-vgpu-ready",
              "true",
            );
            await expect(owner.locator(".vgpu-player-lighting")).toHaveCSS("visibility", "visible");
          } else if (role === "don") {
            await expect(owner).toHaveCSS("box-shadow", /rgba?\(/);
            const fallback = await owner.evaluate((element) => {
              const style = getComputedStyle(element, "::after");
              return {
                background: style.backgroundImage,
                inset: style.inset,
                content: style.content,
              };
            });
            assert.match(fallback.background, /gradient/);
            assert.equal(fallback.inset, "1px");
            assert.equal(fallback.content, '""');
          } else {
            await expect(owner).toHaveCSS("animation-name", "mafia-flame-pulse");
          }
          if (mode === "privacy") await expect(owner.locator(".role-badge")).toHaveCount(0);
          evidence.push({
            renderer,
            effective,
            role,
            mode,
            ...(await owner.evaluate((element) => ({
              opacity: getComputedStyle(element).opacity,
              filter: getComputedStyle(element).filter,
            }))),
          });
          // Deceased targets remain checkable; the result stage keeps its existing dimming.
          await other.click();
          await expect(shell).toHaveAttribute("data-phase", `night-${role}-result`);
          await expect(owner).toHaveCSS("opacity", "0.48");
          await expect(owner).toHaveCSS("filter", "grayscale(0.9)");
        }
        await page.evaluate(() =>
          window.localStorage.removeItem("mafia-dashboard.player-lighting.v1"),
        );
      }
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(JSON.stringify({ status: "passed", evidence }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
