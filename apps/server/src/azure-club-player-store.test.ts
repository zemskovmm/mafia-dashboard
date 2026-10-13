import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AzureClubStore, AzurePlayerStore } from "./azure-club-player-store.js";
import { createStorageFixture } from "./test-helpers/storage-fixture.js";
import type { AzureStorage } from "./azure-storage.js";

let fixture: Awaited<ReturnType<typeof createStorageFixture>>;
let storage: AzureStorage;
let clubs: AzureClubStore;
let players: AzurePlayerStore;

beforeAll(async () => {
  fixture = await createStorageFixture();
  storage = fixture.storage;
  clubs = new AzureClubStore(storage);
  players = new AzurePlayerStore(storage);
});
afterAll(async () => {
  await fixture?.close();
});

const user = (name = "Ada Lovelace Byron") => ({
  id: randomUUID(),
  email: `user-${randomUUID()}@example.test`,
  name,
  picture: null,
});
const clubInput = () => ({
  name: ` Club ${randomUUID()} `,
  city: " London ",
  headerLogo: null,
  cardLogo: null,
  language: "ru" as const,
  bestMoveEnabled: false,
  ownerConsent: true as const,
});
const addUser = async (account: ReturnType<typeof user>) => {
  const now = new Date();
  await storage.mutate(async (tx) =>
    tx.set(`user:${account.id}`, {
      ...account,
      createdAt: now,
      updatedAt: now,
    }),
  );
};

