# La Verdad — Rules and Product Baseline

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

La Verdad implements one current Club Mafia baseline, owned by [IDD-0002](.idd/intent/IDD-0002.spec-club-mafia-gameplay.md), based on the MAFGAME 1 July 2026 source [S10] with documented club options. The date identifies source material, not a stored game engine. Alternate engines, per-game ruleset/edition selectors and party-game modules are outside scope; optional Casper is the documented nine-human/one-virtual-Citizen roster, not another engine.

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
9. retain known completed-game facts and available history in Azure Table/private Blob Storage.

The product does **not** provide player accounts, automatic role delivery to phones, video chat, remote voting, or a public/spectator display. Those modes are outside its moderator-operated physical-table scope.

### 2.2 Product principles

- **Assist, do not distract.** The moderator must be able to operate the core flow with large controls and minimal typing.
- **Rules are fixed.** The application implements the Club Mafia rules in this document rather than exposing alternate-ruleset selectors.
- **The browser snapshot is live authority.** Parent-linked canonical events validate Log/Timeline/Preview and permitted Undo without replacing the current snapshot. Completed facts remain valid independently of optional replay detail.
- **Secrets stay private.** Private roles and checks must not leak to non-host UI, player-visible logs, browser notifications, or URLs.
- **A moderator remains the arbiter.** The app validates normal flow; exceptional draw and cancellation rulings require an explanation, while ordinary corrections use Undo or Timeline Reset rather than an arbitrary state override.
- **No silent data loss.** Every accepted action is persisted and visibly acknowledged.
- **Fast recovery.** Refreshing the page or restarting the app MUST restore the active game. The auxiliary timer resets locally.

Existing moderator tools repeatedly emphasize role/vote tracking, guided night actions, timers, game history, autosave, and automatic end-game detection. Those are useful benchmark capabilities, not code or designs to copy.[S8][S9]

## 3. Current Club Mafia rules

This section summarizes the current Club Mafia contract in IDD-0002, not a claim that every club uses identical rules. Historical comparisons in section 12 are source context, not runtime alternatives. No persisted business record labels an engine with `rulesEdition`, `rulesetId`, `rulesetVersion` or an equivalent selector.

### 3.1 Participants and teams

A game has:

- **10 active player seats**, numbered 1 through 10;
- **1 non-playing moderator / judge**;
- **Red team (7):** 6 Citizens and 1 Sheriff;
- **Black team (3):** 2 Mafia and 1 Don.

Roles are assigned randomly unless the moderator explicitly records a manual deal. Seat numbers remain stable for the entire game.

Optional Casper fixes a virtual Citizen at seat ten with nine human players. The virtual seat cannot host or draw a role and is never rated as a human; a real person named Casper remains an ordinary player. Casper, Best Move-off and direct role corrections require no deviation acknowledgement.

### 3.2 Role abilities

| Role              |    Team | Count | Knowledge and ability                                                                                          |
| ----------------- | ------: | ----: | -------------------------------------------------------------------------------------------------------------- |
| Citizen           |     Red |     6 | No private night action. Speaks, nominates, and votes while active.                                            |
| Sheriff           |     Red |     1 | When eligible for the night, checks one seated player and privately learns red / black alignment.              |
| Mafia             |   Black |     2 | Learns the black team on night zero and participates in the coordinated nightly shot while active.             |
| Don               |   Black |     1 | Has Mafia abilities and, when eligible for the night, checks whether one seated player is the Sheriff.         |
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
- **Rules draw** follows three completed game nights with no participant-count change during that period. Initial Mafia planning counts as game night one; an intervening day/night departure resets the streak. No host reason is required to acknowledge that rule basis. A separate discretionary draw or cancellation requires a reason.

No ordinary phase starts after a win, draw or cancellation. Permitted correction remains distinct from explicit Finish. A reasoned referee-awarded opposing-team victory retains its rule, losing side and required committee acknowledgement without fabricating departures.

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

