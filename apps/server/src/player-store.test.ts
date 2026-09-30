import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PlayerStore } from "./player-store.js";
import { ClubStore, DEFAULT_CLUB_ID } from "./club-store.js";
import type { AppUser } from "./google-auth.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgresql://mafia:mafia@127.0.0.1:54329/mafia_test";
const schemaName = `player_store_test_${randomUUID().replaceAll("-", "")}`;
const bootstrapPool = new Pool({ connectionString: databaseUrl });
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
const store = new PlayerStore(pool);

beforeAll(async () => {
  await bootstrapPool.query(`CREATE SCHEMA ${schemaName}`);
  await store.initialize();
});

afterAll(async () => {
  await pool.end();
  await bootstrapPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await bootstrapPool.end();
});

const nickname = (base: string) => `${base}-${randomUUID().slice(0, 8)}`;
const createUser = async (name = "Test User"): Promise<AppUser> => {
  const user = {
    id: randomUUID(),
    email: `user-${randomUUID()}@example.test`,
    name,
    picture: null,
  };
  await pool.query("INSERT INTO users (id, email, display_name, picture) VALUES ($1, $2, $3, $4)", [
    user.id,
    user.email,
    user.name,
    user.picture,
  ]);
  return user;
};

const createClub = async () => {
  const creator = await createUser("Club Creator");
  const club = await new ClubStore(pool).create(creator, {
    name: `Player test club ${randomUUID().slice(0, 8)}`,
    city: "Granada",
    headerLogo: null,
    cardLogo: null,
    language: "en",
    ownerConsent: true,
  });
  return { club, creator };
};

