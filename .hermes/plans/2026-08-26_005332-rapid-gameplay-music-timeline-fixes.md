# Mafia Dashboard Rapid Gameplay, Music, and Timeline Fixes Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Deliver a rapid, uncommitted prototype that keeps an always-on static day/night tint, adds a reviewable car-crash result, simplifies car-crash/check controls, makes Mafia target-card shots reversible, fixes music fade volume and player resets, and reduces Past game timeline noise without weakening canonical replay or undo.

**Architecture:** Keep gameplay authority in `@mafia/game-domain`, including any new review phase, and project that state into React. Preserve canonical events needed for replay, persistence, and the last-three-actions undo contract; reduce only the Past game timeline presentation. Keep the YouTube player mounted across non-music UI modes, and make fade restoration a controller-level rule rather than a React workaround.

**Tech Stack:** TypeScript 6, React 19, Vitest + Testing Library, Zod 4, Vite, Playwright verifier, YouTube IFrame API.

---

## Rapid-prototype operating mode

- Leave all implementation changes **uncommitted** until Michael accepts the prototype.
- Run focused tests after each vertical slice; do not run the repository-wide `npm run check` during iteration.
- Rebuild/reload the running app after each visible slice and verify at the canonical fullscreen iPad geometry.
- Use `git diff --check` as the per-slice checkpoint instead of committing.
- After acceptance, run the full finalization gates (`npm run check`) and then commit only if Michael asks.

## Current context and confirmed code paths

- Repository starts clean on `main` at `9f092e9`.
- `GameState` and accepted canonical events are replayed and persisted. The later meaningful-checkpoint correction makes selected phase transitions and `turn.completed` transient drafts; semantic reducers absorb omitted progress at the next meaningful event, and reload intentionally returns to the latest meaningful checkpoint.
- The Day/night effect is currently optional browser state in `apps/web/src/App.tsx:102-103,379-381,1530-1551`; its animated CSS and DAY/NIGHT badge are in `apps/web/src/styles/app.css:827-964`.
- A resolved eliminate-all ballot currently skips directly from `car-crash-decision` to elimination/goodbye/night through `packages/game-domain/src/game-events.ts:951-958` and `apps/web/src/features/game/GameScreen.tsx:530-551`; no reviewable result phase exists.
- The Mafia target card currently fills only unassigned shots (`apps/web/src/features/night/NightStage.tsx:72-80`), while the per-shooter `#seat` controls already toggle individually.
- `MusicController.fadeOut` fades to zero and pauses but leaves volume at zero (`apps/web/src/features/music/music-controller.ts:68-71,145-149`).
- The YouTube player has no periodic reset timer. A concrete reset path exists because `App.tsx:1806-1834` unmounts the entire player whenever historical preview state is open, so remounting re-fetches and re-cues from index zero.
- Check ownership currently treats a role killed during the same night as available (`packages/game-domain/src/night-actions.ts:10-16`), so a deceased Don/Sheriff can still receive target controls.
- Past game timeline currently emits one visible marker for every replay frame (`timeline-model.ts:448-487`). Best move is classified as Day because `completeNight` increments the day before entering `best-move`.

## Product assumptions made explicit

1. **Tint:** the day/night tint becomes always-on and static. Remove the visible DAY/NIGHT badge, all drift/entry/float animations, the Dev toggle, localStorage preference, and optional prop; retain phase-specific gradients, border color, and shadow.
2. **Mafia card shortcut:** tapping a target player card assigns **all active Mafia-aligned shooters** to that target; tapping the same target again clears all of those assignments. Individual `#shooter` buttons remain for split shots.
3. **Car-crash review:** show a result for both outcomes. For an eliminate majority, tied participants are presentation-only provisional deaths until Continue; for no majority, show that they stay. Continue performs the atomic status/winner transition.
4. **Dead check owner:** when the Don/Sheriff is inactive, target cards and discipline actions are disabled and the only phase action is `Skip Don check` / `Skip Sheriff check`. An active owner may still check any seated target, including an already inactive target, matching current rules.
5. **Timeline cleanup:** hide noisy markers only in Past game timeline. Keep the raw canonical event chain and in-game Log drawer unchanged for replay, persistence, preview, and undo.
6. **Music reset:** keep the player mounted but hidden during log preview, Players, and Timeline. Explicit `Reload music player`, playlist changes, leaving the club, and full page reload remain intentional reset boundaries.

---

### Task 1: Replace optional animated Day/night indication with an always-on static tint

**Objective:** Remove the setting and all animation/badge behavior while preserving a static day/night table tint.

**Files:**
- Modify: `apps/web/src/App.tsx:102-103,379-381,1218-1223,1530-1551,1795-1797`
- Modify: `apps/web/src/App.test.tsx:207-263,652-683`
- Modify: `apps/web/src/features/game/GameScreen.tsx:22-40,93-111,424-447`
- Modify: `apps/web/src/features/game/GameScreen.test.tsx:62-97`
- Modify: `apps/web/src/styles/app.css:827-964`
- Modify: `scripts/verify-ui.mjs:391-412,436-488`

**Step 1: Write failing component tests**

