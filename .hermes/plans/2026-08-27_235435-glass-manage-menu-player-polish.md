# Glass Theme, Manage Menu, and Player UI Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Remove the external refraction dependency, retain one customizable CSS-native glass skin, introduce a rotating specular treatment on the New player card, reorganize user actions into a Manage drawer, hide Dev behind a five-tap privacy easter egg with a canary firework, polish player cards, and standardize player terminology throughout the repository.

**Architecture:** Replace runtime refraction/settings branches with a stable CSS-only `GlassSurface` and a single persisted base color. Derive the complete palette with `@property`, `color-mix(in oklch, …)`, gradients, backdrop filters, and masks; keep the animated specular layer isolated to the New player surface to protect iPad performance. Split ordinary club/game operations into a Manage drawer, keep technical operations in a session-unlocked Dev drawer, and preserve all existing action handlers rather than duplicating business logic.

**Tech Stack:** React 19, TypeScript 6, CSS custom properties and Color Level 5 functions, Lucide React, Vitest, Testing Library, Vite, Fastify, PostgreSQL 17, Docker Compose.

---

## Confirmed Product Decisions

- The five rapid privacy-icon taps reveal Dev for the **current browser session only** and trigger the canary firework.
- The new user-facing drawer is named **Manage**.
- Color customization uses one native base-color picker; CSS derives the rest of the palette and the selected color persists locally.
- The legacy collective-player term is removed from user copy, code, tests, SQL aliases, schema migration text, documentation, and historical in-repo plans—not only from visible UI.
- Commit and push include **all currently dirty work**, including the just-finished fullscreen simplification and current gameplay changes, rather than silently leaving unrelated work unstaged.
- Target branch is the currently checked-out `main`, pushed to `origin/main` after verification.

## Current Context and Assumptions

- The worktree is already dirty. Before new implementation, review and verify that state, then make one explicit baseline commit so later UI commits are auditable.
- Existing source includes three color themes, runtime glass settings, feature detection, and `@hashintel/refractive`.
- Existing `GlassSurface` is used by `LiveSidePanel`; the replacement must keep one stable DOM element so the embedded music player is not remounted.
- The Dev drawer currently owns a mixture of technical controls and ordinary user workflows. Existing handlers remain the source of truth; only placement and labels change.
- “Start new game” uses the authoritative existing clear/reset path. If a persisted active game exists, keep the current irreversible confirmation and server deletion behavior before opening fresh setup.
- Five fast privacy taps still perform the normal privacy toggle on each tap, so the fifth tap leaves privacy in the correctly toggled state; the easter egg must not suppress the button’s primary action.
- “Rapid” means each consecutive tap arrives within 500 ms; a slower tap resets the sequence. No unlock state is written to local storage.
- The rotating specular highlight uses a 24-second linear cycle. `prefers-reduced-motion: reduce` keeps a static highlight and suppresses particle travel.
- The native color input stores an sRGB `#rrggbb` value; CSS performs perceptual derivation in OKLCH.

## Target File Map

### Dependency and theme layer

- Modify: `apps/web/package.json`
- Modify: `package-lock.json`
- Modify: `apps/web/src/theme.ts`
- Modify: `apps/web/src/theme.test.ts`
- Modify: `apps/web/src/styles/app.css`
- Modify: `apps/web/src/styles/clubs.css`
- Modify: `apps/web/src/styles/timeline.css`
- Modify: `apps/web/src/features/theme/GlassSurface.tsx`
- Rewrite: `apps/web/src/features/theme/GlassSurface.test.tsx`
- Delete: `apps/web/src/features/theme/glass-settings.ts`
- Delete: `apps/web/src/features/theme/glass-settings.test.ts`
- Delete: `apps/web/src/features/theme/refractive-support.ts`
- Delete: `apps/web/src/features/theme/refractive-support.test.ts`
- Modify: `apps/web/src/features/game/LiveSidePanel.tsx`
- Modify: `apps/web/src/features/game/LiveSidePanel.test.tsx`
- Delete or fold into the normal panel test: `apps/web/src/features/game/LiveSidePanel.persistence.test.tsx`

### Navigation and easter egg

- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Create: `apps/web/src/features/effects/CanaryFirework.tsx`
- Create: `apps/web/src/features/effects/CanaryFirework.test.tsx`
- Modify: `apps/web/src/features/clubs/ClubPortal.tsx`
- Modify: `apps/web/src/features/clubs/ClubPortal.test.tsx`

