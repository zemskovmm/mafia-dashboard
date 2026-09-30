# Entity model

This document describes the current PostgreSQL persistence model and the core game-domain model. It is derived from:

- [`apps/server/src/schema.sql`](../apps/server/src/schema.sql) for physical tables, keys, and foreign keys;
- [`packages/game-domain/src/types.ts`](../packages/game-domain/src/types.ts) for game state;
- [`packages/game-domain/src/game-events.ts`](../packages/game-domain/src/game-events.ts) for canonical events and replay metadata;
- [`apps/server/src/game-session-store.ts`](../apps/server/src/game-session-store.ts) and [`apps/server/src/event-store.ts`](../apps/server/src/event-store.ts) for persistence mappings.

The first diagram is physical: `PK` and `FK` reflect PostgreSQL constraints. The later diagrams are conceptual TypeScript models; their relationships describe containment, extension, or event payloads rather than database foreign keys. `o|`, `||`, and `o{` mean zero-or-one, exactly one, and zero-or-many respectively.

## PostgreSQL entities

```mermaid
erDiagram
    USERS {
        uuid id PK
        string google_subject UK "nullable"
        string email UK
        string display_name
        string picture "nullable"
        timestamp created_at
        timestamp updated_at
    }

    USER_SESSIONS {
        uuid id PK
        binary token_hash UK
        uuid user_id FK
        timestamp expires_at
        timestamp created_at
    }

    CLUBS {
        uuid id PK
        string name
        string city
        string header_logo "nullable"
        string card_logo "nullable"
        string language_code
        boolean best_move_enabled
        uuid created_by FK
        timestamp created_at
        timestamp updated_at
    }

    CLUB_MEMBERSHIPS {
        uuid club_id PK, FK
        uuid user_id PK, FK
        string role
        uuid access_player_id FK "nullable; composite access identity"
        timestamp created_at
    }

    DELETED_CLUBS {
        uuid club_id PK
        timestamp deleted_at
    }

    GAME_EVENTS {
        uuid club_id PK, FK
        uuid id PK
        uuid game_id "logical aggregate id"
        int sequence
        string idempotency_key
        string event_type
        string phase
        int seat "nullable"
        json payload
        uuid parent_event_id "nullable; logical event link"
        int replay_version
        int replay_sequence "nullable"
        string phase_after "nullable"
        int day_before "nullable"
        int day_after "nullable"
        string state_hash_after "nullable"
        timestamp created_at
    }

    DELETED_GAMES {
        uuid club_id PK, FK
        uuid game_id PK
        timestamp deleted_at
    }

    GAME_DAILY_COUNTERS {
        uuid club_id PK, FK
        date game_date PK
        int last_number
    }

    GAME_RULESETS {
        string id PK
        int version PK
        int player_count
        int sheriff_count
        int citizen_count
        int mafia_count
        int don_count
    }

    GAME_SESSIONS {
        uuid club_id PK, FK
        uuid id PK
        string ruleset_id FK
        int ruleset_version FK
        string name
        int revision
        uuid last_mutation_id
        json state
        json results "nullable"
        string status
        json initial_game "nullable"
        uuid replay_base_event_id "nullable; logical event link"
        uuid head_event_id "nullable; logical event link"
        uuid reset_return_event_id "nullable; logical event link"
        boolean reset_return_was_completed
        int replay_version
        timestamp created_at
        timestamp updated_at
    }

    GAME_SESSION_CREATIONS {
        uuid club_id PK, FK
        uuid creation_id PK
        uuid game_id "logical aggregate id; survives game deletion"
        timestamp created_at
    }

    GAME_SESSION_MUTATIONS {
        uuid club_id PK, FK
        uuid game_id PK, FK
        uuid mutation_id PK
        int revision
        json request "nullable"
    }

    PLAYERS {
        uuid id PK
        uuid club_id FK
        string nickname "null only when retired"
        string first_name "nullable"
        string last_name "nullable"
        string email "nullable"
        boolean data_processing_consent
        timestamp consent_at "nullable"
        string club_access "none, user, or manager"
        uuid user_id FK "nullable"
        timestamp created_at
        timestamp updated_at
        timestamp last_played_at "nullable"
        timestamp retired_at "nullable"
    }

    GAME_SESSION_PLAYERS {
        uuid club_id PK, FK
        uuid game_id PK, FK
        uuid player_id PK, FK
        int seat "nullable for host"
        boolean is_host
        string role "nullable before assignment and for host"
    }

    GAME_RESULTS {
        uuid club_id PK, FK
        uuid game_id PK
        string outcome "red, black, draw, or cancelled"
        string winner "nullable for draw or cancellation"
        string reason "required for draw or cancellation; otherwise null"
        timestamp played_at
        uuid host_player_id FK "nullable"
    }

    GAME_PLAYER_RESULTS {
        uuid club_id PK, FK
        uuid game_id PK, FK
        uuid player_id PK, FK
        int seat
        string role
        string team
        string final_status
        int fouls
        boolean won "nullable"
        int best_move_hits "nullable"
    }

    YOUTUBE_OAUTH_CREDENTIALS {
        uuid user_id PK, FK
        boolean singleton
        binary access_token_encrypted
        binary refresh_token_encrypted
        timestamp expires_at
        string account_label
        string scope
        timestamp updated_at
    }

    USERS ||..o{ USER_SESSIONS : authenticates
    USERS ||..o{ CLUBS : creates
    USERS ||--o{ CLUB_MEMBERSHIPS : joins
    CLUBS ||--o{ CLUB_MEMBERSHIPS : grants
    USERS o|..o{ PLAYERS : links_identity
    CLUBS ||..o{ PLAYERS : owns
    PLAYERS o|..o| CLUB_MEMBERSHIPS : access_identity
    USERS ||--o| YOUTUBE_OAUTH_CREDENTIALS : authorizes

    CLUBS ||--o{ GAME_EVENTS : isolates
    CLUBS ||--o{ DELETED_GAMES : tombstones
    CLUBS ||--o{ GAME_DAILY_COUNTERS : numbers
    CLUBS ||--o{ GAME_SESSIONS : owns
    GAME_RULESETS ||..o{ GAME_SESSIONS : governs
    CLUBS ||--o{ GAME_SESSION_CREATIONS : deduplicates_creation
    GAME_SESSIONS ||--o{ GAME_SESSION_MUTATIONS : deduplicates
    GAME_SESSIONS ||--o{ GAME_SESSION_PLAYERS : selects
    PLAYERS ||--o{ GAME_SESSION_PLAYERS : participates

    CLUBS ||--o{ GAME_RESULTS : records
    PLAYERS o|..o{ GAME_RESULTS : hosts
    GAME_RESULTS ||--o{ GAME_PLAYER_RESULTS : contains
    PLAYERS ||--o{ GAME_PLAYER_RESULTS : earns
```

