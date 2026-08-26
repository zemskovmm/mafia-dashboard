# Night Results, Timeline, Timer, and Dev UI Cleanup Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Fix Mafia evaluation after Timeline browsing; add a full-screen Dev Console for all client errors; simplify Timeline details/chrome; restore 60/30-second warning beeps; remove the Happy day and redundant night controls; show the Mafia outcome on the final Night result; gate development-only setup/sample tools behind Dev mode; place the three player-setup actions in one responsive row; and make the table-center shadow permanent.

**Architecture:** Reproduce the Timeline-to-game mutation failure before changing state guards. Add an idempotently installed, bounded in-memory error bus feeding a separate full-screen Console route from Dev. Keep the canonical night result in `GameState.nightResult` and reuse one result card in both Mafia-result phases. Treat Happy day removal as a presentation/new-state change while retaining legacy parsing. Use one session-local `devModeEnabled` authority for setup generation and Timeline samples. Remove Timeline-only privacy projection while retaining canonical event secrecy. Unlock/schedule timer audio from the preset click gesture, and use one flex-wrapping action group for player setup.

**Tech Stack:** React 19, TypeScript, Vitest + Testing Library, shared `@mafia/game-domain`, CSS flex layout, Playwright-based `scripts/verify-ui.mjs`.

---

## Confirmed interpretations and constraints

1. **“Night result” means the final `night-resolution` / “Night complete” screen.** The immediate `night-mafia-result` screen already displays the Mafia outcome; the final screen currently displays only “Night complete”. The implementation will show the same kill/miss/no-effect result on both screens.
2. **“Maria re-evaluate” means the current `Re-evaluate Mafia shots` button.** Remove that button and its special rewind plumbing completely. The ordinary global Undo capability remains unchanged.
3. **Remove inline Red from all Don/Sheriff private-check surfaces.** This includes `night-don`, `night-don-result`, `night-sheriff`, and `night-sheriff-result`. Keep the existing swipe-to-Red action.
4. **“Player screen” means the game-setup player step** containing the exact `Development only` section and the `Select available players`, `Assign players`, and `Start game` buttons.
5. **Dev mode defaults off and is session-local.** Reloading hides the development-only section again. Do not add browser persistence unless Michael requests it before implementation.
6. **Preserve legacy sessions.** Stop generating `dayNotice: "happy"` and never render it, but retain the optional field in domain/server validation so existing sessions containing it still load.
7. **Keep the table-center shadow.** Remove only the hide/show toggle, localStorage key/state, conditional class, hidden CSS selector, and obsolete test. Do not alter `.table-center::before`.
8. **Rapid-prototype workflow remains active.** The worktree already contains extensive accepted-but-uncommitted changes. Do not reset, commit, push, reformat unrelated files, or overwrite neighboring changes. Replace per-task commits with focused tests plus `git diff --check`; commit only after explicit acceptance.
9. **Timeline private view is removed only from Timeline.** Canonical `GameLogEntry.secret` values remain intact; the host Timeline simply stops redacting them or advertising Visibility.
10. **Timeline remains horizontally scrollable.** Remove the `Scroll timeline →` hint element, not the scroll container/track.
11. **Sample generation shares App Dev mode.** It is absent by default and uses the same `Enable dev mode` toggle as setup development players.
12. **Timer warning means one beep at ten seconds remaining.** All +60, +30, and +10 presets must produce it; no start/end beep is added.
13. **Console diagnostics are memory-only and bounded.** Capture errors from startup onward, but never persist diagnostics or record credentials, cookies, OAuth values, raw request/response bodies, event payloads, or player personal data.
14. **Console is always reachable from Dev.** It does not require `Enable dev mode`; a diagnostic screen must remain available while development data generators are disabled.

## Current code map

- Happy day state generation: `packages/game-domain/src/night-actions.ts:268-307`
- Happy day domain regression: `packages/game-domain/src/night-actions.test.ts:193-200`
- Happy day rendering: `apps/web/src/features/game/GameScreen.tsx:297-303`
- Happy day styling: `apps/web/src/styles/app.css:1651-1669`
- Immediate Mafia result and re-evaluate UI: `apps/web/src/features/night/NightStage.tsx:169-238`
- Final Night complete UI: `apps/web/src/features/night/NightStage.tsx:450-488`
- Re-evaluate domain helper: `packages/game-domain/src/night-actions.ts:163-171`
- Re-evaluate App head-move helper: `apps/web/src/App.tsx:839-849`
- Re-evaluate prop plumbing: `apps/web/src/features/game/GameScreen.tsx:22-39,94-111,543-554`
- Inline Don/Sheriff Red actions: `apps/web/src/features/night/NightStage.tsx:47-67,241-420`
- Development-only setup block: `apps/web/src/features/setup/SetupWizard.tsx:501-546`
- Existing development gate: `apps/web/src/App.tsx:1725-1731`
- Dev drawer controls: `apps/web/src/App.tsx:1480-1610`
- Player action markup: `apps/web/src/features/setup/SetupWizard.tsx:581-603`
- Player action layout CSS: `apps/web/src/styles/app.css:581-612,2502-2511,2753-2756,3020-3025`
- Center-shadow setting/state/menu: `apps/web/src/App.tsx:105,378-380,1242,1322,1538-1549`
- Center-shadow hidden CSS: `apps/web/src/styles/app.css:894-896`
- Center-shadow persistence test: `apps/web/src/App.test.tsx:707-715`
- Timeline private/sample/scroll controls: `apps/web/src/features/timeline/GameTimelineScreen.tsx:53-63,510-522,559-600,625-697`
- Timeline marker secrecy projection: `apps/web/src/features/timeline/timeline-model.ts:50-66,452-469`
- Timeline Scroll hint CSS: `apps/web/src/styles/timeline.css:84-89`
- Timer audio lifecycle: `apps/web/src/features/timer/TimerControls.tsx:1-68`
- Timer threshold math: `apps/web/src/features/timer/timer.ts:27-36`
- Browser verification paths: `scripts/verify-ui.mjs:317-365,500-575,850-930`

---

### Task 1: Establish a clean focused baseline without touching existing work

**Objective:** Record the current dirty state and prove the affected test slices are green before writing new RED assertions.

**Files:**
- Read only: all files listed in the current code map
- Do not modify any project file in this task

**Step 1: Record the existing worktree**

Run:

```bash
git status --short --branch
git diff --check
```

Expected:
- branch remains `main...origin/main`;
- the existing modified files and prior untracked plan remain present;
- `git diff --check` exits 0.

**Step 2: Run the current affected tests**

Run:

```bash
npm run test -w @mafia/game-domain -- src/night-actions.test.ts
npm run test -w @mafia/web -- \
  src/features/night/NightStage.test.tsx \
  src/features/game/GameScreen.test.tsx \
  src/features/setup/SetupWizard.test.tsx \
  src/App.test.tsx
```

Expected: PASS before adding the new behavior assertions.

**Step 3: Capture implementation boundaries**

Confirm with searches that:

```text
reopenMafiaShots
onReopenLastAcceptedEvent
centerShadowStorageKey
is-center-shadow-hidden
renderRedCardAction
```

have only the usages listed above. Do not expand scope if unrelated similarly named code exists.

**Step 4: Rapid checkpoint**

Run `git diff --check`. Do not commit.

---

### Task 1A: Reproduce and isolate Mafia evaluation lockout after Timeline browsing

**Objective:** Turn the attached iPad state into a deterministic regression before changing Timeline or Mafia-shot code, then fix only the boundary proven to be stale.

**Screenshot evidence:**

- Current phase is `Mafia shots`.
- Three living Mafia shooters are visible: Don #1 and Mafia #5/#6.
- All three shooter buttons are selected on target #2.
- The table center says `3 of 3 shooters assigned`.
- `Evaluate Mafia shots` looks enabled, yet tapping it reportedly does not evaluate.
- The state occurred after browsing the past-game Timeline.
- Timer is at zero, but evaluation has no timer prerequisite.

