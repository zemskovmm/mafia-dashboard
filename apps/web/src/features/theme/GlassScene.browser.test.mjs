/* global console, window, document, localStorage, getComputedStyle, Event, PageTransitionEvent, HTMLInputElement, HTMLCanvasElement, innerWidth, innerHeight, Storage, DOMException, URL */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium, webkit } from "@playwright/test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import process from "node:process";
import { verifySharedPlayerGlass } from "./GlassScene.shared-scenarios.mjs";
import { verifyHostUi } from "./GlassScene.host-ui-scenarios.mjs";
import { verifyTabletUi } from "./TabletUi.browser-scenarios.mjs";
import {
  verifyPortraitCards,
  verifyPortraitNightLayout,
} from "./PortraitCards.browser-scenarios.mjs";
import {
  capturePlayerCardSources,
  verifyPlayerCards,
} from "./GlassScene.player-card-scenarios.mjs";

// Bundle the actual workspace, drawer, game and shared scene. Only API transport
// and canonical synthetic input are fixtures; no demo code or product mutation.
const root = resolve(import.meta.dirname, "../../../../..");
const followupPhase = process.env.UI_FOLLOWUP_PHASE;
assert.ok(
  followupPhase === undefined || ["04", "05", "06", "07", "08", "12", "13"].includes(followupPhase),
  "Unknown or empty UI_FOLLOWUP_PHASE",
);
assert.ok(
  process.env.UI_FOLLOWUP_ENGINE === undefined ||
    ["chromium", "webkit"].includes(process.env.UI_FOLLOWUP_ENGINE),
);
const evidence = resolve(
  root,
  followupPhase
    ? `.AI/reports/review-followup-2026-10-16/${process.env.UI_FOLLOWUP_RUN ?? `ui-${followupPhase}-${Date.now()}`}`
    : ["player-cards", "portrait-cards"].includes(process.env.GLASS_SCENARIO)
      ? `.AI/qa/player-card-production/${new Date().toISOString().replaceAll(":", "-")}`
      : `.AI/qa/app-glass/${new Date().toISOString().replaceAll(":", "-")}`,
);
assert.ok(
  process.env.GLASS_SCENARIO === undefined ||
    ["shared", "legacy", "player-cards", "portrait-cards", "host-ui", "tablet-ui"].includes(
      process.env.GLASS_SCENARIO,
    ),
  "Unknown GLASS_SCENARIO",
);
assert.ok(
  process.env.GLASS_BROWSER === undefined ||
    [
      "chrome-ipad",
      "chrome-browser-chrome",
      "webkit-ipad",
      "webkit-landscape",
      "webkit-compact",
      "chrome-landscape",
      "chrome-compact",
      "chrome-phone",
      "chrome-tablet",
      "chrome-s6-portrait",
      "chrome-s6-landscape",
      "webkit-phone",
      "webkit-tablet",
    ].includes(process.env.GLASS_BROWSER),
  "Unknown GLASS_BROWSER",
);
assert.ok(
  process.env.GLASS_BROWSER !== "webkit-landscape" ||
    ["player-cards", "portrait-cards"].includes(process.env.GLASS_SCENARIO) ||
    followupPhase,
  "webkit-landscape requires player-cards or UI_FOLLOWUP_PHASE",
);
if (["12", "13"].includes(followupPhase)) {
  assert.ok(
    process.env.GLASS_BROWSER === undefined ||
      ["chrome-landscape", "chrome-compact", "webkit-ipad"].includes(process.env.GLASS_BROWSER),
    "Native interaction requires a supported layout, not an empty matrix",
  );
}
await mkdir(evidence, { recursive: true });
const temp = await mkdtemp(join(evidence, "fixture-"));
const entry = `
import React from "react";
import {createRoot} from "react-dom/client";
import { ClubWorkspace } from "./apps/web/src/App.tsx";
import { DEFAULT_FANCY_STUFF_SETTINGS } from "./apps/web/src/features/effects/fancy-stuff-preferences.ts";
import {I18nProvider} from "./apps/web/src/i18n/I18nProvider.tsx";
import {GameSessionOutbox} from "./apps/web/src/session-outbox.ts";
import {withBrowserGameStorageGuard} from "./apps/web/src/browser-game-storage-lock.ts";
import {createSetup,beginRoleDraw,createSeededRandom,drawRoleForSeat,createGame,completeRoleDraw,advanceSetupPhase,nominate,completeCurrentTurn,startVoting,selectVotingCandidate,createGameLogEntry,createInitialGameBaseline} from "@mafia/game-domain";
import {beginNight,toggleAllMafiaShotsForTarget,resolveMafiaShots} from "@mafia/game-domain";
import "./apps/web/src/styles/app.css";
import "./apps/web/src/features/theme/GlassScene.css";
const query=new URLSearchParams(location.search);
const locale=query.get("locale")==="ru"?"ru":"en";
const club={id:"00000000-0000-4000-8000-000000000101",name:"Glass regression",city:"Test",headerLogo:null,cardLogo:null,language:locale,bestMoveEnabled:true,role:"manager",createdAt:"2026-10-15T00:00:00.000Z",updatedAt:"2026-10-15T00:00:00.000Z"};
const players=Array.from({length:10},(_,i)=>({id:"00000000-0000-4000-8000-"+String(i+1).padStart(12,"0"),seat:i+1}));
let setup=beginRoleDraw(createSetup(players),createSeededRandom(13));
for(let seat=1;seat<=10;seat++)setup=drawRoleForSeat(setup,seat);
let day=createGame(completeRoleDraw(setup));
while(day.phase!=="day")day=advanceSetupPhase(day);
const plainDay=day;
day=nominate(day,1,2);day=nominate(completeCurrentTurn(day),2,3);
const phase=new URLSearchParams(location.search).get("phase");
const emptySetup=new URLSearchParams(location.search).has("empty");
const deceasedNight=resolveMafiaShots(toggleAllMafiaShotsForTarget(beginNight(plainDay),1)).game;
const game=phase==="player-cards"?plainDay:phase==="day"?day:phase==="night"?beginNight(plainDay):phase==="deceased"?deceasedNight:selectVotingCandidate(startVoting(day),2);
const gameId="00000000-0000-4000-8000-000000000399";
const checkpoint=createGameLogEntry({gameId,id:"00000000-0000-4000-8000-000000000398",sequence:1,parentEventId:null,createdAt:"2026-10-15T00:00:00.000Z",before:game,draft:{type:"game.checkpointed",payload:{}}});
const statistics=Object.fromEntries(["hostedGames","gamesPlayed","wins","losses","redGames","redWins","blackGames","blackWins","sheriffGames","citizenGames","mafiaGames","donGames","totalFouls","eliminations","redCards","bestMoves","bestMoveMafiaHits"].map(key=>[key,0]));
const profiles=players.map(p=>({...p,nickname:new URLSearchParams(location.search).has("long-names")?((new URLSearchParams(location.search).get("locale")==="ru"?"Очень длинное имя игрока ":"A very long English nickname ")+p.seat).slice(0,32):"Player "+p.seat,consent:false,clubAccess:"none",managerLocked:false,firstName:null,lastName:null,email:null,consentAt:null,lastPlayedAt:null,statistics:{...statistics},createdAt:club.createdAt,updatedAt:club.createdAt}));
const host={...profiles[0],id:"00000000-0000-4000-8000-000000000011",nickname:"Host"};
if(phase==="setup")profiles.push(host);
const playerSetup=phase==="setup"?{step:"players",hostPlayerId:emptySetup?"":host.id,selectedPlayerIds:players.map(p=>emptySetup?"":p.id),setup:null}:null;
window.fixtureRequests=[];window.fixtureUnexpected=[];
window.fetch=async(url,options={})=>{const path=new URL(url,location.origin).pathname;let body={};
window.fixtureRequests.push({path,method:options.method??"GET",body:options.body?JSON.parse(options.body):null});
if(${followupPhase === "13"}){
 const method=options.method??"GET";
 const known=method==="GET"&&["/api/players","/health/version","/api/ready","/api/music/oauth/status","/api/music/playlists","/api/game-sessions","/api/tournaments","/api/statistics"].includes(path)||["GET","PUT"].includes(method)&&path==="/api/game-sessions/"+gameId;
 if(!known){window.fixtureUnexpected.push({path,method});throw new Error("Unexpected selection fixture request "+method+" "+path);}
}
if(path.startsWith("/api/players/")&&options.method==="PUT"){
 const index=profiles.findIndex(p=>p.id===path.split("/").at(-1));
 if(index<0)throw new Error("Unknown fixture player "+path);
 profiles[index]={...profiles[index],...JSON.parse(options.body)};body={player:profiles[index]};
}
else if(path==="/api/players")body={players:profiles};
else if(path.includes("/version"))body={version:"glass-regression"};
else if(${followupPhase === "13"}&&path==="/api/tournaments")body={tournaments:[]};
else if(${followupPhase === "13"}&&path==="/api/statistics")body={players:[],tournaments:[],coverage:{completedGames:0,unavailableGames:0,pendingGames:0},algorithm:"club-team-elo-v1"};
else if(${followupPhase === "13"}&&path==="/api/music/oauth/status")body={configured:false,connected:false,accountLabel:null};
else if(${followupPhase === "13"}&&path==="/api/music/playlists")body={playlists:[]};
else if(phase==="setup"&&path==="/api/music/oauth/status")body={configured:true,connected:true,accountLabel:"Layout fixture"};
else if(phase==="setup"&&path==="/api/music/playlists")body={playlists:${followupPhase ? '[{id:"fixture-playlist",title:"Mafia local recovery",itemCount:1}]' : "[]"}};
else if(${Boolean(followupPhase)}&&path.includes("/api/music/playlists/"))body={items:[{entryId:"local-entry",videoId:"local-video",title:"Local recovery track",position:0}]};
else if(path.includes("/ready"))body={ready:true};
else if(path==="/api/game-sessions")body={sessions:${followupPhase ? 'new URL(url,location.origin).searchParams.get("status")==="completed"?[{gameId:"00000000-0000-4000-8000-000000000499",name:(locale==="ru"?"Очень длинное название завершённой игры ":"An exceptionally long completed game title ").repeat(5),outcome:"red"}]:[]' : "[]"}};
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
 if(!new URLSearchParams(location.search).has("fresh")){
 localStorage.setItem("mafia-dashboard.developer-unlocked.v1","unlocked");
 if(!playerSetup)localStorage.setItem("mafia-dashboard.developer-mode.v1","enabled");
 }
 localStorage.setItem("mafia-dashboard.lighting-renderer.v1","legacy");
 // Preserve the pre-rollout broad material scenario explicitly. The new fresh
 // scenarios independently prove edge-default refraction on every family.
 if(new URLSearchParams(location.search).has("glass"))localStorage.setItem("mafia-dashboard.glass.v1",JSON.stringify({version:1,enabled:true,refraction:10,goldLight:25,profile:"simple"}));
 else if(!new URLSearchParams(location.search).has("fresh"))localStorage.setItem("mafia-dashboard.glass.v1",JSON.stringify({version:1,enabled:false,refraction:10,goldLight:25,profile:"simple"}));
}
const app=createRoot(document.getElementById("root"));
app.render(<React.StrictMode><I18nProvider locale={locale}><ClubWorkspace storageGuard={storageGuard} club={club} onExit={()=>app.unmount()} onEditClub={()=>{}} onDeleteClub={()=>Promise.resolve()} fancyStuff={DEFAULT_FANCY_STUFF_SETTINGS} onFancyStuffChange={()=>{}}/></I18nProvider></React.StrictMode>);
await new Promise(()=>{});
});
`;
let server;
const bundleBinding = {};
const results = [];
const runId = new Date().toISOString();
const sourceBefore =
  ["player-cards", "portrait-cards"].includes(process.env.GLASS_SCENARIO) || followupPhase
    ? await capturePlayerCardSources(root)
    : null;