Current state records completed game nights, intervening departures and actual Sheriff checks as distinct facts. Rules-draw basis and discretionary draw/cancellation reasons remain distinct; accepted terminal events obey the current canonical lifecycle and cannot be duplicated at the replay head. There is no older cycle-based draw engine.

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
4. The host confirms **Mafia asleep**.
5. A separate reminder wakes Sheriff for ten seconds to look around and greet the host.
6. **Begin round zero** leads directly to the first discussion, with seat 1 opening; no initial check, kill, separate identification confirmation or free-seating stop occurs.

This streamlined club opening is not exact rulebook opening-procedure compliance. Initial planning is official game night one; the first shooting night is game night two. The first discussion is the zero round, although the internal first daytime index may be one.

### 4.4 Day speeches

- Only active players speak.
- Each active player receives up to **60 seconds**.
- Players speak in ascending seat order, wrapping after seat 10.
- Day one starts with seat 1.
- Each later day starts with the next active seat after the previous day’s starting speaker.
- A player MAY end early by passing; the timer stops and the next speaker begins.
- A player with a third foul loses the next ordinary speech while retaining nomination; with three or four players remaining at that turn, they receive 30 seconds instead. The pending restriction survives night, does not shorten a speech already underway, and is not consumed by a tie speech.
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

Each speaker may create one new nomination, including self, and support already nominated candidates once per target without duplicating voting slots or adding votes. Retapping corrects only that speaker's own selection; earlier speakers' contributions survive. A rejected second new nomination does not disable supports or penalties. Counts describe surviving relationships, not toggle activity.

### 4.6 Whether a vote occurs

- With **no nominations**, no vote occurs.
- On **day one only**, one nomination does not trigger a vote; the nominated player stays.
- On later days, one or more nominations trigger a vote.
- With multiple nominations, candidates are voted in nomination order.[S4]

### 4.7 Voting

The moderator opens each candidate’s voting window in nomination order.

- Each active player has one vote per voting round.
- Candidate calls follow the announced nomination order; physical acceptance is the judge's decision from the second mention until STOP, not an app-timer measurement.
- The host records individual assignments and may correct transcription without treating it as a participant's second vote. Each voter has at most one assignment per round.
- Last-candidate remainder applies when that candidate is actually called, not merely inspected; no unobserved votes are invented.
- Explicit Finish requires a complete or mathematically conclusive ballot, not a merely leading candidate. Disputed counts suspend progression until acknowledged external review and a final ruling.
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

Collective lift is prohibited for all remaining players and for a zero-round five-way tie. Three tied at nine also require both completed official game night three and at least two actual Sheriff checks; skips are not checks. A permitted observed hand count may explicitly finish at zero, minority, half or majority without fabricating untouched individual no votes.

### 4.9 Final speech

A player eliminated by the day vote or a successful night shot receives one final speech of up to **60 seconds** unless a disqualifying rule explicitly removes that right. Their role remains hidden.[S3][S4]

The final speech occurs before the next ordinary player speech. The player cannot nominate or vote during it.

### 4.10 Regular night

After the day result and any final speech:

1. all players sleep / put on masks;
2. the moderator runs the black-team shot;
3. the Don checks one seated player if eligible for this night;
4. the Sheriff checks one seated player if eligible for this night;
5. the moderator resolves the night;
6. any special “best move” is recorded;
7. morning and any final speech occur;
8. victory is evaluated before normal day speeches begin.

The application follows this fixed Club Mafia night-action order.

An owner who departed before the night cannot check. A non-decisively shot same-night owner may complete the captured night's check before departure unless disqualification prevents it; inactive targets remain checkable. A deciding result stops further checks, Best Move and farewell.

### 4.11 Black-team shot

- The moderator calls seat numbers 1 through 10 in order.
- Every active black player keeps their eyes closed.
- Each active black player may make one shooting gesture when the intended seat is called.
- The shot succeeds only if **every active black player shoots the same active target exactly once**.
- A mismatch, missing shot or actual multiple shot is a miss. A unanimous shot at an inactive seated target has no effect; unseated targets are rejected. Clerical correction is distinct from observed multiple firing. Accepted ordered private shooter/target observations survive history and Undo without changing public projections.
- The app records each black player’s observed shot privately and derives success or miss.

