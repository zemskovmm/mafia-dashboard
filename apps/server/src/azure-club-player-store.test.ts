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
      language: "ru",
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
    expect(rows.find(({ rowKey }) => rowKey.includes(":player:"))).toMatchObject({
      userId: creator.id,
    });
  });

  it("resolves persisted identity for legacy ID callers and duplicates a one-word name", async () => {
    const creator = user("Prince");
    await addUser(creator);
    const club = await clubs.create(creator.id, clubInput());
    expect(await players.list(club.id)).toMatchObject([
      {
        nickname: "Owner",
        firstName: "Prince",
        lastName: "Prince",
        email: creator.email,
        clubAccess: "manager",
        managerLocked: true,
      },
    ]);
    expect(
      await clubs.update(creator.id, club.id, { ...clubInput(), bestMoveEnabled: true }),
    ).toMatchObject({ role: "manager", language: "ru", bestMoveEnabled: true });
  });

  it("does not steal linked managers or downgrade creator memberships", async () => {
    const creator = user();
    const stranger = user();
    await addUser(creator);
    await addUser(stranger);
    const club = await clubs.create(creator, clubInput());
    const owner = (await players.list(club.id))[0]!;
    await clubs.claimClubAccess(creator.id, creator.email.toUpperCase());
    await clubs.claimClubAccess(stranger.id, creator.email);
    expect(await storage.read((tx) => tx.get(`club:${club.id}:player:${owner.id}`))).toMatchObject({
      userId: creator.id,
    });
    expect(await clubs.getRole(creator.id, club.id)).toBe("manager");
    expect(await clubs.listForUser(stranger.id)).toEqual([]);
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
    const member = user();
    await addUser(member);
    await storage.mutate((tx) =>
      tx.set(`club:${club.id}:member:${member.id}`, {
        userId: member.id,
        role: "user",
      }),
    );
    expect(
      await clubs.update(member.id, club.id, {
        ...clubInput(),
        language: "en",
        bestMoveEnabled: true,
      }),
    ).toBeNull();
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
      language: "en",
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
      firstName: "Alice",
      lastName: "Member",
      email: linked.email.toUpperCase(),
      consent: true,
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

  it.each(["original", "uppercase"])(
    "revokes only profile-derived access when retiring an %s player UUID",
    async (spelling) => {
      const creator = user();
      const linked = user("Linked Member");
      const friend = user("Other Member");
      for (const account of [creator, linked, friend]) await addUser(account);
      const club = await clubs.create(creator, clubInput());
      const otherClub = await clubs.create(linked, clubInput());
      const input = {
        nickname: "Linked",
        consent: true,
        firstName: "Linked",
        lastName: "Member",
        email: linked.email,
        clubAccess: "user" as const,
      };
      const player = await players.create(input, club.id);
      await players.create({ ...input, nickname: "Friend", email: friend.email }, club.id);
      expect(await clubs.getRole(linked.id, club.id)).toBe("user");

      const requestId = spelling === "uppercase" ? player.id.toUpperCase() : player.id;
      expect(await players.delete(requestId, club.id)).toBe("deleted");
      expect(await clubs.getRole(linked.id, club.id)).toBeNull();
      expect(await players.get(player.id, club.id)).toBeNull();
      expect(
        await storage.read((tx) => tx.get(`club:${club.id}:player:${player.id}`)),
      ).toMatchObject({ id: player.id, retiredAt: expect.any(Date), clubAccess: "none" });
      expect(await clubs.getRole(creator.id, club.id)).toBe("manager");
      expect(await clubs.getRole(friend.id, club.id)).toBe("user");
      expect(await clubs.getRole(linked.id, otherClub.id)).toBe("manager");
    },
  );

  it("protects Owner even after consent withdrawal and hides retired profiles without erasing history", async () => {
    const creator = user();
    const editor = user("Owner Profile Editor");
    await addUser(creator);
    await addUser(editor);
    const club = await clubs.create(creator, clubInput());
    await storage.mutate((tx) =>
      tx.set(`club:${club.id}:member:${editor.id}`, {
        userId: editor.id,
        role: "manager",
      }),
    );
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
    const beforeForbidden = await players.get(owner.id, club.id);
    expect(await clubs.getRole(creator.id, club.id)).toBe("manager");
    await expect(
      players.update(
        owner.id,
        {
          nickname: "Other",
          consent: true,
          firstName: "Other",
          lastName: "Editor",
          email: editor.email,
          clubAccess: "manager",
        },
        club.id,
        editor.id,
      ),
    ).rejects.toMatchObject({
      name: "OwnerProfileForbiddenError",
      code: "owner_profile_forbidden",
    });
    expect(await players.get(owner.id, club.id)).toEqual(beforeForbidden);
    expect(await players.delete(owner.id, club.id)).toBe("manager_locked");
    const ordinary = await players.create(
      {
        nickname: "Retire Me",
        consent: true,
        firstName: "Retire",
        lastName: "Me",
        email: "retire@example.test",
      },
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
        seat: 1,
      });
      await tx.set(`club:${club.id}:result:${gameId}:${friend.id}`, {
        gameId,
        playerId: friend.id,
        isHost: false,
        playedAt: new Date(),
        outcome: "red",
        team: "black",
        won: false,
        seat: 2,
      });
      await tx.set(`club:${club.id}:result:${gameId}:${owner.id}`, {
        gameId,
        playerId: owner.id,
        isHost: true,
        playedAt: new Date(),
        outcome: "red",
      });
    });
    expect(await players.delete(ordinary.id, club.id)).toBe("deleted");
    expect((await players.get(friend.id, club.id))?.statistics).toMatchObject({
      gamesPlayed: 1,
      losses: 1,
    });
    expect((await players.get(owner.id, club.id))?.statistics).toMatchObject({
      hostedGames: 1,
      gamesPlayed: 0,
    });
    expect((await players.list(club.id)).map(({ id }) => id)).not.toContain(ordinary.id);
    expect(
      await storage.read((tx) => tx.get(`club:${club.id}:result:${gameId}:${ordinary.id}`)),
    ).toMatchObject({ playerId: ordinary.id, seat: 1, won: true });
    expect(
      await storage.read((tx) => tx.get(`club:${club.id}:result:${gameId}:${friend.id}`)),
    ).toMatchObject({ playerId: friend.id, seat: 2, won: false });
    expect(await players.get(owner.id, club.id)).toMatchObject({ lastPlayedAt: expect.any(Date) });
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
    const retired = await storage.read((tx) => tx.get(`club:${club.id}:player:${ordinary.id}`));
    for (const field of ["nickname", "firstName", "lastName", "email", "userId", "consentAt"])
      expect(retired).not.toHaveProperty(field);
    expect(
      (
        await players.create(
          { nickname: "Retire Me", consent: false, firstName: null, lastName: null, email: null },
          club.id,
        )
      ).id,
    ).not.toBe(ordinary.id);
  });

  it.each(["user", "manager"] as const)(
    "claims pending %s access case-insensitively and idempotently without changing independent memberships",
    async (access) => {
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
          clubAccess: access,
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
          clubAccess: access === "user" ? "manager" : "user",
        },
        second.id,
      );
      await addUser(claimant);
      await storage.mutate((tx) =>
        tx.set(`club:${second.id}:member:${claimant.id}`, {
          userId: claimant.id,
          role: access,
        }),
      );
      await clubs.claimClubAccess(claimant.id.toUpperCase(), claimant.email);
      await clubs.claimClubAccess(claimant.id, claimant.email);
      expect(await clubs.getRole(claimant.id, first.id)).toBe(access);
      expect(await clubs.getRole(claimant.id, second.id)).toBe(access);
      expect(await clubs.listForUser(claimant.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: first.id, role: access }),
          expect.objectContaining({ id: second.id, role: access }),
        ]),
      );
      expect(
        await storage.read((tx) => tx.get(`club:${first.id}:member:${claimant.id}`)),
      ).toMatchObject({ accessPlayerId: pending.id });
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
    },
  );

  it.each(["none", "user", "manager"] as const)(
    "links and promotes a consented %s profile, then revokes only its own club access",
    async (initialAccess) => {
      const creator = user();
      const linked = user();
      await addUser(creator);
      await addUser(linked);
      const club = await clubs.create(creator, clubInput());
      const other = await clubs.create(creator, clubInput());
      const input = {
        nickname: "Linked",
        consent: true,
        firstName: "Linked",
        lastName: "User",
        email: linked.email.toUpperCase(),
        clubAccess: initialAccess,
      };
      const player = await players.create(input, club.id);
      const otherPlayer = await players.create({ ...input, clubAccess: "manager" }, other.id);
      expect(player).toMatchObject({ clubAccess: initialAccess, managerLocked: false });
      expect(await clubs.getRole(linked.id, club.id)).toBe(
        initialAccess === "none" ? null : initialAccess,
      );
      if (initialAccess !== "none") {
        expect(
          await storage.read((tx) => tx.get(`club:${club.id}:member:${linked.id}`)),
        ).toMatchObject({ role: initialAccess, accessPlayerId: player.id });
        expect(
          await storage.read((tx) => tx.get(`club:${club.id}:player:${player.id}`)),
        ).toMatchObject({ userId: linked.id });
      }
      expect(
        await players.update(player.id, { ...input, clubAccess: "manager" }, club.id, creator.id),
      ).toMatchObject({ clubAccess: "manager", managerLocked: false });
      expect(await clubs.getRole(linked.id, club.id)).toBe("manager");
      expect(
        await players.update(player.id, { ...input, clubAccess: "none" }, club.id, creator.id),
      ).toMatchObject({ clubAccess: "none", managerLocked: false });
      expect(await clubs.getRole(linked.id, club.id)).toBeNull();
      expect(
        await storage.read((tx) => tx.get(`club:${club.id}:player:${player.id}`)),
      ).not.toHaveProperty("userId");
      expect(await clubs.getRole(linked.id, other.id)).toBe("manager");
      expect(
        await storage.read((tx) => tx.get(`club:${other.id}:player:${otherPlayer.id}`)),
      ).toMatchObject({ userId: linked.id });
    },
  );

  it.each(["demotion", "deletion"] as const)(
    "preserves independent manager membership after profile %s",
    async (operation) => {
      const creator = user();
      const linked = user();
      await addUser(creator);
      await addUser(linked);
      const club = await clubs.create(creator, clubInput());
      await storage.mutate((tx) =>
        tx.set(`club:${club.id}:member:${linked.id}`, {
          userId: linked.id,
          role: "manager",
        }),
      );
      const input = {
        nickname: "Independent",
        consent: true,
        firstName: "Independent",
        lastName: "Manager",
        email: linked.email,
        clubAccess: "manager" as const,
      };
      const player = await players.create(
        { ...input, clubAccess: operation === "deletion" ? "manager" : "none" },
        club.id,
      );
      if (operation === "demotion") await players.update(player.id, input, club.id, linked.id);
      expect(
        await storage.read((tx) => tx.get(`club:${club.id}:member:${linked.id}`)),
      ).not.toHaveProperty("accessPlayerId");
      if (operation === "demotion") {
        expect(
          await players.update(player.id, { ...input, clubAccess: "none" }, club.id, linked.id),
        ).toMatchObject({ clubAccess: "none", managerLocked: false });
      } else {
        expect(await players.delete(player.id, club.id)).toBe("deleted");
        expect(await players.get(player.id, club.id)).toBeNull();
      }
      expect(await clubs.getRole(linked.id, club.id)).toBe("manager");
      expect(
        await storage.read((tx) => tx.get(`club:${club.id}:member:${linked.id}`)),
      ).not.toHaveProperty("accessPlayerId");
      expect(
        await storage.read((tx) => tx.get(`club:${club.id}:player:${player.id}`)),
      ).not.toHaveProperty("userId");
    },
  );

  it("keeps unknown managers pending, relinks changed email, and deletes only linked access", async () => {
    const creator = user();
    const linked = user();
    await addUser(creator);
    await addUser(linked);
    const club = await clubs.create(creator, clubInput());
    const other = await clubs.create(linked, clubInput());
    const input = {
      nickname: "Pending",
      consent: true,
      firstName: "Pending",
      lastName: "Manager",
      email: `unknown-${randomUUID()}@example.test`,
      clubAccess: "manager" as const,
    };
    const player = await players.create(input, club.id);
    expect(player).toMatchObject({
      clubAccess: "manager",
      managerLocked: false,
      email: input.email,
    });
    expect(
      await storage.read((tx) => tx.get(`club:${club.id}:player:${player.id}`)),
    ).not.toHaveProperty("userId");
    expect(await storage.read((tx) => tx.list(`club:${club.id}:member:`))).toHaveLength(1);
    expect(
      await players.update(player.id, { ...input, email: linked.email }, club.id, creator.id),
    ).toMatchObject({ clubAccess: "manager", managerLocked: false, email: linked.email });
    expect(await storage.read((tx) => tx.get(`club:${club.id}:player:${player.id}`))).toMatchObject(
      { userId: linked.id },
    );
    expect(await storage.read((tx) => tx.get(`club:${club.id}:member:${linked.id}`))).toMatchObject(
      { role: "manager", accessPlayerId: player.id },
    );
    expect(await players.delete(player.id, club.id)).toBe("deleted");
    expect(await clubs.getRole(linked.id, club.id)).toBeNull();
    expect(await clubs.getRole(creator.id, club.id)).toBe("manager");
    expect(await clubs.getRole(linked.id, other.id)).toBe("manager");
  });

  it("preserves the Owner link through email edits, consent restoration, and rejected demotion", async () => {
    const creator = user();
    const other = user();
    await addUser(creator);
    await addUser(other);
    const club = await clubs.create(creator, clubInput());
    const owner = (await players.list(club.id))[0]!;
    const input = {
      nickname: "Owner",
      consent: true,
      firstName: "Edited",
      lastName: "Owner",
      email: other.email,
      clubAccess: "manager" as const,
    };
    expect(await players.update(owner.id, input, club.id, creator.id)).toMatchObject({
      email: other.email,
      clubAccess: "manager",
      managerLocked: true,
    });
    expect(await storage.read((tx) => tx.get(`club:${club.id}:player:${owner.id}`))).toMatchObject({
      userId: creator.id,
    });
    expect(await clubs.getRole(other.id, club.id)).toBeNull();
    await expect(
      players.update(owner.id, { ...input, clubAccess: "none" }, club.id, creator.id),
    ).rejects.toMatchObject({ name: "ManagerLockedError", code: "manager_locked" });
    expect(
      await players.update(
        owner.id,
        { ...input, consent: false, firstName: null, lastName: null, email: null },
        club.id,
        creator.id,
      ),
    ).toMatchObject({
      consent: false,
      consentAt: null,
      firstName: null,
      lastName: null,
      email: null,
      clubAccess: "manager",
      managerLocked: true,
    });
    expect(await storage.read((tx) => tx.get(`club:${club.id}:player:${owner.id}`))).toMatchObject({
      userId: creator.id,
    });
    expect(await clubs.getRole(creator.id, club.id)).toBe("manager");
    expect(
      await storage.read((tx) => tx.get(`club:${club.id}:member:${creator.id}`)),
    ).not.toHaveProperty("accessPlayerId");
    expect(
      await players.update(owner.id, { ...input, email: creator.email }, club.id, creator.id),
    ).toMatchObject({
      consent: true,
      consentAt: expect.any(Date),
      firstName: "Edited",
      lastName: "Owner",
      email: creator.email,
      clubAccess: "manager",
      managerLocked: true,
    });
    expect(await clubs.getRole(other.id, club.id)).toBeNull();
    expect(await players.delete(owner.id, club.id)).toBe("manager_locked");
    expect(await players.get(owner.id, club.id)).toMatchObject({
      managerLocked: true,
      clubAccess: "manager",
    });
    expect(await clubs.getRole(creator.id, club.id)).toBe("manager");
  });

  it("does not retain removed result mutation APIs", () => {
    for (const method of ["saveGameResults", "deleteGameResults", "backfillGameResults"])
      expect(players).not.toHaveProperty(method);
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

  it("orders profiles by current last-played results and reads complete final-result statistics", async () => {
    const creator = user();
    await addUser(creator);
    const club = await clubs.create(creator, clubInput());
    const host = (await players.list(club.id))[0]!;
    const input = { consent: false, firstName: null, lastName: null, email: null };
    const never = await players.create({ ...input, nickname: "Zulu" }, club.id);
    expect(never).toMatchObject({
      nickname: "Zulu",
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
    const older = await players.create({ ...input, nickname: "Alpha" }, club.id);
    const newer = await players.create({ ...input, nickname: "Beta" }, club.id);
    const olderTime = new Date("2026-08-16T20:00:00.000Z");
    const newerTime = new Date("2026-08-17T20:00:00.000Z");
    const oldGameId = randomUUID();
    const newGameId = randomUUID();
    await storage.mutate(async (tx) => {
      await tx.set(`club:${club.id}:result:${oldGameId}:${older.id}`, {
        gameId: oldGameId,
        playerId: older.id,
        isHost: false,
        playedAt: olderTime,
        outcome: "red",
        team: "red",
        role: "sheriff",
        status: "eliminated",
        won: true,
        fouls: 2,
        bestMoveHits: 2,
      });
      await tx.set(`club:${club.id}:result:${newGameId}:${newer.id}`, {
        gameId: newGameId,
        playerId: newer.id,
        isHost: false,
        playedAt: newerTime,
        outcome: "red",
        team: "black",
        role: "mafia",
        status: "active",
        won: false,
        fouls: 0,
      });
      await tx.set(`club:${club.id}:result:${oldGameId}:${host.id}`, {
        gameId: oldGameId,
        playerId: host.id,
        isHost: true,
        playedAt: olderTime,
        outcome: "red",
      });
    });
    expect(await players.get(host.id, club.id)).toMatchObject({
      lastPlayedAt: olderTime,
      statistics: { hostedGames: 1, gamesPlayed: 0, wins: 0 },
    });
    expect(await players.get(older.id, club.id)).toMatchObject({
      lastPlayedAt: olderTime,
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
    expect(await players.get(never.id, club.id)).toMatchObject({ lastPlayedAt: null });
    const ids = (await players.list(club.id)).map(({ id }) => id);
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
    expect(ids.indexOf(older.id)).toBeLessThan(ids.indexOf(never.id));
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
    expect(await players.get(host.id, club.id)).not.toBeNull();
    await storage.mutate(async (tx) => {
      await tx.set(`club:${club.id}:participant:${gameId}:${host.id}`, {
        gameId,
        playerId: host.id,
        isHost: true,
      });
      await tx.set(`club:${club.id}:participant:${gameId}:${player.id}`, {
        gameId,
        playerId: player.id,
        isHost: false,
        seat: 1,
        role: "citizen",
      });
    });
    expect(await players.delete(player.id, club.id)).toBe("active_game");
    expect(await players.delete(host.id, club.id)).toBe("active_game");
    expect(await players.get(player.id, club.id)).not.toBeNull();
    expect(await players.get(host.id, club.id)).not.toBeNull();
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
