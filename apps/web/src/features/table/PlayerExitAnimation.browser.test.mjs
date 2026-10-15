/* global document, window, getComputedStyle, DOMMatrix */
// Real components and domain transitions; no recording and no backend/account data.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";
import { chromium, webkit } from "@playwright/test";
import { PNG } from "pngjs";

const directory = dirname(fileURLToPath(import.meta.url));
const repository = join(directory, "../../../../..");
const output = join(repository, ".AI/reports/player-exit-integration");
await mkdir(output, { recursive: true });
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
      import ${JSON.stringify(join(directory, "../theme/GlassScene.css"))};
      const profiles = Array.from({length:10},(_,i)=>({id:'player-'+(i+1),nickname:'Player '+(i+1)}));
      function day(federation = false) {
        const rulesEdition = federation ? domain.FEDERATION_RULES_EDITION : undefined;
        let setup = domain.beginRoleDraw(domain.createSetup(profiles.map((p,i)=>({id:p.id,seat:i+1})), {rulesEdition}),domain.createSeededRandom(13));
        for(let seat=1;seat<=10;seat++) setup=domain.drawRoleForSeat(setup,seat);
        let game=domain.createGame(domain.completeRoleDraw(setup),{rulesEdition,bestMoveEnabled:false});
        for(let i=0;i<8 && game.phase!=='day';i++) game=domain.advanceSetupPhase(game);
        return game;
      }
      function Fixture() {
        const [game,setGame]=useState(day);
        const [generation,setGeneration]=useState(0);
        const [settings,setSettings]=useState(DEFAULT_PLAYER_EXIT_SETTINGS);
        const [privacy,setPrivacy]=useState(true);
        const [mode,setMode]=useState('live');
        const [glass,setGlass]=useState(false);
        const [glassStatus,setGlassStatus]=useState('off');
        const victim=game.players.find(p=>p.role==='citizen').seat;
        window.exitFixture={game,settings,victim,setSettings,setPrivacy,setMode,setGlass,
          load(kind='goodbye',federation=false) {
            const initial=day(federation);
            const seats=initial.players.filter(p=>p.role==='citizen').map(p=>p.seat);
            const next=kind==='goodbye' ? domain.completeEliminations(initial,seats.slice(0,2)) : kind==='finished' ? domain.completeEliminations(initial,seats.slice(0,4)) : initial;
            setGeneration(g=>g+1);setGame(next);setMode('live');
          },
          exclude(){setGame(g=>domain.redCard(g,victim,domain.isFederationGame(g)?{seat:victim,stage:'day-discussion',rule:'6.2.3',reason:'Fixture violation',checkInProgress:false}:undefined));},
          advance(){setGame(g=>domain.completeGoodbyeSpeech(g));},
          terminal(){setGame(g=>domain.completeEliminations(g,g.players.filter(p=>p.role==='citizen'&&p.status==='active').slice(0,4).map(p=>p.seat)));},
          correction(){setGeneration(g=>g+1);setGame(day());},
        };
        return <SharedGlassContext.Provider value={glass&&glassStatus==='ready'}>
          <div className='app-shell exit-fixture-layout' data-glass-settings='local' data-glass-status={glass?glassStatus:'off'} data-lighting-renderer='legacy' style={{'--glass-gold-light':.25,'--glass-matte-blur':'2px','--glass-matte-lens-blur':'.6px','--glass-tint':.13,'--glass-edge-highlights':1,'--glass-caustics':1}}>
            {glass?<GlassScene settings={{...DEFAULT_GLASS_SETTINGS,enabled:true}} onStatus={setGlassStatus}/>:null}
            <PlayerDirectoryProvider profiles={profiles}>
              <GameScreen key={generation+':'+mode} game={game} playerExitSettings={settings} mode={mode} hostName='Host' privacyHidden={privacy} onGameChange={setGame} onEvent={()=>{}} onAcceptedEvent={domain.isFederationGame(game)?draft=>setGame(g=>domain.applyGameEvent(g,draft)):undefined}/>
            </PlayerDirectoryProvider>
            <aside className='dev-menu-actions'><PlayerExitControls settings={settings} onChange={setSettings}/></aside>
          </div>
        </SharedGlassContext.Provider>;
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
  loader: { ".webp": "dataurl", ".ttf": "dataurl" },
  outfile: join(output, "fixture.js"),
  write: false,
});
const javascript = built.outputFiles.find((file) => file.path.endsWith(".js"))?.text;
const stylesheet = built.outputFiles.find((file) => file.path.endsWith(".css"))?.text;
assert.ok(javascript && stylesheet);
const appCss = (await readFile(join(repository, "apps/web/src/styles/app.css"), "utf8")).replace(
  /^@import[^;]+;/m,
  "",
);
const fixtureCss = `.exit-fixture-layout{display:block;padding:20px;max-width:none}aside{position:fixed;right:20px;top:20px;width:300px;z-index:20;max-height:95vh;overflow:auto} @media(max-width:600px){.exit-fixture-layout .game-shell{display:none}aside{position:relative;right:auto;top:auto;width:auto}}`;
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
    for (const animation of document
      .getAnimations()
      .filter((a) => a.id.startsWith("player-exit-"))) {
      animation.pause();
      animation.currentTime = Number(animation.effect.getTiming().duration) * value;
    }
  }, fraction);
};
const begin = async (page, federation = false) => {
  await page.evaluate((fed) => window.exitFixture.load("goodbye", fed), federation);
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
        assert.equal(await page.locator(`${cardSelector(victim)} .deceased-cross`).count(), 1);
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
          victim = await begin(page, true);
          await sample(page, fraction);
          const card = page.locator(cardSelector(victim));
          const pose = await card.evaluate((element) => ({
            rotate: getComputedStyle(element).rotate,
            front: getComputedStyle(element.querySelector(".player-exit-front")).visibility,
            back: getComputedStyle(element.querySelector(".player-exit-back")).visibility,
            roles: element.querySelectorAll(".role-badge").length,
            glass: element.querySelectorAll(":scope > .liquid-card-glass").length,
          }));
          assert.notEqual(pose.rotate, "none");
          assert.equal(pose.glass, 1);
          assert.equal(pose.roles, 0, "Daytime privacy survives transition into the night table");
          assert.equal(pose.front, fraction < 0.5 ? "visible" : "hidden");
          assert.equal(pose.back, fraction < 0.5 ? "hidden" : "visible");
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
        victim = await begin(page, true);
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
          window.exitFixture.load("day", true);
          window.exitFixture.setPrivacy(false);
        });
        await page.waitForFunction(() => window.exitFixture.game.phase === "day");
        victim = await page.evaluate(() => window.exitFixture.victim);
        await page.evaluate(() => window.exitFixture.exclude());
        await page.locator(`${cardSelector(victim)}[data-player-exit]`).waitFor();
        await sample(page, 0.7);
        assert.ok((await page.locator(`${cardSelector(victim)} .role-badge`).count()) > 0);
        await page.evaluate(() => window.exitFixture.setPrivacy(true));
        assert.equal(await page.locator(`${cardSelector(victim)} .role-badge`).count(), 0);
        await page.evaluate(() => window.exitFixture.correction());
        assert.equal(await page.locator(".seat-anchor [data-player-exit]").count(), 0);
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
        assert.equal(await page.locator(`${cardSelector(victim)} .deceased-cross`).count(), 1);
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.evaluate(() => {
          window.exitFixture.setGlass(true);
          window.exitFixture.load("day");
        });
        await page.waitForFunction(
          () => document.querySelector(".app-shell").dataset.glassStatus !== "off",
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
