import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AzureGameSessionStore, AzureEventStore } from "./azure-game-session-store.js";
import { createStorageFixture } from "./test-helpers/storage-fixture.js";
import { blobFields, blobReference, digest, type AzureStorage } from "./azure-storage.js";

let storage: AzureStorage;
let close: () => Promise<void>;
let games: AzureGameSessionStore;
let events: AzureEventStore;
const clubId = randomUUID();
const otherClubId = randomUUID();
const state = (label: string) => ({
  clientSnapshot: label,
  setup: { step: "players", selectedPlayerIds: [] },
  game: { phase: "anything", day: 4 },
  events: [],
});

beforeAll(async () => {
  ({ storage, close } = await createStorageFixture());
  games = new AzureGameSessionStore(storage);
  events = new AzureEventStore(storage);
  await storage.mutate(async (tx) => {
    await tx.set(`club:${clubId}:meta`, { id: clubId, name: "Test" });
    await tx.set(`club:${otherClubId}:meta`, { id: otherClubId, name: "Other" });
  });
});
afterAll(async () => {
  if (close) await close();
});

describe("Azure game snapshot store", () => {
  it("preserves the SQL event-view conflict rules without changing canonical history", async () => {
    const id = randomUUID();
    const candidate = (eventId: string, sequence: number) => ({
      id: eventId,
      sequence,
      type: "game.completed",
      phaseBefore: "finished",
      payload: { winner: "red" },
      parentEventId: randomUUID(),
      stateHashAfter: "client-hash",
      replayVersion: 7,
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    const history = [candidate(id, 1), candidate(randomUUID(), 1), candidate(id, 2)];
    const first = await games.create({
      clubId,
      creationId: randomUUID(),
      name: "Conflicts",
      state: { events: history },
      results: null,
    });
    expect((await games.get(first.gameId, clubId))?.state).toEqual({ events: history });
    const view = await events.read(first.gameId, { includeSecrets: true }, clubId);
    expect(view).toHaveLength(1);
    expect(view[0]).toMatchObject({
      id,
      sequence: 1,
      parentEventId: null,
      replayVersion: 1,
      stateHashAfter: null,
    });
    expect(view[0]).not.toHaveProperty("seat");
    expect(view[0]!.createdAt.getFullYear()).toBeGreaterThan(2020);
    const other = await games.create({
      clubId,
      creationId: randomUUID(),
      name: "Same event",
      state: { events: [candidate(id, 1)] },
      results: null,
    });
    expect(await events.read(other.gameId, { includeSecrets: true }, clubId)).toEqual([]);
  });
  it("persists exact partial state and returns the current accepted game for a creation retry", async () => {
    const creationId = randomUUID();
    const first = await games.create({
      clubId,
      creationId,
      name: "  First  ",
      state: state("one"),
      results: null,
    });
    expect(first).toMatchObject({
      name: "First",
      revision: 1,
      duplicate: false,
      state: state("one"),
    });
    const saved = await games.save({
      clubId,
      gameId: first.gameId,
      name: "Latest",
      mutationId: randomUUID(),
      state: state("two"),
      results: null,
    });
    expect(saved).toMatchObject({ revision: 2, duplicate: false, state: state("two") });
    const retried = await games.create({
      clubId,
      creationId,
      name: "Stale",
      state: state("stale"),
      results: null,
    });
    expect(retried).toMatchObject({
      gameId: first.gameId,
      name: "Latest",
      revision: 2,
      duplicate: true,
      state: state("two"),
    });
    expect(await games.get(first.gameId, clubId)).toMatchObject({
      revision: 2,
      state: state("two"),
    });
    expect(await games.listActive(clubId)).toContainEqual(
      expect.objectContaining({ gameId: first.gameId, phase: "anything", day: 4 }),
    );
    expect(await games.get(first.gameId, otherClubId)).toBeNull();
    await expect(
      games.save({
        clubId: otherClubId,
        gameId: first.gameId,
        name: "Foreign",
        mutationId: randomUUID(),
        state: state("foreign"),
        results: null,
      }),
    ).rejects.toMatchObject({ code: "game_session_not_found" });
  });

  it("keeps save update-only, last-commit-wins even with the same mutation ID, and deletion non-resurrecting", async () => {
    const creationId = randomUUID();
    const first = await games.create({
      clubId,
      creationId,
      name: "Mutable",
      state: state("initial"),
      results: null,
    });
    const mutationId = randomUUID();
    await games.save({
      clubId,
      gameId: first.gameId,
      name: "Earlier",
      mutationId,
      state: state("earlier"),
      results: null,
    });
    const latest = await games.save({
      clubId,
      gameId: first.gameId,
      name: "Later",
      mutationId,
      state: state("later"),
      results: null,
    });
    expect(latest).toMatchObject({ revision: 3, duplicate: false, state: state("later") });
    await games.clear({ clubId, gameId: first.gameId });
    await games.clear({ clubId, gameId: first.gameId });
    expect(await games.get(first.gameId, clubId)).toBeNull();
    expect(await events.read(first.gameId, { includeSecrets: true }, clubId)).toEqual([]);
    await expect(
      games.create({
        clubId,
        creationId,
        name: "Resurrection",
        state: state("bad"),
        results: null,
      }),
    ).rejects.toMatchObject({ name: "DeletedGameError" });
    await expect(
      games.save({
        clubId,
        gameId: first.gameId,
        name: "Resurrection",
        mutationId,
        state: state("bad"),
        results: null,
      }),
    ).rejects.toMatchObject({ code: "game_session_not_found" });
  });

  it("retains full canonical history while public event reads redact secrets and all replay hashes", async () => {
    const firstId = randomUUID();
    const secondId = randomUUID();
    const history = [
      {
        id: firstId,
        sequence: 1,
        type: "sheriff.checked",
        phaseBefore: "night-sheriff-result",
        payload: { targetSeat: 4, match: true },
        stateHashAfter: "sha256:secret",
        parentEventId: null,
        createdAt: "2026-08-18T08:00:00.000Z",
      },
      {
        id: secondId,
        sequence: 2,
        type: "game.completed",
        phaseBefore: "finished",
        payload: { winner: "red" },
        stateHashAfter: "sha256:public",
        parentEventId: firstId,
        createdAt: "2026-08-18T08:01:00.000Z",
      },
    ];
    const stateWithHistory = { ...state("history"), events: history };
    const created = await games.create({
      clubId,
      creationId: randomUUID(),
      name: "History",
      state: stateWithHistory,
      results: null,
    });
    expect((await games.get(created.gameId, clubId))?.state).toEqual(stateWithHistory);
    expect(await events.read(created.gameId, { includeSecrets: true }, clubId)).toMatchObject([
      {
        id: firstId,
        payload: { targetSeat: 4, match: true },
        parentEventId: null,
        stateHashAfter: null,
        createdAt: expect.any(Date),
      },
      {
        id: secondId,
        payload: { winner: "red" },
        parentEventId: null,
        stateHashAfter: null,
        createdAt: expect.any(Date),
      },
    ]);
    expect(await events.read(created.gameId, { includeSecrets: false }, clubId)).toMatchObject([
      { payload: { redacted: true }, stateHashAfter: null },
      { payload: { winner: "red" }, stateHashAfter: null },
    ]);
    expect(await events.read(created.gameId, { includeSecrets: true }, otherClubId)).toEqual([]);
    await games.save({
      clubId,
      gameId: created.gameId,
      mutationId: randomUUID(),
      name: "Corrected",
      state: state("undo"),
      results: null,
    });
    expect(await events.read(created.gameId, { includeSecrets: true }, clubId)).toEqual([]);
  });

  it("synchronizes bounded participant/result rows and filters accepted completed snapshots", async () => {
    const host = randomUUID();
    const player = randomUUID();
    await storage.mutate(async (tx) => {
      for (const id of [host, player])
        await tx.set(`club:${clubId}:player:${id}`, {
          id,
          nickname: id,
          clubAccess: "none",
          consent: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
    });
    const current = {
      ...state("with players"),
      hostPlayerId: host,
      game: {
        phase: "finished",
        day: 5,
        players: [{ id: player, seat: 1, role: "citizen", team: "red" }],
      },
    };
    const first = await games.create({
      clubId,
      creationId: randomUUID(),
      name: "Results",
      state: current,
      results: null,
    });
    const prefix = `club:${clubId}:`;
    const participants = await storage.read((tx) =>
      tx.list<{ playerId: string }>(`${prefix}participant:${first.gameId}:`),
    );
    expect(participants).toHaveLength(2);
    expect(participants.find((row) => row.playerId === host)).toMatchObject({
      gameId: first.gameId,
      isHost: true,
    });
    expect(participants.find((row) => row.playerId === player)).toMatchObject({
      gameId: first.gameId,
      isHost: false,
      seat: 1,
    });
    const playedAt = "2026-08-18T08:00:00.000Z";
    const results = {
      hostPlayerId: host,
      outcome: "red",
      winner: "red",
      reason: null,
      playedAt,
      players: [
        {
          playerId: player,
          seat: 1,
          role: "citizen",
          team: "red",
          status: "active",
          fouls: 2,
          bestMoveHits: null,
        },
      ],
    };
    await games.save({
      clubId,
      gameId: first.gameId,
      name: "Results",
      mutationId: randomUUID(),
      state: current,
      results,
    });
    const resultRows = await storage.read((tx) =>
      tx.list<{ playerId: string }>(`${prefix}result:${first.gameId}:`),
    );
    expect(resultRows).toHaveLength(2);
    expect(resultRows.find((row) => row.playerId === host)).toMatchObject({
      isHost: true,
      outcome: "red",
    });
    expect(resultRows.find((row) => row.playerId === player)).toMatchObject({
      isHost: false,
      won: true,
      role: "citizen",
    });
    expect(
      await games.listCompleted(clubId, {
        from: "2026-08-18",
        to: "2026-08-18",
        playerId: player,
        outcome: "red",
      }),
    ).toMatchObject([
      { gameId: first.gameId, outcome: "red", winner: "red", playedAt, day: 5, eventCount: 0 },
    ]);
    expect(await games.listCompleted(clubId, { to: "2026-08-17" })).toEqual([]);
    expect(await games.listCompleted(clubId, { playerId: host })).toEqual([]);
    const draw = { ...results, outcome: "draw", winner: null, reason: "agreed" };
    await games.save({
      clubId,
      gameId: first.gameId,
      name: "Draw",
      mutationId: randomUUID(),
      state: current,
      results: draw,
    });
    const drawRows = await storage.read((tx) =>
      tx.list<{ playerId: string }>(`${prefix}result:${first.gameId}:`),
    );
    expect(drawRows).toHaveLength(2);
    expect(drawRows.find((row) => row.playerId === host)).toMatchObject({
      outcome: "draw",
      isHost: true,
    });
    expect(drawRows.find((row) => row.playerId === player)).toMatchObject({
      outcome: "draw",
      isHost: false,
    });
    expect(drawRows.find((row) => row.playerId === player)).not.toHaveProperty("won");
    const cancelled = { ...draw, outcome: "cancelled", reason: "ended" };
    await games.save({
      clubId,
      gameId: first.gameId,
      name: "Cancelled",
      mutationId: randomUUID(),
      state: current,
      results: cancelled,
    });
    expect(await storage.read((tx) => tx.list(`${prefix}result:${first.gameId}:`))).toEqual([]);
    expect(await games.listCompleted(clubId, { outcome: "cancelled" })).toHaveLength(1);
  });

  it("rejects foreign and retired active identities but preserves historical references and casing", async () => {
    const retired = randomUUID();
    const foreign = randomUUID();
    const uppercase = retired.toUpperCase();
    const profile = {
      id: retired,
      nickname: "Retiring",
      clubAccess: "none",
      consent: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await storage.mutate(async (tx) => {
      await tx.set(`club:${clubId}:player:${retired}`, profile);
      await tx.set(`club:${otherClubId}:player:${foreign}`, { ...profile, id: foreign });
    });
    await expect(
      games.create({
        clubId,
        creationId: randomUUID(),
        name: "Foreign",
        state: { hostPlayerId: foreign },
        results: null,
      }),
    ).rejects.toMatchObject({ code: "invalid_game_identity" });
    const accepted = await games.create({
      clubId,
      creationId: randomUUID(),
      name: "Uppercase",
      state: { hostPlayerId: uppercase, events: [] },
      results: null,
    });
    expect((await games.get(accepted.gameId, clubId))?.state).toEqual({
      hostPlayerId: uppercase,
      events: [],
    });
    await storage.mutate(async (tx) =>
      tx.set(`club:${clubId}:player:${retired}`, { ...profile, retiredAt: new Date() }),
    );
    await expect(
      games.create({
        clubId,
        creationId: randomUUID(),
        name: "Retired",
        state: { hostPlayerId: uppercase },
        results: null,
      }),
    ).rejects.toMatchObject({ code: "invalid_game_identity" });
    await expect(
      games.save({
        clubId,
        gameId: accepted.gameId,
        mutationId: randomUUID(),
        name: "Retired active",
        state: { hostPlayerId: uppercase },
        results: null,
      }),
    ).rejects.toMatchObject({ code: "invalid_game_identity" });
    const historical = {
      hostPlayerId: uppercase,
      outcome: "cancelled",
      winner: null,
      reason: "ended",
      playedAt: "2026-08-18T08:00:00.000Z",
      players: [],
    };
    const corrected = await games.save({
      clubId,
      gameId: accepted.gameId,
      mutationId: randomUUID(),
      name: "Historical",
      state: { events: [] },
      results: historical,
    });
    expect(corrected.results).toEqual(historical);
    expect(await games.listCompleted(clubId, { outcome: "cancelled" })).toContainEqual(
      expect.objectContaining({ gameId: accepted.gameId }),
    );
  });

  it("rejects name-bearing snapshots before changing the accepted state or exposing unsupported history", async () => {
    const first = await games.create({
      clubId,
      creationId: randomUUID(),
      name: "Private",
      state: state("safe"),
      results: null,
    });
    await expect(
      games.save({
        clubId,
        gameId: first.gameId,
        mutationId: randomUUID(),
        name: "Poison",
        state: { hostName: "Alice", events: [] },
        results: null,
      }),
    ).rejects.toMatchObject({ code: "unsupported_game_format" });
    expect(await games.get(first.gameId, clubId)).toMatchObject({
      revision: 1,
      state: state("safe"),
    });
    await expect(
      games.create({
        clubId,
        creationId: randomUUID(),
        name: "Poison",
        state: { events: [{ payload: { firstName: "Secret" } }] },
        results: null,
      }),
    ).rejects.toMatchObject({ code: "unsupported_game_format" });
  });

  it("retains long event history in one blob rather than consuming one Table action per event", async () => {
    const history = Array.from({ length: 120 }, (_, index) => ({
      id: randomUUID(),
      sequence: index + 1,
      type: "game.completed",
      phaseBefore: "finished",
      payload: { winner: "red", marker: index },
      stateHashAfter: `sha256:${"a".repeat(64)}`,
      createdAt: "2026-08-18T08:00:00.000Z",
    }));
    const batches = vi.spyOn(storage.table, "submitTransaction");
    const created = await games.create({
      clubId,
      creationId: randomUUID(),
      name: "Long",
      state: { events: history, arbitraryPhase: { custom: [1, 2, 3] } },
      results: null,
    });
    const actionCounts = batches.mock.calls.map(([actions]) => actions.length);
    batches.mockRestore();
    expect(actionCounts).toEqual([4]); // control + receipt + game pointer + creation mapping
    expect((await games.get(created.gameId, clubId))?.state).toEqual({
      events: history,
      arbitraryPhase: { custom: [1, 2, 3] },
    });
    expect(await events.read(created.gameId, { includeSecrets: true }, clubId)).toHaveLength(120);
    expect(
      await storage.read((tx) => tx.list(`club:${clubId}:participant:${created.gameId}:`)),
    ).toEqual([]);
  });

  it("does not expose records through a club tombstone even if stale rows remain", async () => {
    const disposableClub = randomUUID();
    await storage.mutate((tx) => tx.set(`club:${disposableClub}:meta`, { id: disposableClub }));
    const first = await games.create({
      clubId: disposableClub,
      creationId: randomUUID(),
      name: "Hidden",
      state: state("hidden"),
      results: null,
    });
    await storage.mutate((tx) => tx.set(`deleted-club:${disposableClub}`, { id: disposableClub }));
    expect(await games.get(first.gameId, disposableClub)).toBeNull();
    expect(await games.listActive(disposableClub)).toEqual([]);
    expect(await events.read(first.gameId, { includeSecrets: true }, disposableClub)).toEqual([]);
    await expect(
      games.save({
        clubId: disposableClub,
        gameId: first.gameId,
        mutationId: randomUUID(),
        name: "Stale",
        state: state("stale"),
        results: null,
      }),
    ).rejects.toMatchObject({ code: "game_session_not_found" });
  });

  it("keeps complete-roster correction and projection replacement within the Azure batch budget", async () => {
    const host = randomUUID();
    const ids = Array.from({ length: 10 }, () => randomUUID());
    await storage.mutate(async (tx) => {
      for (const id of [host, ...ids])
        await tx.set(`club:${clubId}:player:${id}`, {
          id,
          nickname: id,
          clubAccess: "none",
          consent: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
    });
    const players = ids.map((id, index) => ({ id, seat: index + 1, role: "citizen", team: "red" }));
    const fullState = {
      hostPlayerId: host,
      game: { phase: "finished", day: 1, players },
      events: [],
    };
    const created = await games.create({
      clubId,
      creationId: randomUUID(),
      name: "Full",
      state: fullState,
      results: null,
    });
    const results = {
      hostPlayerId: host,
      outcome: "red",
      winner: "red",
      reason: null,
      playedAt: "2026-08-18T08:00:00.000Z",
      players: players.map(({ id, seat, role, team }) => ({
        playerId: id,
        seat,
        role,
        team,
        status: "active",
        fouls: 0,
        bestMoveHits: null,
      })),
    };
    const batches = vi.spyOn(storage.table, "submitTransaction");
    try {
      await games.save({
        clubId,
        gameId: created.gameId,
        mutationId: randomUUID(),
        name: "Result",
        state: fullState,
        results,
      });
      const winningCounts = batches.mock.calls.map(([actions]) => actions.length);
      batches.mockClear();
      await games.save({
        clubId,
        gameId: created.gameId,
        mutationId: randomUUID(),
        name: "Correction",
        state: fullState,
        results: { ...results, outcome: "black", winner: "black" },
      });
      const correctedCounts = batches.mock.calls.map(([actions]) => actions.length);
      expect(winningCounts).toHaveLength(1);
      expect(correctedCounts).toHaveLength(1);
      expect(Math.max(...winningCounts, ...correctedCounts)).toBeLessThan(98);
      console.info(
        `Azure complete-roster Table actions: first=${winningCounts[0]}, correction=${correctedCounts[0]}`,
      );
    } finally {
      batches.mockRestore();
    }
    expect(
      await storage.read((tx) => tx.list(`club:${clubId}:participant:${created.gameId}:`)),
    ).toHaveLength(11);
    expect(
      await storage.read((tx) => tx.list(`club:${clubId}:result:${created.gameId}:`)),
    ).toHaveLength(11);

    const key = `club:${clubId}:game:${created.gameId}`;
    const tombstoneKey = `club:${clubId}:deleted-game:${created.gameId}`;
    const mutationKey = `club:${clubId}:mutation:${created.gameId}:${randomUUID()}`;
    const request = await storage.mutate(async (tx) => {
      const ref = await tx.writeBlob({ name: "Imported retry", state: {}, results: null });
      await tx.set(mutationKey, { gameId: created.gameId, ...blobFields(ref) });
      return ref;
    });
    const snapshot = blobReference((await storage.getEntity(key))!);
    const rejected = vi
      .spyOn(storage.table, "submitTransaction")
      .mockRejectedValueOnce(new Error("synthetic SDK failure with secret fixture detail"));
    try {
      await expect(games.clear({ clubId, gameId: created.gameId })).rejects.toThrow(
        "Storage publication failed",
      );
    } finally {
      rejected.mockRestore();
    }
    expect(await games.get(created.gameId, clubId)).toMatchObject({ revision: 3 });
    expect(await storage.getEntity(tombstoneKey)).toBeUndefined();
    expect(await storage.getEntity(mutationKey)).toBeDefined();
    expect(await storage.getEntity(`cleanup:${digest(snapshot.name)}`)).toBeUndefined();
    expect(await storage.getEntity(`cleanup:${digest(request.name)}`)).toBeUndefined();
    for (const projection of ["participant", "result"])
      expect(
        await storage.read((tx) => tx.list(`club:${clubId}:${projection}:${created.gameId}:`)),
      ).toHaveLength(11);

    const submit = storage.table.submitTransaction.bind(storage.table);
    let corePublished = false;
    const clearing = vi
      .spyOn(storage.table, "submitTransaction")
      .mockImplementation(async (actions, options) => {
        const response = await submit(actions, options);
        if (
          actions.some(([operation, entity]) => operation === "delete" && entity.rowKey === key)
        ) {
          corePublished = true;
          expect(await games.get(created.gameId, clubId)).toBeNull();
          expect(await events.read(created.gameId, { includeSecrets: true }, clubId)).toEqual([]);
          expect(await storage.getEntity(tombstoneKey)).toBeDefined();
          for (const projection of ["participant", "result"])
            expect(
              await storage.read((tx) =>
                tx.list(`club:${clubId}:${projection}:${created.gameId}:`),
              ),
            ).toEqual([]);
          expect(await storage.getEntity(mutationKey)).toBeDefined();
        }
        return response;
      });
    try {
      await games.clear({ clubId, gameId: created.gameId });
      expect(corePublished).toBe(true);
      expect(clearing.mock.calls.every(([actions]) => actions.length <= 100)).toBe(true);
      expect(clearing.mock.calls).toHaveLength(2);
      console.info(
        `Azure full-roster clear Table actions: ${clearing.mock.calls.map(([actions]) => actions.length).join(", ")}`,
      );
    } finally {
      clearing.mockRestore();
    }
    expect(await storage.getEntity(mutationKey)).toBeUndefined();
    expect(await storage.getEntity(`cleanup:${digest(request.name)}`)).toMatchObject({
      kind: "retired-blob",
    });
    for (const ref of [snapshot, request])
      expect(await storage.blobs.getBlockBlobClient(ref.name).exists()).toBe(true);
  });
});