### Physical-key notes

- Uppercase entity labels correspond directly to the lowercase SQL table names. All current tables and columns are shown. Solid relationships have their entire child-side foreign key inside the child's primary key; dashed relationships do not. Both represent declared SQL foreign keys, not inferred relationships.
- Club isolation is part of the composite keys and composite foreign keys for sessions, mutations, selected players, results, and player results. A matching `club_id` is therefore required across those relationships.
- `game_rulesets` contains the immutable fixed-ruleset identity used by current sessions. Each session has a required composite reference to the canonical `club-mafia` version `1` row; custom rulesets and historical ruleset snapshot behavior remain outside the current model.
- `game_session_players` is an internal relational projection of the authoritative session snapshot. Its composite keys enforce one row per player and one seated row per seat in each club/game. Database checks require hosts to have neither a seat nor a role, require non-hosts to have a seat, and restrict assigned roles to the canonical role vocabulary. A role may remain null before that seat draws a card.
- The full `game_sessions.state` snapshot remains the restorable authority. Event, player and result projections are rebuilt atomically from accepted snapshots; player projection rows are not automatically removed on completion. Virtual Casper has no physical player profile and is omitted from the player projection. These rows never form a separate public or sanitized session representation. Authenticated `manager` and `user` members receive the same complete session data; membership and club isolation control access.
- `club_memberships.access_player_id`, `club_id`, and `user_id` form a composite foreign key to the access player's `(id, club_id, user_id)` identity. `access_player_id` is nullable, making this relationship optional; its partial unique index limits a player to at most one linked membership. Membership roles are `manager` or `user`; a player's `club_access` may also be `none`.
- `players.id` is a permanent, globally unique identity belonging to one club, with `retired_at` marking profile retirement. Retired rows retain the ID but must have null nickname, personal fields, consent timestamp and user link, no consent, and `club_access = 'none'`. Active rows require a nonblank nickname. Historical participation and results reference these retained IDs, not copied profile names.
- Player uniqueness is club-scoped: normalized nickname among non-retired profiles, normalized email among profiles with club access, and linked user ID where present. These composite/partial indexes do not make individual columns globally unique. Personal fields and consent timestamps are required when consent is true and must be null otherwise.
- `game_session_creations` maps `(club_id, creation_id)` to a server-issued `game_id`. Only its club is a foreign key: the mapping intentionally survives game deletion so a retried creation cannot resurrect that game. It is deleted with the club.
- `game_results.outcome` is `red`, `black`, `draw`, or `cancelled`. Team outcomes require the matching winner and a null reason; draw/cancellation require a null winner and a nonblank trimmed reason. `game_player_results.won` is nullable. Host references are optional and club-scoped.
- `game_events` is an event store for both session and non-session game aggregates. `game_events.game_id` deliberately has no foreign key to `game_sessions`.
- `game_events.parent_event_id` and the three event IDs on `game_sessions` are logical replay links without SQL foreign keys, allowing retained branches and non-session aggregates. `game_sessions.last_mutation_id` is also a logical identifier, not a foreign key.
- `deleted_games.game_id` and `game_results.game_id` also identify game aggregates without foreign keys to `game_sessions`; only their club and downstream result relationships are physically enforced.
- `deleted_clubs` is an independent deletion marker, not a child of `clubs`; it must survive after the club row is gone. `deleted_games` remains physically scoped to an existing club.
- Important composite uniqueness rules not expressible as single-column `UK` markers include event sequence and idempotency per club/game, replay sequence per club/game, session mutation revision per club/game, and seat per club/game.

