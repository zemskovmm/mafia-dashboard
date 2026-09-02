# Mafia Dashboard — Rules and Product Baseline

> **Status:** maintained product and rules baseline
> **Primary mode:** in-person, moderator-led **Club Mafia**
> **Product target:** a touch-first, self-hosted SPA for a moderator using a tablet or laptop, not an autonomous online game
> **Normative terms:** **MUST**, **SHOULD**, and **MAY** indicate required, recommended, and optional behavior.

## 1. Research conclusion

“Mafia” is a family of social-deduction games rather than one universally standardized game. The sources agree on the core model—an informed minority opposes an uninformed majority through alternating day and night phases—but differ on player count, roles, role reveal, voting, ties, night actions, and penalties.[S1][S2][S4][S5][S6][S7]

The product standardizes on **Club Mafia**, whose common format uses:

- exactly 10 numbered players;
- seven red-team roles, including one Sheriff;
- three black-team roles, including one Don;
- one-minute sequential speeches;
- 30-second tie speeches;
- concealed roles after elimination;
- moderator-tracked nominations, votes, night shots, checks, and fouls;
- music or masking sound during the night.[S3][S4]

Therefore, Mafia Dashboard implements a versioned Club Mafia rules baseline only. Alternate player counts, role sets, and party-game ruleset modules are outside the product scope.

## 2. Product scope

### 2.1 Product scope

The product is a **moderator’s control surface for a physical table**. Players remain together in person, receive physical role cards, speak aloud, gesture, and vote at the table. The moderator uses the dashboard to:

1. configure a game;
2. assign players to seats 1–10;
3. privately record roles;
4. run the phase sequence;
5. time speeches and night steps;
6. record nominations, votes, fouls, checks, shots, and eliminations;
7. detect legal next actions and win conditions;
8. correct moderator mistakes through an audited undo;
9. retain completed-game history in SQL.

The product does **not** provide player accounts, automatic role delivery to phones, video chat, remote voting, or a public/spectator display. Those modes are outside its moderator-operated physical-table scope.

### 2.2 Product principles

- **Assist, do not distract.** The moderator must be able to operate the core flow with large controls and minimal typing.
- **Rules are fixed.** The application implements the Club Mafia rules in this document rather than exposing alternate-ruleset selectors.
- **The event log is authoritative.** Live state is replayed from an immutable baseline through the active branch of parent-linked semantic events so actions can be audited and safely undone.
- **Secrets stay private.** Private roles and checks must not leak to non-host UI, player-visible logs, browser notifications, or URLs.
- **A moderator remains the arbiter.** The app validates normal flow; exceptional draw and cancellation rulings require an explanation, while ordinary corrections use Undo or Timeline Reset rather than an arbitrary state override.
- **No silent data loss.** Every accepted action is persisted and visibly acknowledged.
- **Fast recovery.** Refreshing the page or restarting the app MUST restore the active game. The auxiliary timer resets locally.

Existing moderator tools repeatedly emphasize role/vote tracking, guided night actions, timers, game history, autosave, and automatic end-game detection. Those are useful benchmark capabilities, not code or designs to copy.[S8][S9]

## 3. Canonical ruleset: Club Mafia v1

This section defines the application’s executable Club Mafia baseline. It is a product decision derived from the compared sources, not a claim that every club uses identical rules.

### 3.1 Participants and teams

A game has:

- **10 active player seats**, numbered 1 through 10;
- **1 non-playing moderator / judge**;
- **Red team (7):** 6 Citizens and 1 Sheriff;
- **Black team (3):** 2 Mafia and 1 Don.

Roles are assigned randomly unless the moderator explicitly records a manual deal. Seat numbers remain stable for the entire game.

### 3.2 Role abilities