**Files for investigation/test:**
- Test: `apps/web/src/App.test.tsx`
- Test: `apps/web/src/features/night/NightStage.test.tsx`
- Browser regression: `scripts/verify-ui.mjs`
- Inspect/fix only if evidence points there: `apps/web/src/App.tsx:431-437,1679-1693,1781-1810`
- Inspect/fix only if evidence points there: `apps/web/src/features/game/GameScreen.tsx:543-554`
- Inspect/fix only if evidence points there: `apps/web/src/features/night/NightStage.tsx:87-165`
- Inspect/fix only if evidence points there: `apps/web/src/session-outbox.ts`

**Step 1: Add an App-level view-transition RED**

Using the existing mocked `GameScreen`, prove a meaningful game action remains accepted after entering Timeline, selecting a marker, and returning via Back:

```ts
await user.click(screen.getByRole("button", { name: "Start test game" }));
await user.click(screen.getByRole("button", { name: "Open developer menu" }));
await user.click(screen.getByRole("button", { name: "Past game timeline" }));
await user.click(screen.getByRole("button", { name: /Game started|Phase: day/ }));
await user.click(screen.getByRole("button", { name: "Back" }));
await user.click(screen.getByRole("button", { name: "Record meaningful checkpoint" }));

expect(screen.getByText("Game fouls 1")).toBeInTheDocument();
expect(api.saveGameSession).toHaveBeenCalledWith(
  expect.any(String),
  expect.objectContaining({ kind: "append-event" }),
  expect.anything(),
);
```

Use the test harness's exact save function signature rather than forcing this illustrative matcher if it differs.

**Step 2: Add the exact browser RED at Mafia shots**

Extend the deterministic journey to:

1. reach `night-mafia`;
2. open Timeline while already in Mafia shots;
3. select/inspect at least one current-game marker without Preview or Reset;
4. return with Back;
5. assign all active Mafia shooters to one active target;
6. assert the center text equals `{N} of {N} shooters assigned`;
7. assert `Evaluate Mafia shots` is enabled;
8. click Evaluate;
9. require one `POST .../events` request with `type === "mafia.shots-resolved"`;
10. require the `Mafia result` heading/result card.

Capture before-click evidence in the failure message:

```js
{
  phaseClass,
  assignmentCount,
  shooterCount,
  evaluateDisabled,
  saveStatus,
  headEventId,
  outboxKinds,
  pageErrors,
}
```

**Step 3: Run RED and classify the boundary**

Run:

```bash
npm run test -w @mafia/web -- src/App.test.tsx -t "Timeline.*meaningful"
APP_URL=http://127.0.0.1:5173 UI_HEADER_ONLY=1 npm run verify:ui
```

Use the first failing boundary:

| Evidence | Root-cause area | Minimal fix direction |
|---|---|---|
| Button disabled while count is complete | `NightStage` derives counter and eligibility from different shooter sets | Derive both from one sorted `shooters` list and one `allShotsRecorded` predicate. |
| Button enabled but no request/local transition | stale `canApplyGameScreenMutation` generation after Timeline navigation | Remount/rebind the live `GameScreen` on return or replace the render-captured generation check with a current view/session capability that still rejects callbacks from unmounted screens. |
| Request sent and server returns conflict | canonical head/outbox diverged while Timeline was open | Reconcile the current head before append; do not fabricate or append intermediate events. |
| Request succeeds but UI immediately reverts | stale async session response overwrites newer local head | Apply latest-request/session-generation protection at the response boundary. |

Do not change code if both regressions pass. In that case, retain the tests, record the unreproduced screenshot state, and request console/network evidence from the affected iPad rather than guessing.

**Step 4: Implement one confirmed fix**

Change only the boundary selected in Step 3. Preserve:

- meaningful-checkpoint-only history;
- in-memory Mafia shot assignments;
- preview/reset branch semantics;
- exact one-event `mafia.shots-resolved` acceptance;
- active-shooter count and dead-player targeting policy.

**Step 5: Run GREEN**

Re-run the focused App test and exact browser journey. Expected: one request, visible Mafia result, no page error, and no duplicate event.

**Step 6: Rapid checkpoint**

Run `git diff --check`. Do not commit.

---

### Task 2: Stop generating and rendering the Happy day indicator

**Objective:** A Mafia miss/no-effect advances directly to the next Day with no `Happy day` state or UI, including for legacy states that still contain `dayNotice: "happy"`.

**Files:**
- Modify: `packages/game-domain/src/night-actions.test.ts:193-200`
- Modify: `packages/game-domain/src/night-actions.ts:268-307`
- Modify: `apps/web/src/features/game/GameScreen.test.tsx:530-545`
- Modify: `apps/web/src/features/game/GameScreen.tsx:297-303`
- Modify: `apps/web/src/styles/app.css:1651-1669`
- Intentionally unchanged for compatibility: `packages/game-domain/src/types.ts:66-93`
- Intentionally unchanged for compatibility: `apps/server/src/game-session-validation.ts:197`
- Intentionally unchanged for compatibility: `packages/game-domain/src/game-events.ts:533-536,695-699`

**Step 1: Write the domain RED**

Change the miss test to require no new Happy-day field:

```ts
const nextDay = completeNight({
  ...base,
  phase: "night-resolution",
  nightResult: { kind: "miss" },
});

expect(nextDay).toMatchObject({ phase: "day", day: 2 });
expect(nextDay).not.toHaveProperty("dayNotice");
```

Keep the existing kill/goodbye assertions in the same test.

**Step 2: Write the UI RED for legacy compatibility**

Render a Day state that still contains the old field and prove it is ignored:

```tsx
render(
  <GameScreen
    game={{ ...day, dayNotice: "happy" }}
    hostName="Host Player"
    onGameChange={() => undefined}
    onEvent={() => undefined}
    privacyHidden={false}
  />,
);

expect(screen.queryByText("Happy day")).toBeNull();
expect(screen.getByText("Current speaker")).toBeInTheDocument();
```

Rename the existing mixed test so team-count and finish behavior remain covered independently from Happy day.

**Step 3: Run RED**

Run:

```bash
npm run test -w @mafia/game-domain -- src/night-actions.test.ts -t "miss"
npm run test -w @mafia/web -- src/features/game/GameScreen.test.tsx -t "Happy day"
```

Expected: FAIL because `completeNight` still sets `dayNotice: "happy"` and `GameScreen` still renders `.happy-day-note`.

**Step 4: Implement the minimum state change**

In `completeNight`, return the ordinary Day state without adding `dayNotice`:

```ts
return {
  ...dayState,
  phase: "day",
  goodbyeSeats: undefined,
  goodbyeNext: undefined,
  nightResult: undefined,
};
```

Do not remove the optional legacy field from `GameState`, replay validation, or server schema.

**Step 5: Remove the presentation**

Replace the Day center with:

```tsx
<div className="day-center-stack">
  <span className="table-prompt">Current speaker</span>
  <strong>{currentPlayer?.name ?? "Waiting for active player"}</strong>
</div>
```

Delete only the `.happy-day-note` CSS rule. Keep `.day-center-stack` because it still owns layout.

**Step 6: Run GREEN**

Run both Task 2 test commands. Expected: PASS.

**Step 7: Rapid checkpoint**

Run `git diff --check`. Do not commit.

---

### Task 3: Reuse one Mafia shot result card on immediate and final Night results

**Objective:** The final `Night complete` screen visibly states whether Mafia killed a player, missed, or targeted a player already out.

**Files:**
- Modify: `apps/web/src/features/night/NightStage.test.tsx`
- Modify: `apps/web/src/features/night/NightStage.tsx:1-20,169-204,450-488`
- Reuse: `apps/web/src/styles/app.css:1148-1165`

**Step 1: Add final-result RED cases**

Add compact fixtures for `night-resolution`:

```ts
const miss: GameState = {
  ...createNightGame(),
  phase: "night-resolution",
  nightResult: { kind: "miss" },
};

render(<Harness initial={miss} />);
expect(screen.getByRole("group", { name: "Mafia missed" })).toHaveTextContent(
  "No player died",
);
expect(screen.getByRole("button", { name: /begin day 2/i })).toBeInTheDocument();
```

Add a kill case:

```ts
const target = base.players.find(({ team }) => team === "red")!;
const kill: GameState = {
  ...base,
  phase: "night-resolution",
  nightResult: { kind: "kill", targetSeat: target.seat },
};

render(<Harness initial={kill} />);
expect(screen.getByRole("group", { name: "Deceased player" })).toHaveTextContent(target.name);
```

Retain the current immediate-result tests so the refactor cannot regress them. Include the existing no-effect copy in either a third case or a table-driven assertion.

**Step 2: Run RED**

Run:

```bash
npm run test -w @mafia/web -- src/features/night/NightStage.test.tsx -t "final Night"
```

Expected: FAIL because `night-resolution` currently renders only `Night complete`.

**Step 3: Extract a local result component**

Inside `NightStage.tsx`, add one presentational helper accepting `GameState` and `NightShotResult`:

```tsx
const MafiaShotResultCard = ({
  game,
  result,
}: {
  readonly game: GameState;
  readonly result: NightShotResult;
}) => {
  const target =
    result.kind === "miss"
      ? undefined
      : game.players.find(({ seat }) => seat === result.targetSeat);

  if (result.kind === "miss") {
    return (
      <div className="night-miss-card" role="group" aria-label="Mafia missed">
        <span className="table-prompt">Mafia missed</span>
        <strong>No player died</strong>
      </div>
    );
  }
  if (result.kind === "no-effect") {
    return (
      <div className="night-miss-card" role="status" aria-label="Mafia shots had no effect">
        <span className="table-prompt">No effect</span>
        <strong>{target?.name ?? `Seat ${result.targetSeat}`} was already out</strong>
      </div>
    );
  }
  return (
    <div className="deceased-player-card" role="group" aria-label="Deceased player">
      <span className="table-prompt">Deceased player</span>
      <strong>#{target?.seat}</strong>
      <span>{target?.name}</span>
    </div>
  );
};
```

Import `NightShotResult` as a type from `@mafia/game-domain`.

**Step 4: Reuse it in both phases**

- Replace the duplicated immediate `night-mafia-result` branches with `<MafiaShotResultCard game={game} result={result} />`.
- In `night-resolution`, render the card when `game.nightResult` exists.
- Retain the `Begin day N` button and the stage title `Night complete`.
- If a malformed legacy `night-resolution` lacks `nightResult`, retain a simple `Night complete` fallback rather than crashing.

**Step 5: Run GREEN**

Run the full NightStage test file:

```bash
npm run test -w @mafia/web -- src/features/night/NightStage.test.tsx
```

Expected: PASS.

**Step 6: Rapid checkpoint**

Run `git diff --check`. Do not commit.

---

### Task 4: Remove Re-evaluate Mafia shots and all special rewind plumbing

**Objective:** The Mafia result offers only the normal `Continue night` progression; no dedicated re-evaluation API or special head-move callback remains.

**Files:**
- Modify: `apps/web/src/features/night/NightStage.test.tsx:239-290`
- Modify: `apps/web/src/features/night/NightStage.tsx:1-43,169-238`
- Modify: `apps/web/src/features/game/GameScreen.tsx:22-39,94-111,543-554`
- Modify: `apps/web/src/App.tsx:839-849,1792-1798`
- Modify: `packages/game-domain/src/night-actions.test.ts:1-16,132-138`
- Modify: `packages/game-domain/src/night-actions.ts:149-171`
- Modify: `apps/web/src/styles/app.css:1119-1139`
- Do not edit generated `packages/game-domain/dist/**`; rebuild it later.

**Step 1: Rewrite the NightStage RED**

After evaluating shots, assert:

```ts
expect(screen.queryByRole("button", { name: /re-evaluate mafia shots/i })).toBeNull();
expect(screen.getByRole("button", { name: "Continue night" })).toBeInTheDocument();
expect(onEvent.mock.calls.filter(([type]) => type === "mafia.shots-resolved")).toHaveLength(1);
```

Delete the test steps that reopen, reassign, and evaluate a second time.

**Step 2: Run RED**

Run:

```bash
npm run test -w @mafia/web -- src/features/night/NightStage.test.tsx -t "logs Mafia moves"
```

Expected: FAIL because the re-evaluate button is still rendered.

**Step 3: Remove UI and prop plumbing**

- Delete `onReopenLastAcceptedEvent` from `NightStageProps` and `GameScreenProps`.
- Delete its destructuring and forwarding.
- Delete the `.night-result-actions` wrapper and button from the Mafia result center.
- Delete the callback passed by `App`.
- Delete `reopenLastAcceptedEvent` from `App`.

Do not alter ordinary Undo, Log Reset, Timeline Reset, or branch preservation.

**Step 4: Remove the now-unused domain helper**

Delete:

```ts
export const reopenMafiaShots = (game: GameState): GameState => { ... };
```

Remove its import and dedicated domain test. `index.ts` uses wildcard exports, so no explicit export edit is expected.

**Step 5: Remove dead CSS**

Remove `.night-result-actions` from grouped selectors and delete its one-column rule. Keep result-card styling and ordinary table action styles.

**Step 6: Run GREEN**

Run:

```bash
npm run test -w @mafia/game-domain -- src/night-actions.test.ts
npm run test -w @mafia/web -- \
  src/features/night/NightStage.test.tsx \
  src/features/game/GameScreen.test.tsx \
  src/App.test.tsx
```

Expected: PASS with no `reopenMafiaShots`, `onReopenLastAcceptedEvent`, or `Re-evaluate Mafia shots` references in source/tests.

**Step 7: Rapid checkpoint**

Run the three searches, then `git diff --check`. Do not commit.

---

### Task 5: Remove inline Red buttons from Don and Sheriff checks while preserving swipe Red

**Objective:** Don/Sheriff selection and result screens contain no inline `Red` button above player cards; swipe remains the only night discipline affordance.

**Files:**
- Modify: `apps/web/src/features/night/NightStage.test.tsx:41-67,171-236`
- Modify: `apps/web/src/features/night/NightStage.tsx:1-20,44-67,241-447`
- Verify unchanged: `apps/web/src/features/game/GameScreen.tsx` swipe action ownership
- Verify unchanged: `apps/web/src/features/table/GameTable.tsx` swipe behavior

**Step 1: Replace the obsolete Red-control test with RED absence coverage**

Use representative active-owner states for all four phases:

```ts
for (const phase of [
  "night-don",
  "night-don-result",
  "night-sheriff",
  "night-sheriff-result",
] as const) {
  const game = privatePhaseFixture(base, phase);
  const { unmount } = render(<NightStage game={game} ... />);
  expect(screen.queryByRole("button", { name: /^Red card / })).toBeNull();
  unmount();
}
```

Build valid `checkResult` payloads for result phases; do not cast malformed state merely to satisfy the test.

**Step 2: Add/retain swipe fallback coverage**

In `GameScreen.test.tsx`, drive a horizontal touch gesture on a player card in an active Don or Sheriff phase and assert the swipe menu exposes exactly the existing `Red card {name}` action only after the gesture.

This separates:
- no always-visible inline Red;
- swipe Red still works.

**Step 3: Run RED**

Run:

```bash
npm run test -w @mafia/web -- \
  src/features/night/NightStage.test.tsx \
  src/features/game/GameScreen.test.tsx
```

Expected: FAIL because the four private-check surfaces still pass `renderSeatActions`.

**Step 4: Remove inline action rendering**

- Delete `renderRedCardAction` from `NightStage`.
- Remove the `redCard` import and `TableSeatView` type import if unused afterward.
- Remove `renderSeatActions` from Don/Sheriff selection and result `GameTable` instances.
- Keep `onSeatSwipe` and `swipeAction` exactly as they are for active owners and result screens.
- Keep dead-owner Skip-only behavior unchanged.

**Step 5: Run GREEN**

Run the Task 5 command. Expected: PASS.

**Step 6: Rapid checkpoint**

Search `NightStage.tsx` for `renderSeatActions` and `Red card`; neither should remain. Run `git diff --check`. Do not commit.

---

### Task 6: Add one explicit off-by-default Dev mode for all development tools

**Objective:** The setup `Development only` player generator and Timeline sample generator are hidden by default and appear only after selecting `Enable dev mode` in the side Dev menu.