### Player UI

- Modify: `apps/web/src/features/players/PlayersScreen.tsx`
- Modify: `apps/web/src/features/players/PlayersScreen.test.tsx`
- Modify: `apps/web/src/styles/app.css`

### Repository-wide player terminology

Likely affected files identified by the current source scan:

- `apps/server/src/app.test.ts`
- `apps/server/src/event-store.test.ts`
- `apps/server/src/game-session-store.ts`
- `apps/server/src/game-session-store.test.ts`
- `apps/server/src/game-session-validation.ts`
- `apps/server/src/game-session-validation.test.ts`
- `apps/server/src/player-store.test.ts`
- `apps/server/src/schema.sql`
- `apps/server/src/schema-migration.test.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/App.test.tsx`
- `apps/web/src/features/players/PlayersScreen.tsx`
- `apps/web/src/features/setup/SetupWizard.tsx`
- `apps/web/src/features/setup/SetupWizard.test.tsx`
- `apps/web/src/styles/app.css`
- `apps/web/src/styles/clubs.css`
- `docs/product-outline.md`
- `docs/adr/0001-typescript-modular-monolith.md`
- Existing `.hermes/plans/*.md` files containing the legacy term

---

### Task 1: Verify and checkpoint the existing dirty worktree

**Objective:** Make the user-approved current dirty state explicit and recoverable before layering new behavior onto overlapping files.

**Files:**
- Review: every path from `git status --short`
- Include: existing untracked `.hermes/plans/*.md`, including this plan

**Step 1: Re-read repository state**

Run:

```bash
git status --short --branch
git diff --stat
git diff --check
```

Expected: branch `main`; no whitespace errors; every modified/untracked file has a known purpose.

**Step 2: Review overlapping diffs**

Inspect the complete diff, paying special attention to:

- fullscreen simplification in `App.tsx`, `SetupWizard.tsx`, and viewport styles;
- canonical Mafia shot/replay changes in game and domain files;
- existing plan documents;
- any file not described by either known workstream.

Do not discard or overwrite any current hunk.

**Step 3: Run the baseline gates before committing**

Run:

```bash
NODE_OPTIONS=--no-experimental-webstorage npm run test
npm run lint
npm run typecheck
npm run check
npm run build
```

Expected: all commands pass. If a failure belongs to the current dirty work, fix its root cause before checkpointing; if it is external or unrelated, stop and report instead of committing an unverified baseline.

**Step 4: Commit the approved current state**

Run:

```bash
git add -A
git commit -m "fix: stabilize canonical game and fullscreen behavior" -m "Remove ineffective fullscreen-exit workarounds while preserving normal fullscreen controls and editable player selection. Resolve canonical Mafia shot state from persisted checkpoints and retain the associated implementation plans."
```

Expected: one baseline commit; `git status --short` is empty.

---

### Task 2: Replace three skins with one persisted base color

**Objective:** Collapse theme selection to one glass visual system whose palette is derived from a validated user color.

**Files:**
- Modify: `apps/web/src/theme.test.ts`
- Modify: `apps/web/src/theme.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/features/clubs/ClubPortal.tsx`
- Modify: `apps/web/src/features/clubs/ClubPortal.test.tsx`

**Step 1: Write failing theme persistence tests**

Cover:

1. default base color is `#c39a58`;
2. a valid six-digit hex value is read, normalized to lowercase, applied to `--theme-base`, and persisted;
3. malformed storage falls back safely;
4. each legacy theme value migrates to a sensible base color;
5. applying the new preference removes legacy theme/settings keys and does not set `data-theme`.

Use this public contract:

```ts
export const DEFAULT_THEME_COLOR = "#c39a58";
export const readThemeColor: (storage: ThemeStorage) => string;
export const applyThemeColor: (
  root: HTMLElement,
  storage: ThemeStorage,
  color: string,
) => string;
```

**Step 2: Run RED**

Run:

```bash
NODE_OPTIONS=--no-experimental-webstorage npm run test -w @mafia/web -- src/theme.test.ts src/features/clubs/ClubPortal.test.tsx
```

Expected: FAIL because the new single-color API and picker do not exist.

**Step 3: Implement the minimal color API**

In `apps/web/src/theme.ts`:

- validate only `#rrggbb` input;
- export `DEFAULT_THEME_COLOR`;
- persist under a versioned key such as `mafia-dashboard.theme-color.v1`;
- migrate old named themes to their prior accent colors;
- remove old named-theme and glass-settings keys after a successful application;
- set `root.style.setProperty("--theme-base", normalized)`;
- remove `root.dataset.theme`.

