import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { EventStore } from "./event-store.js";
import { GameSessionStore } from "./game-session-store.js";
import { ClubStore, DEFAULT_CLUB_ID } from "./club-store.js";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgresql://mafia:mafia@127.0.0.1:54329/mafia_test";
const pool = new Pool({ connectionString: databaseUrl });
const store = new EventStore(pool);
const legacyOwnerId = "00000000-0000-4000-8000-000000000001";

beforeAll(async () => {
  await store.initialize();
});

afterAll(async () => {
  await pool.end();
});

const waitForAdvisoryWaiters = async (expected: number): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ waiters: number }>(
      `SELECT COUNT(*)::int AS waiters
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query LIKE '%pg_advisory_xact_lock%'`,
    );
    if ((result.rows[0]?.waiters ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for advisory lock waiter");
};

describe("PostgreSQL event store", () => {
  it("assigns monotonic per-game sequences and reads events in order", async () => {
    const gameId = randomUUID();

    const first = await store.append({
      gameId,
      idempotencyKey: "first",
      type: "game.created",
      phase: "setup-players",
      payload: { name: "Friday game" },
    });
    const second = await store.append({
      gameId,
      idempotencyKey: "second",
      type: "players.selected",
      phase: "setup-players",
      payload: { seats: 10 },
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect((await store.read(gameId)).map(({ type }) => type)).toEqual([
      "game.created",
      "players.selected",
    ]);
  });

  it("returns the original event for a duplicate idempotency key", async () => {
    const gameId = randomUUID();
    const input = {
      gameId,
      idempotencyKey: "same-tap",
      type: "turn.started",
      phase: "day",
      seat: 3,
      payload: { seat: 3, seconds: 60 },
    } as const;

    const first = await store.append(input);
    const duplicate = await store.append(input);

    expect(duplicate.id).toBe(first.id);
    expect(duplicate.sequence).toBe(1);
    expect(await store.read(gameId)).toHaveLength(1);
  });

  it("redacts private event types from public reads without storing a secrecy flag", async () => {
    const gameId = randomUUID();
    for (const [index, type] of [
      "don.checked",
      "sheriff.checked",
      "best-move.completed",
    ].entries()) {
      await store.append({
        gameId,
        idempotencyKey: `private-${index}`,
        type,
        phase: "night-don",
        seat: 4,
        payload: { privateValue: type },
      });
    }

    const host = await store.read(gameId, { includeSecrets: true });
    const publicEvents = await store.read(gameId, { includeSecrets: false });

    expect(host.map(({ payload }) => payload)).toEqual([
      { privateValue: "don.checked" },
      { privateValue: "sheriff.checked" },
      { privateValue: "best-move.completed" },
    ]);
    expect(publicEvents.map(({ payload }) => payload)).toEqual([
      { redacted: true },
      { redacted: true },
      { redacted: true },
    ]);
  });

  it("keeps canonical public payloads visible and fails closed for unknown event types", async () => {
    const gameId = randomUUID();
    await store.append({
      gameId,
      idempotencyKey: "public",
      type: "player.nominated",
      phase: "day",
      payload: { candidateSeat: 2 },
    });
    await store.append({
      gameId,
      idempotencyKey: "unknown",
      type: "future.private-event",
      phase: "day",
      payload: { hidden: true },
    });

    const publicEvents = await store.read(gameId, { includeSecrets: false });

    expect(publicEvents.map(({ payload }) => payload)).toEqual([
      { candidateSeat: 2 },
      { redacted: true },
    ]);
  });

  it("truncates the undone event tail by idempotency key while preserving game.created", async () => {
    const gameId = randomUUID();
    await store.append({
      gameId,
      idempotencyKey: "game-created",
      type: "game.created",
      phase: "setup-players",
      payload: {},
    });
    await store.append({
      gameId,
      idempotencyKey: "undo-from-here",
      type: "turn.completed",
      phase: "day",
      payload: { day: 2 },
    });
    await store.append({
      gameId,
      idempotencyKey: "later-event",
      type: "foul.issued",
      phase: "day",
      payload: { seat: 1 },
    });

    await store.truncateFrom(gameId, "undo-from-here");
    await store.truncateFrom(gameId, "undo-from-here");
    await store.truncateFrom(gameId, "game-created");

    await expect(store.read(gameId)).resolves.toMatchObject([
      { sequence: 1, idempotencyKey: "game-created", type: "game.created" },
    ]);
  });

  it("tombstones an abandoned game, removes its active setup players, and rejects late appends", async () => {
    const gameId = randomUUID();
    await store.append({
      gameId,
      idempotencyKey: "setup-players",
      type: "setup.players-selected",
      phase: "setup-players",
      payload: { hostPlayerId: randomUUID(), players: [] },
    });

    await store.deleteGame(gameId);

    await expect(store.read(gameId)).resolves.toEqual([]);
    await expect(
      store.append({
        gameId,
        idempotencyKey: "late-event",
        type: "turn.started",
        phase: "day",
        payload: {},
      }),
    ).rejects.toMatchObject({ code: "game_deleted" });
  });

  it("serializes concurrent appends without duplicate sequence numbers", async () => {
    const gameId = randomUUID();

    const events = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.append({
          gameId,
          idempotencyKey: `event-${index}`,
          type: "log.test",
          phase: "day",
          payload: { index },
        }),
      ),
    );

    expect(events.map(({ sequence }) => sequence).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it("does not serialize the same game UUID across independent clubs", async () => {
    const club = await new ClubStore(pool).create(legacyOwnerId, {
      name: `Independent lock ${randomUUID().slice(0, 8)}`,
      city: "Granada",
      headerLogo: null,
      cardLogo: null,
      language: "en",
      ownerConsent: true,
    });
    const gameId = randomUUID();
    const locker = await pool.connect();
    let local: ReturnType<EventStore["append"]> | undefined;
    let foreign: ReturnType<EventStore["append"]> | undefined;
    let foreignOutcome: string | undefined;
    let localOutcome: string | undefined;
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [gameId]);
      await locker.query("SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))", [
        DEFAULT_CLUB_ID,
        gameId,
      ]);
      local = store.append({
        clubId: DEFAULT_CLUB_ID,
        gameId,
        idempotencyKey: "local",
        type: "game.created",
        phase: "setup-players",
        payload: {},
      });
      foreign = store.append({
        clubId: club.id,
        gameId,
        idempotencyKey: "foreign",
        type: "game.created",
        phase: "setup-players",
        payload: {},
      });
      foreignOutcome = await Promise.race([
        foreign.then(() => "completed"),
        new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 250)),
      ]);
      localOutcome = await Promise.race([
        local.then(() => "completed"),
        new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 50)),
      ]);
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
      await Promise.allSettled([
        ...(local === undefined ? [] : [local]),
        ...(foreign === undefined ? [] : [foreign]),
      ]);
    }

    expect(foreignOutcome).toBe("completed");
    expect(localOutcome).toBe("blocked");
    await expect(store.read(gameId, { includeSecrets: true }, club.id)).resolves.toHaveLength(1);
    await expect(
      store.read(gameId, { includeSecrets: true }, DEFAULT_CLUB_ID),
    ).resolves.toHaveLength(1);
  });

  it("rejects an append queued behind an aggregate tombstone", async () => {
    const gameId = randomUUID();
    const locker = await pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))", [
        DEFAULT_CLUB_ID,
        gameId,
      ]);
      const clear = new GameSessionStore(pool).clear(gameId);
      await waitForAdvisoryWaiters(1);
      const append = store.append({
        gameId,
        idempotencyKey: randomUUID(),
        type: "turn.started",
        phase: "day",
        payload: {},
      });
      await waitForAdvisoryWaiters(2);
      await locker.query("COMMIT");

      await clear;
      await expect(append).rejects.toMatchObject({ code: "game_deleted" });
      await expect(store.read(gameId)).resolves.toEqual([]);
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
  });
});