Replace the optional-animation tests with behavior assertions equivalent to:

```tsx
const { rerender } = render(<GameScreen game={day} {...requiredProps} />);
expect(document.querySelector(".game-shell")).toHaveClass("is-table-cycle-day");
expect(screen.queryByRole("status", { name: /table indication/i })).toBeNull();

rerender(<GameScreen game={{ ...day, phase: "night-mafia" }} {...requiredProps} />);
expect(document.querySelector(".game-shell")).toHaveClass("is-table-cycle-night");
```

In `App.test.tsx`, assert the Dev menu has no button matching `/Day\/night table indication/i` and that the GameScreen mock no longer receives an indication prop.

**Step 2: Run focused RED tests**

Run:

```bash
npm run test -w @mafia/web -- src/features/game/GameScreen.test.tsx src/App.test.tsx
```

Expected: FAIL because the Dev setting, optional prop/status, and old test mock contract still exist.

**Step 3: Remove preference plumbing**

- Delete `dayNightIndicatorStorageKey`, `dayNightIndicatorVisible`, its clear/reset handling, Dev button, and `GameScreen` prop.
- Always append `is-table-cycle-${tableCycle}` to `.game-shell`.
- Remove the hidden accessible Day/Night status because the header already states the canonical gameplay phase.

**Step 4: Make the CSS static**

- Make the tint pseudo-element selector phase-driven without `.is-day-night-indicator-visible`.
- Keep the current day/night gradients, border colors, and shadows.
- Remove `::after` DAY/NIGHT badge rules and `table-daylight-drift`, `table-moonlight-drift`, `table-day-mark-enter`, `table-night-mark-enter`, and `table-cycle-mark-float` keyframes.
- Remove animation declarations from the tint.

The resulting rule shape should be:

```css
.round-table::before {
  position: absolute;
  z-index: 1;
  inset: 0;
  content: "";
  pointer-events: none;
  border-radius: 50%;
}
.is-table-cycle-day .round-table::before { /* current warm gradients, no animation */ }
.is-table-cycle-night .round-table::before { /* current cool gradients, no animation */ }
```

**Step 5: Update the built-browser verifier**

- Delete localStorage/toggle assertions.
- Assert the Dev button is absent.
- Assert day/night `::before` backgrounds contain gradients and `animationName === "none"`.
- Assert `::after` has no DAY/NIGHT content.

**Step 6: Run focused GREEN tests**

Run the command from Step 2. Expected: PASS.

**Step 7: Rapid checkpoint**

Run `git diff --check`. Do not commit.

---

### Task 2: Add a canonical bulk toggle for Mafia target cards

**Objective:** Make a target player card a true all-shooters on/off toggle while keeping individual shooter controls intact.

**Files:**
- Modify: `packages/game-domain/src/night-actions.ts:67-106`
- Modify: `packages/game-domain/src/night-actions.test.ts:85-98`
- Confirm export: `packages/game-domain/src/index.ts`

**Step 1: Write the domain RED test**

Add a test with three active black shooters:

```ts
const selected = toggleAllMafiaShotsForTarget(initial, target.seat);
expect(selected.shotAssignments).toEqual(
  Object.fromEntries(shooters.map(({ seat }) => [seat, target.seat])),
);

const cleared = toggleAllMafiaShotsForTarget(selected, target.seat);
expect(cleared.shotAssignments).toEqual({});

const reassigned = toggleAllMafiaShotsForTarget(
  toggleMafiaShot(initial, shooters[0]!.seat, otherTarget.seat),
  target.seat,
);
expect(Object.values(reassigned.shotAssignments)).toEqual(
  Array.from({ length: shooters.length }, () => target.seat),
);
```

Also cover an inactive target because Mafia may intentionally shoot a deceased participant.

**Step 2: Run RED**

Run:

```bash
npm run test -w @mafia/game-domain -- src/night-actions.test.ts
```

Expected: FAIL because `toggleAllMafiaShotsForTarget` does not exist.

**Step 3: Add the minimal domain command**

Implement one command that:

- validates `night-mafia`;
- derives active black shooters;
- validates the target is seated;
- clears all active shooter assignments if every shooter already targets this seat;
- otherwise assigns every active shooter to this seat, replacing split assignments.

Reuse existing shooter/target validation rather than duplicating role rules.

**Step 4: Run GREEN**

Run the Step 2 command. Expected: PASS.

**Step 5: Rapid checkpoint**

Run `git diff --check`. Do not commit.

---

### Task 3: Wire the Mafia player card to the bulk toggle

**Objective:** Use the new domain command from the target card and expose accurate pressed/action wording.

**Files:**
- Modify: `apps/web/src/features/night/NightStage.tsx:67-114`
- Modify: `apps/web/src/features/night/NightStage.test.tsx:69-155`

**Step 1: Write the UI RED test**

Extend the table test to click the target card twice:

```tsx
const targetCard = screen.getByRole("button", {
  name: `Assign all Mafia shots to ${target.name}`,
});
await user.click(targetCard);
expect(screen.getAllByRole("button", { name: new RegExp(`from target ${target.name}$`) })).toHaveLength(3);

await user.click(screen.getByRole("button", {
  name: `Remove all Mafia shots from ${target.name}`,
}));
expect(screen.getAllByRole("button", { name: new RegExp(`to target ${target.name}$`) })).toHaveLength(3);
```