// These are real Table/Blob integration cases, never an in-memory transaction mock.
describe("Azure club and player stores", () => {
  it("creates a consented locked Owner, membership, and exact club settings in one commit", async () => {
    const creator = user();
    await addUser(creator);
    const club = await clubs.create(creator.id, clubInput());
    expect(club).toMatchObject({
      role: "manager",
      name: club.name.trim(),
      city: "London",
      bestMoveEnabled: false,
    });
    expect(await clubs.getRole(creator.id, club.id)).toBe("manager");
    expect(await players.list(club.id)).toMatchObject([
      {
        nickname: "Owner",
        firstName: "Ada",
        lastName: "Lovelace Byron",
        email: creator.email,
        managerLocked: true,
        consent: true,
        clubAccess: "manager",
      },
    ]);
    const rows = await storage.read((tx) => tx.list<Record<string, unknown>>(`club:${club.id}:`));
    expect(rows.filter(({ rowKey }) => rowKey.includes(":member:"))).toHaveLength(1);
    expect(rows.filter(({ rowKey }) => rowKey.includes(":player:"))).toHaveLength(1);
  });

  it("refuses a detached creator rather than writing orphaned club identity", async () => {
    const detached = user();
    const before = await storage.read((tx) => tx.list("club:"));
    await expect(clubs.create(detached, clubInput())).rejects.toThrow("not found");
    expect(await storage.read((tx) => tx.list("club:"))).toEqual(before);
  });

  it("round-trips maximum accepted logos and protects manager-only club edits", async () => {
    const creator = user();
    await addUser(creator);
    const club = await clubs.create(creator, {
      ...clubInput(),
      headerLogo: "h".repeat(1_500_000),
      cardLogo: "c".repeat(1_500_000),
    });
    expect(club.headerLogo).toHaveLength(1_500_000);
    const original = await storage.read((tx) =>
      tx.get<Record<string, unknown>>(`club:${club.id}:meta`),
    );
    const oldHeader = original?.headerBlobName as string;
    const oldCard = original?.cardBlobName as string;
    expect((await clubs.listForUser(creator.id))[0]?.cardLogo).toHaveLength(1_500_000);
    const outsider = user();
    expect(
      await clubs.update(outsider.id, club.id, {
        name: "Hijacked",
        city: "X",
        language: "en",
        headerLogo: null,
        cardLogo: null,
      }),
    ).toBeNull();
    const updated = await clubs.update(creator.id, club.id, {
      name: " Renamed ",
      city: " Paris ",
      language: "en",
      headerLogo: null,
      cardLogo: "new",
    });
    expect(updated).toMatchObject({
      name: "Renamed",
      city: "Paris",
      headerLogo: null,
      cardLogo: "new",
      bestMoveEnabled: false,
    });
    expect((await clubs.listForUser(creator.id))[0]).toMatchObject(updated!);
    const replacement = await storage.read((tx) =>
      tx.get<Record<string, unknown>>(`club:${club.id}:meta`),
    );
    expect(await storage.read((tx) => tx.list("cleanup:"))).toHaveLength(2);
    expect(await clubs.delete(creator.id, club.id)).toBe(true);
    for (const blobName of [oldHeader, oldCard, replacement?.cardBlobName as string]) {
      await expect(
        storage.blobs.getBlockBlobClient(blobName).getProperties(),
      ).rejects.toMatchObject({ statusCode: 404 });
    }
    expect(await storage.read((tx) => tx.list("cleanup:"))).toEqual([]);
  });

  it("preserves consent boundaries, nickname conflicts, and linked membership atomically", async () => {
    const creator = user();
    const linked = user("Member Person");
    await addUser(creator);
    await addUser(linked);
    const club = await clubs.create(creator, clubInput());
    const input = {
      nickname: " Alice ",
      consent: true,
      firstName: "Alice",
      lastName: "Member",
      email: linked.email.toUpperCase(),
      clubAccess: "user" as const,
    };
    const player = await players.create(input, club.id);
    expect(player).toMatchObject({
      nickname: "Alice",
      clubAccess: "user",
      managerLocked: false,
      consentAt: expect.any(Date),
    });
    expect(await clubs.getRole(linked.id, club.id)).toBe("user");
    const rows = await storage.read((tx) => tx.list<Record<string, unknown>>(`club:${club.id}:`));
    expect(
      rows.find(({ rowKey }) => rowKey === `club:${club.id}:member:${linked.id}`),
    ).toMatchObject({ accessPlayerId: player.id });
    await expect(
      players.create(
        { nickname: "ALICE", consent: false, firstName: null, lastName: null, email: null },
        club.id,
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "players_club_nickname_unique_idx" });
    const withdrawn = await players.update(
      player.id,
      {
        nickname: "Alice",
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
        clubAccess: "none",
      },
      club.id,
      creator.id,
    );
    expect(withdrawn).toMatchObject({
      consent: false,
      consentAt: null,
      email: null,
      clubAccess: "none",
    });
    expect(await clubs.getRole(linked.id, club.id)).toBeNull();
    const stored = await storage.read((tx) =>
      tx.get<Record<string, unknown>>(`club:${club.id}:player:${player.id}`),
    );
    expect(stored).not.toHaveProperty("email");
    expect(stored).not.toHaveProperty("userId");
  });

  it("protects Owner even after consent withdrawal and hides retired profiles without erasing history", async () => {
    const creator = user();
    await addUser(creator);
    const club = await clubs.create(creator, clubInput());
    const owner = (await players.list(club.id))[0]!;
    const withdrawn = await players.update(
      owner.id,
      {
        nickname: "Owner",
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
        clubAccess: "manager",
      },
      club.id,
      creator.id,
    );
    expect(withdrawn).toMatchObject({ managerLocked: true, consent: false, consentAt: null });
    expect(await clubs.getRole(creator.id, club.id)).toBe("manager");
    await expect(
      players.update(
        owner.id,
        {
          nickname: "Other",
          consent: true,
          firstName: "Other",
          lastName: "Editor",
          email: creator.email,
          clubAccess: "manager",
        },
        club.id,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "owner_profile_forbidden" });
    expect(await players.delete(owner.id, club.id)).toBe("manager_locked");
    const ordinary = await players.create(
      { nickname: "Retire Me", consent: false, firstName: null, lastName: null, email: null },
      club.id,
    );
    const friend = await players.create(
      { nickname: "Friend", consent: false, firstName: null, lastName: null, email: null },
      club.id,
    );
    const gameId = randomUUID();
    await storage.mutate(async (tx) => {
      await tx.set(`club:${club.id}:result:${gameId}:${ordinary.id}`, {
        gameId,
        playerId: ordinary.id,
        isHost: false,
        playedAt: new Date(),
        outcome: "red",
        team: "red",
        won: true,
      });
      await tx.set(`club:${club.id}:result:${gameId}:${friend.id}`, {
        gameId,
        playerId: friend.id,
        isHost: false,
        playedAt: new Date(),
        outcome: "red",
        team: "red",
        won: true,
      });
    });
    expect(await players.delete(ordinary.id, club.id)).toBe("deleted");
    expect((await players.get(friend.id, club.id))?.statistics).toMatchObject({
      gamesPlayed: 1,
      wins: 1,
    });
    expect(
      await storage.read((tx) => tx.get(`club:${club.id}:result:${gameId}:${ordinary.id}`)),
    ).toMatchObject({ playerId: ordinary.id, won: true });
    expect(await players.get(ordinary.id, club.id)).toBeNull();
    expect(await players.delete(ordinary.id, club.id)).toBe("not_found");
    expect(
      await storage.read((tx) =>
        tx.get<Record<string, unknown>>(`club:${club.id}:player:${ordinary.id}`),
      ),
    ).toMatchObject({
      id: ordinary.id,
      consent: false,
      clubAccess: "none",
      retiredAt: expect.any(Date),
    });
    expect(
      (
        await players.create(
          { nickname: "Retire Me", consent: false, firstName: null, lastName: null, email: null },
          club.id,
        )
      ).id,
    ).not.toBe(ordinary.id);
  });

  it("claims pending verified email matches across clubs without stealing independent memberships", async () => {
    const creator = user();
    const claimant = user();
    await addUser(creator);
    const first = await clubs.create(creator, clubInput());
    const second = await clubs.create(creator, clubInput());
    const pending = await players.create(
      {
        nickname: "Pending",
        consent: true,
        firstName: "Pending",
        lastName: "User",
        email: claimant.email.toUpperCase(),
        clubAccess: "manager",
      },
      first.id,
    );
    const independent = await players.create(
      {
        nickname: "Independent",
        consent: true,
        firstName: "Independent",
        lastName: "User",
        email: claimant.email,
        clubAccess: "user",
      },
      second.id,
    );
    await addUser(claimant);
    await storage.mutate((tx) =>
      tx.set(`club:${second.id}:member:${claimant.id}`, {
        userId: claimant.id,
        role: "manager",
      }),
    );
    await clubs.claimClubAccess(claimant.id.toUpperCase(), claimant.email);
    await clubs.claimClubAccess(claimant.id, claimant.email);
    expect(await clubs.getRole(claimant.id, first.id)).toBe("manager");
    expect(await clubs.getRole(claimant.id, second.id)).toBe("manager");
    expect(
      await storage.read((tx) =>
        tx.get<Record<string, unknown>>(`club:${first.id}:player:${pending.id}`),
      ),
    ).toMatchObject({ userId: claimant.id });
    expect(
      await storage.read((tx) =>
        tx.get<Record<string, unknown>>(`club:${second.id}:player:${independent.id}`),
      ),
    ).toMatchObject({ userId: claimant.id });
    expect(
      await storage.read((tx) =>
        tx.get<Record<string, unknown>>(`club:${second.id}:member:${claimant.id}`),
      ),
    ).not.toHaveProperty("accessPlayerId");
  });

  it("does not claim pending profiles for a user absent from the account store", async () => {
    const creator = user();
    const absent = user();
    await addUser(creator);
    const club = await clubs.create(creator, clubInput());
    const player = await players.create(
      {
        nickname: "Pending",
        consent: true,
        firstName: "Pending",
        lastName: "Person",
        email: absent.email,
        clubAccess: "user",
      },
      club.id,
    );
    await expect(clubs.claimClubAccess(absent.id, absent.email)).rejects.toMatchObject({
      code: "23503",
    });
    expect(
      await storage.read((tx) => tx.get(`club:${club.id}:player:${player.id}`)),
    ).not.toHaveProperty("userId");
    expect(await clubs.getRole(absent.id, club.id)).toBeNull();
  });

  it("aggregates host, red/black, draws and corrected result projections in one club scan", async () => {
    const creator = user();
    await addUser(creator);
    const club = await clubs.create(creator, clubInput());
    const host = (await players.list(club.id))[0]!;
    const participant = await players.create(
      { nickname: "Participant", consent: false, firstName: null, lastName: null, email: null },
      club.id,
    );
    const older = new Date("2026-08-16T20:00:00.000Z");
    const newer = new Date("2026-08-17T20:00:00.000Z");
    await storage.mutate(async (tx) => {
      await tx.set(`club:${club.id}:result:${randomUUID()}:${host.id}`, {
        gameId: randomUUID(),
        playerId: host.id.toUpperCase(),
        isHost: true,
        playedAt: newer,
        outcome: "red",
      });
      await tx.set(`club:${club.id}:result:${randomUUID()}:${participant.id}`, {
        gameId: randomUUID(),
        playerId: participant.id.toUpperCase(),
        isHost: false,
        playedAt: older,
        outcome: "red",
        team: "red",
        role: "sheriff",
        status: "eliminated",
        won: true,
        fouls: 2,
        bestMoveHits: 0,
      });
      await tx.set(`club:${club.id}:result:${randomUUID()}:${participant.id}`, {
        gameId: randomUUID(),
        playerId: participant.id,
        isHost: false,
        playedAt: newer,
        outcome: "draw",
        team: "black",
        role: "mafia",
        status: "red-carded",
        fouls: 1,
      });
    });
    expect(await players.get(host.id, club.id)).toMatchObject({
      lastPlayedAt: newer,
      statistics: { hostedGames: 1, gamesPlayed: 0 },
    });
    expect(await players.get(participant.id, club.id)).toMatchObject({
      lastPlayedAt: newer,
      statistics: {
        hostedGames: 0,
        gamesPlayed: 2,
        wins: 1,
        losses: 0,
        redGames: 1,
        redWins: 1,
        blackGames: 1,
        blackWins: 0,
        sheriffGames: 1,
        mafiaGames: 1,
        totalFouls: 3,
        eliminations: 1,
        redCards: 1,
        bestMoves: 1,
        bestMoveMafiaHits: 0,
      },
    });
  });

  it("blocks retirement from an active authoritative partial snapshot, not just projection rows", async () => {
    const creator = user();
    await addUser(creator);
    const club = await clubs.create(creator, clubInput());
    const player = await players.create(
      { nickname: "Active", consent: false, firstName: null, lastName: null, email: null },
      club.id,
    );
    const host = await players.create(
      { nickname: "Active Host", consent: false, firstName: null, lastName: null, email: null },
      club.id,
    );
    const gameId = randomUUID();
    await storage.mutate(async (tx) => {
      const ref = await tx.writeBlob(
        {
          formatVersion: 1,
          session: {
            state: {
              hostPlayerId: host.id.toUpperCase(),
              setup: { selectedPlayerIds: [player.id.toUpperCase()] },
            },
          },
          events: [],
        },
        `club/${club.id}/game`,
      );
      await tx.set(`club:${club.id}:game:${gameId}`, {
        gameId,
        status: "active",
        blobName: ref.name,
        blobSha256: ref.sha256,
        blobLength: ref.length,
      });
    });
    expect(await players.delete(player.id, club.id)).toBe("active_game");
    expect(await players.delete(host.id, club.id)).toBe("active_game");
    expect(await players.get(player.id, club.id)).not.toBeNull();
  });

  it("tombstones then resumably removes all club rows in bounded groups, preserving other clubs", async () => {
    const creator = user();
    await addUser(creator);
    const doomed = await clubs.create(creator, clubInput());
    const survivor = await clubs.create(creator, clubInput());
    // Seed realistic families without exceeding the fixture's 98-action transaction budget.
    for (let offset = 0; offset < 150; offset += 50) {
      await storage.mutate(async (tx) => {
        for (let n = offset; n < offset + 50; n++)
          await tx.set(`club:${doomed.id}:result:${randomUUID()}:${randomUUID()}`, {
            gameId: randomUUID(),
            playerId: randomUUID(),
            isHost: false,
            playedAt: new Date(),
            outcome: "red",
          });
      });
    }
    expect(await clubs.delete(randomUUID(), doomed.id)).toBe(false);
    expect(await clubs.delete(creator.id, doomed.id)).toBe(true);
    expect(await clubs.getRole(creator.id, doomed.id)).toBeNull();
    expect(await clubs.listForUser(creator.id)).toMatchObject([{ id: survivor.id }]);
    expect(await players.list(doomed.id)).toEqual([]);
    expect(await storage.read((tx) => tx.list(`club:${doomed.id}:`))).toEqual([]);
    expect(await storage.read((tx) => tx.get(`deleted-club:${doomed.id}`))).toMatchObject({
      userId: creator.id,
    });
    expect(await clubs.delete(creator.id, doomed.id)).toBe(true);
    expect(await clubs.delete(randomUUID(), doomed.id)).toBe(false);
  });

  it("keeps a failed purge hidden and lets the original manager resume it", async () => {
    const creator = user();
    await addUser(creator);
    const club = await clubs.create(creator, clubInput());
    const gameId = randomUUID();
    const ref = await storage.mutate(async (tx) => {
      const written = await tx.writeBlob(
        { secret: "club record" },
        `club/${club.id}/game/${gameId}`,
      );
      await tx.set(`club:${club.id}:game:${gameId}`, {
        gameId,
        status: "completed",
        blobName: written.name,
        blobSha256: written.sha256,
        blobLength: written.length,
      });
      return written;
    });
    const deleteBlob = vi
      .spyOn(storage, "deleteBlob")
      .mockRejectedValueOnce(new Error("simulated outage"));
    try {
      await expect(clubs.delete(creator.id, club.id)).rejects.toThrow("simulated outage");
    } finally {
      deleteBlob.mockRestore();
    }
    expect(await clubs.getRole(creator.id, club.id)).toBeNull();
    expect(await storage.read((tx) => tx.get(`deleted-club:${club.id}`))).toMatchObject({
      userId: creator.id,
    });
    expect(await clubs.delete(randomUUID(), club.id)).toBe(false);
    expect(await clubs.delete(creator.id, club.id)).toBe(true);
    expect(await storage.read((tx) => tx.list(`club:${club.id}:`))).toEqual([]);
    await expect(storage.blobs.getBlockBlobClient(ref.name).getProperties()).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("preserves the authenticated club boundary for profile reads and writes", async () => {
    const creator = user();
    const participant = user();
    await addUser(creator);
    await addUser(participant);
    const club = await clubs.create(creator, clubInput());
    const other = await clubs.create(creator, clubInput());
    await players.create(
      {
        nickname: "Linked",
        consent: true,
        firstName: "Linked",
        lastName: "User",
        email: participant.email,
        clubAccess: "user",
      },
      club.id,
    );
    expect(
      await storage.runAuthorized(participant.id, club.id, false, () => players.list(club.id)),
    ).toHaveLength(2);
    await expect(
      storage.runAuthorized(participant.id, club.id, true, () =>
        players.create(
          { nickname: "Forbidden", consent: false, firstName: null, lastName: null, email: null },
          club.id,
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "club_manager_required" });
    await expect(
      storage.runAuthorized(participant.id, other.id, false, () => players.list(other.id)),
    ).rejects.toMatchObject({ statusCode: 403, code: "club_access_denied" });
    expect(await players.get(randomUUID(), other.id)).toBeNull();
  });

  it("rejects unconsented identity fields and preserves stored profiles on conflict", async () => {
    const creator = user();
    await addUser(creator);
    const club = await clubs.create(creator, clubInput());
    await expect(
      players.create(
        { nickname: "Private", consent: false, firstName: "Leaked", lastName: null, email: null },
        club.id,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const original = await players.create(
      {
        nickname: "Clara",
        consent: true,
        firstName: "Clara",
        lastName: "Dev",
        email: "CLARA@example.test",
        clubAccess: "user",
      },
      club.id,
    );
    const other = await players.create(
      {
        nickname: "Eve",
        consent: true,
        firstName: "Eve",
        lastName: "Dev",
        email: "eve@example.test",
        clubAccess: "user",
      },
      club.id,
    );
    await expect(
      players.update(
        other.id,
        {
          nickname: "Eve",
          consent: true,
          firstName: "Eve",
          lastName: "Dev",
          email: " clara@EXAMPLE.test ",
          clubAccess: "user",
        },
        club.id,
        creator.id,
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "players_club_access_email_unique_idx" });
    expect(await players.get(other.id, club.id)).toMatchObject({ email: "eve@example.test" });
    expect(await players.get(original.id, club.id)).toMatchObject({ email: "CLARA@example.test" });
    expect(await storage.read((tx) => tx.list(`club:${club.id}:nickname:`))).toHaveLength(3);
  });
});