## Core game-domain entities

These entities are framework-independent TypeScript values. They are not additional SQL tables, and their identifiers are logical game/player/event identifiers rather than independent database constraints.

```mermaid
erDiagram
    PLAYER_INPUT {
        string id "logical player id"
        string name
        int seat
    }

    SETUP_STATE {
        string step "SetupStep"
        list players "PlayerInput[]"
        list roleDeck "Role[]"
        list remainingRoles "Role[]"
        map assignments "seat to Role"
    }

    PLAYER_STATE {
        string id "from PlayerInput"
        string name
        int seat
        string role "Role"
        string team "Team"
        string status "PlayerStatus"
        int fouls
        boolean mutePending
    }

    NOMINATION {
        int nominatorSeat
        int candidateSeat
        int order
    }

    SHOT_ASSIGNMENT {
        int shooterSeat
        int targetSeat
        boolean secret "always true"
    }

    GAME_STATE {
        string phase "GamePhase"
        int day
        list players "PlayerState[]"
        list turnOrder "seat[]"
        int currentTurnIndex
        list nominations "Nomination[]"
        map voteAssignments "voter to candidate"
        string votingCancellation "nullable"
        string votingRound "nullable"
        list carCrashSeats "nullable"
        map carCrashVotes "nullable"
        list goodbyeSeats "nullable"
        string goodbyeNext "nullable"
        map shotAssignments "shooter to target"
        string dayNotice "nullable"
        boolean redCardIssuedThisDay "nullable"
        string winner "Team or null"
    }

    BEST_MOVE_STATE {
        int playerSeat
        list selectedSeats "seat[]"
        int mafiaHits "nullable"
    }

    VOTE_RESULT {
        string kind
        list seats "seat[]"
        map totals "seat to votes"
    }

    CAR_CRASH_VOTE_RESULT {
        boolean eliminate
        list seats "seat[]"
        int yesVotes
        int eligibleVoters
    }

    NIGHT_SHOT_RESULT {
        string kind "kill, no-effect, or miss"
        int targetSeat "only kill or no-effect"
    }

    SECRET_CHECK_RESULT {
        string kind "don-check or sheriff-check"
        int targetSeat
        boolean match
        boolean secret "always true"
    }

    INITIAL_GAME_BASELINE {
        int replayVersion "currently 1"
        object game "GameState"
    }

    CANONICAL_EVENT_DRAFT {
        string type "CanonicalGameEventType"
        object payload "variant payload"
    }

    GAME_LOG_ENTRY {
        int replayVersion "currently 1"
        string id "logical event id"
        string gameId "logical aggregate id"
        int sequence
        string parentEventId "nullable"
        string type "CanonicalGameEventType"
        object payload "variant payload"
        string phaseBefore "GamePhase"
        string phaseAfter "GamePhase"
        int dayBefore
        int dayAfter
        string stateHashAfter
        timestamp createdAt
    }

    REPLAY_FRAME {
        object entry "GameLogEntry"
        object before "GameState"
        object after "GameState"
    }

    SETUP_STATE ||--o{ PLAYER_INPUT : selects
    PLAYER_INPUT ||--o| PLAYER_STATE : extended_as
    GAME_STATE ||--o{ PLAYER_STATE : contains
    GAME_STATE ||--o{ NOMINATION : records
    GAME_STATE ||--o| CAR_CRASH_VOTE_RESULT : stores
    GAME_STATE ||--o| NIGHT_SHOT_RESULT : stores
    GAME_STATE ||--o| SECRET_CHECK_RESULT : stores
    GAME_STATE ||--o| BEST_MOVE_STATE : stores
    INITIAL_GAME_BASELINE ||--|| GAME_STATE : captures
    CANONICAL_EVENT_DRAFT ||--|| GAME_LOG_ENTRY : enriched_as
    REPLAY_FRAME ||--|| GAME_LOG_ENTRY : replays
    REPLAY_FRAME ||--|| GAME_STATE : before
    REPLAY_FRAME ||--|| GAME_STATE : after
```

