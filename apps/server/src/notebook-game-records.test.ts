import { randomUUID } from "node:crypto";
import type { NotebookGameCreation } from "@mafia/game-domain";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { blobReference } from "./azure-storage.js";
import { createAzureStores } from "./azure-stores.js";
import { DEFAULT_CLUB_ID } from "./club-store.js";
import { createApplicationStorageFixture } from "./test-helpers/storage-fixture.js";

const owner = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "owner@mafiamalaga.es",
  name: "Notebook owner",
  picture: null,
};
const fixture = await createApplicationStorageFixture(owner);
const { storage, stores } = fixture;
const app = await buildApp({
  stores,
  defaultClubId: DEFAULT_CLUB_ID,
  authenticateRequest: async () => owner,
});
await app.ready();
afterAll(async () => {
  await app.close();
  await fixture.close();
});

const player = async (clubId = DEFAULT_CLUB_ID) => {
  const response = await app.inject({
    method: "POST",
    url: "/api/players",
    headers: { "x-club-id": clubId },
    payload: { nickname: `Notebook ${randomUUID()}`, consent: false },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().player.id as string;
};
const post = (payload: unknown, clubId = DEFAULT_CLUB_ID) =>
  app.inject({
    method: "POST",
    url: "/api/game-sessions",
    payload: JSON.stringify(payload),
    headers: { "x-club-id": clubId, "content-type": "application/json" },
  });
const minimal = (): NotebookGameCreation => ({
  creationId: randomUUID(),
  name: "Sparse notebook",
  state: { notebook: { dayCount: 1, cells: [] } },
  results: { players: [] },
});
const completed = async () => {
  const response = await app.inject({ url: "/api/game-sessions?status=completed" });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().sessions;
};
const authority = async (gameId: string) => {
  const row = (await storage.getEntity(`club:${DEFAULT_CLUB_ID}:game:${gameId}`))!;
  const bytes = await storage.blobs.getBlockBlobClient(blobReference(row).name).downloadToBuffer();
  return { row, bytes };
};

describe("manual notebook import over Azure HTTP", () => {
  it("round-trips exact sparse observations, retries one identity and leaves the active record untouched", async () => {
    const host = await player();
    const a = await player();
    const b = await player();
    const c = await player();
    const activeBody = {
      creationId: randomUUID(),
      name: "Unrelated live game",
      state: {
        setup: { hostPlayerId: host, selectedPlayerIds: [a] },
        pending: { preserve: [null, "unsent marker"] },
      },
      results: null,
    };
    const active = await post(activeBody);
    expect(active.statusCode, active.body).toBe(201);
    const activeId = active.json().gameId as string;
    const activeBefore = await stores.games.get(activeId);
    const activeAuthority = await authority(activeId);
    const activeList = await app.inject({ url: "/api/game-sessions" });
    expect(activeList.statusCode, activeList.body).toBe(200);

    const input: NotebookGameCreation = {
      creationId: randomUUID(),
      name: "Paper observations",
      state: {
        notebook: {
          dayCount: 2,
          seatRoles: [
            { seat: 1, role: "mafia" },
            { seat: 2, role: "don" },
            { seat: 9, role: "sheriff" },
          ],
          cells: [
            { seat: 1, day: 1, phase: "day", nomination: 4, eliminated: true },
            { seat: 4, day: 1, phase: "night", eliminated: true },
            { seat: 9, day: 2, phase: "day", nomination: 1 },
          ],
          bestMove: { ownerSeat: 9, targetSeats: [1, 4] },
        },
      },
      results: {
        hostPlayerId: host,
        players: [
          { playerId: a, seat: 1, role: "mafia", team: "black", status: "eliminated" },
          { playerId: b, seat: 4, status: "eliminated" },
          { playerId: c, seat: 9, role: "sheriff", team: "red" },
        ],
      },
    };
    const created = await post(input);
    expect(created.statusCode, created.body).toBe(201);
    const gameId = created.json().gameId as string;
    expect(gameId).not.toBe(activeId);
    const importedAuthority = await authority(gameId);
    const envelope = JSON.parse(importedAuthority.bytes.toString());
    expect(envelope.session).toMatchObject({ state: input.state, results: input.results });
    expect(envelope.events).toEqual([]);

    // The first acknowledgement may have been lost; retries use the exact request.
    for (let attempt = 0; attempt < 2; attempt++) {
      const retry = await post(input);
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json()).toMatchObject({ gameId, duplicate: true, revision: 1 });
    }
    expect(await authority(gameId)).toEqual(importedAuthority);
    const reopened = createAzureStores(fixture.options);
    const reader = await buildApp({
      stores: reopened.stores,
      defaultClubId: DEFAULT_CLUB_ID,
      authenticateRequest: async () => owner,
    });
    try {
      const detail = await reader.inject({ url: `/api/game-sessions/${gameId}` });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json().session).toMatchObject({ gameId, status: "completed", revision: 1 });
      expect(detail.json().session.state).toEqual(input.state);
      expect(detail.json().session.results).toEqual(input.results);
    } finally {
      await reader.close();
      await reopened.end();
    }
    expect(
      (await completed()).filter((game: { gameId: string }) => game.gameId === gameId),
    ).toEqual([
      expect.objectContaining({
        gameId,
        hostPlayerId: host,
        day: null,
        outcome: null,
        winner: null,
        reason: null,
        playedAt: null,
        timelineAvailable: false,
        eventCount: 0,
      }),
    ]);
    const events = await app.inject({ url: `/api/games/${gameId}/events?visibility=host` });
    expect(events.statusCode, events.body).toBe(200);
    expect(events.json().events).toEqual([]);
    expect(await stores.events.read(gameId, { includeSecrets: true })).toEqual([]);
    expect(await stores.games.get(activeId)).toEqual(activeBefore);
    expect(await authority(activeId)).toEqual(activeAuthority);
    const activeAfter = await app.inject({ url: "/api/game-sessions" });
    expect(activeAfter.statusCode, activeAfter.body).toBe(200);
    expect(activeAfter.json()).toEqual(activeList.json());

    const source = await stores.games.readStatisticsInputs();
    expect(source.games.find((game) => game.gameId === gameId)).toMatchObject({
      outcome: null,
      playedAt: null,
      rosterComplete: false,
      hasCasper: null,
      timelineAvailable: false,
      participants: [
        { ...input.results.players[0], fouls: null, bestMoveHits: null },
        { ...input.results.players[1], role: null, team: null, fouls: null, bestMoveHits: null },
        { ...input.results.players[2], status: null, fouls: null, bestMoveHits: null },
      ],
    });
    const rows = await storage.read((tx) =>
      tx.list<Record<string, unknown>>(`club:${DEFAULT_CLUB_ID}:result:${gameId}:`),
    );
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      for (const key of ["won", "playedAt", "outcome", "fouls", "bestMoveHits"])
        expect(row).not.toHaveProperty(key);
    }
    for (const [playerId, statusGames, eliminations] of [
      [b, 1, 1],
      [c, 0, 0],
    ] as const) {
      const detail = await app.inject({ url: `/api/statistics/players/${playerId}` });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json().player).toMatchObject({
        totals: { games: 1, outcomeGames: 0, wins: 0, draws: 0, losses: 0, winRate: null },
        foulGames: 0,
        foulsPerGame: null,
        statusGames,
        eliminations,
        bestMoveResults: 0,
        lastPlayedAt: null,
        recentForm: [],
        rating: { ratedGames: 0 },
      });
      expect(detail.json().history).toEqual([
        expect.objectContaining({
          gameId,
          playedAt: null,
          outcome: null,
          timelineAvailable: false,
        }),
      ]);
    }
  });

  it("keeps fully unknown notebook facts empty rather than inventing participants or metadata", async () => {
    const input = minimal();
    const created = await post(input);
    expect(created.statusCode, created.body).toBe(201);
    const gameId = created.json().gameId as string;
    const read = await app.inject({ url: `/api/game-sessions/${gameId}` });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().session.state).toEqual(input.state);
    expect(read.json().session.results).toEqual(input.results);
    expect(read.json().session.status).toBe("completed");
    expect(
      (await stores.games.readStatisticsInputs()).games.find((game) => game.gameId === gameId),
    ).toMatchObject({
      participants: [],
      hostPlayerId: null,
      playedAt: null,
      outcome: null,
      hasCasper: null,
      rosterComplete: false,
      timelineAvailable: false,
    });
    expect(await stores.events.read(gameId, { includeSecrets: true })).toEqual([]);
  });

  it.each([
    [
      "night numbers",
      {
        dayCount: 1,
        cells: [{ seat: 1, day: 1, phase: "night", nomination: 4, eliminated: true }],
      },
    ],
    [
      "duplicate coordinates",
      {
        dayCount: 1,
        cells: [
          { seat: 1, day: 1, phase: "day", nomination: 4 },
          { seat: 1, day: 1, phase: "day", eliminated: true },
        ],
      },
    ],
    ["unobserved cells", { dayCount: 1, cells: [{ seat: 1, day: 1, phase: "day" }] }],
    [
      "out-of-range days",
      { dayCount: 1, cells: [{ seat: 1, day: 2, phase: "night", eliminated: true }] },
    ],
    ["duplicate Best Move targets", { dayCount: 1, cells: [], bestMove: { targetSeats: [1, 1] } }],
    ["copied names", { dayCount: 1, cells: [], name: "Profile copy" }],
    ["invalid role", { dayCount: 1, cells: [], seatRoles: [{ seat: 2, role: "unknown" }] }],
    ["out-of-range role seat", { dayCount: 1, cells: [], seatRoles: [{ seat: 11, role: "don" }] }],
    [
      "duplicate role seats",
      {
        dayCount: 1,
        cells: [],
        seatRoles: [
          { seat: 2, role: "don" },
          { seat: 2, role: "mafia" },
        ],
      },
    ],
    [
      "copied role identity",
      { dayCount: 1, cells: [], seatRoles: [{ seat: 2, role: "don", nickname: "Profile copy" }] },
    ],
  ])("rejects %s at create and save without changing Azure authority", async (_label, notebook) => {
    const before = await completed();
    const input = { ...minimal(), state: { notebook } };
    const rejected = await post(input);
    expect(rejected.statusCode, rejected.body).toBe(400);
    expect(await completed()).toEqual(before);
    const valid = minimal();
    const created = await post(valid);
    expect(created.statusCode, created.body).toBe(201);
    const gameId = created.json().gameId as string;
    const original = await authority(gameId);
    const mutation = await app.inject({
      method: "PUT",
      url: `/api/game-sessions/${gameId}`,
      payload: {
        mutationId: randomUUID(),
        name: valid.name,
        state: input.state,
        results: valid.results,
      },
    });
    expect(mutation.statusCode, mutation.body).toBe(400);
    expect(await authority(gameId)).toEqual(original);
    const read = await app.inject({ url: `/api/game-sessions/${gameId}` });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().session.state).toEqual(valid.state);
    expect(read.json().session.results).toEqual(valid.results);
    // Rejection must not reserve the creation identity or rewrite the rejected draft.
    const corrected = await post({ ...valid, creationId: input.creationId });
    expect(corrected.statusCode, corrected.body).toBe(201);
  });

  it("retains club identity isolation, duplicate-identity rejection and retired-selection checks", async () => {
    const createdClub = await app.inject({
      method: "POST",
      url: "/api/clubs",
      payload: {
        name: "Other notebook club",
        city: "London",
        language: "en",
        ownerConsent: true,
        headerLogo: null,
        cardLogo: null,
      },
    });
    expect(createdClub.statusCode, createdClub.body).toBe(201);
    const foreignClub = createdClub.json().club.id as string;
    const foreignPlayer = await player(foreignClub);
    const localPlayer = await player();
    const retiredPlayer = await player();
    const retired = await app.inject({ method: "DELETE", url: `/api/players/${retiredPlayer}` });
    expect(retired.statusCode, retired.body).toBe(204);
    expect(await stores.players.get(retiredPlayer)).toBeNull();
    const before = await completed();
    for (const [status, results] of [
      [409, { players: [{ playerId: foreignPlayer, seat: 1 }] }],
      [409, { players: [], hostPlayerId: foreignPlayer }],
      [409, { players: [{ playerId: randomUUID(), seat: 1 }] }],
      [409, { players: [{ playerId: retiredPlayer, seat: 1 }] }],
      [
        400,
        {
          players: [
            { playerId: localPlayer, seat: 1 },
            { playerId: localPlayer.toUpperCase(), seat: 2 },
          ],
        },
      ],
      [400, { players: [{ playerId: localPlayer, seat: 1, nickname: "Copied profile" }] }],
    ] as const) {
      const rejected = await post({ ...minimal(), results });
      expect(rejected.statusCode, rejected.body).toBe(status);
      expect(rejected.json().error).toBe(
        status === 409 ? "invalid_game_identity" : "validation_failed",
      );
    }
    expect(await completed()).toEqual(before);
    const local = await post({
      ...minimal(),
      results: { players: [{ playerId: localPlayer, seat: 1 }] },
    });
    expect(local.statusCode, local.body).toBe(201);
    const gameId = local.json().gameId as string;
    const original = await authority(gameId);
    const foreignRead = await app.inject({
      url: `/api/game-sessions/${gameId}`,
      headers: { "x-club-id": foreignClub },
    });
    expect(foreignRead.statusCode, foreignRead.body).toBe(404);
    const denied = await post(minimal(), randomUUID());
    expect(denied.statusCode, denied.body).toBe(403);
    const foreignSave = await app.inject({
      method: "PUT",
      url: `/api/game-sessions/${gameId}`,
      headers: { "x-club-id": foreignClub },
      payload: {
        mutationId: randomUUID(),
        name: "Foreign write",
        state: minimal().state,
        results: { players: [] },
      },
    });
    expect(foreignSave.statusCode, foreignSave.body).toBe(404);
    expect(await authority(gameId)).toEqual(original);
    const foreignList = await app.inject({
      url: "/api/game-sessions?status=completed",
      headers: { "x-club-id": foreignClub },
    });
    expect(foreignList.statusCode, foreignList.body).toBe(200);
    expect(foreignList.json().sessions).toEqual([]);
  });
});
