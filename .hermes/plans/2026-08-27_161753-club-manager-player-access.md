# Club Manager Player Access Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Let a club manager mark consented player profiles as “Club manager,” automatically create a protected `Owner` manager profile for each club creator, and make managed clubs appear on the matching Google user’s welcome screen.

**Architecture:** Keep player profiles as the source of manager invitations, linked to application users by verified, case-insensitive email. A linked manager gets a `club_memberships` row, so the existing `GET /api/clubs` query automatically exposes the club on the welcome screen; an unlinked manager is claimed on the first Google sign-in using the same verified email. The creator remains the destructive `owner`; additional club managers receive the existing safer `editor` role, which grants normal club/game/player access but not club deletion.

**Tech Stack:** PostgreSQL 17 schema migrations, Fastify 5, TypeScript 6, Zod 4, React 19, Vitest, Testing Library.

---

## Current context and decisions

- `club_memberships` already drives welcome-screen visibility in `apps/server/src/club-store.ts:45-55`.
- Membership roles are already `owner | editor`; only `owner` can delete a club, while both can edit it (`apps/server/src/club-store.ts:99-159`).
- Players already require consent before storing an email (`apps/server/src/schema.sql:495-527` and `apps/server/src/app.ts:65-80`).
- Google authentication supplies a verified email and display name (`apps/server/src/google-auth.ts:28-34`).
- Player routes are already tenant-scoped through `x-club-id` and membership checks (`apps/server/src/app.ts:277-291`, `495-572`).
- The working tree is already dirty, including `apps/web/src/App.tsx` and `apps/web/src/App.test.tsx`. Preserve those unrelated edits, patch only manager-related hunks, and review `git diff` before every commit/checkpoint.
- No invitation email is sent. “Add a new person” means creating/updating a consented player with `clubManager: true` and the exact Google-account email; the person sees the club after signing in with that verified email.
- Recommended privilege rule: the creator keeps `owner`; invited club managers receive `editor`. If co-managers must also be able to delete the entire club, change the planned grant role from `editor` to `owner` before implementation.
- The creator’s generated profile uses nickname `Owner`, consent enabled, and the verified Google email. Split the Google display name at the first whitespace for first/last name storage; for a one-word display name, use that value for both required fields. The profile remains editable, but its manager flag and deletion are protected so the club cannot be orphaned.
- Existing clubs must be migrated: reuse a consented player whose email matches the creator if one exists; otherwise backfill one deterministic `Owner` profile. New clubs are handled transactionally at creation time.

## Data invariants

Add these invariants to `players`:

```sql
is_club_manager BOOLEAN NOT NULL DEFAULT FALSE,
user_id UUID NULL REFERENCES users (id) ON DELETE SET NULL,
CONSTRAINT players_manager_requires_consent_ck CHECK (
  NOT is_club_manager
  OR (data_processing_consent AND email IS NOT NULL AND BTRIM(email) <> '')
)
```

Add partial unique indexes after legacy backfill:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS players_club_manager_email_unique_idx
  ON players (club_id, LOWER(BTRIM(email)))
  WHERE is_club_manager;

CREATE UNIQUE INDEX IF NOT EXISTS players_club_linked_user_unique_idx
  ON players (club_id, user_id)
  WHERE user_id IS NOT NULL;
