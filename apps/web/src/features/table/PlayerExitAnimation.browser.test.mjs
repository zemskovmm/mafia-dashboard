/* global document, window, getComputedStyle, DOMMatrix, console */
// Real components and domain transitions; synthetic recordings, no backend/account data.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { runDepartureScenarios } from "./player-departure.browser-scenarios.mjs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { build } from "esbuild";
import { chromium, webkit } from "@playwright/test";
import { PNG } from "pngjs";

const directory = dirname(fileURLToPath(import.meta.url));
const repository = join(directory, "../../../../..");
const evidenceRoot = join(repository, ".AI/card-completion/player-departure");
await mkdir(evidenceRoot, { recursive: true });
const output = await mkdtemp(join(evidenceRoot, "browser-"));
console.log(`Player departure evidence: ${output}`);
const built = await build({
  stdin: {
    contents: `
      import React, { useState } from "react";
      import { createRoot } from "react-dom/client";
      import * as domain from "@mafia/game-domain";
      import { GameScreen } from ${JSON.stringify(join(directory, "../game/GameScreen.tsx"))};
      import { PlayerExitControls } from ${JSON.stringify(join(directory, "../developer/PlayerExitControls.tsx"))};
      import { DEFAULT_PLAYER_EXIT_SETTINGS } from ${JSON.stringify(join(directory, "../effects/player-exit-preferences.ts"))};
      import { PlayerDirectoryProvider } from ${JSON.stringify(join(directory, "../players/player-display.tsx"))};
      import { GlassScene } from ${JSON.stringify(join(directory, "../theme/GlassScene.tsx"))};
      import { SharedGlassContext } from ${JSON.stringify(join(directory, "../theme/SharedGlassContext.ts"))};
      import { DEFAULT_GLASS_SETTINGS } from ${JSON.stringify(join(directory, "../theme/glass-preferences.ts"))};
      import { PlayerCardStyleContext } from ${JSON.stringify(join(directory, "../theme/PlayerCardStyleContext.ts"))};
      import { FancyFeaturesContext } from ${JSON.stringify(join(directory, "../effects/FancyFeaturesContext.tsx"))};
      import { projectPlayerActions } from ${JSON.stringify(join(directory, "../game/player-action-presentation.ts"))};
      import { playerDepartureTimeline } from ${JSON.stringify(join(directory, "../effects/player-departure-timeline.ts"))};
      import { PLAYER_TEAR_SEAM_POINTS } from ${JSON.stringify(join(directory, "../effects/player-tear-geometry.ts"))};
      import ${JSON.stringify(join(directory, "../theme/GlassScene.css"))};
      import ${JSON.stringify(join(directory, "../theme/AppBackground.css"))};
      let restored;try{restored=JSON.parse(sessionStorage.getItem('exit-fixture')??'null')}catch{}
      const profiles = Array.from({length:10},(_,i)=>({id:'player-'+(i+1),nickname:'Player '+(i+1)}));
      function day() {
        let setup = domain.beginRoleDraw(domain.createSetup(profiles.map((p,i)=>({id:p.id,seat:i+1}))),domain.createSeededRandom(13));
        for(let seat=1;seat<=10;seat++) setup=domain.drawRoleForSeat(setup,seat);
        let game=domain.createGame(domain.completeRoleDraw(setup),{bestMoveEnabled:false});
        for(let i=0;i<8 && game.phase!=='day';i++) game=domain.advanceSetupPhase(game);
        return game;
      }
      function Fixture() {
        const [snapshot,setSnapshot]=useState(()=>restored?.snapshot??({game:day(),frames:[]}));
        const {game,frames}=snapshot;
        const setGame=next=>setSnapshot(s=>({...s,game:typeof next==='function'?next(s.game):next}));
        const accept=draft=>setSnapshot(s=>{
          const result=domain.createGameLogEntry({gameId:'browser-fixture',id:'event-'+(s.frames.length+1),sequence:s.frames.length+1,parentEventId:s.frames.at(-1)?.entry.id??null,createdAt:'2026-10-28T12:00:00.000Z',before:s.game,draft});
          return {game:result.after,frames:[...s.frames,{before:s.game,...result}]};
        });
        const [generation,setGeneration]=useState(0);
        const [settings,setSettings]=useState(restored?.settings??DEFAULT_PLAYER_EXIT_SETTINGS);
        const [privacy,setPrivacy]=useState(true);
        const [mode,setMode]=useState('live');
        const [glass,setGlass]=useState(restored?.glass??false);
        const [glassStatus,setGlassStatus]=useState('off');
        const [background,setBackground]=useState(restored?.background??'black');
        const [longNames,setLongNames]=useState(false);
        const [style,setStyle]=useState(restored?.style??'glass');
        const [fancy,setFancy]=useState(true);
        const [projected,setProjected]=useState(restored?.projected??false);
        const victim=game.players.find(p=>p.role==='citizen').seat;
        window.exitFixture={game,frames,settings,victim,style,generation,setSettings,setPrivacy,setMode,setGlass,setStyle,setFancy,setProjected,setBackground,setLongNames,accept,
          timeline:cause=>playerDepartureTimeline(settings,cause),defaultSettings:DEFAULT_PLAYER_EXIT_SETTINGS,seam:PLAYER_TEAR_SEAM_POINTS,
          restore(){setGeneration(g=>g+1);},
          save(){sessionStorage.setItem('exit-fixture',JSON.stringify({snapshot,settings,style,glass,projected,background}));},
          load(kind='goodbye') {
            const initial=day();
            const seats=initial.players.filter(p=>p.role==='citizen').map(p=>p.seat);
            let next=kind==='goodbye' ? domain.completeEliminations(initial,seats.slice(0,2)) : kind==='finished' ? domain.completeEliminations(initial,seats.slice(0,4)) : kind==='night' ? domain.beginNight(initial) : initial;
            // Unknown-cause baselines stay in active play: completed games reveal all fronts.
            if(kind==='unknown') {
              next=domain.completeGoodbyeSpeech(domain.completeEliminations(initial,seats.slice(0,2)));
              next=domain.completeMafiaShots(domain.resolveMafiaShots(next).game);
              next=domain.skipDonCheck(next);
              next=domain.skipSheriffCheck(next);
              next=domain.completeNight(next);
            }
            setGeneration(g=>g+1);setSnapshot({game:next,frames:[]});setMode('live');
          },
          exclude(){accept({type:'discipline.removal-observed',payload:{seat:victim,stage:game.phase==='goodbye-speech'?'goodbye-speech':'day-discussion',rule:'6.2.3',reason:'Fixture violation',checkInProgress:false}});},
          announce(){accept({type:'discipline.removals-announced',payload:{seats:[victim]}});},
          foul(){const next=domain.issueFoul(game,victim),p=next.players.find(p=>p.seat===victim);accept({type:'foul.issued',payload:{seat:victim,foulNumber:p.fouls,redCarded:p.status==='red-carded',phase:game.phase,currentTurnIndex:game.currentTurnIndex}});},
          resolveShot(){const resolved=domain.resolveMafiaShots(domain.toggleAllMafiaShotsForTarget(game,victim));accept({type:'mafia.shots-resolved',payload:{shots:resolved.secretShots,result:resolved.result}});},
          advance(){const next=game.phase.startsWith('night-mafia')?domain.completeMafiaShots(game):game.phase==='night-don'?domain.skipDonCheck(game):game.phase==='night-sheriff'?domain.skipSheriffCheck(game):game.phase==='goodbye-speech'?domain.completeGoodbyeSpeech(game):domain.completeNight(game);accept({type:game.phase==='night-don'?'don.check-skipped':game.phase==='night-sheriff'?'sheriff.check-skipped':'phase.changed',payload:game.phase==='night-don'||game.phase==='night-sheriff'?{}:{to:next.phase}});},
          terminal(){setGame(g=>domain.completeEliminations(g,g.players.filter(p=>p.role==='citizen'&&p.status==='active').slice(0,4).map(p=>p.seat)));},
          correction(){setGeneration(g=>g+1);setSnapshot({game:day(),frames:[]});},
        };
        return <FancyFeaturesContext.Provider value={fancy}><PlayerCardStyleContext.Provider value={{style,rolePlacement:'below'}}><SharedGlassContext.Provider value={glass&&glassStatus==='ready'}><div className='app-background-root' data-background={background} data-background-kind='plain'><div className='app-background' aria-hidden='true'/>
          <div className={'app-shell exit-fixture-layout is-background-'+background} data-glass-settings='local' data-glass-status={glass?glassStatus:'off'} data-lighting-renderer='legacy' style={{'--glass-gold-light':.25,'--glass-matte-blur':'2px','--glass-matte-lens-blur':'.6px','--glass-tint':.13,'--glass-edge-highlights':1,'--glass-caustics':1}}>
            {glass?<GlassScene background={background} settings={{...DEFAULT_GLASS_SETTINGS,enabled:true}} onStatus={setGlassStatus}/>:null}
            <PlayerDirectoryProvider profiles={longNames?profiles.map(p=>({...p,nickname:p.nickname+' · Exceptionally long public nickname'})):profiles}>
              <GameScreen key={generation+':'+mode} game={game} playerPresentation={projected?projectPlayerActions(frames,game):undefined} playerExitSettings={settings} mode={mode} hostName='Host' privacyHidden={privacy} onGameChange={setGame} onEvent={()=>{}} onAcceptedEvent={accept}/>
            </PlayerDirectoryProvider>
            <aside className='dev-menu-actions'><PlayerExitControls settings={settings} onChange={setSettings}/></aside>
          </div>
        </div></SharedGlassContext.Provider></PlayerCardStyleContext.Provider></FancyFeaturesContext.Provider>;
      }
      createRoot(document.getElementById('fixture')).render(<Fixture/>);
    `,
    loader: "tsx",
    sourcefile: "player-exit-fixture.tsx",
    resolveDir: repository,
  },
  bundle: true,
  jsx: "automatic",
  format: "iife",
  platform: "browser",
  loader: { ".webp": "dataurl", ".ttf": "dataurl", ".svg": "dataurl" },
  outfile: join(output, "fixture.js"),
  write: false,
  metafile: true,
});
const javascript = built.outputFiles.find((file) => file.path.endsWith(".js"))?.text;
const stylesheet = built.outputFiles.find((file) => file.path.endsWith(".css"))?.text;
assert.ok(javascript && stylesheet);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const inputPaths = Object.keys(built.metafile.inputs)
  .filter((path) => !path.endsWith("player-exit-fixture.tsx"))
  .concat(
    "apps/web/src/styles/app.css",
    "apps/web/src/features/table/PlayerExitAnimation.browser.test.mjs",
    "apps/web/src/features/table/player-departure.browser-scenarios.mjs",
  );
