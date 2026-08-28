# Mafia Dashboard Product Outline

## 1. Product definition

Mafia Dashboard is a host-operated, touch-first single-page application for running an in-person ten-player Club Mafia game. It is designed for landscape tablets and laptops, runs locally through Docker Compose, and deploys to Azure Container Apps with PostgreSQL persistence.

Players do not use accounts or phones. The authenticated host controls setup, music, timers, turns, nominations, voting, night actions, penalties, eliminations, and corrections from one device. Setup metadata is persisted in the revisioned session. Live play is reconstructed from one immutable game baseline and the active branch of parent-linked semantic events; timer and music controls remain local UI state.

## 2. Current product goals

- Make the current game phase and next legal host action obvious.
- Represent ten seated players around a round table plus a distinct host position.
- Complete setup through a guided, gated wizard.
- Make timer and music controls available without leaving the game context.
- Record player-specific votes and Mafia shots by tapping player icons.
- Preserve reusable player profiles and per-player results across games.
- Enforce the requested role counts, turn order, foul penalty, vote uniqueness, night order, and victory conditions.
- Recover the complete active setup or game, host, playlist, log, and undo history after browser or container restart by choosing it in **Active games**.
- Keep role assignments, Mafia shots, and Don/Sheriff checks private to the host.

## 3. Product boundaries

- Remote player clients or role delivery to player phones
- Video chat or online gameplay
- Public/spectator display
- Editing the owner’s real YouTube playlist through Google OAuth
- Multiple simultaneous hosts
- Tournament scoring and standings
- Free-form custom roles, alternate player counts, or alternate rulesets

## 4. Information architecture

The SPA has four persistent regions:

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
- The connected account picker lists owned playlists with the read-only YouTube Data API scope; it does not write to the account playlist.
- The host may also enter an ordinary YouTube playlist ID without connecting a Google account.
- The host’s explicit button press satisfies browser user-gesture requirements where supported.
- The app treats player state events as authoritative; button presses alone never mark music as playing.
- The host may authorize the YouTube Data API to list playlists owned by the selected Google account. YouTube Music playlists are available through the same account's YouTube library.
- Google account authorization does not replace the playback surface: playback remains in the visible YouTube IFrame player.
- A YouTube Music-only embedded player, hidden YouTube player, separated audio stream, and background player are not supported integration modes.
- OAuth uses an HTTPS callback, a short-lived secure/HTTP-only state cookie, encrypted refresh-token storage, and explicit revocation on disconnect.

### 7.2 Fade behavior

- Fade-in starts at volume 0, begins/resumes playback, and reaches the prior audible target over the accepted 2-second duration.
- Quick fade-out runs for 500 milliseconds and then pauses playback at volume 0.
- Slow fade-out runs for 3 seconds and then pauses playback at volume 0.
- Starting a new fade cancels the previous fade cleanly.
- Fade progress and playback transitions are local UI state. Music start/stop/failure, fades, and queue navigation do not produce durable game events; only the chosen playlist ID belongs to the restorable server-side game session.

### 7.3 Queue behavior

The app loads the selected playlist into an application-owned in-session queue. Every supplied occurrence is preserved independently, including repeated occurrences of the same video. The expanded queue supports drag reordering and **Play next** / **Play now** controls. Queue order and track tags are best-effort browser-local preferences scoped to the club; they are not server-side game events.

The queue changes only IFrame playback order. Account authorization remains read-only, and no queue action adds, removes, or reorders items in the owner’s real YouTube playlist.

## 8. Timer behavior

- Preset buttons: **+60**, **+30**, and **+10**.
- Pressing a preset immediately starts/replaces the active countdown after confirmation if another timer is running.
- **Stop** cancels the countdown and resets it to zero; pause/resume is not part of the current timer control.
- When remaining time first reaches 10 seconds, play one faint chime and show a subtle warning state.
- A 10-second timer plays the warning once at start.
- Timer position derives from a local start timestamp, not accumulated browser interval counts.
- Reload/reconnect resets the auxiliary timer; timer state is not part of durable server-side game history.
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
- **Red card:** immediately removes the player, with confirmation, no final speech, and an immediate victory check.
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

Live play has one immutable initial game baseline plus immutable parent-linked semantic events. The server appends each accepted event, advances `head_event_id`, and updates active-player/result projections in one transaction. The active head selects the branch replayed as current state; events on inactive future branches remain stored. Replay validates event shape, parent linkage, legal phase/day transitions, and the state hash after each event. Each retained entry stores:

- replay sequence, parent event ID, and timestamp;
- phase and day before/after the action;
- affected seat data in the payload where applicable;
- event type;
- type-derived private payload handling, with private payloads redacted from public projections;
- mutation-safe UUID;
- state hash after the action.

Required durable event families include:

- setup progress and player selection/reordering;
- role draws;
- phase transitions and turns;
- foul, muted-turn consumption, and red card;
- nomination and vote assignment/result;
- Mafia shots, Don/Sheriff checks, and secret results;
- elimination and victory.

Timer starts/stops/ticks and music playback/fades/navigation are auxiliary controls and are never durable log entries. Ordinary undo moves the active head to its parent without deleting the event or its inactive future branch. At most the latest three ordinary actions may be undone, and an undo cannot cross an event that advances the day. Timeline reset and restore-reset also move the active head among retained events. If the head moves behind `game.completed` within the allowed boundary, completed-game projections are retracted and the session becomes active again.

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

Cross-cutting UI state: local running timer, privacy shield, YouTube playback state, and aggregate connection/save status.

## 15. Touch and accessibility requirements

- Landscape tablet and laptop are the primary layouts.
- Core controls have at least 48×48 CSS-pixel hit targets and adequate separation.
- Long press is never the only way to invoke an action.
- Keyboard operation and visible focus are supported on laptops.
- Current speaker, nomination, elimination, muted state, and phase use text/icon in addition to color.
- Night screens use low-glare surfaces and an immediate privacy shield.
- Animation respects `prefers-reduced-motion`.
- Faint timer audio has a visible equivalent and a test button.

## 16. Product decisions and implementation gaps

Implemented and accepted behavior includes the current 2-second fade-in, 500-millisecond quick fade-out, 3-second slow fade-out, faint ten-second warning chime, no final speech after a red card, and the tie-vote flow in `rules.md`.

Two decided requirements remain implementation gaps:

1. The initial product requires English and Russian; the current UI is English-only.
2. Best Move must be a per-club setting enabled by default; current behavior is fixed and has no club-level setting.

The production backup target, method, retention, and restore procedure remain unresolved owner decisions.