```

Manager-to-membership behavior:

```text
creator Owner player     -> linked user + membership role owner; cannot be demoted/deleted
other linked manager     -> linked user + membership role editor
pending manager          -> manager=true, user_id=null; claimed at matching Google sign-in
manager demotion/delete  -> remove only an editor membership created by that player
owner membership         -> never downgraded or removed by player editing
```

## Task 1: Add an idempotent manager schema migration

**Objective:** Persist manager state and user linkage safely on fresh and populated databases.

**Files:**
- Modify: `apps/server/src/schema.sql:495-550`
- Modify/Test: `apps/server/src/schema-migration.test.ts`

**Step 1: Write the failing migration test**

Extend the isolated-schema test to create a legacy club creator plus an existing consented matching player, run `initializeSchema()` twice, and assert:

```ts
expect(managerColumns.rows[0]).toMatchObject({
  is_club_manager: true,
  user_id: legacyOwnerId,
});
expect(managerConstraints).toEqual(
  expect.arrayContaining([
    expect.objectContaining({ indexname: "players_club_manager_email_unique_idx" }),
    expect.objectContaining({ indexname: "players_club_linked_user_unique_idx" }),
  ]),
);
```

Also add a club with no matching profile and assert exactly one consented `Owner` player is inserted and remains exactly one after the second schema run.

**Step 2: Run the test to verify RED**

Run:

```bash
npm run test -w @mafia/server -- src/schema-migration.test.ts
```

Expected: FAIL because manager columns, constraints, indexes, and creator backfill do not exist.

**Step 3: Implement the migration**

In `schema.sql`:

1. Add `is_club_manager` and `user_id` to the fresh `CREATE TABLE players` definition.
2. Add both columns with `ADD COLUMN IF NOT EXISTS` for existing databases.
3. Add the FK/check constraints inside guarded `DO $$ ... $$` blocks so repeated initialization is safe.
4. Mark one existing consented matching player per creator using `LOWER(BTRIM(player.email)) = LOWER(BTRIM(app_user.email))` and deterministic ordering.
5. Backfill missing creator profiles with deterministic IDs based on club ID, nickname `Owner` unless that nickname is already taken in the club, consent timestamp from club creation, the creator email, and a deterministic first/last-name split.
6. Upsert/preserve the creator’s `owner` membership.
7. Create the partial unique indexes only after the backfill.

Do not alter existing non-manager profiles or game/statistics rows.

**Step 4: Run the test to verify GREEN**

Run the same command. Expected: PASS with fresh and populated schemas and two idempotent schema applications.

**Step 5: Checkpoint**

Review only:

```bash
git diff -- apps/server/src/schema.sql apps/server/src/schema-migration.test.ts
```

If Michael requests commits, commit this isolated migration as `feat: add club manager player schema`; otherwise keep it uncommitted.

## Task 2: Create the club creator’s protected Owner profile

**Objective:** Make new-club creation atomically insert the club, owner membership, and generated manager player.

**Files:**
- Create/Test: `apps/server/src/club-store.test.ts`
- Modify: `apps/server/src/club-store.ts:6-97`
- Modify: `apps/server/src/app.ts:371-377`

**Step 1: Write a failing ClubStore integration test**

Create a user fixture and call the wished-for API:

```ts
const club = await store.create(
  {
    id: creatorId,
    email: "creator@example.test",
    name: "Ada Lovelace",
    picture: null,
  },
  { name: "Mafia London", city: "London", headerLogo: null, cardLogo: null },
);
```

Assert in one database read that:

- the club has an `owner` membership for `creatorId`;
- exactly one player has nickname `Owner`;
- the player has consent, `creator@example.test`, `is_club_manager = true`, and `user_id = creatorId`;
- `PlayerStore.list(club.id)` returns `clubManager: true` and `managerLocked: true`.

**Step 2: Run RED**

```bash
npm run test -w @mafia/server -- src/club-store.test.ts
```

Expected: FAIL because `ClubStore.create` accepts only a user ID and does not create a player.

**Step 3: Implement the minimal transactional creation path**

Change `ClubStore.create` to accept `AppUser`, derive the required profile names with a small pure helper, and insert all three records before commit:

```ts
public async create(user: AppUser, input: ClubInput): Promise<Club>
```

Use the same transaction/client already present. Keep the membership role `owner`; insert the generated player with `randomUUID()`, nickname `Owner`, verified user email, consent timestamp `NOW()`, `is_club_manager = TRUE`, and `user_id = user.id`.

Update `POST /api/clubs` to pass `user`, not `user.id`.

**Step 4: Run GREEN**

Run the focused test and then:

```bash
npm run test -w @mafia/server -- src/app.test.ts -t "creates a club"
```

Expected: both PASS; update the existing API assertion so the new club players include the generated Owner profile before any manually added player.

**Step 5: Checkpoint**

Review `club-store.ts`, its new test, and the small route change. Commit only if explicitly requested.

## Task 3: Claim pending manager invitations during Google sign-in

**Objective:** Turn a manager player’s email into a welcome-screen membership as soon as that Google user signs in.

**Files:**
- Modify/Test: `apps/server/src/club-store.test.ts`
- Modify: `apps/server/src/club-store.ts`
- Modify/Test: `apps/server/src/app.test.ts:778-836`
- Modify: `apps/server/src/app.ts:317-345`

**Step 1: Write failing store and callback tests**

Store-level scenario:

1. Create a club and a consented pending manager player for `new.manager@example.test` with `user_id = NULL`.
2. Insert the corresponding application user.
3. Call:

```ts
await store.claimManagerClubs(newUser.id, newUser.email);
```

4. Assert the player is linked, an `editor` membership exists, and `listForUser(newUser.id)` returns the club.
5. Call the method twice and assert one player link and one membership remain.

Callback scenario: after mocked `completeAuthorization()` returns the new user, assert the callback invokes/reaches claim logic before redirecting; a subsequent `GET /api/clubs` for that user includes the invited club.

**Step 2: Run RED**

```bash
npm run test -w @mafia/server -- src/club-store.test.ts src/app.test.ts -t "manager|Google sign-in"
```

Expected: FAIL because no claim operation exists.

**Step 3: Implement claim semantics**

Add `ClubStore.claimManagerClubs(userId, verifiedEmail)` using one transaction:

- lock matching `is_club_manager` players by normalized email;
- reject/skip a row already linked to a different user rather than stealing it;
- set `user_id` for unlinked rows;
- insert memberships as `editor`;
- on membership conflict, preserve `owner` and otherwise set `editor`;
- be idempotent.

Call it immediately after `googleAuth.completeAuthorization()` and before setting the session cookie/redirect. This keeps membership concerns out of `GoogleAuthService` while guaranteeing that the first welcome load sees the club.

**Step 4: Run GREEN**

Repeat the focused test command. Expected: PASS, including idempotent re-login.

**Step 5: Checkpoint**

Review that email comparison is case-insensitive and that an existing `owner` role can never be downgraded.

## Task 4: Make PlayerStore synchronize manager state and memberships

**Objective:** Create, promote, edit, demote, and delete manager players without stale access or cross-club effects.

**Files:**
- Modify/Test: `apps/server/src/player-store.test.ts`
- Modify: `apps/server/src/player-store.ts:11-230`, `232-341`

**Step 1: Add one failing vertical-slice test at a time**

Add focused tests in this order:

1. Creating a manager whose email already exists in `users` links `user_id` and grants one `editor` membership.
2. Creating a manager for an unknown email stores a pending manager with no membership.
3. Promoting an existing consented player grants/queues access.
4. Changing a pending manager email allows the newly matching user to claim it and does not retain stale linkage.
5. Demoting a non-creator manager clears `user_id` and removes only the matching `editor` membership.
6. Deleting a non-creator manager removes the `editor` membership in the same transaction.
7. Demoting or deleting the creator’s locked Owner profile returns `manager_locked` and leaves owner access intact.
8. All operations remain scoped by `club_id` when the same email exists in another club.

For each case: write the single test, run it and observe the expected failure, implement only that behavior, rerun to green, then proceed.

**Step 2: Extend the public contracts**

Use these shapes:

```ts
export interface PlayerProfileInput {
  readonly nickname: string;
  readonly consent: boolean;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly email: string | null;
  readonly clubManager: boolean;
}