| Role              |    Team | Count | Knowledge and ability                                                                                          |
| ----------------- | ------: | ----: | -------------------------------------------------------------------------------------------------------------- |
| Citizen           |     Red |     6 | No private night action. Speaks, nominates, and votes while active.                                            |
| Sheriff           |     Red |     1 | Once per regular night, checks one active player and privately learns whether that player is red or black.     |
| Mafia             |   Black |     2 | Learns the black team on night zero and participates in the coordinated nightly shot while active.             |
| Don               |   Black |     1 | Has Mafia abilities and, once per regular night, checks whether one active player is the Sheriff.              |
| Moderator / Judge | Neutral |     1 | Runs phases, time, rulings, secret information, votes, fouls, eliminations, and victory checks. Does not play. |

The Sheriff learns **team alignment**, not an exact role. The Don learns only **Sheriff / not Sheriff**.[S3][S4]

### 3.3 Information policy

The ruleset is **closed-role / dark reveal**:

- each player knows only their own role initially;
- black players meet one another on night zero;
- the moderator knows every role;
- Don and Sheriff checks are private;
- an eliminated player’s role is not disclosed until the game ends;
- eliminated players MUST not speak, gesture, or otherwise influence the game after their final speech;
- all roles may be revealed in the post-game summary.

This differs from many party variants that reveal cards immediately after elimination.[S2][S5]

### 3.4 Victory conditions

The dashboard MUST evaluate victory immediately after each elimination, disqualification, or other event that changes active team counts.

- **Red wins** when no active black players remain.
- **Black wins** when active black players are equal to or greater than active red players.
- **Draw** is available as a moderator ruling. In Club Mafia v1 it is automatically suggested if three consecutive complete night/day cycles produce no elimination, but the moderator must confirm it because club rules differ on this edge case.[S4]

No further phase starts after a win, confirmed draw, or cancellation.

## 4. Game state machine

### 4.1 States

The application SHOULD model explicit states rather than a collection of unrelated buttons:

```text
DRAFT
  -> READY
  -> NIGHT_ZERO
  -> DAY_SPEECHES
  -> DAY_VOTE (only when a vote is required)
  -> TIE_SPEECHES / REVOTE (zero or more times)
  -> DAY_RESULT
  -> REGULAR_NIGHT
  -> NIGHT_RESULT
  -> DAY_SPEECHES ...
  -> FINISHED
```

Exceptional terminal states are `CANCELLED` and `DRAW`. A game may be paused from any live state without changing its logical phase.

The implemented domain projection records consecutive complete cycles without an elimination and whether the current cycle has already produced an elimination. The draw suggestion becomes active at three consecutive quiet cycles, but only an explicit `game.drawn` event with a non-empty moderator reason enters `DRAW`. `game.cancelled` likewise requires a reason. Both events are public semantic checkpoints and may appear only once at the active replay head.

### 4.2 Preconditions

A game cannot become `READY` until:

- all 10 seats have unique seat numbers;
- each seat has a display name or nickname;
- exactly 7 red and 3 black roles exist;
- exactly one Sheriff and one Don exist;
- each seat receives exactly one role assignment and each role slot is assigned once;
- the moderator has confirmed that players have seen their physical cards;
- the fixed ten-seat Club Mafia role distribution is valid.

### 4.3 Night zero

Night zero establishes secret information and does not eliminate anyone.

1. The moderator announces night and all players put on masks / close their eyes.
2. Black players wake, identify one another, identify the Don, and agree on a future target order. The default timer is **60 seconds**.[S3][S4]
3. Black players sleep.
4. The Don identifies themself to the moderator if needed.
5. The Sheriff identifies themself to the moderator if needed.
6. The moderator may run the Club Mafia **40-second free-seating / sound-masking period**.[S4]
7. Day one begins with seat 1.

The target plan is a moderator note; it is not enforced as a mandatory sequence because players can miss, become eliminated, or use a different club convention.

### 4.4 Day speeches

- Only active players speak.
- Each active player receives up to **60 seconds**.
- Players speak in ascending seat order, wrapping after seat 10.
- Day one starts with seat 1.
- Each later day starts with the next active seat after the previous day’s starting speaker.
- A player MAY end early by passing; the timer stops and the next speaker begins.
- A player with a third foul loses their next normal speech. Their next turn becomes a **10-second nomination-only window** in which they may make one legal nomination.
- The moderator MAY stop or restart the auxiliary timer. Timer actions remain local UI state and are not added to durable game history.