Keep an assertion that one `#shooter` button can still be toggled and reassigned independently.

**Step 2: Run RED**

Run:

```bash
npm run test -w @mafia/web -- src/features/night/NightStage.test.tsx
```

Expected: FAIL because the card only assigns remaining shooters and never clears all.

**Step 3: Wire the component**

- Replace `assignRemainingShots` with the domain bulk toggle.
- Derive whether all active shooters currently target each card.
- Change `seatActionLabel` between `Assign all Mafia shots to …` and `Remove all Mafia shots from …`.
- Do not emit a log entry for provisional card or `#shooter` toggles; log only evaluated shots as today.

**Step 4: Run GREEN and checkpoint**

Run the Step 2 command, then `git diff --check`. Expected: PASS; leave uncommitted.

---

### Task 4: Restore the pre-fade volume after pausing

**Objective:** Ensure native Play after a completed fade-out is audible at the exact volume present when fade-out began.

**Files:**
- Modify: `apps/web/src/features/music/music-controller.ts:19-153`
- Modify: `apps/web/src/features/music/music-controller.test.ts:5-125`

**Step 1: Write the controller RED tests**

Track operation order in `FakePlayer` and assert:

```ts
player.volume = 60;
const fade = controller.fadeOut({ durationMs: 300 });
await vi.advanceTimersByTimeAsync(300);
await fade;

expect(player.volumes).toEqual([40, 20, 0, 60]);
expect(player.pauseCalls).toBe(1);
expect(player.operations.slice(-2)).toEqual(["pause", "volume:60"]);
```

Add the same invariant for `durationMs: 0`. Keep cancellation tests proving a cancelled fade-out does not later restore stale volume over a newer operation.

**Step 2: Run RED**

Run:

```bash
npm run test -w @mafia/web -- src/features/music/music-controller.test.ts
```

Expected: FAIL because volume remains zero.

**Step 3: Implement pause-then-restore**

Capture `startVolume` once at fade-out start. On successful completion only:

1. set the final fade step to zero;
2. pause;
3. restore `startVolume` while paused;
4. resolve the operation.

Do not route this through React `activeVolume`; it must restore the actual player volume, including manual/native changes.

**Step 4: Run GREEN and checkpoint**

Run the Step 2 command, then `git diff --check`. Expected: PASS; leave uncommitted.

---

### Task 5: Reproduce and lock the music-player reset boundary

**Objective:** Prove the concrete remount/reset path before changing lifecycle behavior.

**Files:**
- Modify test first: `apps/web/src/App.test.tsx:314-316,839+`
- Modify only after RED: `apps/web/src/App.tsx:1806-1834`
- Optional hardening test: `apps/web/src/features/music/YouTubePlaylistPlayer.test.tsx`

**Step 1: Add a mount-counting player mock**

Change the hoisted YouTube mock to record mounts/unmounts while still rendering `data-testid="youtube-player"`.

**Step 2: Write the RED interaction**

Use the existing canonical log preview flow:

1. start a test game;
2. record an accepted action;
3. verify one player mount;
4. open Log and Preview state;
5. verify the player is hidden but still mounted;
6. exit preview;
7. verify mount count remains one and unmount count remains zero.

This should fail against the current `previewGame === null ? <MusicDock> : null` branch.

**Step 3: Run RED**

Run:

```bash
npm run test -w @mafia/web -- src/App.test.tsx
```

Expected: FAIL because preview unmounts the player.

**Step 4: Keep the player mounted across workspace modes**

Render `MusicDock` unconditionally inside the club workspace and drive only its `hidden` prop:

```tsx
<MusicDock hidden={view === "players" || view === "timeline" || previewGame !== null} ...>
  <YouTubePlaylistPlayer ... />
</MusicDock>
```

Do not alter the explicit reload counter or playlist-ID reset behavior.

**Step 5: Add lifecycle hardening only if the focused trace finds another reset**

If the real browser still resets, collect a tagged trace of player constructor, destroy, cue/load, playlist index, current time, reload request, and YT state. Test hypotheses in order:

1. extra mount/effect cleanup;
2. unintended `reloadRequest` change;
3. terminal `ENDED` at the final queue item;
4. queue rewrite losing occurrence identity.

Add a semantic failing test for the confirmed cause before changing code. If callback identity is the cause, hold `onStateChange` in a ref and key player creation only to playlist ID plus explicit reload generation. If terminal provider behavior is the cause, add only the smallest provider-state handling needed to preserve the current/final occurrence. Do not add speculative timers.

**Step 6: Run GREEN and checkpoint**

Run the Step 3 command. Also run:

```bash
npm run test -w @mafia/web -- src/features/music/YouTubePlaylistPlayer.test.tsx
```

Expected: PASS; `git diff --check`; leave uncommitted.

---

### Task 6: Make dead Don/Sheriff ownership strictly inactive in the domain

