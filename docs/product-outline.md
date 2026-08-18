# Mafia Dashboard Product Outline

## 1. Product definition

Mafia Dashboard is a host-operated, touch-first single-page application for running an in-person ten-player Sport / Club Mafia game. It is designed for landscape tablets and laptops and runs from a local Dockerized server with PostgreSQL persistence.

Players do not need accounts or phones in the first release. The host controls setup, music, timers, turns, nominations, voting, night actions, penalties, eliminations, and corrections from one device. Every accepted setup or game-state action is included in the authoritative session snapshot and non-auxiliary game log; timer and music controls remain local UI state.

## 2. First-release goals

- Make the current game phase and next legal host action obvious.
- Represent ten seated players around a round table plus a distinct host position.
- Complete setup through a guided, gated wizard.
- Make timer and music controls available without leaving the game context.
- Record player-specific votes and Mafia shots by tapping player icons.
- Preserve reusable player profiles and per-player results across games.
- Enforce the requested role counts, turn order, foul penalty, vote uniqueness, night order, and victory conditions.
- Recover the complete active setup or game, host, playlist, log, and undo history after browser or container restart by choosing it in **Active games**.
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
3. **Players & Statistics** — a separate profile-management and historical-statistics workspace outside the live game.
4. **Utility rail** — music, timer, nomination queue, and collapsible game log. On smaller tablets this becomes a bottom sheet so the table retains usable size.

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

- Select existing players from ten nickname dropdowns.
- Dropdown options are ordered by most recent game first, then nickname alphabetically; players who have never played follow the dated entries.
- Exactly ten distinct players are required.
- The selected order maps to seats 1–10 and can be reordered before confirmation.
- Continue remains disabled until all ten seats are valid.

### Player profiles and statistics

- Player management is a separate application section and remains available outside game setup.
- Nicknames are required and case-insensitively unique.
- Without **Agree for data processing**, only the nickname is stored; first name, last name, and email are cleared.
- With consent, first name, last name, and email are all required.
- A player card shows games played, wins, losses, win rate, red/black games and wins, role counts, total fouls, eliminations, red cards, and last played.
- A completed game stores one idempotent result row per selected player so retries cannot double-count a game.

### Step 2 — Start music

- Connect the host's Google account and choose a playlist from the account's YouTube Music library.
- When account OAuth is not configured, a playlist ID remains available as a deployment fallback.
- Controls:
  - **Start + fade in**
  - **Quick fade out + stop**
  - **Slow fade out + stop**
  - no separate pause/resume control; fades own playback transitions
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
- Starting or stopping the timer is local UI behavior and is not added to the durable game log; timer expiry does not advance the phase automatically.

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
- The connected account picker lists owned playlists with the read-only YouTube Data API scope; arbitrary YouTube video queueing is not exposed.
- The host may also enter an ordinary YouTube playlist ID without connecting a Google account.
- The host’s explicit button press satisfies browser user-gesture requirements where supported.
- The app treats player state events as authoritative; button presses alone never mark music as playing.
- The host may authorize the YouTube Data API to list playlists owned by the selected Google account. YouTube Music playlists are available through the same account's YouTube library.
- Google account authorization does not replace the playback surface: playback remains in the visible YouTube IFrame player.
- A YouTube Music-only embedded player, hidden YouTube player, separated audio stream, and background player are not supported integration modes.
- OAuth uses an HTTPS callback, a short-lived secure/HTTP-only state cookie, encrypted refresh-token storage, and explicit revocation on disconnect.

### 7.2 Fade behavior

- Fade-in starts at volume 0, begins/resumes playback, then increments volume to the configured target.
- Quick fade-out uses a short configurable duration and then pauses playback at volume 0.
- Slow fade-out uses a longer configurable duration and then pauses playback at volume 0.
- Starting a new fade cancels the previous fade cleanly.
- Fade progress and playback transitions are local UI state. Music start/stop/failure, fades, and queue navigation do not produce durable game events; only the chosen playlist ID belongs to the restorable session snapshot.

### 7.3 Queue behavior

The MVP plays the selected YouTube playlist as supplied by YouTube. It preserves playlist order and repeated occurrences of the same video, and it does not expose application-owned add, remove, or reorder controls. Account authorization may list/select existing owned playlists with read access; changing the actual playlist on the user’s account remains out of scope because it requires separate YouTube Data API write scopes.

## 8. Timer behavior

- Preset buttons: **+60**, **+30**, and **+10**.
- Pressing a preset immediately starts/replaces the active countdown after confirmation if another timer is running.
- **Stop** cancels the countdown and resets it to zero; pause/resume is not part of the MVP.
- When remaining time first reaches 10 seconds, play one faint chime and show a subtle warning state.
- A 10-second timer plays the warning once at start.
- Timer position derives from a local start timestamp, not accumulated browser interval counts.
- Reload/reconnect resets the auxiliary timer; timer state is not part of the durable game snapshot.
- Timer start, stop/reset, ticks, and expiry are not added to the durable game log.
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

The full non-auxiliary log is part of every authoritative session mutation. The server preserves immutable sequence-1 `game.created` and transactionally replaces the later tail from the snapshot, so state, log, roster, and results cannot diverge. Each retained entry stores:

- event sequence and timestamp;
- phase;
- affected seat data in the payload where applicable;
- event type;
- secret payload classification where applicable;
- mutation-safe UUID.

Required durable event families include:

- setup progress and player selection/reordering;
- role draws;
- phase transitions and turns;
- foul, muted-turn consumption, and red card;
- nomination and vote assignment/result;
- Mafia shots, Don/Sheriff checks, and secret results;
- elimination and victory.

Timer starts/stops/ticks and music playback/fades/navigation are auxiliary controls and are never durable log entries. An ordinary undo restores its prior full game snapshot and removes that action's log tail. Only the latest three ordinary actions are retained. Beginning day one and every later completed-night day increment clear undo history; no undo crosses a day boundary.

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

Cross-cutting UI state: local running timer, privacy shield, local music player state, and aggregate connection/save status.

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