Do not introduce a color parsing dependency.

**Step 4: Replace theme cycling with a native picker**

In `App.tsx` and `ClubPortal.tsx`:

```tsx
<label className="theme-color-field">
  <span>Glass color</span>
  <input
    type="color"
    value={themeColor}
    aria-label="Glass color"
    onChange={(event) => onThemeColorChange(event.currentTarget.value)}
  />
</label>
```

Expose the same picker in the welcome portal and later in Manage. Remove named-theme order/label code.

**Step 5: Run GREEN**

Run the same targeted test command.

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/web/src/theme.ts apps/web/src/theme.test.ts apps/web/src/App.tsx apps/web/src/features/clubs/ClubPortal.tsx apps/web/src/features/clubs/ClubPortal.test.tsx
git commit -m "feat: make the glass palette customizable"
```

---

### Task 3: Build a CSS-native glass surface and remove runtime glass settings

**Objective:** Preserve stable glass geometry without the beta refraction component, runtime capability checks, or Dev tuning controls.

**Files:**
- Rewrite: `apps/web/src/features/theme/GlassSurface.tsx`
- Rewrite: `apps/web/src/features/theme/GlassSurface.test.tsx`
- Modify: `apps/web/src/features/game/LiveSidePanel.tsx`
- Modify: `apps/web/src/features/game/LiveSidePanel.test.tsx`
- Delete: `apps/web/src/features/game/LiveSidePanel.persistence.test.tsx`
- Delete: the four settings/support source and test files listed above
- Modify: `apps/web/src/App.tsx`

**Step 1: Replace dependency-specific tests with stable-surface tests**

The new tests must prove:

- `as="aside"` keeps semantic element selection;
- `radius={20}` sets `--glass-radius: 20px`;
- `specular` adds `is-specular`;
- caller class names, ARIA attributes, children, and non-owned inline styles survive;
- rerendering the wrapper preserves the same descendant music-player node.

**Step 2: Run RED**

```bash
NODE_OPTIONS=--no-experimental-webstorage npm run test -w @mafia/web -- src/features/theme/GlassSurface.test.tsx src/features/game/LiveSidePanel.test.tsx
```

Expected: FAIL because the current component requires library-specific props.

**Step 3: Simplify `GlassSurface`**

Use a small local wrapper with no runtime effect detection:

```tsx
export interface GlassSurfaceProps extends React.HTMLAttributes<HTMLElement> {
  readonly as?: "div" | "aside" | "main" | "section";
  readonly radius?: number;
  readonly specular?: boolean;
}
```

Render one stable native element with:

- class `glass-surface`;
- optional class `is-specular`;
- bounded radius written to `--glass-radius`;
- no imported component, no fallback branch, and no dynamically changing element type.

**Step 4: Simplify `LiveSidePanel`**

Remove theme, settings, and capability props. Keep the glass backdrop as:

```tsx
<GlassSurface aria-hidden="true" className="live-side-panel-glass" radius={20} />
```

Update all callers and tests.

**Step 5: Remove settings UI and state**

From `App.tsx`, remove:

- settings imports/state/read/write/reset code;
- feature-detection state/effects;
- all Dev fieldsets/sliders/checkboxes for refraction;
- props passed solely to `LiveSidePanel`.

**Step 6: Delete obsolete modules and run GREEN**

Run the targeted tests again.

Expected: PASS and no imports of deleted files.

**Step 7: Commit**

```bash
git add -A apps/web/src/features/theme apps/web/src/features/game/LiveSidePanel.tsx apps/web/src/features/game/LiveSidePanel.test.tsx apps/web/src/features/game/LiveSidePanel.persistence.test.tsx apps/web/src/App.tsx
git commit -m "refactor: replace runtime refraction with native glass"
```

---

### Task 4: Derive the complete glass palette with modern CSS

**Objective:** Make one base color drive all glass, focus, portal, and timeline accents without JavaScript RGB conversion.

**Files:**
- Modify: `apps/web/src/styles/app.css`
- Modify: `apps/web/src/styles/clubs.css`
- Modify: `apps/web/src/styles/timeline.css`

**Step 1: Add the typed color property and single token set**

Start `app.css` with a safe fallback:

```css
@property --theme-base {
  syntax: "<color>";
  inherits: true;
  initial-value: #c39a58;
}