**Objective:** Prevent a Don/Sheriff killed that same night from performing a check while retaining explicit skip phases.

**Files:**
- Modify: `packages/game-domain/src/night-actions.ts:10-16,175-252`
- Modify: `packages/game-domain/src/night-actions.test.ts:238-320`
- Modify compatibility test only if necessary: `packages/game-domain/src/game-replay.test.ts:490-539`

**Step 1: Write the domain RED test**

Cover both pre-existing death and same-night victim death:

```ts
const killedOwner = {
  ...checkPhase,
  players: markOwnerEliminated(checkPhase.players),
  nightResult: { kind: "kill", targetSeat: owner.seat },
};
expect(() => performDonCheck(killedOwner, target.seat)).toThrow(/available Don/i);
expect(skipDonCheck(killedOwner).phase).toBe("night-sheriff");
```

Repeat for Sheriff. Keep the existing transition expectation that the dead role’s phase is present so the host explicitly skips it.

**Step 2: Run RED**

Run:

```bash
npm run test -w @mafia/game-domain -- src/night-actions.test.ts src/game-replay.test.ts
```

Expected: FAIL for the same-night killed owner because `hasCheckOwner` currently grants that exception.

**Step 3: Tighten active-owner policy**

- Replace `hasCheckOwner` with a strict `status === "active"` check.
- Keep `nextPrivatePhase`, `continueDonCheck`, and skip transitions role-presence-based so the explicit dead-owner skip screen still appears.
- Preserve legacy weak-hash replay compatibility in `applyReplayEvent`; old historical checks by inactive owners must remain readable, while new events use the strict command.

**Step 4: Run GREEN and checkpoint**

Run the Step 2 command, then `git diff --check`. Expected: PASS; leave uncommitted.

---

### Task 7: Render only Skip when the check owner is dead

**Objective:** Remove target, disabled-placeholder, foul/red-card, and other phase actions when no active role owner exists.

**Files:**
- Modify: `apps/web/src/features/night/NightStage.tsx:224-280,326-382`
- Modify: `apps/web/src/features/night/NightStage.test.tsx:157-206`

**Step 1: Write UI RED tests**

For dead Don and dead Sheriff screens, assert:

```tsx
expect(screen.getByRole("button", { name: "Skip Don check" })).toBeEnabled();
expect(screen.queryByText("Select a player to continue")).toBeNull();
expect(screen.queryByRole("button", { name: /^Don check Player/ })).toBeNull();
expect(screen.queryByRole("button", { name: /red card|foul/i })).toBeNull();
```

Then click Skip and repeat for Sheriff. Add one active-owner control case to prove target checks and explicit Skip remain available when alive.

**Step 2: Run RED**

Run:

```bash
npm run test -w @mafia/web -- src/features/night/NightStage.test.tsx
```

Expected: FAIL because dead-owner screens still expose target cards and the disabled primary placeholder.

**Step 3: Gate controls from canonical ownership**

- Derive `hasActiveDon` / `hasActiveSheriff` from `game.players`.
- For inactive owners, omit `onSeatClick`, `renderSeatActions`, and the disabled primary placeholder; disable the player cards as action targets and render only Skip in `advance`.
- For active owners, retain current target checks, result screen, Red actions, and Skip.

**Step 4: Run GREEN and checkpoint**

Run the Step 2 command, then `git diff --check`. Expected: PASS; leave uncommitted.

---

### Task 8: Model car-crash ballot review as a persisted gameplay phase

**Objective:** Enter a durable result phase before applying multi-player elimination or starting night.

**Files:**
- Modify: `packages/game-domain/src/types.ts:9-27,65-91`
- Modify: `packages/game-domain/src/day-actions.ts:418-509`
- Modify: `packages/game-domain/src/day-actions.test.ts:438+`
- Modify: `packages/game-domain/src/night-actions.ts:36-64` (clear phase-owned result on night entry)
- Confirm export: `packages/game-domain/src/index.ts`

**Step 1: Write domain RED tests**

Add two vertical cases:

```ts
const reviewed = acceptCarCrashBallot(filledDecision(6));
expect(reviewed).toMatchObject({
  phase: "car-crash-result",
  carCrashResult: { eliminate: true, seats: [4, 6], yesVotes: 6, eligibleVoters: 10 },
  winner: null,
});
expect(reviewed.players.find(({ seat }) => seat === 4)?.status).toBe("active");

const continued = completeCarCrashResult(reviewed);
expect(continued.players.filter(({ seat }) => [4, 6].includes(seat)).every(
  ({ status }) => status === "eliminated",
)).toBe(true);
expect(continued.phase).toBe("goodbye-speech");
```

Also cover five yes votes: result says `eliminate: false`, all players remain active, Continue enters `night-mafia`. Cover a winning multi-elimination: apply every status first, evaluate victory once, then finish.

**Step 2: Run RED**

Run:

```bash
npm run test -w @mafia/game-domain -- src/day-actions.test.ts
```

Expected: FAIL because the phase, stored result, and commands do not exist.

**Step 3: Add minimal canonical state**