export interface PlayerProfile extends PlayerProfileInput {
  readonly managerLocked: boolean;
  // existing fields unchanged
}
```

Extend `profileSelect` to return `is_club_manager` and derive `manager_locked` by joining the club and checking that the linked player user is the club creator.

**Step 3: Make profile mutation transactional**

Convert manager-sensitive create/update paths to use a checked-out client and transaction. Use a private helper that:

- looks up a user by normalized email when `clubManager` is true;
- sets/clears `players.user_id`;
- grants `editor` while preserving `owner`;
- removes only `editor` on demotion;
- never removes creator ownership.

Keep existing nickname conflict behavior and statistics selection unchanged.

Extend deletion’s return union:

```ts
Promise<"deleted" | "not_found" | "active_game" | "manager_locked">
```

Remove an editor membership before deleting a non-creator linked manager. Preserve all existing game-history locking and deletion order.

**Step 4: Run focused tests**

```bash
npm run test -w @mafia/server -- src/player-store.test.ts
```

Expected: PASS with existing statistics/deadlock tests unchanged.

**Step 5: Checkpoint**

Inspect transaction rollback paths, lock ordering, club scoping, and membership role preservation before moving to HTTP wiring.

## Task 5: Validate and expose manager state through the HTTP API

**Objective:** Make the API reject invalid manager profiles and return stable conflict codes for protected creator profiles.

**Files:**
- Modify/Test: `apps/server/src/app.test.ts:406-608`
- Modify: `apps/server/src/app.ts:58-80`, `495-572`

**Step 1: Write failing endpoint tests**

Add cases for:

```ts
// Invalid: manager requires consent and verified-shaped email data.
{
  nickname: "Pending",
  consent: false,
  firstName: null,
  lastName: null,
  email: null,
  clubManager: true,
}
```

Expected `400 validation_failed`.

Also verify:

- valid manager create/update responses include `clubManager` and `managerLocked`;
- creator manager demotion and deletion return `409 { error: "manager_locked" }`;
- omitted `clubManager` is accepted as `false` for backward compatibility with older clients/outbox-free requests;
- manager email conflicts produce a distinct `409 { error: "manager_email_conflict" }`, while nickname conflicts remain `nickname_conflict`.

**Step 2: Run RED**

```bash
npm run test -w @mafia/server -- src/app.test.ts -t "manager|consent|player"
```

**Step 3: Implement schema and error mapping**

Add `clubManager: z.boolean().default(false)` to both consent branches, then add a refinement that prevents manager=true on the no-consent branch. Distinguish PostgreSQL unique constraint names when mapping `23505`, so the manager-email partial index does not masquerade as a nickname conflict. Map `PlayerStore.delete(...)=manager_locked` to HTTP 409.

**Step 4: Run GREEN**

Repeat the focused command, then run all server tests:

```bash
npm run test -w @mafia/server
```

Expected: PASS with no warnings or leaked database handles.

## Task 6: Extend the web API contract

**Objective:** Carry manager state through TypeScript types and player requests without changing unrelated client behavior.

**Files:**
- Modify/Test: `apps/web/src/api/client.test.ts:39-166`
- Modify: `apps/web/src/api/client.ts:23-77`, `347-389`

**Step 1: Write failing client assertions**

Extend the fixture:

```ts
const player = {
  // existing fields
  clubManager: false,
  managerLocked: false,
};
```

Assert create and update JSON bodies include `clubManager`, and list responses preserve both manager fields.

**Step 2: Run RED**

```bash
npm run test -w @mafia/web -- src/api/client.test.ts
```

**Step 3: Update client types**

Add `clubManager` to both branches of `PlayerProfileInput`; add `clubManager` and `managerLocked` to `PlayerProfile`. Keep URLs, headers, and error handling unchanged.

**Step 4: Run GREEN**

Repeat the focused client test. Expected: PASS.

## Task 7: Add the Club manager control to player forms

**Objective:** Let managers select the role from the Players menu while making its consent/email dependency and creator protection clear.

**Files:**
- Modify/Test: `apps/web/src/features/players/PlayersScreen.test.tsx`
- Modify: `apps/web/src/features/players/PlayersScreen.tsx:14-53`, `72-152`, `154-303`
- Modify: `apps/web/src/styles/app.css:505-575`, responsive block near `3360-3369`

**Step 1: Write the failing UI tests**

Add vertical tests for:

1. New-player form renders a checkbox named `New player Club manager`.
2. Checking it also enables data-processing consent and makes first name, last name, and email required.
3. Submitting sends `clubManager: true` with normalized personal fields.
4. Unchecking consent also clears `clubManager` and personal data.
5. Existing manager cards render a visible “Club manager” state/badge.
6. A locked creator checkbox remains checked and disabled with guidance; its delete button is disabled even when no game protects it.
7. A normal manager can be demoted and submits `clubManager: false`.

Update the shared `profile()` fixture with `clubManager: false` and `managerLocked: false` so existing tests remain explicit.

**Step 2: Run RED**

```bash
npm run test -w @mafia/web -- src/features/players/PlayersScreen.test.tsx
```

**Step 3: Implement the minimal form behavior**

Extend `ProfileDraft` and `draftFromPlayer`. In `toInput`, force `clubManager: false` when consent is false. Add a checkbox styled like the consent control:

```tsx
<label className="consent-field" htmlFor={`${idPrefix}-club-manager`}>
  <input
    id={`${idPrefix}-club-manager`}
    aria-label={`${labelPrefix} Club manager`}
    type="checkbox"
    checked={draft.clubManager}
    disabled={managerLocked}
    onChange={(event) =>
      update({
        clubManager: event.currentTarget.checked,
        consent: event.currentTarget.checked ? true : draft.consent,
      })
    }
  />
  Club manager
