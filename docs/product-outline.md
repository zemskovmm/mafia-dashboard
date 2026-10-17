# La Verdad Product Outline

## 1. Product definition

La Verdad is the official application of the [La Verdad club in Málaga](https://mafiamalaga.es): a host-operated, touch-first single-page application for running an in-person ten-player Club Mafia game. It is designed for landscape tablets and laptops, runs locally with an owned Azurite emulator, and deploys to Azure Container Apps with Azure Table/private Blob persistence.

Players do not use accounts or phones. The authenticated host controls setup, music, timers, turns, nominations, voting, night actions, penalties, eliminations, and corrections from one device. The browser persists the authoritative full setup/live snapshot; semantic events provide validated Log, Timeline, and Preview history, while timer and music controls remain local UI state.

The current gameplay contract is owned by [IDD-0002](../.idd/intent/IDD-0002.spec-club-mafia-gameplay.md): one current engine follows the MAFGAME 1 July 2026 source with the club options below. Games do not store engine labels or select older rules on resume; the dated reference belongs to documentation, not game identity. Casper, Best Move-off and direct role corrections remain club options without deviation warnings or acknowledgement screens; they do not imply exact federation compliance. Role giveaway supports immediate triple-tap reroll and either-direction swipe to clear or select an available role. Discretionary referee rulings retain their own safeguards. This outline describes the product contract, not a claim of completed release or data-migration qualification.

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
- downward foul gesture, upward penalty menu (including confirmed Red card), and eligible whole-card nomination/support; left/right gameplay swipes open no Red-card shortcut and apply no action or trailing tap;
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
- A player card shows games played, W/D/L, win rate, team/role observations, total fouls, eliminations, red cards, Best Move and last played, with observed denominators and incomplete-coverage disclosure. Unknown is not zero or loss; missing one field does not erase unrelated known facts.
- Completed records may contain minimal, partial or full factual results independently of optional timeline detail. Preserve every game and known identity, result, timestamp, host, tournament and participant observation; retries cannot double-count a game. History includes incomplete records without edition categories; filters cannot match unknown values, and undated records have stable placement without invented dates.
- Experimental lifetime `club-team-elo-v1` retains its full ordering, 1,500 start, simultaneous team-mean expectation updates with K=32, precision/rounding, provisional/rank rules, correction rebuilds and tournament-delta accounting in [IDD-0007](../.idd/intent/IDD-0007.spec-club-statistics-and-rating.md). Edition is not an eligibility criterion. Known complete non-Casper ten-human rosters, valid seats/roles/teams, played time and accepted outcome are required; unrelated missing fouls or timeline detail are not.

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

### Step 4 — Initial game night: Mafia planning

- Mafia receive 60 seconds to agree, then sleep. The screen remains host-private and low-glare.
- Timer controls remain auxiliary and host-started; expiry never advances phase.

### Step 5 — Sheriff greeting

- After manually putting Mafia to sleep and confirming **Mafia asleep**, the host sees a separate reminder to wake Sheriff for ten seconds to look around the table and greet the host.
- **Begin round zero** follows directly, without Don-identification confirmation, masked-identification prompts or a separate free-seating stop. This streamlined club opening is not a claim of exact rulebook opening-procedure compliance. Valid retained current opening steps survive ordinary operations without rewritten history.
- No target check or shot occurs in the initial planning night. It is official game night one; the first shooting night is game night two.

### Step 6 — Zero-round discussion

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

- Preset buttons: **+60**, **+30**, **+20**, and **+10**.
- Pressing a preset immediately starts/replaces the active countdown; the timer face pauses or resumes it.
- Recommended durations are 60 seconds for ordinary speech/planning, 30 for tie/restored free-seating/short-table speech, 20 for Best Move and 10 for Sheriff greeting/checks. The host starts the applicable timer explicitly.
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
- A player with a pending third-foul restriction may nominate but has no ordinary speech; with three or four remaining players, that turn receives 30 seconds. A tie speech remains available and does not consume this restriction.
- The host can end a turn early; the next eligible seat becomes current.
- Completing the final eligible turn moves the game to voting if candidates exist, otherwise to night.

### 9.3 Player actions

- **Foul:** records the judge's accepted sanction. Third foul affects the next ordinary discussion turn, survives night and does not retroactively shorten a speech underway. It is distinct from farewell eligibility.
- **Red card:** no farewell; removal/announcement timing follows its day/night occurrence. During shooting/checks, preserve required completion boundaries, exclude a disqualified shooter's shot and retain legitimate combined shot/removal facts. A participant departs only once.
- **Voting cancellation:** apply the current or nearest affected ballot, including the next day after a result, with rulebook victim exceptions. Several removals do not create several consecutive cancelled days.
- **Nominate/support:** during the current speaker's eligible window, create one new nomination, including self, and support existing candidates once per target. Retapping corrects only that speaker's own selection without replacing earlier contributions or discarding unrelated actions; counts are surviving relationships, not ballot votes or toggle activity.

## 10. Voting

- The candidate queue remains visible in nomination order.
- Announce the full order twice. Live candidate calls follow that order and accept votes on the second mention until judge STOP; inspection of another candidate does not change the live cursor.
- Tap eligible player icons to assign their votes to that candidate.
- A voter can be assigned to at most one candidate per voting round.
- Tapping an assigned voter again removes/reassigns the vote only through an explicit action.
- Eliminated/red-carded players cannot vote.
- Candidate totals and unassigned eligible voters remain visible.
- Finish voting requires a complete or mathematically conclusive ballot; no invented uncast votes. Last-candidate remainder applies when that candidate is actually called, not when inspected. A merely leading candidate cannot finish early.
- A count dispute immediately pauses further voting until the judge acknowledges external video review and records the final ruling. Physical vote acceptance remains a judge decision, not an app-timer measurement.
- A lone zero-round nominee is not voted out; a lone later nominee leaves with all votes when discussion ends. Generic convenience skip is not a federation rule exception.
- Thirty-second tie speeches precede revoting; shrinking ties repeat. Collective lift requires a strict majority and is not held for all remaining players. It is also prohibited for a zero-round five-way tie, and for three tied at nine unless official game night three has completed and Sheriff actually checked at least twice.
- The highest total wins; ties enter the configured tie flow from `rules.md` rather than being resolved randomly.
- Elimination is logged and victory is checked before night begins.

## 11. Night

Night is a host-private guided sequence.

Don/Sheriff check eligibility is captured for the night. A previously departed owner cannot continue checking. A non-decisively shot same-night owner may finish that night's check before leaving unless an applicable disqualification prevents it. Inactive target seats remain checkable. Checks never restore shooting, voting or speech rights.

There is no alternative post-departure check engine. Accepted historical checks/results remain facts, not a reason to re-adjudicate outcomes or dispatch older rules. Explicit one-time conversion is governed by [IDD-0005](../.idd/intent/IDD-0005.spec-data-compatibility-and-preservation.md); normal reads and saves never perform it.

### 11.1 Mafia shots

- The app lists each active Mafia-aligned shooter: both Mafia roles and Don while active.
- Select a shooter, then tap that shooter’s intended seated target.
- Each active shooter may have at most one recorded target when the host resolves the shots.
- If all active shooters selected the same active target, the target is eliminated; the same
  selection against an inactive seated player has no effect.
- Missing/conflicting shots or an actual multiple shot by one shooter result in a miss; unseated targets are rejected. A correction of transcription is distinct from recording an actual multiple shot.
- Individual shooter-to-target assignments are retained for replay; the timeline summarizes the
  collective result and eliminated target when applicable.

### 11.2 Don check

- If the Don is eligible for this night, show `DON CHECK`.
- Tap one seated target, including deceased players, or skip the check.
- Host-private result is Sheriff / not Sheriff.
- The judge has a ten-second check window and reads back the numbered target; the UI includes seat number, not only player name.
- The result is stored as a secret event.

### 11.3 Sheriff check

- If the Sheriff is eligible for this night, show `SHERIFF CHECK`.
- Tap one seated target, including deceased players, or skip the check.
- Host-private result is Mafia-aligned / not Mafia-aligned.
- Read back the target number and signal **red = thumb up**, **black = thumb down** during the ten-second check window. Skipping does not increment the actual-check counter.
- The result is stored as a secret event.

### 11.4 Night completion

- Apply the Mafia result and evaluate victory.
- If eligible, complete Best Move before announcing morning, then provide the victim's farewell and the rotated discussion order. Do not increment the night/day boundary twice through these steps.
- After three completed game nights with no participant-count change during that period, award a rules draw. Initial planning counts as game night one under the adopted literal reading; any intervening day/night departure resets the streak.

### 11.5 Best Move

- The first shooting-night victim may give up to three accepted numbers, in order, during night with a twenty-second time allowance. Two or more first-day departures suppress eligibility.
- Preserve an accepted prefix of zero through three numbers when time, interruption or decline ends the attempt. Ordinary changes/additions after acceptance are not allowed; an obvious-slip correction is explicit.
- **Skip Best Move** records decline for an empty list and continues to morning/farewell without changing preferences. **Finish early** preserves already accepted numbers. Timer expiry signals STOP but never advances automatically.
- The judge reads back the numbers and says accepted; only then does morning follow. Recorded hits are descriptive, not tournament scoring.

## 12. Victory

- Red wins when no active Mafia-aligned player remains.
- Mafia wins when active Mafia-aligned players are equal to or greater than active red players.
- Victory is evaluated after every elimination or red card and before starting another phase.
- The final result and role reveal are recorded, but private role information remains behind the host privacy control.
- The referee may award a reasoned opposing-team victory (ППК), retaining rule, losing side and required committee acknowledgement without fabricating deaths. Authoritative result detail retains this basis separately from normal win statistics.
- A detected win/draw/cancellation stops ordinary play but remains distinct from explicit **Finish game**, preserving authorized Undo/Reset until Finish.

## 13. Game log

The browser's complete persisted game-session snapshot is authoritative for live play. Azure stores the last accepted snapshot and its semantic event prefix without server-side game-rule/replay validation or client revision fencing; game-record access requires authenticated club membership, with both managers and regular users permitted to host. The server preserves identity/shape and club-isolation checks. Semantic events remain the structured source for Log, Timeline, and Preview, while client-side replay validates their shape, parent linkage, legal phase/day transitions, and state hashes without replacing the snapshot's current `GameState`. Completed factual validity does not depend on a full snapshot or playable history: usable timelines remain read-only, absent detail is visibly unavailable, and corrupt retained history never becomes editable fallback. Each retained entry stores:

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
  → SETUP_MAFIA_ASLEEP
  → SETUP_SHERIFF_GREETING
  → DAY_TURNS
  → VOTING (when candidates exist)
  → NIGHT_MAFIA_SHOTS
  → NIGHT_DON_CHECK (when Don eligible this night)
  → NIGHT_SHERIFF_CHECK (when Sheriff eligible this night)
  → NIGHT_RESOLUTION
  → BEST_MOVE (when eligible, still night; accepted prefix or Skip)
  → MORNING / FAREWELL (when applicable)
  → DAY_TURNS ...
  → FINISHED
```

Cross-cutting UI state: local running timer, privacy shield, YouTube playback state, and aggregate connection/save status.

## 15. Touch and accessibility requirements

- Landscape tablet and laptop are the primary layouts.
- Core controls have at least 48×48 CSS-pixel hit targets and adequate separation.
- Long press is never the only way to invoke an action.
- Setup's trusted horizontal touch opens the correct role chooser initially and after Clear in either direction, without a trailing click. Browser touch policy follows available actions: horizontal-only role cards preserve native vertical pan and pinch zoom; cards needing vertical foul/penalty gestures retain their existing vertical application policy. Cancellation, capture loss, multi-pointer and disabled/read-only cases cannot leave stale actions. Gameplay horizontal no-ops do not remove upward penalties, downward fouls, history or Undo.
- Native typing, Tab navigation, and button activation follow [IDD-0003's Native interaction contract](../.idd/intent/IDD-0003.spec-host-controls-and-presentation.md#native-interaction); no complete keyboard-only workflow is promised. [Interaction and landscape verification](keyboard-and-landscape-ergonomics.md) distinguishes retained coverage from pending local qualification.
- Current speaker, nomination, elimination, muted state, and phase use text/icon in addition to color.
- Night screens use low-glare surfaces and an immediate privacy shield.
- Animation respects `prefers-reduced-motion`.
- Faint timer audio has a visible equivalent and a test button.

## 16. Product decisions and implementation gaps

The setup durability/back-navigation, full-volume playback, foul/mute, opening-seat, and same-night eligibility decisions above were accepted in [#45](https://github.com/zemskovmm/mafia-dashboard/issues/45), [#46](https://github.com/zemskovmm/mafia-dashboard/issues/46), [#47](https://github.com/zemskovmm/mafia-dashboard/issues/47), [#49](https://github.com/zemskovmm/mafia-dashboard/issues/49), [#50](https://github.com/zemskovmm/mafia-dashboard/issues/50), [#51](https://github.com/zemskovmm/mafia-dashboard/issues/51), and [#54](https://github.com/zemskovmm/mafia-dashboard/issues/54). Browser ownership, club claims, snapshot authority, and current-only data support are specified in [ADR 0001](adr/0001-typescript-modular-monolith.md#current-data-support-and-ownership-boundaries).

Implemented and accepted behavior includes the current 2-second fade-in, 500-millisecond quick fade-out, 3-second slow fade-out, faint ten-second warning chime, no final speech after a red card, the tie-vote flow in `rules.md`, and complete English/Russian localization of every host-facing surface. Before a club is opened, the portal follows the browser language (`ru` locales use Russian; all others use English). Language is then controlled by the club: existing clubs migrate to English, new clubs default from the creator's browser, owners and managers/editors can change it, and an accepted change applies immediately without altering an active game.

Best Move is enabled for standard new games and captured during meaningful setup. A club override remains supported; later preference changes do not rewrite existing games. The per-attempt Skip action never changes that setting. There is no older-setup rule/default fallback in normal runtime.

Azure recovery uses consistent Table/private Blob packages and an isolated local restore drill described in [Azure Storage backup and recovery](azure-storage-backup-and-recovery.md). Production scheduling, retention and live recovery qualification remain separate operational work; old PostgreSQL archives are not deleted by retiring their tooling.

One-time historical normalization is separate from normal runtime and recovery. It preserves every game, known fact and valid relationship; keeps faithful usable timelines; and may retain a completed record as statistics-only when optional history cannot be converted faithfully. Incompatible active or unsent work is a stop condition, never permission to discard it. Any predecessor decoder stays in private local operational material. Production execution still requires exact-target inventory/dry-run, separately authorized writes, proven private backup/recovery and an explicitly authorized compatible app/data cutover; local preparation does not establish completion or deployment authority.
