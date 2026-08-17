# Mafia Dashboard Product Outline

## 1. Product definition

Mafia Dashboard is a host-operated, touch-first single-page application for running an in-person ten-player Sport / Club Mafia game. It is designed for landscape tablets and laptops and runs from a local Dockerized server with PostgreSQL persistence.

Players do not need accounts or phones in the first release. The host controls setup, music, timers, turns, nominations, voting, night actions, penalties, eliminations, and corrections from one device. Every accepted action is appended to the game log.

## 2. First-release goals

- Make the current game phase and next legal host action obvious.
- Represent ten seated players around a round table plus a distinct host position.
- Complete setup through a guided, gated wizard.
- Make timer and music controls available without leaving the game context.
- Record player-specific votes and Mafia shots by tapping player icons.
- Enforce the requested role counts, turn order, foul penalty, vote uniqueness, night order, and victory conditions.
- Recover the active game and log after browser or container restart.
- Keep role assignments, Mafia shots, and Don/Sheriff checks private to the host.

## 3. Explicit non-goals for the first release

- Remote player clients or role delivery to player phones
- Video chat or online gameplay
- Public/spectator display
- Editing the owner’s real YouTube playlist through Google OAuth
- Multiple simultaneous hosts
- Tournament scoring and standings
- Free-form custom roles
- Native Swift/iOS application

## 4. Information architecture

The SPA has three persistent regions:

1. **Game header** — game name/status, current phase, day/night number, privacy shield, connection/save state.
2. **Workspace** — setup wizard before the game; round table and phase controls during play.
3. **Utility rail** — music, timer, nomination queue, and collapsible game log. On smaller tablets this becomes a bottom sheet so the table retains usable size.

The host can reach music, timers, and the log from every live phase. Phase-specific actions remain near the affected player or in the center of the table.

## 5. Main table screen

### 5.1 Table composition

- A round green-felt table is centered in the workspace.
- Ten player seats are placed clockwise around the perimeter and numbered 1–10.
- A visually distinct host seat/control position sits below the table and is not part of turn order.
- The center contains the primary phase action: continue setup, start current turn, finish voting, resolve night, or begin next day.
- The layout is optimized for landscape view. Below the supported width, the app shows a compact ordered-seat fallback rather than overlapping controls.

### 5.2 Player seat content

Each player seat shows:

- seat number and display name;
- person icon/avatar;
- active, eliminated, red-carded, current-speaker, nominated, and muted-next-turn states using icon/text as well as color;
- foul count;
- host-private role badge behind the privacy shield;
- context actions: **Foul**, **Red card**, and **Nominate**;
- vote assignment marker during voting;
- shot/check target marker during private night steps.

Primary hit targets are at least 48×48 CSS pixels. A destructive action requires confirmation or a short reversible window.

## 6. Setup wizard

### Step 1 — Select ten players

- Select existing players or create display names inline.
- Exactly ten distinct players are required.
- The selected order maps to seats 1–10 and can be reordered before confirmation.
- Continue remains disabled until all ten seats are valid.

### Step 2 — Start music

- Load the configured YouTube playlist or locally edited queue.
- Controls:
  - **Start + fade in**
  - **Quick fade out + stop**
  - **Slow fade out + stop**
  - pause/resume when supported by the player state
  - queue editor for add, remove, and reorder
- Continue remains disabled until the official YouTube IFrame Player API reports `PLAYING`.
- A blocked, unavailable, or failed video displays a recovery action and does not satisfy the gate.

### Step 3 — Draw roles at the table

- Return to the round-table presentation.
- The remaining role deck is shuffled once from Sheriff ×1, Citizen ×6, Mafia ×2, and Don ×1.
- Tapping an unassigned player reveals/draws one remaining role for that player.
- A seat cannot draw twice; assigned roles and remaining counts are host-private.
- Continue appears in the center only after all ten seats have one role.

### Step 4 — Mafia negotiation