:root {
  color-scheme: dark;
  --accent: var(--theme-base);
  --accent-hover: color-mix(in oklch, var(--theme-base) 78%, white);
  --border: color-mix(in oklch, var(--theme-base) 24%, transparent);
  --panel: color-mix(in oklch, var(--theme-base) 8%, rgb(12 11 10 / 62%));
  --surface: color-mix(in oklch, var(--theme-base) 14%, rgb(22 18 14 / 58%));
}
```

Keep literal fallbacks before newer declarations where a missing Color Level 5 function would otherwise make a critical surface transparent.

**Step 2: Remove named-theme selector blocks**

Delete all three skin-specific token sections and move the retained glass behavior into base selectors. Background shades remain diagnostic controls, not skins.

**Step 3: Replace RGB-triplet variables**

Replace `--accent-rgb`, `--portal-muted-rgb`, and `--portal-spotlight-rgb` consumers with direct color values, for example:

```css
outline-color: color-mix(in oklch, var(--accent) 55%, transparent);
background: color-mix(in oklch, var(--portal-text) 72%, transparent);
```

Do this across all three style files so arbitrary picker colors work everywhere.

**Step 4: Define the reusable native glass surface**

```css
.glass-surface {
  border-radius: var(--glass-radius, 20px);
  background:
    linear-gradient(145deg, rgb(255 255 255 / 14%), transparent 42%),
    color-mix(in oklch, var(--theme-base) 8%, rgb(12 10 8 / 66%));
  border: 1px solid color-mix(in oklch, var(--theme-base) 30%, transparent);
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 22%),
    0 20px 70px rgb(0 0 0 / 45%);
  backdrop-filter: blur(14px) saturate(1.16);
  -webkit-backdrop-filter: blur(14px) saturate(1.16);
}
```

Add an opaque fallback under `prefers-reduced-transparency: reduce`.

**Step 5: Verify CSS and build**

```bash
npx prettier --check apps/web/src/styles/app.css apps/web/src/styles/clubs.css apps/web/src/styles/timeline.css
npm run build -w @mafia/web
```

Expected: both pass; no named-theme selectors or RGB-triplet theme variables remain.

**Step 6: Commit**

```bash
git add apps/web/src/styles/app.css apps/web/src/styles/clubs.css apps/web/src/styles/timeline.css
git commit -m "style: derive one glass skin from a base color"
```

---

### Task 5: Remove the external refraction package

**Objective:** Prove the application no longer needs or installs the glass library.

**Files:**
- Modify: `apps/web/package.json`
- Modify: `package-lock.json`

**Step 1: Confirm no source import remains**

Use `search_files` for `@hashintel/refractive` and the deleted settings/support module names.

Expected: only manifest/lockfile hits remain.

**Step 2: Uninstall through npm**

```bash
npm uninstall @hashintel/refractive -w @mafia/web
```

Expected: dependency removed from `apps/web/package.json` and all lockfile package entries pruned.

**Step 3: Verify dependency graph**

```bash
npm ls @hashintel/refractive --all
npm run typecheck -w @mafia/web
npm run build -w @mafia/web
```

Expected: npm reports an empty dependency subtree; typecheck and build pass.

**Step 4: Commit**

```bash
git add apps/web/package.json package-lock.json
git commit -m "chore: remove the refraction dependency"
```

---

### Task 6: Add the Manage drawer and move ordinary operations

**Objective:** Keep club/game management visible while reducing Dev to technical diagnostics.

**Files:**
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles/app.css`

**Step 1: Write failing navigation tests**

Assert that:

- the toolbar has `Open Manage menu`;
- Manage uses `role="dialog"` and `aria-label="Manage"`;
- Manage contains `Start new game`, `Edit club`, `Delete club`, `Players screen`, `Music player setup`, `Active games`, and `Glass color`;
- Dev contains none of those controls and no glass settings;
- actions call the current handlers and close the drawer where appropriate;
- only one drawer is open at a time;
- Log, Manage, and Dev share the same drawer shell/geometry class.

**Step 2: Run RED**

```bash
NODE_OPTIONS=--no-experimental-webstorage npm run test -w @mafia/web -- src/App.test.tsx -t "Manage|ordinary operations"
```

Expected: FAIL because Manage does not exist.

**Step 3: Extend drawer state**

Change the drawer union to include `"manage"`. Add a visible toolbar button with a Lucide management/menu icon, active state, accessible label, and tooltip.