const sourceHashes = Object.fromEntries(
  await Promise.all(
    [...new Set(inputPaths.map((path) => path.split("?")[0]))]
      .sort()
      .map(async (path) => [path, hash(await readFile(join(repository, path)))]),
  ),
);
await writeFile(
  join(output, "source-manifest.json"),
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      javascript: hash(javascript),
      stylesheet: hash(stylesheet),
      sources: sourceHashes,
    },
    null,
    2,
  ),
);
after(async () => {
  const changed = [];
  for (const [path, digest] of Object.entries(sourceHashes))
    if (hash(await readFile(join(repository, path))) !== digest) changed.push(path);
  await writeFile(
    join(output, "source-stability.json"),
    JSON.stringify({ stable: changed.length === 0, changed }, null, 2),
  );
  assert.deepEqual(
    changed,
    [],
    "Browser evidence must be tied to unchanged bundled source; re-run after owner handoffs if this fails",
  );
});
const appCss = (await readFile(join(repository, "apps/web/src/styles/app.css"), "utf8")).replace(
  /^@import[^;]+;/m,
  "",
);
const fixtureCss = `.exit-fixture-layout{display:block;padding:20px;max-width:none}aside{position:fixed;right:20px;top:20px;width:300px;z-index:20;max-height:95vh;overflow:auto}body[data-departure-scenarios] aside{display:none}[data-pixel-hidden],[data-pixel-hidden] *{visibility:hidden!important}@media(max-width:600px){.exit-fixture-layout .game-shell{display:none}aside{position:relative;right:auto;top:auto;width:auto}}`;
await writeFile(
  join(output, "fixture.html"),
  `<!doctype html><meta charset="utf-8"><title>Player exit · real component verification</title><style>${appCss}\n${stylesheet}\n${fixtureCss}</style><div id="fixture"></div><script>${javascript.replaceAll("</script", "<\\/script")}</script>`,
);

