import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { DEFAULT_CLUB_ID } from "./club-store.js";

import type { AppUser, GoogleAuthService } from "./google-auth.js";
import type { PlayerProfile } from "./player-store.js";
import { AzurePlayerStore } from "./azure-club-player-store.js";
import { blobFields, blobReference } from "./azure-storage.js";
import type { GameEvent } from "./event-store.js";
import { createApplicationStorageFixture } from "./test-helpers/storage-fixture.js";
import type { YouTubeOAuthService } from "./youtube-oauth.js";

const authenticatedUser: AppUser = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "owner@mafiamalaga.es",
  name: "Mafia Malaga owner",
  picture: null,
};
const fixture = await createApplicationStorageFixture(authenticatedUser);
const { storage, stores, accounts } = fixture;
const seedUser = (user: Omit<AppUser, "picture"> & { picture?: string | null }) =>
  accounts.upsertUser({ ...user, picture: user.picture ?? null, subject: user.id });
const app = await buildApp({
  stores,
  authenticateRequest: async () => authenticatedUser,
  defaultClubId: DEFAULT_CLUB_ID,
});
const playerStore = new AzurePlayerStore(storage);
const roleDeck = [
  "sheriff",
  "citizen",
  "citizen",
  "citizen",
  "citizen",
  "citizen",
  "citizen",
  "mafia",
  "mafia",
  "don",
] as const;
const createSessionPlayers = async (clubId = DEFAULT_CLUB_ID) => {
  const players: PlayerProfile[] = [];
  for (let index = 0; index < 11; index++) {
    players.push(
      await playerStore.create(
        {
          nickname: `Session ${index + 1} ${randomUUID().slice(0, 8)}`,
          consent: false,
          firstName: null,
          lastName: null,
          email: null,
        },
        clubId,
      ),
    );
  }
  return players;
};
const roleGiveawayState = (
  selectedPlayers: readonly Pick<PlayerProfile, "id" | "nickname">[],
  host: Pick<PlayerProfile, "id" | "nickname">,
  assignedFirstRole = false,
) => ({
  setup: {
    step: "roles",
    hostPlayerId: host.id,
    selectedPlayerIds: selectedPlayers.map(({ id }) => id),
    setup: {
      step: "role-draw",
      players: selectedPlayers.map(({ id }, index) => ({
        id,
        seat: index + 1,
      })),
      roleDeck,
      remainingRoles: assignedFirstRole ? roleDeck.slice(1) : roleDeck,
      assignments: assignedFirstRole ? { "1": roleDeck[0] } : {},
    },
  },
  game: null,
  hostPlayerId: host.id,

  playlistId: "",
  log: [],
  undoHistory: [],
  undoBudget: 0,
  initialGame: null,
  events: [],
  headEventId: null,
  resetReturnEventId: null,
  legacyLog: [],
});

afterEach(async () => {
  const rows = await storage.read((tx) => tx.list<{ gameId?: string; status?: string }>("club:"));
  for (const row of rows) {
    if (row.rowKey.includes(":game:") && row.status === "active" && row.gameId)
      await stores.games.clear({ clubId: row.rowKey.split(":")[1]!, gameId: row.gameId });
  }
});

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await fixture.close();
});