The UI MUST show the current speaker, upcoming speaker, remaining time, fouls, and whether the player has already nominated someone that day.

### 4.5 Nominations

During their own speech, each active player MAY nominate at most one active player for elimination.

A valid nomination records:

- game day;
- nominating player;
- nominated player;
- sequence order;
- timestamp;
- moderator who accepted it.

Duplicate nominations of the same candidate do not create a second voting slot. In Club Mafia v1, an accepted nomination cannot be withdrawn.[S3][S4]

### 4.6 Whether a vote occurs

- With **no nominations**, no vote occurs.
- On **day one only**, one nomination does not trigger a vote; the nominated player stays.
- On later days, one or more nominations trigger a vote.
- With multiple nominations, candidates are voted in nomination order.[S4]

### 4.7 Voting

The moderator opens each candidate’s voting window in nomination order.

- Each active player has one vote per voting round.
- The physical vote is cast within approximately **1.5–2 seconds** after the moderator calls the candidate.[S3][S4]
- The moderator records the number of votes for the candidate.
- A vote already cast cannot be moved.
- Any uncast votes are assigned to the last candidate under the canonical Club Mafia rule.
- The recorded total MUST equal the number of active players eligible to vote unless a rules event explicitly changes eligibility.
- The candidate with the sole highest total is eliminated.

The app records each eligible player’s vote by seat while keeping candidate totals and unassigned voters visible.

### 4.8 Tie resolution

If two or more candidates share the highest total:

1. tied candidates receive **30 seconds each**, in original nomination order;
2. only those candidates enter a revote;
3. if a smaller subset ties, repeat 30-second speeches and a revote for that subset;
4. if the same candidate set ties again, the moderator asks whether **all tied candidates should leave**;
5. all eligible active players vote yes or no;
6. a strict majority of yes votes eliminates every tied candidate; otherwise all stay.

After simultaneous eliminations, all affected players are marked inactive before victory is evaluated.

### 4.9 Final speech

A player eliminated by the day vote or a successful night shot receives one final speech of up to **60 seconds** unless a disqualifying rule explicitly removes that right. Their role remains hidden.[S3][S4]

The final speech occurs before the next ordinary player speech. The player cannot nominate or vote during it.

### 4.10 Regular night

After the day result and any final speech:

1. all players sleep / put on masks;
2. the moderator runs the black-team shot;
3. the Don checks one active player, if the Don is active;
4. the Sheriff checks one active player, if the Sheriff is active;
5. the moderator resolves the night;
6. any special “best move” is recorded;
7. morning and any final speech occur;
8. victory is evaluated before normal day speeches begin.

The application follows this fixed Club Mafia night-action order.

### 4.11 Black-team shot

- The moderator calls seat numbers 1 through 10 in order.
- Every active black player keeps their eyes closed.
- Each active black player may make one shooting gesture when the intended seat is called.
- The shot succeeds only if **every active black player shoots the same active target exactly once**.
- A mismatch, missing shot, extra shot, or invalid target is a miss; nobody is eliminated by the Mafia that night.
- The app records each black player’s observed shot privately and derives success or miss.

This closed-eye coordinated shot is a defining Club Mafia mechanic and differs from party variants where the Mafia awaken and select a victim together every night.[S2][S3][S4]

### 4.12 Don check

If the Don is active:

- the moderator starts a default **10-second** check timer;
- the Don selects one active target;
- the moderator privately returns `SHERIFF` or `NOT_SHERIFF`;
- the result is stored as secret game data.

No player is eliminated by this check.

### 4.13 Sheriff check

If the Sheriff is active:

- the moderator starts a default **10-second** check timer;
- the Sheriff selects one active target;
- the moderator privately returns `RED` or `BLACK`;
- the result is stored as secret game data.

No player is eliminated by this check.

### 4.14 First-night “best move”

Current implemented behavior runs Best Move when there is an eligible victim on the first regular night:

- while still masked, the victim receives **20 seconds**;
- the victim names exactly three seat numbers they believe are black;
- the moderator records the ordered trio;
- the victim still receives their normal final speech after morning.