const cardSelector = (seat) => `.seat-anchor[data-seat="${seat}"] > .player-seat`;
const near = (a, b, label) => assert.ok(Math.abs(a - b) < 0.7, `${label}: ${a} / ${b}`);
const pixelDifference = (before, after) => {
  const a = PNG.sync.read(before),
    b = PNG.sync.read(after);
  assert.deepEqual([a.width, a.height], [b.width, b.height]);
  let max = 0,
    painted = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let delta = 0;
    for (let channel = 0; channel < 4; channel++)
      delta = Math.max(delta, Math.abs(a.data[i + channel] - b.data[i + channel]));
    max = Math.max(max, delta);
    if (delta > 1) painted++;
  }
  return { max, painted };
};
const sample = async (page, fraction) => {
  await page.evaluate((value) => {
    const host = document.querySelector(".seat-anchor [data-player-exit]");
    const timeline = window.exitFixture.timeline(host?.dataset.departureCause);
    const elapsed =
      timeline.turnStart +
      (window.exitFixture.settings.liftMs + window.exitFixture.settings.landingMs) * value;
    for (const animation of document
      .getAnimations()
      .filter((a) => /^(player-exit-|printed-card-exit-)/.test(a.id))) {
      animation.pause();
      animation.currentTime = elapsed;
    }
  }, fraction);
};
const begin = async (page) => {
  await page.evaluate(() => window.exitFixture.load("goodbye"));
  await page.getByRole("button", { name: "Begin night", exact: true }).waitFor();
  const victim = await page.evaluate(() => window.exitFixture.victim);
  assert.equal(
    await page.locator(`${cardSelector(victim)} .deceased-cross`).count(),
    0,
    "No crossed final face before goodbye finishes",
  );
  assert.equal(await page.locator(".seat-anchor [data-player-exit]").count(), 0);
  await page.getByRole("button", { name: "Begin night", exact: true }).click();
  await page.locator(`${cardSelector(victim)}[data-player-exit]`).waitFor();
  return victim;
};

