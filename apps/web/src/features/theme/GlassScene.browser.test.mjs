/* global console, window, document, localStorage, getComputedStyle, Event, PageTransitionEvent, HTMLInputElement, HTMLCanvasElement, innerWidth, innerHeight, Storage, DOMException */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium, webkit } from "@playwright/test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import process from "node:process";
import {
  capturePlayerCardSources,
  verifyPlayerCards,
} from "./GlassScene.player-card-scenarios.mjs";

// Bundle the actual workspace, drawer, game and shared scene. Only API transport
// and canonical synthetic input are fixtures; no demo code or product mutation.
const root = resolve(import.meta.dirname, "../../../../..");
const evidence = resolve(
  root,
  process.env.GLASS_SCENARIO === "player-cards"
    ? `.AI/qa/player-card-production/${new Date().toISOString().replaceAll(":", "-")}`
    : ".AI/reports/app-glass",
);
assert.ok(
  !process.env.GLASS_SCENARIO || ["legacy", "player-cards"].includes(process.env.GLASS_SCENARIO),
  "Unknown GLASS_SCENARIO",
);
assert.ok(
  !process.env.GLASS_BROWSER ||
    [
      "chrome-ipad",
      "webkit-ipad",
      "webkit-landscape",
      "webkit-compact",
      "chrome-landscape",
      "chrome-compact",
    ].includes(process.env.GLASS_BROWSER),
  "Unknown GLASS_BROWSER",
);
assert.ok(
  process.env.GLASS_BROWSER !== "webkit-landscape" || process.env.GLASS_SCENARIO === "player-cards",
  "webkit-landscape is supported by GLASS_SCENARIO=player-cards only",
);
await mkdir(evidence, { recursive: true });
const temp = await mkdtemp(join(evidence, "fixture-"));
const entry = `
import React from "react";
import {createRoot} from "react-dom/client";
import {ClubWorkspace} from "./apps/web/src/App.tsx";
import {I18nProvider} from "./apps/web/src/i18n/I18nProvider.tsx";
import {GameSessionOutbox} from "./apps/web/src/session-outbox.ts";
import {withBrowserGameStorageGuard} from "./apps/web/src/browser-game-storage-lock.ts";
import {createSetup,beginRoleDraw,createSeededRandom,drawRoleForSeat,createGame,completeRoleDraw,advanceSetupPhase,nominate,completeCurrentTurn,startVoting,selectVotingCandidate,createGameLogEntry,createInitialGameBaseline} from "@mafia/game-domain";
import {beginNight} from "@mafia/game-domain";
import "./apps/web/src/styles/app.css";
import "./apps/web/src/features/theme/GlassScene.css";
const query=new URLSearchParams(location.search);
const locale=query.get("locale")==="ru"?"ru":"en";
const club={id:"00000000-0000-4000-8000-000000000101",name:"Glass regression",city:"Test",headerLogo:null,cardLogo:null,language:locale,bestMoveEnabled:true,role:"manager",createdAt:"2026-10-15T00:00:00.000Z",updatedAt:"2026-10-15T00:00:00.000Z"};
const players=Array.from({length:10},(_,i)=>({id:"00000000-0000-4000-8000-"+String(i+1).padStart(12,"0"),seat:i+1}));
let setup=beginRoleDraw(createSetup(players,query.get("edition")==="legacy"?{}:{rulesEdition:"mafgame-2026-07-01"}),createSeededRandom(13));
for(let seat=1;seat<=10;seat++)setup=drawRoleForSeat(setup,seat);
let day=createGame(completeRoleDraw(setup));
while(day.phase!=="day")day=advanceSetupPhase(day);
const plainDay=day;
day=nominate(day,1,2);day=nominate(completeCurrentTurn(day),2,3);
const phase=new URLSearchParams(location.search).get("phase");
const emptySetup=new URLSearchParams(location.search).has("empty");
const game=phase==="player-cards"?plainDay:phase==="day"?day:phase==="night"?beginNight(plainDay):selectVotingCandidate(startVoting(day),2);
const gameId="00000000-0000-4000-8000-000000000399";
const checkpoint=createGameLogEntry({gameId,id:"00000000-0000-4000-8000-000000000398",sequence:1,parentEventId:null,createdAt:"2026-10-15T00:00:00.000Z",before:game,draft:{type:"game.checkpointed",payload:{}}});
const profiles=players.map(p=>({...p,nickname:"Player "+p.seat,realName:null,consentToStoreRealName:false,createdAt:club.createdAt,updatedAt:club.createdAt}));
const host={...profiles[0],id:"00000000-0000-4000-8000-000000000011",nickname:"Host"};
if(phase==="setup")profiles.push(host);
const playerSetup=phase==="setup"?{step:"players",hostPlayerId:emptySetup?"":host.id,selectedPlayerIds:players.map(p=>emptySetup?"":p.id),rulesEdition:"mafgame-2026-07-01",setup:null}:null;
window.fetch=async(url,options={})=>{const path=new URL(url,location.origin).pathname;let body={};
if(path.includes("/players"))body={players:profiles};
else if(path.includes("/version"))body={version:"glass-regression"};
else if(phase==="setup"&&path==="/api/music/oauth/status")body={configured:true,connected:true,accountLabel:"Layout fixture"};
else if(phase==="setup"&&path==="/api/music/playlists")body={playlists:[]};
else if(path.includes("/ready"))body={ready:true};
else if(path==="/api/game-sessions")body={sessions:[]};
else if(path.includes("/game-sessions/")){
 const stored=JSON.parse(localStorage.getItem("mafia-dashboard.game-session.v5")||"null");
 const request=options.body?JSON.parse(options.body):null;
 const session={gameId,clubId:club.id,name:"Glass regression",hostName:"Host",status:"active",revision:1,appliedOperationId:request?.mutationId??null,results:null,createdAt:club.createdAt,updatedAt:club.updatedAt,state:request?.state??stored?.current?.state};
 body=options.method==="PUT"?session:{session};
}
return new Response(JSON.stringify(body),{status:200,headers:{"Content-Type":"application/json"}});};
withBrowserGameStorageGuard(async storageGuard=>{
if(!localStorage.getItem("mafia-dashboard.glass-fixture-seeded")){
 new GameSessionOutbox({storage:localStorage,storageGuard,clubId:club.id,createId:()=>crypto.randomUUID(),save:()=>Promise.resolve()}).activateRemote({gameId,clubId:club.id,name:"Glass regression",hostName:"Host",status:"active",revision:1,appliedOperationId:null,results:null,createdAt:club.createdAt,updatedAt:club.updatedAt,state:{setup:playerSetup,game:playerSetup?null:checkpoint.after,hostPlayerId:playerSetup?.hostPlayerId||null,playlistId:"",log:[],undoHistory:[],undoBudget:0,initialGame:playerSetup?null:createInitialGameBaseline(game),events:playerSetup?[]:[checkpoint.entry],headEventId:playerSetup?null:checkpoint.entry.id,resetReturnEventId:null,legacyLog:[]}});
 localStorage.setItem("mafia-dashboard.glass-fixture-seeded","yes");
 localStorage.setItem("mafia-dashboard.developer-unlocked.v1","unlocked");
 if(!playerSetup)localStorage.setItem("mafia-dashboard.developer-mode.v1","enabled");
 localStorage.setItem("mafia-dashboard.lighting-renderer.v1","legacy");
 if(new URLSearchParams(location.search).has("glass"))localStorage.setItem("mafia-dashboard.glass.v1",JSON.stringify({version:1,enabled:true,refraction:10,goldLight:25}));
}
const app=createRoot(document.getElementById("root"));
app.render(<React.StrictMode><I18nProvider locale={locale}><ClubWorkspace storageGuard={storageGuard} club={club} onExit={()=>app.unmount()} onEditClub={()=>{}} onDeleteClub={()=>Promise.resolve()}/></I18nProvider></React.StrictMode>);
await new Promise(()=>{});
});
`;
let server;
const results = [];
const sourceBefore =
  process.env.GLASS_SCENARIO === "player-cards" ? await capturePlayerCardSources(root) : null;