Best Move is a per-club setting enabled by default. Its resolved value is copied into `GameState` when the game starts, so later club-setting changes cannot alter an active or completed game.[S4]

## 5. Fouls and discipline

### 5.1 Ordinary fouls

The moderator can issue a foul with a reason and optional note. Common reasons include:

- speaking, whispering, or interjecting out of turn;
- disruptive touching or table noise;
- arguing with the moderator;
- improper conduct during voting;
- excessive gestures that distract other players;
- other minor violations selected by the moderator.

Consequences:

- foul 1: warning;
- foul 2: warning;
- foul 3: the player’s next normal 60-second speech that day becomes a 10-second nomination-only turn; if the player is eliminated by that day’s vote before consuming it, they receive no final speech;
- foul 4: immediate disqualification with no final speech.[S3][S4]

The app MUST track whether the third-foul speech penalty has been consumed; the count alone is insufficient. Any unconsumed penalty expires when the next day begins, before Best Move, morning final speeches, or ordinary day speeches, so it cannot suppress an overnight victim’s new-day final speech.

### 5.2 Immediate disqualification

The moderator MAY disqualify a player immediately for a serious violation, including deliberate peeking, prohibited night communication, outside information, threats, bribery, cheating, abusive conduct, or leaving the table without authorization. The exact tournament consequence—player removal, team loss, replay, or other ruling—remains a moderator decision and is logged.

### 5.3 Conduct baseline

At minimum:

- no harassment, threats, slurs, or personal abuse;
- no external messages, screenshots, coded signals, or outside observers supplying information;
- no physical contact used to communicate hidden information;
- no wagers, oaths, religion, or real-world claims used as proof of a role;
- no deliberate peeking;
- eliminated players and anyone observing the table remain neutral.

The product SHOULD use neutral UI wording such as “eliminated” and “night target,” while allowing themed moderator narration.

## 6. Club Mafia configuration boundary

Mafia Dashboard supports the ten-seat Club Mafia rules in this document. Player count, role distribution, role reveal, speech order, nominations, voting, tie resolution, night actions, checks, draw suggestion, and foul policy are not alternate-ruleset selectors.

Canonical events carry a replay-format version, but the UI does not expose a ruleset selector. Best Move is the one settled club-level rules control: it is enabled by default, configurable per club, and snapshotted into each new game before play begins.

The club language is presentation configuration rather than a rules selector. Every host-facing surface supports English and Russian; existing clubs migrate to English, new clubs default from the creator's browser language, and owners or managers/editors can change the club language immediately without changing an active game's canonical state.

## 7. Moderator workflow requirements

### 7.1 Setup screen

The setup screen SHOULD provide:

- 10 numbered seats in table order;
- player nickname entry and reusable player selection;
- random seat assignment with manual override;
- role validation and private assignment;
- the fixed ten-seat Club Mafia role distribution;
- timer presets;
- readiness checklist;
- start confirmation that summarizes secret-data handling.

The canonical setup wizard is ordered and gated: select exactly ten players, start the configured YouTube playlist, draw one random remaining role by tapping each seat, run Mafia negotiation, run the Sheriff wake-up step, and begin day one. The music step may advance only after the browser player reports that playback is actually running. The application loads playlist entries—including repeated occurrences—into its own browser-local session queue. The host can drag to reorder entries and use **Play next** or **Play now** without changing the owner’s real YouTube playlist. The chosen playlist ID belongs to the restorable game session; queue order and track tags are best-effort per-club browser-local preferences.

### 7.2 Live dashboard

The main live view SHOULD keep these visible without scrolling on a tablet or laptop:

- current phase and day/night number;
- ten seat cards in physical table order;
- active/eliminated/disqualified state;
- private role indicator in moderator mode;
- current speaker and countdown;
- per-player foul count;
- nominations in accepted order;
- phase-specific primary action;
- pause, undo, and correction controls;
- red/black active counts and pending victory warning;
- music / masking-audio controls;

Dangerous actions such as eliminating a player, ending the game, revealing roles, or undoing across a phase boundary require confirmation or a short undo window.

### 7.3 Night screen