**Files:**
- Modify: `apps/web/src/App.test.tsx:108-207,707-794,1779-1810`
- Modify: `apps/web/src/App.tsx:375-381,1480-1610,1679-1693,1725-1731`
- Existing gate retained: `apps/web/src/features/setup/SetupWizard.tsx:28,260,516-546`
- Existing component test retained: `apps/web/src/features/setup/SetupWizard.test.tsx:268-293`
- Add Timeline gate in Task 8A: `apps/web/src/features/timeline/GameTimelineScreen.tsx`

**Step 1: Update the App test mock**

Add `showDevelopmentTools` to the mocked `SetupWizard` props and gate the mock button:

```tsx
{showDevelopmentTools && onPopulateDevelopmentPlayers !== undefined ? (
  <button type="button" onClick={() => void onPopulateDevelopmentPlayers()}>
    Generate test players
  </button>
) : null}
```

**Step 2: Write the App-level RED**

```ts
render(<App />);
expect(screen.queryByRole("button", { name: "Generate test players" })).toBeNull();

await user.click(screen.getByRole("button", { name: "Open developer menu" }));
await user.click(screen.getByRole("button", { name: "Enable dev mode" }));
expect(screen.getByRole("button", { name: "Generate test players" })).toBeInTheDocument();

await user.click(screen.getByRole("button", { name: "Open developer menu" }));
await user.click(screen.getByRole("button", { name: "Disable dev mode" }));
expect(screen.queryByRole("button", { name: "Generate test players" })).toBeNull();
```

Also open Timeline before and after toggling Dev mode: `Generate sample game data` must follow the same authority. Update existing development-roster tests to enable Dev mode before clicking the player generator.

**Step 3: Run RED**

Run:

```bash
npm run test -w @mafia/web -- src/App.test.tsx -t "dev mode|development"
```

Expected: FAIL because App currently gates only on `import.meta.env.DEV` and has no runtime toggle.

**Step 4: Implement one session-local authority**

Add:

```ts
const [devModeEnabled, setDevModeEnabled] = useState(false);
```

Add a Dev drawer button:

```tsx
<button
  type="button"
  aria-pressed={devModeEnabled}
  onClick={() => setDevModeEnabled((enabled) => !enabled)}
>
  {devModeEnabled ? "Disable dev mode" : "Enable dev mode"}
</button>
```

Pass the same value to both development surfaces:

```tsx
<SetupWizard showDevelopmentTools={devModeEnabled} ... />
<GameTimelineScreen showDevelopmentTools={devModeEnabled} ... />
```

Do not add a localStorage/sessionStorage key. Reset Dev mode to false only when the workspace component naturally remounts or when `Clear all data` explicitly resets local UI authorities.

**Step 5: Run GREEN**

Run the focused App test command and `SetupWizard.test.tsx`. Expected: PASS.

**Step 6: Rapid checkpoint**

Verify the source no longer uses `import.meta.env.DEV` for `showDevelopmentTools`. Run `git diff --check`. Do not commit.

---

### Task 7: Put Select available, Assign players, and Start game in one responsive action row

**Objective:** All three player-setup actions share one row when their full labels fit; flex wrapping moves overflow actions to a new line where a lone wrapped action fills the row width.

**Files:**
- Modify: `apps/web/src/features/setup/SetupWizard.test.tsx`
- Modify: `apps/web/src/features/setup/SetupWizard.tsx:581-603`
- Modify: `apps/web/src/styles/app.css:581-612,2502-2511,2753-2756,3020-3025`
- Modify later for rendered geometry: `scripts/verify-ui.mjs:317-365`

**Step 1: Write a semantic component RED**

Render the player step and assert one action group owns the three buttons in order:

```ts
const actions = screen.getByRole("group", { name: "Player setup actions" });
expect(
  within(actions)
    .getAllByRole("button")
    .map((button) => button.textContent?.trim()),
).toEqual(["Select available players", "Assign players", "Start game"]);
```

This test proves semantic grouping; geometry is verified in Task 9 because jsdom has no layout.

**Step 2: Run RED**

Run:

```bash
npm run test -w @mafia/web -- src/features/setup/SetupWizard.test.tsx -t "player setup actions"
```

Expected: FAIL because the buttons currently live in two sibling containers.

**Step 3: Consolidate markup**

Replace the two containers with:

```tsx
<div className="player-setup-actions" role="group" aria-label="Player setup actions">
  <button type="button" onClick={onOpenAvailablePlayers}>
    Select available players
  </button>
  <button
    type="button"
    className="primary-action"
    disabled={selectablePlayers.length < 11}
    onClick={randomlyFillSeats}
  >
    Assign players
  </button>
  <button
    className="primary-action"
    type="button"
    disabled={!playersReady}
    onClick={startRoleDraw}
  >
    Start game
  </button>
</div>
```

**Step 4: Implement label-aware wrapping**

Use flex rather than fixed grid columns:

```css
.player-setup-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  width: 100%;
  margin-top: auto;
}
.player-setup-actions button {
  flex: 1 1 max-content;
  min-height: 48px;
  padding-inline: 18px;
  white-space: nowrap;
}
```

Delete player-step-specific rules for the old two containers. Retain generic `.setup-completion-actions` rules needed by non-player setup stages. Update fullscreen/short-height selectors to target `.player-setup-actions` where they currently target `.player-setup-card .setup-completion-actions`.

**Step 5: Run GREEN**

Run the full `SetupWizard.test.tsx`. Expected: PASS.

**Step 6: Rapid checkpoint**

Run `git diff --check`. Do not commit.

---

### Task 8: Remove the center-shadow toggle and keep the shadow permanently enabled

**Objective:** Dev contains no shadow visibility setting, stale browser values cannot hide it, and the base radial shadow remains unchanged.

**Files:**
- Modify: `apps/web/src/App.test.tsx:707-715`
- Modify: `apps/web/src/App.tsx:105,375-381,1239-1244,1319-1324,1538-1549`
- Modify: `apps/web/src/styles/app.css:864-896`
- Verify unchanged: `.table-center::before` in `apps/web/src/styles/app.css:877-893`

**Step 1: Replace the old persistence test with RED absence behavior**

```ts
window.localStorage.setItem("mafia-dashboard.center-shadow", "hidden");
render(<App />);

await user.click(screen.getByRole("button", { name: "Open developer menu" }));
expect(screen.queryByRole("button", { name: /table center shadow/i })).toBeNull();
expect(document.querySelector(".app-shell")).not.toHaveClass("is-center-shadow-hidden");
```

The stale key may remain inert; do not add migration code solely to delete it.

**Step 2: Run RED**

Run:

```bash
npm run test -w @mafia/web -- src/App.test.tsx -t "center shadow"
```

Expected: FAIL because App still reads the stale key and renders the toggle/class.

**Step 3: Remove all setting code**

Delete:

- `centerShadowStorageKey`;
- `centerShadowVisible` state;
- `setCenterShadowVisible(true)` from clear/reset code;
- conditional `is-center-shadow-hidden` class interpolation;
- Hide/Show shadow Dev button and localStorage writes;
- `.is-center-shadow-hidden .table-center::before` CSS.

Do not alter `.table-center`, `.table-center::before`, its radial gradient, blur, dimensions, or z-index.

**Step 4: Run GREEN**

Run the focused App test. Expected: PASS.

**Step 5: Rapid checkpoint**

Search source/tests/CSS for:

```text
centerShadow
center-shadow
is-center-shadow-hidden
Hide table center shadow
Show table center shadow
```

Expected: zero source/test matches, excluding historical plan files or generated bundles. Run `git diff --check`. Do not commit.

---

### Task 8A: Simplify Timeline chrome and gate sample generation behind Dev mode

**Objective:** Timeline always shows event details without a private-view mode, omits the Scroll hint and Visibility field, and exposes sample generation only while App Dev mode is enabled.