This closed-eye coordinated shot is a defining Club Mafia mechanic and differs from party variants where the Mafia awaken and select a victim together every night.[S2][S3][S4]

### 4.12 Don check

If the Don is eligible for this night:

- the moderator starts a default **10-second** check timer;
- the Don selects one seated target, including an inactive player, or skips;
- the moderator privately returns `SHERIFF` or `NOT_SHERIFF`;
- the result is stored as secret game data.

No player is eliminated by this check.

### 4.13 Sheriff check

If the Sheriff is eligible for this night:

- the moderator starts a default **10-second** check timer;
- the Sheriff selects one seated target, including an inactive player, or skips;
- the moderator privately returns `RED` or `BLACK`;
- the result is stored as secret game data.

No player is eliminated by this check.

### 4.14 First-night “best move”

Best Move runs for an eligible first shooting-night victim unless two or more first-day departures suppress it:

- while still masked, the victim receives **20 seconds**;
- the victim may provide zero through three accepted seat numbers in spoken order;
- the moderator preserves the accepted prefix if time, interruption, decline or early completion ends the attempt; no active-only target restriction or invented numbers applies;
- the victim still receives their normal final speech after morning.

Best Move is a per-club setting enabled by default and captured during meaningful setup, so later preferences cannot alter existing games. Skip records an empty decline without changing that setting; Finish early retains accepted numbers. The judge reads back and accepts before morning; timer expiry never advances automatically. Post-acceptance edits require explicit obvious-slip correction. A virtual Casper victim skips Best Move; previously known Best Move observations remain facts, not alternate gameplay.

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
- foul 3: restrict the next ordinary discussion turn as in section 4.4, surviving night until consumed; do not use it as a blanket farewell prohibition;
- foul 4: disqualification without farewell at the applicable disciplinary boundary.

The app MUST track whether the third-foul restriction has been consumed; the count alone is insufficient. Fourth foul and direct removal preserve day/night occurrence, announcement timing, required shooting/check completion and legitimate combined shot/removal facts. Exclude a disqualified shooter's shot and count departure once. Cancel the current or nearest affected ballot, including the next day after a result, with victim exceptions; several removals do not cancel several consecutive days.

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

La Verdad supports the current ten-seat Club Mafia rules and documented Casper option in this document. Role reveal, speech order, nominations, voting, ties, night actions/checks, rules draw and fouls are not alternate-ruleset selectors.

Data-shape/operational versions may describe serialization, storage, recovery or the Elo calculation, never dispatch older rules. Games contain no engine identity; there are no edition labels, filters, unrated reasons or old/current game-bank categories. Best Move settings, Casper and role corrections are game facts/options under the one current engine, not version selectors.

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

The canonical setup wizard is ordered and gated: select ten participants (or nine humans plus fixed Casper), optionally start the configured YouTube playlist, assign roles by tapping seats or the separate role chooser, run Mafia agreement, confirm Mafia asleep, wake Sheriff for the greeting and begin the zero round. Unavailable music is nonblocking. The application loads playlist entries—including repeated occurrences—into its own browser-local session queue. The host can drag to reorder entries and use **Play next** or **Play now** without changing the owner’s real YouTube playlist. The chosen playlist ID belongs to the restorable game session; queue order and track tags are best-effort per-club browser-local preferences.

During role giveaway, either horizontal swipe opens the selected seat's Clear/available-role chooser, including after the complete deal; triple-tap reroll remains separate. Trusted touch must work initially and after Clear. Browser gesture policy follows available actions: horizontal-only role cards retain native vertical pan and pinch zoom, while cards needing vertical foul/penalty gestures retain their existing application policy. Cancelled/capture-lost, multi-pointer and disabled/read-only gestures cannot trigger stale actions or trailing clicks. Native typing, selection and controls remain unchanged; no global cancellation workaround is introduced.

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