- The screen changes to a low-glare night state with a prominent `MAFIA NEGOTIATION` phase banner.
- The center action confirms entry into the stage.
- The host uses the `+60` timer control to start negotiation.
- Timer actions are logged but timer expiry does not advance the phase automatically.

### Step 5 — Sheriff wake-up

- The night screen changes to `SHERIFF — 10 SECONDS`.
- The host starts the 10-second timer.
- Finishing this step enables **Begin day one**.

### Step 6 — First day

- The app reveals no roles publicly.
- Day one begins with seat 1 and continues through seat 10, skipping any inactive seat.

## 7. Music behavior

### 7.1 Playback integration

- Playback uses the official YouTube IFrame Player API in the browser.
- A playlist ID is configured through the environment/admin configuration.
- The host’s explicit button press satisfies browser user-gesture requirements where supported.
- The app treats player state events as authoritative; button presses alone never mark music as playing.

### 7.2 Fade behavior

- Fade-in starts at volume 0, begins/resumes playback, then increments volume to the configured target.
- Quick fade-out uses a short configurable duration and then pauses playback at volume 0.
- Slow fade-out uses a longer configurable duration and then pauses playback at volume 0.
- Starting a new fade cancels the previous fade cleanly.
- Fade progress is local UI state; start, stop, failure, and queue edits are durable game events.

### 7.3 Queue behavior

The MVP queue is application-owned. It accepts YouTube video URLs or IDs, preserves order, and supports add, remove, and reorder. Changing the actual playlist on the user’s YouTube account is out of scope because it requires Google OAuth and YouTube Data API write scopes.

## 8. Timer behavior

- Preset buttons: **+60**, **+30**, and **+10**.
- Pressing a preset immediately starts/replaces the active countdown after confirmation if another timer is running.
- Pause, resume, reset, and clear controls are available.
- When remaining time first reaches 10 seconds, play one faint chime and show a subtle warning state.
- A 10-second timer plays the warning once at start.
- Timer position derives from an authoritative start timestamp and accumulated paused duration, not browser interval counts.
- Reload/reconnect restores the same logical remaining time.
- Timer start, pause, resume, reset, expiry, and correction are logged.
- Timer expiry never silently advances a game phase.

## 9. Day turns

### 9.1 Rotation

- Day 1 order: 1 → 2 → … → 10.
- Day 2 order: 2 → 3 → … → 10 → 1.
- Day 3 order: 3 → 4 → … → 10 → 1 → 2.
- The starting seat continues to rotate and wraps after seat 10.
- Eliminated/red-carded players are omitted while the relative order remains stable.

### 9.2 Turn control

- The current seat is highlighted with text/icon and a visible next-seat preview.
- The center button starts that player’s timer.
- A normal active turn defaults to 60 seconds.
- A player with a pending third-foul penalty receives a 10-second nomination-only turn instead.
- The host can end a turn early; the next eligible seat becomes current.
- Completing the final eligible turn moves the game to voting if candidates exist, otherwise to night.

### 9.3 Player actions

- **Foul:** increments foul count and logs the reason/note when provided.
- **Third foul:** creates one pending muted turn. That next turn lasts 10 seconds and permits only one nomination.
- **Red card:** immediately removes the player, with confirmation, no final speech in MVP, and an immediate victory check.
- **Nominate:** during the current player’s eligible window, choose one other active player. Each candidate appears once in first-nomination order.

## 10. Voting

- The candidate queue remains visible in nomination order.
- Select the candidate currently receiving votes.
- Tap eligible player icons to assign their votes to that candidate.
- A voter can be assigned to at most one candidate per voting round.
- Tapping an assigned voter again removes/reassigns the vote only through an explicit action.
- Eliminated/red-carded players cannot vote.
- Candidate totals and unassigned eligible voters remain visible.
- Finish voting is disabled until every eligible voter is assigned or the host records an explained override.
- The highest total wins; ties enter the configured tie flow from `rules.md` rather than being resolved randomly.
- Elimination is logged and victory is checked before night begins.