for (const [name, engine, launch] of [
  ["chrome", chromium, { channel: "chrome" }],
  ["webkit", webkit, {}],
]) {
  test(
    `${name}: real settings, phase transitions and correctly oriented exit faces`,
    { timeout: 120000 },
    async () => {
      const browser = await engine.launch({ ...launch, headless: true });
      const page = await browser.newPage({
        viewport: name === "webkit" ? { width: 1024, height: 768 } : { width: 1366, height: 1024 },
        hasTouch: name === "webkit",
        recordVideo: { dir: output, size: { width: 1366, height: 1024 } },
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await page.setContent('<div id="fixture"></div>');
        await page.addStyleTag({ content: appCss + stylesheet + fixtureCss });
        await page.addScriptTag({ content: javascript });
        await page.getByText("Player exit animation", { exact: true }).first().waitFor();
        await page.locator(".player-exit-controls > summary").click();
        assert.equal(await page.getByLabel("Lift duration", { exact: true }).inputValue(), "100");
        assert.equal(
          await page.getByLabel("Landing duration", { exact: true }).inputValue(),
          "480",
        );
        assert.equal(
          await page.getByLabel("Lift / flip overlap", { exact: true }).inputValue(),
          "100",
        );
        assert.equal(
          await page.getByLabel("Final departed-card opacity", { exact: true }).inputValue(),
          "45",
        );
        assert.equal(
          await page.getByLabel("Departure fade duration", { exact: true }).inputValue(),
          String(await page.evaluate(() => window.exitFixture.settings.fadeMs)),
        );
        for (const phase of ["Lift", "Flip", "Drop"])
          assert.equal(
            await page.getByLabel(`${phase} easing`, { exact: true }).inputValue(),
            "out",
          );
        const originalGame = await page.evaluate(() => JSON.stringify(window.exitFixture.game));
        await page.getByRole("button", { name: "Preview exit", exact: true }).click();
        await page.waitForFunction(
          () => !document.querySelector(".player-exit-preview [data-player-exit]"),
        );
        assert.equal(
          await page.evaluate(() => JSON.stringify(window.exitFixture.game)),
          originalGame,
        );
        await page.screenshot({ path: join(output, `${name}-settings.png`) });
        // The selected defaults run to completion without a synthetic animation clock.
        let victim = await begin(page);
        assert.equal(
          await page.locator(".seat-anchor [data-player-exit]").count(),
          2,
          "Every goodbye victim animates through the table replacement",
        );
        await page.waitForFunction(
          () => !document.querySelector(".seat-anchor [data-player-exit]"),
        );
        assert.equal(
          await page.locator(`${cardSelector(victim)} .player-torn-fragment`).count(),
          2,
        );
        assert.equal(
          await page
            .locator(cardSelector(victim))
            .evaluate((card) => getComputedStyle(card).rotate),
          "none",
        );
        // Longer allowed timings leave room for actual rendering/pixel inspection, without freezing expiry.
        await page.getByLabel("Lift duration", { exact: true }).press("End");
        await page.getByLabel("Landing duration", { exact: true }).press("End");
        for (const fraction of [0.08, 0.7]) {
          victim = await begin(page);
          await sample(page, fraction);
          const card = page.locator(cardSelector(victim));
          const pose = await card.evaluate((element) => ({
            rotate: getComputedStyle(element).rotate,
            front: getComputedStyle(element.querySelector(".player-exit-front")).visibility,
            back: getComputedStyle(element.querySelector(".player-exit-back")).visibility,
            reverseNames: element.querySelectorAll(".player-exit-back .seat-name").length,
            visibleNames: [
              ...element.parentElement.querySelectorAll(":scope > .player-seat-caption"),
            ]
              .filter((node) => getComputedStyle(node).visibility === "visible")
              .map((node) => node.textContent),
            roles: element.querySelectorAll(".player-role-icon[role=img]").length,
            glass: element.querySelectorAll(":scope > .liquid-card-glass").length,
          }));
          assert.notEqual(pose.rotate, "none");
          assert.equal(pose.glass, 1);
          assert.equal(pose.roles, 0, "Daytime privacy survives transition into the night table");
          assert.equal(pose.front, fraction < 0.5 ? "visible" : "hidden");
          assert.equal(pose.back, fraction < 0.5 ? "hidden" : "visible");
          assert.equal(pose.reverseNames, 0, "Known Glass reverses never contain a player name");
          assert.deepEqual(
            pose.visibleNames,
            [`Player ${victim}`],
            "The public external caption survives both sides of the Glass turn",
          );
          assert.ok(
            await card.evaluate((element) => {
              const degrees = parseFloat(getComputedStyle(element).rotate.split(" ").at(-1));
              const face = [...element.querySelectorAll(".player-exit-face")].find(
                (node) => getComputedStyle(node).visibility === "visible",
              );
              return (
                Math.cos((degrees * Math.PI) / 180) *
                  new DOMMatrix(getComputedStyle(face).transform).m11 >
                0
              );
            }),
            "The visible face counter-rotates identity instead of mirroring it",
          );
          await page.screenshot({
            path: join(output, `${name}-${fraction < 0.5 ? "rising" : "revealed"}.png`),
          });
          const hidden = card.locator(fraction < 0.5 ? ".player-exit-back" : ".player-exit-front");
          const pixels = await card.screenshot({
            path: join(output, `${name}-${fraction}-face-before.png`),
          });
          await hidden.evaluate((element) =>
            element.style.setProperty("display", "none", "important"),
          );
          const hiddenPixels = await card.screenshot({
            path: join(output, `${name}-${fraction}-face-hidden.png`),
          });
          // WebKit recomposition changed 102 pixels by one channel level, including the glass rim.
          // Do not confuse that measured quantization with face bleed or missing painted identity.
          assert.ok(
            pixelDifference(pixels, hiddenPixels).max <= 1,
            `${name} at ${fraction}: no visible hidden-face bleed`,
          );
          const visible = card.locator(fraction < 0.5 ? ".player-exit-front" : ".player-exit-back");
          await visible.evaluate((element) =>
            element.style.setProperty("display", "none", "important"),
          );
          const painted = pixelDifference(pixels, await card.screenshot());
          assert.ok(
            painted.max > 16 && painted.painted > 100,
            "The visible identity must really paint, not disappear behind flattened glass",
          );
        }
        victim = await begin(page);
        const target = page.locator(cardSelector(victim));
        const finalSize = await target.evaluate((element) => ({
          width: element.offsetWidth,
          height: element.offsetHeight,
        }));
        const neighbor = page.locator(cardSelector(victim === 10 ? 1 : 10));
        const before = await neighbor.boundingBox();
        await page.evaluate(() =>
          document
            .getAnimations()
            .filter((a) => a.id.startsWith("player-exit-"))
            .forEach((a) => a.finish()),
        );
        await page.waitForFunction(
          () => !document.querySelector(".seat-anchor [data-player-exit]"),
        );
        const after = await neighbor.boundingBox();
        for (const key of ["x", "y", "width", "height"])
          near(before[key], after[key], `Neighbor ${key}`);
        const landed = await target.boundingBox();
        for (const key of ["width", "height"])
          near(landed[key], finalSize[key], `Final tile ${key}`);
        await page.waitForTimeout(180);
        const settled = await target.boundingBox();
        for (const key of ["x", "y", "width", "height"])
          near(landed[key], settled[key], `Stable landing ${key}`);
        assert.equal(
          await page.evaluate(
            () =>
              document
                .getAnimations()
                .filter((animation) => animation.id.startsWith("player-exit-")).length,
          ),
          0,
          "Exit animations are cleaned up after landing",
        );
        assert.equal(
          await page
            .locator(cardSelector(victim))
            .evaluate(
              (element) =>
                element.querySelector(".liquid-card-glass") === element.firstElementChild,
            ),
          true,
        );
        for (const overlap of [0, 50]) {
          const control = page.getByLabel("Lift / flip overlap", { exact: true });
          await control.press("Home");
          for (let index = 0; index < overlap / 5; index++) await control.press("ArrowRight");
          victim = await begin(page);
          await sample(page, 0.27);
          const rotation = await page
            .locator(cardSelector(victim))
            .evaluate((element) => parseFloat(getComputedStyle(element).rotate.split(" ").at(-1)));
          if (overlap === 0) near(rotation, 0, "Zero overlap waits for lift completion");
          else assert.ok(rotation > 1, "Partial overlap turns during pickup");
          const id = await page.locator(cardSelector(victim)).getAttribute("data-player-exit");
          await page.getByLabel("Landing duration", { exact: true }).press("ArrowLeft");
          assert.equal(
            await page.locator(cardSelector(victim)).getAttribute("data-player-exit"),
            id,
            "Tuning does not restart live exits",
          );
          await page.getByLabel("Landing duration", { exact: true }).press("End");
        }
        await page.getByLabel("Lift / flip overlap", { exact: true }).press("End");
        await page.getByLabel("Flip easing", { exact: true }).selectOption("in");
        victim = await begin(page);
        await sample(page, 0.5);
        assert.equal(
          await page
            .locator(`${cardSelector(victim)} .player-exit-front`)
            .evaluate((element) => getComputedStyle(element).visibility),
          "visible",
          "Asymmetric ease-in does not reveal the reverse too early",
        );
        await page.getByLabel("Flip easing", { exact: true }).selectOption("out");
        await page
          .getByRole("button", { name: "Disable player exit animation", exact: true })
          .click();
        assert.equal(
          await page.locator(".seat-anchor [data-player-exit]").count(),
          0,
          "Disabling motion cancels active flips",
        );
        await page.evaluate(() => window.exitFixture.load("goodbye"));
        await page.getByRole("button", { name: "Begin night", exact: true }).click();
        assert.equal(
          await page.locator(".seat-anchor [data-player-exit]").count(),
          0,
          "Disabled motion stays static",
        );
        await page
          .getByRole("button", { name: "Enable player exit animation", exact: true })
          .click();
        await page.evaluate(() => {
          window.exitFixture.load("day");
          window.exitFixture.setPrivacy(false);
        });
        await page.waitForFunction(() => window.exitFixture.game.phase === "day");
        victim = await page.evaluate(() => window.exitFixture.victim);
        await page.evaluate(() => window.exitFixture.exclude());
        await page.locator(`${cardSelector(victim)}[data-player-exit]`).waitFor();
        await sample(page, 0.7);
        assert.ok(
          (await page
            .locator(`${cardSelector(victim)} .player-exit-front .player-role-icon[role=img]`)
            .count()) > 0,
          "Privacy-off outgoing front retains the real role face until hidden",
        );
        assert.equal(
          await page
            .locator(`${cardSelector(victim)} .player-exit-back .player-role-icon[role=img]`)
            .count(),
          0,
          "Known reverse has no role art even with privacy off",
        );
        await page.evaluate(() => window.exitFixture.setPrivacy(true));
        assert.equal(
          await page.locator(`${cardSelector(victim)} .player-role-icon[role=img]`).count(),
          0,
        );
        await page.evaluate(() => window.exitFixture.correction());
        assert.equal(await page.locator(".seat-anchor [data-player-exit]").count(), 0);
        await page.waitForFunction(() =>
          window.exitFixture.game.players.every((p) => p.status === "active"),
        );
        await page.evaluate(() => window.exitFixture.terminal());
        await page.waitForFunction(() => window.exitFixture.game.phase === "finished");
        for (const style of ["glass", "classic", "heritage", "noir"]) {
          for (const [fancy, reducedMotion] of [
            [true, "no-preference"],
            [false, "no-preference"],
            [true, "reduce"],
          ]) {
            await page.emulateMedia({ reducedMotion });
            await page.evaluate(
              ({ style, fancy }) => {
                window.exitFixture.setStyle(style);
                window.exitFixture.setFancy(fancy);
              },
              { style, fancy },
            );
            await page.waitForFunction(
              (style) =>
                document.querySelector(".seat-anchor .player-seat").dataset.cardStyle === style,
              style,
            );
            assert.equal(await page.locator('.seat-anchor [data-card-face="front"]').count(), 10);
            assert.equal(await page.locator('.seat-anchor [data-winner-team="black"]').count(), 3);
            assert.equal(await page.locator(".seat-anchor > .player-seat-caption").count(), 10);
            assert.equal(
              await page
                .locator(
                  ".seat-anchor [data-player-exit],.seat-anchor [data-departure-cause],.seat-anchor .deceased-cross",
                )
                .count(),
              0,
            );
            assert.equal(
              await page
                .locator(".seat-anchor .player-seat")
                .evaluateAll((cards) =>
                  cards.every(
                    (card) =>
                      getComputedStyle(card).opacity === "1" &&
                      getComputedStyle(card).filter === "none",
                  ),
                ),
              true,
            );
          }
        }
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.evaluate(() => {
          window.exitFixture.setStyle("glass");
          window.exitFixture.setFancy(true);
        });
        await page.evaluate(() => window.exitFixture.load("finished"));
        assert.equal(
          await page.locator(".seat-anchor [data-player-exit]").count(),
          0,
          "Restored absent players do not replay",
        );
        await page.evaluate(() => window.exitFixture.setMode("preview"));
        assert.equal(await page.locator(".seat-anchor [data-player-exit]").count(), 0);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.evaluate(() => window.exitFixture.load("goodbye"));
        await page.getByRole("button", { name: "Begin night", exact: true }).click();
        assert.equal(await page.locator(".seat-anchor [data-player-exit]").count(), 0);
        assert.equal(
          await page.locator(`${cardSelector(victim)} .player-torn-fragment`).count(),
          2,
        );
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.evaluate(() => {
          window.exitFixture.setGlass(true);
          window.exitFixture.load("day");
        });
        await page.waitForFunction(
          () => document.querySelector(".app-shell").dataset.glassStatus === "ready",
        );
        victim = await begin(page);
        await sample(page, 0.7);
        await page.screenshot({ path: join(output, `${name}-glass-reveal.png`) });
        await page.evaluate(() => window.exitFixture.correction());
        if (name === "chrome") {
          await page
            .getByRole("button", { name: "Reset exit animation settings", exact: true })
            .click();
          await page.setViewportSize({ width: 390, height: 844 });
          await page.locator("aside").evaluate((element) => {
            element.scrollTop = 0;
          });
          assert.ok(
            (await page.getByLabel("Lift duration", { exact: true }).boundingBox()).height >= 48,
            "Touch controls retain a 48px target",
          );
          await page.screenshot({
            path: join(output, "chrome-narrow-settings.png"),
            fullPage: true,
          });
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
            true,
          );
        }
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    },
  );
}

runDepartureScenarios({
  test,
  engines: [
    ["chrome", () => chromium.launch({ channel: "chrome", headless: true })],
    ["webkit", () => webkit.launch({ headless: true })],
  ],
  output,
  install: async (page) => {
    const html = await readFile(join(output, "fixture.html"), "utf8");
    await page.route("http://player-exit.test/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: html }),
    );
    await page.goto("http://player-exit.test/");
    await page.waitForFunction(() => !!window.exitFixture);
  },
});