**Step 4: Render Manage with existing handlers**

Move or create controls in this order:

1. Start new game;
2. Players screen;
3. Music player setup;
4. Active games section;
5. Edit club;
6. Glass color;
7. Delete club.

Keep destructive actions visually separated at the bottom. Do not duplicate API calls; call the current reset, navigation, edit, deletion, music, and session handlers.

**Step 5: Implement Start new game safely**

- If no current/persisted game exists, reset local setup and open game setup immediately.
- If one exists, use the existing irreversible server-delete confirmation/path.
- Only open fresh setup after the prior clear succeeds.
- A canceled or failed clear leaves the current game untouched.

**Step 6: Remove moved actions from Dev**

Dev retains only technical capabilities such as version/canary information, timeline/console diagnostics, developer mode/sample data, background diagnostics, reload music player, data reset, and normal fullscreen exit where already specified.

**Step 7: Style and run GREEN**

Use the same `.app-drawer` geometry as Dev/Log; add only content-level grouping styles.

Run the targeted test command again.

Expected: PASS.

**Step 8: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/App.test.tsx apps/web/src/styles/app.css
git commit -m "feat: add a dedicated Manage menu"
```

---

### Task 7: Hide Dev and unlock it with five privacy taps

**Objective:** Make Dev intentionally undiscoverable by default while preserving a deterministic session-only QA easter egg.

**Files:**
- Create: `apps/web/src/features/effects/CanaryFirework.tsx`
- Create: `apps/web/src/features/effects/CanaryFirework.test.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles/app.css`

**Step 1: Write failing firework component tests**

Require:

- exactly 32 decorative canary particles;
- each particle is `aria-hidden` and receives deterministic angle/distance/delay CSS variables;
- changing `burstKey` replays via new keys/classes;
- no timers are owned by individual particles.

**Step 2: Write failing App unlock tests with fake timers**

Cover:

- Dev button absent on first render;
- four fast taps leave Dev hidden;
- fifth fast tap shows Dev and one firework;
- a >500 ms gap resets the sequence;
- unlock survives normal renders/navigation but not a reload/remount;
- every tap still toggles privacy;
- opening Manage/Log before unlock never exposes Dev content.

**Step 3: Run RED**

```bash
NODE_OPTIONS=--no-experimental-webstorage npm run test -w @mafia/web -- src/features/effects/CanaryFirework.test.tsx src/App.test.tsx -t "canary|five privacy|Dev hidden"
```

Expected: FAIL.

**Step 4: Implement the canary particle component**

Use the existing Lucide `Bird` glyph with `fill="currentColor"`. Generate a deterministic 32-entry array at module scope, distributed over the full circle with alternating travel distances and tiny staggered delays. Render one absolute, pointer-events-none burst rooted at the privacy button.

**Step 5: Implement the tap sequence**

Use refs for count and last timestamp, plus state for `devUnlocked` and `burstKey`. Do not persist either value. On the fifth valid tap:

- reset the counter;
- reveal the Dev toolbar button;
- increment `burstKey`;
- apply the privacy-icon pop/spin class;
- render `CanaryFirework` next to the icon.

**Step 6: Add animation CSS**

- taps 1–4: small escalating eye-icon wiggle;
- tap 5: quick pop/spin;
- 32 canaries travel out, rotate, and fade;
- animation duration around 900 ms;
- use transforms/opacity only;
- under reduced motion, skip travel and reveal Dev without movement.

**Step 7: Run GREEN and commit**

```bash
NODE_OPTIONS=--no-experimental-webstorage npm run test -w @mafia/web -- src/features/effects/CanaryFirework.test.tsx src/App.test.tsx -t "canary|five privacy|Dev hidden"
git add apps/web/src/features/effects apps/web/src/App.tsx apps/web/src/App.test.tsx apps/web/src/styles/app.css
git commit -m "feat: unlock Dev with a canary firework"
```

Expected: tests pass and commit succeeds.

---

### Task 8: Add a slowly rotating specular layer to New player

**Objective:** Reproduce the classy rotating highlight locally without animating every surface or reintroducing a rendering package.

**Files:**
- Modify: `apps/web/src/features/players/PlayersScreen.test.tsx`
- Modify: `apps/web/src/features/players/PlayersScreen.tsx`
- Modify: `apps/web/src/styles/app.css`

**Step 1: Write a failing structural test**

Require the New player section to use `GlassSurface` with `specular`, while existing player cards do not receive the animated class.

**Step 2: Run RED**

```bash
NODE_OPTIONS=--no-experimental-webstorage npm run test -w @mafia/web -- src/features/players/PlayersScreen.test.tsx -t "specular"
```

Expected: FAIL.

**Step 3: Wrap the creation surface**

Render the New player region through:

```tsx
<GlassSurface
  as="section"
  className="new-player-panel"
  radius={16}
  specular
  aria-labelledby="new-player-title"