const insertFinalResult = async ({
  gameId = randomUUID(),
  clubId = DEFAULT_CLUB_ID,
  hostPlayerId = null,
  playedAt,
  players,
}: {
  readonly gameId?: string;
  readonly clubId?: string;
  readonly hostPlayerId?: string | null;
  readonly playedAt: Date;
  readonly players: readonly {
    readonly playerId: string;
    readonly seat: number;
    readonly role: "sheriff" | "citizen" | "mafia" | "don";
    readonly team: "red" | "black";
    readonly status: "active" | "eliminated" | "red-carded";
    readonly fouls: number;
    readonly bestMoveHits?: number | null;
  }[];
}): Promise<string> => {
  await pool.query(
    `INSERT INTO game_results
       (club_id, game_id, outcome, winner, reason, played_at, host_player_id)
     VALUES ($1, $2, 'red', 'red', NULL, $3, $4)`,
    [clubId, gameId, playedAt, hostPlayerId],
  );
  for (const player of players) {
    await pool.query(
      `INSERT INTO game_player_results
         (club_id, game_id, player_id, seat, role, team, final_status, fouls, won, best_move_hits)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        clubId,
        gameId,
        player.playerId,
        player.seat,
        player.role,
        player.team,
        player.status,
        player.fouls,
        player.team === "red",
        player.bestMoveHits ?? null,
      ],
    );
  }
  const impactedPlayerIds = [...players.map(({ playerId }) => playerId), hostPlayerId].filter(
    (playerId): playerId is string => playerId !== null,
  );
  await pool.query(
    "UPDATE players SET last_played_at = $1 WHERE club_id = $2 AND id = ANY($3::uuid[])",
    [playedAt, clubId, impactedPlayerIds],
  );
  return gameId;
};

describe("PlayerStore", () => {
  it("links a new manager to an existing user and grants editor access", async () => {
    const { club } = await createClub();
    const manager = await createUser("Existing Manager");

    const player = await store.create(
      {
        nickname: nickname("Existing manager"),
        consent: true,
        firstName: "Existing",
        lastName: "Manager",
        email: manager.email.toUpperCase(),
        clubAccess: "manager",
      },
      club.id,
    );

    expect(player).toMatchObject({ clubAccess: "manager", managerLocked: false });
    await expect(
      pool.query(
        `SELECT player.user_id, membership.role, membership.access_player_id
           FROM players AS player
           LEFT JOIN club_memberships AS membership
             ON membership.club_id = player.club_id
            AND membership.user_id = player.user_id
          WHERE player.id = $1 AND player.club_id = $2`,
        [player.id, club.id],
      ),
    ).resolves.toMatchObject({
      rows: [{ user_id: manager.id, role: "manager", access_player_id: player.id }],
    });
  });

  it("grants, changes, and revokes player-linked user access", async () => {
    const { club, creator } = await createClub();
    const user = await createUser("Regular User");
    const input = {
      nickname: nickname("Regular user"),
      consent: true,
      firstName: "Regular",
      lastName: "User",
      email: user.email,
      clubAccess: "user" as const,
    };

    const player = await store.create(input, club.id);
    expect(player).toMatchObject({ clubAccess: "user", managerLocked: false });
    await expect(
      pool.query(
        "SELECT role, access_player_id FROM club_memberships WHERE club_id = $1 AND user_id = $2",
        [club.id, user.id],
      ),
    ).resolves.toMatchObject({
      rows: [{ role: "user", access_player_id: player.id }],
    });

    await expect(
      store.update(player.id, { ...input, clubAccess: "manager" }, club.id, creator.id),
    ).resolves.toMatchObject({ clubAccess: "manager" });
    await expect(
      pool.query("SELECT role FROM club_memberships WHERE club_id = $1 AND user_id = $2", [
        club.id,
        user.id,
      ]),
    ).resolves.toMatchObject({ rows: [{ role: "manager" }] });

    await expect(
      store.update(player.id, { ...input, clubAccess: "none" }, club.id, creator.id),
    ).resolves.toMatchObject({ clubAccess: "none" });
    await expect(
      pool.query("SELECT role FROM club_memberships WHERE club_id = $1 AND user_id = $2", [
        club.id,
        user.id,
      ]),
    ).resolves.toMatchObject({ rows: [] });
  });

  it("promotes an existing consented player and grants editor access", async () => {
    const { club, creator } = await createClub();
    const manager = await createUser("Promoted Manager");
    const player = await store.create(
      {
        nickname: nickname("Promoted manager"),
        consent: true,
        firstName: "Promoted",
        lastName: "Manager",
        email: manager.email,
      },
      club.id,
    );

    const promoted = await store.update(
      player.id,
      {
        nickname: player.nickname,
        consent: true,
        firstName: "Promoted",
        lastName: "Manager",
        email: manager.email,
        clubAccess: "manager",
      },
      club.id,
      creator.id,
    );

    expect(promoted).toMatchObject({ clubAccess: "manager", managerLocked: false });
    await expect(
      pool.query("SELECT role FROM club_memberships WHERE club_id = $1 AND user_id = $2", [
        club.id,
        manager.id,
      ]),
    ).resolves.toMatchObject({ rows: [{ role: "manager" }] });
  });

  it("preserves independent editor access after manager demotion", async () => {
    const { club } = await createClub();
    const manager = await createUser("Independent Editor");
    await pool.query(
      "INSERT INTO club_memberships (club_id, user_id, role) VALUES ($1, $2, 'manager')",
      [club.id, manager.id],
    );
    const player = await store.create(
      {
        nickname: nickname("Independent editor"),
        consent: true,
        firstName: "Independent",
        lastName: "Editor",
        email: manager.email,
      },
      club.id,
    );
    const managerInput = {
      nickname: player.nickname,
      consent: true,
      firstName: player.firstName,
      lastName: player.lastName,
      email: player.email,
      clubAccess: "manager" as const,
    };

    await store.update(player.id, managerInput, club.id, manager.id);
    const demoted = await store.update(
      player.id,
      { ...managerInput, clubAccess: "none" },
      club.id,
      manager.id,
    );

    expect(demoted).toMatchObject({ clubAccess: "none", managerLocked: false });
    await expect(
      pool.query(
        `SELECT player.user_id, membership.role
           FROM players AS player
           LEFT JOIN club_memberships AS membership
             ON membership.club_id = player.club_id
            AND membership.user_id = $1
          WHERE player.id = $2 AND player.club_id = $3`,
        [manager.id, player.id, club.id],
      ),
    ).resolves.toMatchObject({ rows: [{ user_id: null, role: "manager" }] });
  });

  it("preserves independent editor access after manager deletion", async () => {
    const { club } = await createClub();
    const manager = await createUser("Independent Deleted Editor");
    await pool.query(
      "INSERT INTO club_memberships (club_id, user_id, role) VALUES ($1, $2, 'manager')",
      [club.id, manager.id],
    );
    const player = await store.create(
      {
        nickname: nickname("Independent deleted editor"),
        consent: true,
        firstName: "Independent",
        lastName: "Deleted",
        email: manager.email,
        clubAccess: "manager",
      },
      club.id,
    );

    await expect(store.delete(player.id, club.id)).resolves.toBe("deleted");
    await expect(
      pool.query(
        `SELECT role, access_player_id
           FROM club_memberships
          WHERE club_id = $1 AND user_id = $2`,
        [club.id, manager.id],
      ),
    ).resolves.toMatchObject({
      rows: [{ role: "manager", access_player_id: null }],
    });
  });

  it("removes only an editor membership when deleting a linked manager", async () => {
    const { club } = await createClub();
    const manager = await createUser("Deleted Manager");
    const player = await store.create(
      {
        nickname: nickname("Deleted manager"),
        consent: true,
        firstName: "Deleted",
        lastName: "Manager",
        email: manager.email,
        clubAccess: "manager",
      },
      club.id,
    );

    await expect(store.delete(player.id, club.id)).resolves.toBe("deleted");
    await expect(
      pool.query("SELECT role FROM club_memberships WHERE club_id = $1 AND user_id = $2", [
        club.id,
        manager.id,
      ]),
    ).resolves.toMatchObject({ rows: [] });
  });

  it("preserves the creator link when editing the locked manager email", async () => {
    const { club, creator } = await createClub();
    const otherUser = await createUser("Other User");
    const owner = (await store.list(club.id)).find(({ managerLocked }) => managerLocked);
    expect(owner).toBeDefined();

    const updated = await store.update(
      owner!.id,
      {
        nickname: owner!.nickname,
        consent: true,
        firstName: "Edited",
        lastName: "Owner",
        email: otherUser.email,
        clubAccess: "manager",
      },
      club.id,
      creator.id,
    );

    expect(updated).toMatchObject({
      email: otherUser.email,
      clubAccess: "manager",
      managerLocked: true,
    });
    await expect(
      pool.query("SELECT user_id FROM players WHERE id = $1 AND club_id = $2", [
        owner!.id,
        club.id,
      ]),
    ).resolves.toMatchObject({ rows: [{ user_id: creator.id }] });
    await expect(
      pool.query("SELECT role FROM club_memberships WHERE club_id = $1 AND user_id = $2", [
        club.id,
        otherUser.id,
      ]),
    ).resolves.toMatchObject({ rows: [] });
  });

  it("rejects locked Owner profile mutations from a different user without changing PII", async () => {
    const { club, creator } = await createClub();
    const editor = await createUser("Owner Profile Editor");
    await pool.query(
      "INSERT INTO club_memberships (club_id, user_id, role) VALUES ($1, $2, 'manager')",
      [club.id, editor.id],
    );
    const owner = (await store.list(club.id)).find(({ managerLocked }) => managerLocked)!;
    await store.update(
      owner.id,
      {
        nickname: owner.nickname,
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
        clubAccess: "manager",
      },
      club.id,
      creator.id,
    );
    const withdrawn = await store.get(owner.id, club.id);

    const mutationError = await store
      .update(
        owner.id,
        {
          nickname: nickname("Editor rewrite"),
          consent: true,
          firstName: "Editor",
          lastName: "Rewrite",
          email: editor.email,
          clubAccess: "manager",
        },
        club.id,
        editor.id,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    const afterAttempt = await store.get(owner.id, club.id);

    expect([mutationError, afterAttempt]).toEqual([
      expect.objectContaining({
        name: "OwnerProfileForbiddenError",
        code: "owner_profile_forbidden",
      }),
      withdrawn,
    ]);
  });

  it("rejects demotion for the locked creator manager", async () => {
    const { club, creator } = await createClub();
    const owner = (await store.list(club.id)).find(({ managerLocked }) => managerLocked)!;
    const demotion = {
      nickname: owner.nickname,
      consent: true,
      firstName: owner.firstName,
      lastName: owner.lastName,
      email: owner.email,
      clubAccess: "none" as const,
    };

    await expect(store.update(owner.id, demotion, club.id, creator.id)).rejects.toMatchObject({
      name: "ManagerLockedError",
      code: "manager_locked",
    });
    await expect(store.get(owner.id, club.id)).resolves.toMatchObject({
      clubAccess: "manager",
      managerLocked: true,
    });
    await expect(
      pool.query("SELECT role FROM club_memberships WHERE club_id = $1 AND user_id = $2", [
        club.id,
        creator.id,
      ]),
    ).resolves.toMatchObject({ rows: [{ role: "manager" }] });
  });

  it("lets the linked creator withdraw and restore consent without removing manager access", async () => {
    const { club, creator } = await createClub();
    const owner = (await store.list(club.id)).find(({ managerLocked }) => managerLocked)!;

    const updated = await store.update(
      owner.id,
      {
        nickname: owner.nickname,
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
        clubAccess: "manager",
      },
      club.id,
      creator.id,
    );

    expect(updated).toMatchObject({
      consent: false,
      consentAt: null,
      firstName: null,
      lastName: null,
      email: null,
      clubAccess: "manager",
      managerLocked: true,
    });
    await expect(
      pool.query(
        `SELECT player.user_id, player.club_access, membership.role,
                membership.access_player_id
           FROM players AS player
           JOIN club_memberships AS membership
             ON membership.club_id = player.club_id
            AND membership.user_id = player.user_id
          WHERE player.id = $1 AND player.club_id = $2`,
        [owner.id, club.id],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          user_id: creator.id,
          club_access: "manager",
          role: "manager",
          access_player_id: null,
        },
      ],
    });

    const restored = await store.update(
      owner.id,
      {
        nickname: owner.nickname,
        consent: true,
        firstName: "Club",
        lastName: "Creator",
        email: creator.email,
        clubAccess: "manager",
      },
      club.id,
      creator.id,
    );
    expect(restored).toMatchObject({
      consent: true,
      consentAt: expect.any(Date),
      firstName: "Club",
      lastName: "Creator",
      email: creator.email,
      clubAccess: "manager",
      managerLocked: true,
    });
  });

  it("rejects deleting the locked creator manager", async () => {
    const { club, creator } = await createClub();
    const owner = (await store.list(club.id)).find(({ managerLocked }) => managerLocked)!;

    await expect(store.delete(owner.id, club.id)).resolves.toBe("manager_locked");
    await expect(store.get(owner.id, club.id)).resolves.toMatchObject({
      clubAccess: "manager",
      managerLocked: true,
    });
    await expect(
      pool.query("SELECT role FROM club_memberships WHERE club_id = $1 AND user_id = $2", [
        club.id,
        creator.id,
      ]),
    ).resolves.toMatchObject({ rows: [{ role: "manager" }] });
  });

  it("keeps an unknown manager pending without granting membership", async () => {
    const { club } = await createClub();
    const email = `pending-${randomUUID()}@example.test`;

    const player = await store.create(
      {
        nickname: nickname("Pending manager"),
        consent: true,
        firstName: "Pending",
        lastName: "Manager",
        email,
        clubAccess: "manager",
      },
      club.id,
    );

    expect(player).toMatchObject({ clubAccess: "manager", managerLocked: false, email });
    await expect(
      pool.query("SELECT user_id FROM players WHERE id = $1 AND club_id = $2", [
        player.id,
        club.id,
      ]),
    ).resolves.toMatchObject({ rows: [{ user_id: null }] });
  });

  it("relinks a pending manager when its email changes to an existing user", async () => {
    const { club, creator } = await createClub();
    const manager = await createUser("Relinked Manager");
    const player = await store.create(
      {
        nickname: nickname("Relinked manager"),
        consent: true,
        firstName: "Pending",
        lastName: "Manager",
        email: `unknown-${randomUUID()}@example.test`,
        clubAccess: "manager",
      },
      club.id,
    );

    const updated = await store.update(
      player.id,
      {
        nickname: player.nickname,
        consent: true,
        firstName: "Relinked",
        lastName: "Manager",
        email: manager.email,
        clubAccess: "manager",
      },
      club.id,
      creator.id,
    );

    expect(updated).toMatchObject({
      clubAccess: "manager",
      managerLocked: false,
      email: manager.email,
    });
    await expect(
      pool.query(
        `SELECT player.user_id, membership.role
           FROM players AS player
           JOIN club_memberships AS membership
             ON membership.club_id = player.club_id
            AND membership.user_id = player.user_id
          WHERE player.id = $1 AND player.club_id = $2`,
        [player.id, club.id],
      ),
    ).resolves.toMatchObject({ rows: [{ user_id: manager.id, role: "manager" }] });
  });

  it("demotes a non-creator manager without affecting its other-club access", async () => {
    const first = await createClub();
    const second = await createClub();
    const manager = await createUser("Tenant Manager");
    const input = {
      nickname: nickname("Tenant manager"),
      consent: true,
      firstName: "Tenant",
      lastName: "Manager",
      email: manager.email,
      clubAccess: "manager" as const,
    };
    const firstPlayer = await store.create(input, first.club.id);
    const secondPlayer = await store.create(
      { ...input, nickname: nickname("Tenant manager") },
      second.club.id,
    );

    const demoted = await store.update(
      firstPlayer.id,
      { ...input, nickname: firstPlayer.nickname, clubAccess: "none" },
      first.club.id,
      first.creator.id,
    );

    expect(demoted).toMatchObject({ clubAccess: "none", managerLocked: false });
    await expect(
      pool.query(
        `SELECT player.club_id, player.user_id, membership.role
           FROM players AS player
           LEFT JOIN club_memberships AS membership
             ON membership.club_id = player.club_id
            AND membership.user_id = $1
          WHERE player.id = ANY($2::uuid[])
          ORDER BY player.club_id`,
        [manager.id, [firstPlayer.id, secondPlayer.id]],
      ),
    ).resolves.toMatchObject({
      rows: expect.arrayContaining([
        { club_id: first.club.id, user_id: null, role: null },
        { club_id: second.club.id, user_id: manager.id, role: "manager" },
      ]),
    });
  });

  it("stores consent-safe profiles and rejects case-insensitive duplicate nicknames", async () => {
    const aliceNickname = nickname("Alice");
    const alice = await store.create({
      nickname: aliceNickname,
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    expect(alice).toMatchObject({
      nickname: aliceNickname,
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });

    const bob = await store.create({
      nickname: nickname("Bob"),
      consent: true,
      firstName: "Bob",
      lastName: "Player",
      email: "bob@example.test",
    });
    expect(bob).toMatchObject({
      consent: true,
      firstName: "Bob",
      lastName: "Player",
      email: "bob@example.test",
    });

    await expect(
      store.create({
        nickname: aliceNickname.toUpperCase(),
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
      }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("reads current final-result rows into player statistics", async () => {
    const host = await store.create({
      nickname: nickname("Result host"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const player = await store.create({
      nickname: nickname("Result player"),
      consent: true,
      firstName: "Result",
      lastName: "Player",
      email: `result-${randomUUID()}@example.test`,
    });
    const playedAt = new Date("2026-08-17T21:00:00.000Z");
    await insertFinalResult({
      hostPlayerId: host.id,
      playedAt,
      players: [
        {
          playerId: player.id,
          seat: 4,
          role: "sheriff",
          team: "red",
          status: "eliminated",
          fouls: 2,
          bestMoveHits: 2,
        },
      ],
    });

    await expect(store.get(host.id)).resolves.toMatchObject({
      lastPlayedAt: playedAt,
      statistics: { hostedGames: 1, gamesPlayed: 0, wins: 0 },
    });
    await expect(store.get(player.id)).resolves.toMatchObject({
      lastPlayedAt: playedAt,
      statistics: {
        gamesPlayed: 1,
        wins: 1,
        losses: 0,
        redGames: 1,
        redWins: 1,
        blackGames: 0,
        blackWins: 0,
        sheriffGames: 1,
        citizenGames: 0,
        mafiaGames: 0,
        donGames: 0,
        totalFouls: 2,
        eliminations: 1,
        redCards: 0,
        bestMoves: 1,
        bestMoveMafiaHits: 2,
      },
    });
  });

  it("orders profiles by current materialized last-played timestamps", async () => {
    const never = await store.create({
      nickname: nickname("Zulu"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const older = await store.create({
      nickname: nickname("Alpha"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const newer = await store.create({
      nickname: nickname("Beta"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    await insertFinalResult({
      playedAt: new Date("2026-08-16T20:00:00.000Z"),
      players: [
        {
          playerId: older.id,
          seat: 1,
          role: "citizen",
          team: "red",
          status: "active",
          fouls: 0,
        },
      ],
    });
    await insertFinalResult({
      playedAt: new Date("2026-08-17T20:00:00.000Z"),
      players: [
        {
          playerId: newer.id,
          seat: 1,
          role: "mafia",
          team: "black",
          status: "active",
          fouls: 0,
        },
      ],
    });

    const orderedIds = (await store.list()).map(({ id }) => id);
    expect(orderedIds.indexOf(newer.id)).toBeLessThan(orderedIds.indexOf(older.id));
    expect(orderedIds.indexOf(older.id)).toBeLessThan(orderedIds.indexOf(never.id));
  });

  it("retires a player's profile while retaining individual and shared completed results", async () => {
    const host = await store.create({
      nickname: nickname("History host"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const participant = await store.create({
      nickname: nickname("History participant"),
      consent: true,
      firstName: "History",
      lastName: "Participant",
      email: `history-${randomUUID()}@example.test`,
    });
    const peer = await store.create({
      nickname: nickname("History peer"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const gameId = await insertFinalResult({
      hostPlayerId: host.id,
      playedAt: new Date("2026-08-18T00:00:00.000Z"),
      players: [
        {
          playerId: participant.id,
          seat: 1,
          role: "citizen",
          team: "red",
          status: "active",
          fouls: 0,
        },
        {
          playerId: peer.id,
          seat: 2,
          role: "mafia",
          team: "black",
          status: "active",
          fouls: 1,
        },
      ],
    });

    await expect(store.delete(participant.id)).resolves.toBe("deleted");
    await expect(store.get(participant.id)).resolves.toBeNull();
    expect((await store.list()).some(({ id }) => id === participant.id)).toBe(false);
    await expect(
      pool.query(
        `SELECT nickname, first_name, last_name, email, user_id, club_access,
                data_processing_consent, consent_at, retired_at
           FROM players WHERE club_id = $1 AND id = $2`,
        [DEFAULT_CLUB_ID, participant.id],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          nickname: null,
          first_name: null,
          last_name: null,
          email: null,
          user_id: null,
          club_access: "none",
          data_processing_consent: false,
          consent_at: null,
          retired_at: expect.any(Date),
        },
      ],
    });
    await expect(store.get(host.id)).resolves.toMatchObject({
      lastPlayedAt: expect.any(Date),
      statistics: { hostedGames: 1, gamesPlayed: 0 },
    });
    await expect(store.get(peer.id)).resolves.toMatchObject({
      statistics: { gamesPlayed: 1, losses: 1 },
    });
    await expect(
      pool.query(
        "SELECT player_id, seat, won FROM game_player_results WHERE club_id = $1 AND game_id = $2 ORDER BY seat",
        [DEFAULT_CLUB_ID, gameId],
      ),
    ).resolves.toMatchObject({
      rows: [
        { player_id: participant.id, seat: 1, won: true },
        { player_id: peer.id, seat: 2, won: false },
      ],
    });
    await expect(
      pool.query("SELECT 1 FROM game_results WHERE club_id = $1 AND game_id = $2", [
        DEFAULT_CLUB_ID,
        gameId,
      ]),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(store.delete(participant.id)).resolves.toBe("not_found");
    await expect(
      store.create({
        nickname: participant.nickname,
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
      }),
    ).resolves.toMatchObject({ nickname: participant.nickname });
  });

  it("protects an active host as well as a participant from profile deletion", async () => {
    const host = await store.create({
      nickname: nickname("Active host"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const gameId = randomUUID();
    await pool.query(
      `INSERT INTO game_sessions (id, club_id, name, revision, last_mutation_id, state, status)
       VALUES ($1, $2, 'Hosted active game', 1, $3, '{}'::jsonb, 'active')`,
      [gameId, DEFAULT_CLUB_ID, randomUUID()],
    );
    await pool.query(
      `INSERT INTO game_session_players (club_id, game_id, player_id, seat, is_host, role)
       VALUES ($1, $2, $3, NULL, TRUE, NULL)`,
      [DEFAULT_CLUB_ID, gameId, host.id],
    );
    await expect(store.delete(host.id)).resolves.toBe("active_game");
    await expect(store.get(host.id)).resolves.toMatchObject({ id: host.id });
  });

  it("does not delete a player referenced by a current active projection", async () => {
    const player = await store.create({
      nickname: nickname("Active player"),
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const gameId = randomUUID();
    await pool.query(
      `INSERT INTO game_sessions
         (id, club_id, name, revision, last_mutation_id, state, status)
       VALUES ($1, $2, 'Current active projection', 1, $3, $4::jsonb, 'active')`,
      [gameId, DEFAULT_CLUB_ID, randomUUID(), JSON.stringify({})],
    );
    await pool.query(
      `INSERT INTO game_session_players (club_id, game_id, player_id, seat, is_host, role)
       VALUES ($1, $2, $3, 1, FALSE, 'citizen')`,
      [DEFAULT_CLUB_ID, gameId, player.id],
    );

    await expect(store.delete(player.id)).resolves.toBe("active_game");
    await expect(store.get(player.id)).resolves.toMatchObject({ id: player.id });
  });

  it("does not retain removed result mutation APIs", () => {
    const legacyStore = store as unknown as Record<string, unknown>;
    expect(legacyStore.saveGameResults).toBeUndefined();
    expect(legacyStore.deleteGameResults).toBeUndefined();
    expect(legacyStore.backfillGameResults).toBeUndefined();
  });
});