The night screen MUST minimize accidental leaks:

- use a dark, low-glare theme;
- keep role and check details behind the host privacy controls;
- show a guided action queue;
- make target selection large and seat-number based;
- require confirmation for night resolution;
- distinguish pending action from resolved result;
- permit a deliberate shot at an inactive target and resolve it as the documented no-effect outcome.

### 7.4 Undo and Reset

The moderator MUST be able to correct recent actions from the authoritative browser snapshot. The browser persists the complete current `GameState` after every domain change and keeps semantic events as the structured Log/Timeline history. Ordinary Undo permanently removes the latest undoable event and every later event; Timeline Reset permanently retains only the selected root-to-checkpoint prefix. Undo and Reset do not create their own game events and there is no Reset Return or administrative correction event.

Undo is limited to the latest three ordinary actions and cannot cross an event that advances the game day. Reset consumes the current Undo allowance. Both actions remain available after a winning state is reached, but become unavailable immediately after the moderator clicks **Finish game**. A confirmed draw or cancellation is terminal immediately because its ruling already includes the required reason. After any completion is persisted, normal snapshot, event, head-move, normalization, start, completion, and delete/clear requests cannot edit, reopen, or remove it; only an exact idempotent retry of the accepted terminal request succeeds. The auxiliary timer resets locally rather than being reconstructed from game history.

The browser snapshot is persisted before network activity. PostgreSQL mirrors the last uploaded valid snapshot even when its client revision is older than the server revision. The server still validates snapshot shape, game invariants, club-owned participants, semantic-history integrity, and secret-data boundaries, then rebuilds active-player or completion projections atomically.

## 8. Persistence model

A relational database fits the domain because games have strongly related, auditable records and integrity constraints.

Current persisted entities:

- `users` and hashed-token `user_sessions`;
- `clubs` and `club_memberships` for manager/user access;
- `players`, including explicit pending/effective club access and optional membership provenance;
- `game_sessions`, containing the authoritative full browser snapshot, revision metadata, and session status;
- `game_events`, mirroring the snapshot's exact semantic Log/Timeline prefix;
- `game_session_mutations` for revisioned idempotent request handling;
- `game_session_players` as the durable host/participant projection used by active games and history filters;
- `game_results` and `game_player_results` as durable terminal and statistics projections;
- encrypted `youtube_oauth_credentials` for the separate read-only account grant.

Important invariants:

- one player per seat per game;
- one role per player per game;
- exactly one linear semantic event prefix and one browser-authoritative current game state;
- event replay sequence is monotonic within the retained prefix; Undo and Reset permanently remove the discarded tail;
- replay validates event envelopes, parent links, phase/day transitions, and state hashes;
- canonical illegal actions expose a stable `GameRuleError` code and safe context without mutating the supplied projection;
- red wins, black wins, reasoned draws, and reasoned cancellations become durable completed-game records with their snapshotted ruleset identity;
- completed history can be filtered by inclusive UTC calendar dates, participating player, and terminal result;
- secret fields are never returned by public APIs;
- completion projections mirror the accepted terminal browser snapshot and cannot be rewritten, reopened, or deleted through normal routes;
- application-level authorization is enforced on every game route, not only in the UI.

## 9. Self-hosted deployment baseline

A small single-server deployment SHOULD use Docker Compose with:

1. one web application container;
2. one PostgreSQL container or an external managed PostgreSQL service;
3. a persistent PostgreSQL volume;
4. a reverse proxy / TLS endpoint, either in Compose or already present on the server;
5. monitoring and a production backup approach chosen by the owner.

Operational requirements:

- pin major application and PostgreSQL image versions;
- wait for PostgreSQL’s health check, not merely container startup, before starting migrations/application traffic; Docker documents `service_healthy` for this purpose.[S10]
- run schema migrations as a controlled one-shot step;
- keep secrets outside the image and repository;
- do not publish the PostgreSQL port to the public internet;
- provide `/health/live` and `/health/ready` endpoints;
- persist database data outside the disposable container layer;
- choose, document, and test a PostgreSQL backup and restore approach before production; PostgreSQL documents SQL dumps, file-system backups, and continuous archiving as distinct options.[S11]
- document upgrades and rollback;
- use secure cookies, CSRF protection, rate limiting on authentication, and TLS.

