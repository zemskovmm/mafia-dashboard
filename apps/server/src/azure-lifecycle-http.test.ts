import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { AzureAccountStore } from "./azure-account-store.js";
import { createAzureStores } from "./azure-stores.js";
import { AzureClubStore, AzurePlayerStore } from "./azure-club-player-store.js";
import { AzureEventStore, AzureGameSessionStore } from "./azure-game-session-store.js";
import { AzureTournamentStore } from "./azure-tournament-store.js";
import type { AppUser } from "./google-auth.js";
import type { ApplicationStores } from "./storage-contracts.js";
import { createStorageFixture } from "./test-helpers/storage-fixture.js";
import { verifyAdjudicationHttp } from "./test-helpers/adjudication-http.js";

let fixture: Awaited<ReturnType<typeof createStorageFixture>>;
beforeAll(async () => {
  fixture = await createStorageFixture();
});
afterAll(async () => {
  await fixture?.close();
});

const setup = async () => {
  const storage = fixture.storage;
  const accounts = new AzureAccountStore(storage);
  const owner = await accounts.upsertUser({
    id: randomUUID(),
    subject: randomUUID(),
    email: `${randomUUID()}@example.test`,
    name: "Owner Example",
    picture: null,
  });
  const outsider = await accounts.upsertUser({
    id: randomUUID(),
    subject: randomUUID(),
    email: `${randomUUID()}@example.test`,
    name: "Outsider",
    picture: null,
  });
  const clubs = new AzureClubStore(storage);
  const stores: ApplicationStores = {
    clubs,
    players: new AzurePlayerStore(storage),
    games: new AzureGameSessionStore(storage),
    tournaments: new AzureTournamentStore(storage),
    events: new AzureEventStore(storage),
    ready: () => storage.ready(),
    runAuthorized: (userId, clubId, manager, work) =>
      storage.runAuthorized(userId, clubId, manager, work),
  };
  let actor: AppUser | null = owner;
  const app = await buildApp({ stores, authenticateRequest: async () => actor });
  const created = await app.inject({
    method: "POST",
    url: "/api/clubs",
    payload: {
      name: "HTTP club",
      city: "London",
      language: "en",
      ownerConsent: true,
      headerLogo: null,
      cardLogo: null,
    },
  });
  expect(created.statusCode).toBe(201);
  return {
    app,
    stores,
    owner,
    outsider,
    clubId: created.json().club.id as string,
    setActor: (user: AppUser | null) => {
      actor = user;
    },
  };
};

it("resumes an interrupted club purge through HTTP only for its original manager", async () => {
  const context = await setup();
  const { app, clubId, outsider, owner, setActor } = context;
  const submit = fixture.storage.table.submitTransaction.bind(fixture.storage.table);
  const fault = vi
    .spyOn(fixture.storage.table, "submitTransaction")
    .mockImplementationOnce(submit)
    .mockRejectedValueOnce(new Error("purge interrupted after tombstone"));
  try {
    const first = await app.inject({ method: "DELETE", url: `/api/clubs/${clubId}` });
    expect(first.statusCode).toBeGreaterThanOrEqual(500);
    expect(await fixture.storage.read((tx) => tx.get(`deleted-club:${clubId}`))).toMatchObject({
      userId: owner.id,
    });
    fault.mockRestore();
    expect(
      (await app.inject({ url: "/api/players", headers: { "x-club-id": clubId } })).statusCode,
    ).toBe(403);
    setActor(outsider);
    expect((await app.inject({ method: "DELETE", url: `/api/clubs/${clubId}` })).statusCode).toBe(
      403,
    );
    setActor(owner);
    const resumed = await app.inject({ method: "DELETE", url: `/api/clubs/${clubId}` });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toEqual({ deleted: true, physicalCleanup: "not_guaranteed" });
    expect(await fixture.storage.read((tx) => tx.list(`club:${clubId}:`))).toEqual([]);
  } finally {
    fault.mockRestore();
    await app.close();
  }
});

it("preserves a pending and completed adjudication through Azure HTTP reads", async () => {
  const { app, clubId } = await setup();
  try {
    await verifyAdjudicationHttp(app, clubId);
  } finally {
    await app.close();
  }
});

it("persists partial setup through HTTP, reopens it and prevents deleted-game resurrection", async () => {
  const { app, clubId, owner, outsider, setActor } = await setup();
  const headers = { "x-club-id": clubId };
  const reopened = createAzureStores(fixture.options);
  let secondApp: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    const player = await app.inject({
      method: "POST",
      url: "/api/players",
      headers,
      payload: { nickname: "Seat one", consent: false },
    });
    expect(player.statusCode).toBe(201);
    const playerId = player.json().player.id as string;
    const roster = await app.inject({ url: "/api/players", headers });
    const hostId = roster
      .json()
      .players.find((row: { nickname: string }) => row.nickname === "Owner").id as string;
    const state = {
      setup: {
        selectedPlayerIds: [playerId],
        hostPlayerId: hostId,
        emptySeats: [2, 3],
        roleDraw: { remaining: ["don", "sheriff"] },
      },
      playlist: { id: "playlist", selectedTrack: 4 },
      undo: { marker: "exact" },
      opaque: "\u0800".repeat(32_000),
      events: [
        {
          id: randomUUID(),
          sequence: 1,
          type: "sheriff.checked",
          phaseBefore: "night",
          payload: { targetSeat: 4, match: true },
        },
      ],
    };
    const creationId = randomUUID();
    const created = await app.inject({
      method: "POST",
      url: "/api/game-sessions",
      headers,
      payload: { creationId, name: "Partial setup", state, results: null },
    });
    expect(created.statusCode).toBe(201);
    const gameId = created.json().gameId as string;
    expect(
      (await app.inject({ method: "DELETE", url: `/api/players/${playerId}`, headers })).statusCode,
    ).toBe(409);
    const publicEvents = await app.inject({
      url: `/api/games/${gameId}/events?visibility=public`,
      headers,
    });
    expect(publicEvents.statusCode).toBe(200);
    expect(publicEvents.json().events[0].payload).toEqual({ redacted: true });
    setActor(outsider);
    expect((await app.inject({ url: `/api/game-sessions/${gameId}`, headers })).statusCode).toBe(
      403,
    );
    setActor(owner);
    await reopened.ready();
    secondApp = await buildApp({ stores: reopened.stores, authenticateRequest: async () => owner });
    const restored = await secondApp.inject({ url: `/api/game-sessions/${gameId}`, headers });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().session.state).toEqual(state);
    expect(
      (await secondApp.inject({ method: "DELETE", url: `/api/game-sessions/${gameId}`, headers }))
        .statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/game-sessions/${gameId}`,
          headers,
          payload: { mutationId: randomUUID(), name: "Late", state, results: null },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/game-sessions",
          headers,
          payload: { creationId, name: "Retry", state, results: null },
        })
      ).statusCode,
    ).toBe(410);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/players/${playerId}`, headers })).statusCode,
    ).toBe(204);
    const replacement = await app.inject({
      method: "POST",
      url: "/api/players",
      headers,
      payload: { nickname: "Seat one", consent: false },
    });
    expect(replacement.statusCode).toBe(201);
    expect(replacement.json().player.id).not.toBe(playerId);
  } finally {
    await secondApp?.close();
    await app.close();
    await reopened.end();
  }
});