</label>
```

Pass `managerLocked` into `ProfileFields` for existing cards and `false` for the create form. When consent is unchecked, clear manager plus personal fields. Reuse the existing 44px touch targets and grid; add only the CSS needed for a fifth/sixth field and lock guidance.

For deletion, combine active-game and manager-lock protection into one explicit blocked reason so screen-reader guidance and `title` stay accurate.

**Step 4: Run GREEN**

Repeat the focused test. Expected: PASS.

**Step 5: Checkpoint**

At desktop and iPad widths, verify the added control does not cause document scrolling outside `.players-shell`; preserve the project’s fullscreen/table geometry.

## Task 8: Wire manager profile refreshes through ClubWorkspace

**Objective:** Ensure create/update responses refresh the players and manager state without disturbing existing club/game state.

**Files:**
- Modify/Test: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/App.tsx:1145-1173`, `1972-1990`

**Step 1: Write failing integration tests**

In the ClubWorkspace test harness:

- provide manager-aware `PlayerProfile` fixtures;
- promote a player in the rendered Players screen;
- assert `api.updatePlayer` receives the selected club ID and `clubManager: true`;
- resolve the subsequent `listPlayers` call with the updated manager and assert the badge/control refreshes;
- verify creating a manager similarly calls `createPlayer(input, testClub.id)`.