describe("server API", () => {
  it("does not register obsolete raw game mutations or normalization", async () => {
    const gameId = randomUUID();
    const routes = [
      { method: "POST", url: `/api/game-sessions/${gameId}/normalize` },
      { method: "POST", url: "/api/games" },
      { method: "DELETE", url: `/api/games/${gameId}` },
      { method: "POST", url: `/api/games/${gameId}/events/truncate` },
      { method: "POST", url: `/api/games/${gameId}/events` },
      { method: "PUT", url: `/api/games/${gameId}/results` },
      { method: "DELETE", url: `/api/games/${gameId}/results` },
    ] as const;

    for (const route of routes) {
      const response = await app.inject(route);
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(404);
    }
    expect(await storage.getEntity(`club:${DEFAULT_CLUB_ID}:game:${gameId}`)).toBeUndefined();
  });

  it.each([
    "/api/game-sessions?status=completed&from=21-08-2026",
    "/api/game-sessions?status=completed&to=2026-08-32",
    "/api/game-sessions?status=completed&from=2026-08-22&to=2026-08-21",
    "/api/game-sessions?status=completed&playerId=not-a-uuid",
    "/api/game-sessions?status=completed&outcome=unknown",
    "/api/game-sessions?status=active&outcome=red",
  ])("rejects an invalid completed-history query: %s", async (url) => {
    const response = await app.inject({ method: "GET", url });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "validation_failed" });
  });

  it("accepts composable completed-history filters", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/game-sessions?status=completed&from=2026-08-21&to=2026-08-21&playerId=${randomUUID()}&outcome=draw`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sessions: [] });
  });

  it.each([
    ["missing", {}],
    ["false", { ownerConsent: false }],
  ])("rejects club creation with %s Owner consent", async (_label, consent) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/clubs",
      payload: {
        name: `No consent ${randomUUID().slice(0, 8)}`,
        city: "Nowhere",
        headerLogo: null,
        cardLogo: null,
        language: "en",
        ...consent,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "validation_failed" });
  });

  it.each([undefined, "es"])("rejects unsupported club language %s", async (language) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/clubs",
      payload: {
        name: `Invalid language ${randomUUID().slice(0, 8)}`,
        city: "Nowhere",
        headerLogo: null,
        cardLogo: null,
        ownerConsent: true,
        ...(language === undefined ? {} : { language }),
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "validation_failed" });
  });

  it("authenticates the owner, creates a club, and isolates its players", async () => {
    const auth = await app.inject({ method: "GET", url: "/api/auth/session" });
    expect(auth.json().user).toMatchObject(authenticatedUser);
    const authHeaders = {};

    const anonymousApp = await buildApp({
      stores,
      authenticateRequest: async () => null,
      defaultClubId: DEFAULT_CLUB_ID,
    });

    expect(
      await anonymousApp.inject({
        method: "POST",
        url: "/api/clubs",
        payload: {
          name: "Unauthorized",
          city: "Nowhere",
          headerLogo: null,
          cardLogo: null,
          language: "en",
          ownerConsent: true,
        },
      }),
    ).toHaveProperty("statusCode", 401);
    await anonymousApp.close();

    const initial = await app.inject({ method: "GET", url: "/api/clubs", headers: authHeaders });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().clubs).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Mafia Malaga", city: "Málaga" })]),
    );
    const defaultClubId = initial.json().clubs[0].id as string;

    const createdClub = await app.inject({
      method: "POST",
      url: "/api/clubs",
      headers: authHeaders,
      payload: {
        name: `Sevilla ${randomUUID().slice(0, 8)}`,
        city: "Sevilla",
        headerLogo: null,
        cardLogo: null,
        language: "ru",
        bestMoveEnabled: false,
        ownerConsent: true,
      },
    });
    expect(createdClub.statusCode).toBe(201);
    expect(createdClub.json().club.language).toBe("ru");
    expect(createdClub.json().club.bestMoveEnabled).toBe(false);
    const secondClubId = createdClub.json().club.id as string;

    const preservedSetting = await app.inject({
      method: "PUT",
      url: `/api/clubs/${secondClubId}`,
      headers: authHeaders,
      payload: {
        name: createdClub.json().club.name,
        city: "Sevilla",
        headerLogo: null,
        cardLogo: null,
        language: "ru",
      },
    });
    expect(preservedSetting.statusCode).toBe(200);
    expect(preservedSetting.json().club.bestMoveEnabled).toBe(false);

    const nickname = `Tenant-${randomUUID().slice(0, 8)}`;
    const createdPlayer = await app.inject({
      method: "POST",
      url: "/api/players",
      headers: { ...authHeaders, "x-club-id": secondClubId },
      payload: { nickname, consent: false, firstName: null, lastName: null, email: null },
    });
    expect(createdPlayer.statusCode).toBe(201);
    expect(
      await app.inject({
        method: "POST",
        url: "/api/players",
        headers: { ...authHeaders, "x-club-id": defaultClubId },
        payload: { nickname, consent: false, firstName: null, lastName: null, email: null },
      }),
    ).toHaveProperty("statusCode", 201);

    const secondPlayers = await app.inject({
      method: "GET",
      url: "/api/players",
      headers: { ...authHeaders, "x-club-id": secondClubId },
    });
    const firstPlayers = await app.inject({
      method: "GET",
      url: "/api/players",
      headers: { ...authHeaders, "x-club-id": defaultClubId },
    });
    expect(secondPlayers.json().players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nickname: "Owner",
          consent: true,
          email: authenticatedUser.email,
          clubAccess: "manager",
          managerLocked: true,
        }),
      ]),
    );
    expect(secondPlayers.json().players).toEqual(
      expect.arrayContaining([expect.objectContaining({ nickname })]),
    );
    expect(secondPlayers.json().players.map((player: { id: string }) => player.id)).toContain(
      createdPlayer.json().player.id,
    );
    expect(firstPlayers.json().players).toEqual(
      expect.arrayContaining([expect.objectContaining({ nickname })]),
    );
    expect(
      firstPlayers
        .json()
        .players.find((player: { nickname: string }) => player.nickname === nickname).id,
    ).not.toBe(createdPlayer.json().player.id);
    expect(firstPlayers.json().players.map((player: { id: string }) => player.id)).not.toContain(
      createdPlayer.json().player.id,
    );

    const gamePlayers = await createSessionPlayers(secondClubId);
    const savedGame = await app.inject({
      method: "POST",
      url: "/api/game-sessions",
      headers: { ...authHeaders, "x-club-id": secondClubId },
      payload: {
        creationId: randomUUID(),
        name: "Tenant table",
        state: roleGiveawayState(gamePlayers.slice(0, 10), gamePlayers[10]!),
        results: null,
      },
    });
    expect(savedGame.statusCode).toBe(201);
    const gameId = savedGame.json().gameId as string;
    expect(
      await app.inject({
        method: "GET",
        url: `/api/game-sessions/${gameId}`,
        headers: { ...authHeaders, "x-club-id": defaultClubId },
      }),
    ).toHaveProperty("statusCode", 404);
    expect(
      await app.inject({
        method: "GET",
        url: `/api/game-sessions/${gameId}`,
        headers: { ...authHeaders, "x-club-id": secondClubId },
      }),
    ).toHaveProperty("statusCode", 200);

    const deletedClub = await app.inject({
      method: "DELETE",
      url: `/api/clubs/${secondClubId}`,
      headers: authHeaders,
    });
    expect(deletedClub.statusCode).toBe(204);
    const afterDelete = await app.inject({
      method: "GET",
      url: "/api/clubs",
      headers: authHeaders,
    });
    expect(afterDelete.json().clubs.map((club: { id: string }) => club.id)).not.toContain(
      secondClubId,
    );
    expect(await storage.read((tx) => tx.list(`club:${secondClubId}:`))).toEqual([]);
  });

  it("redirects browser pages from a direct host to the configured secure app origin", async () => {
    const secureApp = await buildApp({
      stores,
      publicAppUrl: "https://mbp16.tail102fab.ts.net",
    });
    await secureApp.ready();

    const response = await secureApp.inject({
      method: "GET",
      url: "/?music=connected",
      headers: {
        accept: "text/html",
        host: "100.95.109.89:8080",
      },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://mbp16.tail102fab.ts.net/?music=connected");
    await secureApp.close();
  });

  it("reports liveness and database readiness separately", async () => {
    const live = await app.inject({ method: "GET", url: "/health/live" });
    const ready = await app.inject({ method: "GET", url: "/health/ready" });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: "live" });
    expect(live.headers["permissions-policy"]).toBe("picture-in-picture=()");
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: "ready" });
  });

  it("reports an exact immutable release identity without caching", async () => {
    const versioned = await buildApp({
      stores,
      releaseIdentity: { version: "1.0.0", commit: "a".repeat(40) },
    });
    await versioned.ready();

    const response = await versioned.inject({ method: "GET", url: "/health/version" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ version: "1.0.0", commit: "a".repeat(40) });
    expect(response.headers["cache-control"]).toBe("no-store");
    await versioned.close();
  });

  it("redacts private event payloads and integrity hashes from public log requests", async () => {
    const created = await stores.games.create({
      creationId: randomUUID(),
      name: "Private log",
      state: {},
      results: null,
    });
    const gameId = created.gameId;
    const stateHashAfter = `sha256:${"a".repeat(64)}`;
    await storage.mutate(async (tx) => {
      const key = `club:${DEFAULT_CLUB_ID}:game:${gameId}`;
      const row = (await tx.get(key))!;
      const snapshot = await tx.readBlob<{
        events: Array<Omit<GameEvent, "createdAt"> & { createdAt: string }>;
      }>(blobReference(row));
      snapshot.events = [
        {
          id: randomUUID(),
          gameId,
          sequence: 1,
          idempotencyKey: "check-1",
          type: "sheriff.checked",
          phase: "night-sheriff",
          seat: 5,
          payload: { targetSeat: 8, match: true },
          stateHashAfter,
          parentEventId: null,
          replayVersion: 1,
          createdAt: new Date().toISOString(),
          duplicate: false,
        },
      ];
      const ref = await tx.writeBlob(snapshot, `club/${DEFAULT_CLUB_ID}/game/${gameId}`);
      const fields = Object.fromEntries(
        Object.entries(row).filter(([name]) => name !== "odata.metadata"),
      );
      await tx.set(key, { ...fields, ...blobFields(ref) });
      await tx.retireBlob(blobReference(row));
    });

    const host = await app.inject({ method: "GET", url: `/api/games/${gameId}/events` });
    const publicLog = await app.inject({
      method: "GET",
      url: `/api/games/${gameId}/events?visibility=public`,
    });

    expect(host.statusCode).toBe(200);
    expect(publicLog.statusCode).toBe(200);
    expect(host.json().events[0]).toMatchObject({
      payload: { targetSeat: 8, match: true },
      stateHashAfter,
    });
    expect(publicLog.json().events[0]).toMatchObject({
      payload: { redacted: true },
      stateHashAfter: null,
    });
  });

  it("creates consent-safe player profiles and rejects duplicate nicknames", async () => {
    const nickname = `Profile-${randomUUID().slice(0, 8)}`;
    const invalidManagerWithoutConsent = await app.inject({
      method: "POST",
      url: "/api/players",
      payload: {
        nickname: `Manager-${randomUUID().slice(0, 8)}`,
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
        clubAccess: "manager",
      },
    });
    expect(invalidManagerWithoutConsent.statusCode).toBe(400);
    expect(invalidManagerWithoutConsent.json()).toMatchObject({ error: "validation_failed" });

    const invalidWithoutConsent = await app.inject({
      method: "POST",
      url: "/api/players",
      payload: {
        nickname,
        consent: false,
        firstName: "Must not be stored",
        lastName: null,
        email: null,
      },
    });
    expect(invalidWithoutConsent.statusCode).toBe(400);

    const created = await app.inject({
      method: "POST",
      url: "/api/players",
      payload: {
        nickname,
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().player).toMatchObject({
      nickname,
      consent: false,
      clubAccess: "none",
      managerLocked: false,
      firstName: null,
      lastName: null,
      email: null,
      statistics: { gamesPlayed: 0, wins: 0, losses: 0 },
    });

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/players",
      payload: {
        nickname: nickname.toUpperCase(),
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
      },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ error: "nickname_conflict" });

    const listed = await app.inject({ method: "GET", url: "/api/players" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().players).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.json().player.id, nickname })]),
    );
  });

  it("creates and updates a manager while returning manager fields", async () => {
    const manager = {
      id: randomUUID(),
      email: `api-manager-${randomUUID()}@example.test`,
      name: "API Manager",
    };
    await seedUser(manager);
    const created = await app.inject({
      method: "POST",
      url: "/api/players",
      payload: {
        nickname: `API manager ${randomUUID().slice(0, 8)}`,
        consent: true,
        firstName: "API",
        lastName: "Manager",
        email: manager.email.toUpperCase(),
        clubAccess: "manager",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().player).toMatchObject({ clubAccess: "manager", managerLocked: false });

    const updated = await app.inject({
      method: "PUT",
      url: `/api/players/${created.json().player.id}`,
      payload: {
        nickname: `${created.json().player.nickname}-updated`,
        consent: true,
        firstName: "API",
        lastName: "Manager",
        email: manager.email,
        clubAccess: "manager",
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().player).toMatchObject({ clubAccess: "manager", managerLocked: false });
  });

  it("returns club_access_consent_required when an unlinked player is promoted without consent", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/players",
      payload: {
        nickname: `Unlinked manager ${randomUUID().slice(0, 8)}`,
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
      },
    });
    expect(created.statusCode).toBe(201);

    const response = await app.inject({
      method: "PUT",
      url: `/api/players/${created.json().player.id}`,
      payload: {
        nickname: created.json().player.nickname,
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
        clubAccess: "manager",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "club_access_consent_required" });
  });

  it("returns club_access_email_conflict separately from nickname conflicts", async () => {
    const email = `pending-conflict-${randomUUID()}@example.test`;
    const profile = {
      consent: true,
      firstName: "Pending",
      lastName: "Manager",
      email,
      clubAccess: "manager",
    };
    const first = await app.inject({
      method: "POST",
      url: "/api/players",
      payload: { ...profile, nickname: `Pending manager ${randomUUID().slice(0, 8)}` },
    });
    const conflict = await app.inject({
      method: "POST",
      url: "/api/players",
      payload: { ...profile, nickname: `Other manager ${randomUUID().slice(0, 8)}` },
    });

    expect(first.statusCode).toBe(201);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: "club_access_email_conflict" });

    const updateTarget = await app.inject({
      method: "POST",
      url: "/api/players",
      payload: {
        ...profile,
        email: `other-pending-${randomUUID()}@example.test`,
        nickname: `Update target ${randomUUID().slice(0, 8)}`,
      },
    });
    const updateConflict = await app.inject({
      method: "PUT",
      url: `/api/players/${updateTarget.json().player.id}`,
      payload: { ...profile, nickname: updateTarget.json().player.nickname },
    });
    expect(updateConflict.statusCode).toBe(409);
    expect(updateConflict.json()).toEqual({ error: "club_access_email_conflict" });

    const linkedUserId = randomUUID();
    const previousEmail = `linked-manager-${randomUUID()}@example.test`;
    const currentEmail = `renamed-manager-${randomUUID()}@example.test`;
    await seedUser({ id: linkedUserId, email: previousEmail, name: "Renamed Manager" });
    const linkedManager = await app.inject({
      method: "POST",
      url: "/api/players",
      payload: {
        ...profile,
        nickname: `Linked manager ${randomUUID().slice(0, 8)}`,
        email: previousEmail,
      },
    });
    expect(linkedManager.statusCode).toBe(201);
    await seedUser({ id: linkedUserId, email: currentEmail, name: "Renamed Manager" });

    const linkedUserConflict = await app.inject({
      method: "POST",
      url: "/api/players",
      payload: {
        ...profile,
        nickname: `Relinked manager ${randomUUID().slice(0, 8)}`,
        email: currentEmail,
      },
    });
    expect(linkedUserConflict.statusCode).toBe(409);
    expect(linkedUserConflict.json()).toEqual({ error: "club_access_email_conflict" });
  });

  it("allows the linked creator to withdraw Owner profile consent", async () => {
    const createdClub = await app.inject({
      method: "POST",
      url: "/api/clubs",
      payload: {
        name: `Withdraw consent ${randomUUID().slice(0, 8)}`,
        city: "Granada",
        headerLogo: null,
        cardLogo: null,
        language: "en",
        ownerConsent: true,
      },
    });
    expect(createdClub.statusCode).toBe(201);
    const clubId = createdClub.json().club.id as string;
    const listed = await app.inject({
      method: "GET",
      url: "/api/players",
      headers: { "x-club-id": clubId },
    });
    const owner = listed
      .json()
      .players.find((player: { managerLocked: boolean }) => player.managerLocked);
    expect(owner).toBeDefined();

    const response = await app.inject({
      method: "PUT",
      url: `/api/players/${owner.id}`,
      headers: { "x-club-id": clubId },
      payload: {
        nickname: owner.nickname,
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
        clubAccess: "manager",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().player).toMatchObject({
      consent: false,
      consentAt: null,
      firstName: null,
      lastName: null,
      email: null,
      clubAccess: "manager",
      managerLocked: true,
    });
    await expect(
      app.inject({ method: "DELETE", url: `/api/clubs/${clubId}` }),
    ).resolves.toHaveProperty("statusCode", 204);
  });

  it("returns 403 when an editor tries to restore locked Owner consent and PII", async () => {
    const createdClub = await app.inject({
      method: "POST",
      url: "/api/clubs",
      payload: {
        name: `Owner authorization ${randomUUID().slice(0, 8)}`,
        city: "Granada",
        headerLogo: null,
        cardLogo: null,
        language: "en",
        ownerConsent: true,
      },
    });
    const clubId = createdClub.json().club.id as string;
    const owner = (
      await app.inject({
        method: "GET",
        url: "/api/players",
        headers: { "x-club-id": clubId },
      })
    )
      .json()
      .players.find((player: { managerLocked: boolean }) => player.managerLocked);
    await playerStore.update(
      owner.id,
      {
        nickname: owner.nickname,
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
        clubAccess: "manager",
      },
      clubId,
      authenticatedUser.id,
    );
    const withdrawn = (
      await app.inject({
        method: "GET",
        url: "/api/players",
        headers: { "x-club-id": clubId },
      })
    )
      .json()
      .players.find((player: { id: string }) => player.id === owner.id);

    const editor: AppUser = {
      id: randomUUID(),
      email: `owner-editor-${randomUUID()}@example.test`,
      name: "Owner Editor",
      picture: null,
    };
    await seedUser(editor);
    await storage.mutate((tx) =>
      tx.set(`club:${clubId}:member:${editor.id}`, {
        userId: editor.id,
        role: "manager",
      }),
    );
    const editorApp = await buildApp({
      stores,
      authenticateRequest: async () => editor,
      defaultClubId: DEFAULT_CLUB_ID,
    });

    try {
      const response = await editorApp.inject({
        method: "PUT",
        url: `/api/players/${owner.id}`,
        headers: { "x-club-id": clubId },
        payload: {
          nickname: `Editor rewrite ${randomUUID().slice(0, 8)}`,
          consent: true,
          firstName: "Editor",
          lastName: "Rewrite",
          email: editor.email,
          clubAccess: "manager",
        },
      });
      const afterAttempt = (
        await editorApp.inject({
          method: "GET",
          url: "/api/players",
          headers: { "x-club-id": clubId },
        })
      )
        .json()
        .players.find((player: { id: string }) => player.id === owner.id);
      const normalPlayer = await editorApp.inject({
        method: "POST",
        url: "/api/players",
        headers: { "x-club-id": clubId },
        payload: {
          nickname: `Editor normal ${randomUUID().slice(0, 8)}`,
          consent: false,
          firstName: null,
          lastName: null,
          email: null,
          clubAccess: "none",
        },
      });
      const normalNickname = `${normalPlayer.json().player.nickname}-updated`;
      const normalUpdate = await editorApp.inject({
        method: "PUT",
        url: `/api/players/${normalPlayer.json().player.id}`,
        headers: { "x-club-id": clubId },
        payload: {
          nickname: normalNickname,
          consent: false,
          firstName: null,
          lastName: null,
          email: null,
          clubAccess: "none",
        },
      });

      expect([
        response.statusCode,
        response.json(),
        afterAttempt,
        normalUpdate.statusCode,
        normalUpdate.json().player.nickname,
      ]).toEqual([403, { error: "owner_profile_forbidden" }, withdrawn, 200, normalNickname]);
    } finally {
      await editorApp.close();
      await app.inject({ method: "DELETE", url: `/api/clubs/${clubId}` });
    }
  });

  it("returns manager_locked for creator demotion and deletion", async () => {
    const listed = await app.inject({ method: "GET", url: "/api/players" });
    const owner = listed
      .json()
      .players.find((player: { managerLocked: boolean }) => player.managerLocked);
    expect(owner).toBeDefined();

    const demotion = await app.inject({
      method: "PUT",
      url: `/api/players/${owner.id}`,
      payload: {
        nickname: owner.nickname,
        consent: owner.consent,
        firstName: owner.firstName,
        lastName: owner.lastName,
        email: owner.email,
        clubAccess: "none",
      },
    });
    const deletion = await app.inject({
      method: "DELETE",
      url: `/api/players/${owner.id}`,
    });

    expect(demotion.statusCode).toBe(409);
    expect(demotion.json()).toEqual({ error: "manager_locked" });
    expect(deletion.statusCode).toBe(409);
    expect(deletion.json()).toEqual({ error: "manager_locked" });
    await expect(
      app.inject({ method: "DELETE", url: "/api/players/not-a-uuid" }),
    ).resolves.toHaveProperty("statusCode", 400);
  });

  it("requires all personal fields with consent and updates a player", async () => {
    const nickname = `Consented-${randomUUID().slice(0, 8)}`;
    const missingEmail = await app.inject({
      method: "POST",
      url: "/api/players",
      payload: {
        nickname,
        consent: true,
        firstName: "Ada",
        lastName: "Player",
        email: null,
      },
    });
    expect(missingEmail.statusCode).toBe(400);

    const created = await app.inject({
      method: "POST",
      url: "/api/players",
      payload: {
        nickname,
        consent: true,
        firstName: "Ada",
        lastName: "Player",
        email: "ada@example.test",
      },
    });
    expect(created.statusCode).toBe(201);

    const updated = await app.inject({
      method: "PUT",
      url: `/api/players/${created.json().player.id}`,
      payload: {
        nickname: `${nickname}-updated`,
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().player).toMatchObject({
      nickname: `${nickname}-updated`,
      consent: false,
      firstName: null,
      lastName: null,
      email: null,
    });
  });

  it("deletes an unused player and reports a missing player", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/players",
      payload: {
        nickname: `Delete-${randomUUID().slice(0, 8)}`,
        consent: false,
        firstName: null,
        lastName: null,
        email: null,
      },
    });
    const playerId = created.json().player.id as string;

    const deleted = await app.inject({ method: "DELETE", url: `/api/players/${playerId}` });
    const missing = await app.inject({ method: "DELETE", url: `/api/players/${playerId}` });

    expect(deleted.statusCode).toBe(204);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "player_not_found" });
  });

  it("validates OAuth state before exchanging the Google authorization code", async () => {
    const oauth = {
      createAuthorizationUrl: vi.fn(
        (state: string) => `https://accounts.google.test/authorize?state=${state}`,
      ),
      exchangeCode: vi.fn().mockResolvedValue(undefined),
    } as unknown as YouTubeOAuthService;
    let oauthUser = authenticatedUser;
    const oauthApp = await buildApp({
      stores,
      youtubeOAuth: oauth,
      authenticateRequest: async () => oauthUser,
    });
    await oauthApp.ready();

    const started = await oauthApp.inject({ method: "GET", url: "/api/music/oauth/start" });
    expect(started.statusCode).toBe(302);
    const location = new URL(started.headers.location!);
    const cookie = String(started.headers["set-cookie"]).split(";", 1)[0]!;
    expect(location.searchParams.get("state")).toHaveLength(43);
    expect(started.headers["set-cookie"]).toContain("HttpOnly");
    expect(started.headers["set-cookie"]).toContain("Secure");
    expect(started.headers["set-cookie"]).toContain("SameSite=Lax");

    const invalid = await oauthApp.inject({
      method: "GET",
      url: "/api/music/oauth/callback?code=authorization-code&state=wrong-state",
      headers: { cookie },
    });
    expect(invalid.statusCode).toBe(400);
    expect(oauth.exchangeCode).not.toHaveBeenCalled();

    oauthUser = { ...authenticatedUser, id: randomUUID() };
    const changedUser = await oauthApp.inject({
      method: "GET",
      url: `/api/music/oauth/callback?code=authorization-code&state=${location.searchParams.get("state")}`,
      headers: { cookie },
    });
    expect(changedUser.statusCode).toBe(400);
    expect(oauth.exchangeCode).not.toHaveBeenCalled();
    oauthUser = authenticatedUser;

    const callback = await oauthApp.inject({
      method: "GET",
      url: `/api/music/oauth/callback?code=authorization-code&state=${location.searchParams.get("state")}`,
      headers: { cookie },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe("/?music=connected");
    expect(callback.headers["set-cookie"]).toContain("Max-Age=0");
    expect(oauth.exchangeCode).toHaveBeenCalledWith(authenticatedUser.id, "authorization-code");

    await oauthApp.close();
  });

  it("claims approved regular-user access before completing Google sign-in", async () => {
    const invitee: AppUser = {
      id: randomUUID(),
      email: `google-invitee-${randomUUID()}@example.test`,
      name: "Google Invitee",
      picture: null,
    };
    const createdClub = await app.inject({
      method: "POST",
      url: "/api/clubs",
      payload: {
        name: `Google invite ${randomUUID().slice(0, 8)}`,
        city: "Granada",
        headerLogo: null,
        cardLogo: null,
        language: "en",
        ownerConsent: true,
      },
    });
    const invitedClubId = createdClub.json().club.id as string;
    const invitation = await app.inject({
      method: "POST",
      url: "/api/players",
      headers: { "x-club-id": invitedClubId },
      payload: {
        nickname: `Invitee ${randomUUID().slice(0, 8)}`,
        consent: true,
        firstName: "Google",
        lastName: "Invitee",
        email: invitee.email.toUpperCase(),
        clubAccess: "user",
      },
    });
    expect(invitation.statusCode).toBe(201);
    await seedUser(invitee);

    const googleAuth = {
      createAuthorizationUrl: vi.fn(
        (state: string) => `https://accounts.google.test/authorize?state=${state}`,
      ),
      completeAuthorization: vi.fn(async () => ({
        user: invitee,
        sessionToken: "application-session-token",
        expiresAt: new Date(Date.now() + 60_000),
      })),
      getUserForSession: vi.fn(async (token: string | null) =>
        token === "application-session-token" ? invitee : null,
      ),
      endSession: vi.fn(async () => undefined),
    } as unknown as GoogleAuthService;
    const authApp = await buildApp({
      stores,
      googleAuth,
      publicAppUrl: "https://mafia.example.test",
      authRateLimit: { limit: 2, windowMs: 10_000 },
    });
    await authApp.ready();

    const started = await authApp.inject({ method: "GET", url: "/api/auth/google/start" });
    const location = new URL(started.headers.location!);
    const state = location.searchParams.get("state")!;
    const stateCookie = String(started.headers["set-cookie"]).split(";", 1)[0]!;
    expect(started.statusCode).toBe(302);
    expect(state).toHaveLength(43);
    expect(started.headers["set-cookie"]).toContain("HttpOnly");
    expect(started.headers["set-cookie"]).toContain("Secure");

    const callback = await authApp.inject({
      method: "GET",
      url: `/api/auth/google/callback?code=google-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: stateCookie },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe("/");
    expect(String(callback.headers["set-cookie"])).toContain(
      "mafia_session=application-session-token",
    );
    expect(googleAuth.completeAuthorization).toHaveBeenCalledWith("google-code");
    const throttled = await authApp.inject({ method: "GET", url: "/api/auth/google/start" });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json()).toEqual({ error: "auth_rate_limited" });

    const session = await authApp.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: "mafia_session=application-session-token" },
    });
    expect(session.json()).toEqual({ configured: true, user: invitee });

    const clubs = await authApp.inject({
      method: "GET",
      url: "/api/clubs",
      headers: { cookie: "mafia_session=application-session-token" },
    });
    expect(clubs.statusCode).toBe(200);
    expect(clubs.json().clubs).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: invitedClubId, role: "user" })]),
    );

    const signedOut = await authApp.inject({
      method: "DELETE",
      url: "/api/auth/session",
      headers: {
        cookie: "mafia_session=application-session-token",
        origin: "https://mafia.example.test",
      },
    });
    expect(signedOut.statusCode).toBe(204);
    expect(googleAuth.endSession).toHaveBeenCalledWith("application-session-token");
    await authApp.close();
  });

  it("reports that account playlists are unavailable when OAuth is not configured", async () => {
    const status = await app.inject({ method: "GET", url: "/api/music/oauth/status" });

    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({
      configured: false,
      connected: false,
      accountLabel: null,
    });
  });

  it("returns connected account playlists and disconnects the account", async () => {
    const playlists = [
      {
        id: "PL-music",
        title: "Mafia music",
        itemCount: 20,
        thumbnailUrl: "https://i.ytimg.com/music.jpg",
      },
    ];
    const playlistItems = [
      { videoId: "video-1", title: "Opening", position: 0, thumbnailUrl: null },
    ];
    const oauth = {
      getStatus: vi.fn().mockResolvedValue({
        configured: true,
        connected: true,
        accountLabel: "Mafia Host",
      }),
      listPlaylists: vi.fn().mockResolvedValue(playlists),
      listPlaylistItems: vi.fn().mockResolvedValue(playlistItems),
      disconnect: vi.fn().mockResolvedValue(undefined),
    } as unknown as YouTubeOAuthService;
    const oauthApp = await buildApp({
      stores,
      youtubeOAuth: oauth,
      authenticateRequest: async () => authenticatedUser,
    });
    await oauthApp.ready();

    const status = await oauthApp.inject({ method: "GET", url: "/api/music/oauth/status" });
    const listed = await oauthApp.inject({ method: "GET", url: "/api/music/playlists" });
    const items = await oauthApp.inject({
      method: "GET",
      url: "/api/music/playlists/PL-music/items",
    });
    const disconnected = await oauthApp.inject({
      method: "DELETE",
      url: "/api/music/oauth/connection",
    });

    expect(status.json()).toEqual({
      configured: true,
      connected: true,
      accountLabel: "Mafia Host",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ playlists });
    expect(items.statusCode).toBe(200);
    expect(items.json()).toEqual({ items: playlistItems });
    expect(oauth.listPlaylistItems).toHaveBeenCalledWith(authenticatedUser.id, "PL-music");
    expect(disconnected.statusCode).toBe(204);
    expect(oauth.disconnect).toHaveBeenCalledWith(authenticatedUser.id);

    await oauthApp.close();
  });

  it("requires the exact public origin before a session-cookie mutation", async () => {
    const endSession = vi.fn(async () => undefined);
    const googleAuth = {
      configured: true,
      getUserForSession: vi.fn(async () => authenticatedUser),
      endSession,
    } as unknown as GoogleAuthService;
    const protectedApp = await buildApp({
      stores,
      googleAuth,
      publicAppUrl: "https://mafia.example.test",
    });
    await protectedApp.ready();

    for (const origin of [
      undefined,
      "not a URL",
      "http://mafia.example.test",
      "https://evil.test",
    ]) {
      const response = await protectedApp.inject({
        method: "DELETE",
        url: "/api/auth/session",
        headers: {
          cookie: "mafia_session=private-session-token",
          ...(origin === undefined ? {} : { origin }),
        },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "csrf_origin_mismatch" });
    }
    expect(endSession).not.toHaveBeenCalled();

    const accepted = await protectedApp.inject({
      method: "DELETE",
      url: "/api/auth/session",
      headers: {
        cookie: "mafia_session=private-session-token",
        origin: "https://mafia.example.test",
      },
    });
    expect(accepted.statusCode).toBe(204);
    expect(endSession).toHaveBeenCalledWith("private-session-token");
    await protectedApp.close();
  });

  it("throttles Google sign-in attempts with a stable retry contract", async () => {
    const googleAuth = {
      configured: true,
      createAuthorizationUrl: vi.fn(
        (state: string) => `https://accounts.example.test?state=${state}`,
      ),
    } as unknown as GoogleAuthService;
    const throttledApp = await buildApp({
      stores,
      googleAuth,
      publicAppUrl: "https://mafia.example.test",
      authRateLimit: { limit: 2, windowMs: 10_000 },
    });
    await throttledApp.ready();

    const first = await throttledApp.inject({ method: "GET", url: "/api/auth/google/start" });
    const second = await throttledApp.inject({ method: "GET", url: "/api/auth/google/start" });
    const rejected = await throttledApp.inject({ method: "GET", url: "/api/auth/google/start" });

    expect(first.statusCode).toBe(302);
    expect(second.statusCode).toBe(302);
    expect(rejected.statusCode).toBe(429);
    expect(rejected.headers["retry-after"]).toBe("10");
    expect(rejected.json()).toEqual({ error: "auth_rate_limited" });
    expect(googleAuth.createAuthorizationUrl).toHaveBeenCalledTimes(2);
    await throttledApp.close();
  });

  it("does not expose unexpected failure details to clients", async () => {
    const secretMarker = "private-role-and-check-result";
    const googleAuth = {
      configured: true,
      getUserForSession: vi.fn(async () => {
        throw new Error(secretMarker);
      }),
    } as unknown as GoogleAuthService;
    const errorApp = await buildApp({ stores, googleAuth });
    await errorApp.ready();

    const response = await errorApp.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: "mafia_session=private-session-token" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "internal_server_error" });
    expect(response.body).not.toContain(secretMarker);
    expect(response.body).not.toContain("private-session-token");
    await errorApp.close();
  });

  it("requires authentication on every protected API route", async () => {
    const id = "00000000-0000-4000-8000-000000000099";
    const club = {
      name: "Protected club",
      city: "Málaga",
      headerLogo: null,
      cardLogo: null,
      language: "en",
    };
    const routes = [
      { method: "GET", url: "/api/clubs" },
      { method: "POST", url: "/api/clubs", payload: { ...club, ownerConsent: true } },
      { method: "PUT", url: `/api/clubs/${id}`, payload: club },
      { method: "DELETE", url: `/api/clubs/${id}` },
      { method: "GET", url: "/api/music/oauth/status" },
      { method: "GET", url: "/api/music/oauth/start" },
      { method: "GET", url: "/api/music/oauth/callback?code=code&state=state" },
      { method: "GET", url: "/api/music/playlists" },
      { method: "GET", url: "/api/music/playlists/playlist/items" },
      { method: "DELETE", url: "/api/music/oauth/connection" },
      { method: "GET", url: "/api/players" },
      { method: "POST", url: "/api/players" },
      { method: "PUT", url: `/api/players/${id}` },
      { method: "DELETE", url: `/api/players/${id}` },
      { method: "GET", url: "/api/game-sessions" },
      { method: "GET", url: "/api/game-sessions?status=completed" },
      { method: "POST", url: "/api/game-sessions" },
      { method: "GET", url: `/api/game-sessions/${id}` },
      { method: "PUT", url: `/api/game-sessions/${id}` },
      { method: "DELETE", url: `/api/game-sessions/${id}` },
      { method: "GET", url: `/api/games/${id}/events` },
    ] as const;
    const anonymousApp = await buildApp({
      stores,
      authenticateRequest: async () => null,
      defaultClubId: DEFAULT_CLUB_ID,
    });
    await anonymousApp.ready();

    for (const route of routes) {
      const response = await anonymousApp.inject({
        method: route.method,
        url: route.url,
        ...("payload" in route ? { payload: route.payload } : {}),
      });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
      expect(response.json(), `${route.method} ${route.url}`).toEqual({
        error: "authentication_required",
      });
    }
    await anonymousApp.close();
  });

  it("enforces club membership on game records while keeping club and profile administration manager-only", async () => {
    const regularUser = {
      id: randomUUID(),
      email: `regular-${randomUUID()}@example.test`,
      name: "Regular user",
      picture: null,
    };
    const outsider = {
      id: randomUUID(),
      email: `outsider-${randomUUID()}@example.test`,
      name: "Outsider",
      picture: null,
    };
    for (const user of [regularUser, outsider]) await seedUser(user);
    await storage.mutate((tx) =>
      tx.set(`club:${DEFAULT_CLUB_ID}:member:${regularUser.id}`, {
        userId: regularUser.id,
        role: "user",
      }),
    );
    const regularApp = await buildApp({
      stores,
      authenticateRequest: async () => regularUser,
      defaultClubId: DEFAULT_CLUB_ID,
    });
    const outsiderApp = await buildApp({
      stores,
      authenticateRequest: async () => outsider,
      defaultClubId: DEFAULT_CLUB_ID,
    });
    await Promise.all([regularApp.ready(), outsiderApp.ready()]);
    const id = "00000000-0000-4000-8000-000000000099";
    const club = {
      name: "Protected club",
      city: "Málaga",
      headerLogo: null,
      cardLogo: null,
      language: "en",
    };
    const managerRoutes = [
      { method: "PUT", url: `/api/clubs/${DEFAULT_CLUB_ID}`, payload: club },
      { method: "DELETE", url: `/api/clubs/${DEFAULT_CLUB_ID}` },
      { method: "POST", url: "/api/players" },
      { method: "PUT", url: `/api/players/${id}` },
      { method: "DELETE", url: `/api/players/${id}` },
    ] as const;
    const gameRoutes = [
      { method: "GET", url: "/api/game-sessions" },
      { method: "GET", url: "/api/game-sessions?status=completed" },
      { method: "POST", url: "/api/game-sessions" },
      { method: "GET", url: `/api/game-sessions/${id}` },
      { method: "PUT", url: `/api/game-sessions/${id}` },
      { method: "DELETE", url: `/api/game-sessions/${id}` },
    ] as const;
    const memberRoutes = [
      ...managerRoutes,
      ...gameRoutes,
      { method: "GET", url: "/api/players" },
      { method: "GET", url: `/api/games/${id}/events` },
    ] as const;

    for (const route of memberRoutes) {
      const response = await outsiderApp.inject({
        method: route.method,
        url: route.url,
        ...("payload" in route ? { payload: route.payload } : {}),
      });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
      expect(response.json(), `${route.method} ${route.url}`).toEqual({
        error: "club_access_denied",
      });
    }
    for (const route of managerRoutes) {
      const response = await regularApp.inject({
        method: route.method,
        url: route.url,
        ...("payload" in route ? { payload: route.payload } : {}),
      });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
      expect(response.json(), `${route.method} ${route.url}`).toEqual({
        error: "club_manager_required",
      });
    }
    expect(await regularApp.inject({ method: "GET", url: "/api/players" })).toHaveProperty(
      "statusCode",
      200,
    );

    await Promise.all([regularApp.close(), outsiderApp.close()]);
  });
});