>
  {/* existing creation UI */}
</GlassSurface>
```

**Step 4: Add the masked rotating border/highlight**

Use a pseudo-element with `conic-gradient`, padding-box masking, and a typed angle:

```css
@property --specular-angle {
  syntax: "<angle>";
  inherits: false;
  initial-value: 0deg;
}

.glass-surface.is-specular::before {
  content: "";
  position: absolute;
  inset: 0;
  padding: 1px;
  border-radius: inherit;
  pointer-events: none;
  background: conic-gradient(
    from var(--specular-angle),
    transparent 0 58%,
    color-mix(in oklch, var(--theme-base) 36%, white) 68%,
    rgb(255 255 255 / 88%) 72%,
    transparent 82% 100%
  );
  animation: specular-rotate 24s linear infinite;
}

@keyframes specular-rotate {
  to { --specular-angle: 1turn; }
}
```

Use mask/composite rules so the highlight stays on the rim and never intercepts inputs. Give descendants a stable stacking layer. Under reduced motion, stop at a tasteful fixed angle.

**Step 5: Run GREEN and commit**

```bash
NODE_OPTIONS=--no-experimental-webstorage npm run test -w @mafia/web -- src/features/players/PlayersScreen.test.tsx -t "specular"
git add apps/web/src/features/players/PlayersScreen.tsx apps/web/src/features/players/PlayersScreen.test.tsx apps/web/src/styles/app.css
git commit -m "style: add a rotating specular player surface"
```

---

### Task 9: Refine New player and player profile layouts

**Objective:** Apply the requested hierarchy, field sizing, and compact action layout without changing data validation.

**Files:**
- Modify: `apps/web/src/features/players/PlayersScreen.test.tsx`
- Modify: `apps/web/src/features/players/PlayersScreen.tsx`
- Modify: `apps/web/src/styles/app.css`

**Step 1: Write failing content and layout-contract tests**

Assert:

- New player has one heading, styled with `eyebrow`, and no secondary pre-heading;
- existing cards do not contain `Player profile`;
- a player with no game date renders no last-played element/text;
- a dated player still renders `Last played …`;
- data-processing and manager controls use the shared 44px control shell;
- Add player is associated with the create form but lives in the compact heading/action rail;
- Save and Delete are children of one `.player-card-actions` group;
- when both exist, neither occupies a separate row;
- Owner/locked cards render Save at full width when Delete is unavailable.

**Step 2: Run RED**

```bash
NODE_OPTIONS=--no-experimental-webstorage npm run test -w @mafia/web -- src/features/players/PlayersScreen.test.tsx -t "New player|profile labels|player actions|field height"
```

Expected: FAIL.

**Step 3: Simplify card headings**

- Replace the two-line New player heading with one semantic `h2.eyebrow`.
- Remove the `Player profile` eyebrow from existing cards.
- Render last-played metadata only when a timestamp exists; render nothing for a never-played player.

**Step 4: Normalize boolean fields**

Give each checkbox field the same two-part structure as text fields:

- caption line;
- 44px `.player-toggle-control` row containing checkbox and concise state text.

Keep consent/manager disabling and ARIA guidance behavior unchanged.

**Step 5: Compact the create action**

Assign the form an id such as `new-player-form`. Keep fields in the right content area and place the Add player submit button in the left heading/action rail with `form="new-player-form"`. This uses existing horizontal space and avoids a full-width action row.

**Step 6: Group existing-card actions**

Wrap Save/Delete in:

```tsx
<div className="player-card-actions">
  <button type="submit">…</button>
  <button type="button" className="danger-action">…</button>