For the welcome app, keep the existing create/open test and add an API contract assertion that any club returned by `listClubs()`—including an `editor` membership claimed by email—is rendered as a playable card. The server test proves how that list is populated; the web test proves the welcome rendering remains role-agnostic.

**Step 2: Run RED**

```bash
npm run test -w @mafia/web -- src/App.test.tsx -t "manager|welcome|club"
```

**Step 3: Apply the smallest wiring changes**

Most callbacks already pass `club.id` and refresh players. Update only changed manager types/fixtures and any deletion guidance props required by Task 7; do not refactor the 2,000-line component or unrelated game logic.

**Step 4: Run GREEN**

Repeat the focused test command. Expected: PASS.

**Step 5: Preserve existing work**

Because `App.tsx` and `App.test.tsx` were modified before this plan, inspect only manager-related hunks and compare against the pre-implementation `git status` before proceeding.

## Task 9: Format, verify, and manually exercise the two-account flow

**Objective:** Prove schema safety, API behavior, UI behavior, and welcome-screen access end to end.

**Files:**
- Verify all touched files; no new production files beyond those listed above.

**Step 1: Format only touched files**

Run Prettier against the explicit touched-file list, not the whole dirty repository:

```bash
npx prettier --write \
  apps/server/src/schema.sql \
  apps/server/src/schema-migration.test.ts \
  apps/server/src/club-store.ts \
  apps/server/src/club-store.test.ts \
  apps/server/src/player-store.ts \
  apps/server/src/player-store.test.ts \
  apps/server/src/app.ts \
  apps/server/src/app.test.ts \
  apps/web/src/api/client.ts \
  apps/web/src/api/client.test.ts \
  apps/web/src/features/players/PlayersScreen.tsx \
  apps/web/src/features/players/PlayersScreen.test.tsx \
  apps/web/src/App.tsx \
  apps/web/src/App.test.tsx \
  apps/web/src/styles/app.css
```

Expected: only intended manager-related formatting changes.

**Step 2: Run focused suites**

```bash
npm run test -w @mafia/server -- \
  src/schema-migration.test.ts \
  src/club-store.test.ts \
  src/player-store.test.ts \
  src/app.test.ts

npm run test -w @mafia/web -- \
  src/api/client.test.ts \
  src/features/players/PlayersScreen.test.tsx \
  src/App.test.tsx
```

Expected: all PASS.