Left/right gameplay swipes open no Red-card shortcut and apply no penalty, vote or accidental tap; its dedicated quick-menu is absent. Downward fouls and the upward penalty menu remain, including confirmed disqualification, fourth-foul handling, voting cancellation, no dismissed-player farewell, canonical history and permitted Undo. Setup's horizontal role chooser is not removed.

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

Undo is limited to the latest three ordinary actions and cannot cross an event that advances the game day. Reset consumes the current Undo allowance. Wins, draws and cancellations stop ordinary play but retain permitted correction until explicit **Finish game**, which disables client Undo/Reset. Finish is not an API immutability promise or a new authorization boundary; authorized snapshot persistence remains last-write-wins under IDD-0004. The auxiliary timer resets locally rather than being reconstructed from game history.

The browser snapshot is persisted before network activity. Azure stores the last accepted snapshot without a client revision fence. The server validates identity-only shape, club-owned identities and authorization/secret-data boundaries, then publishes related projections atomically. Gameplay rules and semantic replay validation remain in the browser.

## 8. Persistence model

Azure Table Storage holds typed records and synchronized projections; private Blob Storage holds complete immutable game revision envelopes and large values. These logical record groups are not SQL tables, and canonical events are stored inside their game envelope rather than one Table entity per event. IDD-0004/0005/0006 own the current persistence and preservation contracts.

Current persisted entities:

- `users` and hashed-token `user_sessions`;
- `clubs` and `club_memberships` for manager/user access;
- `players`, including explicit pending/effective club access and optional membership provenance;
- game heads and private immutable envelopes containing full active snapshots or independently known completed facts, revision metadata and status;
- retained canonical events inside the envelope, preserving exact semantic Log/Timeline linkage and privacy, not separate Table rows;
- creation mappings, deletion markers and atomic commit receipts for idempotent publication and non-resurrection;
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
- red wins, black wins, rules/discretionary draws and cancellations retain accepted factual bases without engine identity; partial completed records preserve unknowns rather than fabricated outcomes;
- completed history can be filtered by inclusive UTC calendar dates, participating player, and terminal result;
- secret fields are never returned by public APIs;
- result projections mirror known accepted facts; available completed timelines are read-only and unavailable detail does not invalidate the factual record;
- application-level authorization is enforced on every game route, not only in the UI.

Every game and known label/time, host, tournament, participant identity/seat, role/team, status, fouls, Best Move and actual Casper/roster fact remains preserved. Metrics use their own observed denominators; unknown is not zero, false, loss or a made-up played time, and unrelated missing fields do not poison other facts. Win rate includes observed draws; missing outcomes do not become losses. Incomplete records remain in unfiltered history with deterministic undated placement. Elo eligibility is independent: retain the entire `club-team-elo-v1` algorithm, ordering, precision/rounding, ranking, correction rebuilds and tournament-delta accounting in [IDD-0007](.idd/intent/IDD-0007.spec-club-statistics-and-rating.md), removing only edition-based exclusion. Missing actual rating inputs leaves the record unrated, not invalid; missing unrelated foul/status/timeline data does not block a determined rating.

## 9. Deployment baseline

The application runs locally with its owned Azurite/API/Vite workflow and deploys as an immutable Docker image to Azure Container Apps. Azure Table/private Blob Storage is the sole supported backend. PostgreSQL runtime, Compose deployment and SQL import tooling are not maintained; existing databases, archives and infrastructure are not erased by retiring that support.

Operational requirements:

- pin application image identity and verify it after deployment;
- validate recognized storage readiness before application traffic; explicitly initialize only an approved empty namespace;
- keep secrets outside the image and repository, using scoped managed identity for production storage;
- retain private Blob content and provide `/health/live` and `/health/ready` endpoints;
- confirm remote persistence before acknowledging saves;
- preserve compatible data through upgrades and rollback without automatic reset or runtime conversion;
- use secure cookies, CSRF protection, rate limiting on authentication, and TLS.