- Add `"car-crash-result"` to `GamePhase`.
- Add optional `carCrashResult?: CarCrashVoteResult` to `GameState`.
- Add `acceptCarCrashBallot(game)` to compute/store the exact result and enter the review phase without changing player status/winner.
- Add `completeCarCrashResult(game)` to atomically eliminate all approved seats, evaluate victory once, and transition to `finished`, `goodbye-speech`, or `night-mafia`.
- Clear `carCrashResult` with other car-crash-owned fields when beginning night/cancelling/restarting the flow.

**Step 4: Run GREEN and checkpoint**

Run the Step 2 command, then `git diff --check`. Expected: PASS; leave uncommitted.

---

### Task 9: Extend canonical events without invalidating old replay chains

**Objective:** Persist the new review phase while retaining old `car-crash.resolved` semantics for existing SHA/legacy histories.

**Files:**
- Modify: `packages/game-domain/src/game-events.ts:41-167,172-191,330-423,485-696,848-1003,1053-1120`
- Modify: `packages/game-domain/src/game-replay.test.ts`
- Modify: `apps/server/src/game-session-validation.ts:14-33,146-218,406-469`
- Modify: `apps/server/src/game-session-validation.test.ts`

**Step 1: Write compatibility RED tests**

Add a new canonical event, e.g. `car-crash.ballot-resolved`, whose payload is the same complete `{ votes, result }` contract but whose after-state is `car-crash-result`. Assert:

- the new event replays into review with no premature status mutation;
- a following `phase.changed` applies `completeCarCrashResult` and reaches the declared next phase;
- an existing `car-crash.resolved` fixture still replays directly to its historical after-state/hash;
- forged result/vote payloads and malformed result-phase state are rejected.

**Step 2: Run RED**

Run:

```bash
npm run test -w @mafia/game-domain -- src/game-replay.test.ts
npm run test -w @mafia/server -- src/game-session-validation.test.ts
```

Expected: FAIL because the new event/phase/state schema is unknown.

**Step 3: Implement append-only compatibility**

- Keep `car-crash.resolved` accepted and replayed with its current direct-resolution behavior for historical events.
- Add `car-crash.ballot-resolved` for all newly accepted UI ballots; validate exact votes/result and call `acceptCarCrashBallot`.
- Extend `applyPhaseChange` from `car-crash-result` through `completeCarCrashResult` and verify the declared target phase.
- Extend exact-key state validation for optional `carCrashResult` and phase-scoped invariants.
- Extend server Zod phase/result schemas and require result-phase car-crash seats, complete canonical voter keys, matching majority result, active provisional participants, and `winner: null`.
- Do not bump/rewrite existing event IDs, hashes, sequences, or `CURRENT_REPLAY_VERSION` merely to alter presentation.

**Step 4: Run GREEN and checkpoint**

Run both Step 2 commands, then `git diff --check`. Expected: PASS; leave uncommitted.

---

### Task 10: Display the car-crash result screen and continue explicitly

**Objective:** Show the eliminate/keep outcome on the table before canonical elimination/night progression.

**Files:**
- Modify: `apps/web/src/features/voting/VotingStage.tsx:18-267`
- Modify: `apps/web/src/features/voting/VotingStage.test.tsx:140-223`
- Modify: `apps/web/src/features/game/GameScreen.tsx:52-90,123-148,516-565`
- Modify: `apps/web/src/features/game/GameScreen.test.tsx:274-369`
- Modify if styling is needed: `apps/web/src/styles/app.css`

**Step 1: Write the UI RED flow**

For six yes votes:

1. click Resolve car crash;
2. expect heading/status `Car crash result`;
3. expect copy naming every tied participant and `Eliminated` (or equivalent accepted wording);
4. expect their cards to have `is-provisional-deceased` while canonical `status` is still active;
5. expect only one phase action, `Continue` / `Continue to goodbye speeches`;
6. click Continue and assert every participant is now eliminated and the next phase is goodbye/finished.

For five or fewer yes votes, assert `Players stay`, no provisional death class, then Continue begins night.

**Step 2: Run RED**

Run:

```bash
npm run test -w @mafia/web -- src/features/voting/VotingStage.test.tsx src/features/game/GameScreen.test.tsx
```

Expected: FAIL because resolution currently jumps directly past a result screen.

**Step 3: Render and accept the new event**

- Emit `car-crash.ballot-resolved` from Resolve.
- Add a `car-crash-result` branch that reads only canonical `carCrashResult` and `carCrashSeats`.
- Mark approved participants presentation-only with `provisionalDeceased`.
- Continue through `phase.changed` with the target calculated by `completeCarCrashResult(game)`; local fallback calls the same domain command.
- Keep the all-active-tie skipped informational screen unchanged.
- Add `Car crash result` to `phaseTitle` and voting-stage routing.

**Step 4: Run GREEN and checkpoint**

Run the Step 2 command, then `git diff --check`. Expected: PASS; leave uncommitted.

---

### Task 11: Keep Foul controls available throughout Day and voting flow

**Objective:** Keep the ordinary Foul action available for every active player throughout Day, voting, car-crash speeches, decisions, skipped ballots, and result review while preserving the separate swipe Red-card contract outside Mafia shooting.