**Step 3: Run project gates**

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run build
```

Expected: all exit 0. Server tests require the documented PostgreSQL test database at `127.0.0.1:54329/mafia_test` or an explicit `TEST_DATABASE_URL`.

**Step 4: Verify the real UI with two Google accounts**

On the running app:

1. Sign in as account A and create a new club.
2. Open Players and verify a consented, locked `Owner` manager profile exists with account A’s Google email.
3. Add account B as a consented player, check `Club manager`, and save.
4. Sign out A, sign in as B using the exact saved email, and verify the club card appears under “Available clubs.”
5. Open the club as B; verify players/game management works and `Delete club` is absent because B is an `editor` manager.
6. Sign back in as A, demote B, then verify B no longer receives the club after signing in/reloading.
7. Re-promote B to verify idempotent re-linking and no duplicate membership/player rows.
8. Verify an email mismatch does not expose the club.

**Step 5: Final diff audit**

```bash
git status --short
git diff --check
git diff -- \
  apps/server/src/schema.sql \
  apps/server/src/club-store.ts \
  apps/server/src/player-store.ts \
  apps/server/src/app.ts \
  apps/web/src/api/client.ts \
  apps/web/src/features/players/PlayersScreen.tsx \
  apps/web/src/App.tsx \
  apps/web/src/styles/app.css
```

Confirm no unrelated pre-existing game/event changes were reformatted or overwritten. Commit only after Michael accepts the behavior.

## Files likely to change

| Path | Purpose |
|---|---|
| `apps/server/src/schema.sql` | Manager columns, constraints, indexes, creator backfill |
| `apps/server/src/schema-migration.test.ts` | Fresh/legacy/idempotent migration coverage |
| `apps/server/src/club-store.ts` | Atomic creator Owner profile and sign-in claim logic |
| `apps/server/src/club-store.test.ts` | Club creation, pending claim, role preservation tests |
| `apps/server/src/player-store.ts` | Manager fields and membership synchronization |
| `apps/server/src/player-store.test.ts` | Promotion/demotion/deletion/tenant tests |
| `apps/server/src/app.ts` | Validation, callback claim, conflict mapping |
| `apps/server/src/app.test.ts` | End-to-end API and Google callback coverage |
| `apps/web/src/api/client.ts` | Manager-aware player contracts |
| `apps/web/src/api/client.test.ts` | Request/response contract tests |
| `apps/web/src/features/players/PlayersScreen.tsx` | Club manager control and lock guidance |
| `apps/web/src/features/players/PlayersScreen.test.tsx` | Form/consent/protection behavior tests |
| `apps/web/src/App.tsx` | Minimal manager profile refresh wiring |
| `apps/web/src/App.test.tsx` | ClubWorkspace/welcome integration tests |
| `apps/web/src/styles/app.css` | Touch-friendly manager control layout |

## Risks and tradeoffs

- **Privilege semantics:** This plan deliberately maps non-creator managers to `editor`, not destructive `owner`. It satisfies club visibility and management while protecting club deletion. Confirm before execution if co-managers must delete clubs.
- **Email is the invitation key:** Access depends on the saved player email matching Google’s verified email case-insensitively. The UI should explain this near `Club manager`.
- **Consent coupling:** A manager requires stored email, so manager selection necessarily enables consent and required personal fields. The server must enforce this independently of the UI.
- **Existing data:** Backfill must avoid nickname/email collisions and run twice safely. Migration tests are mandatory before applying to the real database.
- **Creator safety:** Preventing creator demotion/deletion avoids orphaned clubs but means changing ownership is intentionally out of scope.
- **Concurrent edits:** Promotion/demotion and first-login claim can race. Transactions, row locks, partial unique indexes, and idempotent membership upserts must make both orders converge.
- **Email changes:** If Google later changes an already-linked manager’s email, the existing membership remains valid; changing the player email explicitly can relink only after a deliberate manager profile update. Automatic ownership transfer on Google email changes is out of scope.
- **Dirty workspace:** `App.tsx` and related tests already contain unrelated uncommitted work. Avoid whole-file rewrites and repository-wide formatting.

## Acceptance criteria

- [ ] Every new club contains exactly one consented, linked, locked `Owner` club-manager player using the creator’s Google email.
- [ ] Players menu supports selecting/deselecting `Club manager` with accessible touch controls.
- [ ] Manager selection cannot bypass consent or omit required personal data/email.
- [ ] A matching existing Google user gets the club immediately; a new user gets it on first matching Google sign-in.
- [ ] The club appears on the invitee’s welcome screen and opens normally.
- [ ] Non-creator managers cannot delete the club under the recommended `editor` mapping.
- [ ] Demotion/deletion removes only the manager’s editor access and never creator ownership.
- [ ] Creator manager profile cannot be demoted or deleted.
- [ ] All matching is tenant-scoped and case-insensitive by email.
- [ ] Fresh and populated schema migrations are idempotent.
- [ ] Focused tests and all project quality gates pass.