**Files:**
- Modify: `apps/web/src/features/timeline/GameTimelineScreen.test.tsx:53-91,460-520`
- Modify: `apps/web/src/features/timeline/GameTimelineScreen.tsx:1-16,53-63,351-360,510-522,559-600,625-697`
- Modify: `apps/web/src/features/timeline/timeline-model.ts:50-66,452-469`
- Modify: `apps/web/src/features/timeline/timeline-model.test.ts`
- Modify: `apps/web/src/styles/timeline.css:84-89`
- Modify: `apps/web/src/App.tsx:1679-1693`
- Modify: `apps/web/src/App.test.tsx`
- Canonical event secrecy remains unchanged: `packages/game-domain/src/game-events.ts`

**Step 1: Replace the privacy/redaction test with RED removal assertions**

Render a Timeline containing secret Mafia/Don/Sheriff events and assert they are shown normally:

```ts
render(
  <GameTimelineScreen
    clubId={clubId}
    onBack={() => undefined}
    showDevelopmentTools
    loaders={{ listCompleted: () => Promise.resolve([]), getSession: vi.fn() }}
  />,
);

await user.click(screen.getByRole("button", { name: "Generate sample game data" }));
expect(screen.queryByRole("button", { name: /show private info|hide private info/i })).toBeNull();
expect(screen.getByRole("button", { name: /Don checked Player 1: Sheriff/i })).toBeInTheDocument();
expect(screen.queryByRole("button", { name: "Private event" })).toBeNull();
```

Select a secret marker and require its ordinary label/result/shots rather than `Hidden`.

**Step 2: Add RED chrome-removal assertions**

With the long sample Timeline rendered:

```ts
expect(screen.queryByText(/Scroll timeline/i)).toBeNull();
const details = screen.getByLabelText("Selected event details");
expect(within(details).queryByText("Visibility")).toBeNull();
expect(within(details).queryByText(/Host secret|Game log/)).toBeNull();
```

Horizontal scrolling of `.timeline-track-scroll` must remain functional; remove only the hint element.

**Step 3: Add RED Dev-gate coverage**

Default render:

```ts
render(<GameTimelineScreen clubId={clubId} onBack={() => undefined} loaders={loaders} />);
expect(screen.queryByRole("button", { name: "Generate sample game data" })).toBeNull();
```

Enabled render:

```ts
render(
  <GameTimelineScreen
    clubId={clubId}
    onBack={() => undefined}
    loaders={loaders}
    showDevelopmentTools
  />,
);
expect(screen.getByRole("button", { name: "Generate sample game data" })).toBeInTheDocument();
```

Update every existing sample-driven test to pass `showDevelopmentTools`; prefer one local render helper over duplicating the prop in every test.

**Step 4: Run RED**

Run:

```bash
npm run test -w @mafia/web -- \
  src/features/timeline/GameTimelineScreen.test.tsx \
  src/features/timeline/timeline-model.test.ts
```

Expected: FAIL because privacy, scroll hint, Visibility, and unconditional sample controls still exist.

**Step 5: Remove Timeline private-view code**

- Remove `privacyHidden` and `onTogglePrivacy` from `GameTimelineScreenProps` and component destructuring.
- Remove the private-view header button and `EyeOff` import. Keep `Eye` if it remains the Don-check event icon.
- Render every marker with its real icon, class, sequence, aria label, and title.
- Render inspector event/result/shot details directly with no private branch.
- Remove the obsolete privacy props from the `GameTimelineScreen` call in `App`; keep global `privacyHidden` for the live table.
- Remove `secret` from `TimelineMarker` and marker projections if it has no use after redaction/Visibility removal.
- Keep `GameLogEntry.secret` and payload secrecy unchanged for canonical persistence/API behavior.

**Step 6: Remove Scroll hint and Visibility field**

- Delete the `timeline-scroll-hint` span from Timeline metadata.
- Delete `.timeline-scroll-hint` CSS.
- Delete only the inspector `<dt>Visibility</dt>` row.
- Preserve Event, Time, optional Result, accessible details, and shot list.

**Step 7: Gate sample generation with the shared Dev authority**

Add:

```ts
readonly showDevelopmentTools?: boolean;
```

with default `false`, then render:

```tsx
{showDevelopmentTools ? (
  <button type="button" onClick={showSample}>
    Generate sample game data
  </button>
) : null}
```

In `App`, pass the same `devModeEnabled` state introduced by Task 6:

```tsx
showDevelopmentTools={devModeEnabled}
```

Do not create a second Timeline-specific Dev toggle.

**Step 8: Run GREEN**

Run the Task 8A command plus focused App tests. Expected: PASS.

**Step 9: Rapid checkpoint**

Search Timeline source/tests/CSS for:

```text
privacyHidden
onTogglePrivacy
Private event
timeline-scroll-hint
Scroll timeline
<dt>Visibility</dt>
```

Expected: zero Timeline implementation matches. Run `git diff --check`. Do not commit.

---

### Task 8B: Make the ten-second warning beep reliable for 60- and 30-second timers

**Objective:** Starting any 60-, 30-, or 10-second preset produces one faint warning chime when ten seconds remain, including on iPad Safari where creating Web Audio outside a user gesture is suspended.

**Root-cause hypothesis to prove:** `TimerControls` currently creates `AudioContext` only when the warning threshold is crossed. The 10-second preset crosses during the click gesture and can beep; 30/60-second presets create audio later from `setInterval`, which Safari may block/suspend.

**Files:**
- Modify: `apps/web/src/features/timer/TimerControls.test.tsx`
- Modify: `apps/web/src/features/timer/TimerControls.tsx:1-68`
- Keep countdown math: `apps/web/src/features/timer/timer.ts`
- Keep threshold tests: `apps/web/src/features/timer/timer.test.ts`
- Modify browser instrumentation later: `scripts/verify-ui.mjs`

**Step 1: Build a deterministic fake AudioContext**

In `TimerControls.test.tsx`, install a fake with spies for `resume`, oscillator `start/stop`, gain ramps, `connect`, and `disconnect`. Give it a fixed `currentTime`, for example `5`.

The fake must satisfy only the methods used by `TimerControls`; restore `window.AudioContext` after each test.

**Step 2: Write RED scheduled-warning assertions**

For a 60-second click, require creation/resume during the click and a scheduled oscillator at current time + 50 seconds:

```ts
await user.click(screen.getByRole("button", { name: "Start 60 second timer" }));
expect(audioContextConstructor).toHaveBeenCalledOnce();
expect(oscillatorStart).toHaveBeenCalledWith(55);
```

For 30 seconds, require `start(25)` with the same fixed current time. For 10 seconds, require immediate `start(5)`. Use separate renders or reset spies so one preset cannot satisfy another's assertion.

Add a cancellation assertion: stopping or replacing a countdown cancels/disconnects a warning scheduled for the old timer and schedules exactly one new warning.

**Step 3: Run RED**

Run:

```bash
npm run test -w @mafia/web -- src/features/timer/TimerControls.test.tsx
```

Expected: FAIL because the current 60/30-second click does not create or schedule audio.

**Step 4: Unlock and schedule audio during the user gesture**

Refactor the chime helper to accept/reuse one component-owned AudioContext. Add refs for the context and currently scheduled oscillator/cleanup.

On each preset click:

1. create the context if absent;
2. call `resume()` while still handling the click if suspended;
3. cancel the previous scheduled warning;
4. schedule the oscillator at:

```ts
const warningDelay = Math.max(0, seconds - 10);
const startsAt = context.currentTime + warningDelay;
```

5. stop it at `startsAt + 0.18`;
6. start the timestamp-based countdown as today.

Do not create a second context from the interval. Keep `readCountdown(...).emitWarning` for authoritative threshold state/visual warning, but remove interval-triggered audio so only the pre-scheduled oscillator chimes once.

**Step 5: Cancel safely**

- Stop/disconnect a pending oscillator on Stop, preset replacement, and unmount.
- Guard repeated `stop()` calls because Web Audio nodes can throw when stopped twice.
- If `AudioContext` is unavailable, preserve a fully working visual timer with no exception.
- Do not close the shared context on every preset; reuse it for the mounted component.

**Step 6: Run GREEN**

Run:

```bash
npm run test -w @mafia/web -- \
  src/features/timer/timer.test.ts \
  src/features/timer/TimerControls.test.tsx
```

Expected: PASS; countdown timestamp behavior remains unchanged.

**Step 7: Browser/iPad verification**