See [`docs/azure-deployment.md`](docs/azure-deployment.md) for deployment and rollback. Consistent recovery packages contain typed Table records and all referenced Blob bytes; replication alone is not an application backup. [`docs/azure-storage-backup-and-recovery.md`](docs/azure-storage-backup-and-recovery.md) describes the isolated local qualification. Production backup scheduling, retention and live recovery objectives remain separately scoped work.

Historical normalization is a separately gated one-time operation, not runtime compatibility. Preserve every game/known fact and valid relationship; retain faithful usable completed timelines or a private statistics-only disposition for incompatible optional detail. Incompatible active or unsent state stops the operation. Any predecessor decoder remains private local operational material. Verified representation conversion alone may replace bytes/corresponding hashes; ordinary saves and metadata edits never do. Production execution requires exact-target inventory/dry-run, separately authorized writes, a proven private Table/Blob backup and isolated restore/readback, and an explicitly authorized compatible app/data maintenance sequence with protected pending work, interruption/repeat safety and exact readbacks. Local preparation does not establish completion, access-grant or deployment authority; image-only rollback does not prove data compatibility, and pre-conversion restore after new writes requires a new recovery decision.

## 10. Non-functional acceptance criteria

### Reliability

- A browser refresh restores the active game; the auxiliary timer resets locally.
- A container restart does not lose accepted game events.
- Duplicate requests do not create duplicate nominations, votes, fouls, or eliminations.
- Interrupted storage initialization or recovery fails safely and visibly without resetting existing data.

### Performance

- Primary moderator actions acknowledge within 200 ms on a local/LAN deployment under normal load.
- Timer display remains smooth and does not depend on one database write per animation frame.
- Reconnecting clients start with a reset local timer; timer position is never reconstructed from server state.

### Accessibility and ergonomics

- Native control behavior follows [IDD-0003's Native interaction contract](.idd/intent/IDD-0003.spec-host-controls-and-presentation.md#native-interaction); no complete keyboard-only workflow is promised. [Interaction and landscape verification](docs/keyboard-and-landscape-ergonomics.md) records retained coverage and pending local qualification.
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
- Persistence integration tests run against owned, isolated Azurite fixtures.
- End-to-end tests cover setup through both red and black victories, refresh recovery, and undo.

## 11. Product decisions

### Implemented and accepted

- **Platform and scope:** TypeScript web application for authenticated club hosts/managers running ten-seat Club Mafia at a physical table.
- **Product boundaries:** no player-phone mode, public/spectator display, notes/drawing surface, or alternate rulesets.
- **Music and timer:** visible YouTube IFrame playback, a read-only account relationship, an application-owned browser-local session queue, 2-second fade-in, 500-millisecond quick fade-out, 3-second slow fade-out, and the current faint ten-second warning chime.
- **Rules:** no final speech after a red card, and the tie-vote conventions in section 4.8 are accepted.
- **Localization:** every host-facing surface supports English and Russian. The pre-club portal follows the browser language; each club then supplies the active language, which owners and managers/editors can change immediately without changing game state. Existing clubs migrate to English, while new clubs default from the creator's browser language.

### Current data and interaction decisions

- **One current engine:** business records have no engine metadata; partial completed facts are valid independently of optional history, with observed metric coverage and unchanged Elo apart from edition exclusion.
- **Player cards:** no horizontal gameplay Red-card quick-menu; upward penalties, downward fouls, fourth-foul discipline and setup's trusted horizontal role chooser remain.
- **Best Move:** enabled by default, configurable per club and captured during meaningful setup; per-attempt Skip does not change the setting.

### Unresolved

- **Production recovery:** local Azure package/restore qualification does not establish production scheduling, retention, recovery objectives or point-in-time recovery.

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
- **[S10] MAFGAME rules, 1 July 2026 source.** Dated source for the current contract in IDD-0002; the app's club options and streamlined opening do not claim exact tournament compliance.
  <https://mafgame.org/pages/rules>

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
