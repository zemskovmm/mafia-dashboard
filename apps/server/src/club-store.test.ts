import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { ClubStore } from "./club-store.js";
import type { AppUser } from "./google-auth.js";
import { PlayerStore } from "./player-store.js";

const pool = new Pool({
  connectionString:
    process.env.TEST_DATABASE_URL ?? "postgresql://mafia:mafia@127.0.0.1:54329/mafia_test",
});
const store = new ClubStore(pool);
const playerStore = new PlayerStore(pool);

beforeAll(async () => {
  await playerStore.initialize();
});

afterAll(async () => {
  await pool.end();
});

const createUser = async (name = "Ada Lovelace Byron"): Promise<AppUser> => {
  const user = {
    id: randomUUID(),
    email: `user-${randomUUID()}@example.test`,
    name,
    picture: null,
  };
  await pool.query(
    `INSERT INTO users (id, email, display_name, picture)
     VALUES ($1, $2, $3, $4)`,
    [user.id, user.email, user.name, user.picture],
  );
  return user;
};

const clubInput = () => ({
  name: `Club ${randomUUID().slice(0, 8)}`,
  city: "London",
  headerLogo: null,
  cardLogo: null,
  language: "ru" as const,
  bestMoveEnabled: false,
  ownerConsent: true as const,
});

describe("ClubStore access roles", () => {
  it("atomically creates the creator's protected manager profile", async () => {
    const creator = await createUser();

    const club = await store.create(creator, clubInput());

    expect(club.role).toBe("manager");
    expect(club.language).toBe("ru");
    expect(club.bestMoveEnabled).toBe(false);
    await expect(playerStore.list(club.id)).resolves.toMatchObject([
      {
        nickname: "Owner",
        consent: true,
        firstName: "Ada",
        lastName: "Lovelace Byron",
        email: creator.email,
        clubAccess: "manager",
        managerLocked: true,
      },
    ]);
    await expect(
      pool.query(
        `SELECT membership.role, player.club_access, player.user_id
           FROM club_memberships AS membership
           JOIN players AS player
             ON player.club_id = membership.club_id
            AND player.user_id = membership.user_id
          WHERE membership.club_id = $1 AND membership.user_id = $2`,
        [club.id, creator.id],
      ),
    ).resolves.toMatchObject({
      rows: [{ role: "manager", club_access: "manager", user_id: creator.id }],
    });
  });

  it("claims pending user or manager access case-insensitively and idempotently", async () => {
    const creator = await createUser();
    const club = await store.create(creator, clubInput());
    const manager = await createUser("Grace Hopper");
    const playerId = randomUUID();
    await pool.query(
      `INSERT INTO players
         (id, club_id, nickname, first_name, last_name, email,
          data_processing_consent, consent_at, club_access)
       VALUES ($1, $2, $3, 'Grace', 'Hopper', $4, TRUE, NOW(), 'user')`,
      [playerId, club.id, `Manager ${randomUUID().slice(0, 8)}`, manager.email.toUpperCase()],
    );

    await store.claimClubAccess(manager.id, manager.email);
    await store.claimClubAccess(manager.id, manager.email);

    await expect(
      pool.query(
        `SELECT player.user_id, membership.role, membership.access_player_id
           FROM players AS player
           LEFT JOIN club_memberships AS membership
             ON membership.club_id = player.club_id
            AND membership.user_id = player.user_id
          WHERE player.id = $1`,
        [playerId],
      ),
    ).resolves.toMatchObject({
      rows: [{ user_id: manager.id, role: "user", access_player_id: playerId }],
    });
    await expect(store.listForUser(manager.id)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: club.id, role: "user" })]),
    );
  });

  it("keeps an existing independent membership unmarked when claiming pending access", async () => {
    const creator = await createUser();
    const club = await store.create(creator, clubInput());
    const manager = await createUser("Independent Claimant");
    const playerId = randomUUID();
    await pool.query(
      `INSERT INTO players
         (id, club_id, nickname, first_name, last_name, email,
          data_processing_consent, consent_at, club_access)
       VALUES ($1, $2, $3, 'Independent', 'Claimant', $4, TRUE, NOW(), 'manager')`,
      [playerId, club.id, `Manager ${randomUUID().slice(0, 8)}`, manager.email],
    );
    await pool.query(
      "INSERT INTO club_memberships (club_id, user_id, role) VALUES ($1, $2, 'user')",
      [club.id, manager.id],
    );

    await store.claimClubAccess(manager.id, manager.email);

    await expect(
      pool.query(
        `SELECT player.user_id, membership.role, membership.access_player_id
           FROM players AS player
           JOIN club_memberships AS membership
             ON membership.club_id = player.club_id
            AND membership.user_id = player.user_id
          WHERE player.id = $1`,
        [playerId],
      ),
    ).resolves.toMatchObject({
      rows: [{ user_id: manager.id, role: "user", access_player_id: null }],
    });
  });

  it("does not steal linked managers or downgrade creator memberships", async () => {
    const creator = await createUser();
    const club = await store.create(creator, clubInput());
    const otherUser = await createUser("Other Claimant");

    await store.claimClubAccess(creator.id, creator.email.toUpperCase());
    await store.claimClubAccess(otherUser.id, creator.email);

    await expect(
      pool.query(
        `SELECT player.user_id, membership.role
           FROM players AS player
           JOIN club_memberships AS membership
             ON membership.club_id = player.club_id
            AND membership.user_id = player.user_id
          WHERE player.club_id = $1 AND player.nickname = 'Owner'`,
        [club.id],
      ),
    ).resolves.toMatchObject({ rows: [{ user_id: creator.id, role: "manager" }] });
    await expect(store.listForUser(otherUser.id)).resolves.toEqual([]);
  });

  it("resolves persisted identity for legacy ID callers and duplicates a one-word name", async () => {
    const creator = await createUser("Prince");

    const club = await store.create(creator.id, clubInput());

    await expect(playerStore.list(club.id)).resolves.toMatchObject([
      {
        nickname: "Owner",
        firstName: "Prince",
        lastName: "Prince",
        email: creator.email,
        clubAccess: "manager",
        managerLocked: true,
      },
    ]);
  });

  it("lets managers, but not users or strangers, update their club", async () => {
    const creator = await createUser("Language Owner");
    const editor = await createUser("Language Editor");
    const stranger = await createUser("Language Stranger");
    const club = await store.create(creator, clubInput());
    await pool.query(
      "INSERT INTO club_memberships (club_id, user_id, role) VALUES ($1, $2, 'user')",
      [club.id, editor.id],
    );

    await expect(
      store.update(editor.id, club.id, {
        name: club.name,
        city: club.city,
        headerLogo: club.headerLogo,
        cardLogo: club.cardLogo,
        language: "en",
        bestMoveEnabled: true,
      }),
    ).resolves.toBeNull();
    await expect(
      store.update(creator.id, club.id, {
        name: club.name,
        city: club.city,
        headerLogo: club.headerLogo,
        cardLogo: club.cardLogo,
        language: "ru",
        bestMoveEnabled: true,
      }),
    ).resolves.toMatchObject({
      id: club.id,
      language: "ru",
      bestMoveEnabled: true,
      role: "manager",
    });
    await expect(
      store.update(stranger.id, club.id, {
        name: club.name,
        city: club.city,
        headerLogo: club.headerLogo,
        cardLogo: club.cardLogo,
        language: "en",
        bestMoveEnabled: false,
      }),
    ).resolves.toBeNull();
  });
});