In the browser verifier, instrument `AudioContext` before app load and assert 60/30/10 presets schedule delays of 50/20/0 seconds respectively. Automated tests can prove scheduling but not audible device output; include one manual iPad acceptance step to hear the beep at ten seconds remaining for 60 and 30.

**Step 8: Rapid checkpoint**

Run `git diff --check`. Do not commit.

---

### Task 8C: Add a full-screen error Console accessible from Dev

**Objective:** Provide a separate full-screen Console view that continuously lists every captured client error and can be opened from the side Dev menu without changing the active game head/state.

**Scope definition:** “All errors” includes:

- every `console.error(...)` call;
- uncaught `window.error` events;
- unhandled Promise rejections;
- caught application/API/persistence errors that currently become UI flags or are swallowed;
- React/API error message, timestamp, source/context, and stack when available.

It does **not** include normal `console.log`, info, debug, or warnings. Diagnostics are memory-only, bounded, and must not retain credentials, OAuth values, cookies, request bodies, playlist IDs, or player personal data.

**Files:**
- Create: `apps/web/src/features/console/error-console.ts`
- Create: `apps/web/src/features/console/error-console.test.ts`
- Create: `apps/web/src/features/console/ErrorConsoleScreen.tsx`
- Create: `apps/web/src/features/console/ErrorConsoleScreen.test.tsx`
- Modify: `apps/web/src/main.tsx:1-12`
- Modify: `apps/web/src/App.tsx:89-90,308-309,1286-1323,1480-1610,1679-1817`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/api/client.ts:230-250`
- Audit/modify caught-error boundaries: `apps/web/src/App.tsx`, `apps/web/src/session-outbox.ts`, `apps/web/src/features/music/AccountPlaylistPicker.tsx`, `apps/web/src/features/music/YouTubePlaylistPlayer.tsx`, `apps/web/src/features/music/music-controller.ts`, `apps/web/src/features/players/PlayersScreen.tsx`, `apps/web/src/features/setup/SetupWizard.tsx`, `apps/web/src/features/timeline/GameTimelineScreen.tsx`, `apps/web/src/features/clubs/ClubPortal.tsx`
- Modify: `apps/web/src/styles/app.css`
- Modify browser acceptance: `scripts/verify-ui.mjs`

**Step 1: Write the error-store contract RED**

Define the wished-for public API in the test:

```ts
import {
  clearErrorConsole,
  getErrorConsoleSnapshot,
  installErrorConsoleCapture,
  reportAppError,
  subscribeToErrorConsole,
} from "./error-console.js";
```

Assert an explicit reported error produces a normalized entry:

```ts
reportAppError(new Error("Mafia evaluation failed"), {
  source: "application",
  context: "mafia.shots-resolved",
});

expect(getErrorConsoleSnapshot()).toEqual([
  expect.objectContaining({
    level: "error",
    source: "application",
    context: "mafia.shots-resolved",
    message: "Mafia evaluation failed",
    stack: expect.stringContaining("Mafia evaluation failed"),
    createdAt: expect.any(String),
  }),
]);
```

**Step 2: Add capture RED cases**

After `installErrorConsoleCapture()`:

1. call `console.error("failed", new Error("detail"))` and prove the original console method still receives the exact arguments while one normalized entry is added;
2. dispatch an `ErrorEvent("error", { error: new Error("uncaught") })`;
3. dispatch an `unhandledrejection` event with `reason: new Error("rejected")`;
4. report circular/non-Error values and prove serialization cannot throw;
5. add more than the cap (recommended 200) and prove only the newest entries remain;
6. call the installer twice and prove no duplicate listeners/console wrapping;
7. clear the buffer and prove subscribers receive the empty snapshot.

Use deterministic IDs/timestamps through injectable factories or Vitest fake time; do not make production depend on test globals.

**Step 3: Run store RED**

Run:

```bash
npm run test -w @mafia/web -- src/features/console/error-console.test.ts
```

Expected: FAIL because the error store does not exist.

**Step 4: Implement a bounded external store**

Use one module-level immutable snapshot and listener set suitable for `useSyncExternalStore`:

```ts
export interface ErrorConsoleEntry {
  readonly id: string;
  readonly level: "error";
  readonly source: "console" | "window" | "promise" | "application" | "api" | "persistence";
  readonly context: string | null;
  readonly message: string;
  readonly stack: string | null;
  readonly createdAt: string;
}
```

Rules:

- append by replacing the array reference;
- cap at the newest 200;
- safely normalize `Error`, strings, primitives, arrays, and circular objects;
- retain only sanitized summaries, never arbitrary response/request bodies;
- never call `console.error` from the reporter (prevents recursion);
- `installErrorConsoleCapture` is idempotent and keeps the original console method.

**Step 5: Install capture before React**

In `main.tsx`, call the installer before `createRoot(...).render(...)`:

```ts
installErrorConsoleCapture();
```

This ensures startup and render-time console/window errors are captured.

**Step 6: Write the full-screen component RED**

Render the screen against the store and assert:

- heading `Console`;
- empty state `No errors captured.`;
- newest-first error rows;
- visible timestamp, source/context, message, and stack;
- long stack/message uses internal scrolling and pre-wrapped text;
- `Clear console` clears entries after confirmation or directly if no confirmation is planned;
- Back invokes `onBack`;
- no live game mutation controls are present.

Use accessible row labels such as `Error 1: Mafia evaluation failed` rather than relying on CSS selectors.

**Step 7: Implement `ErrorConsoleScreen`**

Use `useSyncExternalStore(subscribeToErrorConsole, getErrorConsoleSnapshot)` and reverse only for presentation so canonical storage remains append order. Recommended structure:

```tsx
<main className="error-console-screen" aria-label="Error console">
  <header className="error-console-header">
    <button type="button" onClick={onBack}>Back</button>
    <div><p className="eyebrow">Developer diagnostics</p><h1>Console</h1></div>
    <button type="button" disabled={entries.length === 0} onClick={clearErrorConsole}>
      Clear console
    </button>
  </header>
  <section className="error-console-list" aria-live="polite">...</section>
</main>
```

The page itself must fill the viewport and not document-scroll; only `.error-console-list` scrolls.

**Step 8: Add App routing and Dev-menu access**

- Extend `WorkspaceView` with `"console"`.
- Add a `viewBeforeConsoleRef` so Back returns to Game or Players without losing the active state.
- Add an always-visible Dev drawer button named `Console`; it does not require Dev mode because diagnostics must remain reachable when setup/sample tools are disabled.
- Render `<ErrorConsoleScreen onBack={...} />` as a full-screen sibling of Timeline/Players/Game.
- Exclude Console from application status chrome, live timer rail, and game mutation surfaces.
- Keep `MusicDock` mounted but hidden while Console is open, matching Timeline/Players behavior.
- Opening, clearing, or closing Console must not modify `game`, canonical events, head, outbox, timer data, or persistence revision.

**Step 9: Add App navigation RED/GREEN**

Test:

```ts
reportAppError(new Error("Captured before navigation"), {
  source: "application",
  context: "test",
});
render(<App />);
await user.click(screen.getByRole("button", { name: "Open developer menu" }));
await user.click(screen.getByRole("button", { name: "Console" }));
expect(screen.getByRole("heading", { name: "Console" })).toBeInTheDocument();
expect(screen.getByText("Captured before navigation")).toBeInTheDocument();
expect(screen.queryByLabelText("Application tools")).toBeNull();
await user.click(screen.getByRole("button", { name: "Back" }));
expect(screen.getByRole("heading", { name: /Live test game|Game setup/ })).toBeInTheDocument();
```

For a live game, snapshot the durable browser envelope before/after Console navigation and require byte equality.

**Step 10: Route caught errors into the store**

Audit every non-test `catch`/`.catch` in `apps/web/src`. At each boundary that converts an exception into UI state, add one context-rich report before the existing behavior:

```ts
catch (error) {
  reportAppError(error, { source: "application", context: "players.list" });
  setPlayersError(true);
}
```

For API failures, report only safe `ApiError` metadata (`message`, `status`, `code`, endpoint label), never response body/headers. For persistence/outbox failures, report operation kind and safe revision/context, not full event payload/state. Avoid duplicate reports: if an API boundary already reports and a UI catch merely displays the same tagged error, dedupe by object identity or mark it as reported.

Create a checklist from the search counts and finish with zero unreviewed swallowed catches. Expected starting audit: App ~22, session outbox ~6, and smaller component groups; exact counts may change with earlier tasks.

**Step 11: Run focused Console GREEN**

Run:

```bash
npm run test -w @mafia/web -- \
  src/features/console/error-console.test.ts \
  src/features/console/ErrorConsoleScreen.test.tsx \
  src/App.test.tsx \
  src/api/client.test.ts \
  src/session-outbox.test.ts