if (sourceBefore)
  await writeFile(join(evidence, "source-before.json"), JSON.stringify(sourceBefore, null, 2));
async function previousResults(path) {
  try {
    return JSON.parse(await readFile(path, "utf8")).results ?? [];
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return [];
  }
}
async function verifyFollowup(page, url, config) {
  const { engine, enhanced, locale } = config;
  const prefix = `${engine}-${locale}-${enhanced ? "enhanced" : "normal"}`;
  const receipt = {
    plan: followupPhase,
    ...config,
    viewport: page.viewportSize(),
    browserVersion: page.context().browser().version(),
    origin: new URL(url).origin,
    ...(followupPhase === "13"
      ? { sourceDigest: sourceBefore.digest, compiledOutputs: bundleBinding.production.outputs }
      : {}),
    screenshots: [],
    errors: [],
    requests: [],
  };
  const ru = locale === "ru";
  page.on("pageerror", (error) => receipt.errors.push(error.message));
  if (followupPhase === "13") {
    receipt.resourceFailures = [];
    receipt.blockedRequests = [];
    page.on("requestfailed", (request) =>
      receipt.resourceFailures.push({ url: request.url(), failure: request.failure()?.errorText }),
    );
  }
  const screenshot = async (name) => {
    const path = join(evidence, `${prefix}-${name}.png`);
    await page.screenshot({ path, fullPage: true });
    receipt.screenshots.push(path);
  };
  await page.route("**/*", async (route) => {
    const request = route.request();
    const target = request.url();
    if (target === "https://www.youtube.com/iframe_api") {
      receipt.requests.push({
        url: target,
        action: receipt.requests.length === 0 ? "abort" : "local-fixture",
      });
      if (receipt.requests.length === 1) return route.abort("failed");
      return route.fulfill({
        contentType: "text/javascript",
        body: `
        window.localPlayerConstructions = (window.localPlayerConstructions || 0);
        class LocalPlayer {
          constructor(id, options) {
            this.options=options; this.volume=65; this.state=5; this.videoIds=[];
            this.iframe=document.createElement('iframe'); this.iframe.title='Local YouTube fixture';
            document.getElementById(id).replaceChildren(this.iframe);
            window.localPlayer=this; window.localPlayerConstructions++;
            setTimeout(()=>options.events.onReady({target:this}),0);
          }
          playVideo(){this.state=1;this.options.events.onStateChange({target:this,data:1});}
          pauseVideo(){this.state=2;this.options.events.onStateChange({target:this,data:2});}
          cuePlaylist(ids,index=0){this.videoIds=[...ids];this.index=index;this.state=5;setTimeout(()=>this.options.events.onStateChange({target:this,data:5}),0);}
          loadPlaylist(ids,index=0){this.cuePlaylist(ids,index);this.playVideo();}
          cueVideoById(value){this.videoIds=[value.videoId??value];this.state=5;setTimeout(()=>this.options.events.onStateChange({target:this,data:5}),0);}
          loadVideoById(value){this.cueVideoById(value);this.playVideo();}
          playVideoAt(index){this.index=index;this.playVideo();}
          setVolume(volume){this.volume=volume;} getVolume(){return this.volume;}
          getIframe(){return this.iframe;} getPlaylistIndex(){return this.index??0;}
          getPlaylist(){return this.videoIds;} getCurrentTime(){return 0;}
          getPlayerState(){return this.state;} getVideoData(){return {title:'Local recovery track'};}
          destroy(){this.iframe.remove();}
        }
        window.YT={Player:LocalPlayer,PlayerState:{PLAYING:1,PAUSED:2,ENDED:0,BUFFERING:3,CUED:5}};
        window.onYouTubeIframeAPIReady();
      `,
      });
    }
    if (target.startsWith(url + "/")) return route.continue();
    if (followupPhase === "13") receipt.blockedRequests.push(target);
    return route.abort();
  });
  try {
    await page.goto(
      `${url}/?phase=${followupPhase === "04" ? "setup" : "day"}&locale=${locale}${enhanced ? "&glass" : ""}`,
    );
    await page.locator(".app-shell").waitFor();
    if (enhanced)
      await page.waitForFunction(
        () => document.querySelector(".app-shell")?.dataset.glassStatus === "ready",
      );
    receipt.glassStatus = await page.locator(".app-shell").getAttribute("data-glass-status");
    if (followupPhase === "04") {
      await page.locator(".music-panel-handle").click();
      await page.locator(".youtube-session-queue select").selectOption("fixture-playlist");
      await page
        .getByRole("button", {
          name: ru ? "Открыть меню управления" : "Open Manage menu",
          exact: true,
        })
        .click();
      await page
        .getByRole("button", {
          name: ru ? "Настройка музыкального плеера" : "Music player setup",
          exact: true,
        })
        .click();
      await page
        .locator(".music-status")
        .filter({ hasText: ru ? "недоступ" : "unavailable" })
        .waitFor();
      assert.equal(receipt.requests.length, 1);
      assert.equal(
        await page.locator('script[src="https://www.youtube.com/iframe_api"]').count(),
        0,
      );
      await screenshot("api-failed");
      await page
        .getByRole("button", {
          name: ru ? "Перезагрузить музыкальный плеер" : "Reload music player",
          exact: true,
        })
        .click();
      await page.waitForFunction(
        () =>
          window.localPlayerConstructions === 1 &&
          document.querySelector('iframe[title="Local YouTube fixture"]'),
      );
      assert.equal(receipt.requests.length, 2);
      await page
        .locator(".music-status")
        .filter({ hasText: ru ? "Готово · пауза" : "Ready · paused" })
        .waitFor();
      receipt.recoveryLabel = await page.locator(".music-status").innerText();
      await screenshot("manage-recovered");
      await page
        .getByRole("button", {
          name: ru ? "Закрыть меню управления" : "Close Manage menu",
          exact: true,
        })
        .click();
      await screenshot("api-recovered");
      receipt.recovery = await page.evaluate(() => ({
        constructions: window.localPlayerConstructions,
        scripts: document.querySelectorAll('script[src="https://www.youtube.com/iframe_api"]')
          .length,
        queue: window.localPlayer.videoIds,
        state: window.localPlayer.getPlayerState(),
      }));
      assert.equal(receipt.recovery.scripts, 1);
      assert.ok(receipt.recovery.queue.length > 0);
    }
    if (followupPhase === "05") {
      await page
        .getByRole("button", {
          name: ru ? "Открыть меню разработчика" : "Open developer menu",
          exact: true,
        })
        .click();
      receipt.title = await page
        .locator(".dev-setting-toggle strong")
        .first()
        .evaluate((node) => ({
          actual: getComputedStyle(node).color,
          expected: getComputedStyle(node).getPropertyValue("--text").trim(),
          undefinedToken: getComputedStyle(node).getPropertyValue("--foreground"),
        }));
      await screenshot("developer-title");
      await page
        .getByRole("button", {
          name: ru ? "Хронология прошлых игр" : "Past game timeline",
          exact: true,
        })
        .click();
      await page
        .locator(".timeline-header select option[value='00000000-0000-4000-8000-000000000499']")
        .waitFor({ state: "attached" });
      await page
        .locator(".timeline-header select")
        .selectOption("00000000-0000-4000-8000-000000000499");
      await page.locator(".timeline-error").waitFor();
      receipt.error = await page.locator(".timeline-error").evaluate((node) => ({
        actual: getComputedStyle(node).color,
        expected: getComputedStyle(node).getPropertyValue("--red").trim(),
        text: node.textContent,
      }));
      await screenshot("long-error");
      const dates = page.locator('.timeline-filters input[type="date"]');
      await dates.nth(0).fill("2026-10-16");
      await dates.nth(1).fill("2026-10-15");
      receipt.filterError = await page.locator(".timeline-filter-error").evaluate((node) => ({
        actual: getComputedStyle(node).color,
        expected: getComputedStyle(node).getPropertyValue("--red").trim(),
      }));
      await screenshot("filter-error");
      const normalize = (value) =>
        value.startsWith("#")
          ? `rgb(${value
              .slice(1)
              .match(/../g)
              .map((part) => parseInt(part, 16))
              .join(", ")})`
          : value;
      assert.equal(
        receipt.title.actual,
        normalize(receipt.title.expected),
        "Developer title uses existing --text",
      );
      assert.equal(
        receipt.error.actual,
        normalize(receipt.error.expected),
        "Timeline load error uses existing --red",
      );
      assert.equal(
        receipt.filterError.actual,
        normalize(receipt.filterError.expected),
        "Timeline filter error uses existing --red",
      );
    }
    if (followupPhase === "06") {
      await page
        .getByRole("button", {
          name: ru ? "Открыть меню разработчика" : "Open developer menu",
          exact: true,
        })
        .click();
      const canonicalBefore = await page.evaluate(
        () => JSON.parse(localStorage.getItem("mafia-dashboard.game-session.v5")).current.state,
      );
      await page
        .getByRole("button", {
          name: ru ? "Хронология прошлых игр" : "Past game timeline",
          exact: true,
        })
        .click();
      await page.locator(".timeline-marker").first().click();
      receipt.currentActions = [];
      for (const button of await page.locator(".timeline-state-actions button").all()) {
        await button.scrollIntoViewIfNeeded();
        const box = await button.boundingBox();
        assert.ok(box.x >= -1 && box.x + box.width <= page.viewportSize().width + 1);
        assert.ok(box.height >= 44);
        receipt.currentActions.push({
          text: await button.innerText(),
          disabled: await button.isDisabled(),
          box,
        });
      }
      assert.equal(receipt.currentActions.length, 2);
      assert.equal(receipt.currentActions[0].disabled, false);
      assert.equal(receipt.currentActions[1].disabled, true);
      await screenshot("current-actions");
      const geometry = () =>
        page.evaluate(() => {
          const read = (node) => {
            const box = node.getBoundingClientRect();
            return {
              x: box.x,
              y: box.y,
              right: box.right,
              bottom: box.bottom,
              width: box.width,
              height: box.height,
              clientWidth: node.clientWidth,
              scrollWidth: node.scrollWidth,
            };
          };
          return {
            viewport: { width: innerWidth, height: innerHeight },
            documentWidth: document.documentElement.scrollWidth,
            header: read(document.querySelector(".timeline-header")),
            filters: read(document.querySelector(".timeline-filters")),
            controls: [
              ...document.querySelectorAll(".timeline-header > *, .timeline-filters > *"),
            ].map(read),
            inspector: document.querySelector(".timeline-inspector")
              ? read(document.querySelector(".timeline-inspector"))
              : null,
          };
        });
      await page
        .locator(".timeline-header select option[value='00000000-0000-4000-8000-000000000499']")
        .waitFor({ state: "attached" });
      await page
        .locator(".timeline-header select")
        .selectOption("00000000-0000-4000-8000-000000000499");
      await page.locator(".timeline-error").waitFor();
      receipt.longError = await geometry();
      await screenshot("long-error");
      await page
        .getByRole("button", {
          name: ru ? "Создать демонстрационную игру" : "Generate sample game data",
          exact: true,
        })
        .click();
      assert.equal(await page.locator(".timeline-marker").count(), 23);
      assert.equal(await page.locator(".timeline-region").count(), 7);
      await page.locator(".timeline-marker").nth(9).click();
      receipt.populated = await geometry();
      receipt.detail = await page.locator(".timeline-inspector").innerText();
      await page.locator(".timeline-inspector").scrollIntoViewIfNeeded();
      await screenshot("populated-detail");
      receipt.lane = await page.locator(".timeline-track-scroll").evaluate((node) => {
        const width = node.clientWidth,
          scrollWidth = node.scrollWidth;
        node.scrollLeft = scrollWidth;
        return {
          width,
          scrollWidth,
          scrollLeft: node.scrollLeft,
          overflowX: getComputedStyle(node).overflowX,
        };
      });
      await screenshot("lane-right");
      assert.ok(receipt.lane.scrollWidth > receipt.lane.width && receipt.lane.scrollLeft > 0);
      assert.equal(receipt.lane.overflowX, "auto");
      assert.deepEqual(
        await page.evaluate(
          () => JSON.parse(localStorage.getItem("mafia-dashboard.game-session.v5")).current.state,
        ),
        canonicalBefore,
      );
      for (const state of [receipt.longError, receipt.populated]) {
        assert.ok(
          state.documentWidth <= state.viewport.width + 1,
          "No document horizontal overflow",
        );
        for (const control of state.controls)
          assert.ok(
            control.x >= -1 && control.right <= state.viewport.width + 1,
            `Timeline control clips: ${JSON.stringify(control)}`,
          );
        if (state.inspector)
          assert.ok(
            state.inspector.scrollWidth <= state.inspector.clientWidth + 1,
            `Inspector horizontal overflow: ${JSON.stringify(state.inspector)}`,
          );
      }
    }
    if (followupPhase === "13") {
      receipt.selection = [];
      receipt.editing = [];
      const canonical = () =>
        page.evaluate(
          () => JSON.parse(localStorage.getItem("mafia-dashboard.game-session.v5")).current.state,
        );
      const dragBetween = async (from, to) => {
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 8 });
        await page.mouse.up();
      };
      const blocked = async (target, label) => {
        await target.scrollIntoViewIfNeeded();
        receipt.selectionTarget = await target.evaluate((node) => {
          const ancestors = [];
          for (let el = node; el; el = el.parentElement)
            ancestors.push({
              tag: el.tagName,
              userSelect: getComputedStyle(el).userSelect,
              webkitUserSelect: getComputedStyle(el).webkitUserSelect,
            });
          return ancestors;
        });
        const bounds = await target.evaluate((node) => {
          const walker = document.createTreeWalker(node, 4);
          let text;
          while ((text = walker.nextNode())) {
            if (!text.textContent.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(text);
            const box = range.getClientRects()[0];
            if (box?.width > 10)
              return { x: box.x, y: box.y, width: box.width, height: box.height };
          }
          return null;
        });
        assert.ok(bounds?.width > 10, `${label}: real visible text target`);
        await page.evaluate(() => window.getSelection().removeAllRanges());
        await dragBetween(
          { x: bounds.x + 2, y: bounds.y + bounds.height / 2 },
          { x: bounds.x + bounds.width - 2, y: bounds.y + bounds.height / 2 },
        );
        const drag = await page.evaluate(() => window.getSelection().toString());
        assert.equal(drag, "", `${label}: native drag must not select ordinary UI text`);
        await page.mouse.dblclick(bounds.x + 6, bounds.y + bounds.height / 2);
        const doubleClick = await page.evaluate(() => window.getSelection().toString());
        assert.equal(doubleClick, "", `${label}: native double-click must not select UI text`);
        const computed = await target.evaluate((node) => ({
          unprefixedSupported: window.CSS.supports("user-select", "none"),
          userSelect: getComputedStyle(node).getPropertyValue("user-select") || null,
          webkitUserSelect: getComputedStyle(node).webkitUserSelect,
        }));
        assert.equal(
          computed.userSelect,
          computed.unprefixedSupported ? "none" : null,
          `${label}: computed selection policy`,
        );
        assert.equal(computed.webkitUserSelect, "none", `${label}: WebKit selection policy`);
        receipt.selection.push({ label, drag, doubleClick, ...computed });
      };
      const editable = async (field, label) => {
        const original = await field.inputValue();
        await field.fill("Native selection sample");
        await field.click();
        const read = () =>
          field.evaluate((node) => ({
            start: node.selectionStart,
            end: node.selectionEnd,
            value: node.value,
            unprefixedSupported: window.CSS.supports("user-select", "text"),
            userSelect: getComputedStyle(node).getPropertyValue("user-select") || null,
            webkitUserSelect: getComputedStyle(node).webkitUserSelect,
            readWrite: node.matches(":read-write"),
            portaled: !node.closest("#root"),
          }));
        await page.keyboard.press("Meta+A");
        const all = await read();
        assert.equal(all.start, 0, label);
        assert.equal(all.end, all.value.length, label);
        assert.equal(all.userSelect, all.unprefixedSupported ? "text" : null, label);
        assert.equal(all.webkitUserSelect, "text", label);
        assert.equal(all.readWrite, true, label);
        await page.keyboard.press("ArrowLeft");
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowRight");
        for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowRight");
        const part = await read();
        assert.deepEqual([part.start, part.end], [2, 5], `${label}: native substring selection`);
        if (label === "body-portaled opposing-victory textarea")
          await screenshot("native-textarea-substring");
        // Intercept the trusted native copy command BEFORE its default action.
        // Never read or write the operator clipboard; this proves command dispatch only.
        await field.evaluate((node) => {
          node.dataset.copyEvents = "0";
          node.addEventListener(
            "copy",
            (event) => {
              event.preventDefault();
              node.dataset.copyEvents = String(Number(node.dataset.copyEvents) + 1);
              node.dataset.copyTrusted = String(event.isTrusted);
            },
            { once: true },
          );
        });
        await page.keyboard.press("Meta+C");
        assert.equal(await field.getAttribute("data-copy-events"), "1", label);
        assert.equal(await field.getAttribute("data-copy-trusted"), "true", label);
        await page.keyboard.type("XYZ");
        assert.equal(
          await field.inputValue(),
          "NaXYZe selection sample",
          `${label}: replace substring`,
        );
        await page.keyboard.press("Meta+A");
        await page.keyboard.type("Selection 13");
        assert.equal(await field.inputValue(), "Selection 13", `${label}: replace all`);
        await page.keyboard.press("ArrowLeft");
        const caret = await read();
        assert.deepEqual([caret.start, caret.end], [11, 11], `${label}: native caret`);
        receipt.editing.push({
          label,
          all,
          part,
          caret,
          copy: "trusted native command; default prevented; no clipboard roundtrip",
        });
        await field.fill(original);
      };
      await blocked(page.locator(".game-header h1"), "workspace title");
      const before = await canonical();
      const selected = page.locator('.game-shell .seat-anchor[data-seat="3"] > .player-seat');
      assert.equal(await selected.getAttribute("aria-pressed"), "true");
      assert.ok((await selected.getAttribute("class")).includes("is-nomination-selected"));
      const glow = await page
        .locator(".game-shell .player-seat.is-current")
        .first()
        .evaluate((node) => ({
          shadow: getComputedStyle(node).boxShadow,
          animation: getComputedStyle(node).animationName,
        }));
      assert.notEqual(glow.shadow, "none");
      receipt.semanticStatus = { selected: true, marker: true, glow };
      const utility = page.locator(".utility-panels-toggle");
      await utility.click();
      await page.locator("#game-utility-panels").waitFor({ state: "hidden" });
      assert.equal(await page.locator("#game-utility-panels").isVisible(), false);
      await utility.click();
      assert.equal(await page.locator("#game-utility-panels").isVisible(), true);
      receipt.panelGesture = {
        nativeToggle: true,
        nativeSwipe: "WebKit swipe unavailable; component handler covered separately",
      };
      if (engine.startsWith("chrome")) {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
        const grip = await utility.boundingBox();
        const x = grip.x + grip.width / 2,
          y = grip.y + grip.height / 2;
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x, y, id: 1 }],
        });
        for (let i = 1; i <= 6; i++)
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x, y: y + i * 10, id: 1 }],
          });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        assert.equal(
          await page.locator("#game-utility-panels").isVisible(),
          true,
          "Panel swipe does not toggle on its trailing click",
        );
        await utility.click();
        assert.equal(
          await page.locator("#game-utility-panels").isVisible(),
          true,
          "Existing post-swipe click suppression consumes the next click",
        );
        await utility.click();
        await page.locator("#game-utility-panels").waitFor({ state: "hidden" });
        assert.equal(
          await page.locator("#game-utility-panels").isVisible(),
          false,
          "Subsequent native panel activation after the suppressed click",
        );
        await utility.click();
        await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
        await cdp.detach();
        receipt.panelGesture.nativeSwipe =
          "trusted CDP touch start/move/end and subsequent real click";
      }
      const card = page.locator('.game-shell .seat-anchor[data-seat="1"] > .player-seat');
      const box = await card.boundingBox();
      await dragBetween(
        { x: box.x + box.width / 2, y: box.y + box.height / 2 },
        { x: box.x + box.width / 2, y: box.y + box.height / 2 - 75 },
      );
      const dialog = page.locator("dialog.federation-judge-dialog[open]");
      await dialog.waitFor();
      assert.equal(await dialog.evaluate((node) => node.parentElement === document.body), true);
      await blocked(dialog.locator("header strong"), "body-portaled penalty title");
      await editable(dialog.locator("input[maxlength='500']"), "body-portaled optional notes");
      await dialog
        .locator(".federation-discipline-form > label select")
        .selectOption("opponent-victory");
      await editable(dialog.locator("textarea"), "body-portaled opposing-victory textarea");
      await screenshot("native-portal-editing");
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      assert.deepEqual(
        await canonical(),
        before,
        "Reading/editing an unsubmitted penalty does not change game state",
      );
      const rules = page.getByRole("button", { name: ru ? "Правила" : "Rules", exact: true });
      await rules.click();
      const reader = page.locator("dialog.rules-sketchbook[open]");
      await reader.waitFor();
      assert.equal(await reader.evaluate((node) => node.parentElement === document.body), true);
      const book = reader.locator(".rs-book");
      const idle = () =>
        page.waitForFunction(() => {
          const paper = document.querySelector(".rs-book");
          return (
            paper &&
            paper.getAttribute("aria-busy") !== "true" &&
            !document.querySelector(".rs-curl")
          );
        });
      const openTableChapter = async () => {
        await idle();
        await reader.locator(".rs-bookmark").click();
        await idle();
        await reader.locator('.rs-spread [data-chapter-target="table"]').click();
        await idle();
        assert.equal(await book.getAttribute("data-chapter"), "table");
      };
      await openTableChapter();
      await blocked(reader.locator(".rs-spread .rs-lede"), "body-portaled real Rules text");
      // Selection attempts can themselves turn pages. Settle and re-establish
      // an exact starting chapter before attributing the next native gesture.
      await openTableChapter();
      const paper = await book.boundingBox();
      await dragBetween(
        { x: paper.x + paper.width * 0.2, y: paper.y + paper.height * 0.5 },
        { x: paper.x + paper.width * 0.8, y: paper.y + paper.height * 0.5 },
      );
      await page.waitForFunction(
        () => document.querySelector(".rs-book")?.dataset.chapter === "contents",
      );
      await idle();
      const reading = reader.locator(".rs-spread .rs-body");
      const scroll = await reading.evaluate((node) => ({
        height: node.clientHeight,
        scrollHeight: node.scrollHeight,
      }));
      if (scroll.scrollHeight > scroll.height) {
        await reading.hover();
        await page.mouse.wheel(0, 250);
        await page.waitForFunction(() =>
          [...document.querySelectorAll(".rs-body")].some((node) => node.scrollTop > 0),
        );
      }
      const scrollTop = await reading.evaluate((node) => node.scrollTop);
      assert.ok(scrollTop > 0, "Actual Rules contents body scrolled after native wheel");
      receipt.rules = {
        pageGesture: "settled native mouse drag: table -> contents",
        nativeWheelScroll: scroll.scrollHeight > scroll.height,
        scrollTop,
        scroll,
      };
      await screenshot("rules-selection-and-gesture");
      await page.keyboard.press("Escape");
      await reader.waitFor({ state: "detached" });
      assert.deepEqual(await canonical(), before);
      await page.locator(".manage-toolbar-button").click();
      await page
        .getByRole("button", { name: ru ? "Экран игроков" : "Players screen", exact: true })
        .click();
      await blocked(
        page.locator('[data-player-glass="profile"] h2').first(),
        "player profile card name",
      );
      await editable(page.locator('input[id$="-nickname"]').first(), "player nickname");
      await editable(page.locator("#player-search"), "player nickname search");
      await screenshot("native-profile-fields");
      await page.locator(".manage-toolbar-button").click();
      await page
        .getByRole("button", { name: ru ? "Статистика" : "Statistics", exact: true })
        .click();
      await page.locator(".statistics-coverage").waitFor();
      await blocked(page.locator(".statistics-header h1"), "statistics heading");
      await blocked(page.locator(".statistics-filter-note").first(), "statistics label");
      await blocked(
        page.locator(".statistics-table-tools button"),
        "native statistics refresh button",
      );
      await editable(page.locator('.statistics-screen input[type="search"]'), "statistics search");
      await page.locator(".statistics-header button").click();
      await page.locator(".dev-toolbar-button").click();
      await page
        .getByRole("button", {
          name: ru ? "Хронология прошлых игр" : "Past game timeline",
          exact: true,
        })
        .click();
      await blocked(page.locator(".timeline-header h1"), "Timeline heading");
      await page.locator(".timeline-marker").first().click();
      await blocked(page.locator(".timeline-inspector h2"), "Timeline detail label");
      await screenshot("timeline-text");
      assert.deepEqual(await canonical(), before);
      receipt.fixtureRequests = await page.evaluate(() => window.fixtureRequests);
      assert.deepEqual(await page.evaluate(() => window.fixtureUnexpected), []);
      await page.evaluate(() => localStorage.clear());
      await page.goto(`${url}/?phase=setup&locale=${locale}${enhanced ? "&glass" : ""}`);
      await page.locator("#seat-1-player").waitFor();
      await page.waitForFunction(
        () => document.querySelector("#seat-1-player")?.value === "Player 1",
      );
      await editable(page.locator("#host-player"), "host picker search");
      await page.locator(".player-setup-card h1").click();
      const picker = page.locator("#seat-1-player");
      await editable(picker, "seat picker search");
      await page.locator(".player-setup-card h1").click();
      await picker.click();
      await page
        .locator("#seat-1-player-suggestions")
        .getByRole("option", { name: "Player 1", exact: true })
        .click();
      assert.equal(await page.getByRole("listbox").count(), 0);
      await page
        .getByRole("button", {
          name: ru ? "Выбрать доступных игроков" : "Select available players",
          exact: true,
        })
        .click();
      await editable(
        page.getByRole("searchbox", {
          name: ru ? "Поиск доступных игроков" : "Search available players",
          exact: true,
        }),
        "available-player search",
      );
      await page
        .getByRole("button", {
          name: ru ? "Закрыть список доступных игроков" : "Close available players",
          exact: true,
        })
        .click();
      await page.locator('.tournament-picker input[type="checkbox"]').check();
      await page
        .getByRole("button", { name: ru ? "Новый турнир…" : "New tournament…", exact: true })
        .click();
      await editable(page.locator(".tournament-picker-create input"), "tournament name");
      await screenshot("native-setup-fields");
      await page.locator('.tournament-picker input[type="checkbox"]').uncheck();
      const handle = page.locator('[data-setup-seat="1"] .setup-seat-drag-handle');
      await handle.scrollIntoViewIfNeeded();
      const source = await handle.boundingBox(),
        target = await page.locator('[data-setup-seat="2"]').boundingBox();
      await dragBetween(
        { x: source.x + source.width / 2, y: source.y + source.height / 2 },
        { x: target.x + target.width / 2, y: target.y + target.height / 2 },
      );
      await page.waitForFunction(
        () =>
          document.querySelector("#seat-1-player")?.value === "Player 2" &&
          document.querySelector("#seat-2-player")?.value === "Player 1",
      );
      await page
        .getByRole("button", { name: ru ? "Начать игру" : "Start game", exact: true })
        .click();
      const role = page.locator('.seat-anchor[data-seat="1"] .player-seat');
      await role.click();
      const roleBox = await role.boundingBox();
      await dragBetween(
        { x: roleBox.x + roleBox.width / 2, y: roleBox.y + roleBox.height / 2 },
        { x: roleBox.x + roleBox.width / 2 + 70, y: roleBox.y + roleBox.height / 2 },
      );
      const chooser = page.getByRole("dialog", {
        name: ru ? "Выберите роль" : "Choose role",
        exact: true,
      });
      await chooser.waitFor();
      await blocked(chooser.locator(".table-prompt"), "role chooser title");
      await chooser.getByRole("button", { name: ru ? "Отмена" : "Cancel", exact: true }).click();
      await chooser.waitFor({ state: "detached" });
      receipt.pointerPreservation = {
        penaltyGesture: true,
        pickerOption: true,
        seatSwap: true,
        roleChooser: "trusted mouse horizontal swipe and visible cancel",
      };
      receipt.fixtureRequests.push(...(await page.evaluate(() => window.fixtureRequests)));
      assert.deepEqual(await page.evaluate(() => window.fixtureUnexpected), []);
      const font =
        "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500&family=Ubuntu:wght@400;500;600;700&display=swap";
      assert.ok(
        receipt.blockedRequests.every((request) => request === font),
        "Only the existing external font import may be blocked",
      );
      assert.ok(
        receipt.resourceFailures.every((request) => receipt.blockedRequests.includes(request.url)),
        "No unclassified/local resource failures",
      );
      await screenshot("ordinary-text");
    }
    if (followupPhase === "12") {
      const canonical = () =>
        page.evaluate(
          () => JSON.parse(localStorage.getItem("mafia-dashboard.game-session.v5")).current.state,
        );
      const focused = async (control, label) => {
        const baseline = await control.evaluate((node) => ({
          outlineStyle: getComputedStyle(node).outlineStyle,
          outlineWidth: getComputedStyle(node).outlineWidth,
          outlineColor: getComputedStyle(node).outlineColor,
          outlineOffset: getComputedStyle(node).outlineOffset,
        }));
        await control.focus();
        const style = await control.evaluate((node) => ({
          focused: node === document.activeElement,
          outlineStyle: getComputedStyle(node).outlineStyle,
          outlineWidth: getComputedStyle(node).outlineWidth,
          outlineColor: getComputedStyle(node).outlineColor,
          outlineOffset: getComputedStyle(node).outlineOffset,
        }));
        assert.equal(style.focused, true);
        const { focused: active, ...outline } = style;
        assert.equal(active, true);
        assert.deepEqual(
          outline,
          baseline,
          `${label}: focus adds no outline while preserving semantic selected/game outlines`,
        );
        receipt.focusedControls ??= [];
        receipt.focusedControls.push({ label, baseline, ...style });
      };
      const toggle = page.locator(".dev-toolbar-button");
      if (enhanced) {
        await toggle.click();
        await page.locator(".dev-menu-actions > .dev-setting-toggle").nth(0).focus();
        await page.keyboard.press("Enter");
        await toggle.click();
        await page.waitForFunction(() =>
          ["ready", "fallback"].includes(document.querySelector(".app-shell")?.dataset.vgpuStatus),
        );
      }
      const selected = page.locator('.game-shell .seat-anchor[data-seat="3"] > .player-seat');
      await selected.waitFor();
      assert.equal(await selected.getAttribute("aria-pressed"), "true");
      assert.ok((await selected.getAttribute("class")).includes("is-nomination-selected"));
      const gameBefore = await canonical();
      await focused(selected, "selected native player button");
      await screenshot("focused-selected-player");
      for (const key of ["f", "Shift+F10", "ContextMenu"]) await page.keyboard.press(key);
      assert.deepEqual(
        await canonical(),
        gameBefore,
        "Retired player keys cannot mutate canonical state",
      );
      assert.equal(await page.locator("dialog[open]").count(), 0);
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () =>
          document
            .querySelector('.seat-anchor[data-seat="3"] > .player-seat')
            ?.getAttribute("aria-pressed") === "false",
      );
      await page.keyboard.press("Space");
      await page.waitForFunction(
        () =>
          document
            .querySelector('.seat-anchor[data-seat="3"] > .player-seat')
            ?.getAttribute("aria-pressed") === "true",
      );
      assert.equal(
        (await canonical()).events.length,
        gameBefore.events.length + 2,
        "Native Enter/Space each perform one canonical nomination action",
      );
      assert.equal(await selected.getAttribute("aria-pressed"), "true");
      assert.ok((await selected.getAttribute("class")).includes("is-nomination-selected"));
      receipt.semanticSelection = {
        before: "true",
        after: await selected.getAttribute("aria-pressed"),
        acceptedEvents: 2,
        markerRetained: true,
      };
      if (enhanced) {
        const current = page.locator(".game-shell .player-seat.is-current").first();
        await focused(current, "current speaker with retained game-state glow");
        receipt.gameLighting = await current.evaluate((node) => {
          const shell = node.closest(".app-shell");
          const canvas = node.querySelector(".vgpu-player-lighting");
          return {
            requested: shell.dataset.lightingRendererRequested,
            effective: shell.dataset.lightingRenderer,
            status: shell.dataset.vgpuStatus,
            ready: canvas?.dataset.vgpuReady,
            visibility: canvas ? getComputedStyle(canvas).visibility : null,
            cssAnimation: getComputedStyle(node).animationName,
            cssShadow: getComputedStyle(node).boxShadow,
          };
        });
        assert.equal(receipt.gameLighting.requested, "vgpu");
        assert.ok(
          (receipt.gameLighting.effective === "vgpu" &&
            receipt.gameLighting.ready === "true" &&
            receipt.gameLighting.visibility === "visible") ||
            (receipt.gameLighting.effective === "legacy" &&
              receipt.gameLighting.status === "fallback" &&
              receipt.gameLighting.cssAnimation !== "none" &&
              receipt.gameLighting.cssShadow !== "none"),
          "Focused speaker retains a real supported GPU or explicit CSS fallback game glow",
        );
        await screenshot("focused-current-game-glow");
      }
      await toggle.click();
      await page.keyboard.press("Escape");
      assert.equal(
        await page.locator("#dev-menu-drawer").count(),
        1,
        "Retired drawer Escape does not close a non-native drawer",
      );
      const detail = page.locator(".player-exit-controls");
      await detail.locator("summary").focus();
      await page.keyboard.press("Enter");
      assert.equal(await detail.getAttribute("open"), "");
      await focused(detail.locator("summary"), "native details summary");
      await page.keyboard.press("Space");
      assert.equal(await detail.getAttribute("open"), null);
      await page.keyboard.press("Enter");
      const range = detail.locator("input[type=range]").first();
      await focused(range, "native range");
      const minimum = Number(await range.getAttribute("min"));
      const step = Number(await range.getAttribute("step"));
      await page.keyboard.press("Home");
      assert.equal(await range.inputValue(), String(minimum));
      await page.keyboard.press("ArrowRight");
      assert.equal(await range.inputValue(), String(minimum + step));
      const select = detail.locator("select").first();
      await select.selectOption({ index: 0 });
      await focused(select, "native select");
      if (ru) {
        // Playwright's insertText path for Cyrillic does not exercise native
        // select type-ahead; OS popup keyboard delivery remains unqualified.
        await select.selectOption({ index: 1 });
        receipt.nativeSelectActivation =
          "native DOM selectOption; Russian OS-popup keyboard not qualified";
        receipt.gaps = [
          "Russian native select popup keyboard delivery on this macOS headless host",
        ];
      } else {
        await page.keyboard.type(await select.locator("option").nth(1).innerText(), { delay: 30 });
        receipt.nativeSelectActivation = "native type-ahead";
      }
      assert.equal(
        await select.inputValue(),
        await select.locator("option").nth(1).getAttribute("value"),
      );
      await screenshot("focused-native-range-drawer-stays-open");
      await toggle.click();
      await page.locator("#dev-menu-drawer").waitFor({ state: "detached" });
      const rules = page.getByRole("button", { name: ru ? "Правила" : "Rules", exact: true });
      await focused(rules, "native Rules opener");
      await page.keyboard.press("Enter");
      const reader = page.locator("dialog.rules-sketchbook[open]");
      await reader.waitFor();
      assert.equal(await reader.evaluate((node) => node.matches(":modal")), true);
      const bookBefore = await canonical();
      await rules.evaluate((node) => node.focus());
      assert.equal(
        await rules.evaluate((node) => node === document.activeElement),
        false,
        "Native modal inertness rejects background focus",
      );
      const paper = reader.locator(".rs-book");
      await paper.waitFor();
      const chapter = await paper.getAttribute("data-chapter");
      assert.notEqual(chapter, "unavailable", "Real bundled Rule content is available");
      for (const key of ["ArrowRight", "ArrowLeft"]) await page.keyboard.press(key);
      assert.equal(
        await paper.getAttribute("data-chapter"),
        chapter,
        "Retired Rules arrow navigation cannot change the real reader chapter",
      );
      assert.equal(await reader.locator(".rs-curl").count(), 0);
      receipt.readerContent = { chapter, source: "real bundled RulesBookContent/rulesChapters" };
      await focused(reader.locator(".rs-close"), "native modal Close");
      await screenshot("focused-native-modal-close");
      await page.keyboard.press("Escape");
      await reader.waitFor({ state: "detached" });
      assert.equal(await page.locator("[inert]").count(), 0);
      assert.deepEqual(await canonical(), bookBefore);
      receipt.nativeModal =
        "real bundled Rules reader: native showModal inertness; retired arrows inert; native Escape and Close Space cleanup; no authored focus return asserted";
      await rules.click();
      await page.locator("dialog.rules-sketchbook[open] .rs-close").focus();
      await page.keyboard.press("Space");
      await page.locator("dialog.rules-sketchbook[open]").waitFor({ state: "detached" });
      receipt.nativeControls = `player Enter/Space; details Enter/Space; range Home/ArrowRight; select ${receipt.nativeSelectActivation}; Rules Enter; Close Space; native modal Escape`;
      receipt.geometry = await page.evaluate(() => ({
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        scrollY: window.scrollY,
      }));
      assert.ok(receipt.geometry.documentWidth <= receipt.geometry.viewportWidth + 1);
      receipt.nativeAssertions = {
        playerActivations: 2,
        retiredPlayerKeysIgnored: 3,
        drawerEscapeIgnored: 1,
        detailsActivations: 3,
        rangeKeyChanges: 2,
        nativeSelectTypeAhead: ru ? 0 : 1,
        nativeSelectDomChanges: ru ? 1 : 0,
        nativeModalOpens: 2,
        nativeEscapeCloses: 1,
        nativeCloseSpace: 1,
        backgroundFocusRejected: 1,
        focusedControls: receipt.focusedControls.length,
      };
    }
    if (["07", "08"].includes(followupPhase)) {
      await page
        .getByRole("button", {
          name: ru ? "Открыть меню разработчика" : "Open developer menu",
          exact: true,
        })
        .click();
      receipt.disclosures = [];
      for (const selector of [
        ".dev-glass-controls",
        ".player-exit-controls",
        ".fancy-stuff-controls",
      ]) {
        const disclosure = page.locator(selector);
        const read = () =>
          disclosure.evaluate((node) => {
            const style = (el) => {
              const css = getComputedStyle(el);
              const box = el.getBoundingClientRect();
              return {
                width: box.width,
                height: box.height,
                padding: css.padding,
                border: css.border,
                radius: css.borderRadius,
                display: css.display,
                gap: css.gap,
                color: css.color,
                fontSize: css.fontSize,
                minHeight: css.minHeight,
              };
            };
            return {
              open: node.open,
              host: style(node),
              summary: style(node.querySelector(":scope > summary")),
              fields: style(node.querySelector(":scope > div")),
              controls: [...node.querySelectorAll("button,input,select")]
                .filter((el) => el.getClientRects().length > 0)
                .map((el) => ({
                  tag: el.tagName,
                  type: el.type,
                  disabled: el.disabled,
                  label: el.getAttribute("aria-label"),
                  pressed: el.getAttribute("aria-pressed"),
                  style: style(el),
                })),
            };
          });
        const before = await read();
        assert.equal(before.open, false);
        await disclosure.locator(":scope > summary").click();
        const open = await read();
        assert.equal(open.open, true);
        if (selector === ".dev-glass-controls") {
          for (const nested of [".dev-glass-advanced", ".dev-player-card-appearance"]) {
            await disclosure.locator(`${nested} > summary`).click();
            await screenshot(`${selector.slice(1)}-${nested.slice(1)}`);
            await disclosure.locator(`${nested} > summary`).click();
          }
        }
        await disclosure.locator(":scope > summary").scrollIntoViewIfNeeded();
        await screenshot(`${selector.slice(1)}-open`);
        await disclosure.locator(":scope > summary").click();
        const closed = await read();
        assert.equal(closed.open, false);
        receipt.disclosures.push({ selector, before, open, closed });
      }
      if (process.env.UI_FOLLOWUP_BASELINE) {
        const baseline = JSON.parse(
          await readFile(
            join(
              root,
              ".AI/reports/review-followup-2026-10-16",
              process.env.UI_FOLLOWUP_BASELINE,
              `${prefix}-receipt.json`,
            ),
            "utf8",
          ),
        );
        assert.deepEqual(
          receipt.disclosures,
          baseline.disclosures,
          "Disclosure geometry, controls and computed styles remain identical",
        );
      }
      await screenshot("disclosures-closed");
      if (followupPhase === "08") {
        receipt.nativeToggles = [];
        for (const selector of [".dev-glass-controls", ".player-exit-controls"]) {
          const disclosure = page.locator(selector);
          await disclosure.locator(":scope > summary").click();
          for (const button of await disclosure.locator(".dev-setting-toggle").all()) {
            const label = await button.getAttribute("aria-label"),
              before = await button.getAttribute("aria-pressed");
            await button.focus();
            await page.keyboard.press("Enter");
            assert.notEqual(await button.getAttribute("aria-pressed"), before);
            await page.keyboard.press("Space");
            assert.equal(await button.getAttribute("aria-pressed"), before);
            receipt.nativeToggles.push({ label, before, activation: "Enter then Space restored" });
          }
          await disclosure.locator(":scope > summary").click();
        }
        const ray = page.locator(".dev-menu-actions > .dev-setting-toggle").nth(0);
        const pulse = page.locator(".dev-menu-actions > .dev-setting-toggle").nth(1);
        assert.equal(await pulse.isDisabled(), true);
        const pulseBefore = await pulse.getAttribute("aria-pressed");
        await ray.focus();
        await page.keyboard.press("Enter");
        assert.equal(await pulse.isDisabled(), false);
        assert.equal(
          await page.evaluate(() => localStorage.getItem("mafia-dashboard.lighting-renderer.v1")),
          "vgpu",
        );
        await pulse.focus();
        await page.keyboard.press("Enter");
        assert.notEqual(await pulse.getAttribute("aria-pressed"), pulseBefore);
        await page.keyboard.press("Space");
        assert.equal(await pulse.getAttribute("aria-pressed"), pulseBefore);
        await ray.focus();
        await page.keyboard.press("Space");
        assert.equal(await pulse.isDisabled(), true);
        assert.equal(
          await page.evaluate(() => localStorage.getItem("mafia-dashboard.lighting-renderer.v1")),
          "legacy",
        );
        receipt.preferences = await page.evaluate(() =>
          Object.fromEntries(
            Object.entries(localStorage).filter(([key]) =>
              /glass\.v1|player-exit|player-pulse|lighting-renderer/.test(key),
            ),
          ),
        );
        await screenshot("native-toggles-restored");
      }
    }
    assert.deepEqual(receipt.errors, []);
    receipt.status = "passed";
  } catch (error) {
    receipt.status = "failed";
    receipt.failure = error.stack;
    await screenshot("failure");
    throw error;
  } finally {
    results.push(receipt);
    await writeFile(join(evidence, `${prefix}-receipt.json`), JSON.stringify(receipt, null, 2));
  }
}
try {
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
      metafile: Boolean(sourceBefore),
      format: "esm",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": JSON.stringify(mode), "import.meta.env": "{}" },
      loader: { ".svg": "dataurl", ".png": "dataurl", ".webp": "dataurl", ".ttf": "dataurl" },
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
    ...(process.env.GLASS_SCENARIO === "portrait-cards"
      ? [
          { name: "chrome-s6-portrait", engine: chromium, viewport: { width: 700, height: 1100 } },
          { name: "chrome-s6-landscape", engine: chromium, viewport: { width: 1138, height: 712 } },
        ]
      : []),
    ...(followupPhase || process.env.GLASS_SCENARIO === "portrait-cards"
      ? [
          { name: "chrome-phone", engine: chromium, viewport: { width: 390, height: 844 } },
          { name: "chrome-tablet", engine: chromium, viewport: { width: 768, height: 1024 } },
          { name: "webkit-phone", engine: webkit, viewport: { width: 390, height: 844 } },
          { name: "webkit-tablet", engine: webkit, viewport: { width: 768, height: 1024 } },
          { name: "webkit-landscape", engine: webkit, viewport: { width: 1366, height: 768 } },
        ]
      : []),
    { name: "chrome-ipad", engine: chromium, viewport: { width: 1366, height: 1024 } },
    ...(process.env.GLASS_SCENARIO === "tablet-ui"
      ? [
          {
            name: "chrome-browser-chrome",
            engine: chromium,
            viewport: { width: 1376, height: 900 },
          },
        ]
      : []),
    { name: "webkit-ipad", engine: webkit, viewport: { width: 1366, height: 1024 } },
    ...(process.env.GLASS_SCENARIO === "player-cards"
      ? [{ name: "webkit-landscape", engine: webkit, viewport: { width: 1366, height: 768 } }]
      : []),
    { name: "webkit-compact", engine: webkit, viewport: { width: 1000, height: 600 } },
    { name: "chrome-landscape", engine: chromium, viewport: { width: 1366, height: 768 } },
    { name: "chrome-compact", engine: chromium, viewport: { width: 1000, height: 600 } },
  ].filter(
    (config) =>
      (!followupPhase ||
        (["12", "13"].includes(followupPhase)
          ? ["chrome-landscape", "chrome-compact", "webkit-ipad"].includes(config.name)
          : (process.env.UI_FOLLOWUP_ENGINE === "webkit"
              ? ["webkit-phone", "webkit-tablet", "webkit-landscape"]
              : ["chrome-phone", "chrome-tablet", "chrome-landscape"]
            ).includes(config.name))) &&
      (!process.env.GLASS_BROWSER || config.name === process.env.GLASS_BROWSER),
  )) {
    const browser = await config.engine.launch({
      headless: true,
      ...(config.engine === chromium && (!followupPhase || ["12", "13"].includes(followupPhase))
        ? { channel: "chrome" }
        : {}),
    });
    try {
      if (process.env.GLASS_SCENARIO === "portrait-cards") {
        if (process.env.PORTRAIT_NIGHT_ONLY === "1")
          await verifyPortraitNightLayout({ browser, config, url, evidence, results });
        else await verifyPortraitCards({ browser, config, url, evidence, results });
        continue;
      }
      if (process.env.GLASS_SCENARIO === "tablet-ui") {
        await verifyTabletUi({ browser, config, url, evidence, results });
        continue;
      }
      if (process.env.GLASS_SCENARIO === "host-ui") {
        assert.ok(!followupPhase, "Select only one focused scenario");
        await verifyHostUi({ browser, config, url, evidence, results });
        continue;
      }
      if (process.env.GLASS_SCENARIO === "player-cards") {
        assert.ok(!followupPhase, "Select only one focused scenario");
        await verifyPlayerCards({ browser, config, url, evidence, results });
        continue;
      }
      if (followupPhase) {
        for (const enhanced of [false, true])
          for (const locale of ["en", "ru"]) {
            const page = await browser.newPage({ viewport: config.viewport });
            try {
              await verifyFollowup(page, url, { engine: config.name, enhanced, locale });
            } finally {
              await page.close();
            }
          }
        continue;
      }
      if (!process.env.GLASS_SCENARIO || process.env.GLASS_SCENARIO === "shared")
        await verifySharedPlayerGlass({ browser, config, url, evidence, results });
      if (process.env.GLASS_SCENARIO === "shared") continue;
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
        if (!empty)
          await setupPage.waitForFunction(
            () =>
              document.querySelector("#host-player")?.value === "Host" &&
              document.querySelector("#seat-10-player")?.value === "Player 10",
          );
        assert.equal(
          await setupPage.locator("#host-player").getAttribute("value"),
          empty ? "" : "Host",
        );
        assert.equal(
          await setupPage.locator("#seat-10-player").getAttribute("value"),
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
              // The published layout keeps safe-area clearance in the controls
              // footer, not the side-panel wrapper. Measure the actual content.
              const content =
                selector === ".live-side-panel" ? el.querySelector(".live-music-controls") : el;
              if (!content) throw new Error("Missing panel content for safe-area measurement");
              const contentBounds = content.getBoundingClientRect();
              const style = getComputedStyle(content);
              return {
                top: bounds.top,
                bottom: bounds.bottom,
                height: bounds.height,
                width: bounds.width,
                contentBottom:
                  innerHeight -
                  contentBounds.bottom +
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
          // Music controls can be absent when the account is unconfigured.
          // Verify the last visible interactive control, not an empty panel edge.
          const controls = [
            ...document.querySelectorAll(".live-side-panel :is(button,input,select)"),
          ].filter(
            (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility === "visible",
          );
          if (!controls.length) throw new Error("Missing live panel controls");
          const controlBottom = Math.max(
            ...controls.map((el) => el.getBoundingClientRect().bottom),
          );
          const tableStage = document.querySelector(".table-stage").getBoundingClientRect();
          return {
            left: table.left,
            right: innerWidth - side.right,
            tableBottom: innerHeight - table.bottom,
            sideBottom: innerHeight - side.bottom,
            sideContentBottom: innerHeight - controlBottom,
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
      assert.equal(await page.locator(".table-stage .liquid-card-glass").count(), 10);
      assert.ok(
        await page
          .locator('.table-stage [data-player-glass="table"]')
          .evaluateAll((nodes) => nodes.every((node) => node.dataset.glassPainted === "true")),
      );
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
      const compare = async (key, threshold = 3) =>
        page.evaluate(
          ({ key, threshold }) => {
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
                    threshold
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
          },
          { key, threshold },
        );
      // Keep the existing >10-pixel displacement proof on the legacy simple
      // profile. Illuminate the sampled source instead of lowering thresholds
      // when a compact/square row sits in a nearly uniform dark background.
      await setRange("Gold background light", 100);
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
      await setRange("Gold background light", 25);
      // Matte changes only material samples, not optics, geometry, state or
      // graphics resources. Read actual GPU pixels, not just accepted uniforms.
      const materialState = () =>
        page
          .locator(".table-stage .table-card.player-seat,.nomination-panel li")
          .evaluateAll((elements) =>
            elements.map((el) => {
              const style = getComputedStyle(el);
              return {
                rect: el.getBoundingClientRect().toJSON(),
                classes: el.className,
                text: el.textContent,
                border: style.borderColor,
                shadow: style.boxShadow,
                color: style.color,
                contentFilters: [...el.querySelectorAll("strong,span,button")].map(
                  (child) => getComputedStyle(child).filter,
                ),
              };
            }),
          );
      const preservedMaterial = await materialState();
      const matteToggle = page.getByRole("button", { name: "Disable matte glass" });
      assert.equal(await matteToggle.getAttribute("aria-pressed"), "true");
      assert.ok((await matteToggle.boundingBox()).height >= 48);
      await save("matteOn");
      const beforeMatte = await page
        .locator(".glass-scene-canvas")
        .getAttribute("data-glass-draws");
      await page.evaluate(() => {
        window.matteContext = document.querySelector(".glass-scene-canvas").getContext("webgl");
        window.matteProgram = window.matteContext.getParameter(window.matteContext.CURRENT_PROGRAM);
      });
      await matteToggle.focus();
      await page.keyboard.press("Space");
      await page.waitForFunction(
        (before) =>
          Number(document.querySelector(".glass-scene-canvas").dataset.glassDraws) > Number(before),
        beforeMatte,
      );
      const matte = await compare("matteOn", 0);
      assert.equal(matte.surfaces.length, 12);
      assert.ok(
        matte.surfaces.every((count) => count > 10),
        JSON.stringify(matte),
      );
      assert.equal(matte.outside, 0);
      assert.deepEqual(await materialState(), preservedMaterial);
      assert.equal(await range("Refraction strength").inputValue(), "24");
      assert.equal(await range("Gold background light").inputValue(), "25");
      assert.equal(
        await page.evaluate(() => {
          const gl = document.querySelector(".glass-scene-canvas").getContext("webgl");
          return (
            gl === window.matteContext &&
            gl.getParameter(gl.CURRENT_PROGRAM) === window.matteProgram
          );
        }),
        true,
      );
      assert.equal(
        await page.getByRole("button", { name: "Enable matte glass" }).getAttribute("aria-pressed"),
        "false",
      );
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
        // Compact utilities scroll independently of the fixed music footer.
        await row.scrollIntoViewIfNeeded();
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
        const hit = await row.evaluate(
          (node, point) => {
            const element = document.elementFromPoint(point.x, point.y);
            return {
              matches: element?.closest("button") === node.querySelector("button"),
              element: element?.outerHTML.slice(0, 500),
            };
          },
          { x, y: box.y + box.height / 2 },
        );
        assert.ok(hit.matches, `${config.name} ${target}: ${JSON.stringify({ box, hit })}`);
        await page.touchscreen.tap(x, box.y + box.height / 2);
        await page.waitForFunction(
          () =>
            document
              .querySelectorAll(".nomination-panel li button")[1]
              ?.getAttribute("aria-pressed") === "true",
        );
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
      await page.waitForFunction(() => {
        const card = document.querySelector('.seat-anchor[data-seat="1"] > .player-seat');
        const style = getComputedStyle(card);
        return Number(style.opacity) === 0.55 && style.scale === "0.88";
      });
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
      assert.match(
        await page
          .locator(".liquid-card-glass__backdrop")
          .first()
          .evaluate(
            (el) =>
              getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter,
          ),
        /blur\(0px\)/,
      );
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
      assert.equal(
        await page.getByRole("button", { name: "Enable matte glass" }).getAttribute("aria-pressed"),
        "false",
      );
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
      await page.waitForFunction(
        () => document.querySelector(".app-shell")?.dataset.glassStatus === "ready",
      );
      assert.equal(await canvas.count(), 1);
      assert.equal(await range("Gold background light").inputValue(), "25");
      assert.equal(await range("Refraction strength").inputValue(), "14");
      assert.equal(
        await page
          .getByRole("button", { name: "Disable matte glass" })
          .getAttribute("aria-pressed"),
        "true",
      );
      // Reset is now ON. Explicitly request OFF for the retained fallback,
      // resource-release and denied-storage checks; do not weaken those checks.
      await page.getByRole("button", { name: "Disable enhanced glass" }).click();
      assert.equal(await shell.getAttribute("data-glass-status"), "off");
      assert.equal(await canvas.count(), 0);
      const fallbackBlur = () =>
        page
          .locator(".liquid-card-glass__backdrop")
          .evaluateAll((elements) =>
            elements.map(
              (el) =>
                getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter,
            ),
          );
      // The global reduced-motion rule still leaves a 0.01ms transition;
      // wait for the actual material value rather than sampling its first frame.
      await page.waitForFunction(() =>
        [...document.querySelectorAll(".liquid-card-glass__backdrop")].every((el) =>
          /blur\((2|0\.6)px\)/.test(
            getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter,
          ),
        ),
      );
      const fallbackFilters = await fallbackBlur();
      assert.ok(
        fallbackFilters.every((filter) => /blur\((2|0\.6)px\)/.test(filter)),
        JSON.stringify(fallbackFilters),
      );
      assert.equal(await page.evaluate(() => window.releasedGlass.isContextLost()), true);
      await setRange("Gold background light", 0);
      await page.waitForFunction(
        () =>
          Number(
            getComputedStyle(document.querySelector(".app-shell")).getPropertyValue(
              "--glass-gold-light",
            ),
          ) === 0,
      );
      const fallbackZero = await shell.evaluate(
        (el) => getComputedStyle(el, "::before").backgroundImage,
      );
      await setRange("Gold background light", 100);
      await page.waitForFunction(
        () =>
          Number(
            getComputedStyle(document.querySelector(".app-shell")).getPropertyValue(
              "--glass-gold-light",
            ),
          ) === 1,
      );
      await page.waitForFunction(
        (before) =>
          getComputedStyle(document.querySelector(".app-shell"), "::before").backgroundImage !==
          before,
        fallbackZero,
      );
      const fallbackFull = await shell.evaluate(
        (el) => getComputedStyle(el, "::before").backgroundImage,
      );
      assert.notEqual(
        fallbackZero,
        fallbackFull,
        "Gold tuning changes the continuous fallback scene",
      );
      assert.match(fallbackZero, /linear-gradient/, "The base scene remains when gold is zero");
      assert.equal(await shell.evaluate((el) => getComputedStyle(el, "::before").opacity), "1");
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
      await page.getByRole("button", { name: "Disable matte glass" }).click();
      await page.waitForFunction(() =>
        [...document.querySelectorAll(".liquid-card-glass__backdrop")].every((el) =>
          /blur\(0px\)/.test(
            getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter,
          ),
        ),
      );
      assert.ok((await fallbackBlur()).every((filter) => /blur\(0px\)/.test(filter)));
      assert.equal(
        await page.evaluate(
          () => JSON.parse(localStorage.getItem("mafia-dashboard.glass.v1")).matte,
        ),
        true,
      );
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
        matte,
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
        await phasePage.getByRole("button", { name: "Disable matte glass" }).click();
        assert.deepEqual(await readGlow(), glow);
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
        assert.equal(
          await phasePage.locator(".player-role-icon[role=img]").count(),
          phase === "day" ? 0 : 10,
        );
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
          await phasePage.screenshot({
            path: join(evidence, `${config.name}-${phase}-reduced-transparency.png`),
          });
          const material = await phasePage
            .locator(".liquid-card-glass__backdrop")
            .first()
            .evaluate((el) => ({
              background: getComputedStyle(el).backgroundColor,
              hostBackground: getComputedStyle(el.closest("[data-player-glass]")).backgroundColor,
              filter: getComputedStyle(el).backdropFilter,
            }));
          console.log("ACCESSIBILITY MATERIAL", config.name, phase, JSON.stringify(material));
          assert.equal(material.filter, "none");
          assert.equal(material.background, "rgb(27, 37, 32)");
          await phasePage.waitForFunction(() =>
            [...document.querySelectorAll(".nomination-panel li")].every(
              (el) =>
                getComputedStyle(el).backgroundColor === "rgb(27, 37, 32)" &&
                getComputedStyle(el).backdropFilter === "none",
            ),
          );
          const opaqueRows = await phasePage
            .locator(".nomination-panel li")
            .evaluateAll((elements) =>
              elements.map((el) => ({
                background: getComputedStyle(el).backgroundColor,
                filter: getComputedStyle(el).backdropFilter,
              })),
            );
          for (const row of opaqueRows)
            assert.deepEqual(row, { background: "rgb(27, 37, 32)", filter: "none" });
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
      assert.equal(await failed.locator(".liquid-card-glass").count(), 12);
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
      assert.equal(await strict.locator(".liquid-card-glass").count(), 12);
      assert.ok(
        await strict
          .locator("[data-player-glass]")
          .evaluateAll((nodes) => nodes.every((node) => node.dataset.glassPainted === "true")),
      );
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

  if (["12", "13"].includes(followupPhase))
    assert.equal(
      results.length,
      (process.env.GLASS_BROWSER ? 1 : 3) * 4,
      "Native interaction matrix must complete every selected engine/layout, locale and mode",
    );
  console.log(JSON.stringify(results, null, 2));
  if (process.env.GLASS_SCENARIO === "portrait-cards")
    assert.ok(
      results.length >= (process.env.PORTRAIT_NIGHT_ONLY === "1" ? 1 : 3),
      "Portrait matrix cannot pass without running selected cases",
    );
  if (["player-cards", "portrait-cards"].includes(process.env.GLASS_SCENARIO))
    assert.equal(
      results.filter((result) => result.status === "failed").length,
      0,
      "Player-card regression failures; see retained per-case evidence",
    );
} finally {
  // Persist partial/failing runs too, appending rather than erasing prior evidence.
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
  const resultsPath = join(evidence, "browser-results.json");
  const previous = await previousResults(resultsPath);
  await writeFile(
    resultsPath,
    JSON.stringify(
      {
        scope: "Actual application workspace with isolated synthetic canonical game/API transport",
        physicalIpadStandalone: "not verified",
        results: [...previous, ...results.map((result) => ({ runId, ...result }))],
      },
      null,
      2,
    ),
  );
  await new Promise((done) => server?.close(done) ?? done());
  await rm(temp, { recursive: true, force: true });
}
