# Mafia Dashboard Product Outline

## 1. Product definition

Mafia Dashboard is a host-operated, touch-first single-page application for running an in-person ten-player Club Mafia game. It is designed for landscape tablets and laptops, runs locally through Docker Compose, and deploys to Azure Container Apps with PostgreSQL persistence.

Players do not use accounts or phones. The authenticated host controls setup, music, timers, turns, nominations, voting, night actions, penalties, eliminations, and corrections from one device. The browser persists the authoritative full setup/live snapshot; semantic events provide validated Log, Timeline, and Preview history, while timer and music controls remain local UI state.

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
- Entering role giveaway from valid player/host selection requests the first durable setup snapshot before any role is drawn. The server generates the game GUID; a new game waits for that response, retaining the setup draft on failure. Reloads and offline update retries retain the same returned GUID, role deck, assignments, and pending save.
- **Back to player selection** preserves the host and seat selection without revealing drawn roles. Returning with unchanged selections preserves partial role-draw progress; changing the host or any seat resets that progress. Back-navigation and re-entry retain the same game ID.
- **Active games** lists all active games stored on the server for the selected club. Club admins/owners may open any game or delete it directly from this list. Multiple active games are allowed; starting another game does not delete a saved one. Deletion permanently removes the stored game without recording results, and is confirmed only after the server acknowledges it.
- There is no session claim, takeover, heartbeat, or stale-writer protection. Concurrent clients may overwrite each other's snapshots. A removed GUID cannot be recreated by an update; an already-open client discovers removal on its next request.

### Step 4 — Night zero: Mafia free seating

- The screen changes to a low-glare night state with a prominent `NIGHT ZERO · MAFIA FREE SEATING` phase banner.
- Mafia establish their target order during free seating; the center action advances to the
  night-zero Sheriff wake-up.
- The host uses the `+60` timer control to start negotiation.
- Starting or stopping the timer is local UI behavior and is not added to the durable game log; timer expiry does not advance the phase automatically.

### Step 5 — Night zero: Sheriff wake-up

- The night screen changes to `NIGHT ZERO · SHERIFF — 10 SECONDS`.
- The host starts the 10-second timer.
- Night zero does not add Don or Sheriff target checks; recorded checks begin in the ordinary
  nightly sequence after day one.
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

- Fade-in starts at volume 0, begins/resumes playback, and reaches 100% volume over the accepted 2-second duration. Direct playback also normalizes to 100%, rather than inheriting a previous low player volume.
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

- Day one starts at the first active seat from seat 1.
- Each later day opens at the next active seat after the previous day's actual opening seat, wrapping after seat 10. The cursor is not derived from the day number.
- Eliminated/red-carded seats are skipped. If the previous opener later becomes inactive, its original opening seat still anchors the next day's rotation.
- With every seat active, the first three openers are 1, 2, and 3. If seat 2 is inactive, they are 1, 3, and 4 instead.

### 9.2 Turn control

- The current seat is highlighted with text/icon and a visible next-seat preview.
- The center button starts that player’s timer.
- A normal active turn defaults to 60 seconds.
- A player with a pending third-foul penalty receives a 10-second nomination-only turn instead.
- The host can end a turn early; the next eligible seat becomes current.
- Completing the final eligible turn moves the game to voting if candidates exist, otherwise to night.

### 9.3 Player actions

- **Foul:** increments foul count and logs the reason/note when provided. Controls remain available for active players throughout live non-night day-play phases, including voting, car-crash handling, and goodbye speeches. They are unavailable during setup, night, Best Move (treated as night for this control), preview, and completed play.
- **Third foul:** creates one pending muted turn. That next turn lasts 10 seconds and permits only one nomination. A player who is still muted receives no goodbye speech. Any unconsumed mute expires when the day advances, before the new day's Best Move or goodbye speech; it never carries into the next day.
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

Don/Sheriff check eligibility is captured when the ordinary night begins. Active and eliminated role owners may check: both screens remain available on the night of death and every subsequent ordinary night, with target selection, private results, Continue, and Skip still usable. Owners red-carded before the night remain ineligible. Checks do not revive players or restore shooting, voting, or speaking rights. During their own eligible check selection screen, deceased owners retain the existing full-bright role highlight and deceased marker; result screens retain their normal presentation.