## 11. Night

Night is a host-private guided sequence.

### 11.1 Mafia shots

- The app lists each active Mafia-aligned shooter: both Mafia roles and Don while active.
- Select a shooter, then tap that shooter’s intended active target.
- Each active shooter must have exactly one recorded target before resolution.
- If all active shooters selected the same active target, the target is eliminated.
- Missing, invalid, or conflicting shots result in a miss and no elimination.
- Individual shooter choices remain secret; the public log shows only success/miss and the eliminated target when applicable.

### 11.2 Don check

- If the Don is active, show `DON CHECK`.
- Tap one active target.
- Host-private result is Sheriff / not Sheriff.
- The result is stored as a secret event.

### 11.3 Sheriff check

- If the Sheriff is active, show `SHERIFF CHECK`.
- Tap one active target.
- Host-private result is Mafia-aligned / not Mafia-aligned.
- The result is stored as a secret event.

### 11.4 Night completion

- Apply the Mafia result and evaluate victory.
- If no side has won, increment the day and derive its rotated active-player order.
- Return to the table in day mode.

## 12. Victory

- Red wins when no active Mafia-aligned player remains.
- Mafia wins when active Mafia-aligned players are equal to or greater than active red players.
- Victory is evaluated after every elimination or red card and before starting another phase.
- The final result and role reveal are recorded, but private role information remains behind the host privacy control.

## 13. Game log

The log is append-only. Each entry stores:

- event sequence and timestamp;
- game ID and phase;
- host or affected seat;
- event type and public summary;
- secret payload classification where applicable;
- idempotency key;
- correlation/causation metadata;
- correction reference when an action is reversed.

Required event families:

- game and setup creation;
- player selection/reordering;
- music start/stop/failure and queue edits;
- role draws;
- phase transitions;
- timer start/pause/resume/reset/expiry;
- turn start/end/skip;
- foul, muted-turn consumption, and red card;
- nomination;
- individual vote assignment and voting result;
- individual Mafia shot and shot resolution;
- Don/Sheriff check and secret result;
- elimination;
- victory/draw/cancellation;
- correction/override.

Corrections append compensating events. Existing events are never deleted or rewritten.

## 14. Phase model

```text
SETUP_PLAYERS
  → SETUP_MUSIC
  → SETUP_ROLE_DRAW
  → SETUP_MAFIA_NEGOTIATION
  → SETUP_SHERIFF_WAKE
  → DAY_TURNS
  → VOTING (when candidates exist)
  → NIGHT_MAFIA_SHOTS
  → NIGHT_DON_CHECK (when Don active)
  → NIGHT_SHERIFF_CHECK (when Sheriff active)
  → NIGHT_RESOLUTION
  → DAY_TURNS ...
  → FINISHED
```

Cross-cutting state: paused timer, privacy shield, music player state, active correction, connection/save status.

## 15. Touch and accessibility requirements

- Landscape tablet and laptop are the primary layouts.
- Core controls have at least 48×48 CSS-pixel hit targets and adequate separation.
- Long press is never the only way to invoke an action.
- Keyboard operation and visible focus are supported on laptops.
- Current speaker, nomination, elimination, muted state, and phase use text/icon in addition to color.
- Night screens use low-glare surfaces and an immediate privacy shield.
- Animation respects `prefers-reduced-motion`.
- Faint timer audio has a visible equivalent and a test button.

## 16. Owner inputs still needed

These are configurable and do not block the initial build:

1. YouTube playlist URL/ID.
2. Preferred fade-in, quick fade-out, and slow fade-out durations.
3. Preferred warning sound or permission to ship a subtle generated chime.
4. Whether a red-carded player should receive any final speech.
5. Whether the first release needs English only or English plus Russian.
6. Exact tie-vote and first-night “best move” convention if it differs from `rules.md`.