**Files:**
- Modify tests: `apps/web/src/features/game/GameScreen.test.tsx`
- Modify only if a failure exposes leakage: `apps/web/src/features/game/GameScreen.tsx`, `apps/web/src/features/voting/VotingStage.tsx`

**Step 1: Add a phase matrix test**

Render `day`, `voting`, `voting-cancelled`, `car-crash`, `car-crash-decision`, `car-crash-result`, and `car-crash-skipped` fixtures and assert:

```ts
expect(screen.getAllByRole("button", { name: /^Foul /i })).toHaveLength(activePlayerCount);
```

Exercise one button in each component path and verify it invokes the canonical Foul action. Test buttons, not historical `Foul ×N` badges.

**Step 2: Run the focused test**

Run:

```bash
npm run test -w @mafia/web -- src/features/game/GameScreen.test.tsx
```

Expected: RED in every car-crash/informational branch that currently omits Foul controls.

**Step 3: Apply the smallest fix if RED**

Share one active-player Foul renderer across every `VotingStage` branch, and render Foul without nomination controls during `car-crash` speeches. Include `car-crash-result` in fourth-Foul/red-card cancellation and clear its provisional result when that cancellation occurs. Do not remove swipe Red-card behavior unless a separate requirement changes it.

**Step 4: Re-run and checkpoint**

Expected: PASS; `git diff --check`; leave uncommitted.

---

### Task 12: Define one Past game timeline visibility policy

**Objective (superseded):** This presentation-only filter was the first implementation. Michael later clarified that these intermediate entries must not be stored in new game history at all; legacy rows remain readable and filtered only for backward compatibility.

**Files:**
- Modify: `apps/web/src/features/timeline/timeline-model.ts:99-147,190-220,428-487`
- Modify: `apps/web/src/features/timeline/timeline-model.test.ts`
- Modify: `apps/web/src/features/timeline/GameTimelineScreen.tsx:109-152,161-305`
- Modify: `apps/web/src/features/timeline/GameTimelineScreen.test.tsx:413-450,528-600`

**Step 1: Write canonical timeline RED assertions**

Against sample history, assert no visible marker for:

- `phase.changed` to `sheriff-wake`;
- any `turn.completed`;
- `phase.changed` to `night-don`;
- `phase.changed` to `night-sheriff`;
- `phase.changed` to `best-move`.

Assert the `phase.changed` marker to `night-mafia` remains and is labelled exactly `Night`, not `Phase: night mafia`. Assert original event sequence numbers are retained, so visible marker numbering may have gaps.

**Step 2: Run RED**

Run:

```bash
npm run test -w @mafia/web -- src/features/timeline/timeline-model.test.ts src/features/timeline/GameTimelineScreen.test.tsx
```

Expected: FAIL because every accepted frame currently becomes a marker.

**Step 3: Centralize projection policy**

Create a pure helper in `timeline-model.ts` shared by canonical and legacy projections:

```ts
const hiddenPhaseTargets = new Set(["sheriff-wake", "night-don", "night-sheriff", "best-move"]);

export const isVisibleTimelineEvent = (type: string, payload: unknown): boolean => {
  if (type === "turn.completed") return false;
  if (type !== "phase.changed") return true;
  const to = asRecord(payload)?.to;
  return typeof to !== "string" || !hiddenPhaseTargets.has(to);
};
```

Use the same helper in `legacyTimeline`; continue excluding provisional events with `isProvisionalInteractionType`.

**Step 4: Reindex visible columns safely**

Filter to visible replay frames first, then compute marker `frameIndex`, regions, grid spans, and counts from visible columns. Keep each `TimelineFrameModel.replayFrame` as the canonical original so state/sequence provenance is preserved. Do not leave sparse original indexes in a grid sized to visible markers.

**Step 5: Rename Night marker**

Special-case `phase.changed` with `to === "night-mafia"` to `{ label: "Night", ariaLabel: "Night" }` in both canonical and legacy marker descriptions.

**Step 6: Run GREEN and checkpoint**

Run the Step 2 command, then `git diff --check`. Expected: PASS; leave uncommitted.

---

### Task 13: Place Best move in the preceding Night region

**Objective:** Keep the semantic Best move marker visible but group it with the night that caused it.

**Files:**
- Modify: `apps/web/src/features/timeline/timeline-model.ts:99-147`
- Modify: `apps/web/src/features/timeline/timeline-model.test.ts:7-52,129-167`
- Modify legacy projection: `apps/web/src/features/timeline/GameTimelineScreen.tsx:109-152,262-305`
- Modify: `apps/web/src/features/timeline/GameTimelineScreen.test.tsx`

**Step 1: Write RED assertions**

Find `best-move.completed` in sample timeline and assert:

```ts
expect(bestMove).toMatchObject({
  kind: "best-move",
  regionId: "night-1",
});
expect(timeline.regions.find(({ id }) => id === "night-1")?.frameCount).toBeGreaterThan(0);
```

Also assert it is not in `day-2`. Add a best-effort legacy fixture with a `best-move.completed` entry and day/phase metadata.

**Step 2: Run RED**

Run the Task 12 focused command. Expected: FAIL because Best move currently lands in Day 2.