`Role`, `Team`, `SetupStep`, `PlayerStatus`, `GamePhase`, and `Winner` are discriminated scalar unions, so they appear as field types rather than fake entities. `votingCancellation` and `votingRound` are inline optional state variants. `VoteResult` and `ShotAssignment` are canonical event payload values; they are connected to their event variants below rather than stored directly in `GameState`.

## Canonical game events

A `CanonicalGameEventDraft` has exactly one of the following 18 variants. Mermaid ER has no XOR connector, so the optional variant edges below collectively mean “exactly one,” not 18 independent optional children.

```mermaid
erDiagram
    CANONICAL_EVENT_DRAFT {
        string type "exactly one canonical type"
        object payload
    }

    GAME_STARTED {
        string eventType "game.started"
        boolean secret "true"
    }

    GAME_CHECKPOINTED {
        string eventType "game.checkpointed"
        boolean secret "true"
    }

    PHASE_CHANGED {
        string eventType "phase.changed"
        string to "GamePhase"
        boolean secret "false"
    }

    TURN_COMPLETED {
        string eventType "turn.completed"
        int seat
        boolean secret "false"
    }

    PLAYER_NOMINATED {
        string eventType "player.nominated"
        int nominatorSeat
        int candidateSeat
        boolean secret "false"
    }

    FOUL_ISSUED {
        string eventType "foul.issued"
        int seat
        int foulNumber
        boolean redCarded
        string phase "optional with turn index"
        int currentTurnIndex "optional with phase"
        boolean secret "false"
    }

    PLAYER_RED_CARDED {
        string eventType "player.red-carded"
        int seat
        string phase "optional with turn index"
        int currentTurnIndex "optional with phase"
        boolean secret "false"
    }

    VOTING_SKIPPED {
        string eventType "voting.skipped"
        string reason "host-skipped"
        boolean secret "false"
    }

    VOTING_RESOLVED {
        string eventType "voting.resolved"
        map voteAssignments "voter to candidate"
        object result "VoteResult"
        boolean secret "false"
    }

    CAR_CRASH_RESOLVED {
        string eventType "car-crash.resolved"
        map votes "seat to boolean"
        object result "CarCrashVoteResult"
        boolean secret "false"
    }

    CAR_CRASH_BALLOT_RESOLVED {
        string eventType "car-crash.ballot-resolved"
        map votes "seat to boolean"
        object result "CarCrashVoteResult"
        boolean secret "false"
    }

    MAFIA_SHOTS_RESOLVED {
        string eventType "mafia.shots-resolved"
        list shots "ShotAssignment[]"
        object result "NightShotResult"
        boolean secret "true"
    }

    DON_CHECKED {
        string eventType "don.checked"
        int targetSeat
        boolean match
        boolean secret "true"
    }

    DON_CHECK_SKIPPED {
        string eventType "don.check-skipped"
        boolean secret "true"
    }

    SHERIFF_CHECKED {
        string eventType "sheriff.checked"
        int targetSeat
        boolean match
        boolean secret "true"
    }

    SHERIFF_CHECK_SKIPPED {
        string eventType "sheriff.check-skipped"
        boolean secret "true"
    }

    BEST_MOVE_COMPLETED {
        string eventType "best-move.completed"
        int playerSeat
        list selectedSeats "seat[]"
        int mafiaHits
        boolean secret "true"
    }

    GAME_COMPLETED {
        string eventType "game.completed"
        string winner "red or black"
        boolean secret "false"
    }

    VOTE_RESULT {
        string kind
        list seats
        map totals
    }

    CAR_CRASH_VOTE_RESULT {
        boolean eliminate
        list seats
        int yesVotes
        int eligibleVoters
    }

    SHOT_ASSIGNMENT {
        int shooterSeat
        int targetSeat
        boolean secret
    }

    NIGHT_SHOT_RESULT {
        string kind
        int targetSeat "conditional"
    }

    CANONICAL_EVENT_DRAFT ||--o| GAME_STARTED : variant
    CANONICAL_EVENT_DRAFT ||--o| GAME_CHECKPOINTED : variant
    CANONICAL_EVENT_DRAFT ||--o| PHASE_CHANGED : variant
    CANONICAL_EVENT_DRAFT ||--o| TURN_COMPLETED : variant
    CANONICAL_EVENT_DRAFT ||--o| PLAYER_NOMINATED : variant
    CANONICAL_EVENT_DRAFT ||--o| FOUL_ISSUED : variant
    CANONICAL_EVENT_DRAFT ||--o| PLAYER_RED_CARDED : variant
    CANONICAL_EVENT_DRAFT ||--o| VOTING_SKIPPED : variant
    CANONICAL_EVENT_DRAFT ||--o| VOTING_RESOLVED : variant
    CANONICAL_EVENT_DRAFT ||--o| CAR_CRASH_RESOLVED : variant
    CANONICAL_EVENT_DRAFT ||--o| CAR_CRASH_BALLOT_RESOLVED : variant
    CANONICAL_EVENT_DRAFT ||--o| MAFIA_SHOTS_RESOLVED : variant
    CANONICAL_EVENT_DRAFT ||--o| DON_CHECKED : variant
    CANONICAL_EVENT_DRAFT ||--o| DON_CHECK_SKIPPED : variant
    CANONICAL_EVENT_DRAFT ||--o| SHERIFF_CHECKED : variant
    CANONICAL_EVENT_DRAFT ||--o| SHERIFF_CHECK_SKIPPED : variant
    CANONICAL_EVENT_DRAFT ||--o| BEST_MOVE_COMPLETED : variant
    CANONICAL_EVENT_DRAFT ||--o| GAME_COMPLETED : variant

    VOTING_RESOLVED ||--|| VOTE_RESULT : includes
    CAR_CRASH_RESOLVED ||--|| CAR_CRASH_VOTE_RESULT : includes
    CAR_CRASH_BALLOT_RESOLVED ||--|| CAR_CRASH_VOTE_RESULT : includes
    MAFIA_SHOTS_RESOLVED ||--|{ SHOT_ASSIGNMENT : includes
    MAFIA_SHOTS_RESOLVED ||--|| NIGHT_SHOT_RESULT : includes
```