Previously saved nights retain their captured eligibility until the next ordinary night. Canonical replay remains current-rules-only: older logs whose transition hashes encode the former post-death skip rule are rejected, not silently rewritten or migrated.

### 11.1 Mafia shots

- The app lists each active Mafia-aligned shooter: both Mafia roles and Don while active.
- Select a shooter, then tap that shooter’s intended seated target.
- Each active shooter may have at most one recorded target when the host resolves the shots.
- If all active shooters selected the same active target, the target is eliminated; the same
  selection against an inactive seated player has no effect.
- Missing or conflicting shots result in a miss and no elimination; unseated targets are rejected.
- Individual shooter-to-target assignments are retained for replay; the timeline summarizes the
  collective result and eliminated target when applicable.

### 11.2 Don check

- If the Don is eligible for this night, show `DON CHECK`.
- Tap one seated target, including deceased players, or skip the check.
- Host-private result is Sheriff / not Sheriff.
- The result is stored as a secret event.

### 11.3 Sheriff check

- If the Sheriff is eligible for this night, show `SHERIFF CHECK`.
- Tap one seated target, including deceased players, or skip the check.
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

The browser's complete persisted game-session snapshot is authoritative for live play. PostgreSQL mirrors the last uploaded snapshot and its semantic event prefix without game-rule, replay, ownership or revision validation; game-record access requires authenticated club admin/owner authorization. Semantic events remain the structured source for Log, Timeline, and Preview, while client-side replay validates their shape, parent linkage, legal phase/day transitions, and state hashes without replacing the snapshot's current `GameState`. Each retained entry stores:

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

Timer starts/stops/ticks and music playback/fades/navigation are auxiliary controls and are never durable log entries. Ordinary Undo permanently removes the latest undoable event and its tail. Timeline Reset permanently retains only the selected root-to-checkpoint prefix. Neither action creates a log event, and there is no Reset Return. At most the latest three ordinary actions may be undone, and Undo cannot cross an event that advances the day. Undo and Reset become unavailable immediately after the host clicks **Finish game**.

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
  → NIGHT_DON_CHECK (when Don eligible this night)
  → NIGHT_SHERIFF_CHECK (when Sheriff eligible this night)
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

The setup durability/back-navigation, full-volume playback, foul/mute, opening-seat, and same-night eligibility decisions above were accepted in [#45](https://github.com/zemskovmm/mafia-dashboard/issues/45), [#46](https://github.com/zemskovmm/mafia-dashboard/issues/46), [#47](https://github.com/zemskovmm/mafia-dashboard/issues/47), [#49](https://github.com/zemskovmm/mafia-dashboard/issues/49), [#50](https://github.com/zemskovmm/mafia-dashboard/issues/50), [#51](https://github.com/zemskovmm/mafia-dashboard/issues/51), and [#54](https://github.com/zemskovmm/mafia-dashboard/issues/54). Browser ownership, club claims, snapshot authority, and current-only data support are specified in [ADR 0001](adr/0001-typescript-modular-monolith.md#current-data-support-and-ownership-boundaries).

Implemented and accepted behavior includes the current 2-second fade-in, 500-millisecond quick fade-out, 3-second slow fade-out, faint ten-second warning chime, no final speech after a red card, the tie-vote flow in `rules.md`, and complete English/Russian localization of every host-facing surface. Before a club is opened, the portal follows the browser language (`ru` locales use Russian; all others use English). Language is then controlled by the club: existing clubs migrate to English, new clubs default from the creator's browser, owners and managers/editors can change it, and an accepted change applies immediately without altering an active game.

Best Move is implemented as a per-club setting enabled by default. Its resolved value is copied into each game when play starts, so later club-setting changes do not rewrite active or completed games.

Production recovery uses PostgreSQL custom archives with configurable 14-day local and 30-day off-server retention defaults, daily scheduling, weekly isolated semantic restore tests, and the disaster-recovery procedure in `postgresql-backup-and-recovery.md`. Point-in-time recovery remains outside the single-server baseline.
