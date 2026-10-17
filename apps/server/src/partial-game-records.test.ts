import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { DEFAULT_CLUB_ID } from "./club-store.js";
import { blobReference } from "./azure-storage.js";
import { createApplicationStorageFixture } from "./test-helpers/storage-fixture.js";

const owner = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "owner@mafiamalaga.es",
  name: "Mafia Malaga owner",
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

const player = async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/players",
    payload: { nickname: `Partial ${randomUUID()}`, consent: false },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().player.id as string;
};
const create = async (state: Record<string, unknown>, results: Record<string, unknown> | null) => {
  const response = await app.inject({
    method: "POST",
    url: "/api/game-sessions",
    payload: { creationId: randomUUID(), name: "Partial facts", state, results },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().gameId as string;
};
const observations = async (gameId: string) =>
  (await stores.games.readStatisticsInputs()).games.find((game) => game.gameId === gameId)!;

describe("partial completed Azure records", () => {
  it("round-trips and lists an empty completed result without inventing observations or a timeline", async () => {
    const body = {
      creationId: randomUUID(),
      name: "Minimal completed record",
      state: {},
      results: {},
    };
    const created = await app.inject({ method: "POST", url: "/api/game-sessions", payload: body });
    expect(created.statusCode, created.body).toBe(201);
    const gameId = created.json().gameId as string;
    const detail = await app.inject({ method: "GET", url: `/api/game-sessions/${gameId}` });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().session).toMatchObject({
      gameId,
      status: "completed",
      state: {},
      results: {},
    });
    const row = (await storage.getEntity(`club:${DEFAULT_CLUB_ID}:game:${gameId}`))!;
    const before = await storage.blobs
      .getBlockBlobClient(blobReference(row).name)
      .downloadToBuffer();
    const listed = await app.inject({ method: "GET", url: "/api/game-sessions?status=completed" });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().sessions).toEqual([
      expect.objectContaining({
        gameId,
        outcome: null,
        winner: null,
        reason: null,
        playedAt: null,
        day: null,
        hostPlayerId: null,
        timelineAvailable: false,
        eventCount: 0,
      }),
    ]);
    expect(created.json()).not.toHaveProperty("rulesetId");
    expect(created.json()).not.toHaveProperty("rulesetVersion");
    expect(row).not.toHaveProperty("rulesetId");
    expect(row).not.toHaveProperty("rulesetVersion");
    const source = await stores.games.readStatisticsInputs();
    expect(source.games).toEqual([
      expect.objectContaining({
        gameId,
        participants: null,
        hasCasper: null,
        rosterComplete: null,
        outcome: null,
        playedAt: null,
        timelineAvailable: false,
      }),
    ]);
    for (const filter of ["from=2026-01-01", "to=2026-12-31", "outcome=red"]) {
      const filtered = await app.inject({
        method: "GET",
        url: `/api/game-sessions?status=completed&${filter}`,
      });
      expect(filtered.statusCode, filtered.body).toBe(200);
      expect(filtered.json().sessions).toEqual([]);
    }
    expect(
      await storage.blobs.getBlockBlobClient(blobReference(row).name).downloadToBuffer(),
    ).toEqual(before);
  });

  it("keeps valid optional participant facts independent and never turns missing facts into losses or zeroes", async () => {
    const [host, a, b] = await Promise.all([player(), player(), player()]);
    const results = {
      hostPlayerId: host.toUpperCase(),
      winner: "black",
      playedAt: "not-a-date",
      reason: "Known note",
      players: [
        {
          playerId: a.toUpperCase(),
          seat: 1,
          team: "black",
          role: "unknown",
          status: "unknown",
          fouls: -1,
          bestMoveHits: 8,
        },
        { playerId: b, role: "sheriff", team: "red", status: "active", fouls: 0, bestMoveHits: 0 },
      ],
    };
    const gameId = await create({}, results);
    expect(await observations(gameId)).toMatchObject({
      outcome: null,
      reason: "Known note",
      playedAt: null,
      hostPlayerId: host.toUpperCase(),
      hasCasper: null,
      rosterComplete: false,
      participants: [
        {
          playerId: a.toUpperCase(),
          seat: 1,
          team: "black",
          role: null,
          status: null,
          fouls: null,
          bestMoveHits: null,
        },
        {
          playerId: b,
          seat: null,
          role: "sheriff",
          team: "red",
          status: "active",
          fouls: 0,
          bestMoveHits: 0,
        },
      ],
    });
    const rows = await storage.read((tx) =>
      tx.list<Record<string, unknown>>(`club:${DEFAULT_CLUB_ID}:result:${gameId}:`),
    );
    expect(rows).toHaveLength(3);
    const first = rows.find((row) => String(row.playerId).toLowerCase() === a)!;
    for (const key of ["won", "playedAt", "outcome", "role", "status", "fouls", "bestMoveHits"])
      expect(first).not.toHaveProperty(key);
    expect((await stores.players.get(a))?.statistics).toMatchObject({
      gamesPlayed: 1,
      wins: 0,
      losses: 0,
      totalFouls: 0,
    });
    expect((await stores.players.get(host))?.statistics.hostedGames).toBe(1);
    expect((await stores.players.get(host))?.lastPlayedAt).toBeNull();
    const detail = await app.inject({ url: `/api/game-sessions/${gameId}` });
    expect(detail.json().session.results).toEqual(results);
    const filtered = await app.inject({ url: `/api/game-sessions?status=completed&playerId=${a}` });
    expect(filtered.statusCode, filtered.body).toBe(200);
    expect(filtered.json().sessions).toEqual([
      expect.objectContaining({ gameId, outcome: null, playedAt: null }),
    ]);
  });

  it("uses complete explicit ten-seat results without requiring a gameplay snapshot and does not invent Casper evidence", async () => {
    const ids = [];
    for (let i = 0; i < 10; i++) ids.push(await player());
    const players = ids.map((playerId, index) => ({
      playerId,
      seat: index + 1,
      role: index < 3 ? (index === 0 ? "don" : "mafia") : index === 3 ? "sheriff" : "citizen",
      team: index < 3 ? "black" : "red",
      status: "active",
      fouls: 0,
    }));
    const results = { outcome: "red", playedAt: "2026-02-20T20:00:00+02:00", players };
    const complete = await create({}, results);
    expect(await observations(complete)).toMatchObject({
      hasCasper: false,
      rosterComplete: true,
      playedAt: "2026-02-20T18:00:00.000Z",
      timelineAvailable: false,
      participants: players.map((p) => ({ ...p, bestMoveHits: null })),
    });
    const unknown = await create({}, { players: [{ playerId: ids[0] }] });
    expect(await observations(unknown)).toMatchObject({ hasCasper: null, rosterComplete: false });
    const absent = await create({ hostPlayerId: "" }, { outcome: "red", rosterComplete: true });
    expect(await observations(absent)).toMatchObject({
      hasCasper: null,
      rosterComplete: null,
      participants: null,
      hostPlayerId: null,
    });
    const page = await app.inject({ url: `/api/statistics/players/${ids[0]}?limit=1` });
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json().history[0]).toMatchObject({
      gameId: complete,
      playedAt: "2026-02-20T18:00:00.000Z",
    });
    expect(page.json().nextCursor).toEqual(expect.any(String));
    const next = await app.inject({
      url: `/api/statistics/players/${ids[0]}?limit=1&cursor=${encodeURIComponent(page.json().nextCursor)}`,
    });
    expect(next.statusCode, next.body).toBe(200);
    expect(next.json().history[0]).toMatchObject({ gameId: unknown, playedAt: null });
    const casper = await create(
      {},
      {
        players: [
          { playerId: "casper", seat: 10 },
          { playerId: ids[0], seat: 1 },
        ],
      },
    );
    expect(await observations(casper)).toMatchObject({
      hasCasper: true,
      rosterComplete: false,
      participants: [expect.objectContaining({ playerId: ids[0] })],
    });
  });

  it("orders unknown dates last by identity, filters only observed dates inclusively, and never substitutes updatedAt", async () => {
    const undated = [await create({}, {}), await create({}, { playedAt: "invalid" })];
    const earlier = await create({}, { playedAt: "2026-04-01T00:00:00.000Z" });
    const later = await create({}, { playedAt: "2026-04-02T23:59:59.999Z" });
    const all = await stores.games.listCompleted();
    expect(
      all.filter((g) => [...undated, earlier, later].includes(g.gameId)).map((g) => g.gameId),
    ).toEqual([later, earlier, ...undated.sort()]);
    expect(
      (await stores.games.listCompleted(undefined, { from: "2026-04-01", to: "2026-04-02" })).map(
        (g) => g.gameId,
      ),
    ).toEqual([later, earlier]);
    for (const gameId of undated) expect(all.find((g) => g.gameId === gameId)?.playedAt).toBeNull();
  });

  it("delivers retained corrupt timeline detail unchanged, counts actual entries, and does no server replay", async () => {
    const state = {
      initialGame: { replayVersion: 3, game: { opaque: true } },
      events: [{ nonsense: true, stateHashAfter: "intentionally-corrupt-client-hash" }, null],
      headEventId: randomUUID(),
      undoHistory: [{ unsent: "preserve" }],
    };
    const gameId = await create(state, {});
    const read = await app.inject({ url: `/api/game-sessions/${gameId}` });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().session.state).toEqual(state);
    expect((await stores.games.listCompleted()).find((g) => g.gameId === gameId)).toMatchObject({
      timelineAvailable: true,
      eventCount: 2,
      day: null,
      outcome: null,
    });
    expect(await stores.events.read(gameId, { includeSecrets: true })).toEqual([]);
  });

  it.each(["rulesEdition", "rulesetId", "rulesetVersion"])(
    "rejects the structural %s key for every value without rewriting hashed JSON",
    async (key) => {
      const gameId = await create(
        { game: { opaque: "current unsent state" }, stateHashAfter: "retained" },
        null,
      );
      const original = await stores.games.get(gameId);
      for (const value of [null, 1, 3, "club-mafia", "mafgame-2026-07-01", "unrecognized-value"]) {
        const state = { initialGame: { game: { [key]: value } }, stateHashAfter: "client-hash" };
        const rejected = await app.inject({
          method: "PUT",
          url: `/api/game-sessions/${gameId}`,
          payload: { mutationId: randomUUID(), name: "Reject, never reseal", state, results: null },
        });
        expect(rejected.statusCode, rejected.body).toBe(400);
        const rejectedCreate = await app.inject({
          method: "POST",
          url: "/api/game-sessions",
          payload: {
            creationId: randomUUID(),
            name: "Reject, never classify",
            state: {},
            results: { nested: { [key]: value } },
          },
        });
        expect(rejectedCreate.statusCode, rejectedCreate.body).toBe(400);
      }
      expect(await stores.games.get(gameId)).toEqual(original);
    },
  );

  it("preserves opaque existing envelope provenance across ordinary save, tournament and profile metadata changes", async () => {
    const participant = await player();
    const gameId = await create({}, { players: [{ playerId: participant }] });
    const key = `club:${DEFAULT_CLUB_ID}:game:${gameId}`;
    const provenance = {
      lastMutationId: randomUUID(),
      createdAt: "2026-05-03T11:12:13.123456+00:00",
      updatedAt: "2026-05-03T12:13:14.654321+00:00",
    };
    const opaque = {
      source: "non-engine retention canary",
      nested: [null, { keep: true, precise: "00001.2300" }],
    };
    await storage.mutate(async (tx) => {
      const row = (await tx.get<Record<string, unknown>>(key))!;
      const envelope = await tx.readBlob<Record<string, unknown>>(blobReference(row));
      const ref = await tx.writeBlob({ ...envelope, postgres: provenance, futureMetadata: opaque });
      await tx.set(key, {
        ...row,
        blobName: ref.name,
        blobSha256: ref.sha256,
        blobLength: ref.length,
      });
      await tx.retireBlob(blobReference(row));
    });
    const verify = async () => {
      const row = (await storage.getEntity(key))!;
      const envelope = await storage.read((tx) =>
        tx.readBlob<Record<string, unknown>>(blobReference(row)),
      );
      expect(envelope.postgres).toEqual(provenance);
      expect(envelope.futureMetadata).toEqual(opaque);
      const read = await app.inject({ url: `/api/game-sessions/${gameId}` });
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json().session).not.toHaveProperty("postgres");
      expect(read.json().session).not.toHaveProperty("futureMetadata");
    };
    await verify();
    const mutation = {
      mutationId: randomUUID(),
      name: "Ordinary save",
      state: {},
      results: { players: [{ playerId: participant }] },
    };
    for (let i = 0; i < 2; i++) {
      const saved = await app.inject({
        method: "PUT",
        url: `/api/game-sessions/${gameId}`,
        payload: mutation,
      });
      expect(saved.statusCode, saved.body).toBe(200);
      await verify();
    }
    const event = await stores.tournaments.create(`Canary ${randomUUID()}`, DEFAULT_CLUB_ID);
    const assigned = await app.inject({
      method: "PUT",
      url: `/api/game-sessions/${gameId}/tournament`,
      payload: { tournamentId: event.id },
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
    await verify();
    const changed = await app.inject({
      method: "PUT",
      url: `/api/players/${participant}`,
      payload: { nickname: `Changed ${randomUUID()}`, consent: false },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    await verify();
    const retired = await app.inject({ method: "DELETE", url: `/api/players/${participant}` });
    expect(retired.statusCode, retired.body).toBe(204);
    await verify();
  });

  it("surfaces corrupt immutable authority as read errors rather than an empty completed history or statistics source", async () => {
    const gameId = await create({}, {});
    const row = (await storage.getEntity(`club:${DEFAULT_CLUB_ID}:game:${gameId}`))!;
    const blob = storage.blobs.getBlockBlobClient(blobReference(row).name);
    const before = await blob.downloadToBuffer();
    await blob.uploadData(Buffer.from("corrupt-authoritative-bytes"));
    try {
      for (const url of [
        "/api/game-sessions?status=completed",
        `/api/game-sessions/${gameId}`,
        "/api/statistics",
      ]) {
        const read = await app.inject({ url });
        expect(read.statusCode, read.body).toBe(500);
        expect(read.json()).not.toHaveProperty("sessions");
      }
      await expect(stores.games.readStatisticsInputs()).rejects.toThrow();
    } finally {
      await blob.uploadData(before);
    }
    expect((await stores.games.get(gameId))?.results).toEqual({});
  });
});