| Event type                  | Payload                                                           | Visibility |
| --------------------------- | ----------------------------------------------------------------- | ---------- |
| `game.started`              | Empty                                                             | Secret     |
| `game.checkpointed`         | Empty                                                             | Secret     |
| `phase.changed`             | Destination phase                                                 | Public     |
| `turn.completed`            | Seat                                                              | Public     |
| `player.nominated`          | Nominator and candidate seats                                     | Public     |
| `foul.issued`               | Seat, foul number, red-card flag, and optional discipline context | Public     |
| `player.red-carded`         | Seat and optional discipline context                              | Public     |
| `voting.skipped`            | Host-skipped reason                                               | Public     |
| `voting.resolved`           | Vote assignments and `VoteResult`                                 | Public     |
| `car-crash.resolved`        | Votes and `CarCrashVoteResult`                                    | Public     |
| `car-crash.ballot-resolved` | Votes and `CarCrashVoteResult`                                    | Public     |
| `mafia.shots-resolved`      | Secret shot assignments and `NightShotResult`                     | Secret     |
| `don.checked`               | Target seat and match result                                      | Secret     |
| `don.check-skipped`         | Empty                                                             | Secret     |
| `sheriff.checked`           | Target seat and match result                                      | Secret     |
| `sheriff.check-skipped`     | Empty                                                             | Secret     |
| `best-move.completed`       | Player seat, selected seats, and Mafia hit count                  | Secret     |
| `game.completed`            | Winning team                                                      | Public     |

