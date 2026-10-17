/* global document, getComputedStyle */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const evidenceDirectory = process.env.NIGHT_CHECK_GLOW_EVIDENCE_DIR;
if (evidenceDirectory) await mkdir(evidenceDirectory, { recursive: true });
const receipt = {
  status: "running",
  expectedCases: 20,
  viewport: { width: 1440, height: 1000 },
  evidence: [],
  pageErrors: [],
  screenshots: [],
  cleanup: { browserClosed: false, serverClosed: false },
};
let page;
let activeCase;
const screenshot = async (label) => {
  if (!evidenceDirectory) return;
  const path = resolve(evidenceDirectory, `${label}.png`);
  await page.screenshot({ path, fullPage: true });
  receipt.screenshots.push(path);
};

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
  receipt.origin = server.resolvedUrls.local[0];
  receipt.browser = { channel: "chrome", version: browser.version(), headless: true };
  const evidence = receipt.evidence;
  for (const renderer of ["legacy", "vgpu"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript((value) => {
      window.localStorage.setItem("mafia-dashboard.lighting-renderer.v1", value);
    }, renderer);
    page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
      receipt.pageErrors.push({ ...activeCase, message: error.message });
    });
    for (const role of ["don", "sheriff"]) {
      for (const mode of ["check", "prior", "privacy", "prior-privacy", "retired-disabled"]) {
        activeCase = { renderer, role, mode };
        const query = mode === "prior-privacy" ? "prior=1&privacy=1" : `${mode}=1`;
        await page.goto(`${server.resolvedUrls.local[0]}?role=${role}&${query}`);
        if (mode === "retired-disabled") {
          await page.evaluate(() =>
            window.localStorage.setItem("mafia-dashboard.player-lighting.v1", "disabled"),
          );
          await page.reload();
        }
        const shell = page.locator(".app-shell");
        const prior = mode.startsWith("prior");
        const expectedPhase = prior
          ? role === "don"
            ? "night-sheriff"
            : "night-resolution"
          : `night-${role}`;
        await expect(shell).toHaveAttribute("data-phase", expectedPhase);
        if (renderer === "vgpu") {
          await expect(shell).toHaveAttribute("data-vgpu-status", "ready", { timeout: 15_000 });
        }
        await expect(shell).toHaveAttribute("data-lighting-renderer", renderer);
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
        // Night is exempt from the daytime masking toggle (IDD-0003).
        if (mode.endsWith("privacy")) {
          await expect(page.locator(".role-badge:visible")).toHaveCount(10);
          await expect(owner.locator(".role-badge")).toBeVisible();
        }
        if (prior) {
          // A role eliminated before this night has no check or active-owner glow.
          await expect(owner).toHaveCSS("opacity", "0.48");
          await expect(owner).toHaveCSS("filter", "grayscale(0.9)");
          await expect(owner).not.toHaveClass(/is-mafia-shooter|is-sheriff-highlight/);
          evidence.push({ renderer, role, mode, phase: expectedPhase, checkUnavailable: true });
          if (mode === "prior") await screenshot(`${renderer}-${role}-${mode}`);
          assert.deepEqual(errors, []);
          continue;
        }
        await expect(owner).toHaveCSS("opacity", "1");
        await expect(owner).toHaveCSS("filter", "none");
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
          await expect(owner).toHaveCSS("animation-name", "liquid-state-pulse");
        }
        const checkState = {
          renderer,
          effective,
          role,
          mode,
          ...(await owner.evaluate((element) => ({
            opacity: getComputedStyle(element).opacity,
            filter: getComputedStyle(element).filter,
          }))),
          vgpuStatus: await shell.getAttribute("data-vgpu-status"),
          daytimeMaskingEnabled: mode.endsWith("privacy"),
          visibleRoleBadges: await page.locator(".role-badge:visible").count(),
          compatMode: await page.evaluate(() => document.compatMode),
        };
        if (mode === "check") await screenshot(`${renderer}-${role}-${mode}`);
        // Deceased targets remain checkable; the result stage keeps its existing dimming.
        await other.click();
        await expect(shell).toHaveAttribute("data-phase", `night-${role}-result`);
        await expect(owner).toHaveCSS("opacity", "0.48");
        await expect(owner).toHaveCSS("filter", "grayscale(0.9)");
        if (mode === "check") await screenshot(`${renderer}-${role}-${mode}-result`);
        assert.deepEqual(errors, []);
        evidence.push({ ...checkState, resultPhase: `night-${role}-result`, resultDimmed: true });
        await page.evaluate(() =>
          window.localStorage.removeItem("mafia-dashboard.player-lighting.v1"),
        );
      }
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  assert.equal(evidence.length, receipt.expectedCases);
  receipt.status = "passed";
} catch (error) {
  receipt.status = "failed";
  receipt.failure = { ...activeCase, message: error.message };
  if (page && !page.isClosed()) {
    await screenshot(`${activeCase.renderer}-${activeCase.role}-${activeCase.mode}-failure`);
    receipt.failure.observed = await page.locator(".app-shell").evaluate((element) => ({
      phase: element.getAttribute("data-phase"),
      effectiveRenderer: element.getAttribute("data-lighting-renderer"),
      vgpuStatus: element.getAttribute("data-vgpu-status"),
      roleBadges: element.querySelectorAll(".role-badge").length,
      compatMode: document.compatMode,
    }));
  }
  throw error;
} finally {
  await browser?.close();
  receipt.cleanup.browserClosed = true;
  await server.close();
  receipt.cleanup.serverClosed = true;
  receipt.completedCases = receipt.evidence.length;
  if (evidenceDirectory) {
    await writeFile(resolve(evidenceDirectory, "receipt.json"), JSON.stringify(receipt, null, 2));
  }
  console.log(JSON.stringify(receipt, null, 2));
}