**Step 3: Derive the causal night explicitly**

For `best-move.completed`, override ordinary after-state region selection and return Night `max(1, frame.before.day - 1)`. This is required because `completeNight` increments `day` before entering Best move. Apply equivalent day-minus-one logic to legacy Best move entries when their stored day is available.

Do not move morning goodbye or ordinary Day 2 events into Night unless their own product contract says so.

**Step 4: Run GREEN and checkpoint**

Run the focused command, then `git diff --check`. Expected: PASS; leave uncommitted.

---

### Task 13A: Persist meaningful checkpoints only and expose current Timeline navigation

**Objective:** Keep intermediate step progress in memory, persist only meaningful semantic checkpoints, and make the active game Timeline reuse Log Preview and branch-preserving Reset.

**Confirmed architecture decision:**

- Do not persist `turn.completed` or `phase.changed` to `sheriff-wake`, `night-don`, `night-sheriff`, or `best-move` for new sessions.
- Do not add a rolling full-state snapshot. Intermediate progress is an in-memory draft; reload intentionally returns to the latest meaningful checkpoint.
- Preserve replay support for legacy logs containing the retired intermediate entries.
- Make later meaningful reducers deterministically absorb omitted Day turns and private-phase transitions.
- Reject new intermediate appends at the authoritative server store.
- Include the active game and its current semantic head in Timeline.
- Preview is read-only; Reset moves the active head while preserving inactive future events exactly as Log does.

**Primary files:**

- `packages/game-domain/src/game-events.ts`
- `packages/game-domain/src/game-replay.test.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/App.test.tsx`
- `apps/server/src/game-session-store.ts`
- `apps/server/src/game-session-store.test.ts`
- `apps/web/src/features/timeline/sample-game-data.ts`
- `apps/web/src/features/timeline/GameTimelineScreen.tsx`
- `apps/web/src/features/timeline/GameTimelineScreen.test.tsx`

---

### Task 14: Update the deterministic iPad browser verifier

**Objective:** Make the built-browser probe cover the new static tint, car-crash review, control scoping, and cleaned timeline.

**Files:**
- Modify: `scripts/verify-ui.mjs:391-488,526-560,940-990,1100-1103`

**Step 1: Update static tint checks**

Assert no Dev Day/night toggle, day/night gradient presence, no pseudo-element label, and `animationName === "none"` at both phases.

**Step 2: Update timeline checks**

After generating sample data:

- assert hidden labels/accessible names are absent;
- assert the `Night` marker exists;
- select Best move and verify its marker sits inside the Night 1 grid span;
- update marker-count expectations to the exact filtered count computed from the sample, not a stale `>= 8` threshold.

**Step 3: Update car-crash checks**

For the existing zero-vote fixture:

1. assert one working Foul button for every active player;
2. resolve;
3. wait for `Car crash result` and `Players stay`;
4. assert no provisional deceased cards;
5. click Continue;
6. wait for `phase-night-mafia`.

Add an eliminate-majority fixture or interactions that assert every car-crash participant is provisional on the result screen and canonical only after Continue.

**Step 4: Add dead-owner and Mafia card checks**

- Inject or drive a dead Don/Sheriff phase and count exactly one enabled phase action: Skip.
- On Mafia shots, click a target card once and count all shooter assignments; click again and count zero.

**Step 5: Run the focused verifier against the rebuilt local app**

Run, using the active local app URL:

```bash
APP_URL=http://127.0.0.1:8080 npm run verify:ui
```

Expected: `Focused iPad gameplay verification: PASS` with no page/route errors and fresh screenshots.

**Step 6: Rapid checkpoint**

Run `git diff --check`. Leave changes uncommitted for Michael’s visual acceptance.

---

### Task 15: Focused integration and acceptance pass

**Objective:** Verify all requested slices together without prematurely switching out of rapid-prototype mode.

**Files:**
- No new files unless a regression requires a focused test.
- Build-generated only at finalization: `packages/game-domain/dist/*` (never hand-edit).

**Step 1: Run focused domain suites**

```bash
npm run test -w @mafia/game-domain -- src/day-actions.test.ts src/night-actions.test.ts src/game-replay.test.ts
```

Expected: all selected tests PASS.

**Step 2: Run focused web suites**

```bash
npm run test -w @mafia/web -- \
  src/App.test.tsx \
  src/features/game/GameScreen.test.tsx \
  src/features/voting/VotingStage.test.tsx \
  src/features/night/NightStage.test.tsx \
  src/features/music/music-controller.test.ts \
  src/features/music/YouTubePlaylistPlayer.test.tsx \
  src/features/timeline/timeline-model.test.ts \
  src/features/timeline/GameTimelineScreen.test.tsx
```

Expected: all selected tests PASS.

**Step 3: Run focused persistence validation**

```bash
npm run test -w @mafia/server -- src/game-session-validation.test.ts
```

Expected: PASS for current and new result-phase states, forged state rejection, and historical replay compatibility.

**Step 4: Run package typechecks**

```bash
npm run typecheck -w @mafia/game-domain
npm run typecheck -w @mafia/web
npm run typecheck -w @mafia/server
```