Provisional interactions such as individual vote assignment/removal, voting candidate advancement, car-crash vote assignment, Mafia shot recording, and `setup.*`, `timer.*`, or `music.*` events are not canonical durable game events.

## Persistence-to-domain mapping

| Persistence field(s)                                                                      | Domain meaning                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `game_sessions.state`                                                                     | Revisioned current-format `StoredGameSessionState`; contains setup metadata, the current `GameState`, selected host/playlist data, current activity log, and explicit replay metadata. |
| `game_sessions.initial_game`                                                              | The immutable `InitialGameBaseline` used as the replay starting state.                                                                                                                 |
| `game_sessions.results`                                                                   | Completed-game projection used to materialize `game_results` and `game_player_results`.                                                                                                |
| `game_events.event_type` + `game_events.payload`                                          | Current canonical event discriminator and variant payload with complete replay metadata. Historical raw-event mutation endpoints are not supported.                                    |
| `game_events.parent_event_id`                                                             | Logical parent link for retained replay branches.                                                                                                                                      |
| `game_events.replay_sequence`, phase/day fields, `replay_version`, and `state_hash_after` | Canonical ordering and deterministic replay-integrity metadata.                                                                                                                        |
| `game_sessions.state`                                                                     | Authoritative full browser snapshot, including current `GameState`, semantic event prefix, and Undo allowance.                                                                         |
| `game_sessions.replay_base_event_id`                                                      | Compatibility mirror of the snapshot's semantic-history root.                                                                                                                          |
| `game_sessions.head_event_id`                                                             | Compatibility mirror of the snapshot's retained semantic-history head; it does not override `state.game`.                                                                              |
| `game_sessions.reset_return_event_id`                                                     | Retired compatibility column; browser-authoritative snapshots keep it null and expose no Reset Return.                                                                                 |

PostgreSQL mirrors the last uploaded valid current-format browser snapshot and its exact semantic event prefix. Domain replay follows the retained parent chain to validate phase/day transitions and SHA-256 hashes for Log/Timeline integrity, but the snapshot's `state.game` remains the current gameplay authority. Historical hashes, event-shape adapters, snapshot normalization, and fallback hydration are unsupported. The field named `legacyLog` still carries current setup/activity entries; it is not an importer for old histories.