The implemented Docker Compose and Azure baselines run the schema bundle as a one-shot migration before application traffic. The self-hosted TLS, logging, upgrade, shutdown, and rollback procedures are documented in [`docs/self-hosted-deployment.md`](docs/self-hosted-deployment.md). Scheduled PostgreSQL custom archives, off-server retention, semantic restore verification, and disaster recovery are documented in [`docs/postgresql-backup-and-recovery.md`](docs/postgresql-backup-and-recovery.md).

A Docker volume provides persistence but is **not** a backup. The production baseline uses daily PostgreSQL custom archives, configurable 14-day local and 30-day off-server retention defaults, weekly isolated semantic restore tests, encrypted/restricted storage, and non-zero failure alerts. This logical backup does not include cluster-global roles or point-in-time recovery.

## 10. Non-functional acceptance criteria

### Reliability

- A browser refresh restores the active game; the auxiliary timer resets locally.
- A container restart does not lose accepted game events.
- Duplicate requests do not create duplicate nominations, votes, fouls, or eliminations.
- An interrupted migration fails safely and visibly.

### Performance

- Primary moderator actions acknowledge within 200 ms on a local/LAN deployment under normal load.
- Timer display remains smooth and does not depend on one database write per animation frame.
- Reconnecting clients start with a reset local timer; timer position is never reconstructed from server state.

### Accessibility and ergonomics

- Core controls are keyboard operable.
- Color is never the only indicator of team, state, or error.
- Touch targets are suitable for a tablet.
- The live dashboard works at common laptop and tablet landscape widths.
- Alerts use both visual and optional audio cues.
- Secret information can be hidden instantly with a privacy toggle.

### Security and privacy

- Only authenticated moderators can create or modify games.
- Private game data is filtered server-side.
- Application session tokens are random, stored only as hashes, expire after a fixed non-sliding 30 days, and are independently revocable by signing out that session.
- Session cookies are `HttpOnly`, `Secure` in production, and use an appropriate `SameSite` policy.
- Cookie-authenticated unsafe API requests require an exact browser-origin match, and Google sign-in attempts are throttled per source.
- Responses enforce a tested content-security and browser-hardening policy; sensitive API responses are not cacheable.
- No credentials, role assignments, or private checks appear in URLs, analytics, logs, or client error reports.
- Dependency, static, repository, workflow, and production-image security gates block high/critical findings before release.
- Backups receive the same protection as the live database.

### Testability

- Rules-engine tests cover every normal transition and win condition.
- Table-driven tests cover the accepted vote/tie flow and foul thresholds.
- Permission tests prove public APIs cannot reveal secret data.
- Integration tests run against PostgreSQL.
- End-to-end tests cover setup through both red and black victories, refresh recovery, and undo.

## 11. Product decisions

### Implemented and accepted

- **Platform and scope:** TypeScript web application for authenticated club hosts/managers running ten-seat Club Mafia at a physical table.
- **Product boundaries:** no player-phone mode, public/spectator display, notes/drawing surface, or alternate rulesets.
- **Music and timer:** visible YouTube IFrame playback, a read-only account relationship, an application-owned browser-local session queue, 2-second fade-in, 500-millisecond quick fade-out, 3-second slow fade-out, and the current faint ten-second warning chime.
- **Rules:** no final speech after a red card, and the tie-vote conventions in section 4.8 are accepted.
- **Localization:** every host-facing surface supports English and Russian. The pre-club portal follows the browser language; each club then supplies the active language, which owners and managers/editors can change immediately without changing game state. Existing clubs migrate to English, while new clubs default from the creator's browser language.

### Decided requirements not yet implemented

- **Best Move:** a per-club setting enabled by default is required. Current behavior is fixed and has no club-level setting.

### Unresolved

- **Point-in-time recovery:** the single-server production baseline uses daily logical archives; base backups plus WAL archiving remain a separate decision if a 24-hour recovery-point window is unacceptable.

