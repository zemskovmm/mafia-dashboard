# Player Profiles, Statistics, and Account Music Implementation Plan

> **For Hermes:** Implement task-by-task with strict TDD and verify PostgreSQL migrations against fresh and populated databases.

**Goal:** Add a separate persistent Players & Statistics area, replace setup name inputs with sorted nickname dropdowns, save final per-player game outcomes, and add a supported path for selecting the host's account playlists.

**Architecture:** PostgreSQL becomes the source of truth for player profiles and finalized game results. Fastify exposes profile/statistics/result endpoints; React adds a separate Players view and consumes the same ordered profile list in setup. Google account playlist selection will use OAuth 2.0 authorization code flow on the backend, while playback remains in the required visible YouTube IFrame player because Google exposes no embeddable YouTube Music player API.

**Tech Stack:** PostgreSQL 17, Fastify, Zod, React/Vite, Vitest/Testing Library, YouTube Data API v3, Google Identity Services OAuth 2.0.

---

## Confirmed product decisions

- A player's nickname is always required and case-insensitively unique.
- Without data-processing consent, only the nickname is stored; first name, last name, and email must remain empty.
- With consent, first name, last name, and email are all required.
- Setup offers ten nickname dropdowns ordered by `last_played_at DESC NULLS LAST`, then nickname alphabetically.
- The Players & Statistics section is separate from live game setup/play.
- Initial statistics: games played, wins/losses/win rate, red/black games and wins, role counts, total fouls, eliminations, red cards, and last played.
- YouTube Music playlists appear in the same account's YouTube library, so an authorized YouTube Data API request can list owned playlists.
- Playback must remain in a visible YouTube IFrame player. Hiding the player or providing audio-only/background YouTube playback is not supported by policy.
- Google OAuth on an iPad requires an HTTPS redirect origin. The current LAN HTTP origin is unsuitable; Tailscale HTTPS is the preferred local/private deployment path.

## Task 1: Record requirements and migration contract

**Files:**

- Modify: `docs/product-outline.md`
- Modify: `README.md`

1. Add the Players & Statistics information architecture, profile validation, sort order, and initial stat definitions.
2. Replace the YouTube-login non-goal with the supported OAuth playlist-picker boundary.
3. Document that account OAuth requires HTTPS and credentials, while playlist-ID playback remains available without account authorization.

## Task 2: Add persistent player and result schema

**Files:**

- Modify: `apps/server/src/schema.sql`
- Create: `apps/server/src/player-store.ts`
- Create: `apps/server/src/player-store.test.ts`

1. Write failing integration tests for consent validation storage shape, case-insensitive nickname uniqueness, ordered listing, idempotent final-result saving, and aggregate statistics.
2. Add `players`, `game_results`, and `game_player_results` tables with constraints and indexes.
3. Implement profile CRUD/list and atomic result upsert/stat aggregation.
4. Run the tests on a fresh PostgreSQL database and rerun initialization to prove idempotency.
5. Run against the current populated Compose database and verify existing `game_events` remain unchanged.

## Task 3: Expose player/statistics APIs

**Files:**

- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/app.test.ts`

1. Write failing API tests for list/create/update profiles and save results.
2. Add strict Zod schemas implementing the confirmed consent rule.
3. Return ordered profiles with aggregated statistics.
4. Map duplicate nickname conflicts to HTTP 409 and validation errors to HTTP 400.
5. Add idempotent `PUT /api/games/:gameId/results`.

## Task 4: Add typed web API client

**Files:**

- Modify: `apps/web/src/api/client.ts`

1. Add `PlayerProfile`, `PlayerStatistics`, and final-result request types.
2. Add list/create/update profile and save-game-results functions.
3. Keep all APIs same-origin for LAN/Tailscale deployment.

## Task 5: Build the separate Players & Statistics view

**Files:**

- Create: `apps/web/src/features/players/PlayersScreen.tsx`
- Create: `apps/web/src/features/players/PlayersScreen.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles/app.css`

1. Write failing component tests for create/edit behavior, consent-dependent fields, error retention, and statistics rendering.
2. Add top-level Game / Players & Statistics navigation.
3. Render editable player cards with nickname, consent, personal fields, and stats.
4. Clear personal fields when consent is unchecked.
5. Refresh the shared profile list after a successful save.

## Task 6: Replace setup inputs with ordered nickname dropdowns

**Files:**

- Modify: `apps/web/src/features/setup/SetupWizard.tsx`
- Modify: `apps/web/src/features/setup/SetupWizard.test.tsx`
- Modify: `scripts/verify-ui.mjs`

1. Write failing tests for ten dropdowns, no duplicate selections, and empty-list guidance.
2. Pass ordered profiles from `App` into setup.
3. Map selected persistent profile IDs/nicknames to seats 1–10.
4. Update browser verification to create/select test profiles through the API.

## Task 7: Save final game results and refresh statistics

**Files:**

- Modify: `apps/web/src/App.tsx`
- Add/update focused tests around final-result submission.

1. Submit one result row per player when a game reaches `finished`.
2. Include role, team, final status, foul count, winner, and seat.
3. Make retries safe by using the game ID/player ID primary key.
4. Refresh player statistics after a successful save.

## Task 8: Add account playlist authorization

**Files likely to change:**

- Modify: `.env.example`
- Modify: `compose.yaml`
- Modify: `apps/server/src/config.ts`
- Create: `apps/server/src/youtube-oauth.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/web/src/features/music/YouTubePlaylistPlayer.tsx`
- Modify: `apps/web/src/features/setup/SetupWizard.tsx`

1. Start Tailscale and configure a private HTTPS origin/Serve proxy for port 8080.
2. Create/configure a Google Cloud Web OAuth client and enable YouTube Data API v3.
3. Add backend code-flow endpoints with CSRF state, secure refresh-token storage, revocation, and least-privilege YouTube scopes.
4. List `mine=true` playlists and let the host select one.
5. Keep the visible YouTube IFrame for playback and retain native controls.
6. Verify on iPad through the HTTPS Tailscale URL with a real user gesture and physical Google consent.

**External prerequisite:** Task 8 cannot be live-verified until the Google OAuth client ID/secret exist and the user completes Google consent. Never commit those credentials or refresh tokens.

## Final verification

- `npm run check`
- `git diff --check`
- Fresh PostgreSQL schema/read/write/stat aggregation probe
- Populated Compose upgrade preserving existing event count
- `docker compose up --build --detach`
- LAN and Tailscale health checks
- `npm run verify:ui`
- iPad setup/player/statistics smoke test
- Real Google account playlist listing and playback only after explicit user consent

## Official references

- YouTube IFrame Player API: https://developers.google.com/youtube/iframe_api_reference
- YouTube required minimum functionality: https://developers.google.com/youtube/terms/required-minimum-functionality
- YouTube developer policies: https://developers.google.com/youtube/terms/developer-policies
- List authenticated user's playlists: https://developers.google.com/youtube/v3/docs/playlists/list
- Google Identity Services code model: https://developers.google.com/identity/oauth2/web/guides/use-code-model
- OAuth redirect validation: https://developers.google.com/identity/protocols/oauth2/web-server
- YouTube Music playlist/library behavior: https://support.google.com/youtubemusic/answer/7205933