Expected: all PASS, including exhaustive `GamePhase` switches.

**Step 5: Rebuild and run the browser verifier**

Rebuild the running app through its existing local workflow, then run Task 14’s `verify:ui`. Verify at the canonical fullscreen iPad geometry:

- static warm/cool tint, no badge/animation/setting;
- Mafia card all-on/all-off and individual shooter buttons;
- dead Don/Sheriff only Skip;
- car-crash result before elimination/night with Foul controls still available;
- fade-out pauses then native Play is audible at the previous level;
- Log preview, Players, and Timeline hide but do not reset the player;
- timeline contains meaningful markers only, `Night` label, Best move in Night.

**Step 6: Review scope**

Run:

```bash
git status --short
git diff --check
git diff --stat
```

Expected: only listed source/tests/verifier files plus build-generated domain output if a build was run; no secrets, unrelated refactors, commits, or history changes.

**Step 7: Wait for acceptance**

Present the running prototype and screenshots to Michael. Do not run full gates, format the whole repository, commit, or push until accepted.

**Step 8: Finalize after acceptance**

Run:

```bash
npm run check
```

Expected: formatting check, lint, typecheck, all tests, and all builds PASS. Address only regressions caused by this work. Commit/push only on explicit request.

---

## Files likely to change

| Area | Files |
| --- | --- |
| Static tint/setting removal | `apps/web/src/App.tsx`, `apps/web/src/App.test.tsx`, `apps/web/src/features/game/GameScreen.tsx`, `apps/web/src/features/game/GameScreen.test.tsx`, `apps/web/src/styles/app.css`, `scripts/verify-ui.mjs` |
| Car-crash result | `packages/game-domain/src/types.ts`, `packages/game-domain/src/day-actions.ts`, `packages/game-domain/src/day-actions.test.ts`, `packages/game-domain/src/night-actions.ts`, `packages/game-domain/src/game-events.ts`, `packages/game-domain/src/game-replay.test.ts`, `apps/server/src/game-session-validation.ts`, `apps/server/src/game-session-validation.test.ts`, `apps/web/src/features/voting/VotingStage.tsx`, `apps/web/src/features/voting/VotingStage.test.tsx`, `apps/web/src/features/game/GameScreen.tsx`, `apps/web/src/features/game/GameScreen.test.tsx` |
| Mafia shots/check owner | `packages/game-domain/src/night-actions.ts`, `packages/game-domain/src/night-actions.test.ts`, `apps/web/src/features/night/NightStage.tsx`, `apps/web/src/features/night/NightStage.test.tsx` |
| Music | `apps/web/src/features/music/music-controller.ts`, `apps/web/src/features/music/music-controller.test.ts`, `apps/web/src/App.tsx`, `apps/web/src/App.test.tsx`; `YouTubePlaylistPlayer.*` only if a second reset cause is proven |
| Timeline cleanup | `apps/web/src/features/timeline/timeline-model.ts`, `apps/web/src/features/timeline/timeline-model.test.ts`, `apps/web/src/features/timeline/GameTimelineScreen.tsx`, `apps/web/src/features/timeline/GameTimelineScreen.test.tsx`, `scripts/verify-ui.mjs` |

## Risks and tradeoffs

- **Replay compatibility:** changing the meaning of existing `car-crash.resolved` would invalidate stored hashes. The plan avoids this by adding a new event for new review-phase behavior and retaining old replay semantics.
- **New phase exhaustiveness:** `car-crash-result` must be added to domain validation, server Zod, phase titles/routing, red-card policy decisions, history preview, and test fixtures. Typecheck is the safety net but not a substitute for phase-scoped tests.
- **Undo semantics:** the accepted ballot and Continue become two accepted actions. That is desirable for reviewing/undoing the result, but it consumes two positions in the last-three-action window. Do not mark either auxiliary.
- **Foul vs Red card:** Foul buttons stay available in every Day and voting/car-crash stage. Existing swipe Red-card behavior is a separate established contract and remains unless Michael requests its removal too. A fourth Foul during result review cancels the voting result through the canonical red-card path and clears provisional result state.
- **Timeline counts:** visible marker counts will differ from stored event counts and sequence numbers will have gaps. Label region metadata as visible/accepted timeline events rather than implying storage was deleted.
- **Music resets:** keeping the player mounted fixes the concrete preview reset path. Do not add periodic polling, recuing, or end-state workarounds unless the real trace proves another cause.
- **Static tint layering:** retaining `::before` at `z-index: 1` must not intercept touches or obscure cards/center controls; keep `pointer-events: none` and verify rendered contrast.

## Open questions to verify during the prototype, not blockers to starting

- Confirm the accepted car-crash result wording visually (`Eliminated` / `Players stay`) and whether Continue should say `Continue to goodbye speeches`, `Begin night`, or simply `Continue`; the next phase must still be domain-derived.
- Confirm the player reset no longer occurs during a normal-length live session after the preview-unmount fix. If it does, capture the provider trace before any second fix.
- Confirm static tint intensity is unchanged from the currently enabled setting; only movement and badge/setting should disappear.