## 12. Source comparison and references

The rules above are paraphrased and normalized; they do not reproduce a commercial rulebook.

- **[S1] Original Mafia rules — Dmitry Davidoff.** Establishes the informed-minority/uninformed-majority core, original player ratios, hidden identities, and a substantially different paper-based night procedure.
  <https://gusandco.net/wp-content/uploads/2021/04/The-Original-Mafia-Rules-1.pdf>
- **[S2] Andrew Plotkin, “Werewolf.”** Influential live-play formulation with moderator, night/day loop, Seer, majority elimination, dead-player silence, parity victory, and practical moderation guidance.
  <https://www.eblong.com/zarf/werewolf.html>
- **[S3] English Mafia Club, classic rules.** Documents the ten-player 7-red/3-black format, Don and Sheriff, one-minute speeches, closed-eye shots, hidden eliminated roles, timed voting, and foul thresholds.
  <https://englishmafiaclub.com/how-to-play-mafia-by-classic-rules.html>
- **[S4] Federal Sport Mafia rules, 23 January 2023 edition, mirrored by Dom Mafia.** Detailed tournament procedure for setup, night zero, sequential speeches, nominations, timed voting, tie revotes, synchronized shots, Don/Sheriff checks, best move, fouls, special cases, and scoring.
  <https://dom-mafia.ru/sport_mafia_game_rules>
- **[S5] Fantasy Flight Games, _Mafia: Vendetta_ rules.** Commercial modern reference for facilitator responsibilities, explicit round structure, role secrecy, active/eliminated state, first-night behavior, voting, tie behavior, abilities, and alternate modes.
  <https://images-cdn.fantasyflightgames.com/filer_public/83/7a/837a5b73-ea6d-4aaa-b723-cbc1a201ce21/va95_mafia_rules_eng_v5compressed.pdf>
- **[S6] KQED, “How to Play Mafia.”** Accessible party-game example using Mafia, civilians, Doctor, Detective, and narrator; demonstrates how common house rules differ from Sport Mafia.
  <https://www.kqed.org/pop/10178/how-to-play-mafia-an-in-depth-guide-to-the-perfect-holiday-game>
- **[S7] Mafia Game rules.** Useful comparison for configurable open/dark games, speeches, nominations, voting/revoting, role actions, game logs, and host responsibilities in a digital implementation.
  <https://mafia-game.net/en/rules>
- **[S8] `kligarski/mafia-the-party-game`.** Existing moderator-assistance web app documenting lobby codes, role assignment, moderator prompts, player-device voting, discussion timing, Django, Svelte, WebSockets, and deployment considerations.
  <https://github.com/kligarski/mafia-the-party-game>
- **[S9] `samanrashidii/mafiabuzz`.** Existing moderator dashboard illustrating role configuration, team balance, night resolution, end-game detection, history, autosave, localization, and custom roles.
  <https://github.com/samanrashidii/mafiabuzz>
- **[S10] Docker Compose startup-order documentation.** Defines health-check-based dependency readiness with `service_healthy`.
  <https://docs.docker.com/compose/how-tos/startup-order/>
- **[S11] PostgreSQL Backup and Restore documentation.** Defines SQL dumps, file-system backups, and continuous archiving as separate backup strategies.
  <https://www.postgresql.org/docs/current/backup.html>

## 13. Glossary

- **Active:** still participating and eligible for applicable actions.
- **Black:** Mafia team alignment.
- **Closed / dark reveal:** eliminated roles remain hidden until game end.
- **Day:** speeches, nominations, and voting.
- **Don:** black special role that checks for the Sheriff.
- **Eliminated:** removed through vote or night action; distinct from a disciplinary disqualification.
- **Foul:** recorded rules violation and its escalating penalty.
- **Moderator / Judge:** non-playing person who runs and arbitrates the game.
- **Night zero:** setup night where black players meet; no shot is resolved.
- **Nomination:** a candidate accepted for the current day’s vote.
- **Red:** Citizen team alignment.
- **Sheriff:** red special role that checks player alignment.
- **Shot:** the black team’s coordinated night elimination attempt.