if (sourceBefore)
  await writeFile(join(evidence, "source-before.json"), JSON.stringify(sourceBefore, null, 2));
try {
  const bundleBinding = {};
  for (const mode of ["production", "development"]) {
    const built = await build({
      stdin: {
        contents: entry,
        loader: "tsx",
        resolveDir: root,
        sourcefile: "glass-regression.tsx",
      },
      outfile: join(temp, mode === "production" ? "fixture.js" : "strict.js"),
      bundle: true,
      metafile: process.env.GLASS_SCENARIO === "player-cards",
      format: "esm",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": JSON.stringify(mode), "import.meta.env": "{}" },
      loader: { ".svg": "dataurl", ".png": "dataurl" },
      logLevel: "silent",
    });
    if (sourceBefore) {
      const outputs = {};
      for (const path of Object.keys(built.metafile.outputs))
        outputs[path.replace(temp, "fixture-root")] = createHash("sha256")
          .update(await readFile(resolve(root, path)))
          .digest("hex");
      bundleBinding[mode] = {
        sourceDigest: sourceBefore.digest,
        outputs,
        inputs: built.metafile.inputs,
      };
    }
  }
  if (sourceBefore)
    await writeFile(join(evidence, "bundle-binding.json"), JSON.stringify(bundleBinding, null, 2));
  server = createServer(async (req, res) => {
    try {
      const path = req.url?.split("?")[0];
      if (["/fixture.js", "/fixture.css", "/strict.js", "/strict.css"].includes(path)) {
        res.setHeader("Content-Type", path.endsWith("js") ? "text/javascript" : "text/css");
        res.end(await readFile(join(temp, path.slice(1))));
      } else {
        res.setHeader("Content-Type", "text/html");
        const html =
          '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>';
        res.end(path.startsWith("/strict/") ? html.replaceAll("fixture", "strict") : html);
      }
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const config of [
    { name: "chrome-ipad", engine: chromium, viewport: { width: 1366, height: 1024 } },
    { name: "webkit-ipad", engine: webkit, viewport: { width: 1366, height: 1024 } },
    ...(process.env.GLASS_SCENARIO === "player-cards"
      ? [{ name: "webkit-landscape", engine: webkit, viewport: { width: 1366, height: 768 } }]
      : []),
    { name: "webkit-compact", engine: webkit, viewport: { width: 1000, height: 600 } },
    { name: "chrome-landscape", engine: chromium, viewport: { width: 1366, height: 768 } },
    { name: "chrome-compact", engine: chromium, viewport: { width: 1000, height: 600 } },
  ].filter((config) => !process.env.GLASS_BROWSER || config.name === process.env.GLASS_BROWSER)) {
    const browser = await config.engine.launch({
      headless: true,
      ...(config.engine === chromium ? { channel: "chrome" } : {}),
    });
    try {
      if (process.env.GLASS_SCENARIO === "player-cards") {
        await verifyPlayerCards({ browser, config, url, evidence, results });
        continue;
      }
      for (const empty of [true, false]) {
        const setupPage = await browser.newPage({
          viewport: config.viewport,
          deviceScaleFactor: 2,
          hasTouch: true,
          reducedMotion: "reduce",
        });
        const setupErrors = [];
        setupPage.on("pageerror", (error) => setupErrors.push(error.message));
        await setupPage.route("**/*", (route) =>
          route.request().url().startsWith(url) ? route.continue() : route.abort(),
        );
        await setupPage.goto(`${url}/?phase=setup${empty ? "&empty" : ""}`);
        await setupPage.locator(".player-setup-card").waitFor();
        await setupPage.locator(".music-panel-handle").waitFor();
        assert.equal(await setupPage.locator("#host-player").inputValue(), empty ? "" : "Host");
        assert.equal(
          await setupPage.locator("#seat-10-player").inputValue(),
          empty ? "" : "Player 10",
        );
        const assertPanelAlignment = async (label, inset) => {
          await setupPage.evaluate(
            () =>
              new Promise((resolve) =>
                window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)),
              ),
          );
          const geometry = await setupPage.evaluate(() => {
            const read = (selector) => {
              const el = document.querySelector(selector);
              const bounds = el.getBoundingClientRect();
              const style = getComputedStyle(el);
              return {
                top: bounds.top,
                bottom: bounds.bottom,
                height: bounds.height,
                width: bounds.width,
                contentBottom:
                  innerHeight -
                  bounds.bottom +
                  parseFloat(style.paddingBottom) +
                  parseFloat(style.borderBottomWidth),
              };
            };
            return {
              main: read(".player-setup-card, .table-workspace"),
              side: read(".live-side-panel"),
              gutter: parseFloat(
                getComputedStyle(document.querySelector(".app-shell")).getPropertyValue(
                  "--layout-gutter",
                ),
              ),
              setupPadding:
                document.querySelector(".setup-shell") &&
                getComputedStyle(document.querySelector(".setup-shell")).padding,
              viewportHeight: innerHeight,
              documentOverflow:
                document.documentElement.scrollHeight > innerHeight ||
                document.documentElement.scrollWidth > innerWidth,
            };
          });
          console.log("SETUP PANEL GEOMETRY", config.name, label, inset, JSON.stringify(geometry));
          await setupPage.screenshot({
            path: join(evidence, `${config.name}-${label}-inset-${inset}.png`),
          });
          for (const edge of ["top", "bottom", "height"])
            assert.ok(
              Math.abs(geometry.main[edge] - geometry.side[edge]) <= 1,
              `${config.name} ${label} ${edge}: ${JSON.stringify(geometry)}`,
            );
          assert.equal(geometry.documentOverflow, false);
          if (config.viewport.width >= 1160) {
            assert.equal(geometry.viewportHeight - geometry.main.bottom, geometry.gutter);
            assert.ok(geometry.main.contentBottom >= inset);
            assert.ok(geometry.side.contentBottom >= inset);
          }
          results.push({ engine: config.name, panelState: label, inset, geometry });
          return geometry;
        };
        const cdp =
          config.engine === chromium ? await setupPage.context().newCDPSession(setupPage) : null;
        for (const inset of cdp ? [0, 28] : [0]) {
          if (cdp) {
            await cdp.send("Emulation.setSafeAreaInsetsOverride", {
              insets: { top: 0, right: 0, bottom: inset, left: 0 },
            });
            await setupPage.reload();
            await setupPage.locator(".player-setup-card").waitFor();
            await setupPage.locator(".music-panel-handle").waitFor();
            await setupPage.evaluate(() =>
              document.documentElement.style.setProperty(
                "--test-safe-area-bottom",
                "env(safe-area-inset-bottom)",
              ),
            );
            await setupPage.waitForFunction(
              (inset) =>
                getComputedStyle(document.documentElement)
                  .getPropertyValue("--test-safe-area-bottom")
                  .trim() === `${inset}px`,
              inset,
            );
          }
          const label = empty ? "setup-empty" : "setup-filled";
          const collapsed = await assertPanelAlignment(label, inset);
          await setupPage.locator(".music-panel-handle").click();
          await setupPage.locator(".youtube-dock.is-expanded").waitFor();
          const expanded = await assertPanelAlignment(`${label}-expanded`, inset);
          assert.equal(expanded.main.width, collapsed.main.width);
          assert.equal(expanded.side.width, collapsed.side.width);
          await setupPage.locator(".music-panel-handle").click();
          if (cdp && inset > 0) {
            await setupPage.getByRole("button", { name: "Enter fullscreen" }).click();
            await setupPage.waitForFunction(() =>
              document.querySelector(".app-shell").classList.contains("is-fullscreen"),
            );
            await assertPanelAlignment(`${label}-fullscreen`, inset);
            await setupPage.getByRole("button", { name: "Exit fullscreen" }).click();
            await setupPage.waitForFunction(
              () => !document.querySelector(".app-shell").classList.contains("is-fullscreen"),
            );
          }
        }
        await setupPage.locator(".player-setup-actions").scrollIntoViewIfNeeded();
        const actionsVisible = await setupPage.locator(".player-setup-actions").evaluate((el) => {
          const card = el.closest(".player-setup-card");
          const actions = el.getBoundingClientRect();
          const bounds = card.getBoundingClientRect();
          return (
            actions.top >= bounds.top &&
            actions.bottom <= bounds.bottom &&
            (card.scrollHeight <= card.clientHeight || card.scrollTop > 0)
          );
        });
        assert.ok(actionsVisible, "Setup actions remain reachable by scrolling inside the card");
        if (!empty) {
          await setupPage.getByRole("button", { name: "Start game", exact: true }).click();
          await setupPage
            .locator(".table-layout-shell .role-draw-screen .table-workspace")
            .waitFor();
          await assertPanelAlignment("role-giveaway", cdp ? 28 : 0);
        }
        assert.deepEqual(setupErrors, []);
        await cdp?.detach();
        await setupPage.close();
      }
      const page = await browser.newPage({
        viewport: config.viewport,
        deviceScaleFactor: 2,
        hasTouch: true,
        reducedMotion: "reduce",
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/*", (route) =>
        route.request().url().startsWith(url) ? route.continue() : route.abort(),
      );
      await page.goto(url);
      await page
        .locator(".nomination-panel li")
        .first()
        .waitFor({ timeout: 5000 })
        .catch(async (error) => {
          await page.screenshot({ path: join(evidence, "fixture-error.png") });
          console.log("FIXTURE ERROR", errors, await page.locator("body").innerText());
          throw error;
        });
      const shell = page.locator(".app-shell");
      assert.equal(await shell.getAttribute("data-glass-status"), "off");
      assert.equal(await page.locator(".glass-scene-canvas").count(), 0);
      const panelAppearance = await page.evaluate(() => {
        const read = (selector) => {
          const el = document.querySelector(selector);
          const s = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return {
            edge: [
              s.borderTopWidth,
              s.borderTopStyle,
              s.borderTopColor,
              s.borderTopLeftRadius,
              s.borderTopRightRadius,
              s.borderBottomLeftRadius,
              s.borderBottomRightRadius,
              s.boxShadow,
            ],
            bounds: {
              left: r.left,
              right: r.right,
              top: r.top,
              bottom: r.bottom,
              height: r.height,
            },
          };
        };
        return {
          table: read(".table-workspace"),
          side: read(".live-side-panel"),
          width: innerWidth,
          height: innerHeight,
        };
      });
      console.log("PANEL BASELINE", config.name, JSON.stringify(panelAppearance));
      await page.screenshot({ path: join(evidence, `${config.name}-panel-layout.png`) });
      assert.deepEqual(panelAppearance.table.edge, panelAppearance.side.edge);
      for (const edge of ["top", "bottom", "height"])
        assert.ok(
          Math.abs(panelAppearance.table.bounds[edge] - panelAppearance.side.bounds[edge]) <= 1,
          `${config.name} live panel ${edge}`,
        );
      assert.ok(
        Math.abs(
          panelAppearance.height -
            panelAppearance.table.bounds.bottom -
            panelAppearance.table.bounds.left,
        ) <= 1,
      );
      assert.ok(
        Math.abs(
          panelAppearance.height -
            panelAppearance.side.bounds.bottom -
            (panelAppearance.width - panelAppearance.side.bounds.right),
        ) <= 1,
      );
      const assertSquareRows = async () => {
        const radii = await page
          .locator(".nomination-panel li, .nomination-row-target")
          .evaluateAll((elements) =>
            elements.flatMap((el) => {
              const s = getComputedStyle(el);
              return [
                s.borderTopLeftRadius,
                s.borderTopRightRadius,
                s.borderBottomLeftRadius,
                s.borderBottomRightRadius,
              ];
            }),
          );
        assert.ok(
          radii.length > 0 && radii.every((radius) => radius === "0px"),
          JSON.stringify(radii),
        );
        assert.ok(
          await page
            .locator(".table-stage .player-seat")
            .first()
            .evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius) > 0),
        );
      };
      await assertSquareRows();
      if (config.name === "chrome-ipad") {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Emulation.setSafeAreaInsetsOverride", {
          insets: { top: 0, right: 0, bottom: 28, left: 0 },
        });
        await page.reload();
        await page.locator(".nomination-panel li").first().waitFor();
        await page.evaluate(() =>
          document.documentElement.style.setProperty(
            "--test-safe-area-bottom",
            "env(safe-area-inset-bottom)",
          ),
        );
        await page.waitForFunction(
          () =>
            getComputedStyle(document.documentElement)
              .getPropertyValue("--test-safe-area-bottom")
              .trim() === "28px",
        );
        const insetLayout = await page.evaluate(() => {
          const table = document.querySelector(".table-workspace").getBoundingClientRect();
          const side = document.querySelector(".live-side-panel").getBoundingClientRect();
          const sideStyle = getComputedStyle(document.querySelector(".live-side-panel"));
          const tableStage = document.querySelector(".table-stage").getBoundingClientRect();
          return {
            left: table.left,
            right: innerWidth - side.right,
            tableBottom: innerHeight - table.bottom,
            sideBottom: innerHeight - side.bottom,
            sideContentBottom:
              innerHeight -
              side.bottom +
              parseFloat(sideStyle.paddingBottom) +
              parseFloat(sideStyle.borderBottomWidth),
            tableContentBottom: innerHeight - tableStage.bottom,
          };
        });
        console.log("SAFE AREA LAYOUT", JSON.stringify(insetLayout));
        await page.screenshot({ path: join(evidence, "chrome-ipad-safe-area.png") });
        assert.equal(insetLayout.tableBottom, insetLayout.left);
        assert.equal(insetLayout.sideBottom, insetLayout.right);
        assert.ok(
          insetLayout.sideContentBottom >= 28,
          "Panel content stays above the home-indicator inset",
        );
        assert.ok(
          insetLayout.tableContentBottom >= 28,
          "Table controls stay above the home-indicator inset",
        );
        await page.getByRole("button", { name: "Enter fullscreen" }).click();
        await page.waitForFunction(() =>
          document.querySelector(".app-shell").classList.contains("is-fullscreen"),
        );
        const fullscreenGutters = await page
          .locator(".table-workspace, .live-side-panel")
          .evaluateAll((elements) =>
            elements.map((el) => innerHeight - el.getBoundingClientRect().bottom),
          );
        assert.deepEqual(fullscreenGutters, [14, 14]);
        await page.screenshot({ path: join(evidence, "chrome-ipad-safe-area-fullscreen.png") });
        await page.getByRole("button", { name: "Exit fullscreen" }).click();
        await page.waitForFunction(
          () => !document.querySelector(".app-shell").classList.contains("is-fullscreen"),
        );
        results.push({ engine: config.name, insetLayout, fullscreenGutters });
        await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: {} });
        await page.reload();
        await page.locator(".nomination-panel li").first().waitFor();
        await page.evaluate(() =>
          document.documentElement.style.setProperty(
            "--test-safe-area-bottom",
            "env(safe-area-inset-bottom)",
          ),
        );
        await page.waitForFunction(
          () =>
            getComputedStyle(document.documentElement)
              .getPropertyValue("--test-safe-area-bottom")
              .trim() === "0px",
        );
        await page.evaluate(() =>
          document.documentElement.style.removeProperty("--test-safe-area-bottom"),
        );
        await cdp.detach();
      }
      const baseline = await page.evaluate(() =>
        localStorage.getItem("mafia-dashboard.game-session.v5"),
      );
      await page
        .getByRole("button", { name: "Open developer menu" })
        .click({ timeout: 3000 })
        .catch(async (error) => {
          console.log(
            "DRAWER ERROR",
            errors,
            await page.locator("body").innerText(),
            await page.evaluate(() => Object.entries(localStorage)),
          );
          throw error;
        });
      assert.equal(await page.locator(".dev-glass-controls").getAttribute("open"), null);
      await page.locator(".dev-glass-controls > summary").click();
      const range = (label) => page.getByLabel(label, { exact: true });
      const setRange = async (label, value) => {
        const previous = await range(label).inputValue();
        const surface = page.locator(".glass-scene-canvas");
        const before =
          (await surface.count()) > 0 ? await surface.getAttribute("data-glass-draws") : null;
        await range(label).evaluate((el, val) => {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
          setter.call(el, String(val));
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }, value);
        if (label === "Gold background light") {
          await page.waitForFunction(
            (value) =>
              document.querySelector(".app-shell")?.style.getPropertyValue("--glass-gold-light") ===
              String(value / 100),
            value,
          );
        }
        if (
          before !== null &&
          previous !== String(value) &&
          (await shell.getAttribute("data-glass-status")) === "ready"
        ) {
          await page.waitForFunction(
            (before) =>
              Number(document.querySelector(".glass-scene-canvas")?.dataset.glassDraws) >
              Number(before),
            before,
          );
        }
      };
      assert.equal(await range("Refraction strength").isDisabled(), true);
      assert.equal(await range("Gold background light").inputValue(), "25");
      await page.getByRole("button", { name: "Enable enhanced glass" }).click();
      await page.waitForFunction(
        () => document.querySelector(".app-shell")?.dataset.glassStatus === "ready",
      );
      assert.equal(await range("Refraction strength").isDisabled(), false);
      await assertSquareRows();
      assert.equal(
        await page.locator(".glass-scene-canvas").evaluate((canvas) => {
          const gl = canvas.getContext("webgl");
          const program = gl.getParameter(gl.CURRENT_PROGRAM);
          // The last lens drawn is a nomination row: inspect the actual GPU uniform.
          return gl.getUniform(program, gl.getUniformLocation(program, "u_radius"));
        }),
        0,
      );
      assert.equal(await page.locator(".table-stage .liquid-card-glass").count(), 0);
      assert.equal(await page.locator(".nomination-panel .vgpu-player-lighting").count(), 0);
      assert.equal(
        await page.locator(".glass-scene-canvas").getAttribute("data-glass-surfaces"),
        "12",
      );
      const save = async (key) =>
        page.evaluate((key) => {
          const c = document.querySelector(".glass-scene-canvas");
          const gl = c.getContext("webgl");
          const pixels = new Uint8Array(c.width * c.height * 4);
          gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          window[key] = pixels;
        }, key);
      const compare = async (key) =>
        page.evaluate((key) => {
          const c = document.querySelector(".glass-scene-canvas");
          const gl = c.getContext("webgl");
          const now = new Uint8Array(c.width * c.height * 4);
          gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, now);
          const old = window[key];
          const dpr = c.width / innerWidth;
          const count = (r) => {
            let diff = 0;
            for (
              let y = Math.max(0, Math.ceil(r.y * dpr));
              y < Math.min(c.height, Math.floor((r.y + r.height) * dpr));
              y++
            )
              for (
                let x = Math.max(0, Math.ceil(r.x * dpr));
                x < Math.min(c.width, Math.floor((r.x + r.width) * dpr));
                x++
              ) {
                const i = ((c.height - 1 - y) * c.width + x) * 4;
                if (
                  Math.abs(now[i] - old[i]) +
                    Math.abs(now[i + 1] - old[i + 1]) +
                    Math.abs(now[i + 2] - old[i + 2]) >
                  3
                )
                  diff++;
              }
            return diff;
          };
          return {
            surfaces: [
              ...document.querySelectorAll(
                ".table-stage .table-card.player-seat,.nomination-panel li",
              ),
            ].map((el) => count(el.getBoundingClientRect())),
            outside: count({ x: 2, y: innerHeight - 40, width: 30, height: 30 }),
          };
        }, key);
      await setRange("Refraction strength", 0);
      await save("glassZero");
      await setRange("Refraction strength", 10);
      const normal = await compare("glassZero");
      assert.ok(
        normal.surfaces.every((n) => n > 10),
        JSON.stringify(normal),
      );
      assert.equal(normal.outside, 0);
      await save("glassDefault");
      await setRange("Refraction strength", 24);
      const maximum = await compare("glassDefault");
      assert.ok(
        maximum.surfaces.every((n) => n > 10),
        JSON.stringify(maximum),
      );
      assert.equal(maximum.outside, 0);
      await setRange("Gold background light", 0);
      await save("goldZero");
      await setRange("Gold background light", 100);
      const gold = await compare("goldZero");
      assert.ok(
        gold.surfaces.every((n) => n > 10),
        JSON.stringify(gold),
      );
      assert.ok(gold.outside > 0);
      assert.equal(
        await page.evaluate(() => localStorage.getItem("mafia-dashboard.game-session.v5")),
        baseline,
      );
      await page.screenshot({ path: join(evidence, `${config.name}-controls.png`) });
      await page.getByRole("button", { name: "Close developer menu" }).click();
      await page.screenshot({ path: join(evidence, `${config.name}-maximum.png`) });
      await assertSquareRows();
      // The semantic row target covers name, count and both edges; real taps switch
      // the canonical ballot, and keyboard works without changing cast votes.
      for (const target of ["left", "name", "count", "right"]) {
        const row = page.locator(".nomination-panel li").nth(1);
        const box = await row.boundingBox();
        assert.ok(box.height >= 48);
        const x =
          target === "left"
            ? box.x + 3
            : target === "right"
              ? box.x + box.width - 3
              : target === "count"
                ? box.x + box.width - 18
                : box.x + box.width * 0.4;
        await page.touchscreen.tap(x, box.y + box.height / 2);
        assert.equal(await row.locator("button").getAttribute("aria-pressed"), "true");
        await page.locator(".nomination-panel li").first().locator("button").focus();
        await page.keyboard.press("Enter");
        await assertSquareRows();
        assert.equal(
          await page
            .locator(".nomination-panel li")
            .first()
            .locator("button")
            .getAttribute("aria-pressed"),
          "true",
        );
      }
      const voter = page.locator('.seat-anchor[data-seat="1"] > .player-seat');
      await page.emulateMedia({ reducedMotion: "no-preference" });
      // The last-candidate fill has already voted this card. First reassign, then
      // clear it, so the measured next tap actually changes its scale/opacity.
      await voter.tap();
      await voter.tap();
      await page.waitForTimeout(320);
      assert.ok(!(await voter.getAttribute("class")).includes("is-voted"));
      const transitionStart = Number(
        await page.locator(".glass-scene-canvas").getAttribute("data-glass-draws"),
      );
      await voter.tap();
      assert.ok((await voter.getAttribute("class")).includes("is-voted"));
      // Current-candidate voters retain active emphasis; switching candidates
      // exercises the existing shrink/fade transition for other-candidate voters.
      assert.ok((await voter.getAttribute("class")).includes("is-current"));
      await page.locator(".nomination-panel li").nth(1).locator("button").click();
      await page.waitForTimeout(320);
      const voted = await voter.evaluate((el) => ({
        opacity: Number(getComputedStyle(el).opacity),
        scale: getComputedStyle(el).scale,
      }));
      assert.equal(voted.opacity, 0.55);
      assert.equal(voted.scale, "0.88");
      const transitionDraws =
        Number(await page.locator(".glass-scene-canvas").getAttribute("data-glass-draws")) -
        transitionStart;
      assert.ok(
        transitionDraws > 1,
        "Optical geometry must follow the actual shrink/fade transition",
      );
      await page.locator(".nomination-panel li").nth(1).locator("button").click();
      assert.equal(
        await page.locator(".nomination-panel li").first().locator(".nomination-total").innerText(),
        "1",
      );
      // Selecting the final candidate already filled the nine remaining voters,
      // as the existing ballot contract requires. Reassigning seat 1 makes ten.
      await voter.tap();
      assert.equal(
        await page.locator(".nomination-panel li").nth(1).locator(".nomination-total").innerText(),
        "10",
      );
      await voter.tap();
      assert.ok(!(await voter.getAttribute("class")).includes("is-voted"));
      assert.equal(
        await page.locator(".nomination-panel li").nth(1).locator(".nomination-total").innerText(),
        "9",
      );
      await page.locator(".nomination-panel li").first().locator("button").click();
      await page.emulateMedia({ reducedMotion: "reduce" });
      // A bounded layout seam makes the real nominee list scrollable so this
      // fixture proves scroll remeasurement/clipping, not just a no-op event.
      const list = page.locator(".nomination-panel ol");
      const beforeScroll = await page.locator(".nomination-panel li").first().boundingBox();
      await list.evaluate((el) => {
        el.style.maxHeight = "55px";
        el.style.overflowY = "auto";
      });
      await list.evaluate((el) => {
        el.scrollTop = 30;
      });
      await page.waitForFunction(
        () => document.querySelector(".nomination-panel ol").scrollTop === 30,
      );
      await page.waitForTimeout(100);
      const afterScroll = await page.locator(".nomination-panel li").first().boundingBox();
      assert.ok(afterScroll.y < beforeScroll.y);
      await list.evaluate((el) => {
        el.scrollTop = 0;
        el.style.removeProperty("max-height");
        el.style.removeProperty("overflow-y");
        el.dispatchEvent(new Event("scroll"));
      });
      await page.waitForTimeout(100);
      const canvas = page.locator(".glass-scene-canvas");
      await page.waitForTimeout(1200);
      const idle = await canvas.getAttribute("data-glass-draws");
      await page.waitForTimeout(350);
      assert.equal(await canvas.getAttribute("data-glass-draws"), idle);
      await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent("pageshow"));
      });
      await page.waitForTimeout(80);
      assert.ok(Number(await canvas.getAttribute("data-glass-draws")) > Number(idle));
      const hiddenDraws = await canvas.getAttribute("data-glass-draws");
      await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { value: true, configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("resize"));
      });
      await page.waitForTimeout(150);
      assert.equal(await canvas.getAttribute("data-glass-draws"), hiddenDraws);
      await page.evaluate(() => {
        delete document.hidden;
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.waitForTimeout(80);
      assert.ok(Number(await canvas.getAttribute("data-glass-draws")) > Number(hiddenDraws));
      await page.setViewportSize({ width: config.viewport.height, height: config.viewport.width });
      await page.waitForTimeout(150);
      await page.setViewportSize(config.viewport);
      await page.waitForTimeout(150);
      assert.equal(await canvas.getAttribute("data-glass-surfaces"), "12");
      await page.evaluate(() => {
        window.glassContextLoss = document
          .querySelector(".glass-scene-canvas")
          .getContext("webgl")
          .getExtension("WEBGL_lose_context");
        window.glassContextLoss.loseContext();
      });
      await page.waitForFunction(
        () => document.querySelector(".app-shell")?.dataset.glassStatus === "context-lost",
      );
      assert.equal(await page.locator(".table-stage .liquid-card-glass").count(), 10);
      await page.evaluate(() => window.glassContextLoss.restoreContext());
      await page.waitForFunction(
        () => document.querySelector(".app-shell")?.dataset.glassStatus === "ready",
      );
      await page.getByRole("button", { name: "Open developer menu" }).click();
      await page.locator(".dev-glass-controls > summary").click();
      await page.getByRole("button", { name: "Hide developer mode" }).click();
      assert.equal(await shell.getAttribute("data-glass-status"), "ready");
      await page.reload();
      await page.waitForFunction(
        () => document.querySelector(".app-shell")?.dataset.glassStatus === "ready",
      );
      assert.equal(await page.getByRole("button", { name: "Open developer menu" }).count(), 0);
      await page.evaluate(() => {
        localStorage.setItem("mafia-dashboard.developer-unlocked.v1", "unlocked");
        localStorage.setItem("mafia-dashboard.developer-mode.v1", "enabled");
      });
      await page.reload();
      await page.getByRole("button", { name: "Open developer menu" }).click();
      await page.locator(".dev-glass-controls > summary").click();
      assert.equal(await range("Gold background light").inputValue(), "100");
      assert.equal(await range("Refraction strength").inputValue(), "24");
      // Root theme changes (outside the canvas's workspace subtree) must redraw.
      await save("beforeTheme");
      const themeDraws = await canvas.getAttribute("data-glass-draws");
      await page.evaluate(() =>
        document.documentElement.style.setProperty("--theme-base", "#6688cc"),
      );
      await page.waitForFunction(
        (before) =>
          Number(document.querySelector(".glass-scene-canvas")?.dataset.glassDraws) >
          Number(before),
        themeDraws,
      );
      const theme = await compare("beforeTheme");
      assert.ok(
        theme.surfaces.every((n) => n > 10),
        JSON.stringify({ engine: config.name, theme }),
      );
      await page.evaluate(() => document.documentElement.style.removeProperty("--theme-base"));
      const shades = [];
      for (let i = 0; i < 4; i++) {
        await page
          .locator(".dev-menu-actions button")
          .filter({ hasText: /Use .*background/ })
          .click();
        await page.waitForTimeout(80);
        shades.push(await shell.getAttribute("data-background-shade"));
      }
      assert.deepEqual(shades, ["grey-33", "grey-66", "white", "black"]);
      await setRange("Refraction strength", 10);
      await setRange("Gold background light", 25);
      await page.getByRole("button", { name: "Close developer menu" }).click();
      await page.screenshot({ path: join(evidence, `${config.name}-game.png`) });
      await page.getByRole("button", { name: "Open developer menu" }).click();
      await page.locator(".dev-glass-controls > summary").click();
      await page.evaluate(() => {
        window.releasedGlass = document.querySelector(".glass-scene-canvas").getContext("webgl");
      });
      await page.getByRole("button", { name: "Reset glass settings" }).click();
      assert.equal(await shell.getAttribute("data-glass-status"), "off");
      assert.equal(await canvas.count(), 0);
      assert.equal(await range("Gold background light").inputValue(), "25");
      assert.equal(await range("Refraction strength").inputValue(), "10");
      assert.equal(await page.evaluate(() => window.releasedGlass.isContextLost()), true);
      await setRange("Gold background light", 0);
      await page.waitForFunction(
        () => getComputedStyle(document.querySelector(".app-shell"), "::before").opacity === "0",
      );
      const fallbackZero = await shell.evaluate((el) => getComputedStyle(el, "::before").opacity);
      await setRange("Gold background light", 100);
      await page.waitForFunction(
        () => getComputedStyle(document.querySelector(".app-shell"), "::before").opacity === "1",
      );
      const fallbackFull = await shell.evaluate((el) => getComputedStyle(el, "::before").opacity);
      assert.equal(fallbackZero, "0");
      assert.equal(fallbackFull, "1");
      const washStack = await page.locator(".live-side-panel").evaluate((el) => ({
        isolation: getComputedStyle(el).isolation,
        wash: getComputedStyle(el, "::after").zIndex,
      }));
      assert.deepEqual(washStack, { isolation: "isolate", wash: "-1" });
      const savedGold = await page.evaluate(
        () => JSON.parse(localStorage.getItem("mafia-dashboard.glass.v1")).goldLight,
      );
      await page.evaluate(() => {
        const setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key === "mafia-dashboard.glass.v1") throw new DOMException("Denied", "SecurityError");
          return setItem.call(this, key, value);
        };
      });
      await setRange("Gold background light", 50);
      assert.equal(await range("Gold background light").inputValue(), "50");
      assert.equal(
        await page.evaluate(
          () => JSON.parse(localStorage.getItem("mafia-dashboard.glass.v1")).goldLight,
        ),
        savedGold,
      );
      assert.deepEqual(errors, []);
      results.push({
        engine: config.name,
        normal,
        panelAppearance,
        squareRows: "fallback, enhanced GPU radius, selected and keyboard focus",
        maximum,
        gold,
        theme,
        shades,
        voted,
        transitionDraws,
        idleDraws: Number(idle),
        errors,
      });
      for (const phase of ["day", "night"]) {
        const phasePage = await browser.newPage({
          viewport: config.viewport,
          hasTouch: true,
          reducedMotion: "reduce",
        });
        const phaseErrors = [];
        phasePage.on("pageerror", (e) => phaseErrors.push(e.message));
        await phasePage.route("**/*", (route) =>
          route.request().url().startsWith(url) ? route.continue() : route.abort(),
        );
        await phasePage.goto(url + `/?phase=${phase}&glass`);
        await phasePage
          .waitForFunction(
            () => document.querySelector(".app-shell")?.dataset.glassStatus === "ready",
            null,
            { timeout: 5000 },
          )
          .catch(async (e) => {
            console.log(
              "PHASE ERROR",
              config.name,
              phase,
              phaseErrors,
              await phasePage.locator("body").innerText(),
            );
            throw e;
          });
        const phaseShell = phasePage.locator(".game-shell");
        assert.ok((await phaseShell.getAttribute("class")).includes(`is-table-cycle-${phase}`));
        const glowing = phasePage
          .locator(phase === "day" ? ".player-seat.is-current" : ".player-seat.is-mafia-shooter")
          .first();
        await glowing.waitFor();
        const readGlow = () =>
          glowing.evaluate((el) => ({
            border: getComputedStyle(el).borderColor,
            shadow: getComputedStyle(el).boxShadow,
            animation: getComputedStyle(el).animationName,
          }));
        const glow = await readGlow();
        assert.notEqual(glow.shadow, "none");
        await phasePage.getByRole("button", { name: "Open developer menu" }).click();
        await phasePage.locator(".dev-glass-controls > summary").click();
        await phasePage.getByLabel("Gold background light", { exact: true }).evaluate((el) => {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
          setter.call(el, "0");
          el.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await phasePage.waitForTimeout(80);
        assert.deepEqual(await readGlow(), glow);
        await phasePage.getByRole("button", { name: "Close developer menu" }).click();
        await phasePage.screenshot({
          path: join(evidence, `${config.name}-${phase}-gold-zero.png`),
        });
        await phasePage.getByRole("button", { name: "Hide private info" }).click();
        // Existing privacy suppression is day-only; night judge roles stay visible.
        assert.equal(await phasePage.locator(".role-badge").count(), phase === "day" ? 0 : 10);
        await phasePage.getByRole("button", { name: "Show private info" }).click();
        await phasePage.getByRole("button", { name: "Open developer menu" }).click();
        await phasePage.locator(".dev-glass-controls > summary").click();
        await phasePage.getByRole("button", { name: "Enable Raytracing" }).click();
        await phasePage.waitForFunction(
          () => document.querySelector(".app-shell")?.dataset.lightingRenderer === "vgpu",
        );
        await glowing
          .locator('.vgpu-player-lighting[data-vgpu-ready="true"]')
          .waitFor({ state: "attached" });
        assert.equal(
          await phasePage.locator(".app-shell").getAttribute("data-glass-status"),
          "ready",
        );
        await phasePage.getByRole("button", { name: "Disable enhanced glass" }).click();
        assert.equal(
          await phasePage.locator(".app-shell").getAttribute("data-lighting-renderer"),
          "vgpu",
        );
        await phasePage.getByRole("button", { name: "Enable enhanced glass" }).click();
        await phasePage.waitForFunction(
          () => document.querySelector(".app-shell")?.dataset.glassStatus === "ready",
        );
        if (config.engine === chromium) {
          const cdp = await phasePage.context().newCDPSession(phasePage);
          await cdp.send("Emulation.setEmulatedMedia", {
            features: [
              { name: "prefers-reduced-transparency", value: "reduce" },
              { name: "prefers-reduced-motion", value: "reduce" },
            ],
          });
          await phasePage.waitForFunction(
            () =>
              document.querySelector(".app-shell")?.dataset.glassStatus === "reduced-transparency",
          );
          assert.equal(
            await phasePage.getByLabel("Refraction strength", { exact: true }).isDisabled(),
            true,
          );
          const material = await phasePage
            .locator(".liquid-card-glass")
            .first()
            .evaluate((el) => ({
              background: getComputedStyle(el).backgroundColor,
              filter: getComputedStyle(el).backdropFilter,
            }));
          assert.equal(material.filter, "none");
          await cdp.send("Emulation.setEmulatedMedia", { features: [] });
          await phasePage.waitForFunction(
            () => document.querySelector(".app-shell")?.dataset.glassStatus === "ready",
          );
        }
        await phasePage.getByRole("button", { name: "Close developer menu" }).click();
        await phasePage.evaluate(() => {
          window.exitedGlass = document.querySelector(".glass-scene-canvas").getContext("webgl");
        });
        await phasePage.getByRole("button", { name: /Choose another club/ }).click();
        assert.equal(await phasePage.locator(".glass-scene-canvas").count(), 0);
        assert.equal(await phasePage.evaluate(() => window.exitedGlass.isContextLost()), true);
        assert.deepEqual(phaseErrors, []);
        results.push({
          engine: config.name,
          phase,
          glow,
          vgpu: "preserved",
          exitResources: "released",
          reducedTransparency:
            config.engine === chromium ? "actual CSS/media emulation" : "not in this engine",
          errors: phaseErrors,
        });
        await phasePage.close();
      }
      const failed = await browser.newPage({ viewport: config.viewport });
      await failed.addInitScript(() => {
        const get = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
          return kind === "webgl" ? null : get.call(this, kind, ...args);
        };
      });
      await failed.route("**/*", (route) =>
        route.request().url().startsWith(url) ? route.continue() : route.abort(),
      );
      await failed.goto(url + "/?glass");
      await failed.waitForFunction(
        () => document.querySelector(".app-shell")?.dataset.glassStatus === "unavailable",
      );
      assert.equal(await failed.locator(".liquid-card-glass").count(), 10);
      await failed.getByRole("button", { name: "Open developer menu" }).click();
      await failed.locator(".dev-glass-controls > summary").click();
      assert.equal(
        await failed.getByLabel("Refraction strength", { exact: true }).isDisabled(),
        true,
      );
      results.push({
        engine: config.name,
        webglAllocationFailure: "readable fallback, disabled optics",
      });
      await failed.close();
      const strict = await browser.newPage({ viewport: config.viewport });
      const strictErrors = [];
      await strict.addInitScript(() => {
        const getContext = HTMLCanvasElement.prototype.getContext;
        window.strictGlassAttempts = 0;
        HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
          if (kind === "webgl" && this.classList.contains("glass-scene-canvas"))
            window.strictGlassAttempts++;
          return getContext.call(this, kind, ...args);
        };
      });
      strict.on("pageerror", (error) => strictErrors.push(error.message));
      await strict.route("**/*", (route) =>
        route.request().url().startsWith(url) ? route.continue() : route.abort(),
      );
      await strict.goto(url + "/strict/?glass");
      await strict.waitForFunction(
        () => document.querySelector(".app-shell")?.dataset.glassStatus === "ready",
      );
      assert.equal(
        await strict.locator(".glass-scene-canvas").getAttribute("data-glass-surfaces"),
        "12",
      );
      assert.equal(await strict.locator(".liquid-card-glass").count(), 0);
      const attempts = await strict.evaluate(() => window.strictGlassAttempts);
      assert.ok(attempts >= 2);
      assert.deepEqual(strictErrors, []);
      results.push({
        engine: config.name,
        developmentStrictMode: "real effect replay passed",
        attempts,
        errors: strictErrors,
      });
      await strict.close();
    } finally {
      await browser.close();
    }
  }
  console.log(JSON.stringify(results, null, 2));
  if (process.env.GLASS_SCENARIO === "player-cards")
    assert.equal(
      results.filter((result) => result.status === "failed").length,
      0,
      "Player-card regression failures; see retained per-case evidence",
    );
} finally {
  if (sourceBefore) {
    const after = await capturePlayerCardSources(root);
    const changed = [
      ...new Set([...Object.keys(sourceBefore.files), ...Object.keys(after.files)]),
    ].filter((path) => sourceBefore.files[path] !== after.files[path]);
    await writeFile(join(evidence, "source-after.json"), JSON.stringify(after, null, 2));
    await writeFile(
      join(evidence, "source-binding.json"),
      JSON.stringify(
        {
          before: sourceBefore.digest,
          after: after.digest,
          finalTreeMatches: changed.length === 0,
          changed,
        },
        null,
        2,
      ),
    );
    console.log(
      "PLAYER CARD SOURCE BINDING",
      JSON.stringify({ evidence, before: sourceBefore.digest, after: after.digest, changed }),
    );
  }
  await writeFile(
    join(evidence, "browser-results.json"),
    JSON.stringify(
      {
        scope: "Actual application workspace with isolated synthetic canonical game/API transport",
        physicalIpadStandalone: "not verified",
        results,
      },
      null,
      2,
    ),
  );
  await new Promise((done) => server?.close(done) ?? done());
  await rm(temp, { recursive: true, force: true });
}