```

Expected: PASS.

**Step 12: Add fullscreen/iPad browser acceptance**

In `verify-ui.mjs`:

1. inject one deterministic `console.error`, one `window.error`, and one rejected Promise without leaking secrets;
2. open Dev → Console;
3. require all three rows and their source labels;
4. measure the screen against the viewport (`x=0`, `y=0`, width/height equal viewport within 1 px);
5. require document scroll height ≤ viewport + 1 and internal list overflow when many rows are injected;
6. clear the console and verify the empty state;
7. Back to the prior game state;
8. prove the sessionStorage aggregate/head is byte-identical.

Capture a Console screenshot and include its path/count/geometry in verifier output.

**Step 13: Rapid checkpoint**

Run:

```bash
git diff --check
```

Do not commit.

---

### Task 9: Extend the deterministic iPad verifier for every requested UI/state contract

**Objective:** Prove full-screen Console capture/navigation, Timeline-to-game mutation recovery, Timeline chrome removals, Dev gates, timer scheduling, night-result changes, responsive player actions, and permanent center shadow in the real browser at the canonical iPad geometry.

**Files:**
- Modify: `scripts/verify-ui.mjs:317-365,500-575,850-930,1255-1256`
- Rebuild/reload: existing local Vite app on `http://127.0.0.1:5173`

**Step 1: Verify Dev mode and default hidden state**

Before setup player selection:

1. Assert `Development only` and its generator are absent.
2. Open Dev and assert `Enable dev mode` exists.
3. Assert no shadow toggle exists.
4. Click `Enable dev mode`; close Dev.
5. Assert the development-only section appears.
6. Open Timeline and assert `Generate sample game data` appears while Dev mode is enabled.
7. Reopen Dev, click `Disable dev mode`, and assert both the setup section and Timeline sample button disappear again.

Do not use the development generator for the canonical journey; continue with the deterministic API-created players.

**Step 1A: Verify simplified Timeline chrome**

On the current-game Timeline and Dev-enabled sample Timeline, require:

- no Show/Hide private-info button;
- no `Private event` marker labels;
- secret Mafia/Don/Sheriff event labels/details remain readable;
- no `Scroll timeline` text or `.timeline-scroll-hint` element;
- no `Visibility`, `Host secret`, or `Game log` field in Selected event details;
- horizontal track scrolling still changes `.timeline-track-scroll.scrollLeft`.

**Step 1B: Verify Mafia evaluation after Timeline browsing**

Run the exact Task 1A sequence while the live phase is Mafia shots: open Timeline, inspect a marker, return, assign all shooters, click Evaluate, observe exactly one canonical event request, and reach Mafia result. Include the screenshot-derived state (`3 of 3`) in failure diagnostics.

**Step 1C: Verify timer warning scheduling**

Install an AudioContext probe before app startup and click +60, +30, and +10 in isolated timer states. Require warning oscillator offsets of 50, 20, and 0 seconds and one scheduled warning per preset. Restore the real API after the probe; leave audible confirmation to the final iPad check.

**Step 2: Measure the three-button default row**

At the canonical fullscreen iPad player setup:

```js
const actionRects = await page
  .getByRole("group", { name: "Player setup actions" })
  .getByRole("button")
  .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().toJSON()));
```

Require:

- three buttons;
- all three top coordinates within 1 CSS pixel;
- no overlap;
- every label fully contained.

**Step 3: Measure wrap behavior**

Temporarily constrain only the action group to a width too small for all three full labels, then require:

- at least two distinct rows;
- any button alone on its wrapped row has width within 1 CSS pixel of the group content width;
- no text clipping or horizontal document overflow.

Restore the inline probe style before continuing and before screenshots.

**Step 4: Verify permanent shadow**

Read `getComputedStyle(tableCenter, "::before")` and require:

```js
{
  display: valueNotEqualToNone,
  backgroundImage: valueContainingRadialGradient,
}
```

Also require the App shell never has `is-center-shadow-hidden` even if the stale localStorage key was seeded before load.

**Step 5: Replace re-evaluate assertions**

After Mafia evaluation:

- retain the canonical `mafia.shots-resolved` request/hash/payload checks;
- assert the result card is visible;
- assert `Re-evaluate Mafia shots` is absent;
- assert `Continue night` is the only result progression button;
- remove retry-button geometry and associated error messages.

**Step 6: Verify Don/Sheriff inline Red absence**

On Don check, Don result, Sheriff check, and Sheriff result, require zero `button[name^="Red card "]` before any swipe gesture. Keep one existing swipe probe on a private-check screen or rely on the focused GameScreen swipe regression plus the existing journey-wide swipe probe.

**Step 7: Verify final Night result**

At `Night complete`, require the same Mafia result card from the evaluated shot:

- kill: deceased player name/seat;
- miss: `Mafia missed` and `No player died`;
- no-effect: target and `was already out`.

The canonical journey currently produces a kill, so add a bounded restored-state miss probe or a second deterministic assignment pattern to prove the miss copy too.

**Step 8: Verify Happy day absence**

From the miss `night-resolution` fixture:

1. click `Begin day N`;
2. wait for the Day heading/current speaker;
3. assert `Happy day` is absent;
4. assert the Day center still fits the canonical table geometry.

**Step 9: Run verifier syntax and focused browser journey**

Run:

```bash
node --check scripts/verify-ui.mjs
APP_URL=http://127.0.0.1:5173 UI_HEADER_ONLY=1 npm run verify:ui
```

Expected: `Focused iPad gameplay verification: PASS` with Console geometry/error capture, Timeline chrome, post-Timeline Mafia evaluation, timer schedule, action-row, center-shadow, immediate result, final Night result, and no-Happy-day evidence in the JSON summary.

**Step 10: Rapid checkpoint**

Run `git diff --check`. Do not commit.

---

### Task 10: Run focused verification and hand off the uncommitted prototype

**Objective:** Prove the changed domain/UI paths work together without broad finalization work during rapid prototype mode.

**Files:**
- Verify all modified files from Tasks 2-9
- Update this plan only if implementation discovers a requirement correction

**Step 1: Run domain tests**

```bash
npm run test -w @mafia/game-domain -- \
  src/night-actions.test.ts \
  src/game-replay.test.ts
```

Expected: PASS; legacy replay remains compatible and miss/no-effect Day transitions have no new Happy indicator.

**Step 2: Run focused web tests**

```bash
npm run test -w @mafia/web -- \
  src/App.test.tsx \
  src/features/setup/SetupWizard.test.tsx \
  src/features/night/NightStage.test.tsx \
  src/features/game/GameScreen.test.tsx \
  src/features/table/GameTable.test.tsx \
  src/features/timeline/timeline-model.test.ts \
  src/features/timeline/GameTimelineScreen.test.tsx \
  src/features/timer/timer.test.ts \
  src/features/timer/TimerControls.test.tsx \
  src/features/console/error-console.test.ts \
  src/features/console/ErrorConsoleScreen.test.tsx \
  src/api/client.test.ts \
  src/session-outbox.test.ts
```

Expected: PASS.

**Step 3: Run type and build gates**

```bash
npm run typecheck
npm run build
```

Expected: both exit 0. The build regenerates domain declarations/bundles; do not hand-edit `dist`.

**Step 4: Re-run browser acceptance**

```bash
APP_URL=http://127.0.0.1:5173 UI_HEADER_ONLY=1 npm run verify:ui
```

Expected: PASS at canonical fullscreen iPad geometry.

**Step 5: Review only the requested diff**