</div>
```

Use two equal columns when both exist and one full-width column otherwise. Keep confirmation, busy, deletion-protection, and guidance behavior unchanged.

**Step 7: Run GREEN and commit**

```bash
NODE_OPTIONS=--no-experimental-webstorage npm run test -w @mafia/web -- src/features/players/PlayersScreen.test.tsx
git add apps/web/src/features/players/PlayersScreen.tsx apps/web/src/features/players/PlayersScreen.test.tsx apps/web/src/styles/app.css
git commit -m "refactor: streamline player profile cards"
```

---

### Task 10: Standardize player terminology across source, SQL, tests, docs, and plans

**Objective:** Eliminate the legacy collective-player term everywhere in the repository’s maintained text and identifiers.

**Files:**
- Modify: every path in the terminology file map above
- Re-scan: the entire repository excluding generated/vendor directories

**Step 1: Establish the exact baseline**

Use `search_files(pattern="(?i)ro[s]ter", …)` across:

- `apps/`
- `packages/`
- `docs/`
- `scripts/`
- `.hermes/plans/`

Record the baseline count and file list before editing. The current scan found 85 matching lines across source/docs plus historical plan occurrences; re-scan because Task 1 may have changed the tree.

**Step 2: Rename production concepts**

Use “player,” “players,” “selected players,” or “active players” according to context. Preferred internal names include:

- `PlayerSelectionState`
- `replaceActivePlayers`
- `playerSelectionState`
- `playerGateError`
- `activePlayerCount`
- `selectedPlayers`

Do not rename the already-correct `game_session_players` table or public player fields.

**Step 3: Rename SQL aliases and typed result fields**

Use aliases such as:

- `players`
- `player_count`
- `active_players`
- `selected_player`

Update corresponding TypeScript result shapes and assertions atomically. This is a text/alias cleanup, not a database-table migration.

**Step 4: Rename UI/CSS concepts**

Use:

- `.player-search`
- `.empty-players`
- `.player-gate-error`
- `.players-note`
- `.player-guidance`

Update JSX class names, ids, labels (`Search players`), tests, and CSS together.

**Step 5: Rename test helpers/fixtures/descriptions**

Use names such as `fillPlayerSelection`, `firstPlayers`, `secondPlayers`, and `setup-players`. Update assertions and test titles without changing tested behavior.

**Step 6: Update maintained documentation and historical plans**

Replace the legacy term with the contextually correct player wording in `docs/` and `.hermes/plans/`, including this plan only if a later edit introduces it.

**Step 7: Verify zero occurrences**

Repeat the repository-wide `search_files(pattern="(?i)ro[s]ter", …)` scan.

Expected: zero matches outside ignored generated/vendor output. If generated `dist/` still contains old text, rebuild rather than editing generated files by hand.

**Step 8: Run focused server/domain/web tests**

```bash
NODE_OPTIONS=--no-experimental-webstorage npm run test -w @mafia/web -- src/App.test.tsx src/features/players/PlayersScreen.test.tsx src/features/setup/SetupWizard.test.tsx
npm run test -w @mafia/server -- game-session-validation.test.ts game-session-store.test.ts player-store.test.ts app.test.ts schema-migration.test.ts event-store.test.ts
npm run typecheck
```

Expected: all pass; no contract/schema behavior changes.

**Step 9: Commit**

```bash
git add apps packages docs .hermes/plans
git commit -m "refactor: standardize player terminology"
```

---

### Task 11: Run integration and visual acceptance checks

**Objective:** Prove behavior, geometry, animation, dependency cleanup, and repository health before push.

**Files:**
- No new production files expected
- Temporary browser scripts/screenshots may be created under `/tmp` only

**Step 1: Format and inspect**

```bash
npm run format
git diff --check
git status --short
```

Expected: formatting applied only to touched files; no whitespace errors; only expected formatted changes remain.

**Step 2: Run complete project gates**

```bash
NODE_OPTIONS=--no-experimental-webstorage npm run test
npm run lint
npm run typecheck
npm run check
npm run build
```

Expected: all pass.

**Step 3: Recheck removed dependency and terminology**

- `npm ls @hashintel/refractive --all` shows no installed package.
- `search_files` finds no external-package import, runtime settings module, named-theme selector, or legacy collective-player term.
- Dev has no glass tuning controls.

**Step 4: Rebuild the rapid prototype**

```bash
docker compose up -d --build app
curl --fail --silent --show-error http://127.0.0.1:8080/health/ready
docker inspect --format='status={{.State.Status}} health={{.State.Health.Status}} restarts={{.RestartCount}} image={{.Image}}' mafiadashboard-app-1
```

Expected: readiness JSON reports ready; container is running/healthy with zero restarts.

**Step 5: Verify in a 1366×1024 touch-capable browser**

Check and capture evidence for:

- only one glass visual system;
- color picker updates portal and workspace immediately and survives reload;
- New player specular rim completes a slow rotation without moving card content;
- reduced-motion mode uses a static highlight;
- Add player fits in the heading/action rail;
- boolean control shells match text-input height;
- Save/Delete share one equal-width row;
- empty last-played metadata leaves no placeholder;
- Manage matches Dev/Log drawer geometry and contains all six requested workflows;
- Dev is absent initially;
- four quick privacy taps do not reveal Dev;
- the fifth reveals Dev and launches a dense canary burst;
- a slow five-tap sequence does not unlock Dev;
- normal fullscreen entry/exit and editable Host/Seat controls still work.

Prefer a WebKit production-build probe. If live auth blocks deterministic setup, mock only API responses while exercising the real built frontend.

**Step 6: Review final diff**

Run:

```bash
git diff HEAD~6..HEAD --stat
git status --short --branch
```

Confirm no credentials, generated output, temporary scripts, screenshots, or accidental unrelated files are included.

---

### Task 12: Commit final formatting, push, and verify the remote

**Objective:** Publish the fully verified commit sequence and prove `origin/main` points at the same exact commit.

**Files:**
- Any formatting-only tracked changes from Task 11

**Step 1: Commit residual verified formatting if needed**

If Task 11 changed tracked files:

```bash
git add -A
git commit -m "chore: finalize glass and player UI cleanup"
```

If the worktree is clean, do not create an empty commit.

**Step 2: Confirm push preconditions**

```bash
git fetch origin
git status --short --branch
git log --oneline --decorate origin/main..HEAD
```

Expected: clean worktree; local `main` is only ahead, not behind or diverged. If remote advanced, stop and reconcile explicitly rather than force-pushing.

**Step 3: Push**

```bash
git push origin main
```

Expected: normal fast-forward push succeeds.

**Step 4: Read back exact remote state**

```bash
local_sha=$(git rev-parse HEAD)
remote_sha=$(git ls-remote origin refs/heads/main | cut -f1)
printf 'local=%s\nremote=%s\n' "$local_sha" "$remote_sha"
test "$local_sha" = "$remote_sha"
git status --short --branch
```

Expected: local and remote SHAs are identical; branch reports synchronized and clean.

---

## Acceptance Criteria

- `@hashintel/refractive` is absent from manifests, lockfile, installed dependency tree, and imports.
- Runtime feature detection and glass-settings modules/Dev controls are deleted.
- Exactly one glass skin remains.
- One persisted native color picker drives the entire palette through modern CSS.
- New player alone receives the slow rotating specular effect; reduced-motion behavior is safe.
- Manage contains Start new game, Edit club, Delete club, Players screen, Music player setup, and Active games.
- Dev contains none of those workflows and is not visible on initial load.
- Five rapid privacy taps reveal Dev for the session and emit 32 canary particles.
- Player card hierarchy, checkbox sizing, create action placement, and Save/Delete row match the requested layout.
- No never-played placeholder or player-profile pre-heading remains.
- Repository-wide scan finds zero maintained occurrences of the legacy collective-player term.
- Full tests, lint, typecheck, check, build, production Docker rebuild, health check, and focused WebKit acceptance probe pass.
- All pre-existing dirty work and new work are committed, pushed to `origin/main`, and remote SHA verification matches local `HEAD`.

## Risks and Mitigations

- **iPad GPU cost:** Animate only one masked pseudo-element with transformable typed angle; never animate backdrop blur or full-page filters.
- **Modern-color fallback:** Keep valid literal colors before `color-mix` declarations and verify in WebKit.
- **Mask syntax differences:** Include both standard mask composition and WebKit-compatible declarations; visually verify the rim does not cover inputs.
- **Hidden Dev discoverability:** Intentional per decision; session-only unlock avoids permanently exposing diagnostics.
- **Privacy rapid taps:** Preserve the primary toggle on every tap and test the final state.
- **Destructive Start new game:** Reuse the current confirmed server-clear path; never reset local state before remote clear succeeds.
- **Terminology breadth:** Use repository-wide scans before and after; rename SQL aliases/types together and leave already-correct table/API names unchanged.
- **Dirty baseline:** Verify and checkpoint it first because App/test files overlap heavily with this work.
- **Push safety:** Fast-forward only; never force-push or rewrite remote history.

## Open Questions

None. The five planning decisions were resolved interactively and are incorporated above.