```bash
git diff --check
git diff -- \
  packages/game-domain/src/night-actions.ts \
  packages/game-domain/src/night-actions.test.ts \
  apps/web/src/main.tsx \
  apps/web/src/App.tsx \
  apps/web/src/App.test.tsx \
  apps/web/src/api/client.ts \
  apps/web/src/session-outbox.ts \
  apps/web/src/features/console/error-console.ts \
  apps/web/src/features/console/error-console.test.ts \
  apps/web/src/features/console/ErrorConsoleScreen.tsx \
  apps/web/src/features/console/ErrorConsoleScreen.test.tsx \
  apps/web/src/features/clubs/ClubPortal.tsx \
  apps/web/src/features/music/AccountPlaylistPicker.tsx \
  apps/web/src/features/music/YouTubePlaylistPlayer.tsx \
  apps/web/src/features/music/music-controller.ts \
  apps/web/src/features/players/PlayersScreen.tsx \
  apps/web/src/features/setup/SetupWizard.tsx \
  apps/web/src/features/setup/SetupWizard.test.tsx \
  apps/web/src/features/night/NightStage.tsx \
  apps/web/src/features/night/NightStage.test.tsx \
  apps/web/src/features/game/GameScreen.tsx \
  apps/web/src/features/game/GameScreen.test.tsx \
  apps/web/src/features/timeline/timeline-model.ts \
  apps/web/src/features/timeline/timeline-model.test.ts \
  apps/web/src/features/timeline/GameTimelineScreen.tsx \
  apps/web/src/features/timeline/GameTimelineScreen.test.tsx \
  apps/web/src/features/timer/TimerControls.tsx \
  apps/web/src/features/timer/TimerControls.test.tsx \
  apps/web/src/styles/app.css \
  apps/web/src/styles/timeline.css \
  scripts/verify-ui.mjs
```

Expected: no unrelated refactors, no accidental rollback of existing uncommitted work, and no whitespace errors.

**Step 6: Handoff**

- Reopen `http://127.0.0.1:5173` in the preview pane.
- Report the exact focused tests and browser evidence.
- Explicitly state that changes remain uncommitted.
- Defer repository-wide lint/format/full `npm run check`, independent review, commit, and push until Michael accepts/finalizes the prototype.

---

## Files likely to change

| File | Planned change |
|---|---|
| `packages/game-domain/src/night-actions.ts` | Stop setting new Happy-day state; remove `reopenMafiaShots`. |
| `packages/game-domain/src/night-actions.test.ts` | Assert miss advances without Happy state; remove reopen test. |
| `apps/web/src/features/game/GameScreen.tsx` | Remove Happy-day rendering and reopen prop forwarding. |
| `apps/web/src/features/game/GameScreen.test.tsx` | Assert legacy Happy field is ignored and swipe Red remains. |
| `apps/web/src/features/night/NightStage.tsx` | Shared Mafia result card, final Night result, no re-evaluate, no inline Red. |
| `apps/web/src/features/night/NightStage.test.tsx` | Result variants, no re-evaluate, no inline Red. |
| `apps/web/src/features/setup/SetupWizard.tsx` | One responsive three-button action group. |
| `apps/web/src/features/setup/SetupWizard.test.tsx` | Semantic action grouping and retained generator behavior. |
| `apps/web/src/main.tsx` | Install global error capture before React renders. |
| `apps/web/src/App.tsx` | Runtime Dev mode, full-screen Console route, caught-error reporting; remove shadow/re-evaluate plumbing. |
| `apps/web/src/App.test.tsx` | Dev gate, Console navigation/state immutability, permanent shadow, generator workflows. |
| `apps/web/src/api/client.ts` | Safely report API errors without response/request secrets. |
| `apps/web/src/session-outbox.ts` | Report persistence failures with safe operation context. |
| `apps/web/src/features/console/error-console.ts` | Bounded error store and global capture. |
| `apps/web/src/features/console/error-console.test.ts` | Capture, normalization, dedupe, cap, clear tests. |
| `apps/web/src/features/console/ErrorConsoleScreen.tsx` | Full-screen internally scrolling Console UI. |
| `apps/web/src/features/console/ErrorConsoleScreen.test.tsx` | Empty/list/clear/Back/accessibility coverage. |
| Existing caught-error component boundaries | Report safe context before retaining current user-facing fallback behavior. |
| `apps/web/src/styles/app.css` | Console geometry plus removal of Happy/re-evaluate/hidden-shadow CSS and responsive action row. |
| `apps/web/src/features/timeline/timeline-model.ts` | Remove Timeline-only marker secrecy projection after private view/Visibility removal. |
| `apps/web/src/features/timeline/timeline-model.test.ts` | Preserve semantic markers without private-view state. |
| `apps/web/src/features/timeline/GameTimelineScreen.tsx` | Remove private view, Scroll hint, Visibility; gate sample data by shared Dev mode. |
| `apps/web/src/features/timeline/GameTimelineScreen.test.tsx` | Timeline chrome removal, always-visible details, Dev-gated sample coverage. |
| `apps/web/src/styles/timeline.css` | Remove obsolete Scroll hint styling. |
| `apps/web/src/features/timer/TimerControls.tsx` | Unlock/schedule one warning chime from the preset user gesture. |
| `apps/web/src/features/timer/TimerControls.test.tsx` | Verify 60/30/10 warning schedules and cancellation. |
| `scripts/verify-ui.mjs` | Real-browser acceptance for all requested changes. |

## Files intentionally not changed

- `packages/game-domain/src/types.ts` — retain legacy `dayNotice` acceptance.
- `packages/game-domain/src/game-events.ts` — retain legacy state-copy/validation compatibility.
- `apps/server/src/game-session-validation.ts` — retain old saved-session compatibility.
- `packages/game-domain/dist/**` and `apps/web/dist/**` — generated only by the normal build.
- Canonical history/event persistence — Timeline presentation changes do not alter event payloads, secrecy flags, hashes, or meaningful-checkpoint storage.

## Risks and tradeoffs

1. **Legacy Happy-day state:** deleting the field from types/schema would make old sessions fail validation. The plan suppresses rendering and stops new generation while retaining compatibility.
2. **No dedicated re-evaluate:** correcting a mistaken Mafia result now relies on ordinary Undo/Reset rather than a result-local button. This is intentional per the removal request.
3. **Dev mode persistence:** session-local mode is safest and satisfies “hidden by default”; users must re-enable it after reload. Persisting it would require an explicit product decision and storage test.
4. **Flex wrapping:** `max-content` + `white-space: nowrap` makes label width determine wrapping, as requested. Extremely narrow widths below the longest single label may still need a small-screen override that permits text wrapping inside a full-width button; add only if the browser probe demonstrates the need.
5. **Swipe discoverability:** removing inline Red reduces visible discoverability, but the user explicitly prefers the existing swipe action. Do not add a replacement hint unless requested.
6. **Dirty worktree:** all edits must be surgical because the same files already contain accepted uncommitted prototype work.
7. **Timeline secrecy presentation:** removing private view means host-secret event content is always visible on the host Timeline. Canonical secrecy metadata remains for storage/API purposes.
8. **Web Audio scheduling:** pre-scheduling fixes Safari gesture restrictions and background-tab interval drift, but scheduled nodes must be cancelled carefully on Stop/restart/unmount to avoid a stale beep.
9. **Mafia evaluation may be timing-specific:** if the exact post-Timeline regression cannot reproduce, do not weaken mutation-generation guards speculatively; preserve diagnostic tests and collect affected-device console/network evidence.
10. **Diagnostic privacy:** indiscriminately serializing caught values could expose player PII or credentials. Normalize only Error metadata and explicitly safe context; never retain bodies, headers, tokens, cookies, or state/event payloads.
11. **Console interception:** wrapping `console.error` can recurse or double-install under hot reload/Strict Mode. Keep the installer idempotent, call the original once, and make the reporter console-free.

## Open questions before implementation

- Should Dev mode remain session-local as planned, or persist in browser storage after the user enables it?
- Confirm that “night result” means the final `Night complete` screen. If it instead means only the immediate `Mafia result`, that screen already shows the shot outcome and Task 3 should be narrowed.
